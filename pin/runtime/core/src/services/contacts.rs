use std::collections::HashSet;
use std::pin::Pin;

use prost::Message as _;
use prost_types::Timestamp;
use tokio_stream::Stream;
use tonic::{Request, Response, Status};
use tracing::info;

use crate::db::{ContactEmail, ContactName, ContactPhoneNumber, ContactRecord, Database};
use crate::proto::common::encryption::{EncryptedData, EncryptionInformation};
use crate::proto::contacts::contacts_rpc_service_server::ContactsRpcService;
use crate::proto::contacts::*;
use crate::tier_a::wire_sentinels;

const DEFAULT_PAGE_SIZE: usize = 100;
const MAX_PAGE_SIZE: usize = 1_000;
const MAX_CONTACTS_PER_MUTATION: usize = 256;
const MAX_CONTACT_BYTES: usize = 256 * 1024;
const MAX_CONTACT_ID_BYTES: usize = 512;
const MAX_KID_BYTES: usize = 1_024;
const MAX_SEARCH_TERM_BYTES: usize = 512;
const PLAINTEXT_CONTACT_KID: &str = wire_sentinels::PLAINTEXT_ENVELOPE;

pub struct ContactsRpcServiceImpl {
    pub db: Database,
}

#[tonic::async_trait]
impl ContactsRpcService for ContactsRpcServiceImpl {
    #[allow(deprecated)]
    async fn get_contacts(
        &self,
        request: Request<GetContactsRequest>,
    ) -> Result<Response<ContactList>, Status> {
        info!(">>> Contacts.GetContacts");
        let search_term = request.into_inner().search_term.unwrap_or_default();
        if search_term.len() > MAX_SEARCH_TERM_BYTES {
            return Err(Status::invalid_argument("contact search term is too long"));
        }

        let mut contacts = self
            .db
            .list_contacts()
            .await
            .map_err(|_| Status::internal("failed to list contacts"))?;

        if !search_term.trim().is_empty() {
            contacts.retain(|contact| contact_matches_search(contact, &search_term));
        }

        Ok(Response::new(ContactList {
            contacts: contacts.into_iter().map(contact_to_proto).collect(),
            encrypted_contacts: vec![],
            encrypted_contacts_versions: vec![],
        }))
    }

    #[allow(deprecated)]
    async fn get_contact_deltas(
        &self,
        request: Request<GetContactDeltasRequest>,
    ) -> Result<Response<GetContactDeltasResponse>, Status> {
        info!(">>> Contacts.GetContactDeltas");
        let request = request.into_inner();
        validate_delta_request(&request)?;
        let since = request
            .last_synced_time
            .as_ref()
            .map(timestamp_to_millis)
            .transpose()?
            .unwrap_or(0);
        let (contacts, deleted) = self
            .db
            .list_contact_changes_since(since)
            .await
            .map_err(|_| Status::internal("failed to list contact changes"))?;

        let latest = contacts
            .iter()
            .map(|contact| contact.modified_at)
            .chain(deleted.iter().map(|(_, modified_at)| *modified_at))
            .fold(since, i64::max);

        Ok(Response::new(GetContactDeltasResponse {
            contacts: contacts.into_iter().map(contact_to_proto).collect(),
            deleted_contact_ids: deleted.into_iter().map(|(id, _)| id).collect(),
            encrypted_contacts: vec![],
            encrypted_contacts_versions: vec![],
            latest_sync_time: Some(millis_to_timestamp(latest)),
        }))
    }

    type GetContactsStreamingStream =
        Pin<Box<dyn Stream<Item = Result<GetContactsStreamingResponse, Status>> + Send>>;

    async fn get_contacts_streaming(
        &self,
        request: Request<GetContactsStreamingRequest>,
    ) -> Result<Response<Self::GetContactsStreamingStream>, Status> {
        info!(">>> Contacts.GetContactsStreaming");
        let responses = collect_streaming_responses(&self.db, request.into_inner()).await?;
        Ok(Response::new(Box::pin(tokio_stream::iter(
            responses.into_iter().map(Ok),
        ))))
    }

    type GetContactsPaginatedStreamingStream =
        Pin<Box<dyn Stream<Item = Result<GetContactsStreamingPageResponse, Status>> + Send>>;

