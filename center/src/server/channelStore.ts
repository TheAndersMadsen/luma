/*
 * The wearer's channel keys, on disk.
 *
 * Split out of channel.ts so this half can be exercised for what it is: the
 * durable home of irreplaceable wearer key material. channel.ts is the Humane
 * key LIFECYCLE (EstablishWrappingKeys, ImportKeys, the per-principal cache) and
 * cannot be imported without a gRPC stack and a request scope; this module needs
 * a filesystem and nothing else, so `verify/channel-key-store.test.mjs` can
 * write real files and assert what really happens to them.
 *
 * Three properties matter here, and each one has a failure this project has
 * actually seen behind it:
 *
 *   ABSENT IS NOT UNREADABLE   `readStore` returning `{}` for an unreadable file
 *                              makes the caller mint a brand-new key and
 *                              overwrite the server's copy, which turns every
 *                              note and frame sealed so far into "sealed" with
 *                              /api/health still green.
 *   A KID IS NOT AN IDENTITY   the kid is DERIVED from whatever identity a
 *                              request carries, and that derivation has already
 *                              changed shape once. Matching stored keys by exact
 *                              kid abandoned a live wearer's key.
 *   A WRITE CAN BE HALF DONE   `writeFileSync` truncates before it writes, so an
 *                              interrupted write leaves nothing where the only
 *                              copy of a key used to be.
 *   INVALID IS NOT LEGACY      a parsed-but-malformed document must not be
 *                              partially accepted and then rewritten into a
 *                              shape that silently discards an irreplaceable key.
 *
 * This is wearer key material: it is never logged (kids are; keys are not), the
 * file is 0600, and both `.gitignore` and `.dockerignore` cover the name plus
 * the transient sibling this module renames over it.
 */

import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { logWarn } from "./log";

/** One channel key, under the kid it is stored beneath. */
export interface ChannelKey {
  kid: string;
  key: Buffer;
}

/**
 * There is no key to seal or open under, and no retry inside this request can
 * produce one.
 *
 * Raised rather than returned as a null so a caller cannot forget to explain
 * it. The old null was reported as `unconfigured`/`absent` — the word that means
 * "no backend is deployed here" — which /api/health and SourceBadge both read as
 * healthy, so every note write failed silently for the life of the deployment.
 * Cosmos IS configured when this is raised; something else is missing, and the
 * message names it.
 */
export class ChannelKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelKeyUnavailableError";
  }
}

/**
 * Where the keys live between processes.
 *
 * They have to persist: the seeder and the dashboard both seal and open the same
 * wearer's content, and `ImportKeys` overwrites whatever is stored under a kid.
 * Two processes each generating their own would mean the second silently made
 * everything the first sealed unreadable.
 *
 * ONE file, holding a map from kid to key — not one file per wearer. The path is
 * the only one the deployment declares (`COSMOS_CHANNEL_KEY_FILE`, with the
 * legacy `COSMOS_CHANNEL_KEY_FILE` accepted as an exact alias), and the only one
 * the restore/backup contract knows. Both local default names and their
 * transient siblings are covered by `.gitignore` and `.dockerignore`.
 * (`writeStore` uses `<file>.<pid>.tmp` so replacement can be atomic.)
 *
 * Read per call rather than captured at import: a deployment sets it before the
 * process starts, so nothing changes there, and a test can point one case at a
 * scratch file without loading a second copy of the module.
 */
export function channelKeyFile(): string {
  const cosmos = nonBlankEnvironmentPath(process.env.COSMOS_CHANNEL_KEY_FILE);
  const legacyAlias = nonBlankEnvironmentPath(process.env.COSMOS_CHANNEL_KEY_FILE);
  if (cosmos && legacyAlias && cosmos !== legacyAlias) {
    throw new ChannelKeyUnavailableError(
      "COSMOS_CHANNEL_KEY_FILE and COSMOS_CHANNEL_KEY_FILE disagree; refusing to choose a channel-key store.",
    );
  }
  if (cosmos) return cosmos;
  if (legacyAlias) return legacyAlias;

  const cosmosDefault = path.join(process.cwd(), ".cosmos-channel-key.json");
  const legacyDefault = path.join(process.cwd(), ".cosmos-channel-key.json");
  // Reuse legacy key material in place; default selection must never rename or
  // rewrite the only copy.
  if (pathEntryExists(cosmosDefault)) return cosmosDefault;
  return pathEntryExists(legacyDefault) ? legacyDefault : cosmosDefault;
}

