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
 * into memory on either side — local hashing streams, transfer is a bounded
 * resumable `rsync`, and the remote helper hashes in 1 MiB chunks. A dropped
 * connection gets three attempts against the SAME path inside the transaction's
 * hidden incoming directory, so useful already-landed blocks are retained and
 * repaired between attempts. Artifact bytes never enter the ssh payload, and
 * nothing here is reachable from a Docker build context.
 *
 * Security boundary: the deployment account is the trusted writer for this
 * store. Nondumpable helpers keep transient keys and unnamed plaintext fds out
 * of argv/env and ordinary peer procfs access, while no-follow dirfds, statx
 * generations, content hashes, and atomic publication defeat hostile namespace
 * races outside that account. Linux offers an unprivileged process no exclusive
 * directory-name/ACK transaction against a continuously malicious process with
 * the same UID and write authority; such a peer is therefore inside the trusted
 * boundary and requires a dedicated deployment UID if it must be isolated.
 */

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { defaultOperatorPaths, reverifyPersistedHostedRelease } from "./build.mjs";
import {
  canonicalPinReleaseManifestJson,
  parseCanonicalPinReleaseManifestDocument,
  parsePinReleaseHistory,
  parsePinReleaseJson,
} from "./release.mjs";
import {
  OWN_CHILD_PROCESS_GROUP,
  terminateTrackedProcess,
  trackChildProcess,
  withTrackedDeadline,
} from "./bounded-process.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const FIXED_BASH = "/usr/bin/bash";
const FIXED_PYTHON = "/usr/bin/python3";
const FIXED_SSH = "/usr/bin/ssh";
const FIXED_RSYNC = "/usr/bin/rsync";

function positiveToolEnvironment() {
  const environment = {
    HOME: isAbsolute(process.env.HOME ?? "") ? process.env.HOME : "/nonexistent",
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  for (const name of ["USER", "LOGNAME", "SSH_AUTH_SOCK"]) {
    if (typeof process.env[name] === "string" && !process.env[name].includes("\0")) {
      environment[name] = process.env[name];
    }
  }
  return environment;
}

export const PIN_RELEASE_STORE_SCHEMA_VERSION = 1;
export const MAX_STORE_DOCUMENT_BYTES = 1024 * 1024;
export const MAX_REMOTE_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_FRAMED_DOCUMENT_BYTES = 8 * 1024 * 1024;
const READY_TIMEOUT_MILLISECONDS = 30_000;
const PROCESS_TIMEOUT_MILLISECONDS = 10 * 60_000;
const PROTECTED_OPERATION_TIMEOUT_MILLISECONDS = 45 * 60_000;
const RSYNC_TIMEOUT_MILLISECONDS = 45 * 60_000;
/** Matches the production bind-mount source in platform/compose/production.yaml. */
export const DEFAULT_REMOTE_RELEASE_ROOT = "/home/anders/ai-pin-revival/data/pin-releases";
export const PAYLOAD_DELIMITER = "__REVIVAL_PIN_SHIP_PAYLOAD__";
export const RSYNC_UPLOAD_ATTEMPTS = 3;
export const RSYNC_UPLOAD_OPTIONS = Object.freeze([
  "--quiet",
  "--checksum",
  "--partial",
  "--no-whole-file",
  "-s",
  "--no-perms",
  "--no-owner",
  "--no-group",
]);

const RELEASE_ID_RE = /^[0-9a-f]{64}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const REMOTE_NAME_RE = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+$/u;
const STORE_DOCUMENTS = Object.freeze(["history.json", "current.json"]);
const STAGING_COMPONENT_RE = /^[A-Za-z0-9._-]+$/u;

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
  if (manifest.schemaVersion !== 2 || manifest.authority === undefined) {
    fail(
      "hosted-attestation-required",
      `${label} current release is an evidence-free candidate and cannot enter the authoritative ship path`,
    );
  }
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

/** Exactly `manifest.json`, hosted evidence, and five APKs, all digest-pinned. */
function verifyReleaseEntries({ manifest, canonical, entries, label }) {
  const expected = new Map([
    ["manifest.json", { size: Buffer.byteLength(canonical), sha256: sha256(canonical) }],
    [manifest.authority.name, { size: manifest.authority.size, sha256: manifest.authority.sha256 }],
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

function parseFilesystemAuthority(value, label) {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "btime,dev,gid,ino,mntId,mode,uid" ||
    typeof value.dev !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value.dev) ||
    typeof value.ino !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value.ino) ||
    typeof value.mntId !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value.mntId) ||
    typeof value.btime !== "string" ||
    !/^(?:0|[1-9][0-9]*)\.[0-9]{9}$/u.test(value.btime) ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 0 ||
    !Number.isSafeInteger(value.gid) ||
    value.gid < 0 ||
    !Number.isSafeInteger(value.mode) ||
    value.mode < 0 ||
    value.mode > 0o7777
  ) {
    fail("report-invalid", `${label} filesystem authority is malformed`);
  }
  return Object.freeze({
    dev: value.dev,
    ino: value.ino,
    mntId: value.mntId,
    btime: value.btime,
    uid: value.uid,
    gid: value.gid,
    mode: value.mode,
  });
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
  const rootAuthority = parseFilesystemAuthority(report.rootAuthority, `${label} root`);
  let releasesAuthority = null;
  if (report.releasesState === "directory") {
    releasesAuthority = parseFilesystemAuthority(
      report.releasesAuthority,
      `${label} immutable releases directory`,
    );
  } else if (report.releasesState !== "missing" || report.releasesAuthority !== null) {
    fail("store-invalid", `${label} immutable releases path is not a real directory`);
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
  const releaseAuthorities = new Map();
  for (const [releaseId, value] of Object.entries(report.releases)) {
    if (!RELEASE_ID_RE.test(releaseId)) {
      fail("report-invalid", `${label} reported a release identifier that is not a digest`);
    }
    if (value === null) continue;
    if (!isRecord(value) || value.isDirectory !== true) {
      fail("store-invalid", `${label} release ${releaseId} is not a real directory`);
    }
    releaseAuthorities.set(
      releaseId,
      parseFilesystemAuthority(value.authority, `${label} release ${releaseId}`),
    );
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
    releaseAuthorities: Object.freeze(releaseAuthorities),
    authority: Object.freeze({ root: rootAuthority, releases: releasesAuthority }),
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
          Object.freeze({
            name: local.current.manifest.authority.name,
            size: local.current.manifest.authority.size,
            sha256: local.current.manifest.authority.sha256,
            source: join(local.releaseDirectory, local.current.manifest.authority.name),
          }),
        ])
      : Object.freeze([]);
  const entries = Object.freeze(
    [...local.entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, descriptor]) => Object.freeze({ name, ...descriptor })),
  );
  const authority = Object.freeze({
    root: remote.authority.root,
    releases: remote.authority.releases,
    retainedRelease: remote.releaseAuthorities.get(target.releaseId) ?? null,
  });

  return Object.freeze({
    schemaVersion: 1,
    releaseId: target.releaseId,
    version: target.version,
    versionCode: target.versionCode,
    manifestSha256: target.manifestSha256,
    /** True when the server already serves it; confirmation only replays pointer durability. */
    alreadyCurrent,
    uploads,
    entries,
    authority,
    uploadBytes: uploads.reduce((total, upload) => total + upload.size, 0),
    expectedHistorySha256: remote.historyDocument === null ? null : sha256(remote.historyDocument),
    expectedCurrentSha256: remote.current === null ? null : remote.current.sha256,
    historyDocument: local.historyDocument,
    currentDocument: local.current.canonical,
  });
}

export function createApplyPayload(plan, incomingName, authority = plan.authority) {
  return `${JSON.stringify({
    schemaVersion: 1,
    releaseId: plan.releaseId,
    incoming: plan.uploads.length === 0 ? null : incomingName,
    entries: plan.entries,
    authority,
    expectedHistorySha256: plan.expectedHistorySha256,
    expectedCurrentSha256: plan.expectedCurrentSha256,
    historyBase64: Buffer.from(plan.historyDocument, "utf8").toString("base64"),
    currentBase64: Buffer.from(plan.currentDocument, "utf8").toString("base64"),
  })}\n`;
}

/* ------------------------------------------------------- remote helpers --- */

const REMOTE_PRELUDE = `set -euo pipefail
umask 077
PATH=/usr/bin:/bin
export PATH
`;

/**
 * The staging boundary used before rsync and by cleanup.
 *
 * Every absolute directory component is opened relative to the previously
 * verified directory descriptor with O_DIRECTORY|O_NOFOLLOW. Creation and
 * recursive removal then use only dir-fd-relative operations. In particular,
 * cleanup never sends a pathname to a recursive shell remover: if the store
 * root or `releases` is replaced by a symlink, this helper refuses it rather
 * than traversing into the link target.
 */
