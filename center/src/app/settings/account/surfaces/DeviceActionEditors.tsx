"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Switch } from "@/components/Status";
import { exact } from "@/lib/contracts/surfaces";
import type { NativeSurface } from "@/lib/contracts/nativeSurfaces";
import {
  ACTION_CLASSES, applicationId, boundedText, declaredHost, MAX_APPS, MAX_HOSTS, MAX_LABEL_BYTES, MAX_ROOTS,
  MAX_ROOT_ID_BYTES, MAX_ROOT_PATH_BYTES, MAX_PROVIDERS, providerId, rootPath, validActionPolicy,
  type ActionClass, type DeviceActionApproval, type DeviceActionPolicy,
} from "@/lib/contracts/deviceActions";
import {
  bodyBytes, DEVICE_COMMANDS_APPROVAL, DEVICE_COMMANDS_BYTES, MAX_ARGV, MAX_ARGV_BYTES, MAX_BUDGET_MS,
  MAX_COMMAND_ENTRIES, MAX_ENTRY_ID_BYTES, SENSITIVE_LABEL_MESSAGE, validArgument, validCommandEntry, validCommandPolicy,
  type CommandEntry, type DeviceCommandApproval, type DeviceCommandPolicy,
} from "@/lib/contracts/deviceCommands";
import styles from "./surfaces.module.css";
import type { PermissionFailure, PermissionState } from "./permissions";

/**
 * The two owner permissions that let a device do something rather than show or
 * say something. Both edit one whole policy document, because that is what
 * Cosmos stores and what its revision check compares: a half-written list is
 * never sent.
 */

/** Said once, above both, because it is the thing an owner most easily assumes wrongly. */
export const BLAST_RADIUS = "These two permissions apply to this device only. Nothing here changes what any other device may do.";

/** The most private thing an action may carry, in the owner's words. */
const CLASS_LABEL: Record<ActionClass, string> = {
  public: "Only things anyone could see",
  shared_room: "Things that are safe to show in a room",
  near_user: "Things meant for a screen right beside you",
  private: "Things that are private to you",
};
const RANK: Record<ActionClass, number> = { public: 0, shared_room: 1, near_user: 2, private: 3 };

const FAILURE: Record<PermissionFailure, string> = {
  unavailable: "This permission could not be read.",
  changed: "This device’s approval changed.",
  unconfirmed: "Cosmos did not confirm the change. It may still have been saved, so check again before retrying.",
  refused: "Cosmos would not accept this. Nothing changed.",
};

/**
 * What Cosmos said. A definite no is reported as one — nothing was saved and
 * nothing needs re-reading — with the one piece of advice this page cannot
 * work out for itself alongside it, never in place of it.
 */
function Failure({ state, onRefreshDevices, refused }: { state: { failure: PermissionFailure | null; busy: boolean; load(): Promise<void> }; onRefreshDevices(): void; refused?: string }) {
  if (!state.failure) return null;
  return <span className={styles.switchState} role="alert">
    <span>{FAILURE[state.failure]}</span>{" "}
    {state.failure === "refused"
      ? refused ? <span>{refused}</span> : null
      : <button type="button" className={styles.linkButton} disabled={state.busy}
        onClick={() => state.failure === "changed" ? onRefreshDevices() : void state.load()}>
        {state.failure === "changed" ? "Refresh devices" : "Check again"}
      </button>}
  </span>;
}

