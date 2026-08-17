#!/usr/bin/env node

/*
 * Ship an already-published Pin release from the local operator store to the
 * store Center serves from.
 *
 * Why this file exists at all: `./revival pin release build` publishes five
 * signed APKs, an immutable manifest, `current.json` and the anti-rollback
 * `history.json` into a LOCAL directory (build.mjs `publishPinRelease`).
 * Center reads a store with exactly that layout from
 * `REVIVAL_PIN_RELEASE_DIR` (center/src/server/pin-releases.ts), and the
 * deploy creates that directory on the VPS and bind-mounts it read-only
 * (platform/deploy/vps/remote/common.sh, platform/compose/production.yaml).
 * Nothing ever put a release INTO it, so `/api/pin/releases/current` answered
 * 404 for the browser installer and both the canary and the staging smoke
 * accepted that 404 as normal. This is the missing step, and only that step —
 * it is not part of a deploy and it never runs one.
 *
 * There is exactly ONE verifier in play. Everything semantic — canonical
 * manifest bytes, the release identity digest, per-artifact size and SHA-256,
 * a strictly monotonic version history, and each history entry's
 * `manifestSha256` — is checked here through the same `release.mjs` functions
 * `build.mjs` publishes with. What runs on the far side is deliberately dumb:
 * it compares digests and sizes against a plan that was verified here, and it
 * swaps `history.json`/`current.json` only if their current bytes still hash
 * to what the inspection observed. No second, weaker parser exists remotely.
 *
 * Size discipline: the server APK is over 200 MiB. No artifact is ever read
 * into memory on either side — local hashing streams, transfer is `scp`, and
 * the remote helper hashes in 1 MiB chunks. Artifact bytes never enter the
 * ssh payload, and nothing here is reachable from a Docker build context.
 */

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { defaultOperatorPaths } from "./build.mjs";
import {
  canonicalPinReleaseManifestJson,
  parseCanonicalPinReleaseManifestDocument,
  parsePinReleaseHistory,
  parsePinReleaseJson,
} from "./release.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);

export const PIN_RELEASE_STORE_SCHEMA_VERSION = 1;
export const MAX_STORE_DOCUMENT_BYTES = 1024 * 1024;
export const MAX_REMOTE_REPORT_BYTES = 8 * 1024 * 1024;
/** Matches the production bind-mount source in platform/compose/production.yaml. */
export const DEFAULT_REMOTE_RELEASE_ROOT = "/home/anders/ai-pin-revival/data/pin-releases";
export const PAYLOAD_DELIMITER = "__REVIVAL_PIN_SHIP_PAYLOAD__";

const RELEASE_ID_RE = /^[0-9a-f]{64}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const REMOTE_NAME_RE = /^[A-Za-z0-9._@:-]+$/u;
const STORE_DOCUMENTS = Object.freeze(["history.json", "current.json"]);

export class PinReleaseShipError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PinReleaseShipError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PinReleaseShipError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filename) {
  const digest = createHash("sha256");
  let size = 0;
  // Streamed on purpose: one of the five artifacts is a >200 MiB server APK,
  // and `readFile` on it would put the whole thing in this process's heap.
  for await (const chunk of createReadStream(filename, { highWaterMark: 1024 * 1024 })) {
    size += chunk.length;
    digest.update(chunk);
  }
  return Object.freeze({ size, sha256: digest.digest("hex") });
}

async function realDirectory(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") fail("store-missing", `${label} is missing: ${path}`);
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail("store-invalid", `${label} must be a real directory: ${path}`);
  }
  return path;
}

async function readBoundedDocument(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail("store-invalid", `${label} must be a regular file: ${path}`);
  }
  if (metadata.size <= 0 || metadata.size > MAX_STORE_DOCUMENT_BYTES) {
    fail("store-invalid", `${label} is outside its supported size range: ${path}`);
  }
  return await readFile(path, "utf8");
}

/* ------------------------------------------------------ store verification --- */

/**
 * The one place a Pin release store — local or remote — is judged.
 *
 * `entries` is a per-file `{size, sha256}` map for the release directory the
 * history tail names. The local caller produces it by streaming the files; the
 * remote caller produces it from the inspection report. Both then land in this
 * identical set of checks, which is what makes "verified the same way" true
 * rather than aspirational.
 */