export const REMOTE_STAGING_SCRIPT = `${REMOTE_PRELUDE}/usr/bin/python3 -I -B - "$@" <<'__REVIVAL_PIN_STAGING__'
import base64, ctypes, hashlib, hmac, json, os, re, stat, sys

COMPONENT = re.compile(r"^[A-Za-z0-9._-]+$")
os.umask(0o077)


def refuse(message):
    sys.stderr.write("pin-release-ship: " + message + "\\n")
    raise SystemExit(70)


try:
    _libc = ctypes.CDLL(None, use_errno=True)
    _prctl = _libc.prctl
    _prctl.restype = ctypes.c_int
except (AttributeError, OSError):
    refuse("host lacks required process nondumpability support")


def require_nondumpable():
    if _prctl(3, 0, 0, 0, 0) != 0:
        refuse("process lost its nondumpable plaintext boundary")


def read_framed_document(maximum, label):
    require_nondumpable()
    sys.stdout.write("READY\\n")
    sys.stdout.flush()
    length_line = sys.stdin.buffer.readline(33)
    if (
        not length_line.endswith(b"\\n")
        or len(length_line) <= 1
        or not length_line[:-1].isdigit()
        or (len(length_line) > 2 and length_line.startswith(b"0"))
    ):
        refuse(label + " length is malformed")
    length = int(length_line[:-1])
    if length > maximum:
        refuse(label + " exceeds its size bound")
    document = sys.stdin.buffer.read(length)
    if len(document) != length or sys.stdin.buffer.read(1) != b"":
        refuse(label + " framing is incomplete")
    require_nondumpable()
    return document


if _prctl(4, 0, 0, 0, 0) != 0:
    refuse("process cannot establish its nondumpable plaintext boundary")
require_nondumpable()


if (
    not hasattr(os, "O_DIRECTORY")
    or not hasattr(os, "O_NOFOLLOW")
    or not hasattr(os, "O_TMPFILE")
    or not os.path.isdir("/proc/self/fd")
):
    refuse("host lacks required unnamed-file or no-follow descriptor support")


DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
if hasattr(os, "O_CLOEXEC"):
    DIRECTORY_FLAGS |= os.O_CLOEXEC


def safe_component(value, label):
    if (
        not isinstance(value, str)
        or value in ("", ".", "..")
        or len(os.fsencode(value)) > 255
        or COMPONENT.fullmatch(value) is None
    ):
        refuse(label + " is not a safe path component")
    return value


def open_absolute_directory(path, label):
    if not isinstance(path, str) or not path.startswith("/") or os.path.normpath(path) != path:
        refuse(label + " is not a canonical absolute path")
    try:
        descriptor = os.open("/", DIRECTORY_FLAGS)
    except OSError:
        refuse("filesystem root cannot be opened without following links")
    try:
        for component in path.split("/")[1:]:
            try:
                child = os.open(component, DIRECTORY_FLAGS, dir_fd=descriptor)
            except OSError:
                refuse(label + " cannot be opened without following links")
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def linked_info(parent, name):
    try:
        return os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return None


def same_inode(left, right):
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)


class StatxTimestamp(ctypes.Structure):
    _fields_ = [
        ("seconds", ctypes.c_longlong),
        ("nanoseconds", ctypes.c_uint),
        ("reserved", ctypes.c_int),
    ]


class Statx(ctypes.Structure):
    _fields_ = [
        ("mask", ctypes.c_uint), ("block_size", ctypes.c_uint),
        ("attributes", ctypes.c_ulonglong), ("nlink", ctypes.c_uint),
        ("uid", ctypes.c_uint), ("gid", ctypes.c_uint),
        ("mode", ctypes.c_ushort), ("spare0", ctypes.c_ushort),
        ("ino", ctypes.c_ulonglong), ("size", ctypes.c_ulonglong),
        ("blocks", ctypes.c_ulonglong), ("attributes_mask", ctypes.c_ulonglong),
        ("atime", StatxTimestamp), ("btime", StatxTimestamp),
        ("ctime", StatxTimestamp), ("mtime", StatxTimestamp),
        ("rdev_major", ctypes.c_uint), ("rdev_minor", ctypes.c_uint),
        ("dev_major", ctypes.c_uint), ("dev_minor", ctypes.c_uint),
        ("mnt_id", ctypes.c_ulonglong), ("spare2", ctypes.c_ulonglong * 13),
    ]


try:
    _statx = _libc.statx
    _statx.argtypes = [
        ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.POINTER(Statx)
    ]
    _statx.restype = ctypes.c_int
except AttributeError:
    refuse("host lacks required statx generation support")


def identity(metadata, descriptor):
    generation = Statx()
    required = 0x800 | 0x1000
    if _statx(descriptor, b"", 0x1000 | 0x800, 0x7ff | required, ctypes.byref(generation)) != 0:
        refuse("filesystem authority generation cannot be read")
    if (
        generation.mask & required != required
        or generation.mnt_id == 0
        or (generation.btime.seconds == 0 and generation.btime.nanoseconds == 0)
        or generation.btime.nanoseconds >= 1000000000
        or generation.ino != metadata.st_ino
        or generation.uid != metadata.st_uid
        or generation.gid != metadata.st_gid
        or generation.mode != metadata.st_mode
        or generation.dev_major != os.major(metadata.st_dev)
        or generation.dev_minor != os.minor(metadata.st_dev)
    ):
        refuse("filesystem authority generation is unavailable or inconsistent")
    return {
        "dev": str(metadata.st_dev),
        "ino": str(metadata.st_ino),
        "mntId": str(generation.mnt_id),
        "btime": str(generation.btime.seconds) + "." + str(generation.btime.nanoseconds).zfill(9),
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
        "mode": stat.S_IMODE(metadata.st_mode),
    }


def require_identity(metadata, expected, label, descriptor):
    if not isinstance(expected, dict) or identity(metadata, descriptor) != expected:
        refuse(label + " differs from the inspected filesystem authority")


def open_named_directory(parent, name, label):
    linked = linked_info(parent, name)
    if linked is None or stat.S_ISLNK(linked.st_mode) or not stat.S_ISDIR(linked.st_mode):
        refuse(label + " is not a real directory")
    try:
        descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=parent)
    except OSError:
        refuse(label + " cannot be opened without following links")
    opened = os.fstat(descriptor)
    if not stat.S_ISDIR(opened.st_mode) or not same_inode(linked, opened):
        os.close(descriptor)
        refuse(label + " changed while it was opened")
    return descriptor


def open_releases_directory(path, create, expected):
    parent_path, name = os.path.split(path)
    if name != "releases" or parent_path in ("", "/"):
        refuse("immutable releases directory has an unexpected path")
    parent = open_absolute_directory(parent_path, "release store root")
    try:
        require_identity(os.fstat(parent), expected.get("root"), "release store root", parent)
        existing = linked_info(parent, name)
        expected_releases = expected.get("releases")
        if existing is None:
            if not create:
                refuse("immutable releases directory is missing")
            if expected_releases is not None:
                refuse("immutable releases directory disappeared after inspection")
            try:
                os.mkdir(name, 0o700, dir_fd=parent)
            except OSError:
                refuse("immutable releases directory cannot be created safely")
            os.fsync(parent)
        elif expected_releases is None:
            refuse("immutable releases directory appeared after inspection")
        descriptor = open_named_directory(parent, name, "immutable releases directory")
        if expected_releases is not None:
            require_identity(
                os.fstat(descriptor), expected_releases, "immutable releases directory", descriptor
            )
        return descriptor, identity(os.fstat(parent), parent)
    finally:
        os.close(parent)


def require_mode(metadata, expected, label):
    if stat.S_IMODE(metadata.st_mode) != expected:
        refuse(label + " has unsafe permissions")


def validate_upload_target(releases, incoming_name, filename, expected_target):
    incoming = open_named_directory(releases, incoming_name, "incoming release directory")
    try:
        require_mode(os.fstat(incoming), 0o700, "incoming release directory")
        # Re-prove the name after open so a concurrent rename cannot make this
        # check bless a descriptor different from the pathname rsync will use.
        linked = linked_info(releases, incoming_name)
        if linked is None or not same_inode(linked, os.fstat(incoming)):
            refuse("incoming release directory changed before upload")

        target = linked_info(incoming, filename)
        if expected_target is None:
            if target is not None:
                refuse("upload target appeared before atomic publication")
            return
        if target is None:
            refuse("retained upload target is missing")
        if stat.S_ISLNK(target.st_mode) or not stat.S_ISREG(target.st_mode) or target.st_nlink != 1:
            refuse("retained upload target is not one regular file")
        flags = os.O_RDONLY | os.O_NOFOLLOW
        if hasattr(os, "O_CLOEXEC"):
            flags |= os.O_CLOEXEC
        try:
            target_fd = os.open(filename, flags, dir_fd=incoming)
        except OSError:
            refuse("retained upload target cannot be opened without following links")
        try:
            opened = os.fstat(target_fd)
            if not same_inode(target, opened):
                refuse("retained upload target changed while it was opened")
            require_mode(opened, 0o600, "retained upload target")
            require_identity(opened, expected_target, "retained upload target", target_fd)
        finally:
            os.close(target_fd)
    finally:
        os.close(incoming)


def claim_upload_target(
    releases,
    incoming_name,
    filename,
    sealed_name,
    expected_size,
    expected_sha256,
    resume_key,
):
    incoming = open_named_directory(releases, incoming_name, "incoming release directory")
    try:
        target = linked_info(incoming, filename)
        if target is None:
            if (
                not hasattr(os, "O_TMPFILE")
                or not os.path.isdir("/proc/self/fd")
            ):
                refuse("host lacks required unnamed-file publication support")
            sealed = linked_info(incoming, sealed_name)
            if (
                sealed is None
                or stat.S_ISLNK(sealed.st_mode)
                or not stat.S_ISREG(sealed.st_mode)
                or sealed.st_nlink != 1
                or stat.S_IMODE(sealed.st_mode) != 0o600
            ):
                refuse("encrypted rsync result is not one mode-0600 file")
            read_flags = os.O_RDONLY | os.O_NOFOLLOW
            work_flags = os.O_RDWR | os.O_TMPFILE
            if hasattr(os, "O_CLOEXEC"):
                read_flags |= os.O_CLOEXEC
                work_flags |= os.O_CLOEXEC
            checkpoint = os.open(sealed_name, read_flags, dir_fd=incoming)
            require_nondumpable()
            work = os.open(".", work_flags, 0o600, dir_fd=incoming)
            try:
                opened_sealed = os.fstat(checkpoint)
                opened_work = os.fstat(work)
                if (
                    opened_sealed.st_nlink != 1
                    or not same_inode(sealed, opened_sealed)
                    or not stat.S_ISREG(opened_work.st_mode)
                    or opened_work.st_nlink != 0
                ):
                    refuse("encrypted rsync result changed while it was opened")
                magic = b"PINRESUME1\\x00"
                header_size = len(magic) + 16 + 8
                header = os.pread(checkpoint, header_size, 0)
                if (
                    len(header) != header_size
                    or not hmac.compare_digest(header[:len(magic)], magic)
                    or int.from_bytes(header[-8:], "big") != expected_size
                    or opened_sealed.st_size != header_size + expected_size + 32
                ):
                    refuse("encrypted rsync result is incomplete")
                nonce = header[len(magic):len(magic) + 16]
                verifier = hmac.new(resume_key, header, hashlib.sha256)
                digest = hashlib.sha256()
                position = 0
                index = 0
                while position < expected_size:
                    cipher = os.pread(
                        checkpoint,
                        min(1024 * 1024, expected_size - position),
                        header_size + position,
                    )
                    if not cipher:
                        refuse("encrypted rsync result became short")
                    verifier.update(cipher)
                    mask = hashlib.shake_256(
                        b"revival-pin-resume-stream\\x00"
                        + resume_key
                        + nonce
                        + index.to_bytes(8, "big")
                    ).digest(len(cipher))
                    plain = (
                        int.from_bytes(cipher, "little") ^ int.from_bytes(mask, "little")
                    ).to_bytes(len(cipher), "little")
                    digest.update(plain)
                    written = 0
                    while written < len(plain):
                        require_nondumpable()
                        count = os.pwrite(work, plain[written:], position + written)
                        if not isinstance(count, int) or count <= 0:
                            raise OSError("unnamed upload write made no progress")
                        written += count
                    position += len(cipher)
                    index += 1
                tag = os.pread(checkpoint, 32, header_size + expected_size)
                if (
                    not hmac.compare_digest(verifier.digest(), tag)
                    or digest.hexdigest() != expected_sha256
                ):
                    refuse("encrypted rsync result fails its pinned digest")
                linked_sealed = linked_info(incoming, sealed_name)
                if (
                    linked_sealed is None
                    or linked_sealed.st_nlink != 1
                    or os.fstat(checkpoint).st_nlink != 1
                    or not same_inode(linked_sealed, opened_sealed)
                ):
                    refuse("encrypted rsync result changed during authentication")
                os.ftruncate(work, expected_size)
                os.fchmod(work, 0o600)
                os.fsync(work)
                if os.fstat(work).st_nlink != 0 or linked_info(incoming, filename) is not None:
                    refuse("upload target appeared before no-overwrite publication")
                require_nondumpable()
                try:
                    os.link(
                        "/proc/self/fd/" + str(work),
                        filename,
                        dst_dir_fd=incoming,
                        follow_symlinks=True,
                    )
                except OSError:
                    refuse("upload target cannot be linked atomically without replacement")
                published = linked_info(incoming, filename)
                if (
                    published is None
                    or published.st_nlink != 1
                    or os.fstat(work).st_nlink != 1
                    or not same_inode(published, os.fstat(work))
                ):
                    refuse("upload target changed during atomic linking")
                os.fsync(incoming)
            finally:
                os.close(work)
                os.close(checkpoint)

        target = linked_info(incoming, filename)
        if (
            target is None
            or stat.S_ISLNK(target.st_mode)
            or not stat.S_ISREG(target.st_mode)
            or target.st_nlink != 1
            or stat.S_IMODE(target.st_mode) != 0o600
        ):
            refuse("published upload target is not one mode-0600 file")
        flags = os.O_RDONLY | os.O_NOFOLLOW
        if hasattr(os, "O_CLOEXEC"):
            flags |= os.O_CLOEXEC
        descriptor = os.open(filename, flags, dir_fd=incoming)
        try:
            opened = os.fstat(descriptor)
            if opened.st_nlink != 1 or not same_inode(target, opened):
                refuse("published upload target changed while it was opened")
            digest = hashlib.sha256()
            size = 0
            while True:
                chunk = os.read(descriptor, 1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                digest.update(chunk)
            linked = linked_info(incoming, filename)
            if linked is None or linked.st_nlink != 1 or not same_inode(linked, opened):
                refuse("published upload target changed while it was claimed")
            if size != expected_size or digest.hexdigest() != expected_sha256:
                refuse("published upload target differs from its content authority")
            sealed = linked_info(incoming, sealed_name)
            if sealed is not None:
                if stat.S_ISLNK(sealed.st_mode) or not stat.S_ISREG(sealed.st_mode):
                    refuse("encrypted rsync checkpoint changed before cleanup")
                os.unlink(sealed_name, dir_fd=incoming)
                os.fsync(incoming)
            sys.stdout.write(json.dumps(identity(opened, descriptor), sort_keys=True, separators=(",", ":")) + "\\n")
        finally:
            os.close(descriptor)
    finally:
        os.close(incoming)


def remove_contents(directory):
    for name in os.listdir(directory):
        metadata = linked_info(directory, name)
        if metadata is None:
            continue
        if stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode):
            child = open_named_directory(directory, name, "staged child directory")
            opened = os.fstat(child)
            try:
                remove_contents(child)
                os.fsync(child)
            finally:
                os.close(child)
            linked = linked_info(directory, name)
            if linked is None:
                continue
            if not same_inode(linked, opened):
                refuse("staged child directory changed during cleanup")
            os.rmdir(name, dir_fd=directory)
        else:
            # unlinkat relative to the held directory does not follow a leaf
            # symlink, so even an unexpected rsync temporary stays confined.
            try:
                os.unlink(name, dir_fd=directory)
            except FileNotFoundError:
                pass


if len(sys.argv) != 5:
    refuse("staging helper arguments are incomplete")
action = sys.argv[1]
releases_path = sys.argv[2]
incoming_name = safe_component(sys.argv[3], "incoming directory name")
if not incoming_name.startswith(".incoming-"):
    refuse("incoming directory name is outside the transaction namespace")
try:
    expected = json.loads(base64.b64decode(sys.argv[4], validate=True).decode("utf-8"))
except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
    refuse("staging filesystem authority is malformed")
if not isinstance(expected, dict):
    refuse("staging filesystem authority has an unexpected shape")

releases, root_identity = open_releases_directory(releases_path, action == "create", expected)
try:
    if action == "create":
        if linked_info(releases, incoming_name) is not None:
            refuse("incoming release directory already exists")
        try:
            os.mkdir(incoming_name, 0o700, dir_fd=releases)
        except OSError:
            refuse("incoming release directory cannot be created safely")
        incoming = open_named_directory(releases, incoming_name, "incoming release directory")
        targets = {}
        incoming_identity = None
        try:
            os.fchmod(incoming, 0o700)
            filenames = expected.get("filenames")
            if (
                not isinstance(filenames, list)
                or len(filenames) == 0
                or len(set(filenames)) != len(filenames)
            ):
                refuse("incoming target inventory is malformed")
            for filename in filenames:
                filename = safe_component(filename, "upload filename")
                targets[filename] = None
            os.fsync(incoming)
            incoming_identity = identity(os.fstat(incoming), incoming)
        finally:
            os.close(incoming)
        os.fsync(releases)
        sys.stdout.write(json.dumps({
            "root": root_identity,
            "releases": identity(os.fstat(releases), releases),
            "incoming": incoming_identity,
            "targets": targets,
        }, sort_keys=True, separators=(",", ":")) + "\\n")
    elif action == "validate":
        filename = safe_component(expected.get("filename"), "upload filename")
        require_identity(os.fstat(releases), expected.get("releases"), "immutable releases directory", releases)
        incoming = open_named_directory(releases, incoming_name, "incoming release directory")
        try:
            require_identity(os.fstat(incoming), expected.get("incoming"), "incoming release directory", incoming)
        finally:
            os.close(incoming)
        targets = expected.get("targets")
        if not isinstance(targets, dict) or filename not in targets:
            refuse("upload target authority is missing")
        validate_upload_target(releases, incoming_name, filename, targets[filename])
    elif action == "claim":
        filename = safe_component(expected.get("filename"), "upload filename")
        sealed_name = safe_component(expected.get("sealedName"), "encrypted rsync filename")
        expected_size = expected.get("size")
        expected_sha256 = expected.get("sha256")
        try:
            resume_key = bytes.fromhex(
                read_framed_document(64, "upload resume authority").decode("ascii")
            )
        except (UnicodeDecodeError, ValueError):
            refuse("upload resume authority is malformed")
        process_metadata = (
            open("/proc/self/cmdline", "rb").read()
            + b"\\x00".join(
                os.fsencode(key) + b"=" + os.fsencode(value)
                for key, value in os.environ.items()
            )
        )
        if resume_key.hex().encode("ascii") in process_metadata:
            refuse("upload resume authority escaped into process metadata")
        canonical_sealed = (
            ".sealed-" + hashlib.sha256(filename.encode("utf-8")).hexdigest()[:16] + ".resume"
        )
        if (
            not isinstance(expected_size, int)
            or isinstance(expected_size, bool)
            or expected_size < 0
            or not isinstance(expected_sha256, str)
            or re.fullmatch(r"[0-9a-f]{64}", expected_sha256) is None
            or len(resume_key) != 32
            or sealed_name != canonical_sealed
        ):
            refuse("upload content authority is malformed")
        require_identity(os.fstat(releases), expected.get("releases"), "immutable releases directory", releases)
        incoming = open_named_directory(releases, incoming_name, "incoming release directory")
        try:
            require_identity(os.fstat(incoming), expected.get("incoming"), "incoming release directory", incoming)
        finally:
            os.close(incoming)
        targets = expected.get("targets")
        if not isinstance(targets, dict) or targets.get(filename, False) is not None:
            refuse("upload target is not authorized for one no-overwrite publication")
        claim_upload_target(
            releases,
            incoming_name,
            filename,
            sealed_name,
            expected_size,
            expected_sha256,
            resume_key,
        )
    elif action == "remove":
        require_identity(os.fstat(releases), expected.get("releases"), "immutable releases directory", releases)
        metadata = linked_info(releases, incoming_name)
        if metadata is not None:
            incoming = open_named_directory(releases, incoming_name, "incoming release directory")
            require_identity(os.fstat(incoming), expected.get("incoming"), "incoming release directory", incoming)
            opened = os.fstat(incoming)
            try:
                remove_contents(incoming)
                os.fsync(incoming)
            finally:
                os.close(incoming)
            linked = linked_info(releases, incoming_name)
            if linked is None:
                pass
            elif not same_inode(linked, opened):
                refuse("incoming release directory changed during cleanup")
            else:
                os.rmdir(incoming_name, dir_fd=releases)
                os.fsync(releases)
    else:
        refuse("unknown staging helper action")
finally:
    os.close(releases)
__REVIVAL_PIN_STAGING__
`;

