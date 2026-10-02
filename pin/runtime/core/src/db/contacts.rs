use std::collections::HashSet;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::util::now_unix_millis;

use super::Database;

pub(super) const CONTACTS_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS contacts (
    id                TEXT PRIMARY KEY,
    first_name        TEXT NOT NULL DEFAULT '',
    last_name         TEXT NOT NULL DEFAULT '',
    nickname          TEXT NOT NULL DEFAULT '',
    display_name      TEXT NOT NULL DEFAULT '',
    trusted           INTEGER NOT NULL DEFAULT 0,
    emergency         INTEGER NOT NULL DEFAULT 0,
    internal_favorite INTEGER NOT NULL DEFAULT 0,
    temporary         INTEGER NOT NULL DEFAULT 0,
    contact_source    TEXT,
    organization      TEXT,
    modified_at       INTEGER NOT NULL,
    deleted_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_contacts_deleted ON contacts(deleted_at);
CREATE INDEX IF NOT EXISTS idx_contacts_modified ON contacts(modified_at);

CREATE TABLE IF NOT EXISTS contact_emails (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    value      TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT '',
    normalized TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_emails_contact ON contact_emails(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_emails_normalized ON contact_emails(normalized);

CREATE TABLE IF NOT EXISTS contact_phone_numbers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    value      TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT '',
    normalized TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_phone_numbers_contact ON contact_phone_numbers(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_phone_numbers_normalized ON contact_phone_numbers(normalized);
"#;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ContactName {
    #[serde(default)]
    pub first_name: String,
    #[serde(default)]
    pub last_name: String,
    #[serde(default)]
    pub nickname: String,
    #[serde(default)]
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContactEmail {
    pub value: String,
    #[serde(default)]
    pub r#type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContactPhoneNumber {
    pub value: String,
    #[serde(default)]
    pub r#type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContactRecord {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: ContactName,
    #[serde(default)]
    pub emails: Vec<ContactEmail>,
    #[serde(default)]
    pub phone_numbers: Vec<ContactPhoneNumber>,
    #[serde(default)]
    pub trusted: bool,
    #[serde(default)]
    pub emergency: bool,
    #[serde(default)]
    pub internal_favorite: bool,
    #[serde(default)]
    pub temporary: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization: Option<String>,
    #[serde(default)]
    pub modified_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContactImportSummary {
    pub created: usize,
    pub updated: usize,
    pub unchanged: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContactImportError {
    pub error: String,
    pub message: String,
}

impl std::fmt::Display for ContactImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.error, self.message)
    }
}

impl std::error::Error for ContactImportError {}

impl Database {
    pub async fn list_contacts(
        &self,
    ) -> Result<Vec<ContactRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            list_contacts_inner(&conn, "deleted_at IS NULL", params![])
        })
        .await?
    }

    pub async fn list_contact_changes_since(
        &self,
        since: i64,
    ) -> Result<(Vec<ContactRecord>, Vec<(String, i64)>), Box<dyn std::error::Error + Send + Sync>>
    {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let contacts = list_contacts_inner(
                &conn,
                "deleted_at IS NULL AND modified_at > ?1",
                params![since],
            )?;
            let deleted = list_deleted_contacts_since(&conn, since)?;
            Ok((contacts, deleted))
        })
        .await?
    }

    pub async fn list_deleted_contacts(
        &self,
    ) -> Result<Vec<(String, i64)>, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            Ok(list_deleted_contacts_since(&conn, -1)?)
        })
        .await?
    }

    pub async fn get_contact(
        &self,
        id: &str,
    ) -> Result<Option<ContactRecord>, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let id = id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            get_contact_inner(&conn, &id)
        })
        .await?
    }

    pub async fn upsert_contact(
        &self,
        contact: ContactRecord,
    ) -> Result<ContactRecord, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let tx = conn.transaction()?;
            let mut contact = normalize_contact(contact);
            if contact.id.is_empty() {
                contact.id = uuid::Uuid::new_v4().to_string();
            }
            validate_contact(&contact, None)?;
            save_contact(&tx, &mut contact, now_unix_millis())?;
            tx.commit()?;
            Ok(contact)
        })
        .await?
    }

    pub async fn delete_contact(
        &self,
        id: &str,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let conn = self.conn.clone();
        let id = id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let ts = now_unix_millis();
            let changed = conn.execute(
                "UPDATE contacts SET deleted_at = ?1, modified_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
                params![ts, id],
            )?;
            Ok(changed > 0)
        })
        .await?
    }

    pub async fn import_contacts_merge(
        &self,
        contacts: Vec<ContactRecord>,
    ) -> Result<ContactImportSummary, Box<dyn std::error::Error + Send + Sync>> {
        validate_import(&contacts)?;

        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = conn.lock().map_err(|e| format!("lock: {e}"))?;
            let tx = conn.transaction()?;
            let ts = now_unix_millis();
            let mut summary = ContactImportSummary {
                created: 0,
                updated: 0,
                unchanged: 0,
            };

            for contact in contacts {
                let mut contact = normalize_contact(contact);
                if contact.id.is_empty() {
                    contact.id = find_match_id(&tx, &contact)?
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                }

                let existed = get_contact_inner(&tx, &contact.id)?.is_some();
                save_contact(&tx, &mut contact, ts)?;
                if existed {
                    summary.updated += 1;
                } else {
                    summary.created += 1;
                }
            }

            tx.commit()?;
            Ok(summary)
        })
        .await?
    }
}