function verifyStoreDocuments({
  historySource,
  currentSource,
  entriesByRelease,
  label,
  tolerateInterruptedSwap = false,
}) {
  if (historySource === null) {
    if (currentSource !== null) {
      fail("history-missing", `${label} has a current release with no anti-rollback history`);
    }
    return Object.freeze({
      history: Object.freeze({ schemaVersion: 1, releases: Object.freeze([]) }),
      historyDocument: null,
      tail: null,
      current: null,
    });
  }

  const history = parsePinReleaseHistory(
    parsePinReleaseJson(historySource, `${label} history`),
  );
  // Byte-exact republication is the whole point: the document that lands on the
  // far side has to be the document that was verified, not a re-serialization
  // that happens to parse the same way.
  if (historySource !== `${JSON.stringify(history)}\n`) {
    fail("history-noncanonical", `${label} history.json is not canonical compact JSON plus one LF`);
  }

  const tail = history.releases.at(-1) ?? null;
  if (tail === null) {
    if (currentSource !== null) {
      fail("history-current-mismatch", `${label} has an empty history and a current release`);
    }
    return Object.freeze({
      history,
      historyDocument: historySource,
      tail: null,
      served: null,
      current: null,
    });
  }
  if (currentSource === null) {
    fail("current-missing", `${label} has an anti-rollback history with no current release`);
  }

  const manifest = parseCanonicalPinReleaseManifestDocument(currentSource);
  const canonical = canonicalPinReleaseManifestJson(manifest);
  if (canonical !== currentSource) {
    fail("current-noncanonical", `${label} current.json is not the canonical manifest document`);
  }

  /*
   * Which accepted release `current.json` actually is.
   *
   * Normally the tail. The one other state that is allowed — and only on the
   * far side, where `tolerateInterruptedSwap` is set — is the entry immediately
   * before it: publication writes `history.json` and then `current.json`, so an
   * interrupted swap leaves the accepted release recorded and the served one a
   * step behind. `build.mjs` tolerates and repairs exactly that state locally
   * (`verifyPublicationState`). Refusing it here would mean an interrupted ship
   * could only be resolved by hand-editing files on the server, which is the
   * category of dead end this tool exists to remove. Every other divergence is
   * still a refusal.
   */
  const currentDigest = sha256(currentSource);
  const previous = history.releases.at(-2) ?? null;
  const served =
    currentDigest === tail.manifestSha256
      ? tail
      : tolerateInterruptedSwap && previous && currentDigest === previous.manifestSha256
        ? previous
        : null;
  if (
    served === null ||
    manifest.releaseId !== served.releaseId ||
    manifest.version !== served.version ||
    manifest.artifacts[0].versionCode !== served.versionCode
  ) {
    fail("history-current-mismatch", `${label} current release differs from the history tail`);
  }

  const entries = entriesByRelease.get(served.releaseId);
  if (entries === undefined) {
    fail("release-missing", `${label} has no immutable directory for ${served.releaseId}`);
  }
  verifyReleaseEntries({ manifest, canonical, entries, label });

  return Object.freeze({
    history,
    historyDocument: historySource,
    tail,
    /** The accepted entry `current.json` names — the tail, unless a swap was cut short. */
    served,
    current: Object.freeze({ manifest, canonical, sha256: currentDigest }),
  });
}

/** Exactly `manifest.json` plus the five APKs, each pinned to its digest and size. */
function verifyReleaseEntries({ manifest, canonical, entries, label }) {
  const expected = new Map([
    ["manifest.json", { size: Buffer.byteLength(canonical), sha256: sha256(canonical) }],
    ...manifest.artifacts.map((artifact) => [
      artifact.name,
      { size: artifact.size, sha256: artifact.sha256 },
    ]),
  ]);
  const actualNames = [...entries.keys()].sort();
  const expectedNames = [...expected.keys()].sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    fail(
      "release-equivocation",
      `${label} release ${manifest.releaseId} contains missing or unexpected entries`,
    );
  }
  for (const [name, want] of expected) {
    const actual = entries.get(name);
    if (actual.size !== want.size || actual.sha256 !== want.sha256) {
      fail(
        "release-equivocation",
        `${label} release ${manifest.releaseId} entry ${name} does not match its pinned digest`,
      );
    }
  }
}

function parseEntryDigests(value, label) {
  if (!isRecord(value)) fail("report-invalid", `${label} entry map is not an object`);
  const entries = new Map();
  for (const [name, descriptor] of Object.entries(value)) {
    if (!isRecord(descriptor)) fail("report-invalid", `${label} entry ${name} is not an object`);
    if (descriptor.kind !== "file") {
      fail("store-invalid", `${label} entry ${name} is not a regular file`);
    }
    if (
      typeof descriptor.size !== "number" ||
      !Number.isSafeInteger(descriptor.size) ||
      descriptor.size < 0 ||
      typeof descriptor.sha256 !== "string" ||
      !SHA256_RE.test(descriptor.sha256)
    ) {
      fail("report-invalid", `${label} entry ${name} has no usable size and digest`);
    }
    entries.set(name, Object.freeze({ size: descriptor.size, sha256: descriptor.sha256 }));
  }
  return entries;
}

/**
 * Read and fully verify the operator's local store.
 *
 * This is the store `./revival pin release build` writes. Every artifact is
 * hashed from disk here, because the digests it produces are what the far side
 * is later held to.
 */