function pathEntryExists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return false;
    throw invalidStore(file, `path lookup failed with ${errnoOf(error)}`);
  }
}

function nonBlankEnvironmentPath(value: string | undefined): string | null {
  return value !== undefined && value.trim().length > 0 ? value : null;
}

interface KeyStore {
  /** The first key this deployment established — the restore-compatible shape. */
  kid: string;
  key: string;
  /** Every established key, by kid. Authoritative; the pair above is a mirror. */
  keys?: Record<string, string>;
}

const MAX_STORE_BYTES = 16_384;
const MAX_KID_BYTES = 1_024;
// A 16 KiB document cannot safely hold thousands of entries. Keep the logical
// cardinality below the byte ceiling so an operator sees one honest bound rather
// than a nominal 4,096-entry promise that the serializer can never satisfy.
const MAX_MAPPED_KEYS = 256;
const CENTER_KID_SUFFIX = "/center/ephemeral";
const PRINCIPAL_MAX_BYTES = 128;
const IDENTITY_COMPONENT = /^[A-Za-z0-9._-]+$/u;

/** Stable wearer-facing text. Filesystem paths and errno stay in server logs. */
export const CHANNEL_KEY_STORE_DEGRADED =
  "Channel key storage is unavailable; retry or contact the operator.";
export const CHANNEL_KEY_IDENTITY_INVALID =
  "The current wearer identity is invalid; sign in again or fix COSMOS_PRINCIPAL.";

/** Node's errno for a filesystem failure, when the thrown value carries one. */
function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "unknown error";
}

/**
 * The store as it is on disk.
 *
 * ENOENT is the normal first-run state. NOTHING ELSE IS, and the difference is
 * the wearer's content: this used to catch everything and return `{}`, which
 * made an unreadable file indistinguishable from an absent one. With `{}` in
 * hand the lifecycle generates a fresh AES key and `ImportKeys` overwrites the
 * server's copy for that kid, so everything sealed before that moment becomes
 * unopenable — rendered as `sealed: true` — while /api/health stays green. An
 * EACCES on /data (the container runs as 1000:1001) would therefore have minted
 * a new identity on every restart and destroyed a generation of sealed content
 * each time, silently. Raise the typed error instead: a degraded surface the
 * wearer can be told about is recoverable, and a second key is not.
 */
function invalidStore(file: string, detail: string): ChannelKeyUnavailableError {
  logWarn(
    `channel: refusing unsafe channel-key store ${file}: ${detail}`,
  );
  return new ChannelKeyUnavailableError(CHANNEL_KEY_STORE_DEGRADED);
}

function assertNoDuplicateJsonKeys(raw: string): void {
  let cursor = 0;
  const whitespace = /\s/u;
  const skipWhitespace = () => {
    while (cursor < raw.length && whitespace.test(raw[cursor])) cursor += 1;
  };
  const parseString = (): string => {
    const start = cursor;
    if (raw[cursor] !== '"') throw new Error("expected a JSON string");
    cursor += 1;
    while (cursor < raw.length) {
      const char = raw[cursor];
      cursor += 1;
      if (char === '"') return JSON.parse(raw.slice(start, cursor)) as string;
      if (char === "\\") cursor += 1;
    }
    throw new Error("unterminated JSON string");
  };
  const parseValue = (): void => {
    skipWhitespace();
    if (raw[cursor] === "{") {
      cursor += 1;
      skipWhitespace();
      const names = new Set<string>();
      if (raw[cursor] === "}") {
        cursor += 1;
        return;
      }
      for (;;) {
        skipWhitespace();
        const name = parseString();
        if (names.has(name)) throw new Error("duplicate object field");
        names.add(name);
        skipWhitespace();
        if (raw[cursor] !== ":") throw new Error("missing object separator");
        cursor += 1;
        parseValue();
        skipWhitespace();
        if (raw[cursor] === "}") {
          cursor += 1;
          return;
        }
        if (raw[cursor] !== ",") throw new Error("missing object delimiter");
        cursor += 1;
      }
    }
    if (raw[cursor] === "[") {
      cursor += 1;
      skipWhitespace();
      if (raw[cursor] === "]") {
        cursor += 1;
        return;
      }
      for (;;) {
        parseValue();
        skipWhitespace();
        if (raw[cursor] === "]") {
          cursor += 1;
          return;
        }
        if (raw[cursor] !== ",") throw new Error("missing array delimiter");
        cursor += 1;
      }
    }
    if (raw[cursor] === '"') {
      parseString();
      return;
    }
    while (cursor < raw.length && !/[\s,}\]]/u.test(raw[cursor])) cursor += 1;
  };
  parseValue();
  skipWhitespace();
  if (cursor !== raw.length) throw new Error("trailing JSON content");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateTextKid(value: unknown, label: string, file: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidStore(file, `${label} kid is empty or not text`);
  }
  const encoded = Buffer.from(value, "utf8");
  if (
    encoded.length > MAX_KID_BYTES
    || encoded.toString("utf8") !== value
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw invalidStore(file, `${label} kid is not bounded control-free UTF-8`);
  }
}