/** The `--local` equivalent of the remote receiver: one held-fd operation. */
export const LOCAL_UPLOAD_SCRIPT = `${REMOTE_PRELUDE}/usr/bin/python3 -I -B - "$@" <<'__REVIVAL_PIN_LOCAL_UPLOAD__'
import base64, ctypes, hashlib, hmac, json, os, re, secrets, stat, sys

CHUNK = 1024 * 1024
MAGIC = b"PINRESUME1\\x00"
os.umask(0o077)
COMPONENT = re.compile(r"^[A-Za-z0-9._-]+$")


def refuse(message):
    sys.stderr.write("pin-release-ship: " + message + "\\n")
    raise SystemExit(70)


try:
    _libc = ctypes.CDLL(None, use_errno=True)
    _prctl = _libc.prctl
    _prctl.restype = ctypes.c_int
except (AttributeError, OSError):
    refuse("host lacks required process nondumpability support")


def require_nondumpable():
    if _prctl(3, 0, 0, 0, 0) != 0:
        refuse("process lost its nondumpable plaintext boundary")


def read_framed_document(maximum, label):
    require_nondumpable()
    sys.stdout.write("READY\\n")
    sys.stdout.flush()
    length_line = sys.stdin.buffer.readline(33)
    if (
        not length_line.endswith(b"\\n")
        or len(length_line) <= 1
        or not length_line[:-1].isdigit()
        or (len(length_line) > 2 and length_line.startswith(b"0"))
    ):
        refuse(label + " length is malformed")
    length = int(length_line[:-1])
    if length > maximum:
        refuse(label + " exceeds its size bound")
    document = sys.stdin.buffer.read(length)
    if len(document) != length or sys.stdin.buffer.read(1) != b"":
        refuse(label + " framing is incomplete")
    require_nondumpable()
    return document


if _prctl(4, 0, 0, 0, 0) != 0:
    refuse("process cannot establish its nondumpable plaintext boundary")
require_nondumpable()


if (
    not hasattr(os, "O_DIRECTORY")
    or not hasattr(os, "O_NOFOLLOW")
    or not hasattr(os, "O_TMPFILE")
    or not os.path.isdir("/proc/self/fd")
):
    refuse("host lacks required unnamed-file or no-follow descriptor support")


DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
if hasattr(os, "O_CLOEXEC"):
    DIRECTORY_FLAGS |= os.O_CLOEXEC


def safe_component(value, label):
    if (
        not isinstance(value, str)
        or value in ("", ".", "..")
        or len(os.fsencode(value)) > 255
        or COMPONENT.fullmatch(value) is None
    ):
        refuse(label + " is not a safe path component")
    return value


def same_inode(left, right):
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)


class StatxTimestamp(ctypes.Structure):
    _fields_ = [
        ("seconds", ctypes.c_longlong),
        ("nanoseconds", ctypes.c_uint),
        ("reserved", ctypes.c_int),
    ]


class Statx(ctypes.Structure):
    _fields_ = [
        ("mask", ctypes.c_uint), ("block_size", ctypes.c_uint),
        ("attributes", ctypes.c_ulonglong), ("nlink", ctypes.c_uint),
        ("uid", ctypes.c_uint), ("gid", ctypes.c_uint),
        ("mode", ctypes.c_ushort), ("spare0", ctypes.c_ushort),
        ("ino", ctypes.c_ulonglong), ("size", ctypes.c_ulonglong),
        ("blocks", ctypes.c_ulonglong), ("attributes_mask", ctypes.c_ulonglong),
        ("atime", StatxTimestamp), ("btime", StatxTimestamp),
        ("ctime", StatxTimestamp), ("mtime", StatxTimestamp),
        ("rdev_major", ctypes.c_uint), ("rdev_minor", ctypes.c_uint),
        ("dev_major", ctypes.c_uint), ("dev_minor", ctypes.c_uint),
        ("mnt_id", ctypes.c_ulonglong), ("spare2", ctypes.c_ulonglong * 13),
    ]


try:
    _statx = _libc.statx
    _statx.argtypes = [
        ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.POINTER(Statx)
    ]
    _statx.restype = ctypes.c_int
except AttributeError:
    refuse("host lacks required statx generation support")


def identity(metadata, descriptor):
    generation = Statx()
    required = 0x800 | 0x1000
    if _statx(descriptor, b"", 0x1000 | 0x800, 0x7ff | required, ctypes.byref(generation)) != 0:
        refuse("filesystem authority generation cannot be read")
    if (
        generation.mask & required != required
        or generation.mnt_id == 0
        or (generation.btime.seconds == 0 and generation.btime.nanoseconds == 0)
        or generation.btime.nanoseconds >= 1000000000
        or generation.ino != metadata.st_ino
        or generation.uid != metadata.st_uid
        or generation.gid != metadata.st_gid
        or generation.mode != metadata.st_mode
        or generation.dev_major != os.major(metadata.st_dev)
        or generation.dev_minor != os.minor(metadata.st_dev)
    ):
        refuse("filesystem authority generation is unavailable or inconsistent")
    return {
        "dev": str(metadata.st_dev),
        "ino": str(metadata.st_ino),
        "mntId": str(generation.mnt_id),
        "btime": str(generation.btime.seconds) + "." + str(generation.btime.nanoseconds).zfill(9),
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
        "mode": stat.S_IMODE(metadata.st_mode),
    }


def require_identity(metadata, expected, label, descriptor):
    if not isinstance(expected, dict) or identity(metadata, descriptor) != expected:
        refuse(label + " differs from the staged filesystem authority")


def linked_info(parent, name):
    try:
        return os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return None


def open_absolute_directory(path, label):
    if not isinstance(path, str) or not path.startswith("/") or os.path.normpath(path) != path:
        refuse(label + " is not a canonical absolute path")
    descriptor = os.open("/", DIRECTORY_FLAGS)
    try:
        for component in path.split("/")[1:]:
            try:
                child = os.open(component, DIRECTORY_FLAGS, dir_fd=descriptor)
            except OSError:
                refuse(label + " cannot be opened without following links")
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def open_named_directory(parent, name, label):
    linked = linked_info(parent, name)
    if linked is None or stat.S_ISLNK(linked.st_mode) or not stat.S_ISDIR(linked.st_mode):
        refuse(label + " is not a real directory")
    descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=parent)
    opened = os.fstat(descriptor)
    if not same_inode(linked, opened):
        os.close(descriptor)
        refuse(label + " changed while it was opened")
    return descriptor


def write_at(descriptor, data, offset):
    view = memoryview(data)
    written = 0
    while written < len(view):
        require_nondumpable()
        count = os.pwrite(descriptor, view[written:], offset + written)
        if not isinstance(count, int) or count <= 0:
            raise OSError("local upload write made no progress")
        written += count


def open_tmpfile(directory, label):
    require_nondumpable()
    flags = os.O_RDWR | os.O_TMPFILE
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    try:
        descriptor = os.open(".", flags, 0o600, dir_fd=directory)
    except OSError:
        refuse(label + " cannot create an unnamed staging inode")
    opened = os.fstat(descriptor)
    if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 0:
        os.close(descriptor)
        refuse(label + " did not create one unnamed regular inode")
    return descriptor


def link_tmpfile(descriptor, directory, name, label):
    require_nondumpable()
    if os.fstat(descriptor).st_nlink != 0 or linked_info(directory, name) is not None:
        refuse(label + " is no longer an unlinked no-overwrite publication")
    try:
        os.link(
            "/proc/self/fd/" + str(descriptor),
            name,
            dst_dir_fd=directory,
            follow_symlinks=True,
        )
    except OSError:
        refuse(label + " cannot be linked atomically without replacement")
    linked = linked_info(directory, name)
    opened = os.fstat(descriptor)
    if linked is None or linked.st_nlink != 1 or opened.st_nlink != 1 or not same_inode(linked, opened):
        refuse(label + " changed during atomic linking")


def xor_chunk(data, key, nonce, index):
    mask = hashlib.shake_256(
        b"revival-pin-resume-stream\\x00" + key + nonce + index.to_bytes(8, "big")
    ).digest(len(data))
    return (
        int.from_bytes(data, "little") ^ int.from_bytes(mask, "little")
    ).to_bytes(len(data), "little")


def load_checkpoint(directory, name, key, target):
    metadata = linked_info(directory, name)
    if (
        metadata is None
        or stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or stat.S_IMODE(metadata.st_mode) != 0o600
    ):
        return 0
    flags = os.O_RDONLY | os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    try:
        checkpoint = os.open(name, flags, dir_fd=directory)
    except OSError:
        return 0
    try:
        opened = os.fstat(checkpoint)
        if opened.st_nlink != 1 or not same_inode(metadata, opened):
            return 0
        header_size = len(MAGIC) + 16 + 8
        header = os.pread(checkpoint, header_size, 0)
        if len(header) != header_size or not hmac.compare_digest(header[:len(MAGIC)], MAGIC):
            return 0
        nonce = header[len(MAGIC):len(MAGIC) + 16]
        size = int.from_bytes(header[-8:], "big")
        if size > expected_size or os.fstat(checkpoint).st_size != header_size + size + 32:
            return 0
        verifier = hmac.new(key, header, hashlib.sha256)
        position = 0
        index = 0
        while position < size:
            cipher = os.pread(checkpoint, min(CHUNK, size - position), header_size + position)
            if not cipher:
                os.ftruncate(target, 0)
                return 0
            verifier.update(cipher)
            write_at(target, xor_chunk(cipher, key, nonce, index), position)
            position += len(cipher)
            index += 1
        tag = os.pread(checkpoint, 32, header_size + size)
        if not hmac.compare_digest(verifier.digest(), tag):
            os.ftruncate(target, 0)
            return 0
        linked = linked_info(directory, name)
        if linked is None or linked.st_nlink != 1 or not same_inode(linked, opened):
            os.ftruncate(target, 0)
            return 0
        os.ftruncate(target, size)
        return size
    finally:
        os.close(checkpoint)


def seal_checkpoint(directory, name, key, source):
    source_info = os.fstat(source)
    if source_info.st_nlink != 0 or source_info.st_size <= 0 or source_info.st_size > expected_size:
        return
    checkpoint = open_tmpfile(directory, "encrypted resume checkpoint")
    temporary = "." + name + "." + secrets.token_hex(8) + ".tmp"
    try:
        nonce = secrets.token_bytes(16)
        header = MAGIC + nonce + source_info.st_size.to_bytes(8, "big")
        verifier = hmac.new(key, header, hashlib.sha256)
        write_at(checkpoint, header, 0)
        position = 0
        index = 0
        while position < source_info.st_size:
            plain = os.pread(source, min(CHUNK, source_info.st_size - position), position)
            if not plain:
                raise OSError("resume source became short")
            cipher = xor_chunk(plain, key, nonce, index)
            verifier.update(cipher)
            write_at(checkpoint, cipher, len(header) + position)
            position += len(plain)
            index += 1
        write_at(checkpoint, verifier.digest(), len(header) + source_info.st_size)
        os.ftruncate(checkpoint, len(header) + source_info.st_size + 32)
        os.fchmod(checkpoint, 0o600)
        os.fsync(checkpoint)
        link_tmpfile(checkpoint, directory, temporary, "encrypted resume checkpoint")
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        temporary = None
        os.fsync(directory)
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass
        os.close(checkpoint)


def digest_fd(descriptor):
    digest = hashlib.sha256()
    size = os.fstat(descriptor).st_size
    position = 0
    while position < size:
        chunk = os.pread(descriptor, min(CHUNK, size - position), position)
        if not chunk:
            refuse("upload inode became short")
        digest.update(chunk)
        position += len(chunk)
    return size, digest.hexdigest()


def claim_existing_target(directory):
    linked = linked_info(directory, filename)
    if linked is None:
        return None
    if stat.S_ISLNK(linked.st_mode) or not stat.S_ISREG(linked.st_mode) or linked.st_nlink != 1:
        refuse("published upload target is not one regular file")
    flags = os.O_RDONLY | os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    target = os.open(filename, flags, dir_fd=directory)
    try:
        opened = os.fstat(target)
        if (
            not same_inode(linked, opened)
            or opened.st_nlink != 1
            or stat.S_IMODE(opened.st_mode) != 0o600
            or digest_fd(target) != (expected_size, expected_sha256)
        ):
            refuse("published upload target differs from its content authority")
        linked = linked_info(directory, filename)
        if linked is None or linked.st_nlink != 1 or not same_inode(linked, opened):
            refuse("published upload target changed while it was claimed")
        return identity(opened, target)
    finally:
        os.close(target)


if len(sys.argv) != 8:
    refuse("local upload arguments are incomplete")
source_path, releases_path = sys.argv[1:3]
incoming_name = safe_component(sys.argv[3], "incoming directory name")
filename = safe_component(sys.argv[4], "upload filename")
try:
    expected_size = int(sys.argv[5])
except ValueError:
    refuse("local upload size is malformed")
expected_sha256 = sys.argv[6]
try:
    filesystem_authority = json.loads(
        base64.b64decode(sys.argv[7], validate=True).decode("utf-8")
    )
    resume_key = bytes.fromhex(
        read_framed_document(64, "local upload resume authority").decode("ascii")
    )
except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
    refuse("local upload authority is malformed")
process_metadata = (
    open("/proc/self/cmdline", "rb").read()
    + b"\\x00".join(
        os.fsencode(name) + b"=" + os.fsencode(value)
        for name, value in os.environ.items()
    )
)
if resume_key.hex().encode("ascii") in process_metadata:
    refuse("local upload resume authority escaped into process metadata")
if (
    expected_size < 0
    or re.fullmatch(r"[0-9a-f]{64}", expected_sha256) is None
    or len(resume_key) != 32
):
    refuse("local upload content authority is malformed")
sealed_name = ".sealed-" + hashlib.sha256(filename.encode("utf-8")).hexdigest()[:16] + ".resume"

source_flags = os.O_RDONLY | os.O_NOFOLLOW
if hasattr(os, "O_CLOEXEC"):
    source_flags |= os.O_CLOEXEC
source = os.open(source_path, source_flags)
try:
    source_info = os.fstat(source)
    if not stat.S_ISREG(source_info.st_mode) or source_info.st_size != expected_size:
        refuse("local upload source differs from its size authority")

    parent_path, releases_name = os.path.split(releases_path)
    if releases_name != "releases":
        refuse("immutable releases directory has an unexpected path")
    root = open_absolute_directory(parent_path, "release store root")
    try:
        require_identity(os.fstat(root), filesystem_authority.get("root"), "release store root", root)
        releases = open_named_directory(root, releases_name, "immutable releases directory")
    except BaseException:
        os.close(root)
        raise
    try:
        require_identity(
            os.fstat(releases), filesystem_authority.get("releases"), "immutable releases directory", releases
        )
        incoming = open_named_directory(releases, incoming_name, "incoming release directory")
    except BaseException:
        os.close(releases)
        os.close(root)
        raise
    try:
        require_identity(os.fstat(incoming), filesystem_authority.get("incoming"), "incoming release directory", incoming)
        target_authorities = filesystem_authority.get("targets")
        if not isinstance(target_authorities, dict) or target_authorities.get(filename, False) is not None:
            refuse("local upload target is not authorized for one no-overwrite publication")
        existing = claim_existing_target(incoming)
        if existing is not None:
            try:
                os.unlink(sealed_name, dir_fd=incoming)
                os.fsync(incoming)
            except FileNotFoundError:
                pass
            sys.stdout.write(json.dumps(existing, sort_keys=True, separators=(",", ":")) + "\\n")
        else:
            work = open_tmpfile(incoming, "local upload")
            try:
                offset = load_checkpoint(incoming, sealed_name, resume_key, work)
                position = 0
                while position < offset:
                    count = min(CHUNK, offset - position)
                    if os.pread(source, count, position) != os.pread(work, count, position):
                        offset = 0
                        os.ftruncate(work, 0)
                        break
                    position += count
                try:
                    position = offset
                    while position < expected_size:
                        chunk = os.pread(source, min(CHUNK, expected_size - position), position)
                        if not chunk:
                            refuse("local upload source became short")
                        write_at(work, chunk, position)
                        position += len(chunk)
                    os.ftruncate(work, expected_size)
                    os.fchmod(work, 0o600)
                    os.fsync(work)
                    if digest_fd(work) != (expected_size, expected_sha256):
                        refuse("local upload differs from its content authority")
                    if os.fstat(work).st_nlink != 0:
                        refuse("local upload inode became externally linked during mutation")
                    link_tmpfile(work, incoming, filename, "local upload target")
                    os.fsync(incoming)
                except BaseException:
                    try:
                        seal_checkpoint(incoming, sealed_name, resume_key, work)
                    except BaseException:
                        pass
                    raise
                try:
                    os.unlink(sealed_name, dir_fd=incoming)
                    os.fsync(incoming)
                except FileNotFoundError:
                    pass
                published = claim_existing_target(incoming)
                if published is None:
                    refuse("local upload target disappeared after publication")
                sys.stdout.write(json.dumps(published, sort_keys=True, separators=(",", ":")) + "\\n")
            finally:
                os.close(work)
    finally:
        os.close(incoming)
        os.close(releases)
        os.close(root)
finally:
    os.close(source)
__REVIVAL_PIN_LOCAL_UPLOAD__
`;