export async function readLocalPinReleaseStore({ root, label = "local Pin release store" }) {
  const storeRoot = await realDirectory(resolve(root), label);
  const historySource = await readBoundedDocument(join(storeRoot, "history.json"), `${label} history`);
  const currentSource = await readBoundedDocument(join(storeRoot, "current.json"), `${label} current release`);

  const entriesByRelease = new Map();
  let releaseDirectory = null;
  if (historySource !== null && currentSource !== null) {
    // Only the tail is hashed. `build.mjs` verifies exactly the same subset on
    // republication; hashing every historical release would re-read the entire
    // store, which grows without bound, for no additional guarantee about the
    // release actually being shipped.
    const manifest = parseCanonicalPinReleaseManifestDocument(currentSource);
    releaseDirectory = join(storeRoot, "releases", manifest.releaseId);
    await realDirectory(releaseDirectory, `${label} release ${manifest.releaseId}`);
    const entries = new Map();
    for (const name of (await readdir(releaseDirectory)).sort()) {
      const filename = join(releaseDirectory, name);
      const metadata = await lstat(filename);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        fail("store-invalid", `${label} release entry is not a regular file: ${name}`);
      }
      const digest = await sha256File(filename);
      if (digest.size !== metadata.size) {
        fail("store-changed", `${label} release entry changed while it was read: ${name}`);
      }
      entries.set(name, Object.freeze(digest));
    }
    entriesByRelease.set(manifest.releaseId, entries);
  }

  const verified = verifyStoreDocuments({
    historySource,
    currentSource,
    entriesByRelease,
    label,
  });
  return Object.freeze({
    root: storeRoot,
    releaseDirectory,
    entries: entriesByRelease.get(verified.tail?.releaseId) ?? new Map(),
    ...verified,
  });
}

/**
 * Verify the far-side store from its inspection report, through the same
 * checks the local store just went through.
 */
export function parseRemotePinReleaseStore(report, { label = "remote Pin release store" } = {}) {
  if (!isRecord(report)) fail("report-invalid", `${label} inspection report is not an object`);
  if (report.schemaVersion !== PIN_RELEASE_STORE_SCHEMA_VERSION) {
    fail("report-invalid", `${label} inspection report schemaVersion must be 1`);
  }
  if (report.rootExists !== true) fail("store-missing", `${label} root directory does not exist`);
  if (report.rootIsDirectory !== true) {
    fail("store-invalid", `${label} root is not a real directory`);
  }

  const documents = {};
  for (const name of STORE_DOCUMENTS) {
    const descriptor = report[name === "history.json" ? "history" : "current"];
    if (descriptor === null) {
      documents[name] = null;
      continue;
    }
    if (!isRecord(descriptor) || typeof descriptor.base64 !== "string") {
      fail("report-invalid", `${label} ${name} descriptor is unusable`);
    }
    const bytes = Buffer.from(descriptor.base64, "base64");
    if (
      bytes.length !== descriptor.size ||
      bytes.length > MAX_STORE_DOCUMENT_BYTES ||
      sha256(bytes) !== descriptor.sha256 ||
      bytes.toString("base64") !== descriptor.base64.replace(/\s+/gu, "")
    ) {
      fail("report-invalid", `${label} ${name} did not survive transport intact`);
    }
    documents[name] = bytes.toString("utf8");
  }

  if (!isRecord(report.releases)) fail("report-invalid", `${label} release map is not an object`);
  const entriesByRelease = new Map();
  for (const [releaseId, value] of Object.entries(report.releases)) {
    if (!RELEASE_ID_RE.test(releaseId)) {
      fail("report-invalid", `${label} reported a release identifier that is not a digest`);
    }
    if (value === null) continue;
    if (!isRecord(value) || value.isDirectory !== true) {
      fail("store-invalid", `${label} release ${releaseId} is not a real directory`);
    }
    entriesByRelease.set(releaseId, parseEntryDigests(value.entries, `${label} release ${releaseId}`));
  }

  const verified = verifyStoreDocuments({
    historySource: documents["history.json"],
    currentSource: documents["current.json"],
    entriesByRelease,
    label,
    tolerateInterruptedSwap: true,
  });
  return Object.freeze({
    root: typeof report.root === "string" ? report.root : "",
    entriesByRelease: Object.freeze(entriesByRelease),
    ...verified,
  });
}

/* ------------------------------------------------------------------ plan --- */

function sameHistoryEntry(left, right) {
  return (
    left.releaseId === right.releaseId &&
    left.version === right.version &&
    left.versionCode === right.versionCode &&
    left.manifestSha256 === right.manifestSha256
  );
}

/**
 * What must happen on the far side, decided entirely from two verified stores.
 *
 * The anti-rollback rule is a prefix rule, not a comparison: whatever the
 * server has already accepted must appear, entry for entry, at the front of
 * what is being shipped. That refuses a rollback, refuses a forked history,
 * and refuses a silent rewrite of an accepted entry — the three ways a publish
 * could make Center serve something older or different than it already did.
 */