    async fn get_contacts_paginated_streaming(
        &self,
        request: Request<GetContactsStreamingPageRequest>,
    ) -> Result<Response<Self::GetContactsPaginatedStreamingStream>, Status> {
        info!(">>> Contacts.GetContactsPaginatedStreaming");
        let request = request.into_inner();
        let page_size = if request.page_size > 0 {
            request.page_size as usize
        } else {
            DEFAULT_PAGE_SIZE
        };
        if page_size > MAX_PAGE_SIZE {
            return Err(Status::invalid_argument("contact page size is too large"));
        }

        let streaming_request = request
            .streaming_request
            .unwrap_or(GetContactsStreamingRequest {
                sync_option: Some(get_contacts_streaming_request::SyncOption::FullSync(true)),
                server_should_decrypt: false,
            });
        let responses = collect_streaming_responses(&self.db, streaming_request).await?;
        let total_pages = std::cmp::max(1, responses.len().div_ceil(page_size)) as i32;
        let pages: Vec<_> = if responses.is_empty() {
            vec![Ok(GetContactsStreamingPageResponse {
                page_content: vec![],
                page_num: 1,
                total_pages,
            })]
        } else {
            responses
                .chunks(page_size)
                .enumerate()
                .map(|(index, chunk)| {
                    Ok(GetContactsStreamingPageResponse {
                        page_content: chunk.to_vec(),
                        page_num: index as i32 + 1,
                        total_pages,
                    })
                })
                .collect()
        };

        Ok(Response::new(Box::pin(tokio_stream::iter(pages))))
    }

    #[allow(deprecated)]
    async fn create_contacts(
        &self,
        request: Request<ContactList>,
    ) -> Result<Response<ContactList>, Status> {
        info!(">>> Contacts.CreateContacts");
        let contacts = decode_contact_list(request.into_inner(), false)?;
        let mut created = Vec::with_capacity(contacts.len());
        for contact in contacts {
            let contact = self
                .db
                .upsert_contact(proto_to_contact_record(contact))
                .await
                .map_err(|_| Status::internal("failed to create contact"))?;
            created.push(plaintext_contact_envelope(contact_to_proto(contact))?);
        }

        Ok(Response::new(ContactList {
            contacts: vec![],
            encrypted_contacts: created,
            encrypted_contacts_versions: vec![],
        }))
    }

    async fn update_contacts(&self, request: Request<ContactList>) -> Result<Response<()>, Status> {
        info!(">>> Contacts.UpdateContacts");
        let contacts = decode_contact_list(request.into_inner(), true)?;
        for contact in contacts {
            self.db
                .upsert_contact(proto_to_contact_record(contact))
                .await
                .map_err(|_| Status::internal("failed to update contact"))?;
        }
        Ok(Response::new(()))
    }

    async fn delete_contacts(
        &self,
        request: Request<DeleteContactRequest>,
    ) -> Result<Response<()>, Status> {
        info!(">>> Contacts.DeleteContacts");
        let ids = request.into_inner().ids;
        validate_contact_ids(&ids)?;

        let mut seen = HashSet::with_capacity(ids.len());
        for id in ids {
            if seen.insert(id.clone()) {
                self.db
                    .delete_contact(&id)
                    .await
                    .map_err(|_| Status::internal("failed to delete contact"))?;
            }
        }
        Ok(Response::new(()))
    }
}