function ClassField({ id, value, ceiling, personal, disabled, onChange }: {
  id: string; value: ActionClass; ceiling: ActionClass;
  /** False for an installation that can never hold a private-display permission, which is every television. */
  personal: boolean;
  disabled: boolean; onChange(next: ActionClass): void;
}) {
  const allowed = ACTION_CLASSES.filter(name => RANK[name] <= RANK[ceiling]);
  // A ceiling that dropped since this was saved must not render as a blank
  // select: the field shows what Cosmos would actually accept now.
  const shown = RANK[value] <= RANK[ceiling] ? value : ceiling;
  return <div className={styles.editorGroup}>
    <label className={styles.field} htmlFor={id}>The most private thing this may carry
      <select id={id} value={shown} disabled={disabled} onChange={event => onChange(event.target.value as ActionClass)}>
        {allowed.map(name => <option key={name} value={name}>{CLASS_LABEL[name]}</option>)}
      </select>
    </label>
    {ceiling !== "shared_room" ? null
      : personal
        ? <span className={styles.switchPrivacy}>This device may only act on things that are safe to show in a room. A private-display preference cannot verify room privacy.</span>
        : <span className={styles.switchPrivacy}>A television is a screen other people can see, so nothing more private than this ever reaches it.</span>}
  </div>;
}

function List({ label, empty, children }: { label: string; empty: string; children: ReactNode[] }) {
  return <div className={styles.editorGroup}>
    <span className={styles.editorLabel}>{label}</span>
    {children.length ? <ul className={styles.entries}>{children}</ul> : <span className={styles.switchPrivacy}>{empty}</span>}
  </div>;
}

function Row({ title, detail, mono, onRemove, disabled }: { title: string; detail?: string; mono?: boolean; onRemove(): void; disabled: boolean }) {
  return <li className={styles.entry}>
    <span className={styles.entryText}>
      <span className={`${styles.entryTitle}${mono ? ` ${styles.argv}` : ""}`}>{title}</span>
      {detail ? <span className={styles.entryDetail}>{detail}</span> : null}
    </span>
    <button type="button" className={styles.linkButton} disabled={disabled} onClick={onRemove} aria-label={`Remove ${title}`}>Remove</button>
  </li>;
}