export function createPinReleaseShipPlan({ local, remote }) {
  if (local.tail === null) fail("nothing-to-ship", "the local Pin release store has no published release");
  // The local store is read with no tolerance for an interrupted swap, so this
  // holds by construction. It is asserted anyway because if it ever stopped
  // holding, the ship would upload one release's files under another's
  // identifier — the single worst thing this tool could do.
  if (local.current.manifest.releaseId !== local.tail.releaseId) {
    fail("history-current-mismatch", "the local current release is not the accepted history tail");
  }

  const localReleases = local.history.releases;
  const remoteReleases = remote.history.releases;
  if (remoteReleases.length > localReleases.length) {
    fail("history-diverged", "the server has accepted releases this store has never published");
  }
  for (const [index, entry] of remoteReleases.entries()) {
    if (!sameHistoryEntry(entry, localReleases[index])) {
      fail("history-diverged", `the server's accepted release at position ${index + 1} is not the one this store published`);
    }
  }

  const target = local.tail;
  const alreadyCurrent =
    remote.tail !== null &&
    sameHistoryEntry(remote.tail, target) &&
    remote.current?.sha256 === local.current.sha256;

  const existing = remote.entriesByRelease.get(target.releaseId) ?? null;
  // A release directory that already exists has been proven byte-identical by
  // `parseRemotePinReleaseStore` when it is the tail; when it is not the tail it
  // is verified below against the same manifest. Either way there is nothing to
  // re-upload, and re-uploading over an immutable release is the equivocation
  // this refuses to perform.
  if (existing !== null && !alreadyCurrent) {
    verifyReleaseEntries({
      manifest: local.current.manifest,
      canonical: local.current.canonical,
      entries: existing,
      label: "remote Pin release store",
    });
  }

  const uploads =
    existing === null
      ? Object.freeze([
          Object.freeze({
            name: "manifest.json",
            size: Buffer.byteLength(local.current.canonical),
            sha256: sha256(local.current.canonical),
            source: join(local.releaseDirectory, "manifest.json"),
          }),
          ...local.current.manifest.artifacts.map((artifact) =>
            Object.freeze({
              name: artifact.name,
              role: artifact.role,
              size: artifact.size,
              sha256: artifact.sha256,
              source: join(local.releaseDirectory, artifact.name),
            }),
          ),
        ])
      : Object.freeze([]);

  return Object.freeze({
    schemaVersion: 1,
    releaseId: target.releaseId,
    version: target.version,
    versionCode: target.versionCode,
    manifestSha256: target.manifestSha256,
    /** True when the server already serves exactly this release; apply is a no-op. */
    alreadyCurrent,
    uploads,
    uploadBytes: uploads.reduce((total, upload) => total + upload.size, 0),
    expectedHistorySha256: remote.historyDocument === null ? null : sha256(remote.historyDocument),
    expectedCurrentSha256: remote.current === null ? null : remote.current.sha256,
    historyDocument: local.historyDocument,
    currentDocument: local.current.canonical,
  });
}

export function createApplyPayload(plan, incomingName) {
  return `${JSON.stringify({
    schemaVersion: 1,
    releaseId: plan.releaseId,
    incoming: plan.uploads.length === 0 ? null : incomingName,
    entries: plan.uploads.length === 0
      ? null
      : plan.uploads.map((upload) => ({
          name: upload.name,
          size: upload.size,
          sha256: upload.sha256,
        })),
    expectedHistorySha256: plan.expectedHistorySha256,
    expectedCurrentSha256: plan.expectedCurrentSha256,
    historyBase64: Buffer.from(plan.historyDocument, "utf8").toString("base64"),
    currentBase64: Buffer.from(plan.currentDocument, "utf8").toString("base64"),
  })}\n`;
}

/* ------------------------------------------------------- remote helpers --- */

const REMOTE_PRELUDE = `set -euo pipefail
umask 077
`;