/*
 * rsync's resumable pathname is deliberately ciphertext.  A peer that can
 * add hardlinks in the incoming directory can therefore observe or export a
 * receiver inode while rsync is mutating it without exporting any APK bytes.
 * The far-side claim helper authenticates this envelope and decrypts only into
 * an unnamed O_TMPFILE before the final no-overwrite link.
 */
const LOCAL_SEAL_UPLOAD_SCRIPT = `${REMOTE_PRELUDE}/usr/bin/python3 -I -B - "$@" <<'__REVIVAL_PIN_SEAL_UPLOAD__'
import ctypes, hashlib, hmac, os, re, secrets, stat, sys

CHUNK = 1024 * 1024
MAGIC = b"PINRESUME1\\x00"
os.umask(0o077)


def refuse(message):
    sys.stderr.write("pin-release-ship: " + message + "\\n")
    raise SystemExit(70)


try:
    _libc = ctypes.CDLL(None, use_errno=True)
    _prctl = _libc.prctl
    _prctl.restype = ctypes.c_int
except (AttributeError, OSError):
    refuse("host lacks required process nondumpability support")


def require_nondumpable():
    if _prctl(3, 0, 0, 0, 0) != 0:
        refuse("process lost its nondumpable secret boundary")


def read_framed_document(maximum, label):
    require_nondumpable()
    sys.stdout.write("READY\\n")
    sys.stdout.flush()
    length_line = sys.stdin.buffer.readline(33)
    if (
        not length_line.endswith(b"\\n")
        or len(length_line) <= 1
        or not length_line[:-1].isdigit()
        or (len(length_line) > 2 and length_line.startswith(b"0"))
    ):
        refuse(label + " length is malformed")
    length = int(length_line[:-1])
    if length > maximum:
        refuse(label + " exceeds its size bound")
    document = sys.stdin.buffer.read(length)
    if len(document) != length or sys.stdin.buffer.read(1) != b"":
        refuse(label + " framing is incomplete")
    require_nondumpable()
    return document


if _prctl(4, 0, 0, 0, 0) != 0:
    refuse("process cannot establish its nondumpable secret boundary")
require_nondumpable()


def write_all(descriptor, data):
    view = memoryview(data)
    offset = 0
    while offset < len(view):
        count = os.write(descriptor, view[offset:])
        if not isinstance(count, int) or count <= 0:
            raise OSError("encrypted upload write made no progress")
        offset += count


def xor_chunk(data, key, nonce, index):
    mask = hashlib.shake_256(
        b"revival-pin-resume-stream\\x00" + key + nonce + index.to_bytes(8, "big")
    ).digest(len(data))
    return (
        int.from_bytes(data, "little") ^ int.from_bytes(mask, "little")
    ).to_bytes(len(data), "little")


if len(sys.argv) != 5:
    refuse("encrypted upload arguments are incomplete")
source_path, destination_path, expected_size_text, expected_sha256 = sys.argv[1:]
try:
    expected_size = int(expected_size_text)
    key = bytes.fromhex(
        read_framed_document(64, "encrypted upload authority").decode("ascii")
    )
except (UnicodeDecodeError, ValueError):
    refuse("encrypted upload authority is malformed")
process_metadata = (
    open("/proc/self/cmdline", "rb").read()
    + b"\\x00".join(
        os.fsencode(name) + b"=" + os.fsencode(value)
        for name, value in os.environ.items()
    )
)
if key.hex().encode("ascii") in process_metadata:
    refuse("encrypted upload authority escaped into process metadata")
if (
    expected_size < 0
    or re.fullmatch(r"[0-9a-f]{64}", expected_sha256) is None
    or len(key) != 32
):
    refuse("encrypted upload authority is malformed")

source_flags = os.O_RDONLY | os.O_NOFOLLOW
destination_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
if hasattr(os, "O_CLOEXEC"):
    source_flags |= os.O_CLOEXEC
    destination_flags |= os.O_CLOEXEC
source = os.open(source_path, source_flags)
destination = None
try:
    source_info = os.fstat(source)
    if not stat.S_ISREG(source_info.st_mode) or source_info.st_nlink != 1:
        refuse("upload source is not one regular file")
    if source_info.st_size != expected_size:
        refuse("upload source size changed before encryption")
    destination = os.open(destination_path, destination_flags, 0o600)
    nonce = secrets.token_bytes(16)
    header = MAGIC + nonce + expected_size.to_bytes(8, "big")
    verifier = hmac.new(key, header, hashlib.sha256)
    digest = hashlib.sha256()
    write_all(destination, header)
    position = 0
    index = 0
    while position < expected_size:
        plain = os.pread(source, min(CHUNK, expected_size - position), position)
        if not plain:
            refuse("upload source became short during encryption")
        digest.update(plain)
        cipher = xor_chunk(plain, key, nonce, index)
        verifier.update(cipher)
        write_all(destination, cipher)
        position += len(plain)
        index += 1
    if os.fstat(source).st_size != expected_size or digest.hexdigest() != expected_sha256:
        refuse("upload source changed during encryption")
    write_all(destination, verifier.digest())
    os.fchmod(destination, 0o600)
    os.fsync(destination)
finally:
    if destination is not None:
        os.close(destination)
    os.close(source)
__REVIVAL_PIN_SEAL_UPLOAD__
`;

/**
 * Remote half of each rsync attempt.
 *
 * rsync normally asks ssh to start `rsync --server ... /absolute/path`, which
 * would resolve the mutable store path after a separate safety check. This
 * launcher instead opens root/releases/incoming component-by-component with
 * O_NOFOLLOW and changes cwd to the held incoming-directory descriptor. rsync
 * receives only an authenticated encrypted envelope, so even a hardlink to its
 * named resumable partial cannot export APK bytes. This launcher is deliberately
 * keyless: it only anchors and fsyncs ciphertext. A separate nondumpable claim
 * process receives the resume key over framed stdin, authenticates the envelope,
 * and performs the one-time plaintext publication.
 */
export const REMOTE_RSYNC_LAUNCHER_SOURCE = `import base64, ctypes, json, os, re, stat, subprocess, sys

COMPONENT = re.compile(r"^[A-Za-z0-9._-]+$")
AUTHORITY_PREFIX = "REVIVAL_PIN_RSYNC_AUTHORITY="
MAGIC = b"PINRESUME1\\x00"
os.umask(0o077)


def refuse(message):
    sys.stderr.write("pin-release-ship: " + message + "\\n")
    raise SystemExit(70)


try:
    _libc = ctypes.CDLL(None, use_errno=True)
    _prctl = _libc.prctl
    _prctl.restype = ctypes.c_int
except (AttributeError, OSError):
    refuse("host lacks required process nondumpability support")


def require_nondumpable():
    if _prctl(3, 0, 0, 0, 0) != 0:
        refuse("process lost its nondumpable plaintext boundary")


if _prctl(4, 0, 0, 0, 0) != 0:
    refuse("process cannot establish its nondumpable plaintext boundary")
require_nondumpable()


if (
    not hasattr(os, "O_DIRECTORY")
    or not hasattr(os, "O_NOFOLLOW")
    or not os.path.isdir("/proc/self/fd")
):
    refuse("host lacks required no-follow descriptor support")


DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
if hasattr(os, "O_CLOEXEC"):
    DIRECTORY_FLAGS |= os.O_CLOEXEC


def safe_component(value, label):
    if (
        not isinstance(value, str)
        or value in ("", ".", "..")
        or len(os.fsencode(value)) > 255
        or COMPONENT.fullmatch(value) is None
    ):
        refuse(label + " is not a safe path component")
    return value


def same_inode(left, right):
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)


class StatxTimestamp(ctypes.Structure):
    _fields_ = [
        ("seconds", ctypes.c_longlong),
        ("nanoseconds", ctypes.c_uint),
        ("reserved", ctypes.c_int),
    ]


class Statx(ctypes.Structure):
    _fields_ = [
        ("mask", ctypes.c_uint), ("block_size", ctypes.c_uint),
        ("attributes", ctypes.c_ulonglong), ("nlink", ctypes.c_uint),
        ("uid", ctypes.c_uint), ("gid", ctypes.c_uint),
        ("mode", ctypes.c_ushort), ("spare0", ctypes.c_ushort),
        ("ino", ctypes.c_ulonglong), ("size", ctypes.c_ulonglong),
        ("blocks", ctypes.c_ulonglong), ("attributes_mask", ctypes.c_ulonglong),
        ("atime", StatxTimestamp), ("btime", StatxTimestamp),
        ("ctime", StatxTimestamp), ("mtime", StatxTimestamp),
        ("rdev_major", ctypes.c_uint), ("rdev_minor", ctypes.c_uint),
        ("dev_major", ctypes.c_uint), ("dev_minor", ctypes.c_uint),
        ("mnt_id", ctypes.c_ulonglong), ("spare2", ctypes.c_ulonglong * 13),
    ]


try:
    _statx = _libc.statx
    _statx.argtypes = [
        ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.POINTER(Statx)
    ]
    _statx.restype = ctypes.c_int
except AttributeError:
    refuse("host lacks required statx generation support")


def identity(metadata, descriptor):
    generation = Statx()
    required = 0x800 | 0x1000
    if _statx(descriptor, b"", 0x1000 | 0x800, 0x7ff | required, ctypes.byref(generation)) != 0:
        refuse("filesystem authority generation cannot be read")
    if (
        generation.mask & required != required
        or generation.mnt_id == 0
        or (generation.btime.seconds == 0 and generation.btime.nanoseconds == 0)
        or generation.btime.nanoseconds >= 1000000000
        or generation.ino != metadata.st_ino
        or generation.uid != metadata.st_uid
        or generation.gid != metadata.st_gid
        or generation.mode != metadata.st_mode
        or generation.dev_major != os.major(metadata.st_dev)
        or generation.dev_minor != os.minor(metadata.st_dev)
    ):
        refuse("filesystem authority generation is unavailable or inconsistent")
    return {
        "dev": str(metadata.st_dev),
        "ino": str(metadata.st_ino),
        "mntId": str(generation.mnt_id),
        "btime": str(generation.btime.seconds) + "." + str(generation.btime.nanoseconds).zfill(9),
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
        "mode": stat.S_IMODE(metadata.st_mode),
    }


def require_identity(metadata, expected, label, descriptor):
    if not isinstance(expected, dict) or identity(metadata, descriptor) != expected:
        refuse(label + " differs from the staged filesystem authority")


def linked_info(parent, name):
    try:
        return os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return None


def open_absolute_directory(path, label):
    if not isinstance(path, str) or not path.startswith("/") or os.path.normpath(path) != path:
        refuse(label + " is not a canonical absolute path")
    descriptor = os.open("/", DIRECTORY_FLAGS)
    try:
        for component in path.split("/")[1:]:
            try:
                child = os.open(component, DIRECTORY_FLAGS, dir_fd=descriptor)
            except OSError:
                refuse(label + " cannot be opened without following links")
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def open_named_directory(parent, name, label):
    linked = linked_info(parent, name)
    if linked is None or stat.S_ISLNK(linked.st_mode) or not stat.S_ISDIR(linked.st_mode):
        refuse(label + " is not a real directory")
    try:
        descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=parent)
    except OSError:
        refuse(label + " cannot be opened without following links")
    opened = os.fstat(descriptor)
    if not stat.S_ISDIR(opened.st_mode) or not same_inode(linked, opened):
        os.close(descriptor)
        refuse(label + " changed while it was opened")
    return descriptor


if len(sys.argv) < 3 or not sys.argv[1].startswith(AUTHORITY_PREFIX):
    refuse("rsync authority is missing")
try:
    authority_bytes = base64.b64decode(
        sys.argv[1][len(AUTHORITY_PREFIX):], validate=True
    )
    authority = json.loads(authority_bytes.decode("utf-8"))
except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
    refuse("rsync authority is malformed")
if not isinstance(authority, dict) or set(authority) != {
    "releasesRoot", "incoming", "filename", "sealedName", "size", "sha256",
    "filesystemAuthority"
}:
    refuse("rsync authority has an unexpected shape")

releases_path = authority["releasesRoot"]
incoming_name = safe_component(authority["incoming"], "incoming directory name")
filename = safe_component(authority["filename"], "upload filename")
sealed_name = safe_component(authority["sealedName"], "encrypted rsync filename")
expected_size = authority["size"]
expected_sha256 = authority["sha256"]
filesystem_authority = authority["filesystemAuthority"]
if (
    not isinstance(expected_size, int)
    or isinstance(expected_size, bool)
    or expected_size < 0
    or not isinstance(expected_sha256, str)
    or re.fullmatch(r"[0-9a-f]{64}", expected_sha256) is None
):
    refuse("rsync content authority is malformed")
if not incoming_name.startswith(".incoming-") or not sealed_name.startswith(".sealed-"):
    refuse("incoming directory name is outside the transaction namespace")

server_arguments = sys.argv[2:]
if (
    len(server_arguments) < 2
    or server_arguments[0] != "--server"
    or "--sender" in server_arguments
):
    refuse("rsync server arguments are not in receiver mode")

parent_path, releases_name = os.path.split(releases_path)
if releases_name != "releases" or parent_path in ("", "/"):
    refuse("immutable releases directory has an unexpected path")
root = open_absolute_directory(parent_path, "release store root")
try:
    require_identity(os.fstat(root), filesystem_authority.get("root"), "release store root", root)
    releases = open_named_directory(root, releases_name, "immutable releases directory")
except BaseException:
    os.close(root)
    raise
try:
    require_identity(
        os.fstat(releases), filesystem_authority.get("releases"), "immutable releases directory", releases
    )
    incoming = open_named_directory(releases, incoming_name, "incoming release directory")
except BaseException:
    os.close(releases)
    os.close(root)
    raise

try:
    require_identity(os.fstat(incoming), filesystem_authority.get("incoming"), "incoming release directory", incoming)
    if stat.S_IMODE(os.fstat(incoming).st_mode) != 0o700:
        refuse("incoming release directory has unsafe permissions")
    target_authorities = filesystem_authority.get("targets")
    if not isinstance(target_authorities, dict) or target_authorities.get(filename, False) is not None:
        refuse("upload target is not authorized for one no-overwrite publication")
    if linked_info(incoming, filename) is not None:
        refuse("upload target appeared before atomic publication")
    existing_sealed = linked_info(incoming, sealed_name)
    if existing_sealed is not None and (
        stat.S_ISLNK(existing_sealed.st_mode)
        or not stat.S_ISREG(existing_sealed.st_mode)
        or existing_sealed.st_nlink != 1
    ):
        refuse("encrypted rsync checkpoint is not one regular file")
    os.fchdir(incoming)
    result = subprocess.run(["/usr/bin/rsync", *server_arguments], check=False)
    if result.returncode != 0:
        raise SystemExit(result.returncode)
    sealed = linked_info(incoming, sealed_name)
    if (
        sealed is None
        or stat.S_ISLNK(sealed.st_mode)
        or not stat.S_ISREG(sealed.st_mode)
        or sealed.st_nlink != 1
        or stat.S_IMODE(sealed.st_mode) != 0o600
        or sealed.st_size != len(MAGIC) + 16 + 8 + expected_size + 32
    ):
        refuse("encrypted rsync result is incomplete")
    flags = os.O_RDONLY | os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    checkpoint = os.open(sealed_name, flags, dir_fd=incoming)
    try:
        opened = os.fstat(checkpoint)
        os.fsync(checkpoint)
        linked = linked_info(incoming, sealed_name)
        if linked is None or linked.st_nlink != 1 or not same_inode(linked, opened):
            refuse("encrypted rsync result changed after receipt")
        os.fsync(incoming)
    finally:
        os.close(checkpoint)
finally:
    os.close(incoming)
    os.close(releases)
    os.close(root)
`;

