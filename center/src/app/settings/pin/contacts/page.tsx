"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ContactRecord } from "@/lib/pin-device";
import { PinApiError, logError, logInfo } from "@/lib/pin-device";
import { StatusMessage } from "@/components/Status";
import { EmptyState, SectionSkeleton } from "@/components/States";
import settings from "../../settings.module.css";
import styles from "../_lib/panes.module.css";
import {
  AcknowledgementRow,
  CrossAuthorityNote,
  DeviceRequired,
  PaneSection,
  ToggleRow,
} from "../_lib/PaneShell";
import { usePinPaneSession } from "../_lib/pinSession";
import {
  EMPTY_DEVICE_CONTACT_DRAFT,
  deviceContactDraftError,
  deviceContactFromDraft,
  deviceContactLabel,
  deviceContactMatches,
  deviceContactWithFavorite,
  draftFromDeviceContact,
  type DeviceContactDraft,
} from "../_lib/deviceContacts";

/*
 * The address book stored on the Pin itself.
 *
 * This is the second contacts pane in Center and it is a DIFFERENT store from
 * the first. /settings/contacts talks to `humane.contacts.ContactsRPCService`
 * at COSMOS_ENDPOINT_CONTACTS — the `contacts` container in the compose stack,
 * Cosmos's own principal-keyed database. This pane talks to `/api/contacts` on
 * the device over USB, which is the Pin runtime's SQLite table. The Pin runtime
 * serves the same gRPC service from that table to the stock contacts client on
 * the device, so this is the book the Pin actually answers from — and nothing
 * syncs between the two in either direction.
 *
 * That is the whole reason for the heading, the help text under it and the
 * cross-link at the bottom. A wearer who edits the wrong one sees a save
 * succeed and no change on the device, which reads as a broken product rather
 * than as the wrong pane.
 *
 * The device applies its own validation and its own upsert semantics; the
 * rules this pane depends on live in `_lib/deviceContacts.ts` next to the
 * evidence for them, so verify/pin-contacts.test.mjs can hold them without a
 * device attached.
 */

type LoadState = "idle" | "loading" | "ready" | "unavailable" | "error";

const SCOPE = "pin-contacts-pane";

/** Long enough for a USB round trip, short enough not to freeze the Edit button. */
const EDIT_REREAD_TIMEOUT_MS = 3_000;

function isUnsupported(error: unknown): boolean {
  return (
    error instanceof PinApiError &&
    (error.status === 404 || error.status === 405 || error.status === 501)
  );
}