async fn collect_streaming_responses(
    db: &Database,
    request: GetContactsStreamingRequest,
) -> Result<Vec<GetContactsStreamingResponse>, Status> {
    let server_should_decrypt = request.server_should_decrypt;
    let (contacts, deleted) = match request.sync_option {
        Some(get_contacts_streaming_request::SyncOption::LastSyncedTime(timestamp)) => {
            let since = timestamp_to_millis(&timestamp)?;
            db.list_contact_changes_since(since)
                .await
                .map_err(|_| Status::internal("failed to list contact changes"))?
        }
        Some(get_contacts_streaming_request::SyncOption::FullSync(_)) | None => {
            let contacts = db
                .list_contacts()
                .await
                .map_err(|_| Status::internal("failed to list contacts"))?;
            let deleted = db
                .list_deleted_contacts()
                .await
                .map_err(|_| Status::internal("failed to list deleted contacts"))?;
            (contacts, deleted)
        }
    };

    let mut responses = Vec::with_capacity(contacts.len() + deleted.len());
    for contact in contacts {
        let modified_at = contact.modified_at;
        let contact = contact_to_proto(contact);
        let response = if server_should_decrypt {
            get_contacts_streaming_response::Response::Contact(contact)
        } else {
            get_contacts_streaming_response::Response::EncryptedContact(plaintext_contact_envelope(
                contact,
            )?)
        };
        responses.push(GetContactsStreamingResponse {
            modified_time: Some(millis_to_timestamp(modified_at)),
            response: Some(response),
        });
    }
    responses.extend(
        deleted
            .into_iter()
            .map(|(id, modified_at)| GetContactsStreamingResponse {
                modified_time: Some(millis_to_timestamp(modified_at)),
                response: Some(get_contacts_streaming_response::Response::DeletedContactId(
                    id,
                )),
            }),
    );

    // Delta consumers checkpoint the newest modified_time they have processed.
    // Chronological ordering prevents a partial stream from skipping older rows
    // after a retry.
    responses.sort_by_key(stream_sort_key);
    Ok(responses)
}

fn stream_sort_key(response: &GetContactsStreamingResponse) -> (i64, i32, String) {
    let timestamp = response
        .modified_time
        .as_ref()
        .map(timestamp_to_millis_lossy)
        .unwrap_or_default();
    match response.response.as_ref() {
        Some(get_contacts_streaming_response::Response::DeletedContactId(id)) => {
            (timestamp, 0, id.clone())
        }
        Some(get_contacts_streaming_response::Response::Contact(contact)) => {
            (timestamp, 1, contact.id.clone())
        }
        Some(get_contacts_streaming_response::Response::EncryptedContact(encrypted)) => {
            (timestamp, 1, encrypted.data.len().to_string())
        }
        None => (timestamp, 2, String::new()),
    }
}

#[allow(deprecated)]
fn validate_delta_request(request: &GetContactDeltasRequest) -> Result<(), Status> {
    if request.contact_requests.len() > MAX_CONTACTS_PER_MUTATION {
        return Err(Status::invalid_argument("too many contact delta requests"));
    }
    for contact in &request.contact_requests {
        validate_contact_id(&contact.id)?;
    }
    if let Some(timestamp) = request.last_synced_time.as_ref() {
        timestamp_to_millis(timestamp)?;
    }
    Ok(())
}

#[allow(deprecated)]
fn decode_contact_list(
    contact_list: ContactList,
    require_ids: bool,
) -> Result<Vec<Contact>, Status> {
    if contact_list.encrypted_contacts_versions.len() > MAX_CONTACTS_PER_MUTATION {
        return Err(Status::invalid_argument(
            "too many encrypted contact versions",
        ));
    }
    let contact_count = contact_list
        .contacts
        .len()
        .checked_add(contact_list.encrypted_contacts.len())
        .ok_or_else(|| Status::invalid_argument("too many contacts"))?;
    if contact_count > MAX_CONTACTS_PER_MUTATION {
        return Err(Status::invalid_argument("too many contacts"));
    }

    let mut contacts = Vec::with_capacity(contact_count);
    for contact in contact_list.contacts {
        validate_contact_proto(&contact, require_ids)?;
        contacts.push(contact);
    }
    for envelope in contact_list.encrypted_contacts {
        let kid = envelope
            .encryption_information
            .as_ref()
            .map(|information| information.kid.as_str())
            .filter(|kid| !kid.is_empty())
            .ok_or_else(|| Status::invalid_argument("contact envelope is missing a KID"))?;
        if kid.len() > MAX_KID_BYTES {
            return Err(Status::invalid_argument("contact envelope KID is too long"));
        }
        if envelope.data.is_empty() {
            return Err(Status::invalid_argument("contact envelope is empty"));
        }
        if envelope.data.len() > MAX_CONTACT_BYTES {
            return Err(Status::invalid_argument(
                "contact envelope payload is too large",
            ));
        }

        let mut bytes = envelope.data.as_slice();
        let contact = Contact::decode(&mut bytes)
            .map_err(|_| Status::invalid_argument("contact envelope payload is invalid"))?;
        if !bytes.is_empty() {
            return Err(Status::invalid_argument(
                "contact envelope contains trailing data",
            ));
        }
        validate_contact_proto(&contact, require_ids)?;
        contacts.push(contact);
    }

    let mut seen_ids = HashSet::with_capacity(contacts.len());
    for contact in &contacts {
        if !contact.id.is_empty() && !seen_ids.insert(contact.id.as_str()) {
            return Err(Status::invalid_argument("duplicate contact id"));
        }
    }
    Ok(contacts)
}