export interface CenterPrincipal {
  principal: string;
  subject: string;
}

/**
 * Parse the complete Center principal grammar.
 *
 * The current form is `U:<subject>`. The only legacy form is
 * `V:<two hex digits>:D:<device>:U:<subject>`. Components are deliberately
 * ASCII and delimiter-free: accepting a suffix or lossy UTF-8 form here would
 * make persistence and a later restart disagree about who owns a key.
 */
export function parseCenterPrincipal(value: string): CenterPrincipal | null {
  if (
    value.length === 0
    || Buffer.byteLength(value, "utf8") > PRINCIPAL_MAX_BYTES
    || Buffer.from(value, "utf8").toString("utf8") !== value
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    return null;
  }

  if (value.startsWith("U:")) {
    const subject = value.slice(2);
    return IDENTITY_COMPONENT.test(subject) ? { principal: value, subject } : null;
  }

  const fields = value.split(":");
  if (
    fields.length !== 6
    || fields[0] !== "V"
    || !/^[0-9A-Fa-f]{2}$/u.test(fields[1])
    || fields[2] !== "D"
    || !IDENTITY_COMPONENT.test(fields[3])
    || fields[4] !== "U"
    || !IDENTITY_COMPONENT.test(fields[5])
  ) {
    return null;
  }
  return { principal: value, subject: fields[5] };
}

export interface CenterKid extends CenterPrincipal {
  kid: string;
}

/** Parse one complete persisted/imported Center kid, never a suffix match. */
export function parseCenterKid(value: string): CenterKid | null {
  if (
    !value.endsWith(CENTER_KID_SUFFIX)
    || Buffer.byteLength(value, "utf8") > MAX_KID_BYTES
  ) {
    return null;
  }
  const parsed = parseCenterPrincipal(value.slice(0, -CENTER_KID_SUFFIX.length));
  return parsed === null ? null : { ...parsed, kid: value };
}

/** Derive only from a principal the same parser will accept after restart. */
export function centerKidForPrincipal(principal: string): string | null {
  const parsed = parseCenterPrincipal(principal);
  return parsed === null ? null : `${parsed.principal}${CENTER_KID_SUFFIX}`;
}

function validateKid(value: unknown, label: string, file: string): asserts value is string {
  validateTextKid(value, label, file);
  if (parseCenterKid(value) === null) {
    throw invalidStore(file, `${label} kid is not a supported complete Center kid`);
  }
}

function validateEncodedKey(value: unknown, label: string, file: string): asserts value is string {
  if (typeof value !== "string") throw invalidStore(file, `${label} key is not base64 text`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 16 || decoded.toString("base64") !== value) {
    throw invalidStore(file, `${label} key is not canonical base64 for exactly 16 bytes`);
  }
}

function validateStore(value: unknown, file: string): KeyStore {
  if (!isPlainObject(value)) throw invalidStore(file, "top level is not a plain object");
  const fields = Object.keys(value).sort();
  const expected = value.keys === undefined ? ["key", "kid"] : ["key", "keys", "kid"];
  if (fields.length !== expected.length || fields.some((field, index) => field !== expected[index])) {
    throw invalidStore(file, "fields must be exactly kid, key, and optional keys");
  }
  validateKid(value.kid, "top-level", file);
  validateEncodedKey(value.key, "top-level", file);
  if (value.keys !== undefined) {
    if (!isPlainObject(value.keys)) throw invalidStore(file, "keys is not a plain object");
    const entries = Object.entries(value.keys);
    if (entries.length > MAX_MAPPED_KEYS) throw invalidStore(file, "keys has too many entries");
    for (const [kid, key] of entries) {
      validateKid(kid, "mapped", file);
      validateEncodedKey(key, "mapped", file);
    }
  }
  return value as unknown as KeyStore;
}