export default function PinContactsPane() {
  const { client, connectionError, attachedWithoutServer } = usePinPaneSession();

  const [contacts, setContacts] = useState<ContactRecord[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<DeviceContactDraft | null>(null);
  const [mutating, setMutating] = useState(false);
  const [resetAcknowledged, setResetAcknowledged] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    const requestClient = client;
    setState("loading");
    setMessage(null);
    try {
      const records = await requestClient.listContacts();
      setContacts(records);
      setState("ready");
      logInfo(SCOPE, "Device contacts loaded", { count: records.length });
    } catch (error) {
      const unsupported = isUnsupported(error);
      setState(unsupported ? "unavailable" : "error");
      setMessage(
        unsupported
          ? "This Pin's software does not provide a device address book yet."
          : "Could not load contacts from the Pin.",
      );
      logError(SCOPE, "Device contact load failed", error);
    }
  }, [client]);

  // A connected client is a privacy boundary: never keep one Pin's address book
  // on screen across a disconnect and reconnect in the same browser tab. The
  // open editor goes with it — its `id` refers to a row on the device that is
  // gone from view.
  useEffect(() => {
    setContacts([]);
    setState("idle");
    setMessage(null);
    setNotice(null);
    setDraft(null);
    setResetAcknowledged(false);
    if (client) void load();
  }, [client, load]);

  const visible = useMemo(
    () => contacts.filter((contact) => deviceContactMatches(contact, query)),
    [contacts, query],
  );

  function failureMessage(error: unknown, fallback: string): string {
    if (isUnsupported(error)) {
      return "This Pin's software does not support editing its address book.";
    }
    // A rejected write answers 400 with the device's own `ContactImportError`
    // JSON. Its `message` is generated from the wearer's input rather than from
    // device state, so surfacing it is useful and carries nothing secret; the
    // 500 path deliberately keeps its body out of the UI.
    if (error instanceof PinApiError && error.status === 400) {
      try {
        const body = JSON.parse(error.body) as { message?: unknown };
        if (typeof body.message === "string" && body.message.trim()) {
          return `The Pin rejected this contact: ${body.message.trim()}`;
        }
      } catch {
        // Not the structured shape; fall through to the generic sentence.
      }
    }
    return fallback;
  }

  async function saveDraft() {
    if (!client || !draft || mutating) return;
    const invalid = deviceContactDraftError(draft);
    if (invalid) {
      setMessage(invalid);
      return;
    }
    const existing = draft.id
      ? contacts.find((candidate) => candidate.id === draft.id)
      : undefined;
    const record = deviceContactFromDraft(draft, existing);
    setMutating(true);
    setMessage(null);
    try {
      const saved = draft.id
        ? await client.updateContact(draft.id, record)
        : await client.createContact(record);
      setContacts((current) =>
        draft.id
          ? current.map((candidate) => (candidate.id === draft.id ? saved : candidate))
          : [...current, saved],
      );
      setDraft(null);
      setNotice(
        draft.id
          ? `Saved ${deviceContactLabel(saved)} on the Pin.`
          : `Added ${deviceContactLabel(saved)} to the Pin.`,
      );
    } catch (error) {
      setMessage(failureMessage(error, "Could not save this contact to the Pin."));
      logError(SCOPE, "Device contact save failed", error, { updating: Boolean(draft.id) });
    } finally {
      setMutating(false);
    }
  }

  /*
   * Re-read the one contact, and only then open the editor on it.
   *
   * The list this pane holds is a snapshot: nothing invalidates it when the Pin
   * changes its own book, and the device's own contact sync writes to the same
   * table. Editing a stale row would turn the next save — a whole-record PUT,
   * not a merge — into a silent revert of whatever changed in between.
   *
   * The read finishes BEFORE the form appears rather than refreshing it
   * underneath: a draft swapped out mid-keystroke would discard what the wearer
   * had already typed, which is the same class of loss this re-read exists to
   * prevent. A failed or slow read is not worth blocking the edit over, so the
   * snapshot is the fallback and the read is bounded.
   */
  async function openEditor(contact: ContactRecord) {
    if (!client || mutating || !contact.id) return;
    setMessage(null);
    let record = contact;
    try {
      record = await client.getContact(
        contact.id,
        AbortSignal.timeout(EDIT_REREAD_TIMEOUT_MS),
      );
      setContacts((current) =>
        current.map((candidate) => (candidate.id === contact.id ? record : candidate)),
      );
    } catch (error) {
      logInfo(SCOPE, "Could not re-read contact before editing; using the loaded copy", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    setDraft(draftFromDeviceContact(record));
  }

  async function toggleFavorite(contact: ContactRecord) {
    if (!client || mutating || !contact.id) return;
    const next = contact.internal_favorite !== true;
    setMutating(true);
    setMessage(null);
    try {
      const saved = await client.updateContact(
        contact.id,
        deviceContactWithFavorite(contact, next),
      );
      setContacts((current) =>
        current.map((candidate) => (candidate.id === contact.id ? saved : candidate)),
      );
      setNotice(
        next
          ? `${deviceContactLabel(saved)} is a favourite on this Pin.`
          : `${deviceContactLabel(saved)} is no longer a favourite.`,
      );
    } catch (error) {
      setMessage(failureMessage(error, "Could not change this favourite on the Pin."));
      logError(SCOPE, "Device contact favourite toggle failed", error);
    } finally {
      setMutating(false);
    }
  }

  async function deleteContact(contact: ContactRecord) {
    if (!client || mutating || !contact.id) return;
    if (
      !globalThis.confirm(
        `Delete ${deviceContactLabel(contact)} from this Pin? This is the device's own address book, so Center keeps no copy and this cannot be undone.`,
      )
    ) {
      return;
    }
    setMutating(true);
    setMessage(null);
    try {
      await client.deleteContact(contact.id);
      setContacts((current) => current.filter((candidate) => candidate.id !== contact.id));
      if (draft?.id === contact.id) setDraft(null);
      setNotice(`Deleted ${deviceContactLabel(contact)} from the Pin.`);
    } catch (error) {
      setMessage(failureMessage(error, "Could not delete this contact from the Pin."));
      logError(SCOPE, "Device contact delete failed", error);
    } finally {
      setMutating(false);
    }
  }

  /*
   * Rebuild the Pin's stock contacts database from the list above.
   *
   * What this actually does, end to end: POST /api/contacts/client-reset sets a
   * pending flag on the Pin's server, and the next time arcOS runs
   * ContactsDeltaSyncWorker, Penumbra's hook claims that flag, calls
   * `deleteAll()` on the stock contacts database and clears its sync cursor
   * before letting the original sync run
   * (pin/hook/payload/.../ContactsHooks.kt). The sync then re-pulls everything
   * from the list on this pane.
   *
   * So it does NOT delete anything shown here — but it is still destructive,
   * and precisely so: any contact that exists only in the stock database and
   * not in this list is gone for good, and the Pin has no address book at all
   * between the wipe and the sync finishing. That is what the acknowledgement
   * below states, and why the button stays disabled until it is ticked.
   */
  async function clientReset() {
    if (!client || mutating || !resetAcknowledged) return;
    if (
      !globalThis.confirm(
        "Rebuild the Pin's contacts database from this list? Anything the Pin holds that is not listed on this pane is deleted and cannot be recovered.",
      )
    ) {
      return;
    }
    setMutating(true);
    setMessage(null);
    try {
      const response = await client.clientResetContacts();
      setResetAcknowledged(false);
      setNotice(
        response.queued
          ? "Rebuild queued. The Pin clears and re-syncs its contacts database on its next contact sync."
          : "The Pin did not queue a rebuild. Try again once it is idle.",
      );
      logInfo(SCOPE, "Contact client reset requested", {
        queued: response.queued,
        receivers: response.receivers,
      });
    } catch (error) {
      setMessage(
        failureMessage(error, "Could not ask the Pin to rebuild its contacts database."),
      );
      logError(SCOPE, "Contact client reset failed", error);
    } finally {
      setMutating(false);
    }
  }

  if (!client) {
    return (
      <DeviceRequired
        attachedWithoutServer={attachedWithoutServer}
        what="the address book stored on this Pin"
        connectionError={connectionError}
      />
    );
  }

  if (state === "loading" || state === "idle") {
    return <SectionSkeleton rows={4} />;
  }

  if (state === "unavailable" || state === "error") {
    return (
      <PaneSection title="Contacts on this Pin" testId="pin-contacts">
        <div className={settings.stateRow}>
          <StatusMessage
            tone="warning"
            onRetry={state === "error" ? () => void load() : undefined}
          >
            {message}
          </StatusMessage>
        </div>
      </PaneSection>
    );
  }

  return (
    <>
      <PaneSection
        title="Contacts on this Pin"
        testId="pin-contacts"
        action={
          <span className={styles.chipRow}>
            <button
              type="button"
              className={styles.smallButton}
              onClick={() => void load()}
              disabled={mutating}
            >
              Refresh
            </button>
            <button
              type="button"
              className={styles.smallButton}
              onClick={() => {
                setMessage(null);
                setDraft({ ...EMPTY_DEVICE_CONTACT_DRAFT });
              }}
              disabled={mutating || draft !== null}
            >
              Add contact
            </button>
          </span>
        }
      >
        <div className={styles.formRow}>
          <p className={styles.formHelp}>
            The device&rsquo;s own address book, read through Center&rsquo;s active Pin
            connection. This is what the Pin answers calls and messages from — it is
            a different store from the contacts in your account, and edits here do
            not appear there.
          </p>
          {notice ? <StatusMessage tone="info">{notice}</StatusMessage> : null}
          {message ? <StatusMessage tone="warning">{message}</StatusMessage> : null}
        </div>

        {draft ? (
          <DeviceContactEditor
            draft={draft}
            busy={mutating}
            onChange={setDraft}
            onSave={() => void saveDraft()}
            onCancel={() => {
              setDraft(null);
              setMessage(null);
            }}
          />
        ) : null}

        <div className={styles.formRow}>
          <div className={styles.field}>
            <label className={styles.formLabel} htmlFor="pin-contact-search">
              Search this Pin&rsquo;s contacts
            </label>
            <input
              id="pin-contact-search"
              className={styles.input}
              value={query}
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name, organisation, number or email"
            />
          </div>
        </div>

        {contacts.length === 0 ? (
          <EmptyState
            inline
            title="This Pin has no contacts"
            detail="Add one here, or import your account's contacts onto the device from the Pin itself."
          />
        ) : visible.length === 0 ? (
          <div className={settings.stateRow}>
            <span className={settings.muted}>No contacts on this Pin match that search.</span>
            <button
              type="button"
              className={settings.stateAction}
              onClick={() => setQuery("")}
            >
              Clear the search
            </button>
          </div>
        ) : (
          visible.map((contact) => (
            <article
              className={styles.card}
              key={contact.id ?? deviceContactLabel(contact)}
              data-testid="pin-contact"
            >
              <div className={styles.cardHeading}>
                <span className={styles.cardTitleGroup}>
                  <span className={styles.cardTitleLine}>
                    <h3 className={styles.cardTitle}>{deviceContactLabel(contact)}</h3>
                    {contact.internal_favorite ? (
                      <span className={`${styles.chip} ${styles.chipLive}`}>Favourite</span>
                    ) : null}
                    {contact.trusted ? <span className={styles.chip}>Trusted</span> : null}
                    {contact.emergency ? (
                      <span className={`${styles.chip} ${styles.chipWarning}`}>Emergency</span>
                    ) : null}
                  </span>
                  {contact.organization ? (
                    <span className={styles.cardMeta}>{contact.organization}</span>
                  ) : null}
                </span>
                <span className={styles.chipRow}>
                  <button
                    type="button"
                    className={styles.smallButton}
                    disabled={mutating || !contact.id}
                    aria-pressed={contact.internal_favorite === true}
                    onClick={() => void toggleFavorite(contact)}
                  >
                    {contact.internal_favorite ? "Unfavourite" : "Favourite"}
                  </button>
                  <button
                    type="button"
                    className={styles.smallButton}
                    disabled={mutating || !contact.id}
                    onClick={() => void openEditor(contact)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={styles.linkButton}
                    disabled={mutating || !contact.id}
                    onClick={() => void deleteContact(contact)}
                  >
                    Delete
                  </button>
                </span>
              </div>

              {(contact.phone_numbers ?? []).length > 0 ? (
                <span className={styles.cardMeta}>
                  {(contact.phone_numbers ?? []).map((phone) => phone.value).join(" · ")}
                </span>
              ) : null}
              {(contact.emails ?? []).length > 0 ? (
                <span className={styles.cardMeta}>
                  {(contact.emails ?? []).map((email) => email.value).join(" · ")}
                </span>
              ) : null}
            </article>
          ))
        )}
      </PaneSection>

      <PaneSection title="Rebuild the Pin's contacts database" testId="pin-contacts-reset">
        <div className={styles.formRow}>
          <p className={styles.formHelp}>
            Use this when the Pin shows contacts that are not on this list, or shows
            none at all. It tells the Pin to empty the address book its own software
            keeps and re-sync it from the contacts above on the next contact sync.
          </p>
          <p className={styles.formHelp}>
            Anything the Pin holds that is <strong>not</strong> listed above is deleted
            and cannot be recovered, and the Pin has no contacts at all until the
            re-sync finishes. Nothing on this pane and nothing in your account is
            touched.
          </p>
        </div>

        <AcknowledgementRow
          checked={resetAcknowledged}
          onChange={setResetAcknowledged}
          disabled={mutating}
        >
          I understand the Pin&rsquo;s own contacts database will be emptied and rebuilt
          from the list above.
        </AcknowledgementRow>

        <div className={styles.actionRowEnd}>
          <button
            type="button"
            className={styles.dangerButton}
            disabled={mutating || !resetAcknowledged}
            onClick={() => void clientReset()}
            data-testid="pin-contacts-client-reset"
          >
            Rebuild contacts database
          </button>
        </div>
      </PaneSection>

      <PaneSection title="What this pane is" testId="pin-contacts-authority">
        <CrossAuthorityNote href="/settings/contacts" linkLabel="Account contacts">
          These contacts are available to your Pin for calls and messages. Your account keeps a
          separate list, and Center never merges the two automatically.
        </CrossAuthorityNote>
      </PaneSection>
    </>
  );
}

/**
 * The add/edit form.
 *
 * Multi-values are `|`-separated in one field, the same convention
 * /settings/contacts uses, so a wearer who learned it on one contacts pane does
 * not have to learn a second. Every field is always submitted — see
 * `deviceContactFromDraft` for why clearing one really does clear it.
 */
function DeviceContactEditor({
  draft,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  draft: DeviceContactDraft;
  busy: boolean;
  onChange: (next: DeviceContactDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const field = (key: keyof DeviceContactDraft, value: string) =>
    onChange({ ...draft, [key]: value });

  return (
    <div className={styles.subpanel} data-testid="pin-contact-editor">
      <span className={styles.subpanelTitle}>
        {draft.id ? "Edit this contact on the Pin" : "Add a contact to the Pin"}
      </span>

      <TextField
        id="pin-contact-display-name"
        label="Display name"
        value={draft.displayName}
        busy={busy}
        onChange={(value) => field("displayName", value)}
      />
      <TextField
        id="pin-contact-first-name"
        label="First name"
        value={draft.firstName}
        busy={busy}
        onChange={(value) => field("firstName", value)}
      />
      <TextField
        id="pin-contact-last-name"
        label="Last name"
        value={draft.lastName}
        busy={busy}
        onChange={(value) => field("lastName", value)}
      />
      <TextField
        id="pin-contact-nickname"
        label="Nickname"
        value={draft.nickname}
        busy={busy}
        onChange={(value) => field("nickname", value)}
      />
      <TextField
        id="pin-contact-organization"
        label="Organisation"
        value={draft.organization}
        busy={busy}
        onChange={(value) => field("organization", value)}
      />
      <TextField
        id="pin-contact-phones"
        label="Phone numbers"
        value={draft.phoneNumbers}
        busy={busy}
        help="Separate multiple numbers with |"
        onChange={(value) => field("phoneNumbers", value)}
      />
      <TextField
        id="pin-contact-emails"
        label="Email addresses"
        value={draft.emails}
        busy={busy}
        help="Separate multiple addresses with |"
        onChange={(value) => field("emails", value)}
      />

      {/*
        Switches, not the acknowledgement checkbox: these are capabilities the
        wearer operates on the device, not statements they make about a risk.
        `internal_favorite` is here because it is stored per contact and has no
        endpoint of its own — the only way to set it is a whole-record save.
      */}
      <ToggleRow
        copy="Favourite on the device"
        ariaLabel="Favourite on the device"
        checked={draft.favorite}
        disabled={busy}
        onChange={(next) => onChange({ ...draft, favorite: next })}
      />
      <ToggleRow
        copy="Trusted — the Pin accepts inbound messages and calls from this contact"
        ariaLabel="Trusted contact"
        checked={draft.trusted}
        disabled={busy}
        onChange={(next) => onChange({ ...draft, trusted: next })}
      />
      <ToggleRow
        copy="Emergency contact"
        ariaLabel="Emergency contact"
        checked={draft.emergency}
        disabled={busy}
        onChange={(next) => onChange({ ...draft, emergency: next })}
      />

      <div className={styles.actionRowEnd}>
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={busy || deviceContactDraftError(draft) !== null}
          onClick={onSave}
        >
          {busy ? "Saving…" : "Save to the Pin"}
        </button>
      </div>
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  busy,
  help,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  busy: boolean;
  help?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className={styles.formRow}>
      <div className={styles.field}>
        <label className={styles.formLabel} htmlFor={id}>
          {label}
        </label>
        <input
          id={id}
          className={styles.input}
          value={value}
          disabled={busy}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
        />
        {help ? <p className={styles.formHelp}>{help}</p> : null}
      </div>
    </div>
  );
}