function createRemoteRsyncPath({
  releasesRoot,
  incoming,
  filename,
  size,
  sha256: digest,
  filesystemAuthority,
  sealedName,
  launcherSource,
}) {
  const launcherBase64 = Buffer.from(launcherSource, "utf8").toString("base64");
  const authority = Buffer.from(JSON.stringify({
    releasesRoot,
    incoming,
    filename,
    sealedName,
    size,
    sha256: digest,
    filesystemAuthority,
  }), "utf8")
    .toString("base64");
  return (
    `/usr/bin/python3 -I -B -c 'import base64;exec(compile(base64.b64decode("${launcherBase64}"),` +
    `"<revival-pin-rsync>","exec"))' ` +
    shellQuote(`REVIVAL_PIN_RSYNC_AUTHORITY=${authority}`)
  );
}

function encryptedResumeName(filename) {
  return `.sealed-${sha256(filename).slice(0, 16)}.resume`;
}

export const REMOTE_INSPECT_SCRIPT = `${REMOTE_PRELUDE}root="$1"
shift
/usr/bin/python3 -I -B - "$root" "$@" <<'__REVIVAL_PIN_INSPECT__'
import base64, ctypes, hashlib, json, os, stat, sys

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


class StatxTimestamp(ctypes.Structure):
    _fields_ = [
        ("seconds", ctypes.c_longlong),
        ("nanoseconds", ctypes.c_uint),
        ("reserved", ctypes.c_int),
    ]


class Statx(ctypes.Structure):
    _fields_ = [
        ("mask", ctypes.c_uint), ("block_size", ctypes.c_uint),
        ("attributes", ctypes.c_ulonglong), ("nlink", ctypes.c_uint),
        ("uid", ctypes.c_uint), ("gid", ctypes.c_uint),
        ("mode", ctypes.c_ushort), ("spare0", ctypes.c_ushort),
        ("ino", ctypes.c_ulonglong), ("size", ctypes.c_ulonglong),
        ("blocks", ctypes.c_ulonglong), ("attributes_mask", ctypes.c_ulonglong),
        ("atime", StatxTimestamp), ("btime", StatxTimestamp),
        ("ctime", StatxTimestamp), ("mtime", StatxTimestamp),
        ("rdev_major", ctypes.c_uint), ("rdev_minor", ctypes.c_uint),
        ("dev_major", ctypes.c_uint), ("dev_minor", ctypes.c_uint),
        ("mnt_id", ctypes.c_ulonglong), ("spare2", ctypes.c_ulonglong * 13),
    ]


try:
    _libc = ctypes.CDLL(None, use_errno=True)
    _statx = _libc.statx
    _statx.argtypes = [
        ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.POINTER(Statx)
    ]
    _statx.restype = ctypes.c_int
except (AttributeError, OSError):
    refuse("host lacks required statx generation support")


def identity(metadata, descriptor):
    generation = Statx()
    required = 0x800 | 0x1000
    if _statx(descriptor, b"", 0x1000 | 0x800, 0x7ff | required, ctypes.byref(generation)) != 0:
        refuse("filesystem authority generation cannot be read")
    if (
        generation.mask & required != required
        or generation.mnt_id == 0
        or (generation.btime.seconds == 0 and generation.btime.nanoseconds == 0)
        or generation.btime.nanoseconds >= 1000000000
        or generation.ino != metadata.st_ino
        or generation.uid != metadata.st_uid
        or generation.gid != metadata.st_gid
        or generation.mode != metadata.st_mode
        or generation.dev_major != os.major(metadata.st_dev)
        or generation.dev_minor != os.minor(metadata.st_dev)
    ):
        refuse("filesystem authority generation is unavailable or inconsistent")
    return {
        "dev": str(metadata.st_dev),
        "ino": str(metadata.st_ino),
        "mntId": str(generation.mnt_id),
        "btime": str(generation.btime.seconds) + "." + str(generation.btime.nanoseconds).zfill(9),
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
        "mode": stat.S_IMODE(metadata.st_mode),
    }


DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
if hasattr(os, "O_CLOEXEC"):
    DIRECTORY_FLAGS |= os.O_CLOEXEC


def directory_identity(path, metadata, label):
    try:
        descriptor = os.open(path, DIRECTORY_FLAGS)
    except OSError:
        refuse(label + " cannot be opened without following links")
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
            refuse(label + " changed while it was inspected")
        return identity(opened, descriptor)
    finally:
        os.close(descriptor)


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
    "rootAuthority": None,
    "releasesState": "missing",
    "releasesAuthority": None,
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
        report["rootAuthority"] = directory_identity(root, root_metadata, "release store root")

if report["rootIsDirectory"]:
    releases_path = os.path.join(root, "releases")
    releases_metadata = info(releases_path)
    if releases_metadata is not None:
        if stat.S_ISLNK(releases_metadata.st_mode) or not stat.S_ISDIR(releases_metadata.st_mode):
            report["releasesState"] = "invalid"
        else:
            report["releasesState"] = "directory"
            report["releasesAuthority"] = directory_identity(
                releases_path, releases_metadata, "immutable releases directory"
            )
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
        if report["releasesState"] != "directory":
            report["releases"][release_id] = None
            continue
        directory = os.path.join(root, "releases", release_id)
        metadata = info(directory)
        if metadata is None:
            report["releases"][release_id] = None
            continue
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            report["releases"][release_id] = {"isDirectory": False, "authority": None, "entries": {}}
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
        report["releases"][release_id] = {
            "isDirectory": True,
            "authority": directory_identity(directory, metadata, "immutable release " + release_id),
            "entries": entries,
        }

sys.stdout.write(json.dumps(report, sort_keys=True, separators=(",", ":")) + "\\n")
__REVIVAL_PIN_INSPECT__
`;

