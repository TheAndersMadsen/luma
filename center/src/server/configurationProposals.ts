/*
 * The env-plane writer: pending configuration changes, waiting for a deploy.
 *
 * Split from `configuration.ts` for the same reason `channelStore.ts` is split
 * from `channel.ts` — and for one more. `configuration.ts` is the READ surface,
 * and `verify/configuration-inventory.test.mjs` holds it to having no writer at
 * all: it fails if that module so much as names `writeFile`, `rename` or
 * `unlink`. That is a property worth keeping literally true rather than
 * approximately true, so the bytes that go to disk are written from here.
 *
 * WHAT THIS IS NOT. It is not a queue, and it does not touch anything under
 * `private/`. §2 of `configuration.ts` is the argument: the four protected env
 * files are fingerprinted into every deployment record, and `rollback.sh`
 * recomputes those fingerprints before it will roll anything back. A dashboard
 * that wrote `private/center.env` at 03:00 would disarm recovery for the live
 * system, silently, and the operator would find out at 04:00.
 *
 * So this store is a DESIRED-STATE document in Center's own `/data` volume,
 * which is deliberately absent from `config-digests.tsv`. It says "these
 * settings should have these values". `apply_configuration_proposals`, running
 * inside the deploy while it stages the private configuration, is the only
 * thing that acts on it — so the new values and the new digests are recorded by
 * the same `record_configuration_evidence` call, in the same deployment record,
 * as the release they ship with.
 *
 * Desired state rather than a queue is what lets the deploy read this file and
 * never write it. Applying an entry twice is applying it once, so nothing has
 * to be marked consumed, so no writer for Center's data volume has to exist
 * inside the deploy transaction. §8b.
 *
 * THREE PROPERTIES, each with a failure behind it — two of them this project's
 * own, from `channelStore.ts`:
 *
 *   ABSENT IS NOT UNREADABLE   An unreadable store returning `{}` would render
 *                              as "no pending changes" on a dashboard whose
 *                              whole job is telling an operator what is true,
 *                              and the next save would overwrite entries nobody
 *                              knew were there.
 *   A WRITE CAN BE HALF DONE   `writeFileSync` truncates before it writes, so
 *                              an interrupted save leaves a zero-length file
 *                              where the pending changes were. Write a sibling
 *                              and rename.
 *   THE CATALOG IS THE GATE    Nothing reaches this file that
 *                              `validateProposedValue` did not accept, and that
 *                              function refuses on the NAME first — so a name
 *                              that is `never`, unknown, or a Compose literal
 *                              cannot be stored even by a caller that forgot to
 *                              check.
 */

import fs from "node:fs";
import path from "node:path";
import {
  configurationCatalog,
  proposalTarget,
  validateProposedValue,
  type ConfigurationHome,
} from "./configuration";
import { logInfo, logWarn } from "./log";

/** One pending change, and the audit record for it. */
export interface ConfigurationProposal {
  name: string;
  /** Exactly the bytes the next deploy will write. Already validated. */
  value: string;
  /**
   * The env file Center believed this belonged in when it was saved.
   *
   * DESCRIPTIVE, not authoritative: `apply_configuration_proposals` derives the
   * target from its own allowlist and ignores this. It is here so a human
   * reading the file over SSH — the most likely reader when something has gone
   * wrong — can see where a change was meant to land without cross-referencing
   * the catalog.
   */
  target: ConfigurationHome;
  /** ISO 8601, UTC. Who and when is the whole audit record (§6). */
  proposedAt: string;
  /** The operator's Keycloak subject. Stable across a changed address. */
  proposedBy: string;
  /** What a human reads. Null when the session carried no address. */
  proposedByEmail: string | null;
}

/** Whether the running system already carries a proposed value. */
export type ProposalDelivery =
  /** This process's own environment already holds exactly this value. */
  | "applied"
  /** It does not, so the next deploy is what applies this. */
  | "pending"
  /** The value belongs to another container; Center cannot see it from here. */
  | "unconfirmable"
  /**
   * The catalog no longer allows this name. The next deploy will REFUSE the
   * whole file rather than guess, so this has to be removed before deploying.
   */
  | "refused";

export interface ConfigurationProposalState extends ConfigurationProposal {
  delivery: ProposalDelivery;
}