#[allow(deprecated)]
fn validate_contact_proto(contact: &Contact, require_id: bool) -> Result<(), Status> {
    if contact.encoded_len() > MAX_CONTACT_BYTES {
        return Err(Status::invalid_argument("contact payload is too large"));
    }
    if require_id && contact.id.trim().is_empty() {
        return Err(Status::invalid_argument("updated contact is missing an id"));
    }
    if !contact.id.is_empty() {
        validate_contact_id(&contact.id)?;
    }

    let has_name = contact.name.as_ref().is_some_and(|name| {
        !name.first_name.trim().is_empty()
            || !name.last_name.trim().is_empty()
            || !name.display_name.trim().is_empty()
    });
    let has_email = contact
        .emails
        .iter()
        .any(|email| !email.value.trim().is_empty());
    let has_phone = contact
        .phone_numbers
        .iter()
        .any(|phone| !normalize_phone(&phone.value).is_empty())
        || contact
            .telephone_numbers
            .iter()
            .any(|phone| !normalize_phone(phone).is_empty());
    if !has_name && !has_email && !has_phone {
        return Err(Status::invalid_argument(
            "contact must include a name, email, or phone number",
        ));
    }
    if contact
        .emails
        .iter()
        .filter(|email| !email.value.trim().is_empty())
        .any(|email| !email.value.contains('@'))
    {
        return Err(Status::invalid_argument(
            "contact contains an invalid email",
        ));
    }
    Ok(())
}

fn validate_contact_ids(ids: &[String]) -> Result<(), Status> {
    if ids.len() > MAX_CONTACTS_PER_MUTATION {
        return Err(Status::invalid_argument("too many contact ids"));
    }
    for id in ids {
        validate_contact_id(id)?;
    }
    Ok(())
}

fn validate_contact_id(id: &str) -> Result<(), Status> {
    if id.trim().is_empty() {
        return Err(Status::invalid_argument("contact id is empty"));
    }
    if id.len() > MAX_CONTACT_ID_BYTES {
        return Err(Status::invalid_argument("contact id is too long"));
    }
    Ok(())
}

fn plaintext_contact_envelope(contact: Contact) -> Result<EncryptedData, Status> {
    let data = contact.encode_to_vec();
    if data.len() > MAX_CONTACT_BYTES {
        return Err(Status::resource_exhausted(
            "serialized contact is too large",
        ));
    }
    Ok(EncryptedData {
        encryption_information: Some(EncryptionInformation {
            kid: PLAINTEXT_CONTACT_KID.into(),
        }),
        data,
    })
}

#[allow(deprecated)]
fn proto_to_contact_record(contact: Contact) -> ContactRecord {
    let name = contact.name.unwrap_or_default();
    let mut phone_numbers: Vec<_> = contact
        .phone_numbers
        .into_iter()
        .map(|phone| ContactPhoneNumber {
            value: phone.value,
            r#type: phone.r#type,
        })
        .collect();
    if phone_numbers.is_empty() {
        phone_numbers.extend(contact.telephone_numbers.into_iter().map(|value| {
            ContactPhoneNumber {
                value,
                r#type: String::new(),
            }
        }));
    }

    ContactRecord {
        id: contact.id,
        name: ContactName {
            first_name: name.first_name,
            last_name: name.last_name,
            nickname: name.nickname,
            display_name: name.display_name,
        },
        emails: contact
            .emails
            .into_iter()
            .map(|email| ContactEmail {
                value: email.value,
                r#type: email.r#type,
            })
            .collect(),
        phone_numbers,
        trusted: contact.trusted,
        emergency: contact.emergency,
        internal_favorite: contact.internal_favorite,
        temporary: contact.temporary,
        contact_source: contact.contact_source.map(|source| source.name),
        organization: contact.organization.map(|organization| organization.name),
        modified_at: 0,
    }
}

