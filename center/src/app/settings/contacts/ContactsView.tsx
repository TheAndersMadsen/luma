"use client";

import { SessionReconnect } from "@/components/SessionReconnect";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import settings from "../settings.module.css";
import styles from "./contacts.module.css";
import { SectionSkeleton } from "@/components/States";
import { StatusMessage } from "@/components/Status";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import {
  MAX_CONTACT_VALUES,
  derivedDisplayName,
  importBatches,
  parseContactFile,
  type ContactDraft,
  type ContactValue,
} from "@/lib/contactImport";
import { contactsResponseSchema, type ContactRecord } from "@/lib/contracts/contacts";
import { parseResponse } from "@/lib/contracts/parse";

interface EditorState {
  id?: string;
  firstName: string;
  lastName: string;
  nickname: string;
  displayName: string;
  phoneNumbers: ContactValue[];
  emails: ContactValue[];
  organization: string;
  trusted: boolean;
  emergency: boolean;
  favorite: boolean;
  /** First and last name were proposed from the display name. Say so. */
  splitFromDisplayName: boolean;
}

type NameField = "firstName" | "lastName" | "nickname" | "displayName" | "organization";
type ValueList = "phoneNumbers" | "emails";

const EMPTY_EDITOR: EditorState = {
  firstName: "",
  lastName: "",
  nickname: "",
  displayName: "",
  phoneNumbers: [{ value: "", type: "" }],
  emails: [],
  organization: "",
  trusted: false,
  emergency: false,
  favorite: false,
  splitFromDisplayName: false,
};

/**
 * The largest contact file Center reads. Only names, numbers and addresses are
 * kept, so an export's photos can make the file far larger than its import.
 */
const MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024;

/** Labels the Pin shows as written. A blank phone label reads "cell" there. */
const PHONE_LABELS = ["mobile", "home", "work", "main", "other"];
const EMAIL_LABELS = ["home", "work", "other"];