fn normalize_contact(mut contact: ContactRecord) -> ContactRecord {
    contact.id = contact.id.trim().to_string();
    contact.name.first_name = contact.name.first_name.trim().to_string();
    contact.name.last_name = contact.name.last_name.trim().to_string();
    contact.name.nickname = contact.name.nickname.trim().to_string();
    contact.name.display_name = contact.name.display_name.trim().to_string();
    contact.contact_source = clean_optional(contact.contact_source);
    contact.organization = clean_optional(contact.organization);
    contact.emails = contact
        .emails
        .into_iter()
        .map(|mut email| {
            email.value = email.value.trim().to_string();
            email.r#type = email.r#type.trim().to_string();
            email
        })
        .filter(|email| !email.value.is_empty())
        .collect();
    contact.phone_numbers = contact
        .phone_numbers
        .into_iter()
        .map(|mut phone| {
            phone.value = phone.value.trim().to_string();
            phone.r#type = phone.r#type.trim().to_string();
            phone
        })
        .filter(|phone| !normalize_phone(&phone.value).is_empty())
        .collect();
    contact
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn validate_import(contacts: &[ContactRecord]) -> Result<(), ContactImportError> {
    let mut seen_ids = HashSet::new();
    for (index, contact) in contacts.iter().enumerate() {
        let contact = normalize_contact(contact.clone());
        validate_contact(&contact, Some(index))?;
        if !contact.id.is_empty() && !seen_ids.insert(contact.id) {
            return Err(import_error(format!(
                "duplicate contact id at index {index}"
            )));
        }
    }
    Ok(())
}

fn validate_contact(
    contact: &ContactRecord,
    index: Option<usize>,
) -> Result<(), ContactImportError> {
    let prefix = index
        .map(|i| format!("contact at index {i}"))
        .unwrap_or_else(|| "contact".into());
    let has_name = !contact.name.display_name.is_empty()
        || !contact.name.first_name.is_empty()
        || !contact.name.last_name.is_empty();
    let has_email = contact.emails.iter().any(|email| !email.value.is_empty());
    let has_phone = contact
        .phone_numbers
        .iter()
        .any(|phone| !normalize_phone(&phone.value).is_empty());

    if !has_name && !has_email && !has_phone {
        return Err(import_error(format!(
            "{prefix} must include a name, email, or phone number"
        )));
    }
    if contact
        .emails
        .iter()
        .any(|email| !email.value.contains('@'))
    {
        return Err(import_error(format!("{prefix} contains an invalid email")));
    }
    Ok(())
}

fn import_error(message: impl Into<String>) -> ContactImportError {
    ContactImportError {
        error: "invalid_contacts".into(),
        message: message.into(),
    }
}

fn list_contacts_inner<P>(
    conn: &Connection,
    where_clause: &str,
    params: P,
) -> Result<Vec<ContactRecord>, Box<dyn std::error::Error + Send + Sync>>
where
    P: rusqlite::Params,
{
    let sql = format!(
        "SELECT id, first_name, last_name, nickname, display_name, trusted, emergency,
                internal_favorite, temporary, contact_source, organization, modified_at
         FROM contacts WHERE {where_clause}
         ORDER BY COALESCE(NULLIF(display_name, ''), first_name || ' ' || last_name, id) COLLATE NOCASE"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params, |row| contact_from_row(conn, row))?;
    let mut contacts = Vec::new();
    for row in rows {
        contacts.push(row?);
    }
    Ok(contacts)
}

fn get_contact_inner(
    conn: &Connection,
    id: &str,
) -> Result<Option<ContactRecord>, Box<dyn std::error::Error + Send + Sync>> {
    let mut stmt = conn.prepare(
        "SELECT id, first_name, last_name, nickname, display_name, trusted, emergency,
                internal_favorite, temporary, contact_source, organization, modified_at
         FROM contacts WHERE id = ?1 AND deleted_at IS NULL",
    )?;
    Ok(stmt
        .query_row(params![id], |row| contact_from_row(conn, row))
        .ok())
}

fn contact_from_row(
    conn: &Connection,
    row: &rusqlite::Row,
) -> Result<ContactRecord, rusqlite::Error> {
    let id: String = row.get(0)?;
    Ok(ContactRecord {
        id: id.clone(),
        name: ContactName {
            first_name: row.get(1)?,
            last_name: row.get(2)?,
            nickname: row.get(3)?,
            display_name: row.get(4)?,
        },
        emails: get_emails(conn, &id)?,
        phone_numbers: get_phones(conn, &id)?,
        trusted: row.get::<_, i64>(5)? != 0,
        emergency: row.get::<_, i64>(6)? != 0,
        internal_favorite: row.get::<_, i64>(7)? != 0,
        temporary: row.get::<_, i64>(8)? != 0,
        contact_source: row.get(9)?,
        organization: row.get(10)?,
        modified_at: row.get(11)?,
    })
}

fn get_emails(conn: &Connection, contact_id: &str) -> Result<Vec<ContactEmail>, rusqlite::Error> {
    let mut stmt =
        conn.prepare("SELECT value, type FROM contact_emails WHERE contact_id = ?1 ORDER BY id")?;
    let rows = stmt.query_map(params![contact_id], |row| {
        Ok(ContactEmail {
            value: row.get(0)?,
            r#type: row.get(1)?,
        })
    })?;
    rows.collect()
}

fn get_phones(
    conn: &Connection,
    contact_id: &str,
) -> Result<Vec<ContactPhoneNumber>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT value, type FROM contact_phone_numbers WHERE contact_id = ?1 ORDER BY id",
    )?;
    let rows = stmt.query_map(params![contact_id], |row| {
        Ok(ContactPhoneNumber {
            value: row.get(0)?,
            r#type: row.get(1)?,
        })
    })?;
    rows.collect()
}