interface StoreObservation {
  raw: string;
  device: number;
  inode: number;
  size: number;
  mode: number;
  modified: number;
  changed: number;
}

function exactStoreMode(metadata: fs.Stats): number {
  return metadata.mode & 0o777;
}

function assertStoreMetadata(metadata: fs.Stats, file: string): void {
  if (!metadata.isFile()) {
    throw invalidStore(file, "path is not a regular file");
  }
  if (exactStoreMode(metadata) !== 0o600) {
    throw invalidStore(file, "file mode must be exactly 0600");
  }
  if (metadata.size < 1 || metadata.size > MAX_STORE_BYTES) {
    throw invalidStore(file, "file size is outside the 1..16384 byte contract");
  }
}

function sameObservation(left: StoreObservation, right: fs.Stats): boolean {
  return (
    left.device === right.dev
    && left.inode === right.ino
    && left.size === right.size
    && left.mode === exactStoreMode(right)
    && left.modified === right.mtimeMs
    && left.changed === right.ctimeMs
  );
}

/**
 * Open and read the store through one no-follow descriptor.
 *
 * ENOENT means first-run only when the initial open observes it. Once a file
 * descriptor has been obtained, every later ENOENT/change is an unsafe
 * post-observation race and therefore fails closed instead of becoming
 * "absent". The bounded read prevents a file that grows after fstat from
 * allocating or parsing beyond the contract.
 */
function observeStore(): StoreObservation | null {
  const file = channelKeyFile();
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw invalidStore(file, "this platform does not expose O_NOFOLLOW");
  }
  const noFollow = fs.constants.O_NOFOLLOW;
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return null;
    throw invalidStore(file, `open failed with ${errnoOf(error)}`);
  }
  try {
    const before = fs.fstatSync(descriptor);
    assertStoreMetadata(before, file);

    const bytes = Buffer.alloc(MAX_STORE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length < 1 || length > MAX_STORE_BYTES) {
      throw invalidStore(file, "bounded descriptor read exceeded the 1..16384 byte contract");
    }

    const observation: StoreObservation = {
      raw: "",
      device: before.dev,
      inode: before.ino,
      size: before.size,
      mode: exactStoreMode(before),
      modified: before.mtimeMs,
      changed: before.ctimeMs,
    };
    const after = fs.fstatSync(descriptor);
    if (!sameObservation(observation, after) || length !== after.size) {
      throw invalidStore(file, "file changed while it was being read");
    }

    let current: fs.Stats;
    try {
      current = fs.lstatSync(file);
    } catch (error) {
      throw invalidStore(file, `path changed after it was opened (${errnoOf(error)})`);
    }
    if (current.isSymbolicLink() || !sameObservation(observation, current)) {
      throw invalidStore(file, "path changed after it was opened");
    }

    try {
      observation.raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    } catch {
      throw invalidStore(file, "file is not valid UTF-8");
    }
    return observation;
  } catch (error) {
    if (error instanceof ChannelKeyUnavailableError) throw error;
    throw invalidStore(file, `descriptor read failed with ${errnoOf(error)}`);
  } finally {
    fs.closeSync(descriptor);
  }
}