#[allow(deprecated)]
fn contact_to_proto(contact: ContactRecord) -> Contact {
    Contact {
        id: contact.id,
        version: 0,
        emails: contact
            .emails
            .into_iter()
            .map(|email| Email {
                value: email.value,
                r#type: email.r#type,
            })
            .collect(),
        name: Some(Name {
            first_name: contact.name.first_name,
            last_name: contact.name.last_name,
            nickname: contact.name.nickname,
            display_name: contact.name.display_name,
        }),
        contact_actions: vec![],
        social_handles: vec![],
        telephone_numbers: vec![],
        temporary: contact.temporary,
        last_used_at: None,
        trusted: contact.trusted,
        emergency: contact.emergency,
        phone_numbers: contact
            .phone_numbers
            .into_iter()
            .map(|phone| PhoneNumber {
                value: phone.value,
                r#type: phone.r#type,
            })
            .collect(),
        contact_source: contact.contact_source.map(|name| ContactSource { name }),
        organization: contact.organization.map(|name| Organization { name }),
        modified_at: Some(millis_to_timestamp(contact.modified_at)),
        internal_favorite: contact.internal_favorite,
    }
}

fn timestamp_to_millis(timestamp: &Timestamp) -> Result<i64, Status> {
    if !(0..1_000_000_000).contains(&timestamp.nanos) {
        return Err(Status::invalid_argument("invalid contact sync timestamp"));
    }
    timestamp
        .seconds
        .checked_mul(1_000)
        .and_then(|millis| millis.checked_add(i64::from(timestamp.nanos / 1_000_000)))
        .ok_or_else(|| Status::invalid_argument("invalid contact sync timestamp"))
}

fn timestamp_to_millis_lossy(timestamp: &Timestamp) -> i64 {
    timestamp.seconds.saturating_mul(1_000) + i64::from(timestamp.nanos / 1_000_000)
}

fn millis_to_timestamp(ms: i64) -> Timestamp {
    Timestamp {
        seconds: ms.div_euclid(1_000),
        nanos: (ms.rem_euclid(1_000) * 1_000_000) as i32,
    }
}

fn normalize_phone(value: &str) -> String {
    value
        .trim()
        .chars()
        .enumerate()
        .filter_map(|(index, character)| {
            (character.is_ascii_digit() || (index == 0 && character == '+')).then_some(character)
        })
        .collect()
}

fn contact_matches_search(contact: &ContactRecord, search_term: &str) -> bool {
    let needle = search_term.trim().to_lowercase();
    if needle.is_empty() {
        return true;
    }

    contact.name.first_name.to_lowercase().contains(&needle)
        || contact.name.last_name.to_lowercase().contains(&needle)
        || contact.name.nickname.to_lowercase().contains(&needle)
        || contact.name.display_name.to_lowercase().contains(&needle)
        || contact
            .emails
            .iter()
            .any(|email| email.value.to_lowercase().contains(&needle))
        || contact
            .phone_numbers
            .iter()
            .any(|phone| phone.value.to_lowercase().contains(&needle))
}

#[cfg(test)]
#[allow(deprecated)]
mod tests {
    use std::time::Duration;

    use prost::Message as _;
    use tokio_stream::StreamExt as _;
    use tonic::Code;

    use super::*;