export const REMOTE_INSPECT_SCRIPT = `${REMOTE_PRELUDE}root="$1"
shift
python3 - "$root" "$@" <<'__REVIVAL_PIN_INSPECT__'
import base64, hashlib, json, os, stat, sys

MAX_DOCUMENT_BYTES = ${MAX_STORE_DOCUMENT_BYTES}
CHUNK = 1024 * 1024

root = sys.argv[1]
wanted = sys.argv[2:]


def refuse(message):
    sys.stderr.write("pin-release-ship: " + message + "\\n")
    raise SystemExit(70)


def info(path):
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None


def digest_file(path):
    size = 0
    digest = hashlib.sha256()
    with open(path, "rb", buffering=0) as handle:
        while True:
            chunk = handle.read(CHUNK)
            if not chunk:
                break
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


def read_document(path, label):
    metadata = info(path)
    if metadata is None:
        return None
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        refuse(label + " is not a regular file")
    if metadata.st_size <= 0 or metadata.st_size > MAX_DOCUMENT_BYTES:
        refuse(label + " is outside its supported size range")
    with open(path, "rb", buffering=0) as handle:
        data = handle.read(MAX_DOCUMENT_BYTES + 1)
    if len(data) > MAX_DOCUMENT_BYTES:
        refuse(label + " grew past its bound while it was read")
    return {
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "base64": base64.b64encode(data).decode("ascii"),
    }


report = {
    "schemaVersion": 1,
    "root": root,
    "rootExists": False,
    "rootIsDirectory": False,
    "history": None,
    "current": None,
    "releases": {},
}

root_metadata = info(root)
if root_metadata is not None:
    report["rootExists"] = True
    report["rootIsDirectory"] = bool(
        stat.S_ISDIR(root_metadata.st_mode) and not stat.S_ISLNK(root_metadata.st_mode)
    )

if report["rootIsDirectory"]:
    report["history"] = read_document(os.path.join(root, "history.json"), "history.json")
    report["current"] = read_document(os.path.join(root, "current.json"), "current.json")
    # Whatever the store already serves is always inspected too, so the caller
    # can verify the release it is about to REPLACE with the same digest checks
    # as the one it is shipping. This reads one field to choose a directory; it
    # decides nothing. Every judgement about these bytes is made by the caller.
    if report["current"] is not None:
        try:
            served = json.loads(base64.b64decode(report["current"]["base64"]).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            served = None
        if isinstance(served, dict):
            served_id = served.get("releaseId")
            if isinstance(served_id, str) and len(served_id) == 64 and all(
                character in "0123456789abcdef" for character in served_id
            ):
                wanted = list(wanted) + [served_id]
    for release_id in sorted(set(wanted)):
        directory = os.path.join(root, "releases", release_id)
        metadata = info(directory)
        if metadata is None:
            report["releases"][release_id] = None
            continue
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            report["releases"][release_id] = {"isDirectory": False, "entries": {}}
            continue
        entries = {}
        for name in sorted(os.listdir(directory)):
            child = os.path.join(directory, name)
            child_metadata = info(child)
            if child_metadata is None:
                continue
            if stat.S_ISLNK(child_metadata.st_mode) or not stat.S_ISREG(child_metadata.st_mode):
                entries[name] = {"kind": "other", "size": 0, "sha256": ""}
                continue
            size, sha256 = digest_file(child)
            entries[name] = {"kind": "file", "size": size, "sha256": sha256}
        report["releases"][release_id] = {"isDirectory": True, "entries": entries}

sys.stdout.write(json.dumps(report, sort_keys=True, separators=(",", ":")) + "\\n")
__REVIVAL_PIN_INSPECT__
`;

export const REMOTE_APPLY_SCRIPT = `${REMOTE_PRELUDE}root="$1"
python3 - "$root" <<'__REVIVAL_PIN_APPLY__'
import base64, hashlib, json, os, stat, sys, tempfile

CHUNK = 1024 * 1024
root = sys.argv[1]

with open(os.environ["REVIVAL_PIN_PAYLOAD"], "rb") as handle:
    payload = json.loads(handle.read().decode("utf-8"))


def refuse(message):
    sys.stderr.write("pin-release-ship: " + message + "\\n")
    raise SystemExit(70)


def info(path):
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None


def digest_file(path):
    size = 0
    digest = hashlib.sha256()
    with open(path, "rb", buffering=0) as handle:
        while True:
            chunk = handle.read(CHUNK)
            if not chunk:
                break
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


def require_directory(path, label):
    metadata = info(path)
    if metadata is None:
        refuse(label + " is missing")
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        refuse(label + " is not a real directory")


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def document_digest(path):
    metadata = info(path)
    if metadata is None:
        return None
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        refuse(os.path.basename(path) + " is not a regular file")
    return digest_file(path)[1]


def atomic_write(path, data):
    handle, temporary = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".", suffix=".tmp")
    try:
        os.write(handle, data)
        os.fsync(handle)
        os.fchmod(handle, 0o600)
    finally:
        os.close(handle)
    os.replace(temporary, path)
    sync_directory(os.path.dirname(path))


require_directory(root, "release store root")
releases_root = os.path.join(root, "releases")
if info(releases_root) is None:
    os.mkdir(releases_root, 0o700)
require_directory(releases_root, "immutable releases directory")

# Compare-and-swap. The two mutable documents must still be exactly what the
# inspection saw, or another publisher moved underneath this one and the plan's
# anti-rollback reasoning no longer describes reality.
for name, expected in (
    ("history.json", payload["expectedHistorySha256"]),
    ("current.json", payload["expectedCurrentSha256"]),
):
    observed = document_digest(os.path.join(root, name))
    if observed != expected:
        refuse(name + " changed since the store was inspected")

final = os.path.join(releases_root, payload["releaseId"])
if payload["incoming"] is None:
    require_directory(final, "immutable release " + payload["releaseId"])
else:
    incoming = os.path.join(releases_root, payload["incoming"])
    require_directory(incoming, "incoming release directory")
    expected_entries = {entry["name"]: entry for entry in payload["entries"]}
    actual_entries = sorted(os.listdir(incoming))
    if actual_entries != sorted(expected_entries):
        refuse("incoming release directory does not hold exactly the planned files")
    for name in actual_entries:
        child = os.path.join(incoming, name)
        metadata = info(child)
        if metadata is None or stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            refuse("incoming entry is not a regular file: " + name)
        size, sha256 = digest_file(child)
        if size != expected_entries[name]["size"] or sha256 != expected_entries[name]["sha256"]:
            refuse("incoming entry does not match its pinned digest: " + name)
        os.chmod(child, 0o600)
        fd = os.open(child, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    os.chmod(incoming, 0o700)
    sync_directory(incoming)
    if info(final) is not None:
        refuse("immutable release already exists; it must never be rewritten")
    os.rename(incoming, final)
    sync_directory(releases_root)

atomic_write(os.path.join(root, "history.json"), base64.b64decode(payload["historyBase64"]))
atomic_write(os.path.join(root, "current.json"), base64.b64decode(payload["currentBase64"]))

sys.stdout.write(
    json.dumps(
        {"schemaVersion": 1, "applied": True, "releaseId": payload["releaseId"]},
        sort_keys=True,
        separators=(",", ":"),
    )
    + "\\n"
)
__REVIVAL_PIN_APPLY__
`;

