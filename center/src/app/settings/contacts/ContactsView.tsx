"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import settings from "../settings.module.css";
import styles from "./contacts.module.css";
import { SectionSkeleton } from "@/components/States";
import { StatusMessage } from "@/components/Status";
import { parseContactFile, type ImportedContact } from "@/lib/contactImport";

interface ContactRecord extends ImportedContact {
  id: string;
}

interface ContactsResponse {
  contacts: ContactRecord[];
  state?: "live" | "absent" | "degraded";
}

interface EditorState {
  id?: string;
  displayName: string;
  phoneNumbers: string;
  emails: string;
  organization: string;
  trusted: boolean;
  emergency: boolean;
}

const EMPTY_EDITOR: EditorState = {
  displayName: "",
  phoneNumbers: "",
  emails: "",
  organization: "",
  trusted: false,
  emergency: false,
};

export function ContactsView() {
  const [tab, setTab] = useState<"all" | "trusted">("all");
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["contacts", query],
    queryFn: async () => {
      const response = await fetch(`/api/contacts?q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error(`contacts returned ${response.status}`);
      return (await response.json()) as ContactsResponse;
    },
    staleTime: 5000,
  });

  const contacts = (data?.contacts ?? []).filter((contact) => tab === "all" || contact.trusted);
  const filtered = Boolean(query) || tab === "trusted";
  const failed = isError || data?.state === "degraded";
  const absent = !isError && data?.state === "absent";

  async function saveContact() {
    if (!editor?.displayName.trim()) return;
    setBusy(true);
    setActionError(null);
    const contact = {
      displayName: editor.displayName.trim(),
      phoneNumbers: splitValues(editor.phoneNumbers),
      emails: splitValues(editor.emails),
      organization: editor.organization.trim() || null,
      trusted: editor.trusted,
      emergency: editor.emergency,
    };
    const response = await fetch("/api/contacts", {
      method: editor.id ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(editor.id ? { id: editor.id, contact } : { contacts: [contact] }),
    }).catch(() => null);
    if (!response?.ok) {
      const body = (await response?.json().catch(() => ({}))) as { error?: string } | undefined;
      setActionError(body?.error ?? "This contact couldn’t be saved.");
    } else {
      setNotice(editor.id ? "Contact updated." : "Contact added.");
      setEditor(null);
      await refetch();
    }
    setBusy(false);
  }

  async function deleteOne(contact: ContactRecord) {
    if (!window.confirm(`Delete ${contact.displayName}?`)) return;
    setBusy(true);
    setActionError(null);
    const response = await fetch("/api/contacts", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: contact.id }),
    }).catch(() => null);
    if (!response?.ok) {
      setActionError("This contact couldn’t be deleted.");
    } else {
      setNotice("Contact deleted.");
      if (editor?.id === contact.id) setEditor(null);
      await refetch();
    }
    setBusy(false);
  }

  async function importFile(file: File) {
    setActionError(null);
    setNotice(null);
    if (file.size > 1_000_000) {
      setActionError("Choose a contact file smaller than 1 MB.");
      return;
    }
    const contacts = parseContactFile(await file.text(), file.name);
    if (!contacts.length) {
      setActionError("No contacts were found in that file.");
      return;
    }
    setBusy(true);
    const response = await fetch("/api/contacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contacts }),
    }).catch(() => null);
    if (!response?.ok) {
      const body = (await response?.json().catch(() => ({}))) as { error?: string } | undefined;
      setActionError(body?.error ?? "The contacts couldn’t be imported.");
    } else {
      setNotice(`Imported ${contacts.length} contact${contacts.length === 1 ? "" : "s"}.`);
      await refetch();
    }
    setBusy(false);
  }

  return (
    <section className={settings.section}>
      <div className={settings.sectionHeader}>
        <span className={settings.sectionTitle}>Contacts</span>
        <div className={styles.headerTools}>
          <div className={settings.tabRow}>
            {(["all", "trusted"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                aria-pressed={tab === value}
                className={`${settings.tabButton} ${tab === value ? settings.tabButtonActive : ""}`}
              >
                {value === "all" ? "All" : "Trusted"}
              </button>
            ))}
          </div>
          <input
            ref={fileInput}
            className={styles.fileInput}
            type="file"
            accept=".csv,.vcf,.vcard,text/csv,text/vcard"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile(file);
              event.target.value = "";
            }}
          />
          <button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => fileInput.current?.click()}>
            Import
          </button>
          <button className={styles.primaryButton} type="button" disabled={busy} onClick={() => setEditor({ ...EMPTY_EDITOR })}>
            Add contact
          </button>
        </div>
      </div>

      {editor ? (
        <ContactEditor editor={editor} busy={busy} onChange={setEditor} onSave={() => void saveContact()} onCancel={() => setEditor(null)} />
      ) : null}

      <div className={settings.infoRowRoot}>
        <input
          className={settings.searchField}
          data-testid="search-contacts-field"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search contacts"
          aria-label="Search contacts"
        />
      </div>

      {notice ? <div className={settings.stateRow}><StatusMessage tone="info" inline>{notice}</StatusMessage></div> : null}
      {actionError ? <div className={settings.stateRow}><StatusMessage tone="warning" inline>{actionError}</StatusMessage></div> : null}

      {isLoading ? (
        <SectionSkeleton rows={4} />
      ) : failed ? (
        <div className={settings.stateRow}>
          <StatusMessage tone="warning" onRetry={() => void refetch()}>Your contacts couldn&rsquo;t be loaded just now.</StatusMessage>
        </div>
      ) : absent ? (
        <div className={settings.stateRow}><span className={settings.muted}>Connect a Pin to manage contacts.</span></div>
      ) : contacts.length === 0 ? (
        <div className={settings.stateRow}>
          <span className={settings.muted}>{filtered ? "No matching contacts." : "No contacts yet."}</span>
          {filtered ? <button type="button" className={settings.stateAction} onClick={() => { setQuery(""); setTab("all"); }}>Clear the filter</button> : null}
        </div>
      ) : contacts.map((contact) => (
        <div className={settings.infoRowRoot} key={contact.id}>
          <span className={settings.titleInfo} data-testid="info-row-title">
            {contact.displayName}{contact.emergency ? " · Emergency" : ""}
          </span>
          <div className={settings.descWrapper}>
            {contact.phoneNumbers.length ? <span className={settings.description}>{contact.phoneNumbers.join(", ")}</span> : null}
            {contact.emails.length ? <span className={settings.muted}>{contact.emails.join(", ")}</span> : null}
            {contact.organization ? <span className={settings.muted}>{contact.organization}</span> : null}
          </div>
          <div className={styles.rowTools}>
            {contact.trusted ? <span className={styles.trusted}>Trusted</span> : null}
            <button type="button" className={styles.quietButton} disabled={busy} onClick={() => setEditor(toEditor(contact))}>Edit</button>
            <button type="button" className={styles.deleteButton} disabled={busy} onClick={() => void deleteOne(contact)}>Delete</button>
          </div>
        </div>
      ))}
    </section>
  );
}

function ContactEditor({ editor, busy, onChange, onSave, onCancel }: {
  editor: EditorState;
  busy: boolean;
  onChange: (value: EditorState) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const field = (key: "displayName" | "phoneNumbers" | "emails" | "organization", value: string) => onChange({ ...editor, [key]: value });
  return (
    <div className={styles.editor}>
      <div className={styles.formGrid}>
        <label><span>Name</span><input autoFocus className={styles.field} value={editor.displayName} onChange={(event) => field("displayName", event.target.value)} /></label>
        <label><span>Phone numbers</span><input className={styles.field} value={editor.phoneNumbers} onChange={(event) => field("phoneNumbers", event.target.value)} placeholder="Separate multiple values with |" /></label>
        <label><span>Email addresses</span><input className={styles.field} value={editor.emails} onChange={(event) => field("emails", event.target.value)} placeholder="Separate multiple values with |" /></label>
        <label><span>Organization</span><input className={styles.field} value={editor.organization} onChange={(event) => field("organization", event.target.value)} /></label>
      </div>
      <div className={styles.editorFooter}>
        <div className={styles.checks}>
          <label><input type="checkbox" checked={editor.trusted} onChange={(event) => onChange({ ...editor, trusted: event.target.checked })} /> Trusted</label>
          <label><input type="checkbox" checked={editor.emergency} onChange={(event) => onChange({ ...editor, emergency: event.target.checked })} /> Emergency contact</label>
        </div>
        <div className={styles.editorActions}>
          <button type="button" className={styles.secondaryButton} disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className={styles.primaryButton} disabled={busy || !editor.displayName.trim()} onClick={onSave}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

function toEditor(contact: ContactRecord): EditorState {
  return {
    id: contact.id,
    displayName: contact.displayName,
    phoneNumbers: contact.phoneNumbers.join(" | "),
    emails: contact.emails.join(" | "),
    organization: contact.organization ?? "",
    trusted: contact.trusted,
    emergency: contact.emergency,
  };
}

function splitValues(value: string): string[] {
  return value.split("|").map((part) => part.trim()).filter(Boolean);
}