/**
 * There are pending changes on disk and this process cannot read them.
 *
 * Raised rather than returned as an empty store, because those two answers lead
 * to opposite actions: an empty store invites a save that would overwrite
 * whatever is really there, and this one tells the operator to go and look.
 */
export class ConfigurationProposalsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationProposalsUnavailableError";
  }
}

/**
 * Where the pending changes live between processes.
 *
 * `/data` is Center's persistent volume, and the deploy reads this exact name
 * from the host side of that same bind mount. Read per call rather than
 * captured at import, matching `channelKeyFile()`: a deployment sets it before
 * the process starts, and a test can point one case at a scratch file without
 * loading a second copy of the module.
 *
 * The override exists for tests and is catalogued as never-editable, because
 * re-pointing it is the one change that would leave proposals saved, visible,
 * and permanently unapplied — the deploy would keep reading the old name.
 */
export function proposalStoreFile(): string {
  return process.env.REVIVAL_CENTER_CONFIG_PROPOSALS_FILE ?? "/data/configuration-proposals.json";
}

interface StoreDocument {
  /** Bumped only for a shape the deploy-side applier would read differently. */
  schemaVersion: number;
  settings: Record<string, Omit<ConfigurationProposal, "name">>;
}

const SCHEMA_VERSION = 1;

function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "unknown error";
}

function unavailable(detail: string): never {
  throw new ConfigurationProposalsUnavailableError(
    `the configuration proposal store ${proposalStoreFile()} ${detail}`,
  );
}

/**
 * The store as it is on disk.
 *
 * ENOENT is the normal state of a deployment nobody has proposed anything on.
 * Nothing else is: a permission error on /data (the container runs as
 * 1000:1001) or a truncated file must not be reported as "no pending changes",
 * because the next save would then write a document with one entry over a
 * document that had five.
 */
function readDocument(): StoreDocument {
  const file = proposalStoreFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return { schemaVersion: SCHEMA_VERSION, settings: {} };
    unavailable(`could not be read (${errnoOf(error)}), so this deployment cannot tell what is already pending`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    unavailable(
      `is not valid JSON (${error instanceof Error ? error.message : "parse failed"}); it must be repaired or removed on the VPS before the next deploy, which will refuse it`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    unavailable("does not hold a JSON object");
  }
  const document = parsed as Partial<StoreDocument>;
  if (document.schemaVersion !== SCHEMA_VERSION) {
    unavailable(
      `declares schema version ${String(document.schemaVersion)}, and this build only understands ${SCHEMA_VERSION}`,
    );
  }
  const settings = document.settings;
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    unavailable("has no settings object");
  }
  return { schemaVersion: SCHEMA_VERSION, settings: settings as StoreDocument["settings"] };
}

/**
 * Replace the store atomically.
 *
 * A sibling carrying this process's pid, then a rename: rename within a
 * directory is atomic, so a reader sees either the whole old document or the
 * whole new one, and a crash between the two cannot leave a truncated file
 * where the pending changes were. `fsync` before the rename because the rename
 * orders the directory entry, not the contents — a host that loses power just
 * after it would otherwise come back with the new name over an empty file.
 */