/**
 * The exact bytes a transport feeds to `bash -s`.
 *
 * Shared by the ssh transport and the filesystem transport so that a test which
 * runs the helper locally runs the identical text the server would.
 */
export function composeRemoteInvocation({ script, document }) {
  if (typeof script !== "string" || script.length === 0) {
    fail("invalid-invocation", "a remote helper script is required");
  }
  if (document === undefined || document === null) {
    return `${REMOTE_PRELUDE}REVIVAL_PIN_PAYLOAD=""\nexport REVIVAL_PIN_PAYLOAD\n${script}`;
  }
  if (typeof document !== "string" || document.includes(PAYLOAD_DELIMITER)) {
    fail("invalid-invocation", "the remote payload cannot contain the payload delimiter");
  }
  return (
    `${REMOTE_PRELUDE}` +
    `payload_file="$(mktemp)"\n` +
    `cleanup_payload() { rm -f -- "$payload_file"; }\n` +
    `trap cleanup_payload EXIT\n` +
    `cat <<'${PAYLOAD_DELIMITER}' > "$payload_file"\n` +
    `${document.endsWith("\n") ? document : `${document}\n`}` +
    `${PAYLOAD_DELIMITER}\n` +
    `REVIVAL_PIN_PAYLOAD="$payload_file"\nexport REVIVAL_PIN_PAYLOAD\n` +
    script
  );
}