export const REMOTE_APPLY_SCRIPT = `${REMOTE_PRELUDE}root="$1"
/usr/bin/python3 -I -B - "$root" <<'__REVIVAL_PIN_APPLY__'
import base64, ctypes, errno, fcntl, hashlib, json, os, re, secrets, stat, sys

CHUNK = 1024 * 1024
COMPONENT = re.compile(r"^[A-Za-z0-9._-]+$")
root = sys.argv[1]
os.umask(0o077)


def refuse(message):
    sys.stderr.write("pin-release-ship: " + message + "\\n")
    raise SystemExit(70)


try:
    _process_libc = ctypes.CDLL(None, use_errno=True)
    _prctl = _process_libc.prctl
    _prctl.restype = ctypes.c_int
except (AttributeError, OSError):
    refuse("host lacks required process nondumpability support")


def require_nondumpable():
    if _prctl(3, 0, 0, 0, 0) != 0:
        refuse("process lost its nondumpable plaintext boundary")


def read_framed_document(maximum, label):
    require_nondumpable()
    sys.stdout.write("READY\\n")
    sys.stdout.flush()
    length_line = sys.stdin.buffer.readline(33)
    if (
        not length_line.endswith(b"\\n")
        or len(length_line) <= 1
        or not length_line[:-1].isdigit()
        or (len(length_line) > 2 and length_line.startswith(b"0"))
    ):
        refuse(label + " length is malformed")
    length = int(length_line[:-1])
    if length > maximum:
        refuse(label + " exceeds its size bound")
    document = sys.stdin.buffer.read(length)
    if len(document) != length or sys.stdin.buffer.read(1) != b"":
        refuse(label + " framing is incomplete")
    require_nondumpable()
    return document


if _prctl(4, 0, 0, 0, 0) != 0:
    refuse("process cannot establish its nondumpable plaintext boundary")
require_nondumpable()

try:
    payload_document = read_framed_document(${MAX_FRAMED_DOCUMENT_BYTES}, "apply payload")
    process_metadata = (
        open("/proc/self/cmdline", "rb").read()
        + b"\\x00".join(
            os.fsencode(name) + b"=" + os.fsencode(value)
            for name, value in os.environ.items()
        )
    )
    if payload_document in process_metadata:
        refuse("apply payload escaped into process metadata")
    payload = json.loads(payload_document.decode("utf-8"))
except (UnicodeDecodeError, json.JSONDecodeError):
    refuse("apply payload is malformed")


if (
    not hasattr(os, "O_DIRECTORY")
    or not hasattr(os, "O_NOFOLLOW")
    or not hasattr(os, "O_TMPFILE")
    or not os.path.isdir("/proc/self/fd")
):
    refuse("host lacks required unnamed-file or no-follow descriptor support")


DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
if hasattr(os, "O_CLOEXEC"):
    DIRECTORY_FLAGS |= os.O_CLOEXEC


def safe_component(value, label):
    if (
        not isinstance(value, str)
        or value in ("", ".", "..")
        or len(os.fsencode(value)) > 255
        or COMPONENT.fullmatch(value) is None
    ):
        refuse(label + " is not a safe path component")
    return value


def linked_info(parent, name):
    try:
        return os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return None


def same_inode(left, right):
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)


class StatxTimestamp(ctypes.Structure):
    _fields_ = [
        ("seconds", ctypes.c_longlong),
        ("nanoseconds", ctypes.c_uint),
        ("reserved", ctypes.c_int),
    ]


class Statx(ctypes.Structure):
    _fields_ = [
        ("mask", ctypes.c_uint), ("block_size", ctypes.c_uint),
        ("attributes", ctypes.c_ulonglong), ("nlink", ctypes.c_uint),
        ("uid", ctypes.c_uint), ("gid", ctypes.c_uint),
        ("mode", ctypes.c_ushort), ("spare0", ctypes.c_ushort),
        ("ino", ctypes.c_ulonglong), ("size", ctypes.c_ulonglong),
        ("blocks", ctypes.c_ulonglong), ("attributes_mask", ctypes.c_ulonglong),
        ("atime", StatxTimestamp), ("btime", StatxTimestamp),
        ("ctime", StatxTimestamp), ("mtime", StatxTimestamp),
        ("rdev_major", ctypes.c_uint), ("rdev_minor", ctypes.c_uint),
        ("dev_major", ctypes.c_uint), ("dev_minor", ctypes.c_uint),
        ("mnt_id", ctypes.c_ulonglong), ("spare2", ctypes.c_ulonglong * 13),
    ]


try:
    _statx = _process_libc.statx
    _statx.argtypes = [
        ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.POINTER(Statx)
    ]
    _statx.restype = ctypes.c_int
except AttributeError:
    refuse("host lacks required statx generation support")


def identity(metadata, descriptor):
    generation = Statx()
    required = 0x800 | 0x1000
    if _statx(descriptor, b"", 0x1000 | 0x800, 0x7ff | required, ctypes.byref(generation)) != 0:
        refuse("filesystem authority generation cannot be read")
    if (
        generation.mask & required != required
        or generation.mnt_id == 0
        or (generation.btime.seconds == 0 and generation.btime.nanoseconds == 0)
        or generation.btime.nanoseconds >= 1000000000
        or generation.ino != metadata.st_ino
        or generation.uid != metadata.st_uid
        or generation.gid != metadata.st_gid
        or generation.mode != metadata.st_mode
        or generation.dev_major != os.major(metadata.st_dev)
        or generation.dev_minor != os.minor(metadata.st_dev)
    ):
        refuse("filesystem authority generation is unavailable or inconsistent")
    return {
        "dev": str(metadata.st_dev),
        "ino": str(metadata.st_ino),
        "mntId": str(generation.mnt_id),
        "btime": str(generation.btime.seconds) + "." + str(generation.btime.nanoseconds).zfill(9),
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
        "mode": stat.S_IMODE(metadata.st_mode),
    }


def require_identity(metadata, expected, label, descriptor):
    if not isinstance(expected, dict) or identity(metadata, descriptor) != expected:
        refuse(label + " differs from the publication filesystem authority")


def open_absolute_directory(path, label):
    if not isinstance(path, str) or not path.startswith("/") or os.path.normpath(path) != path:
        refuse(label + " is not a canonical absolute path")
    descriptor = os.open("/", DIRECTORY_FLAGS)
    try:
        for component in path.split("/")[1:]:
            try:
                child = os.open(component, DIRECTORY_FLAGS, dir_fd=descriptor)
            except OSError:
                refuse(label + " cannot be opened without following links")
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def open_named_directory(parent, name, label):
    linked = linked_info(parent, name)
    if linked is None or stat.S_ISLNK(linked.st_mode) or not stat.S_ISDIR(linked.st_mode):
        refuse(label + " is not a real directory")
    try:
        descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=parent)
    except OSError:
        refuse(label + " cannot be opened without following links")
    opened = os.fstat(descriptor)
    if not stat.S_ISDIR(opened.st_mode) or not same_inode(linked, opened):
        os.close(descriptor)
        refuse(label + " changed while it was opened")
    return descriptor


def open_regular(parent, name, label, missing_ok=False):
    linked = linked_info(parent, name)
    if linked is None:
        if missing_ok:
            return None
        refuse(label + " is missing")
    if stat.S_ISLNK(linked.st_mode) or not stat.S_ISREG(linked.st_mode) or linked.st_nlink != 1:
        refuse(label + " is not one regular file")
    flags = os.O_RDONLY | os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    try:
        descriptor = os.open(name, flags, dir_fd=parent)
    except OSError:
        refuse(label + " cannot be opened without following links")
    opened = os.fstat(descriptor)
    if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1 or not same_inode(linked, opened):
        os.close(descriptor)
        refuse(label + " changed while it was opened")
    return descriptor


def reprove_link(parent, name, descriptor, label):
    linked = linked_info(parent, name)
    opened = os.fstat(descriptor)
    if (
        linked is None
        or stat.S_ISLNK(linked.st_mode)
        or opened.st_nlink != 1
        or linked.st_nlink != 1
        or not same_inode(linked, opened)
    ):
        refuse(label + " changed after it was opened")


def digest_fd(descriptor):
    size = 0
    digest = hashlib.sha256()
    os.lseek(descriptor, 0, os.SEEK_SET)
    while True:
        chunk = os.read(descriptor, CHUNK)
        if not chunk:
            break
        size += len(chunk)
        digest.update(chunk)
    os.lseek(descriptor, 0, os.SEEK_SET)
    return size, digest.hexdigest()


def sync_directory_fd(descriptor, label):
    os.fsync(descriptor)


try:
    _libc = ctypes.CDLL(None, use_errno=True)
    _renameat2 = _libc.renameat2
    _renameat2.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    _renameat2.restype = ctypes.c_int
except (AttributeError, OSError):
    refuse("host lacks required atomic no-replace rename support")


def rename_noreplace(parent, source, target, label):
    if _renameat2(parent, os.fsencode(source), parent, os.fsencode(target), 1) != 0:
        failure = ctypes.get_errno()
        if failure in (errno.EEXIST, errno.ENOTEMPTY):
            refuse(label + " already exists; it must never be rewritten")
        refuse(label + " cannot be renamed atomically without replacement")


def quarantine_entry(parent, name, label):
    before = linked_info(parent, name)
    if before is None:
        return None
    quarantine = ".rejected-" + name[:16] + "-" + secrets.token_hex(8)
    rename_noreplace(parent, name, quarantine, label + " quarantine")
    moved = linked_info(parent, quarantine)
    if (
        moved is None
        or not same_inode(before, moved)
        or linked_info(parent, name) is not None
    ):
        refuse(label + " could not be quarantined safely")
    sync_directory_fd(parent, "immutable releases directory")
    return quarantine


def document_observation(root_descriptor, name):
    descriptor = open_regular(root_descriptor, name, name, missing_ok=True)
    if descriptor is None:
        return {"descriptor": None, "sha256": None}
    return {"descriptor": descriptor, "sha256": digest_fd(descriptor)[1]}


def reprove_document(root_descriptor, name, observation):
    descriptor = observation["descriptor"]
    if descriptor is None:
        if linked_info(root_descriptor, name) is not None:
            refuse(name + " appeared after compare-and-swap inspection")
    else:
        reprove_link(root_descriptor, name, descriptor, name)
        if digest_fd(descriptor)[1] != observation["sha256"]:
            refuse(name + " changed in place after compare-and-swap inspection")


def verify_published_document(root_descriptor, name, observation):
    descriptor = observation.get("descriptor")
    if descriptor is None:
        refuse(name + " publication descriptor is missing")
    opened = os.fstat(descriptor)
    if (
        not stat.S_ISREG(opened.st_mode)
        or stat.S_IMODE(opened.st_mode) != 0o600
        or opened.st_nlink != 1
        or digest_fd(descriptor) != (observation["size"], observation["sha256"])
    ):
        refuse(name + " changed after publication")
    reprove_link(root_descriptor, name, descriptor, name)
    reopened = open_regular(root_descriptor, name, name)
    actual = None
    try:
        reopened_info = os.fstat(reopened)
        if identity(reopened_info, reopened) != identity(opened, descriptor):
            refuse(name + " changed while it was reopened for verification")
        actual = digest_fd(reopened)
        if actual != (observation["size"], observation["sha256"]):
            refuse(name + " bytes changed while it was reopened for verification")
        reprove_link(root_descriptor, name, reopened, name)
    finally:
        os.close(reopened)
    return actual[1]


def write_all(handle, data):
    view = memoryview(data)
    offset = 0
    while offset < len(view):
        require_nondumpable()
        written = os.write(handle, view[offset:])
        if not isinstance(written, int) or written <= 0 or written > len(view) - offset:
            raise OSError(errno.EIO, "atomic document write made no safe progress")
        offset += written
    if offset != len(view) or os.fstat(handle).st_size != len(view):
        raise OSError(errno.EIO, "atomic document write remained short")


def atomic_write(root_descriptor, name, data):
    temporary = "." + name + "." + str(os.getpid()) + "." + secrets.token_hex(8) + ".tmp"
    flags = os.O_RDWR | os.O_TMPFILE
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    require_nondumpable()
    handle = os.open(".", flags, 0o600, dir_fd=root_descriptor)
    published_descriptor = None
    try:
        opened = os.fstat(handle)
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 0:
            refuse("atomic document did not create one unnamed regular inode")
        write_all(handle, data)
        os.fchmod(handle, 0o600)
        os.fsync(handle)
        opened = os.fstat(handle)
        expected_digest = hashlib.sha256(data).hexdigest()
        if (
            opened.st_nlink != 0
            or stat.S_IMODE(opened.st_mode) != 0o600
            or digest_fd(handle) != (len(data), expected_digest)
        ):
            refuse("atomic document changed before publication")
        if linked_info(root_descriptor, temporary) is not None:
            refuse("atomic document publication name already exists")
        require_nondumpable()
        try:
            os.link(
                "/proc/self/fd/" + str(handle),
                temporary,
                dst_dir_fd=root_descriptor,
                follow_symlinks=True,
            )
        except OSError:
            refuse("atomic document cannot be linked without replacement")
        temporary_info = linked_info(root_descriptor, temporary)
        opened = os.fstat(handle)
        if (
            temporary_info is None
            or not stat.S_ISREG(temporary_info.st_mode)
            or temporary_info.st_nlink != 1
            or opened.st_nlink != 1
            or not same_inode(temporary_info, opened)
        ):
            refuse("atomic document changed during temporary linking")
        os.replace(temporary, name, src_dir_fd=root_descriptor, dst_dir_fd=root_descriptor)
        temporary = None
        published = linked_info(root_descriptor, name)
        if (
            published is None
            or published.st_nlink != 1
            or stat.S_IMODE(published.st_mode) != 0o600
            or not same_inode(published, opened)
        ):
            refuse("atomic document target changed during replacement")
        sync_directory_fd(root_descriptor, "release store root")
        published_descriptor = open_regular(root_descriptor, name, name)
        if not same_inode(os.fstat(published_descriptor), opened):
            refuse("atomic document target changed while reopening read-only")
        observation = {
            "descriptor": published_descriptor,
            "sha256": expected_digest,
            "size": len(data),
        }
        reprove_document(root_descriptor, name, observation)
        return observation
    except BaseException:
        if temporary is not None:
            linked = linked_info(root_descriptor, temporary)
            if linked is not None and same_inode(linked, os.fstat(handle)):
                try:
                    os.unlink(temporary, dir_fd=root_descriptor)
                except FileNotFoundError:
                    pass
        if published_descriptor is not None:
            os.close(published_descriptor)
        raise
    finally:
        os.close(handle)


def acquire_store_lock(root_descriptor):
    # Open relative to a no-follow directory descriptor, and validate the opened
    # inode rather than trusting a pathname check before open. The lock is a
    # persistent store control file: kernel ownership is released on every exit,
    # including a crash between the two document writes, so the existing
    # interrupted-swap repair path cannot be wedged by a stale owner.
    lock_fd = None
    try:
        lock_flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_CLOEXEC"):
            lock_flags |= os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            lock_flags |= os.O_NOFOLLOW
        try:
            lock_fd = os.open(".publish.lock", lock_flags, 0o600, dir_fd=root_descriptor)
        except OSError:
            refuse("publication lock is not a no-follow regular file")
        def prove_lock_inode():
            try:
                linked = os.stat(".publish.lock", dir_fd=root_descriptor, follow_symlinks=False)
                opened = os.fstat(lock_fd)
            except OSError:
                refuse("publication lock cannot be inspected safely")
            if (
                not stat.S_ISREG(opened.st_mode)
                or stat.S_IMODE(opened.st_mode) != 0o600
                or opened.st_nlink != 1
                or (opened.st_dev, opened.st_ino) != (linked.st_dev, linked.st_ino)
            ):
                refuse("publication lock must be one regular mode-0600 file")

        prove_lock_inode()
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            refuse("another Pin release publication holds the store lock")
        except OSError:
            refuse("publication lock cannot be acquired safely")
        # Re-prove the pathname after acquiring authority. A replacement would
        # otherwise let two publishers lock two different inodes under one name.
        prove_lock_inode()
        os.fsync(lock_fd)
        sync_directory_fd(root_descriptor, "release store root")
        return lock_fd
    except BaseException:
        if lock_fd is not None:
            os.close(lock_fd)
        raise


def apply_publication(root_descriptor, releases_descriptor):
    # Compare-and-swap. The two mutable documents must still be exactly what the
    # inspection saw, or another publisher moved underneath this one and the
    # plan's anti-rollback reasoning no longer describes reality. The store lock
    # stays held from this first observation through both durable document writes.
    observations = {}
    for name, expected in (
        ("history.json", payload["expectedHistorySha256"]),
        ("current.json", payload["expectedCurrentSha256"]),
    ):
        observation = document_observation(root_descriptor, name)
        observations[name] = observation
        if observation["sha256"] != expected:
            refuse(name + " changed since the store was inspected")

    release_id = safe_component(payload["releaseId"], "release identifier")
    filesystem_authority = payload["authority"]
    expected_entries = {entry["name"]: entry for entry in payload["entries"]}
    if len(expected_entries) != len(payload["entries"]):
        refuse("release plan contains duplicate file names")
    for name in expected_entries:
        safe_component(name, "release entry name")
    retained_descriptors = {}
    retained_directory = None
    if payload["incoming"] is None:
        final_descriptor = open_named_directory(
            releases_descriptor, release_id, "immutable release " + release_id
        )
        require_identity(
            os.fstat(final_descriptor),
            filesystem_authority.get("retainedRelease"),
            "retained immutable release",
            final_descriptor,
        )
        retained_directory = final_descriptor
        actual_entries = sorted(os.listdir(final_descriptor))
        if actual_entries != sorted(expected_entries):
            refuse("retained immutable release does not hold exactly the planned files")
        for name in actual_entries:
            descriptor = open_regular(final_descriptor, name, "retained release entry " + name)
            retained_descriptors[name] = descriptor
            size, sha256 = digest_fd(descriptor)
            if size != expected_entries[name]["size"] or sha256 != expected_entries[name]["sha256"]:
                refuse("retained release entry does not match its pinned digest: " + name)
            reprove_link(final_descriptor, name, descriptor, "retained release entry " + name)
    else:
        incoming_name = safe_component(payload["incoming"], "incoming directory name")
        if not incoming_name.startswith(".incoming-"):
            refuse("incoming directory name is outside the transaction namespace")
        incoming_descriptor = open_named_directory(
            releases_descriptor, incoming_name, "incoming release directory"
        )
        require_identity(
            os.fstat(incoming_descriptor),
            filesystem_authority.get("incoming"),
            "incoming release directory",
            incoming_descriptor,
        )
        actual_entries = sorted(os.listdir(incoming_descriptor))
        if actual_entries != sorted(expected_entries):
            refuse("incoming release directory does not hold exactly the planned files")
        entry_descriptors = {}
        try:
            for name in actual_entries:
                descriptor = open_regular(
                    incoming_descriptor, name, "incoming entry " + name
                )
                entry_descriptors[name] = descriptor
                target_authorities = filesystem_authority.get("targets")
                if not isinstance(target_authorities, dict) or name not in target_authorities:
                    refuse("incoming entry filesystem authority is missing: " + name)
                require_identity(
                    os.fstat(descriptor),
                    target_authorities[name],
                    "incoming entry " + name,
                    descriptor,
                )
                size, sha256 = digest_fd(descriptor)
                if size != expected_entries[name]["size"] or sha256 != expected_entries[name]["sha256"]:
                    refuse("incoming entry does not match its pinned digest: " + name)
                # A deterministic test barrier replaces the linked name here,
                # after the genuine digest. All following mutations stay on the
                # held descriptor and the name must still prove the same inode.
                reprove_link(incoming_descriptor, name, descriptor, "incoming entry " + name)
                os.fchmod(descriptor, 0o600)
                os.fsync(descriptor)
                reprove_link(incoming_descriptor, name, descriptor, "incoming entry " + name)

            if sorted(os.listdir(incoming_descriptor)) != actual_entries:
                refuse("incoming release directory changed after verification")
            for name, descriptor in entry_descriptors.items():
                reprove_link(incoming_descriptor, name, descriptor, "incoming entry " + name)

            os.fchmod(incoming_descriptor, 0o700)
            sync_directory_fd(incoming_descriptor, "incoming release directory")
            linked_incoming = linked_info(releases_descriptor, incoming_name)
            if linked_incoming is None or not same_inode(linked_incoming, os.fstat(incoming_descriptor)):
                refuse("incoming release directory changed before publication")
            if linked_info(releases_descriptor, release_id) is not None:
                refuse("immutable release already exists; it must never be rewritten")

            for name, observation in observations.items():
                reprove_document(root_descriptor, name, observation)

            rename_noreplace(
                releases_descriptor,
                incoming_name,
                release_id,
                "immutable release",
            )
            try:
                final_info = linked_info(releases_descriptor, release_id)
                if final_info is None or not same_inode(final_info, os.fstat(incoming_descriptor)):
                    refuse("incoming release directory changed during publication rename")
                if sorted(os.listdir(incoming_descriptor)) != actual_entries:
                    refuse("incoming release directory changed during publication rename")
                for name, descriptor in entry_descriptors.items():
                    reprove_link(
                        incoming_descriptor,
                        name,
                        descriptor,
                        "incoming entry " + name,
                    )
            except BaseException:
                # If a name was exchanged in the narrow reproof-to-rename
                # window, restore the exact directory we just moved to its
                # hidden transaction name before refusing. No pointer can name
                # the candidate until all held file descriptors reprove here.
                final_info = linked_info(releases_descriptor, release_id)
                if (
                    linked_info(releases_descriptor, incoming_name) is None
                    and final_info is not None
                    and same_inode(final_info, os.fstat(incoming_descriptor))
                ):
                    rename_noreplace(
                        releases_descriptor,
                        release_id,
                        incoming_name,
                        "incoming release directory",
                    )
                    sync_directory_fd(releases_descriptor, "immutable releases directory")
                elif final_info is not None:
                    quarantine_entry(
                        releases_descriptor,
                        release_id,
                        "mismatched immutable release",
                    )
                raise
            sync_directory_fd(releases_descriptor, "immutable releases directory")
            # Keep every descriptor that proved the release alive through both
            # pointer replacements. The final release name is re-proved around
            # each write, so a post-rename directory or entry exchange is
            # refused before this process acknowledges publication.
            retained_directory = incoming_descriptor
            incoming_descriptor = None
            retained_descriptors = entry_descriptors
            entry_descriptors = {}
        finally:
            for descriptor in entry_descriptors.values():
                os.close(descriptor)
            if incoming_descriptor is not None:
                os.close(incoming_descriptor)

    def reprove_published_release():
        if retained_directory is None:
            refuse("published release descriptor is missing")
        named_root = open_absolute_directory(root, "release store root")
        try:
            require_identity(
                os.fstat(named_root),
                filesystem_authority.get("root"),
                "release store root",
                named_root,
            )
            if not same_inode(os.fstat(named_root), os.fstat(root_descriptor)):
                refuse("release store root changed after it was opened")
        finally:
            os.close(named_root)
        linked_releases = linked_info(root_descriptor, "releases")
        opened_releases = os.fstat(releases_descriptor)
        if (
            linked_releases is None
            or stat.S_ISLNK(linked_releases.st_mode)
            or not stat.S_ISDIR(linked_releases.st_mode)
            or not same_inode(linked_releases, opened_releases)
        ):
            refuse("immutable releases directory changed after it was opened")
        require_identity(
            opened_releases,
            filesystem_authority.get("releases"),
            "immutable releases directory",
            releases_descriptor,
        )
        linked_release = linked_info(releases_descriptor, release_id)
        opened_release = os.fstat(retained_directory)
        if (
            linked_release is None
            or stat.S_ISLNK(linked_release.st_mode)
            or not stat.S_ISDIR(linked_release.st_mode)
            or not same_inode(linked_release, opened_release)
        ):
            if linked_release is not None and not same_inode(linked_release, opened_release):
                quarantine_entry(
                    releases_descriptor,
                    release_id,
                    "mismatched immutable release",
                )
            refuse("published immutable release changed after verification")
        if sorted(os.listdir(retained_directory)) != sorted(expected_entries):
            refuse("published immutable release changed after verification")
        actual_hashes = {}
        for name, descriptor in retained_descriptors.items():
            reprove_link(retained_directory, name, descriptor, "published release entry " + name)
            size, digest = digest_fd(descriptor)
            expected = expected_entries[name]
            if size != expected["size"] or digest != expected["sha256"]:
                refuse("published release entry changed in place: " + name)
            reprove_link(retained_directory, name, descriptor, "published release entry " + name)
            actual_hashes[name] = {"size": size, "sha256": digest}
        return actual_hashes

    published_documents = {}
    try:
        for name, observation in observations.items():
            reprove_document(root_descriptor, name, observation)
        reprove_published_release()
        published_documents["history.json"] = atomic_write(
            root_descriptor,
            "history.json",
            base64.b64decode(payload["historyBase64"]),
        )
        verify_published_document(
            root_descriptor,
            "history.json",
            published_documents["history.json"],
        )
        reprove_published_release()
        reprove_document(root_descriptor, "current.json", observations["current.json"])
        verify_published_document(
            root_descriptor,
            "history.json",
            published_documents["history.json"],
        )
        published_documents["current.json"] = atomic_write(
            root_descriptor,
            "current.json",
            base64.b64decode(payload["currentBase64"]),
        )
        verify_published_document(
            root_descriptor,
            "history.json",
            published_documents["history.json"],
        )
        verify_published_document(
            root_descriptor,
            "current.json",
            published_documents["current.json"],
        )
        reprove_published_release()
        # Final commit proof: both canonical pointer byte strings are reopened
        # no-follow after every publication and once more immediately before
        # success is emitted.
        final_pointer_hashes = {}
        for name in ("history.json", "current.json"):
            final_pointer_hashes[name] = verify_published_document(
                root_descriptor, name, published_documents[name]
            )
        final_release_hashes = reprove_published_release()
        for name in ("history.json", "current.json"):
            final_pointer_hashes[name] = verify_published_document(
                root_descriptor, name, published_documents[name]
            )
        return {
            "historySha256": final_pointer_hashes["history.json"],
            "currentSha256": final_pointer_hashes["current.json"],
            "releaseEntries": final_release_hashes,
        }
    finally:
        for observation in observations.values():
            descriptor = observation["descriptor"]
            if descriptor is not None:
                os.close(descriptor)
        for descriptor in retained_descriptors.values():
            os.close(descriptor)
        if retained_directory is not None:
            os.close(retained_directory)
        for observation in published_documents.values():
            os.close(observation["descriptor"])


root_descriptor = open_absolute_directory(root, "release store root")
releases_descriptor = None
lock_fd = None
try:
    filesystem_authority = payload["authority"]
    require_identity(
        os.fstat(root_descriptor), filesystem_authority.get("root"), "release store root", root_descriptor
    )
    releases_info = linked_info(root_descriptor, "releases")
    if releases_info is None:
        refuse("immutable releases directory is missing")
    releases_descriptor = open_named_directory(
        root_descriptor, "releases", "immutable releases directory"
    )
    require_identity(
        os.fstat(releases_descriptor),
        filesystem_authority.get("releases"),
        "immutable releases directory",
        releases_descriptor,
    )
    lock_fd = acquire_store_lock(root_descriptor)
    try:
        publication_ack = apply_publication(root_descriptor, releases_descriptor)
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)
        lock_fd = None
finally:
    if lock_fd is not None:
        os.close(lock_fd)
    if releases_descriptor is not None:
        os.close(releases_descriptor)
    os.close(root_descriptor)

sys.stdout.write(
    json.dumps(
        {
            "schemaVersion": 1,
            "applied": True,
            "releaseId": payload["releaseId"],
            **publication_ack,
        },
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
    return `${REMOTE_PRELUDE}${script}`;
  }
  fail(
    "invalid-invocation",
    "sensitive remote documents require the nondumpable framed-stdin transport",
  );
}

function extractPythonHeredoc(script, label) {
  if (typeof script !== "string" || script.length === 0) {
    fail("invalid-invocation", `${label} helper script is required`);
  }
  const match = script.match(/<<'([A-Za-z0-9_]+)'\n/u);
  if (match === null || match.index === undefined) {
    fail("invalid-invocation", `${label} helper lacks its Python heredoc`);
  }
  const start = match.index + match[0].length;
  const terminator = `\n${match[1]}\n`;
  const end = script.indexOf(terminator, start);
  if (end < 0 || script.indexOf(terminator, end + terminator.length) >= 0) {
    fail("invalid-invocation", `${label} helper has an ambiguous Python heredoc`);
  }
  return script.slice(start, end);
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

function validateStagingComponent(candidate, label) {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate === "." ||
    candidate === ".." ||
    Buffer.byteLength(candidate) > 255 ||
    !STAGING_COMPONENT_RE.test(candidate)
  ) {
    fail("invalid-upload", `${label} is not a safe path component: ${String(candidate)}`);
  }
  return candidate;
}

function encodeFilesystemAuthority(authority) {
  return Buffer.from(JSON.stringify(authority), "utf8").toString("base64");
}

function parseStagingAuthority(stdout) {
  const value = parseReport(stdout, "incoming directory creation");
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "incoming,releases,root,targets" ||
    !isRecord(value.targets)
  ) {
    fail("report-invalid", "incoming directory creation returned malformed authority");
  }
  const targets = Object.freeze(Object.fromEntries(
    Object.entries(value.targets).map(([name, authority]) => [
      validateStagingComponent(name, "staged upload filename"),
      authority === null
        ? null
        : parseFilesystemAuthority(authority, `staged upload target ${name}`),
    ]),
  ));
  return Object.freeze({
    root: parseFilesystemAuthority(value.root, "staged release root"),
    releases: parseFilesystemAuthority(value.releases, "staged releases directory"),
    incoming: parseFilesystemAuthority(value.incoming, "staged incoming directory"),
    targets,
  });
}

async function runProcess(executable, args, {
  input,
  label,
  maximumOutputBytes = MAX_REMOTE_REPORT_BYTES,
  timeoutMilliseconds = PROCESS_TIMEOUT_MILLISECONDS,
}) {
  const child = spawn(executable, args, {
    detached: OWN_CHILD_PROCESS_GROUP,
    stdio: ["pipe", "pipe", "pipe"],
    env: positiveToolEnvironment(),
  });
  const tracked = trackChildProcess(child, { ownsProcessGroup: OWN_CHILD_PROCESS_GROUP });
  let stdout = "";
  let stderr = "";
  let processError = null;
  let forcedTermination = null;
  const terminateForFailure = () => {
    if (forcedTermination === null) {
      forcedTermination = terminateTrackedProcess(tracked, { graceMilliseconds: 1 });
      void forcedTermination.catch(() => undefined);
    }
  };
  child.stdout.on("data", (chunk) => {
    if (processError !== null) return;
    stdout += chunk.toString("utf8");
    if (stdout.length > maximumOutputBytes) {
      processError = new PinReleaseShipError("remote-failed", `${label} exceeded its output bound`);
      terminateForFailure();
    }
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length <= 64 * 1024) stderr += chunk.toString("utf8");
  });
  child.stdin.on("error", (error) => {
    if (error?.code !== "EPIPE" && processError === null) {
      processError = new PinReleaseShipError("remote-failed", `${label} input failed: ${error.message}`);
      terminateForFailure();
    }
  });
  if (input !== undefined) child.stdin.end(input);
  else child.stdin.end();
  const outcome = await withTrackedDeadline(tracked, tracked.close, {
    milliseconds: timeoutMilliseconds,
    timeoutError: () => new PinReleaseShipError(
      "remote-timeout",
      `${label} exceeded its fixed wall-clock deadline`,
    ),
  });
  if (forcedTermination !== null) await forcedTermination;
  if (processError !== null) throw processError;
  if (outcome.error !== null) {
    throw new PinReleaseShipError("remote-failed", `${label} could not start: ${outcome.error.message}`);
  }
  if (outcome.code !== 0 || outcome.signal !== null) {
    throw new PinReleaseShipError(
      "remote-failed",
      `${label} failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
  }
  return stdout;
}