    fn test_service() -> (tempfile::TempDir, ContactsRpcServiceImpl) {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path().join("contacts.sqlite")).unwrap();
        (directory, ContactsRpcServiceImpl { db })
    }

    fn contact(id: &str, display_name: &str, phone: &str) -> Contact {
        Contact {
            id: id.into(),
            name: Some(Name {
                display_name: display_name.into(),
                ..Default::default()
            }),
            phone_numbers: vec![PhoneNumber {
                value: phone.into(),
                r#type: "mobile".into(),
            }],
            ..Default::default()
        }
    }

    fn envelope(kid: Option<&str>, contact: &Contact) -> EncryptedData {
        EncryptedData {
            encryption_information: kid.map(|kid| EncryptionInformation { kid: kid.into() }),
            data: contact.encode_to_vec(),
        }
    }

    fn full_sync(server_should_decrypt: bool) -> GetContactsStreamingRequest {
        GetContactsStreamingRequest {
            sync_option: Some(get_contacts_streaming_request::SyncOption::FullSync(true)),
            server_should_decrypt,
        }
    }

    #[tokio::test]
    async fn create_update_and_delete_follow_stock_envelope_contract() {
        let (_directory, service) = test_service();
        let original = contact("contact-1", "Test Contact", "+4512345678");
        let created = service
            .create_contacts(Request::new(ContactList {
                contacts: vec![],
                encrypted_contacts: vec![envelope(Some("stock-key-id"), &original)],
                encrypted_contacts_versions: vec![],
            }))
            .await
            .unwrap()
            .into_inner();

        assert!(created.contacts.is_empty());
        assert_eq!(created.encrypted_contacts.len(), 1);
        let returned = &created.encrypted_contacts[0];
        assert_eq!(
            returned
                .encryption_information
                .as_ref()
                .map(|information| information.kid.as_str()),
            Some(PLAINTEXT_CONTACT_KID)
        );
        assert_eq!(
            Contact::decode(returned.data.as_slice()).unwrap().id,
            "contact-1"
        );

        let mut updated = original;
        updated.trusted = true;
        service
            .update_contacts(Request::new(ContactList {
                contacts: vec![],
                encrypted_contacts: vec![envelope(Some("existing-stock-key"), &updated)],
                encrypted_contacts_versions: vec![],
            }))
            .await
            .unwrap();
        assert!(
            service
                .db
                .get_contact("contact-1")
                .await
                .unwrap()
                .unwrap()
                .trusted
        );

        service
            .delete_contacts(Request::new(DeleteContactRequest {
                ids: vec!["contact-1".into(), "contact-1".into()],
            }))
            .await
            .unwrap();
        assert!(service.db.get_contact("contact-1").await.unwrap().is_none());
        assert_eq!(service.db.list_deleted_contacts().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn all_read_surfaces_return_full_and_delta_data_in_stock_shapes() {
        let (_directory, service) = test_service();
        for value in [
            contact("contact-a", "Alice", "+4511111111"),
            contact("contact-b", "Bob", "+4522222222"),
        ] {
            service
                .create_contacts(Request::new(ContactList {
                    contacts: vec![value],
                    encrypted_contacts: vec![],
                    encrypted_contacts_versions: vec![],
                }))
                .await
                .unwrap();
        }

        let listed = service
            .get_contacts(Request::new(GetContactsRequest::default()))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(listed.contacts.len(), 2);

        let delta = service
            .get_contact_deltas(Request::new(GetContactDeltasRequest {
                contact_requests: vec![],
                last_synced_time: Some(Timestamp::default()),
            }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(delta.contacts.len(), 2);
        assert!(delta.deleted_contact_ids.is_empty());
        let checkpoint = timestamp_to_millis(delta.latest_sync_time.as_ref().unwrap()).unwrap();
        assert!(checkpoint > 0);

        let encrypted_stream = service
            .get_contacts_streaming(Request::new(full_sync(false)))
            .await
            .unwrap()
            .into_inner();
        let encrypted_items: Vec<Result<GetContactsStreamingResponse, Status>> =
            encrypted_stream.collect().await;
        assert_eq!(encrypted_items.len(), 2);
        assert!(encrypted_items.iter().all(|item| matches!(
            item.as_ref().unwrap().response.as_ref(),
            Some(get_contacts_streaming_response::Response::EncryptedContact(
                _
            ))
        )));

        let pages = service
            .get_contacts_paginated_streaming(Request::new(GetContactsStreamingPageRequest {
                streaming_request: Some(full_sync(true)),
                page_size: 1,
            }))
            .await
            .unwrap()
            .into_inner();
        let pages: Vec<Result<GetContactsStreamingPageResponse, Status>> = pages.collect().await;
        assert_eq!(pages.len(), 2);
        assert!(pages
            .iter()
            .all(|page| page.as_ref().unwrap().total_pages == 2));
        assert!(pages.iter().all(|page| matches!(
            page.as_ref().unwrap().page_content[0].response.as_ref(),
            Some(get_contacts_streaming_response::Response::Contact(_))
        )));

        tokio::time::sleep(Duration::from_millis(2)).await;
        service
            .delete_contacts(Request::new(DeleteContactRequest {
                ids: vec!["contact-a".into()],
            }))
            .await
            .unwrap();
        let changes = service
            .get_contacts_streaming(Request::new(GetContactsStreamingRequest {
                sync_option: Some(get_contacts_streaming_request::SyncOption::LastSyncedTime(
                    millis_to_timestamp(checkpoint),
                )),
                server_should_decrypt: true,
            }))
            .await
            .unwrap()
            .into_inner();
        let changes: Vec<Result<GetContactsStreamingResponse, Status>> = changes.collect().await;
        assert_eq!(changes.len(), 1);
        assert!(matches!(
            changes[0].as_ref().unwrap().response.as_ref(),
            Some(get_contacts_streaming_response::Response::DeletedContactId(id))
                if id == "contact-a"
        ));
    }

    #[tokio::test]
    async fn mutation_and_stream_limits_reject_malformed_requests_without_writes() {
        let (_directory, service) = test_service();
        let invalid_kid = service
            .create_contacts(Request::new(ContactList {
                contacts: vec![],
                encrypted_contacts: vec![envelope(None, &contact("a", "A", "+451"))],
                encrypted_contacts_versions: vec![],
            }))
            .await
            .unwrap_err();
        assert_eq!(invalid_kid.code(), Code::InvalidArgument);

        let oversized = EncryptedData {
            encryption_information: Some(EncryptionInformation { kid: "key".into() }),
            data: vec![0; MAX_CONTACT_BYTES + 1],
        };
        let oversized = service
            .create_contacts(Request::new(ContactList {
                contacts: vec![],
                encrypted_contacts: vec![oversized],
                encrypted_contacts_versions: vec![],
            }))
            .await
            .unwrap_err();
        assert_eq!(oversized.code(), Code::InvalidArgument);

        let too_many_versions = service
            .create_contacts(Request::new(ContactList {
                contacts: vec![],
                encrypted_contacts: vec![],
                encrypted_contacts_versions: vec![0; MAX_CONTACTS_PER_MUTATION + 1],
            }))
            .await
            .unwrap_err();
        assert_eq!(too_many_versions.code(), Code::InvalidArgument);

        let too_many = service
            .create_contacts(Request::new(ContactList {
                contacts: (0..=MAX_CONTACTS_PER_MUTATION)
                    .map(|index| contact(&format!("id-{index}"), "Person", "+4512345678"))
                    .collect(),
                encrypted_contacts: vec![],
                encrypted_contacts_versions: vec![],
            }))
            .await
            .unwrap_err();
        assert_eq!(too_many.code(), Code::InvalidArgument);

        let missing_update_id = service
            .update_contacts(Request::new(ContactList {
                contacts: vec![contact("", "Person", "+4512345678")],
                encrypted_contacts: vec![],
                encrypted_contacts_versions: vec![],
            }))
            .await
            .unwrap_err();
        assert_eq!(missing_update_id.code(), Code::InvalidArgument);

        let page_too_large = service
            .get_contacts_paginated_streaming(Request::new(GetContactsStreamingPageRequest {
                streaming_request: Some(full_sync(true)),
                page_size: MAX_PAGE_SIZE as i32 + 1,
            }))
            .await
            .err()
            .unwrap();
        assert_eq!(page_too_large.code(), Code::InvalidArgument);
        assert!(service.db.list_contacts().await.unwrap().is_empty());
    }

    #[test]
    fn reconstructed_delta_messages_keep_stock_field_numbers() {
        assert_eq!(
            ContactDeltasRequest {
                id: "x".into(),
                version: 7,
            }
            .encode_to_vec(),
            [0x0a, 0x01, b'x', 0x10, 0x07]
        );
        assert_eq!(
            DeleteContactRequest {
                ids: vec!["x".into()],
            }
            .encode_to_vec(),
            [0x0a, 0x01, b'x']
        );
    }
}