export function ContactsView() {
  const [tab, setTab] = useState<"all" | "trusted">("all");
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const editorStart = useRef<EditorState | null>(null);
  const dirty = editor !== null && JSON.stringify(editor) !== JSON.stringify(editorStart.current);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ message: string; reauthenticate?: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function openEditor(next: EditorState | null) {
    if (dirty && !window.confirm("Discard your changes to this contact?")) return;
    editorStart.current = next;
    setEditor(next);
    setActionError(null);
  }

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["contacts", query],
    queryFn: async () => {
      const response = await fetch(`/api/contacts?q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error(`contacts returned ${response.status}`);
      return parseResponse(contactsResponseSchema, await response.json());
    },
    staleTime: 5000,
  });

  const contacts = (data?.contacts ?? []).filter((contact) => tab === "all" || contact.trusted);
  const filtered = Boolean(query) || tab === "trusted";
  const failed = isError || data?.state === "degraded";
  const absent = !isError && data?.state === "absent";
  // A live read that still could not show everything: sealed contacts exist,
  // so the list is short, and "No contacts yet." would be untrue.
  const sealedNote = !isError && data?.state === "live" ? data.degraded : undefined;

  async function saveContact() {
    if (busy || !editor || !hasName(editor)) return;
    setBusy(true);
    setActionError(null);
    const contact: ContactDraft = {
      firstName: editor.firstName.trim(),
      lastName: editor.lastName.trim(),
      nickname: editor.nickname.trim(),
      displayName: editor.displayName.trim(),
      phoneNumbers: cleanValues(editor.phoneNumbers),
      emails: cleanValues(editor.emails),
      organization: editor.organization.trim() || null,
      trusted: editor.trusted,
      emergency: editor.emergency,
      favorite: editor.favorite,
      source: null,
    };
    const response = await fetch("/api/contacts", {
      method: editor.id ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(editor.id ? { id: editor.id, contact } : { contacts: [contact] }),
    }).catch(() => null);
    if (!response?.ok) {
      const body = (await response?.json().catch(() => ({}))) as
        | { error?: string; reauthenticate?: boolean }
        | undefined;
      setActionError(body?.reauthenticate
        ? { message: "Your session expired, so nothing was saved.", reauthenticate: true }
        : { message: body?.error ?? "This contact couldn’t be saved." });
    } else {
      setNotice(editor.id ? "Contact updated. Your Pin gets it at its next sync." : "Contact added. Your Pin gets it at its next sync.");
      setEditor(null);
      await refetch();
    }
    setBusy(false);
  }

  async function deleteOne(contact: ContactRecord) {
    if (!window.confirm(`Delete ${contact.label}? Your Pin removes them when it next syncs, and this can’t be undone.`)) return;
    setBusy(true);
    setActionError(null);
    const response = await fetch("/api/contacts", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: contact.id }),
    }).catch(() => null);
    if (!response?.ok) {
      const body = (await response?.json().catch(() => ({}))) as
        | { error?: string; reauthenticate?: boolean }
        | undefined;
      setActionError(body?.reauthenticate
        ? { message: "Your session expired, so the contact was not deleted.", reauthenticate: true }
        : { message: body?.error ?? "This contact couldn’t be deleted." });
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
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      setActionError({ message: "Choose a contact file smaller than 20 MB." });
      return;
    }
    const contacts = parseContactFile(await file.text(), file.name);
    if (!contacts.length) {
      setActionError({ message: "No contacts were found in that file." });
      return;
    }
    setBusy(true);
    // The route takes 500 contacts per request. Send every one, in order, and
    // stop at the first request that fails so the count below is exact.
    let imported = 0;
    let failure: string | null = null;
    let failureExpired = false;
    for (const batch of importBatches(contacts)) {
      const response = await fetch("/api/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contacts: batch }),
      }).catch(() => null);
      if (!response?.ok) {
        const body = (await response?.json().catch(() => ({}))) as
          | { error?: string; reauthenticate?: boolean }
          | undefined;
        failure = body?.error ?? "The contacts couldn’t be imported.";
        failureExpired = body?.reauthenticate === true;
        break;
      }
      imported += batch.length;
    }
    if (failure === null) {
      setNotice(`Imported ${contacts.length} contact${contacts.length === 1 ? "" : "s"}.`);
    } else if (imported === 0) {
      setActionError(failureExpired
        ? { message: "Your session expired, so nothing was imported.", reauthenticate: true }
        : { message: failure });
    } else {
      setActionError(failureExpired
        ? { message: `Imported ${imported} of ${contacts.length} contacts, then your session expired.`, reauthenticate: true }
        : { message: `Imported ${imported} of ${contacts.length} contacts. The rest couldn’t be saved: ${failure}` });
    }
    if (imported > 0) await refetch();
    setBusy(false);
  }

  return (
    <section className={settings.section}>
      <UnsavedChangesGuard when={dirty} message="Leave without saving changes to this contact?" />
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
          <button className={styles.primaryButton} type="button" disabled={busy} onClick={() => openEditor({ ...EMPTY_EDITOR })}>
            Add contact
          </button>
        </div>
      </div>

      {editor ? (
        <ContactEditor editor={editor} busy={busy} onChange={setEditor} onSave={() => void saveContact()} onCancel={() => openEditor(null)} />
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
      {actionError ? (
        <div className={settings.stateRow}>
          <StatusMessage tone="warning" inline>
            {actionError.message}
            {actionError.reauthenticate ? <> <SessionReconnect onReconnected={() => setActionError(null)} /> to continue.</> : null}
          </StatusMessage>
        </div>
      ) : null}

      {isLoading ? (
        <SectionSkeleton rows={4} />
      ) : failed ? (
        <div className={settings.stateRow}>
          <StatusMessage tone="warning" onRetry={() => void refetch()}>Your contacts couldn&rsquo;t be loaded just now.</StatusMessage>
        </div>
      ) : absent ? (
        <div className={settings.stateRow}><StatusMessage tone="info">Connect your Pin to manage contacts.</StatusMessage></div>
      ) : (
        <>
          {sealedNote ? (
            <div className={settings.stateRow} data-testid="contacts-sealed">
              <StatusMessage tone="info" inline>{sealedNote}</StatusMessage>
            </div>
          ) : null}
          {contacts.length === 0 ? (
            filtered || !sealedNote ? (
              <div className={settings.stateRow}>
                <span className={settings.muted}>{filtered ? "No matching contacts." : "No contacts yet."}</span>
                {filtered ? <button type="button" className={settings.stateAction} onClick={() => { setQuery(""); setTab("all"); }}>Clear the filter</button> : null}
              </div>
            ) : null
          ) : contacts.map((contact) => (
            <div className={settings.infoRowRoot} key={contact.id}>
              <span className={settings.titleInfo} data-testid="info-row-title">
                {contact.label}
                {contact.nickname && contact.nickname !== contact.label ? ` “${contact.nickname}”` : ""}
                {contact.emergency ? " · Emergency" : ""}
              </span>
              <div className={settings.descWrapper}>
                {contact.phoneNumbers.length ? <span className={settings.description}>{formatValues(contact.phoneNumbers)}</span> : null}
                {contact.emails.length ? <span className={settings.muted}>{formatValues(contact.emails)}</span> : null}
                {contact.organization ? <span className={settings.muted}>{contact.organization}</span> : null}
                {!contact.firstName && !contact.lastName && !contact.nickname ? (
                  <span className={settings.muted}>Add a first name so your Pin can find this contact by name.</span>
                ) : null}
              </div>
              <div className={styles.rowTools}>
                {contact.favorite ? <span className={styles.favorite}>Favourite</span> : null}
                {contact.trusted ? <span className={styles.trusted}>Trusted</span> : null}
                <button type="button" className={styles.quietButton} disabled={busy} onClick={() => openEditor(toEditor(contact))}>Edit</button>
                <button type="button" className={styles.deleteButton} disabled={busy} onClick={() => void deleteOne(contact)}>Delete</button>
              </div>
            </div>
          ))}
        </>
      )}
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
  const field = (key: NameField, value: string) => onChange({ ...editor, [key]: value });
  const setValue = (list: ValueList, index: number, patch: Partial<ContactValue>) =>
    onChange({ ...editor, [list]: editor[list].map((item, at) => (at === index ? { ...item, ...patch } : item)) });
  const addValue = (list: ValueList) => onChange({ ...editor, [list]: [...editor[list], { value: "", type: "" }] });
  const removeValue = (list: ValueList, index: number) =>
    onChange({ ...editor, [list]: editor[list].filter((_, at) => at !== index) });

  return (
    <fieldset className={styles.editor} disabled={busy} aria-label="Contact details">
      <div className={styles.formGrid}>
        <label><span>First name</span><input autoFocus className={styles.field} value={editor.firstName} onChange={(event) => field("firstName", event.target.value)} /></label>
        <label><span>Last name</span><input className={styles.field} value={editor.lastName} onChange={(event) => field("lastName", event.target.value)} /></label>
        <label><span>Nickname</span><input className={styles.field} value={editor.nickname} onChange={(event) => field("nickname", event.target.value)} /></label>
        <label>
          <span>Display name</span>
          <input
            className={styles.field}
            value={editor.displayName}
            onChange={(event) => field("displayName", event.target.value)}
            placeholder={derivedDisplayName(editor) || "Shown on calls"}
          />
        </label>
        <label><span>Organization</span><input className={styles.field} value={editor.organization} onChange={(event) => field("organization", event.target.value)} /></label>
      </div>
      <p className={styles.hint}>
        {editor.splitFromDisplayName
          ? "First and last name were filled in from the display name. Check them before saving: your Pin finds contacts by first name, last name and nickname."
          : "Your Pin finds contacts by first name, last name and nickname."}
      </p>

      <ValueRows
        title="Phone numbers"
        addLabel="Add phone number"
        list="phoneNumbers"
        values={editor.phoneNumbers}
        labels={PHONE_LABELS}
        inputType="tel"
        busy={busy}
        onSet={setValue}
        onAdd={addValue}
        onRemove={removeValue}
      />
      <ValueRows
        title="Email addresses"
        addLabel="Add email address"
        list="emails"
        values={editor.emails}
        labels={EMAIL_LABELS}
        inputType="email"
        busy={busy}
        onSet={setValue}
        onAdd={addValue}
        onRemove={removeValue}
      />

      <div className={styles.editorFooter}>
        <div className={styles.checks}>
          <label><input type="checkbox" checked={editor.trusted} onChange={(event) => onChange({ ...editor, trusted: event.target.checked })} /> Trusted</label>
          <label><input type="checkbox" checked={editor.favorite} onChange={(event) => onChange({ ...editor, favorite: event.target.checked })} /> Favourite</label>
          <label><input type="checkbox" checked={editor.emergency} onChange={(event) => onChange({ ...editor, emergency: event.target.checked })} /> Emergency contact</label>
          {/*
           * `humane.contacts.Contact.emergency` is stored and round-tripped, but
           * the stock Pin ignores it: ironman ContactAdapters.protobufToEntities
           * keeps name, trusted, temporary, internal_favorite, phones and
           * e-mails only, and no ironman or humane_dialer code reads
           * getEmergency(). The control keeps humane.center's field editable;
           * that humane.center offered it is INFERRED from the stock message.
           */}
          <small className={styles.checkHint}>Emergency is saved with the contact; your Pin doesn’t act on it.</small>
        </div>
        <div className={styles.editorActions}>
          <button type="button" className={styles.secondaryButton} disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className={styles.primaryButton} disabled={busy || !hasName(editor)} onClick={onSave}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </fieldset>
  );
}

function ValueRows({ title, addLabel, list, values, labels, inputType, busy, onSet, onAdd, onRemove }: {
  title: string;
  addLabel: string;
  list: ValueList;
  values: ContactValue[];
  labels: string[];
  inputType: "tel" | "email";
  busy: boolean;
  onSet: (list: ValueList, index: number, patch: Partial<ContactValue>) => void;
  onAdd: (list: ValueList) => void;
  onRemove: (list: ValueList, index: number) => void;
}) {
  const options = `${list}-labels`;
  return (
    <fieldset className={styles.values}>
      <legend>{title}</legend>
      <datalist id={options}>
        {labels.map((label) => <option key={label} value={label} />)}
      </datalist>
      {values.map((item, index) => (
        <div className={styles.valueRow} key={index}>
          <input
            className={`${styles.field} ${styles.labelField}`}
            list={options}
            value={item.type}
            onChange={(event) => onSet(list, index, { type: event.target.value })}
            placeholder="Label"
            aria-label={`${title} label ${index + 1}`}
          />
          <input
            className={styles.field}
            type={inputType}
            value={item.value}
            onChange={(event) => onSet(list, index, { value: event.target.value })}
            aria-label={`${title} ${index + 1}`}
          />
          <button type="button" className={styles.quietButton} disabled={busy} onClick={() => onRemove(list, index)}>Remove</button>
        </div>
      ))}
      <button type="button" className={styles.quietButton} disabled={busy || values.length >= MAX_CONTACT_VALUES} onClick={() => onAdd(list)}>{addLabel}</button>
    </fieldset>
  );
}

function hasName(editor: EditorState): boolean {
  return [editor.firstName, editor.lastName, editor.nickname, editor.displayName].some((part) => part.trim());
}

/**
 * Open a contact for editing. A contact that has only a display name, how
 * Center used to save every contact, gets a proposed first and last name, so
 * saving makes it findable by voice. The wearer sees and can change them.
 */
function toEditor(contact: ContactRecord): EditorState {
  const unnamed = !contact.firstName && !contact.lastName && !contact.nickname && /\p{L}/u.test(contact.displayName);
  const words = unnamed ? contact.displayName.trim().split(/\s+/).filter(Boolean) : [];
  // The last of two or more words is the last name. The rest are the first.
  const [firstWord, ...laterWords] = words;
  const lastWord = laterWords.pop();
  const split = firstWord !== undefined;
  return {
    id: contact.id,
    firstName: split ? [firstWord, ...laterWords].join(" ") : contact.firstName,
    lastName: lastWord ?? contact.lastName,
    nickname: contact.nickname,
    // The split restates the display name, so leave it to be derived.
    displayName: split ? "" : contact.displayName,
    phoneNumbers: contact.phoneNumbers.map((item) => ({ ...item })),
    emails: contact.emails.map((item) => ({ ...item })),
    organization: contact.organization ?? "",
    trusted: contact.trusted,
    emergency: contact.emergency,
    favorite: contact.favorite,
    splitFromDisplayName: split,
  };
}

function cleanValues(values: ContactValue[]): ContactValue[] {
  return values
    .map(({ value, type }) => ({ value: value.trim(), type: type.trim() }))
    .filter(({ value }) => value);
}

function formatValues(values: ContactValue[]): string {
  return values.map(({ value, type }) => (type ? `${value} (${type})` : value)).join(", ");
}