function confirmObservedDurability(observation: StoreObservation): void {
  const file = channelKeyFile();
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(path.dirname(file), "r");
    fs.fsyncSync(descriptor);
    const current = fs.lstatSync(file);
    if (current.isSymbolicLink() || !sameObservation(observation, current)) {
      throw invalidStore(file, "path changed while its directory durability was confirmed");
    }
  } catch (error) {
    if (error instanceof ChannelKeyUnavailableError) throw error;
    throw invalidStore(file, `parent-directory durability confirmation failed with ${errnoOf(error)}`);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function readStore(): KeyStore | null {
  const file = channelKeyFile();
  const observation = observeStore();
  if (observation === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(observation.raw);
    assertNoDuplicateJsonKeys(observation.raw);
  } catch (error) {
    // Corrupt is unreadable, not absent, for exactly the same reason.
    throw invalidStore(
      file,
      `JSON validation failed: ${error instanceof Error ? error.message : "parse failed"}`,
    );
  }
  const store = validateStore(parsed, file);
  confirmObservedDurability(observation);
  return store;
}

/**
 * Do two kids name the same wearer?
 *
 * The kid is derived from whatever identity a request carries, and that identity
 * has already changed shape once. The file this deployment wrote holds
 *
 *   V:01:D:web-demo:U:<sub>/center/ephemeral      (the COSMOS_PRINCIPAL shape)
 *
 * while the session path now derives
 *
 *   U:<sub>/center/ephemeral                      (the same person)
 *
 * Matching on equality alone therefore declared the wearer's own established key
 * to be somebody else's, generated a second one, and left everything sealed
 * under the first unopenable — a fact that surfaces as "frame unavailable", i.e.
 * a claim about the capture rather than about the key.
 *
 * The two accepted forms are parsed as complete grammars and compared by their
 * exact subject component. No suffix, substring, path, or extra delimiter is
 * accepted: `U:ab` cannot match `U:cab`, and a syntactically invalid legacy
 * principal never becomes an alias for a valid current one.
 */
function centerKidSubject(kid: string): string | null {
  return parseCenterKid(kid)?.subject ?? null;
}

export function namesSameWearer(a: string, b: string): boolean {
  const left = centerKidSubject(a);
  const right = centerKidSubject(b);
  return left !== null && right !== null && left === right;
}

/**
 * Every key in the store that belongs to this wearer, each under its OWN kid,
 * the exactly-matching one first.
 *
 * This is where wearers are kept apart: an entry whose kid does not name the
 * wearer that `derived` names is never returned, so it can never open or seal
 * their content. The legacy top-level pair is read as one more entry rather than
 * as a special case, because that is what it is — the first key this deployment
 * established, written before the map existed.
 *
 * Throws `ChannelKeyUnavailableError` when the store exists and cannot be read.
 */
export function storedKeysFor(derived: string): ChannelKey[] {
  const store = readStore();
  if (store === null) return [];
  const entries: Array<[unknown, unknown]> = Object.entries(store.keys ?? {});
  if (typeof store.kid === "string" && typeof store.key === "string") {
    entries.push([store.kid, store.key]);
  }

  const found: ChannelKey[] = [];
  const seen = new Set<string>();
  for (const [storedKid, encoded] of entries) {
    if (typeof storedKid !== "string" || typeof encoded !== "string") continue;
    if (seen.has(storedKid) || encoded.length === 0) continue;
    if (!namesSameWearer(storedKid, derived)) continue;
    const key = Buffer.from(encoded, "base64");
    if (key.length === 0) continue;
    seen.add(storedKid);
    found.push({ kid: storedKid, key });
  }
  // The kid we would derive today comes first; it is the one we seal under.
  return found.sort((a, b) => Number(b.kid === derived) - Number(a.kid === derived));
}

/**
 * Confirm that an already-visible store rename is durable before a caller uses
 * it as proof that establishment completed. A parent-directory fsync can fail
 * after rename; the next request must retry that exact durability boundary
 * before it contacts Cosmos or reports success.
 */
export function confirmStoreDurability(): void {
  // `readStore` performs strict descriptor/schema validation and confirms the
  // parent directory before it can return an existing store. Reuse that one
  // path so a durability probe can never be weaker than a real first use.
  void readStore();
}

/**
 * Replace the store atomically.
 *
 * `writeFileSync` truncates first, so a crash, a full disk or an OOM kill
 * between the truncate and the write leaves a zero-length file where the
 * wearer's only copy of their key used to be. That loss is unrecoverable —
 * nothing sealed under it can ever be opened again — and it surfaces as a
 * SystemExit from the deploy's channel-key validator rather than as anything
 * pointing here. Write a sibling and rename instead: rename within a directory
 * is atomic, so a reader sees either the whole old file or the whole new one.
 * Sync the directory after rename as well: syncing the temporary file protects
 * its bytes, while syncing the parent makes the replacement directory entry
 * survive a host power loss before this operation is acknowledged.
 *
 * The sibling carries this process's pid so stale temporary files do not collide
 * inside the one supported writer process. It is not a multi-process lock: the
 * production topology deliberately runs one Center writer and deployment stops
 * the old stack under the global deployment lock before starting its successor.
 */
function writeStore(body: KeyStore): void {
  const file = channelKeyFile();
  // New data crosses the same schema boundary as restored data. In particular,
  // a malformed identity claim must fail before it can create a snapshot that
  // the next process would correctly refuse to load.
  validateStore(body, file);
  // Serialize once, and reject the complete bytes before touching a sibling.
  // Re-stringifying after validation can otherwise make the bound and the file
  // that is actually renamed two subtly different values.
  const serialized = Buffer.from(JSON.stringify(body), "utf8");
  if (serialized.length < 1 || serialized.length > MAX_STORE_BYTES) {
    throw invalidStore(file, "serialized store exceeds the 1..16384 byte contract");
  }
  const temporary = `${file}.${process.pid}.tmp`;
  // A leftover from a crashed predecessor with this pid would keep ITS mode, so
  // remove it and create fresh: 0600 is only applied to a file this call makes.
  fs.rmSync(temporary, { force: true });
  let descriptor: number | null = null;
  let renamed = false;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, serialized);
    // Rename orders the directory entry, not the file's contents. Without this
    // a host that loses power just after the rename can come back with the new
    // name pointing at an empty file — the exact loss the rename prevents.
    fs.fsyncSync(descriptor);
    if (exactStoreMode(fs.fstatSync(descriptor)) !== 0o600) {
      throw invalidStore(file, "new store mode is not exactly 0600");
    }
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
    renamed = true;
    const directoryDescriptor = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (!renamed) fs.rmSync(temporary, { force: true });
  }
}