fn save_contact(
    conn: &Connection,
    contact: &mut ContactRecord,
    modified_at: i64,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    contact.modified_at = modified_at;
    conn.execute(
        "INSERT INTO contacts (
            id, first_name, last_name, nickname, display_name, trusted, emergency,
            internal_favorite, temporary, contact_source, organization, modified_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL)
         ON CONFLICT(id) DO UPDATE SET
            first_name = excluded.first_name,
            last_name = excluded.last_name,
            nickname = excluded.nickname,
            display_name = excluded.display_name,
            trusted = excluded.trusted,
            emergency = excluded.emergency,
            internal_favorite = excluded.internal_favorite,
            temporary = excluded.temporary,
            contact_source = excluded.contact_source,
            organization = excluded.organization,
            modified_at = excluded.modified_at,
            deleted_at = NULL",
        params![
            contact.id,
            contact.name.first_name,
            contact.name.last_name,
            contact.name.nickname,
            contact.name.display_name,
            contact.trusted as i64,
            contact.emergency as i64,
            contact.internal_favorite as i64,
            contact.temporary as i64,
            contact.contact_source,
            contact.organization,
            contact.modified_at,
        ],
    )?;

    conn.execute(
        "DELETE FROM contact_emails WHERE contact_id = ?1",
        params![contact.id],
    )?;
    for email in &contact.emails {
        conn.execute(
            "INSERT INTO contact_emails (contact_id, value, type, normalized) VALUES (?1, ?2, ?3, ?4)",
            params![contact.id, email.value, email.r#type, normalize_email(&email.value)],
        )?;
    }

    conn.execute(
        "DELETE FROM contact_phone_numbers WHERE contact_id = ?1",
        params![contact.id],
    )?;
    for phone in &contact.phone_numbers {
        conn.execute(
            "INSERT INTO contact_phone_numbers (contact_id, value, type, normalized) VALUES (?1, ?2, ?3, ?4)",
            params![contact.id, phone.value, phone.r#type, normalize_phone(&phone.value)],
        )?;
    }

    Ok(())
}

fn find_match_id(
    conn: &Connection,
    contact: &ContactRecord,
) -> Result<Option<String>, Box<dyn std::error::Error + Send + Sync>> {
    for phone in &contact.phone_numbers {
        let normalized = normalize_phone(&phone.value);
        if let Some(id) = find_contact_id_by_normalized(conn, "contact_phone_numbers", &normalized)?
        {
            return Ok(Some(id));
        }
    }
    for email in &contact.emails {
        let normalized = normalize_email(&email.value);
        if let Some(id) = find_contact_id_by_normalized(conn, "contact_emails", &normalized)? {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

fn find_contact_id_by_normalized(
    conn: &Connection,
    table: &str,
    normalized: &str,
) -> Result<Option<String>, rusqlite::Error> {
    let sql = format!(
        "SELECT contact_id FROM {table}
         JOIN contacts ON contacts.id = {table}.contact_id
         WHERE normalized = ?1 AND contacts.deleted_at IS NULL LIMIT 1"
    );
    Ok(conn
        .query_row(&sql, params![normalized], |row| row.get(0))
        .ok())
}

fn list_deleted_contacts_since(
    conn: &Connection,
    since: i64,
) -> Result<Vec<(String, i64)>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, modified_at FROM contacts WHERE deleted_at IS NOT NULL AND modified_at > ?1 ORDER BY modified_at ASC, id ASC",
    )?;
    let rows = stmt.query_map(params![since], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}

fn normalize_email(value: &str) -> String {
    value.trim().to_lowercase()
}

fn normalize_phone(value: &str) -> String {
    value
        .trim()
        .chars()
        .enumerate()
        .filter_map(|(idx, ch)| (ch.is_ascii_digit() || (idx == 0 && ch == '+')).then_some(ch))
        .collect()
}