function writeDocument(document: StoreDocument): void {
  const file = proposalStoreFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  // A leftover from a crashed predecessor with this pid would keep ITS mode, so
  // remove it and create fresh: 0600 is only applied to a file this call makes.
  fs.rmSync(temporary, { force: true });
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Is an entry on disk still a thing this build would accept?
 *
 * Read back through the same validator that let it in, so a catalog change that
 * demotes a setting — or a value hand-edited into the file on the VPS — is
 * caught here and shown, rather than discovered by the deploy that refuses the
 * whole file because of it.
 */
function deliveryOf(proposal: ConfigurationProposal): ProposalDelivery {
  const setting = configurationCatalog().find((entry) => entry.name === proposal.name);
  if (!setting || !proposalTarget(setting)) return "refused";
  if (!validateProposedValue(proposal.name, proposal.value).ok) return "refused";
  // Only ever asked about a proposable setting, which §4 defines as operational
  // — so this comparison is between a value the operator typed and an
  // environment entry, and its one bit of output cannot disclose anything the
  // caller did not already supply. It is never asked about a secret.
  if (!setting.observable) return "unconfirmable";
  return (process.env[proposal.name] ?? "").trim() === proposal.value ? "applied" : "pending";
}

function toProposal(name: string, stored: unknown): ConfigurationProposal | null {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return null;
  const entry = stored as Partial<ConfigurationProposal>;
  if (typeof entry.value !== "string" || typeof entry.proposedAt !== "string") return null;
  return {
    name,
    value: entry.value,
    target: (entry.target ?? "runtime.env") as ConfigurationHome,
    proposedAt: entry.proposedAt,
    proposedBy: typeof entry.proposedBy === "string" ? entry.proposedBy : "unknown",
    proposedByEmail: typeof entry.proposedByEmail === "string" ? entry.proposedByEmail : null,
  };
}

/** Every pending change, oldest first, each with whether it has landed yet. */
export function pendingProposals(): ConfigurationProposalState[] {
  const document = readDocument();
  const proposals: ConfigurationProposalState[] = [];
  for (const [name, stored] of Object.entries(document.settings)) {
    const proposal = toProposal(name, stored);
    if (!proposal) {
      // A malformed entry is not dropped quietly: the deploy will refuse the
      // file over it, and an operator who cannot see it cannot remove it.
      logWarn(`configuration proposals: the entry for ${name} is malformed and the next deploy will refuse this file`);
      proposals.push({
        name,
        value: "",
        target: "runtime.env",
        proposedAt: "",
        proposedBy: "unknown",
        proposedByEmail: null,
        delivery: "refused",
      });
      continue;
    }
    proposals.push({ ...proposal, delivery: deliveryOf(proposal) });
  }
  return proposals.sort((a, b) => a.proposedAt.localeCompare(b.proposedAt) || a.name.localeCompare(b.name));
}

/** Who is asking, for the audit record the file itself becomes. */
export interface ProposalAuthor {
  sub: string;
  email: string | null;
}

export type ProposalWriteOutcome =
  | { ok: true; proposal: ConfigurationProposalState }
  | { ok: false; reason: string };

/**
 * Record a desired value for one setting.
 *
 * The name and the value are both re-validated here even though the route
 * handler validated them, because this is the function that writes and the
 * check that matters is the one nearest the write. Nothing else in this module
 * can add an entry.
 */
export function proposeValue(
  name: string,
  raw: unknown,
  author: ProposalAuthor,
): ProposalWriteOutcome {
  const outcome = validateProposedValue(name, raw);
  if (!outcome.ok) return outcome;

  const setting = configurationCatalog().find((entry) => entry.name === name);
  const target = setting ? proposalTarget(setting) : null;
  if (!setting || !target) {
    // `validateProposedValue` already refuses both of these; restated because
    // the alternative is a non-null assertion on the line that writes to disk.
    return { ok: false, reason: `${name} cannot be changed from the dashboard.` };
  }

  // Re-read immediately before writing so two operators saving concurrently do
  // not erase each other: the map is merged, never replaced.
  const document = readDocument();
  const proposal: ConfigurationProposal = {
    name,
    value: outcome.value,
    target,
    proposedAt: new Date().toISOString(),
    proposedBy: author.sub,
    proposedByEmail: author.email,
  };
  const { name: _name, ...stored } = proposal;
  writeDocument({
    schemaVersion: SCHEMA_VERSION,
    settings: { ...document.settings, [name]: stored },
  });
  // The NAME and the operator, never the value. The file is the record that
  // carries the value; `server/log.ts` is a shared stream (§6).
  logInfo(`configuration proposal saved by ${author.sub}: ${name} -> ${target}, applies on the next deploy`);
  return { ok: true, proposal: { ...proposal, delivery: deliveryOf(proposal) } };
}

/**
 * Stop proposing a value for one setting.
 *
 * This does NOT restore the previous value. The deploy applies desired state by
 * assignment, so whatever was last written into the env file stays there until
 * something else changes it; removing an entry only stops Center re-asserting
 * it on every future deploy. The console says exactly that next to the control,
 * because "remove" reading as "undo" is how an operator concludes a rollback
 * happened that did not.
 */
export function withdrawProposal(name: string, author: ProposalAuthor): boolean {
  const document = readDocument();
  if (!(name in document.settings)) return false;
  const settings = { ...document.settings };
  delete settings[name];
  writeDocument({ schemaVersion: SCHEMA_VERSION, settings });
  logInfo(`configuration proposal withdrawn by ${author.sub}: ${name}`);
  return true;
}