/**
 * Persist this wearer's key, merged into whatever is already there.
 *
 * Failure is both logged and propagated. The caller must not acknowledge or
 * publish a channel key that has not crossed the complete file-sync, rename,
 * directory-sync durability boundary; its next request can safely retry.
 */
export function saveKey(channel: ChannelKey): void {
  const file = channelKeyFile();
  if (parseCenterKid(channel.kid) === null || channel.key.length !== 16) {
    throw new ChannelKeyUnavailableError(CHANNEL_KEY_IDENTITY_INVALID);
  }
  const encoded = channel.key.toString("base64");
  let store: KeyStore | null;
  try {
    // Re-read immediately before writing so concurrent establishments inside
    // the supported single Center process merge into the map. Synchronous I/O
    // serializes these calls in that process; multiple writer processes are not
    // a supported topology and would require database-backed coordination.
    store = readStore();
  } catch (error) {
    // An unreadable store must never be overwritten. The bytes underneath it
    // may be the only copy of this wearer's — or another wearer's — key.
    if (!(error instanceof ChannelKeyUnavailableError)) {
      logWarn(
        `channel: ${file} could not be read safely before writing, so establishment was not acknowledged and no replacement was attempted`,
        error,
      );
    }
    throw error;
  }

  // The mirrored pair moves together or not at all: a half-written `kid` without
  // its `key` would satisfy nothing and break the restore shape.
  const mirrored = store === null ? null : { kid: store.kid, key: store.key };
  const body: KeyStore = {
    ...(mirrored ?? { kid: channel.kid, key: encoded }),
    keys: {
      // The migration, and it comes FIRST so a map entry for the same kid wins:
      // the map is authoritative, the pair is its mirror. Copying the legacy
      // pair in is what stops it being orphaned the day the derived kid changes
      // shape again — it stays a key this wearer's envelopes can be opened with
      // rather than two fields only one reader still looks at.
      ...(mirrored ? { [mirrored.kid]: mirrored.key } : {}),
      ...(store?.keys ?? {}),
      [channel.kid]: encoded,
    },
  };

  try {
    writeStore(body);
  } catch (error) {
    if (error instanceof ChannelKeyUnavailableError) throw error;
    logWarn(
      `channel: ${file} did not cross the complete file-and-directory durability boundary; a rename may already be visible, but establishment must retry before using or acknowledging it`,
      error,
    );
    throw new ChannelKeyUnavailableError(CHANNEL_KEY_STORE_DEGRADED);
  }
}