/*
 * Sensitive helper input is never placed in argv, the environment, or a named
 * temporary.  The child first establishes PR_SET_DUMPABLE=0 and only then
 * emits the exact READY line.  Until that proof crosses this pipe, the parent
 * withholds the length-prefixed document entirely.
 */
async function runReadyProcess(
  executable,
  args,
  {
    document,
    label,
    maximumOutputBytes = MAX_REMOTE_REPORT_BYTES,
    timeoutMilliseconds = PROTECTED_OPERATION_TIMEOUT_MILLISECONDS,
  },
) {
  if (typeof document !== "string" || Buffer.byteLength(document) > MAX_FRAMED_DOCUMENT_BYTES) {
    fail("invalid-invocation", `${label} framed document is outside its size bound`);
  }
  const child = spawn(executable, args, {
    detached: OWN_CHILD_PROCESS_GROUP,
    stdio: ["pipe", "pipe", "pipe"],
    env: positiveToolEnvironment(),
  });
  const tracked = trackChildProcess(child, { ownsProcessGroup: OWN_CHILD_PROCESS_GROUP });
  let stdout = "";
  let stderr = "";
  let readyBuffer = "";
  let ready = false;
  let processError = null;
  let forcedTermination = null;
  const terminateForFailure = () => {
    if (forcedTermination === null) {
      forcedTermination = terminateTrackedProcess(tracked, { graceMilliseconds: 1 });
      void forcedTermination.catch(() => undefined);
    }
  };
  let resolveReady;
  const readyOperation = new Promise((resolvePromise) => { resolveReady = resolvePromise; });
  child.stdout.on("data", (chunk) => {
    if (processError !== null) return;
    const text = chunk.toString("utf8");
    if (!ready) {
      readyBuffer += text;
      if (!"READY\n".startsWith(readyBuffer) && !readyBuffer.startsWith("READY\n")) {
        processError = new PinReleaseShipError(
          "remote-failed",
          `${label} returned output before its protected input boundary`,
        );
        terminateForFailure();
        resolveReady();
        return;
      }
      if (readyBuffer.startsWith("READY\n")) {
        ready = true;
        stdout += readyBuffer.slice("READY\n".length);
        readyBuffer = "";
        resolveReady();
        const bytes = Buffer.from(document, "utf8");
        child.stdin.cork();
        child.stdin.write(`${bytes.length}\n`, "ascii");
        child.stdin.end(bytes);
        child.stdin.uncork();
      }
    } else {
      stdout += text;
    }
    if (stdout.length > maximumOutputBytes) {
      processError = new PinReleaseShipError("remote-failed", `${label} exceeded its output bound`);
      terminateForFailure();
      resolveReady();
    }
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length <= 64 * 1024) stderr += chunk.toString("utf8");
  });
  child.stdin.on("error", (error) => {
    if (error?.code === "EPIPE" || processError !== null) return;
    processError = new PinReleaseShipError(
      "remote-failed",
      `${label} protected input failed: ${error.message}`,
    );
    terminateForFailure();
    resolveReady();
  });
  void tracked.exit.then(() => resolveReady());
  await withTrackedDeadline(tracked, readyOperation, {
    milliseconds: READY_TIMEOUT_MILLISECONDS,
    timeoutError: () => new PinReleaseShipError(
      "remote-timeout",
      `${label} did not establish its protected input boundary`,
    ),
  });
  if (processError !== null) {
    await (forcedTermination ?? terminateTrackedProcess(tracked, { graceMilliseconds: 1 }));
    throw processError;
  }
  if (!ready) {
    const early = await tracked.exit;
    if (early.error !== null) {
      throw new PinReleaseShipError("remote-failed", `${label} could not start: ${early.error.message}`);
    }
    throw new PinReleaseShipError(
      "remote-failed",
      `${label} exited before its protected input boundary${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
  }
  const outcome = await withTrackedDeadline(tracked, tracked.close, {
    milliseconds: timeoutMilliseconds,
    timeoutError: () => new PinReleaseShipError(
      "remote-timeout",
      `${label} exceeded its fixed post-READY wall-clock deadline`,
    ),
  });
  if (forcedTermination !== null) await forcedTermination;
  if (processError !== null) throw processError;
  if (outcome.error !== null) {
    throw new PinReleaseShipError("remote-failed", `${label} could not start: ${outcome.error.message}`);
  }
  if (outcome.code !== 0 || outcome.signal !== null) {
    throw new PinReleaseShipError(
      "remote-failed",
      `${label} failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
  }
  return stdout;
}

/**
 * Ship over ssh/rsync. The transfer is quiet and each file receives a strict
 * three-attempt budget. The checksum/delta algorithm repairs any existing
 * ciphertext shape (short, corrupt, equal-size corrupt, or too long), while
 * `--partial` keeps useful encrypted blocks in the hidden transaction directory
 * after a transient disconnect. A keyless receiver anchors and fsyncs those
 * bytes; a separate protected claim authenticates and decrypts into an unnamed
 * inode. The apply helper streams and verifies the final size and SHA-256 before
 * the incoming directory can be renamed into the immutable store.
 */
