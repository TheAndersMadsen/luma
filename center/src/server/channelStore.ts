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
 *
 * This is wearer key material: it is never logged (kids are; keys are not), the
 * file is 0600, and both `.gitignore` and `.dockerignore` cover the name plus
 * the transient sibling this module renames over it.
 */

import fs from "node:fs";
import path from "node:path";
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
 * the only one the deployment declares (`COSMOS_CHANNEL_KEY_FILE`), the only one
 * the restore/backup contract knows, and the only one `.gitignore` and
 * `.dockerignore` name; inventing sibling filenames would put wearer key
 * material somewhere neither of those covers. (`writeStore` does use one
 * transient sibling, `<file>.<pid>.tmp`, so the replacement can be atomic —
 * which is why both ignore lists now cover `.cosmos-channel-key.json*` rather
 * than the exact name.)
 *
 * Read per call rather than captured at import: a deployment sets it before the
 * process starts, so nothing changes there, and a test can point one case at a
 * scratch file without loading a second copy of the module.
 */
export function channelKeyFile(): string {
  return process.env.COSMOS_CHANNEL_KEY_FILE
    ?? path.join(process.cwd(), ".cosmos-channel-key.json");
}

interface KeyStore {
  /** The first key this deployment established — the restore-compatible shape. */
  kid?: string;
  key?: string;
  /** Every established key, by kid. Authoritative; the pair above is a mirror. */
  keys?: Record<string, string>;
}

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
function readStore(): KeyStore {
  const file = channelKeyFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return {};
    throw new ChannelKeyUnavailableError(
      `the channel key store ${file} could not be read (${errnoOf(error)}), so this deployment cannot tell whether the wearer already has a key - refusing to mint a second one over it`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Corrupt is unreadable, not absent, for exactly the same reason.
    throw new ChannelKeyUnavailableError(
      `the channel key store ${file} is not valid JSON (${error instanceof Error ? error.message : "parse failed"}) - refusing to mint a second key over the wearer's existing one`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ChannelKeyUnavailableError(
      `the channel key store ${file} does not hold a JSON object - refusing to mint a second key over the wearer's existing one`,
    );
  }
  return parsed as KeyStore;
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
 * The two forms differ only by a version/device prefix in front of the same
 * `U:<sub>` partition, so one is a colon-delimited suffix of the other. The
 * colon is required and is the whole safety argument: it forces the match onto a
 * segment boundary, so one wearer's id can never be read as the tail of
 * another's — `U:ab` does not match `U:cab`, and nothing shorter than a whole
 * `U:<uuid>` segment can match at all.
 */
export function namesSameWearer(a: string, b: string): boolean {
  return a === b || a.endsWith(`:${b}`) || b.endsWith(`:${a}`);
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
 * Replace the store atomically.
 *
 * `writeFileSync` truncates first, so a crash, a full disk or an OOM kill
 * between the truncate and the write leaves a zero-length file where the
 * wearer's only copy of their key used to be. That loss is unrecoverable —
 * nothing sealed under it can ever be opened again — and it surfaces as a
 * SystemExit from the deploy's channel-key validator rather than as anything
 * pointing here. Write a sibling and rename instead: rename within a directory
 * is atomic, so a reader sees either the whole old file or the whole new one.
 *
 * The sibling carries this process's pid so two Center processes cannot land on
 * the same temporary name, and a crash cannot leave key material under a name
 * the ignore lists do not cover.
 */
function writeStore(body: KeyStore): void {
  const file = channelKeyFile();
  const temporary = `${file}.${process.pid}.tmp`;
  // A leftover from a crashed predecessor with this pid would keep ITS mode, so
  // remove it and create fresh: 0600 is only applied to a file this call makes.
  fs.rmSync(temporary, { force: true });
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(body));
    // Rename orders the directory entry, not the file's contents. Without this
    // a host that loses power just after the rename can come back with the new
    // name pointing at an empty file — the exact loss the rename prevents.
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
 * Persist this wearer's key, merged into whatever is already there.
 *
 * Never fatal — the key works for this process either way — but never silent
 * either. A store that cannot be written means the next restart mints another
 * key and orphans everything sealed since, and the only warning that ever had
 * was an empty `catch {}`.
 */
export function saveKey(channel: ChannelKey): void {
  const file = channelKeyFile();
  const encoded = channel.key.toString("base64");
  let store: KeyStore;
  try {
    // Re-read immediately before writing so a second wearer establishing
    // concurrently does not erase the first: the map is merged, never replaced.
    store = readStore();
  } catch (error) {
    // An unreadable store must never be overwritten. The bytes underneath it
    // may be the only copy of this wearer's — or another wearer's — key.
    logWarn(
      `channel: ${file} could not be read before writing, so the key established now was not persisted and a restart will mint another`,
      error,
    );
    return;
  }

  // The mirrored pair moves together or not at all: a half-written `kid` without
  // its `key` would satisfy nothing and break the restore shape.
  const mirrored = store.kid && store.key ? { kid: store.kid, key: store.key } : null;
  const body: KeyStore = {
    ...(mirrored ?? { kid: channel.kid, key: encoded }),
    keys: {
      // The migration, and it comes FIRST so a map entry for the same kid wins:
      // the map is authoritative, the pair is its mirror. Copying the legacy
      // pair in is what stops it being orphaned the day the derived kid changes
      // shape again — it stays a key this wearer's envelopes can be opened with
      // rather than two fields only one reader still looks at.
      ...(mirrored ? { [mirrored.kid]: mirrored.key } : {}),
      ...(store.keys ?? {}),
      [channel.kid]: encoded,
    },
  };

  try {
    writeStore(body);
  } catch (error) {
    logWarn(
      `channel: ${file} could not be written, so the key established now exists only in memory and a restart will mint another`,
      error,
    );
  }
}