export function shellQuote(value) {
  if (typeof value !== "string" || value.includes("\0")) {
    fail("invalid-invocation", "a remote argument must be NUL-free text");
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function validateRemoteRoot(candidate) {
  if (
    typeof candidate !== "string" ||
    !/^\/[A-Za-z0-9._/-]+$/u.test(candidate) ||
    candidate.includes("//") ||
    candidate.includes("/./") ||
    candidate.includes("/../") ||
    candidate.endsWith("/.") ||
    candidate.endsWith("/..") ||
    candidate.endsWith("/")
  ) {
    fail("invalid-remote-root", `unsafe remote release store path: ${String(candidate)}`);
  }
  return candidate;
}

function runProcess(executable, args, { input, label, maximumOutputBytes = MAX_REMOTE_REPORT_BYTES }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > maximumOutputBytes) {
        child.kill("SIGKILL");
        finish(() => rejectPromise(new PinReleaseShipError("remote-failed", `${label} exceeded its output bound`)));
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length <= 64 * 1024) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      finish(() => rejectPromise(new PinReleaseShipError("remote-failed", `${label} could not start: ${error.message}`)));
    });
    child.once("close", (code, signal) => {
      finish(() => {
        if (code === 0 && signal === null) resolvePromise(stdout);
        else {
          rejectPromise(new PinReleaseShipError(
            "remote-failed",
            `${label} failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
          ));
        }
      });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * Ship over ssh/scp. `scp` is what carries the APKs: it streams, so a 200 MiB
 * server package never becomes a buffer in this process or in the ssh payload.
 */
export function createSshTransport({ remote, sshExecutable = "ssh", scpExecutable = "scp" }) {
  if (typeof remote !== "string" || !REMOTE_NAME_RE.test(remote)) {
    fail("invalid-remote", `unsafe ssh target: ${String(remote)}`);
  }
  const sshOptions = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
  ];
  return Object.freeze({
    describe: () => `ssh:${remote}`,
    async run({ script, args = [], document, label }) {
      const command = `bash -s -- ${args.map((value) => shellQuote(value)).join(" ")}`;
      return await runProcess(sshExecutable, [...sshOptions, remote, command], {
        input: composeRemoteInvocation({ script, document }),
        label,
      });
    },
    async upload({ source, destination, label }) {
      await runProcess(
        scpExecutable,
        [...sshOptions, "-q", "--", source, `${remote}:${destination}`],
        { input: "", label, maximumOutputBytes: 64 * 1024 },
      );
    },
    async makeIncomingDirectory({ releasesRoot, name }) {
      const path = `${releasesRoot}/${name}`;
      await runProcess(
        sshExecutable,
        [...sshOptions, remote, `umask 077; test ! -e ${shellQuote(path)} && install -d -m 700 ${shellQuote(path)}`],
        { input: "", label: "incoming directory creation", maximumOutputBytes: 64 * 1024 },
      );
      return path;
    },
    async removeIncomingDirectory({ releasesRoot, name }) {
      const path = `${releasesRoot}/${name}`;
      await runProcess(
        sshExecutable,
        [...sshOptions, remote, `rm -rf -- ${shellQuote(path)}`],
        { input: "", label: "incoming directory cleanup", maximumOutputBytes: 64 * 1024 },
      ).catch(() => undefined);
    },
  });
}

/**
 * Ship into a store on this machine — the same helper scripts, run through the
 * local shell. Real when the store is a locally mounted volume, and it is what
 * lets the acceptance suite execute the actual remote helpers without a server.
 */
export function createLocalTransport({ shellExecutable = "bash" } = {}) {
  return Object.freeze({
    describe: () => "file",
    async run({ script, args = [], document, label }) {
      return await runProcess(shellExecutable, ["-s", "--", ...args], {
        input: composeRemoteInvocation({ script, document }),
        label,
      });
    },
    async upload({ source, destination }) {
      await pipeline(createReadStream(source), createWriteStream(destination, { mode: 0o600 }));
    },
    async makeIncomingDirectory({ releasesRoot, name }) {
      await mkdir(releasesRoot, { recursive: true, mode: 0o700 });
      const path = join(releasesRoot, name);
      await mkdir(path, { mode: 0o700 });
      return path;
    },
    async removeIncomingDirectory({ releasesRoot, name }) {
      await rm(join(releasesRoot, name), { recursive: true, force: true }).catch(() => undefined);
    },
  });
}

/* ------------------------------------------------------------------ ship --- */

function parseReport(stdout, label) {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length !== 1) fail("report-invalid", `${label} did not return exactly one report line`);
  try {
    return JSON.parse(lines[0]);
  } catch {
    return fail("report-invalid", `${label} did not return JSON`);
  }
}

export async function inspectRemotePinReleaseStore({ transport, remoteRoot, releaseIds = [] }) {
  validateRemoteRoot(remoteRoot);
  for (const releaseId of releaseIds) {
    if (!RELEASE_ID_RE.test(releaseId)) fail("invalid-release-id", `unsafe release identifier: ${releaseId}`);
  }
  const stdout = await transport.run({
    script: REMOTE_INSPECT_SCRIPT,
    args: [remoteRoot, ...releaseIds],
    label: "remote release store inspection",
  });
  return parseRemotePinReleaseStore(parseReport(stdout, "remote release store inspection"));
}

/**
 * Plan, and — only with `confirm` — carry it out.
 *
 * Without `confirm` this reads both stores and stops. That is deliberate and
 * matches `./revival pin install`: the command that can change something states
 * what it would change and does nothing until it is told twice.
 */
export async function shipPinRelease({
  releaseRoot,
  remoteRoot = DEFAULT_REMOTE_RELEASE_ROOT,
  transport,
  confirm = false,
}) {
  validateRemoteRoot(remoteRoot);
  const local = await readLocalPinReleaseStore({ root: releaseRoot });
  if (local.tail === null) fail("nothing-to-ship", "the local Pin release store has no published release");

  const remote = await inspectRemotePinReleaseStore({
    transport,
    remoteRoot,
    releaseIds: [local.tail.releaseId],
  });
  const plan = createPinReleaseShipPlan({ local, remote });

  const summary = {
    schemaVersion: 1,
    target: transport.describe(),
    remoteRoot,
    releaseId: plan.releaseId,
    version: plan.version,
    versionCode: plan.versionCode,
    alreadyCurrent: plan.alreadyCurrent,
    uploads: plan.uploads.map((upload) => ({ name: upload.name, size: upload.size })),
    uploadBytes: plan.uploadBytes,
    applied: false,
  };
  if (!confirm) return Object.freeze(summary);
  if (plan.alreadyCurrent && plan.uploads.length === 0) {
    return Object.freeze({ ...summary, applied: true, unchanged: true });
  }

  const releasesRoot = `${remoteRoot}/releases`;
  const incomingName = `.incoming-${plan.releaseId.slice(0, 12)}-${randomBytes(6).toString("hex")}`;
  let created = false;
  try {
    if (plan.uploads.length > 0) {
      const directory = await transport.makeIncomingDirectory({ releasesRoot, name: incomingName });
      created = true;
      for (const upload of plan.uploads) {
        await transport.upload({
          source: upload.source,
          destination: `${directory}/${upload.name}`,
          label: `upload ${upload.name}`,
        });
      }
    }
    const stdout = await transport.run({
      script: REMOTE_APPLY_SCRIPT,
      args: [remoteRoot],
      document: createApplyPayload(plan, incomingName),
      label: "remote release publication",
    });
    const result = parseReport(stdout, "remote release publication");
    if (result?.applied !== true || result.releaseId !== plan.releaseId) {
      fail("apply-failed", "the remote helper did not confirm the published release");
    }
    created = false;
    return Object.freeze({ ...summary, applied: true, unchanged: false });
  } finally {
    if (created) await transport.removeIncomingDirectory({ releasesRoot, name: incomingName });
  }
}

/* ------------------------------------------------------------------- CLI --- */

function help() {
  process.stdout.write(
    "Usage: ./revival pin release ship [--remote NAME | --local] [--remote-root PATH]\n" +
    "                                  [--release-root DIR] [--confirm] [--json]\n" +
    "\nCopies the release `pin release build` already published locally into the store\n" +
    "Center serves from, so the in-browser installer can reach it. Without --confirm it\n" +
    "reads both stores, prints the plan, and changes nothing. It never runs a deploy and\n" +
    "never touches a device.\n",
  );
}

function parseCli(argumentsList) {
  const values = { confirm: false, json: false, local: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--confirm") values.confirm = true;
    else if (argument === "--json") values.json = true;
    else if (argument === "--local") values.local = true;
    else if (argument === "--remote") values.remote = argumentsList[++index];
    else if (argument === "--remote-root") values.remoteRoot = argumentsList[++index];
    else if (argument === "--release-root") values.releaseRoot = argumentsList[++index];
    else fail("usage", `unknown ship option: ${argument ?? ""}`);
  }
  if (values.local && values.remote !== undefined) {
    fail("usage", "--local and --remote are mutually exclusive");
  }
  for (const [key, flag] of [
    ["remote", "--remote"],
    ["remoteRoot", "--remote-root"],
    ["releaseRoot", "--release-root"],
  ]) {
    if (Object.hasOwn(values, key) && (values[key] === undefined || String(values[key]).startsWith("--"))) {
      fail("usage", `${flag} requires a value`);
    }
  }
  return Object.freeze(values);
}

async function main(argumentsList) {
  if (argumentsList.length === 0 || ["help", "--help", "-h"].includes(argumentsList[0])) {
    help();
    return;
  }
  const command = argumentsList.shift();
  if (command !== "ship") fail("usage", "expected ship");
  if (argumentsList.length === 1 && ["help", "--help", "-h"].includes(argumentsList[0])) {
    help();
    return;
  }
  const options = parseCli(argumentsList);
  const releaseRoot = options.releaseRoot ?? defaultOperatorPaths().releaseRoot;
  if (!isAbsolute(releaseRoot)) fail("usage", "--release-root must be an absolute path");
  const transport = options.local
    ? createLocalTransport()
    : createSshTransport({ remote: options.remote ?? process.env.REVIVAL_DEPLOY_REMOTE ?? "vps" });
  const result = await shipPinRelease({
    releaseRoot,
    remoteRoot: options.remoteRoot ?? DEFAULT_REMOTE_RELEASE_ROOT,
    transport,
    confirm: options.confirm,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (!result.applied) {
    process.stdout.write(
      `[plan] ${result.releaseId} (${result.version}) -> ${result.target}:${result.remoteRoot}\n` +
      `[plan] ${result.uploads.length} file(s), ${result.uploadBytes} bytes; nothing was changed. Re-run with --confirm.\n`,
    );
    return;
  }
  process.stdout.write(
    result.unchanged
      ? `[implemented] ${result.releaseId} was already the current release on ${result.target}\n`
      : `[implemented] published ${result.releaseId} (${result.version}) to ${result.target}:${result.remoteRoot}\n`,
  );
}

if (resolve(process.argv[1] ?? "") === SELF_PATH) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pin-release-ship: ${message}\n`);
    process.exitCode = error?.code === "usage" ? 64 : 1;
  });
}