/** "a, b or c", so a device is only ever described by what it actually declares. */
const sentence = (parts: string[]) => parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} or ${parts.at(-1)}`;

const EMPTY_OPEN = { hosts: [] as string[], apps: [] as { id: string; label: string }[], roots: [] as { id: string; label: string; path: string }[] };
const sorted = (values: string[]) => Array.from(new Set(values)).sort();

/**
 * "Let this device act". Only the operations this installation's approved
 * manifest declares can be written here: an operation it never declared is not
 * a permission the owner can grant, however this page is used.
 */
export function DeviceActsEditor({ row, state, ceiling, personal, onRefreshDevices }: {
  row: NativeSurface;
  state: PermissionState<DeviceActionApproval | null, DeviceActionPolicy>;
  ceiling: ActionClass;
  /** False for an installation that can never hold a private-display permission. */
  personal: boolean;
  onRefreshDevices(): void;
}) {
  const saved = state.snapshot?.policy ?? null;
  const [draft, setDraft] = useState<DeviceActionPolicy | null>(null);
  const [touched, setTouched] = useState(false);
  const [host, setHost] = useState("");
  const [app, setApp] = useState({ id: "", label: "" });
  const [root, setRoot] = useState({ id: "", label: "", path: "" });
  const [provider, setProvider] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => { if (!touched) setDraft(saved); }, [saved, touched]);
  const opens = row.actions.includes("action.open");
  const routes = row.actions.includes("action.route");
  const plays = row.actions.includes("action.play");
  const reading = state.snapshot === undefined && state.failure === null;
  const busy = state.busy;
  const change = (next: DeviceActionPolicy) => { setTouched(true); setNote(""); setDraft(next); };
  /**
   * What Cosmos would actually be sent: an open block that names nothing is not
   * a permission, so it is dropped rather than making a route-only phone
   * unsavable, and the class never exceeds the ceiling this installation holds.
   */
  const written = (policy: DeviceActionPolicy): DeviceActionPolicy => {
    const next = { ...policy };
    if (next.open && !next.open.hosts.length && !next.open.apps.length && !next.open.roots.length) delete next.open;
    return RANK[next.maximumClass] <= RANK[ceiling] ? next : { ...next, maximumClass: ceiling };
  };

  async function toggle(next: boolean) {
    setNote("");
    if (!next) {
      setTouched(false);
      await state.commit(() => ({ policy: null }), "Cosmos confirmed this device may no longer act.");
      return;
    }
    // An empty policy is not a legal one, so turning it on opens the lists
    // instead of writing a permission that names nothing.
    setTouched(true);
    setDraft({ maximumClass: "shared_room", ...(opens ? { open: { ...EMPTY_OPEN } } : {}) });
    setNote("Add at least one thing this device may act on, then choose Save.");
  }
  async function save() {
    if (!draft || !validActionPolicy(written(draft))) return;
    const outcome = await state.commit(() => ({ policy: written(draft) }), "Cosmos confirmed what this device may do.");
    if (outcome.result === "confirmed") { setTouched(false); setNote(""); }
  }

  const on = draft !== null;
  const dirty = touched && !exact(draft && written(draft), saved);
  const valid = draft !== null && validActionPolicy(written(draft));
  // Only what this installation's manifest declares is described, offered or
  // asked for: a television is never told it could open a website.
  const can = [...(opens ? ["open something you listed"] : []), ...(routes ? ["show the way to a place"] : []),
    ...(plays ? ["play something from a provider you allowed"] : [])];
  const names = [...(opens ? ["website, application or folder"] : []), ...(routes ? ["place"] : []), ...(plays ? ["provider"] : [])];
  return <div className={`${styles.switchRow} ${styles.tallRow}`} role="group" aria-label="Let this device act">
    <div className={styles.switchText}>
      <span className={styles.switchTitle}>Let this device act</span>
      <span className={styles.switchDescription}>
        Cosmos may ask this device to {sentence(can)}. It never invents an address, a place or a title: every one comes
        from something Cosmos already found for you.
      </span>
      <span className={styles.switchPrivacy}>Nothing here lets Cosmos send a message, buy anything or change a setting on this device.</span>
      {reading ? <span className={styles.switchState} role="status">Checking…</span> : null}
      <Failure state={state} onRefreshDevices={onRefreshDevices} />
      {note ? <span className={styles.switchState} role="status">{note}</span> : null}
      {state.message ? <span className={styles.switchState} role="status">{state.message}</span> : null}
      {on && draft ? <div className={styles.editor}>
        <ClassField id={`acts-class-${row.surfaceId}`} value={draft.maximumClass} ceiling={ceiling} personal={personal} disabled={busy}
          onChange={next => change({ ...draft, maximumClass: next })} />
        {opens ? <>
          <List label={`Websites it may open (${draft.open?.hosts.length ?? 0} of ${MAX_HOSTS})`} empty="No websites yet.">
            {(draft.open?.hosts ?? []).map(value => <Row key={value} title={value} disabled={busy}
              onRemove={() => change({ ...draft, open: { ...(draft.open ?? EMPTY_OPEN), hosts: (draft.open?.hosts ?? []).filter(item => item !== value) } })} />)}
          </List>
          <div className={styles.addRow}>
            <label className={styles.field} htmlFor={`host-${row.surfaceId}`}>Website
              <input id={`host-${row.surfaceId}`} value={host} maxLength={253} autoComplete="off" spellCheck={false} placeholder="github.com"
                disabled={busy} onChange={event => setHost(event.target.value.trim().toLowerCase())} />
            </label>
            <button type="button" className={styles.secondary}
              disabled={busy || !declaredHost(host) || (draft.open?.hosts ?? []).includes(host) || (draft.open?.hosts.length ?? 0) >= MAX_HOSTS}
              onClick={() => { change({ ...draft, open: { ...(draft.open ?? EMPTY_OPEN), hosts: sorted([...(draft.open?.hosts ?? []), host]) } }); setHost(""); }}>Add website</button>
          </div>
          <List label={`Applications it may open (${draft.open?.apps.length ?? 0} of ${MAX_APPS})`} empty="No applications yet.">
            {(draft.open?.apps ?? []).map(entry => <Row key={entry.id} title={entry.label} detail={entry.id} disabled={busy}
              onRemove={() => change({ ...draft, open: { ...(draft.open ?? EMPTY_OPEN), apps: (draft.open?.apps ?? []).filter(item => item.id !== entry.id) } })} />)}
          </List>
          <div className={styles.addRow}>
            <label className={styles.field} htmlFor={`app-label-${row.surfaceId}`}>Application name
              <input id={`app-label-${row.surfaceId}`} value={app.label} maxLength={MAX_LABEL_BYTES} autoComplete="off" placeholder="Zed"
                disabled={busy} onChange={event => setApp({ ...app, label: event.target.value })} />
            </label>
            <label className={styles.field} htmlFor={`app-id-${row.surfaceId}`}>Application ID
              <input id={`app-id-${row.surfaceId}`} value={app.id} maxLength={128} autoComplete="off" spellCheck={false} placeholder="dev.zed.Zed"
                disabled={busy} onChange={event => setApp({ ...app, id: event.target.value.trim() })} />
            </label>
            <button type="button" className={styles.secondary}
              disabled={busy || !applicationId(app.id) || !boundedText(app.label, MAX_LABEL_BYTES)
                || (draft.open?.apps ?? []).some(item => item.id === app.id) || (draft.open?.apps.length ?? 0) >= MAX_APPS}
              onClick={() => { change({ ...draft, open: { ...(draft.open ?? EMPTY_OPEN), apps: [...(draft.open?.apps ?? []), { id: app.id, label: app.label }] } }); setApp({ id: "", label: "" }); }}>Add application</button>
          </div>
          <List label={`Folders it may open (${draft.open?.roots.length ?? 0} of ${MAX_ROOTS})`} empty="No folders yet.">
            {(draft.open?.roots ?? []).map(entry => <Row key={entry.id} title={entry.label} detail={`${entry.id} · ${entry.path}`} disabled={busy}
              onRemove={() => change({ ...draft, open: { ...(draft.open ?? EMPTY_OPEN), roots: (draft.open?.roots ?? []).filter(item => item.id !== entry.id) } })} />)}
          </List>
          <div className={styles.addRow}>
            <label className={styles.field} htmlFor={`root-label-${row.surfaceId}`}>Folder name
              <input id={`root-label-${row.surfaceId}`} value={root.label} maxLength={MAX_LABEL_BYTES} autoComplete="off" placeholder="Projects"
                disabled={busy} onChange={event => setRoot({ ...root, label: event.target.value })} />
            </label>
            <label className={styles.field} htmlFor={`root-id-${row.surfaceId}`}>Shared name
              <input id={`root-id-${row.surfaceId}`} value={root.id} maxLength={MAX_ROOT_ID_BYTES} autoComplete="off" spellCheck={false} placeholder="repo"
                disabled={busy} onChange={event => setRoot({ ...root, id: event.target.value.trim().toLowerCase() })} />
            </label>
            <label className={styles.field} htmlFor={`root-path-${row.surfaceId}`}>Path on this device
              <input id={`root-path-${row.surfaceId}`} value={root.path} maxLength={MAX_ROOT_PATH_BYTES} autoComplete="off" spellCheck={false} placeholder="/Users/you/Projects"
                disabled={busy} onChange={event => setRoot({ ...root, path: event.target.value.trim() })} />
            </label>

            <button type="button" className={styles.secondary}
              disabled={busy || !/^[a-z0-9-]+$/.test(root.id) || !boundedText(root.label, MAX_LABEL_BYTES) || !rootPath(root.path)
                || (draft.open?.roots ?? []).some(item => item.id === root.id) || (draft.open?.roots.length ?? 0) >= MAX_ROOTS}
              onClick={() => { change({ ...draft, open: { ...(draft.open ?? EMPTY_OPEN), roots: [...(draft.open?.roots ?? []), { ...root }] } }); setRoot({ id: "", label: "", path: "" }); }}>Add folder</button>
          </div>
          <span className={styles.switchPrivacy}>A folder’s shared name has to match on both devices, or a handoff between them has nowhere to land.</span>
        </> : null}
        {routes ? <label className={styles.checkField}>
          <input type="checkbox" checked={draft.route !== undefined} disabled={busy}
            onChange={event => { const next = { ...draft }; if (event.target.checked) next.route = { app: "google_maps" }; else delete next.route; change(next); }} />
          Let it show the way to a place in Google Maps
        </label> : null}
        {plays ? <>
          <List label={`Media providers it may play (${draft.play?.providers.length ?? 0} of ${MAX_PROVIDERS})`} empty="No providers yet.">
            {(draft.play?.providers ?? []).map(value => <Row key={value} title={value} disabled={busy} onRemove={() => {
              const rest = (draft.play?.providers ?? []).filter(item => item !== value);
              const next = { ...draft }; if (rest.length) next.play = { providers: rest }; else delete next.play; change(next);
            }} />)}
          </List>
          <div className={styles.addRow}>
            <label className={styles.field} htmlFor={`provider-${row.surfaceId}`}>Provider
              <input id={`provider-${row.surfaceId}`} value={provider} maxLength={32} autoComplete="off" spellCheck={false} placeholder="youtube"
                disabled={busy} onChange={event => setProvider(event.target.value.trim().toLowerCase())} />
            </label>
            <button type="button" className={styles.secondary}
              disabled={busy || !providerId(provider) || (draft.play?.providers ?? []).includes(provider) || (draft.play?.providers.length ?? 0) >= MAX_PROVIDERS}
              onClick={() => { change({ ...draft, play: { providers: sorted([...(draft.play?.providers ?? []), provider]) } }); setProvider(""); }}>Add provider</button>
          </div>
          <span className={styles.switchState}>
            Before playback can ever be confirmed, allow Cosmos to read media sessions on the TV itself:
            {" "}<strong>Settings → Device Preferences → Apps → Special app access → Notification access → Cosmos</strong>.
            Cosmos cannot open that screen for you; this firmware publishes no way in. Without it the honest report is
            “Cannot confirm”, because a launched player is not playback.
          </span>
        </> : null}
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} disabled={busy || !valid || !dirty} onClick={() => void save()}>Save what it may do</button>
          {dirty ? <button type="button" className={styles.quiet} disabled={busy} onClick={() => { setTouched(false); setDraft(saved); setNote(""); }}>Discard changes</button> : null}
        </div>
        {!valid ? <span className={styles.switchPrivacy}>Name at least one {sentence(names)} before saving.</span> : null}
      </div> : null}
    </div>
    <Switch checked={on} disabled={busy || reading || (state.failure !== null && state.failure !== "refused")}
      ariaLabel="Let this device act" onChange={next => void toggle(next)} />
  </div>;
}

const EMPTY_ENTRY: CommandEntry = { id: "", label: "", argv: [], cwd: "", mutates: false, budgetMs: 60000 };
/** One argument per line, exactly as it will be spawned. There is no shell here to split a string. */
const argvLines = (argv: string[]) => argv.join("\n");
const parseArgv = (text: string) => text.split("\n").map(line => line.trim()).filter(line => line !== "");

/**
 * "Tasks on this device". macOS only, because it is the one platform that can
 * supply an actor attestation without a new dependency. Every entry confirms
 * before it runs, and `argv` is fixed here by a person.
 */
export function DeviceTasksEditor({ row, state, ceiling, personal, onRefreshDevices }: {
  row: NativeSurface;
  state: PermissionState<DeviceCommandApproval | null, DeviceCommandPolicy>;
  ceiling: ActionClass;
  personal: boolean;
  onRefreshDevices(): void;
}) {
  const saved = state.snapshot?.policy ?? null;
  const [draft, setDraft] = useState<DeviceCommandPolicy | null>(null);
  const [touched, setTouched] = useState(false);
  const [entry, setEntry] = useState<CommandEntry>(EMPTY_ENTRY);
  const [argv, setArgv] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => { if (!touched) setDraft(saved); }, [saved, touched]);
  const reading = state.snapshot === undefined && state.failure === null;
  const busy = state.busy;
  const change = (next: DeviceCommandPolicy) => { setTouched(true); setNote(""); setDraft(next); };

  async function toggle(next: boolean) {
    setNote("");
    if (!next) {
      setTouched(false);
      await state.commit(() => ({ policy: null }), "Cosmos confirmed this device runs no tasks.");
      return;
    }
    setTouched(true);
    setDraft({ maximumClass: "shared_room", offerOutputToCognition: false, entries: [] });
    setNote("Write one task, then choose Save. A task with no command is not a permission.");
  }
  async function save() {
    if (!draft || !validCommandPolicy(draft) || over) return;
    const capped = RANK[draft.maximumClass] <= RANK[ceiling] ? draft : { ...draft, maximumClass: ceiling };
    const outcome = await state.commit(() => ({ policy: capped }), "Cosmos confirmed the tasks this device may run.");
    if (outcome.result === "confirmed") { setTouched(false); setNote(""); }
  }

  const candidate: CommandEntry = { ...entry, argv: parseArgv(argv) };
  const duplicate = (draft?.entries ?? []).some(item => item.id === candidate.id);
  const full = (draft?.entries.length ?? 0) >= MAX_COMMAND_ENTRIES;
  const on = draft !== null;
  const dirty = touched && !exact(draft, saved);
  const weight = draft ? bodyBytes({ approval: DEVICE_COMMANDS_APPROVAL, approvalRevision: row.revision, expectedRevision: state.snapshot?.revision ?? 0, policy: draft }) : 0;
  const over = weight > DEVICE_COMMANDS_BYTES;
  const valid = draft !== null && validCommandPolicy(draft) && !over;
  return <div className={`${styles.switchRow} ${styles.tallRow}`} role="group" aria-label="Tasks on this device">
    <div className={styles.switchText}>
      <span className={styles.switchTitle}>Tasks on this device</span>
      <span className={styles.switchDescription}>
        Commands you write here, and only these. Cosmos can ask this Mac to run one of them; it can never write a command,
        add an argument or reach a shell. Every task asks you to confirm on the Mac before it runs.
      </span>
      <span className={styles.switchPrivacy}>This Mac runs what you list with no sandbox around it. Keep the list to things you would run yourself.</span>
      {reading ? <span className={styles.switchState} role="status">Checking…</span> : null}
      <Failure state={state} onRefreshDevices={onRefreshDevices} refused={SENSITIVE_LABEL_MESSAGE} />
      {note ? <span className={styles.switchState} role="status">{note}</span> : null}
      {state.message ? <span className={styles.switchState} role="status">{state.message}</span> : null}
      {on && draft ? <div className={styles.editor}>
        <ClassField id={`tasks-class-${row.surfaceId}`} value={draft.maximumClass} ceiling={ceiling} personal={personal} disabled={busy}
          onChange={next => change({ ...draft, maximumClass: next })} />
        <List label={`Tasks (${draft.entries.length} of ${MAX_COMMAND_ENTRIES})`} empty="No tasks yet.">
          {draft.entries.map(item => <Row key={item.id} title={item.label} mono
            detail={`${item.argv.join(" ")} · in ${item.cwd} · ${item.mutates ? "changes files" : "changes no files"} · up to ${Math.round(item.budgetMs / 1000)}s`}
            disabled={busy} onRemove={() => change({ ...draft, entries: draft.entries.filter(candidate => candidate.id !== item.id) })} />)}
        </List>
        <div className={styles.editorGroup}>
          <span className={styles.editorLabel}>Add a task</span>
          <label className={styles.field} htmlFor={`task-label-${row.surfaceId}`}>What you call it
            <input id={`task-label-${row.surfaceId}`} value={entry.label} maxLength={MAX_LABEL_BYTES} autoComplete="off" placeholder="Project tests"
              disabled={busy || full} onChange={event => setEntry({ ...entry, label: event.target.value })} />
          </label>
          <label className={styles.field} htmlFor={`task-id-${row.surfaceId}`}>Short name
            <input id={`task-id-${row.surfaceId}`} value={entry.id} maxLength={MAX_ENTRY_ID_BYTES} autoComplete="off" spellCheck={false} placeholder="project-tests"
              disabled={busy || full} onChange={event => setEntry({ ...entry, id: event.target.value.trim().toLowerCase() })} />
          </label>
          <label className={styles.field} htmlFor={`task-argv-${row.surfaceId}`}>The command, one part per line
            <textarea id={`task-argv-${row.surfaceId}`} className={styles.descriptor} value={argv} rows={4} spellCheck={false} autoComplete="off"
              placeholder={"./revival\ncheck\ncosmos"} disabled={busy || full} onChange={event => setArgv(event.target.value)} />
          </label>
          <span className={styles.switchPrivacy}>One part per line, at most {MAX_ARGV} parts of {MAX_ARGV_BYTES} bytes. There is no shell, so quoting and spaces are never split for you.</span>
          <label className={styles.field} htmlFor={`task-cwd-${row.surfaceId}`}>Folder it runs in
            <input id={`task-cwd-${row.surfaceId}`} value={entry.cwd} maxLength={MAX_ROOT_PATH_BYTES} autoComplete="off" spellCheck={false} placeholder="/Users/you/Projects/app"
              disabled={busy || full} onChange={event => setEntry({ ...entry, cwd: event.target.value.trim() })} />
          </label>
          <label className={styles.checkField}>
            <input type="checkbox" checked={entry.mutates} disabled={busy || full} onChange={event => setEntry({ ...entry, mutates: event.target.checked })} />
            This task changes files
          </label>
          <label className={styles.field} htmlFor={`task-budget-${row.surfaceId}`}>Give up after
            <input id={`task-budget-${row.surfaceId}`} type="number" min={1} max={MAX_BUDGET_MS / 1000} value={Math.round(entry.budgetMs / 1000)}
              disabled={busy || full} onChange={event => setEntry({ ...entry, budgetMs: Math.min(Math.max(Number(event.target.value) || 0, 0), MAX_BUDGET_MS / 1000) * 1000 })} />
          </label>
          <span className={styles.switchPrivacy}>Seconds, at most {MAX_BUDGET_MS / 1000}.</span>
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} disabled={busy || full || duplicate || !validCommandEntry(candidate)}
              onClick={() => { change({ ...draft, entries: [...draft.entries, candidate] }); setEntry(EMPTY_ENTRY); setArgv(""); }}>Add task</button>
          </div>
          {full ? <span className={styles.switchState}>Eight tasks is the most this device can hold. Remove one to add another.</span> : null}
          {duplicate ? <span className={styles.switchState}>A task with that short name is already here.</span> : null}
          {!full && argv.trim() && parseArgv(argv).some(part => !validArgument(part))
            ? <span className={styles.switchState}>Each part must be at most {MAX_ARGV_BYTES} bytes and carry no control characters.</span> : null}
        </div>
        <label className={styles.checkField}>
          <input type="checkbox" checked={draft.offerOutputToCognition} disabled={busy}
            onChange={event => change({ ...draft, offerOutputToCognition: event.target.checked })} />
          Let a later question read what a task printed
        </label>
        <span className={styles.budget} role="status">{weight} of {DEVICE_COMMANDS_BYTES} bytes used.</span>
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} disabled={busy || !valid || !dirty} onClick={() => void save()}>Save these tasks</button>
          {dirty ? <button type="button" className={styles.quiet} disabled={busy} onClick={() => { setTouched(false); setDraft(saved); setNote(""); }}>Discard changes</button> : null}
        </div>
        {over ? <span className={styles.switchState} role="alert">This list is too long to send. Shorten a command or remove a task.</span> : null}
      </div> : null}
    </div>
    <Switch checked={on} disabled={busy || reading || (state.failure !== null && state.failure !== "refused")}
      ariaLabel="Tasks on this device" onChange={next => void toggle(next)} />
  </div>;
}