export function createSshTransport({
  remote,
  sshExecutable = FIXED_SSH,
  rsyncExecutable = FIXED_RSYNC,
  rsyncLauncherSource = REMOTE_RSYNC_LAUNCHER_SOURCE,
  stagingScript = REMOTE_STAGING_SCRIPT,
} = {}) {
  if (typeof remote !== "string" || !REMOTE_NAME_RE.test(remote) || remote.startsWith("-")) {
    fail("invalid-remote", `unsafe ssh target: ${String(remote)}`);
  }
  const sshOptions = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
  ];
  // rsync accepts its remote shell as one option value and tokenizes that value
  // itself. Keep the customizable executable deliberately narrower than a shell
  // command: no whitespace, quotes, substitutions, or user-controlled options
  // can enter that tokenization boundary. Host identity and known-host behavior
  // remain ssh's defaults; the same batch/connect/keepalive options used by the
  // helper invocations are carried into every rsync attempt.
  if (
    typeof sshExecutable !== "string" ||
    !/^[A-Za-z0-9_./-]+$/u.test(sshExecutable) ||
    sshExecutable.startsWith("-")
  ) {
    fail("invalid-transport", `unsafe ssh executable for rsync: ${String(sshExecutable)}`);
  }
  if (typeof rsyncLauncherSource !== "string" || rsyncLauncherSource.length === 0) {
    fail("invalid-transport", "a remote rsync launcher source is required");
  }
  const rsyncRemoteShell = [sshExecutable, ...sshOptions].join(" ");
  const runRemote = async ({
    script,
    args = [],
    document,
    label,
    maximumOutputBytes = MAX_REMOTE_REPORT_BYTES,
  }) => {
    if (document !== undefined && document !== null) {
      const source = extractPythonHeredoc(script, label);
      const sourceBase64 = Buffer.from(source, "utf8").toString("base64");
      const bootstrap = "import base64,sys;exec(compile(base64.b64decode(sys.argv.pop(1)),\"<revival-pin-protected>\",\"exec\"))";
      const command = [FIXED_PYTHON, "-I", "-B", "-c", bootstrap, sourceBase64, ...args]
        .map((value) => shellQuote(value))
        .join(" ");
      return await runReadyProcess(
        sshExecutable,
        [...sshOptions, remote, command],
        { document, label, maximumOutputBytes },
      );
    }
    const command = `${FIXED_BASH} -s -- ${args.map((value) => shellQuote(value)).join(" ")}`;
    return await runProcess(sshExecutable, [...sshOptions, remote, command], {
      input: composeRemoteInvocation({ script, document }),
      label,
      maximumOutputBytes,
    });
  };
  return Object.freeze({
    describe: () => `ssh:${remote}`,
    async run({ script, args = [], document, label }) {
      return await runRemote({ script, args, document, label });
    },
    async upload({
      source,
      destination,
      releasesRoot,
      incoming,
      filename,
      size,
      sha256: digest,
      authority,
      label,
    }) {
      if (typeof source !== "string" || !isAbsolute(source) || source.includes("\0")) {
        fail("invalid-upload", `unsafe local upload source: ${String(source)}`);
      }
      // `destination` is an audit assertion, not rsync's authority: the actual
      // endpoint is one protected relative component, and the remote launcher
      // anchors that component to its held incoming-directory descriptor.
      validateRemoteRoot(destination);
      validateRemoteRoot(releasesRoot);
      validateStagingComponent(incoming, "incoming directory name");
      validateStagingComponent(filename, "upload filename");
      if (!Number.isSafeInteger(size) || size < 0 || typeof digest !== "string" || !SHA256_RE.test(digest)) {
        fail("invalid-upload", "upload content authority is malformed");
      }
      if (destination !== `${releasesRoot}/${incoming}/${filename}`) {
        fail("invalid-upload", "upload destination differs from its directory authority");
      }
      if (typeof label !== "string" || label.length === 0 || label.includes("\0")) {
        fail("invalid-upload", "an upload label must be NUL-free text");
      }

      const resumeKey = randomBytes(32).toString("hex");
      const sealedName = encryptedResumeName(filename);
      const envelopeDirectory = await mkdtemp(join(tmpdir(), "revival-pin-rsync-"));
      const sealedSource = join(envelopeDirectory, "payload.sealed");
      const claim = async () => {
        const stdout = await runRemote({
          script: stagingScript,
          args: ["claim", releasesRoot, incoming, encodeFilesystemAuthority({
            ...authority,
            filename,
            sealedName,
            size,
            sha256: digest,
          })],
          document: resumeKey,
          label: `${label} claim`,
          maximumOutputBytes: 64 * 1024,
        });
        return parseFilesystemAuthority(
          parseReport(stdout, `${label} claim`),
          `${label} target`,
        );
      };
      try {
        await runReadyProcess(FIXED_PYTHON, [
          "-I", "-B", "-c",
          extractPythonHeredoc(LOCAL_SEAL_UPLOAD_SCRIPT, `${label} local encryption`),
          source,
          sealedSource,
          String(size),
          digest,
        ], {
          document: resumeKey,
          label: `${label} local encryption`,
          maximumOutputBytes: 64 * 1024,
        });
        const rsyncPath = createRemoteRsyncPath({
          releasesRoot,
          incoming,
          filename,
          sealedName,
          size,
          sha256: digest,
          filesystemAuthority: authority,
          launcherSource: rsyncLauncherSource,
        });
        const argumentsList = [
          ...RSYNC_UPLOAD_OPTIONS,
          `--rsh=${rsyncRemoteShell}`,
          `--rsync-path=${rsyncPath}`,
          "--",
          sealedSource,
          `${remote}:${sealedName}`,
        ];
        let lastError;
        for (let attempt = 1; attempt <= RSYNC_UPLOAD_ATTEMPTS; attempt += 1) {
          try {
            await runProcess(rsyncExecutable, argumentsList, {
              input: "",
              label: `${label} (rsync attempt ${attempt}/${RSYNC_UPLOAD_ATTEMPTS})`,
              maximumOutputBytes: 64 * 1024,
              timeoutMilliseconds: RSYNC_TIMEOUT_MILLISECONDS,
            });
            return await claim();
          } catch (error) {
            lastError = error;
            try {
              return await claim();
            } catch {
              // A failed receiver may retain ciphertext for the next rsync
              // attempt, but never a named plaintext partial.
            }
          }
        }
        const detail = lastError instanceof Error && lastError.message.length > 0
          ? `: ${lastError.message}`
          : "";
        throw new PinReleaseShipError(
          "remote-failed",
          `${label} failed after ${RSYNC_UPLOAD_ATTEMPTS} resumable rsync attempts${detail}`,
        );
      } finally {
        await unlink(sealedSource).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
        await rmdir(envelopeDirectory);
      }
    },
    async makeIncomingDirectory({ releasesRoot, name, authority, filenames }) {
      validateRemoteRoot(releasesRoot);
      validateStagingComponent(name, "incoming directory name");
      if (!name.startsWith(".incoming-")) {
        fail("invalid-upload", "incoming directory name is outside the transaction namespace");
      }
      const path = `${releasesRoot}/${name}`;
      const stdout = await runRemote({
        script: stagingScript,
        args: ["create", releasesRoot, name, encodeFilesystemAuthority({
          ...authority,
          filenames,
        })],
        label: "incoming directory creation",
        maximumOutputBytes: 64 * 1024,
      });
      return Object.freeze({ path, authority: parseStagingAuthority(stdout) });
    },
    async removeIncomingDirectory({ releasesRoot, name, authority }) {
      validateRemoteRoot(releasesRoot);
      validateStagingComponent(name, "incoming directory name");
      await runRemote({
        script: stagingScript,
        args: ["remove", releasesRoot, name, encodeFilesystemAuthority(authority)],
        label: "incoming directory cleanup",
        maximumOutputBytes: 64 * 1024,
      }).catch(() => undefined);
    },
  });
}

/**
 * Ship into a store on this machine — the same helper scripts, run through the
 * local shell. Real when the store is a locally mounted volume, and it is what
 * lets the acceptance suite execute the actual remote helpers without a server.
 */
export function createLocalTransport({
  shellExecutable = FIXED_BASH,
  localUploadScript = LOCAL_UPLOAD_SCRIPT,
} = {}) {
  const runLocal = async ({ script, args = [], document, label }) => {
    if (document !== undefined && document !== null) {
      return await runReadyProcess(
        FIXED_PYTHON,
        ["-I", "-B", "-c", extractPythonHeredoc(script, label), ...args],
        { document, label },
      );
    }
    return await runProcess(shellExecutable, ["-s", "--", ...args], {
      input: composeRemoteInvocation({ script, document }),
      label,
    });
  };
  return Object.freeze({
    describe: () => "file",
    async run({ script, args = [], document, label }) {
      return await runLocal({ script, args, document, label });
    },
    async upload({
      source,
      destination,
      releasesRoot,
      incoming,
      filename,
      size,
      sha256: digest,
      authority,
      label,
    }) {
      if (
        typeof source !== "string" ||
        !isAbsolute(source) ||
        source.includes("\0") ||
        destination !== `${releasesRoot}/${incoming}/${filename}` ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        typeof digest !== "string" ||
        !SHA256_RE.test(digest)
      ) {
        fail("invalid-upload", "local upload authority is malformed");
      }
      const resumeKey = randomBytes(32).toString("hex");
      let lastError;
      for (let attempt = 1; attempt <= RSYNC_UPLOAD_ATTEMPTS; attempt += 1) {
        try {
          const stdout = await runLocal({
            script: localUploadScript,
            args: [
              source,
              releasesRoot,
              incoming,
              filename,
              String(size),
              digest,
              encodeFilesystemAuthority(authority),
            ],
            document: resumeKey,
            label: `${label} (local attempt ${attempt}/${RSYNC_UPLOAD_ATTEMPTS})`,
          });
          return parseFilesystemAuthority(
            parseReport(stdout, `${label} local upload`),
            `${label} target`,
          );
        } catch (error) {
          lastError = error;
        }
      }
      const detail = lastError instanceof Error && lastError.message.length > 0
        ? `: ${lastError.message}`
        : "";
      throw new PinReleaseShipError(
        "remote-failed",
        `${label} failed after ${RSYNC_UPLOAD_ATTEMPTS} resumable local attempts${detail}`,
      );
    },
    async makeIncomingDirectory({ releasesRoot, name, authority, filenames }) {
      validateRemoteRoot(releasesRoot);
      validateStagingComponent(name, "incoming directory name");
      const path = join(releasesRoot, name);
      const stdout = await runLocal({
        script: REMOTE_STAGING_SCRIPT,
        args: ["create", releasesRoot, name, encodeFilesystemAuthority({
          ...authority,
          filenames,
        })],
        label: "incoming directory creation",
      });
      return Object.freeze({ path, authority: parseStagingAuthority(stdout) });
    },
    async removeIncomingDirectory({ releasesRoot, name, authority }) {
      validateRemoteRoot(releasesRoot);
      validateStagingComponent(name, "incoming directory name");
      await runLocal({
        script: REMOTE_STAGING_SCRIPT,
        args: ["remove", releasesRoot, name, encodeFilesystemAuthority(authority)],
        label: "incoming directory cleanup",
      }).catch(() => undefined);
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
 * Plan, and — only with `confirm` — complete it.
 *
 * Without `confirm` this reads both stores and stops. That is deliberate and
 * matches `./revival pin install`: the command that can change something states
 * what it would change and does nothing until it is told twice.
 */
async function shipPinReleaseCore({
  releaseRoot,
  remoteRoot = DEFAULT_REMOTE_RELEASE_ROOT,
  transport,
  confirm = false,
}, { testFixture = false } = {}) {
  validateRemoteRoot(remoteRoot);
  const local = await readLocalPinReleaseStore({ root: releaseRoot });
  if (local.tail === null) fail("nothing-to-ship", "the local Pin release store has no published release");

  const remote = await inspectRemotePinReleaseStore({
    transport,
    remoteRoot,
    releaseIds: [local.tail.releaseId],
  });
  const plan = createPinReleaseShipPlan({ local, remote });

  if (confirm && !testFixture) {
    await reverifyPersistedHostedRelease({
      releaseDirectory: local.releaseDirectory,
      manifest: local.current.manifest,
    });
  }

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
  // Even an already-current confirmation reaches the helper. A preceding
  // directory-fsync error can leave complete new bytes visible but not yet
  // durably acknowledged; replaying the locked CAS and pointer fsyncs is what
  // makes an operator retry close that uncertainty safely.
  const unchanged = plan.alreadyCurrent && plan.uploads.length === 0;

  const releasesRoot = `${remoteRoot}/releases`;
  const incomingName = `.incoming-${plan.releaseId.slice(0, 12)}-${randomBytes(6).toString("hex")}`;
  let created = false;
  let transactionAuthority = plan.authority;
  try {
    if (plan.uploads.length > 0) {
      const staged = await transport.makeIncomingDirectory({
        releasesRoot,
        name: incomingName,
        authority: plan.authority,
        filenames: plan.uploads.map((upload) => upload.name),
      });
      const directory = staged.path;
      transactionAuthority = staged.authority;
      created = true;
      for (const upload of plan.uploads) {
        // The staging directory was safe when it was created, but root or
        // `releases` could have been exchanged before this individual rsync.
        // This separate check is useful early feedback, but grants no authority:
        // every individual rsync attempt re-opens and then HOLDS the complete
        // no-follow parent chain in its own remote server process.
        await transport.run({
          script: REMOTE_STAGING_SCRIPT,
          args: ["validate", releasesRoot, incomingName, encodeFilesystemAuthority({
            ...transactionAuthority,
            filename: upload.name,
          })],
          label: `validate upload ${upload.name}`,
        });
        const targetAuthority = await transport.upload({
          source: upload.source,
          destination: `${directory}/${upload.name}`,
          releasesRoot,
          incoming: incomingName,
          filename: upload.name,
          size: upload.size,
          sha256: upload.sha256,
          authority: transactionAuthority,
          label: `upload ${upload.name}`,
        });
        transactionAuthority = Object.freeze({
          ...transactionAuthority,
          targets: Object.freeze({
            ...transactionAuthority.targets,
            [upload.name]: parseFilesystemAuthority(
              targetAuthority,
              `uploaded target ${upload.name}`,
            ),
          }),
        });
      }
    }
    const stdout = await transport.run({
      script: REMOTE_APPLY_SCRIPT,
      args: [remoteRoot],
      document: createApplyPayload(plan, incomingName, transactionAuthority),
      label: "remote release publication",
    });
    const result = parseReport(stdout, "remote release publication");
    const expectedReleaseEntries = Object.fromEntries(
      plan.entries.map((entry) => [entry.name, { size: entry.size, sha256: entry.sha256 }]),
    );
    const acknowledgedEntries = isRecord(result?.releaseEntries) ? result.releaseEntries : null;
    const entriesMatch = acknowledgedEntries !== null &&
      Object.keys(acknowledgedEntries).sort().join("\0") ===
        Object.keys(expectedReleaseEntries).sort().join("\0") &&
      Object.entries(expectedReleaseEntries).every(([name, expected]) => {
        const actual = acknowledgedEntries[name];
        return isRecord(actual) && actual.size === expected.size && actual.sha256 === expected.sha256;
      });
    if (
      result?.applied !== true ||
      result.releaseId !== plan.releaseId ||
      result.historySha256 !== sha256(plan.historyDocument) ||
      result.currentSha256 !== sha256(plan.currentDocument) ||
      !entriesMatch
    ) {
      fail("apply-failed", "the remote helper did not confirm the published release");
    }
    created = false;
    return Object.freeze({ ...summary, applied: true, unchanged });
  } finally {
    if (created) {
      await transport.removeIncomingDirectory({
        releasesRoot,
        name: incomingName,
        authority: transactionAuthority,
      });
    }
  }
}

export async function shipPinRelease(options) {
  if (process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES === "1") {
    fail("test-mode", "authoritative ship rejects explicit synthetic fixture mode");
  }
  return await shipPinReleaseCore(options);
}

/**
 * Transaction fixture for local and loopback/fake-SSH transport coverage. Both
 * roots must remain beneath the OS temporary directory; authoritative
 * CLI/module entrypoints reject the enabling mode and always run cryptographic
 * reverify, so this cannot select a production store even when a test exercises
 * the real SSH framing code.
 */
export async function shipPinReleaseFixture(options) {
  const temporary = resolve(tmpdir());
  const withinTemporary = (candidate) => {
    const selected = resolve(candidate);
    return selected !== temporary && selected.startsWith(`${temporary}/`);
  };
  if (
    process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES !== "1" ||
    !withinTemporary(options.releaseRoot) || !withinTemporary(options.remoteRoot ?? "")
  ) fail("test-fixture-disabled", "ship fixture is restricted to explicit temporary-root test mode");
  return await shipPinReleaseCore(options, { testFixture: true });
}

/* ------------------------------------------------------------------- CLI --- */

function help() {
  process.stdout.write(
    "Usage: ./revival pin release ship [--remote NAME | --local] [--remote-root PATH]\n" +
    "                                  [--release-root DIR] [--confirm] [--json]\n" +
    "\nCopies the release the attested hosted workflow published locally into the store\n" +
    "Center serves from, so the in-browser installer can reach it. Without --confirm it\n" +
    "reads both stores, prints the plan, and changes nothing. It never runs a deploy and\n" +
    "never touches a device. A confirmed ship re-verifies the manifest-bound hosted\n" +
    "pre/post Sigstore bundles and exact five APKs before any remote mutation.\n",
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
