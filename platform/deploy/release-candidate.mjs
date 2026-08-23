#!/usr/bin/env node

/**
 * Immutable VPS release candidates.
 *
 * A candidate is a content-addressed directory, not a recipe.  Its descriptor
 * binds the already-packaged VPS source and the already-exported Docker image
 * archive.  Verification is deliberately filesystem-only: it never invokes
 * Docker, Git, a shell, or candidate-controlled code.
 */

import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export const CANDIDATE_SCHEMA = "revival.release-candidate";
export const CANDIDATE_SCHEMA_VERSION = 4;
export const MAX_DESCRIPTOR_BYTES = 2 * 1024 * 1024;
export const MAX_JSON_RECEIPT_BYTES = 8 * 1024 * 1024;
export const MAX_RELEASE_ARCHIVE_BYTES = 1024 * 1024 * 1024;
export const MAX_IMAGE_BUNDLE_BYTES = 32 * 1024 * 1024 * 1024;
export const MAX_SOURCE_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_RELEASE_TREE_BYTES = 1024 * 1024 * 1024;
export const MAX_DOCKER_METADATA_BYTES = 128 * 1024 * 1024;
export const SHA256 = /^[0-9a-f]{64}$/u;
export const DOCKER_SHA256 = /^sha256:[0-9a-f]{64}$/u;
export const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
export const LOCAL_CANDIDATE_AUTHORITY = Object.freeze({
  origin: "local-operator",
  productionUse: "candidate-only",
});
export const HOSTED_CANDIDATE_AUTHORITY = Object.freeze({
  origin: "github-hosted-actions",
  productionUse: "requires-point-of-use-provider-evidence",
});

const HELD_RELEASE_PREFIX = Object.freeze([
  "--held-release-root-fd",
  "--held-release-manifest-fd",
  "--held-release-id",
]);
const HELD_RELEASE_MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
const HELD_RELEASE_PROGRAM_MAX_BYTES = 2 * 1024 * 1024;
const REQUIRED_MEMFD_SEALS = 0x0001 | 0x0002 | 0x0004 | 0x0008;

function heldFailure(message) {
  throw new Error(`held candidate verifier refusal: ${message}`);
}

function canonicalFd(value, label) {
  if (!/^[1-9][0-9]*$/u.test(value ?? "") || !Number.isSafeInteger(Number(value)) || Number(value) <= 2) {
    heldFailure(`${label} is not one canonical inherited descriptor`);
  }
  return Number(value);
}

function readHeldDescriptor(descriptor, metadata, maximum, label) {
  if (metadata.size > BigInt(maximum) || metadata.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    heldFailure(`${label} exceeds its fixed size limit`);
  }
  const bytes = Buffer.alloc(Number(metadata.size));
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count === 0) heldFailure(`${label} was truncated while reading`);
    offset += count;
  }
  const after = fs.fstatSync(descriptor, { bigint: true });
  if (["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink", "mode", "uid", "gid"]
    .some((field) => after[field] !== metadata[field])) heldFailure(`${label} changed while reading`);
  return bytes;
}

function requireSealedModule(descriptor, label) {
  // Node exposes fstat but not Linux F_GET_SEALS. Ask the already-required
  // system Python to inspect an inherited duplicate at child fd 3; no pathname
  // is reopened and candidate-controlled code is never evaluated.
  const python = "/usr/bin/python3";
  try {
    if (!fs.statSync(python).isFile()) heldFailure("the trusted memfd seal inspector is unavailable");
  } catch { heldFailure("the trusted memfd seal inspector is unavailable"); }
  const script = [
    "import fcntl,os,stat",
    `required=${REQUIRED_MEMFD_SEALS}`,
    "value=os.fstat(3)",
    "assert stat.S_ISREG(value.st_mode) and value.st_nlink==0",
    "assert fcntl.fcntl(3,fcntl.F_GET_SEALS)&required==required",
  ].join(";");
  const result = childProcess.spawnSync(python, ["-I", "-B", "-c", script], {
    env: { HOME: "/nonexistent", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/usr/sbin", TZ: "UTC" },
    stdio: ["ignore", "ignore", "pipe", descriptor],
  });
  if (result.error || result.status !== 0) heldFailure(`${label} is not a fully write-sealed memfd`);
}

function heldFileDigest(file, maximum, expectedMode) {
  const before = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!before || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      before.size > BigInt(maximum) || Number(before.mode & 0o777n) !== expectedMode) {
    heldFailure("the release-root verifier entry has unsafe metadata");
  }
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const fields = ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink", "mode", "uid", "gid"];
    if (fields.some((field) => opened[field] !== before[field])) heldFailure("the release-root verifier moved before open");
    const bytes = readHeldDescriptor(descriptor, opened, maximum, "release-root verifier");
    const rebound = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!rebound || fields.some((field) => rebound[field] !== before[field])) heldFailure("the release-root verifier moved while reading");
    return { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  } finally { fs.closeSync(descriptor); }
}

function heldReleaseInvocation(argv) {
  const mainPath = process.argv[1] ?? "";
  const mainMatch = /^\/proc\/self\/fd\/([1-9][0-9]*)$/u.exec(mainPath);
  const modulePath = fileURLToPath(import.meta.url);
  const moduleMatch = /^\/proc\/self\/fd\/([1-9][0-9]*)$/u.exec(modulePath);
  const mentionsHeldMode = argv.some((value) => HELD_RELEASE_PREFIX.includes(value) ||
    String(value).startsWith("--held-release-"));
  if (!mainMatch || !moduleMatch) {
    if (mentionsHeldMode) heldFailure("held authority flags require a proc-self main descriptor");
    return { argv, root: null };
  }
  if (!process.execArgv.includes("--preserve-symlinks-main")) {
    heldFailure("sealed Node execution requires --preserve-symlinks-main");
  }
  if (argv.length < 6 || argv[0] !== HELD_RELEASE_PREFIX[0] ||
      argv[2] !== HELD_RELEASE_PREFIX[1] || argv[4] !== HELD_RELEASE_PREFIX[2]) {
    heldFailure("held authority flags are missing or out of order");
  }
  const mainFd = canonicalFd(mainMatch[1], "main verifier descriptor");
  const moduleFd = canonicalFd(moduleMatch[1], "candidate verifier module descriptor");
  const rootFd = canonicalFd(argv[1], "release root descriptor");
  const manifestFd = canonicalFd(argv[3], "release manifest descriptor");
  const releaseId = argv[5];
  const descriptorCount = moduleFd === mainFd ? 3 : 4;
  if (!SHA256.test(releaseId ?? "") ||
      new Set([mainFd, moduleFd, rootFd, manifestFd]).size !== descriptorCount) {
    heldFailure("held descriptors or release identity are aliased or invalid");
  }
  const main = fs.fstatSync(mainFd, { bigint: true });
  const module = fs.fstatSync(moduleFd, { bigint: true });
  const root = fs.fstatSync(rootFd, { bigint: true });
  const manifest = fs.fstatSync(manifestFd, { bigint: true });
  const uid = BigInt(process.getuid?.() ?? Number(main.uid));
  const gid = BigInt(process.getgid?.() ?? Number(main.gid));
  if (!main.isFile() || main.isSymbolicLink() || main.nlink !== 0n ||
      ![0o644, 0o755].includes(Number(main.mode & 0o777n)) || main.uid !== uid || main.gid !== gid) {
    heldFailure("main release program descriptor type or ownership is invalid");
  }
  if (!module.isFile() || module.isSymbolicLink() || module.nlink !== 0n ||
      ![0o644, 0o755].includes(Number(module.mode & 0o777n)) || module.uid !== uid || module.gid !== gid) {
    heldFailure("candidate verifier module descriptor type or ownership is invalid");
  }
  if (!root.isDirectory() || root.isSymbolicLink() || ![0o700, 0o755].includes(Number(root.mode & 0o777n)) ||
      root.uid !== uid || root.gid !== gid) heldFailure("release root descriptor type or ownership is invalid");
  if (!manifest.isFile() || manifest.isSymbolicLink() || manifest.nlink !== 1n ||
      Number(manifest.mode & 0o777n) !== 0o600 || manifest.uid !== uid || manifest.gid !== gid) {
    heldFailure("release manifest descriptor type or ownership is invalid");
  }
  requireSealedModule(mainFd, "main release program");
  if (moduleFd !== mainFd) {
    if (!process.execArgv.includes("--preserve-symlinks")) {
      heldFailure("sealed candidate verifier imports require --preserve-symlinks");
    }
    requireSealedModule(moduleFd, "candidate verifier module");
  }
  const manifestBytes = readHeldDescriptor(manifestFd, manifest, HELD_RELEASE_MANIFEST_MAX_BYTES, "release manifest");
  let document;
  try { document = JSON.parse(manifestBytes.toString("utf8")); }
  catch { heldFailure("release manifest is not valid JSON"); }
  if (!document || typeof document !== "object" || Array.isArray(document) ||
      Object.keys(document).sort().join(",") !== "entries,profile,releaseId,schemaVersion" ||
      document.schemaVersion !== 1 || document.profile !== "vps" || document.releaseId !== releaseId ||
      !Array.isArray(document.entries)) heldFailure("release manifest schema or requested identity differs");
  const body = { schemaVersion: document.schemaVersion, profile: document.profile, entries: document.entries };
  if (crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex") !== releaseId) {
    heldFailure("release manifest does not reproduce the requested release identity");
  }
  const verifierPath = "platform/deploy/release-candidate.mjs";
  const rootPath = `/proc/self/fd/${rootFd}`;
  const matches = document.entries.filter((entry) => entry?.path === verifierPath);
  if (matches.length !== 1 || Object.keys(matches[0]).sort().join(",") !== "mode,path,sha256,size" ||
      !SHA256.test(matches[0].sha256 ?? "") || !Number.isSafeInteger(matches[0].size) ||
      !["0644", "0755"].includes(matches[0].mode)) {
    heldFailure("release manifest candidate-verifier entry is invalid");
  }
  const verifierBytes = readHeldDescriptor(moduleFd, module, matches[0].size, "sealed candidate verifier");
  if (verifierBytes.length !== matches[0].size ||
      crypto.createHash("sha256").update(verifierBytes).digest("hex") !== matches[0].sha256 ||
      Number(module.mode & 0o777n) !== Number.parseInt(matches[0].mode, 8)) {
    heldFailure("sealed candidate verifier differs from the release manifest");
  }
  const rootVerifier = heldFileDigest(path.join(rootPath, ...verifierPath.split("/")),
    matches[0].size, Number.parseInt(matches[0].mode, 8));
  if (rootVerifier.size !== matches[0].size || rootVerifier.sha256 !== matches[0].sha256) {
    heldFailure("release root and sealed verifier differ from the manifest");
  }
  if (moduleFd !== mainFd) {
    const mainBytes = readHeldDescriptor(mainFd, main, HELD_RELEASE_PROGRAM_MAX_BYTES, "main release program");
    const mainSha256 = crypto.createHash("sha256").update(mainBytes).digest("hex");
    const mainMatches = document.entries.filter((entry) => entry &&
      Object.keys(entry).sort().join(",") === "mode,path,sha256,size" &&
      entry.path !== verifierPath && typeof entry.path === "string" && !entry.path.startsWith("/") &&
      !entry.path.includes("\\") && entry.path.split("/").every((part) => part && part !== "." && part !== "..") &&
      entry.sha256 === mainSha256 && entry.size === mainBytes.length &&
      Number.parseInt(entry.mode, 8) === Number(main.mode & 0o777n));
    if (mainMatches.length !== 1) heldFailure("main release program is not uniquely bound by the release manifest");
    const rootMain = heldFileDigest(path.join(rootPath, ...mainMatches[0].path.split("/")),
      mainMatches[0].size, Number.parseInt(mainMatches[0].mode, 8));
    if (rootMain.size !== mainMatches[0].size || rootMain.sha256 !== mainMatches[0].sha256) {
      heldFailure("release root and sealed main program differ from the manifest");
    }
  }
  return { argv: argv.slice(6), root: rootPath, releaseId };
}

const HELD_RELEASE = heldReleaseInvocation(process.argv.slice(2));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = HELD_RELEASE.root ?? path.resolve(HERE, "..", "..");
const DEFAULT_DATA_DIR = path.resolve(
  process.env.REVIVAL_DATA_DIR ??
    path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "ai-pin-revival"),
);

function siblingServiceDataPath(protectedRoot, serviceFamily) {
  return path.posix.join(path.posix.dirname(protectedRoot), `${serviceFamily}-center-data`);
}

const PROTECTED_PRODUCTION_ROOT = "/home/anders/ai-pin-revival";
const PRODUCTION_AUTHORITY_PATH = "platform/deploy/production-compose-authority.json";
const CANDIDATE_STORE_HELPER = path.join(ROOT, "platform/deploy/candidate-store.py");
const COMPOSE_AUTHORITY_INPUTS = Object.freeze([
  "compose.yaml",
  "platform/compose/production.yaml",
]);

export const PAYLOAD_SPECS = Object.freeze([
  Object.freeze({ role: "release-archive", basename: "release.tar.gz", mediaType: "application/gzip", maxBytes: MAX_RELEASE_ARCHIVE_BYTES }),
  Object.freeze({ role: "release-manifest", basename: "release.manifest.json", mediaType: "application/vnd.ai-pin-revival.release-manifest+json", releaseJson: true, maxBytes: MAX_JSON_RECEIPT_BYTES }),
  Object.freeze({ role: "release-descriptor", basename: "release.json", mediaType: "application/vnd.ai-pin-revival.release-descriptor+json", json: true, maxBytes: MAX_JSON_RECEIPT_BYTES }),
  Object.freeze({ role: "release-verifier", basename: "verify-release.py", mediaType: "text/x-python", maxBytes: 2 * 1024 * 1024 }),
  Object.freeze({ role: "source-snapshot", basename: "source-snapshot.tar", mediaType: "application/x-tar", maxBytes: MAX_SOURCE_ARCHIVE_BYTES }),
  Object.freeze({ role: "source-commit-object", basename: "source-commit.txt", mediaType: "application/vnd.git.commit", maxBytes: 2 * 1024 * 1024 }),
  Object.freeze({ role: "source-snapshot-receipt", basename: "source-receipt.json", mediaType: "application/vnd.ai-pin-revival.source-receipt+json", json: true, maxBytes: MAX_JSON_RECEIPT_BYTES }),
  Object.freeze({ role: "production-compose-model", basename: "compose-model.json", mediaType: "application/vnd.ai-pin-revival.production-compose-model+json", json: true, maxBytes: MAX_JSON_RECEIPT_BYTES }),
  Object.freeze({ role: "production-state-contract", basename: "production-state.json", mediaType: "application/vnd.ai-pin-revival.production-state+json", json: true, maxBytes: MAX_JSON_RECEIPT_BYTES }),
  Object.freeze({ role: "toolchain-receipt", basename: "toolchain-receipt.json", mediaType: "application/vnd.ai-pin-revival.toolchain-receipt+json", json: true, maxBytes: MAX_JSON_RECEIPT_BYTES }),
  Object.freeze({ role: "docker-image-receipt", basename: "image-receipt.json", mediaType: "application/vnd.ai-pin-revival.docker-image-receipt+json", json: true, maxBytes: MAX_JSON_RECEIPT_BYTES }),
  Object.freeze({ role: "docker-image-bundle", basename: "images.tar", mediaType: "application/vnd.docker.image.rootfs.diff.tar", maxBytes: MAX_IMAGE_BUNDLE_BYTES }),
]);

export const CANDIDATE_BASENAME = "candidate.json";
export const EXPECTED_CANDIDATE_FILES = Object.freeze([
  CANDIDATE_BASENAME,
  ...PAYLOAD_SPECS.map((entry) => entry.basename),
].sort());

export const LEGACY_PRODUCTION_STATE = deepFreeze({
  schema: "revival.production-state-contract",
  schemaVersion: 2,
  runtimeProject: "ai-pin-revival",
  projectFamily: "humane-carry-clone",
  storageFamily: "humane-carry-clone",
  volumes: [
    "humane-carry-clone_carry-pgdata",
    "humane-carry-clone_carry-state",
    "humane-carry-clone_grafana-data",
    "humane-carry-clone_prometheus-data",
  ],
  externalNetworks: ["humane-carry-clone_carry-local"],
  centerDataPath: siblingServiceDataPath(PROTECTED_PRODUCTION_ROOT, "carry"),
  protectedRoot: PROTECTED_PRODUCTION_ROOT,
});

// These are the tempting resources emitted by the undeployed legacy-to-Cosmos
// rename.  Naming them explicitly in the closed production authority makes the
// negative half of the bridge reviewable: a generated candidate cannot merely
// omit the known-good legacy names and let Compose auto-create empty replacements.
export const FORBIDDEN_RENAMED_PRODUCTION_RESOURCES = deepFreeze({
  centerDataPaths: ["/home/anders/cosmos-center-data"],
  networks: ["humane-cosmos-clone_cosmos-local"],
  projects: ["humane-cosmos-clone"],
  stateTargets: ["/var/lib/cosmos"],
  volumes: [
    "humane-cosmos-clone_cosmos-pgdata",
    "humane-cosmos-clone_cosmos-state",
    "humane-cosmos-clone_grafana-data",
    "humane-cosmos-clone_prometheus-data",
  ],
});

const REQUIRED_TOOLCHAINS = Object.freeze([
  "cargo",
  "docker",
  "docker-buildx",
  "git",
  "node",
  "npm",
  "rustc",
]);

export const FIRST_PARTY_IMAGES = Object.freeze([
  Object.freeze({ component: "cosmos", context: "cosmos", dockerfile: "Dockerfile", additionalContext: "wire_contracts=contracts/wire" }),
  Object.freeze({ component: "center", context: "center", dockerfile: "Dockerfile", additionalContext: "wire_contracts=contracts/wire" }),
  Object.freeze({ component: "spotify-adapter", context: "center/adapters/spotify", dockerfile: "Dockerfile" }),
]);

export const THIRD_PARTY_IMAGES = Object.freeze([
  "quay.io/keycloak/keycloak:26.0@sha256:09a381c715ab0b111835b70f2905955274843a219c6f27efb348e4d9f4086858",
  "searxng/searxng@sha256:f4c8e59de166ed71f6380c0847c312ca51f0d41996e31d0559163b6b09ecde52",
  "envoyproxy/envoy:v1.31-latest@sha256:caa5b411be1633b90023592a34a7e010c933d6e60206c758f631485e53006865",
  "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777",
  "prom/prometheus:v2.54.1@sha256:f6639335d34a77d9d9db382b92eeb7fc00934be8eae81dbc03b31cfe90411a94",
  "grafana/grafana:11.2.0@sha256:408afb9726de5122b00a2576763a8a57a3c86d5b0eff5305bc994ceb3eb96c3f",
  "node:22.18.0-alpine3.22@sha256:1b2479dd35a99687d6638f5976fd235e26c5b37e8122f786fcd5fe231d63de5b",
]);

export const SERVICE_IMAGE_ROLES = deepFreeze({
  account: "cosmos",
  "ai-bus": "cosmos",
  center: "center",
  connectivity: "cosmos",
  contacts: "cosmos",
  edge: "envoy",
  "feature-flags": "cosmos",
  grafana: "grafana",
  keycloak: "keycloak",
  "notable-events": "cosmos",
  postgres: "postgres",
  prometheus: "prometheus",
  provisioning: "cosmos",
  searxng: "searxng",
  "spotify-adapter": "spotify-adapter",
});

const THIRD_PARTY_IMAGE_ROLES = deepFreeze({
  keycloak: 0,
  searxng: 1,
  envoy: 2,
  postgres: 3,
  prometheus: 4,
  grafana: 5,
  "backup-helper": 6,
});

const OCI_INDEX_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const OCI_MANIFEST_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
const OCI_CONFIG_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.container.image.v1+json",
]);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function fail(message, code = "CANDIDATE_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a JSON object`);
  }
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has unsupported or missing fields`);
  }
}

function assertString(value, pattern, label, maxLength = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength ||
      /[\u0000-\u001f\u007f]/u.test(value) || (pattern && !pattern.test(value))) {
    fail(`${label} is invalid`);
  }
}

function sortedUnique(values, label) {
  if (!Array.isArray(values) || values.length === 0) fail(`${label} must be a nonempty array`);
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0 && String(values[index - 1]).localeCompare(String(values[index])) >= 0) {
      fail(`${label} must be sorted and duplicate-free`);
    }
  }
}

export function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("canonical JSON only permits safe integers");
    return value;
  }
  if (typeof value !== "object") fail("canonical JSON contains an unsupported value");
  if (seen.has(value)) fail("canonical JSON contains a cycle");
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry) => canonicalize(entry, seen));
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) fail("canonical JSON requires plain objects");
    result = {};
    for (const key of Object.keys(value).sort()) {
      if (!key || /[\u0000-\u001f\u007f]/u.test(key)) fail("canonical JSON contains an invalid key");
      result[key] = canonicalize(value[key], seen);
    }
  }
  seen.delete(value);
  return result;
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function canonicalJsonBytes(value) {
  return Buffer.from(`${canonicalStringify(value)}\n`, "utf8");
}

export function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function candidateIdForBody(body) {
  return sha256Bytes(Buffer.from(canonicalStringify(body), "utf8"));
}

function parseCanonicalJson(buffer, label) {
  if (!Buffer.isBuffer(buffer)) fail(`${label} must be bytes`);
  if (buffer.includes(0)) fail(`${label} contains a NUL byte`);
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
  const expected = canonicalJsonBytes(parsed);
  if (!buffer.equals(expected)) fail(`${label} is not recursively canonical JSON`);
  return parsed;
}

function parseReleaseJson(buffer, label) {
  let parsed;
  try { parsed = JSON.parse(buffer.toString("utf8")); } catch { fail(`${label} is not valid JSON`); }
  if (!buffer.equals(Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8"))) {
    fail(`${label} is not in the release packager's canonical JSON form`);
  }
  return parsed;
}

function roleMap(files) {
  if (!Array.isArray(files) || files.length !== PAYLOAD_SPECS.length) fail("candidate file inventory has the wrong size");
  const roles = new Map();
  for (const file of files) {
    assertExactKeys(file, ["basename", "mediaType", "role", "sha256", "size"], "candidate file entry");
    assertString(file.role, /^[a-z0-9-]+$/u, "candidate file role", 80);
    assertString(file.basename, /^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "candidate file basename", 128);
    assertString(file.mediaType, /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u, "candidate file media type", 160);
    if (!SHA256.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) fail("candidate file digest or size is invalid");
    if (roles.has(file.role)) fail("candidate file roles must be unique");
    roles.set(file.role, file);
  }
  const sortedRoles = files.map((entry) => entry.role);
  if (sortedRoles.some((role, index) => index > 0 && sortedRoles[index - 1].localeCompare(role) >= 0)) {
    fail("candidate file inventory must be sorted by role");
  }
  for (const spec of PAYLOAD_SPECS) {
    const entry = roles.get(spec.role);
    if (!entry || entry.basename !== spec.basename || entry.mediaType !== spec.mediaType || entry.size > spec.maxBytes) {
      fail(`candidate file inventory does not match fixed role ${spec.role}`);
    }
  }
  return roles;
}

function validateProductionState(contract) {
  assertExactKeys(contract, ["centerDataPath", "externalNetworks", "projectFamily", "protectedRoot", "runtimeProject", "schema", "schemaVersion", "storageFamily", "volumes"], "production-state contract");
  if (contract.schema !== "revival.production-state-contract" || contract.schemaVersion !== 2) fail("production-state contract schema is unsupported");
  for (const key of ["projectFamily", "runtimeProject", "storageFamily"]) assertString(contract[key], /^[a-z0-9][a-z0-9-]*$/u, `production-state ${key}`, 128);
  for (const key of ["centerDataPath", "protectedRoot"]) {
    assertString(contract[key], /^\/[A-Za-z0-9._/-]+$/u, `production-state ${key}`, 512);
    if (path.posix.normalize(contract[key]) !== contract[key] || contract[key].includes("//")) fail(`production-state ${key} is not canonical`);
  }
  for (const [key, pattern] of [["volumes", /^[A-Za-z0-9][A-Za-z0-9_.-]+$/u], ["externalNetworks", /^[A-Za-z0-9][A-Za-z0-9_.-]+$/u]]) {
    sortedUnique(contract[key], `production-state ${key}`);
    for (const entry of contract[key]) assertString(entry, pattern, `production-state ${key} entry`, 256);
  }
}

export function productionCompatibilityDifferences(actual, expected = LEGACY_PRODUCTION_STATE) {
  validateProductionState(actual);
  validateProductionState(expected);
  const differences = [];
  for (const key of ["runtimeProject", "projectFamily", "storageFamily", "centerDataPath", "protectedRoot"]) {
    if (actual[key] !== expected[key]) differences.push({ field: key, expected: expected[key], actual: actual[key] });
  }
  for (const key of ["volumes", "externalNetworks"]) {
    if (canonicalStringify(actual[key]) !== canonicalStringify(expected[key])) {
      differences.push({ field: key, expected: expected[key], actual: actual[key] });
    }
  }
  return differences;
}

export function assertLegacyProductionCompatible(actual) {
  const differences = productionCompatibilityDifferences(actual);
  if (differences.length > 0) {
    const error = new Error(`candidate production-state is incompatible with the live legacy production contract (${differences.map((entry) => entry.field).join(", ")}); refusal occurs before upload or Docker/runtime mutation`);
    error.code = "PRODUCTION_STATE_INCOMPATIBLE";
    error.differences = differences;
    throw error;
  }
  return true;
}

function validateToolchainReceipt(receipt) {
  assertExactKeys(receipt, ["platform", "schema", "schemaVersion", "tools"], "toolchain receipt");
  if (receipt.schema !== "revival.toolchain-receipt" || receipt.schemaVersion !== 1 || receipt.platform !== "linux/amd64") {
    fail("toolchain receipt schema or platform is unsupported");
  }
  sortedUnique(receipt.tools.map((tool) => tool?.name), "toolchain names");
  const names = [];
  for (const tool of receipt.tools) {
    assertExactKeys(tool, ["name", "sha256", "version"], "toolchain entry");
    assertString(tool.name, /^[a-z0-9-]+$/u, "toolchain name", 64);
    assertString(tool.version, /^[^\r\n\u0000]{1,512}$/u, "toolchain version", 512);
    if (!SHA256.test(tool.sha256)) fail("toolchain executable digest is invalid");
    names.push(tool.name);
  }
  if (canonicalStringify(names) !== canonicalStringify(REQUIRED_TOOLCHAINS)) fail("toolchain receipt is incomplete");
}

function explicitDockerTag(reference) {
  const base = reference.includes("@") ? reference.slice(0, reference.lastIndexOf("@")) : reference;
  return base.lastIndexOf(":") > base.lastIndexOf("/") ? base : `${base}:latest`;
}

function trustedThirdPartyInventory(value = THIRD_PARTY_IMAGES) {
  if (!Array.isArray(value) || value.length !== THIRD_PARTY_IMAGES.length) fail("trusted third-party image policy must contain exactly seven references");
  for (const reference of value) assertString(reference, /^[A-Za-z0-9][A-Za-z0-9._/:@-]+@sha256:[0-9a-f]{64}$/u, "trusted third-party image reference", 512);
  if (new Set(value).size !== value.length) fail("trusted third-party image policy contains duplicates");
  return value;
}

function expectedImageReferences(releaseId, thirdPartyImages = THIRD_PARTY_IMAGES) {
  return [
    ...FIRST_PARTY_IMAGES.map(({ component }) => ({
      bundleReference: `ai-pin-revival/${component}:${releaseId}`,
      component,
      firstParty: true,
      reference: `ai-pin-revival/${component}:${releaseId}`,
    })),
    ...trustedThirdPartyInventory(thirdPartyImages).map((reference) => ({
      bundleReference: explicitDockerTag(reference),
      component: null,
      firstParty: false,
      reference,
    })),
  ].sort((left, right) => left.reference.localeCompare(right.reference));
}

function imageRoleReferences(releaseId, thirdPartyImages = THIRD_PARTY_IMAGES) {
  if (!SHA256.test(releaseId)) fail("production Compose model release ID is invalid");
  const thirdParty = trustedThirdPartyInventory(thirdPartyImages);
  return {
    cosmos: `ai-pin-revival/cosmos:${releaseId}`,
    center: `ai-pin-revival/center:${releaseId}`,
    "spotify-adapter": `ai-pin-revival/spotify-adapter:${releaseId}`,
    ...Object.fromEntries(Object.entries(THIRD_PARTY_IMAGE_ROLES)
      .map(([role, index]) => [role, thirdParty[index]])),
  };
}

function receiptImageIds(imageReceipt) {
  if (imageReceipt === undefined) return null;
  if (!imageReceipt || !Array.isArray(imageReceipt.images)) fail("production Compose model requires a Docker image receipt");
  const result = new Map();
  for (const image of imageReceipt.images) {
    if (!image || typeof image.reference !== "string" || !DOCKER_SHA256.test(image.imageId) || result.has(image.reference)) {
      fail("production Compose model image receipt mapping is invalid");
    }
    result.set(image.reference, image.imageId);
  }
  return result;
}

function canonicalServiceImages(releaseId, thirdPartyImages = THIRD_PARTY_IMAGES, imageReceipt) {
  const references = imageRoleReferences(releaseId, thirdPartyImages);
  const imageIds = receiptImageIds(imageReceipt);
  return Object.fromEntries(Object.entries(SERVICE_IMAGE_ROLES).sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([service, role]) => {
      const reference = references[role];
      const imageId = imageIds?.get(reference) ?? `sha256:${"0".repeat(64)}`;
      if (imageIds && !imageIds.has(reference)) fail(`production Compose model differs from exact image role/reference: missing ${role}`);
      return [service, { imageId, reference, role }];
    }));
}

function productionServiceImageTemplates() {
  const marker = "0".repeat(64);
  return Object.fromEntries(Object.entries(canonicalServiceImages(marker, THIRD_PARTY_IMAGES))
    .map(([service, mapping]) => [service, {
      reference: mapping.reference.replace(marker, "{releaseId}"),
      role: mapping.role,
    }]));
}

function defaultProductionAuthorityBinding() {
  const selected = readAuthorityFile(ROOT, PRODUCTION_AUTHORITY_PATH);
  let authority;
  try { authority = JSON.parse(selected.bytes.toString("utf8")); }
  catch { fail("trusted production Compose authority is invalid JSON"); }
  return { authoritySha256: selected.sha256, composeFiles: structuredClone(authority.composeFiles) };
}

export function createProductionComposeModel({
  releaseId,
  authoritySha256,
  composeFiles,
  trustedThirdPartyImages = THIRD_PARTY_IMAGES,
  imageReceipt,
} = {}) {
  const defaults = authoritySha256 && composeFiles ? null : defaultProductionAuthorityBinding();
  const model = {
    schema: "revival.production-compose-model",
    schemaVersion: 1,
    releaseId,
    authority: {
      path: PRODUCTION_AUTHORITY_PATH,
      sha256: authoritySha256 ?? defaults.authoritySha256,
    },
    composeFiles: structuredClone(composeFiles ?? defaults.composeFiles),
    services: canonicalServiceImages(releaseId, trustedThirdPartyImages, imageReceipt),
  };
  validateProductionComposeModel(model, releaseId, trustedThirdPartyImages, imageReceipt);
  return model;
}

function validateProductionComposeModel(model, releaseId,
                                        thirdPartyImages = THIRD_PARTY_IMAGES, imageReceipt) {
  assertExactKeys(model, ["authority", "composeFiles", "releaseId", "schema", "schemaVersion", "services"], "production Compose model");
  if (model.schema !== "revival.production-compose-model" || model.schemaVersion !== 1 ||
      model.releaseId !== releaseId || !SHA256.test(model.releaseId)) {
    fail("production Compose model schema or release binding is invalid");
  }
  assertExactKeys(model.authority, ["path", "sha256"], "production Compose model authority");
  if (model.authority.path !== PRODUCTION_AUTHORITY_PATH || !SHA256.test(model.authority.sha256)) {
    fail("production Compose model authority binding is invalid");
  }
  assertExactKeys(model.composeFiles, COMPOSE_AUTHORITY_INPUTS, "production Compose model source files");
  if (Object.values(model.composeFiles).some((digest) => !SHA256.test(digest))) {
    fail("production Compose model source digest is invalid");
  }
  const expected = canonicalServiceImages(releaseId, thirdPartyImages, imageReceipt);
  assertExactKeys(model.services, Object.keys(expected), "production Compose model services");
  for (const [service, mapping] of Object.entries(model.services)) {
    assertExactKeys(mapping, ["imageId", "reference", "role"], `production Compose model service ${service}`);
    if (!DOCKER_SHA256.test(mapping.imageId) || mapping.reference !== expected[service].reference ||
        mapping.role !== expected[service].role || (imageReceipt && mapping.imageId !== expected[service].imageId)) {
      fail(`production Compose model service ${service} differs from its exact image role/reference`);
    }
  }
  return model;
}

function registryBytes(record, label) {
  assertExactKeys(record, ["bytesBase64", "digest", "mediaType", "size"], label);
  assertString(record.bytesBase64, /^[A-Za-z0-9+/]*={0,2}$/u, `${label} bytes`, MAX_JSON_RECEIPT_BYTES);
  if (!DOCKER_SHA256.test(record.digest) || !Number.isSafeInteger(record.size) || record.size <= 0 || record.size > MAX_JSON_RECEIPT_BYTES) fail(`${label} descriptor is invalid`);
  assertString(record.mediaType, /^application\/[a-z0-9.+-]+$/u, `${label} media type`, 160);
  const bytes = Buffer.from(record.bytesBase64, "base64");
  if (bytes.toString("base64") !== record.bytesBase64 || bytes.length !== record.size || `sha256:${sha256Bytes(bytes)}` !== record.digest) {
    fail(`${label} raw preimage does not reproduce its exact descriptor`);
  }
  let document;
  try { document = JSON.parse(bytes.toString("utf8")); }
  catch { fail(`${label} raw preimage is invalid JSON`); }
  return { bytes, document };
}

function registryClosure(image) {
  assertExactKeys(image.registry, ["index", "manifest"], "third-party registry provenance");
  const index = registryBytes(image.registry.index, "registry index");
  const manifest = registryBytes(image.registry.manifest, "registry platform manifest");
  if (image.registry.index.digest !== image.sourceDigest || !OCI_INDEX_MEDIA_TYPES.has(image.registry.index.mediaType) ||
      index.document?.mediaType !== image.registry.index.mediaType ||
      !OCI_MANIFEST_MEDIA_TYPES.has(image.registry.manifest.mediaType)) fail("third-party registry provenance has an unsupported digest or media type");
  if (index.document?.schemaVersion !== 2 || !Array.isArray(index.document.manifests)) fail("registry index has an unsupported structure");
  const arm64 = index.document.manifests.filter((descriptor) => descriptor?.platform?.os === "linux" && descriptor?.platform?.architecture === "arm64");
  if (arm64.length !== 1) fail("registry index does not select exactly one linux/arm64 child manifest");
  const selected = arm64[0];
  if (selected.digest !== image.registry.manifest.digest || selected.size !== image.registry.manifest.size ||
      selected.mediaType !== image.registry.manifest.mediaType || !DOCKER_SHA256.test(selected.digest) ||
      ![undefined, "", "v8"].includes(selected.platform.variant)) fail("registry index child descriptor does not bind the sealed linux/arm64 manifest");
  if (manifest.document?.schemaVersion !== 2 || (manifest.document.mediaType !== undefined && manifest.document.mediaType !== image.registry.manifest.mediaType) ||
      !Array.isArray(manifest.document.layers) || manifest.document.layers.length === 0) fail("registry platform manifest has an unsupported structure");
  const config = manifest.document.config;
  if (!config || !DOCKER_SHA256.test(config.digest) || config.digest !== image.imageId || !Number.isSafeInteger(config.size) || config.size <= 0 ||
      !OCI_CONFIG_MEDIA_TYPES.has(config.mediaType)) fail("registry platform manifest config descriptor does not bind the sealed image ID");
  for (const layer of manifest.document.layers) {
    if (!layer || !DOCKER_SHA256.test(layer.digest) || !Number.isSafeInteger(layer.size) || layer.size <= 0 ||
        typeof layer.mediaType !== "string" || !/^application\/vnd\.(?:oci|docker)\./u.test(layer.mediaType)) fail("registry platform manifest has an invalid layer descriptor");
  }
  return { config, layers: manifest.document.layers };
}

export function verifyThirdPartyRegistryEvidence(reference, registry) {
  if (!THIRD_PARTY_IMAGES.includes(reference)) fail("third-party registry evidence is outside the fixed production inventory");
  const rawManifest = registryBytes(registry?.manifest, "registry platform manifest").document;
  const sourceDigest = reference.slice(reference.lastIndexOf("@") + 1);
  const imageId = rawManifest?.config?.digest;
  if (!DOCKER_SHA256.test(imageId)) fail("registry platform manifest lacks a valid config image ID");
  registryClosure({ imageId, registry, sourceDigest });
  return true;
}

function validateImageReceipt(receipt, releaseId, bundleFile, git, thirdPartyImages = THIRD_PARTY_IMAGES) {
  assertExactKeys(receipt, ["bundle", "images", "platform", "schema", "schemaVersion", "targetPlatform"], "Docker image receipt");
  if (receipt.schema !== "revival.docker-image-receipt" || receipt.schemaVersion !== 4 ||
      receipt.platform !== "linux/amd64" || receipt.targetPlatform !== "linux/arm64") {
    fail("Docker image receipt schema or platform is unsupported");
  }
  assertExactKeys(receipt.bundle, ["sha256", "size"], "Docker image bundle receipt");
  if (receipt.bundle.sha256 !== bundleFile.sha256 || receipt.bundle.size !== bundleFile.size) fail("Docker image bundle receipt does not bind candidate bytes");
  const expected = expectedImageReferences(releaseId, thirdPartyImages);
  if (!Array.isArray(receipt.images) || receipt.images.length !== expected.length) {
    fail("Docker image receipt does not contain the exact fixed ten-image inventory");
  }
  const imageIds = new Set();
  for (let index = 0; index < receipt.images.length; index += 1) {
    const image = receipt.images[index];
    const wanted = expected[index];
    assertExactKeys(image, ["bundleReference", "component", "firstParty", "imageId", "labels", "platform", "reference", "registry", "sourceDigest"], "Docker image entry");
    assertString(image.reference, /^[A-Za-z0-9][A-Za-z0-9._/:@-]+$/u, "Docker image reference", 512);
    assertString(image.bundleReference, /^[A-Za-z0-9][A-Za-z0-9._/:-]+$/u, "Docker bundle reference", 512);
    if (image.reference !== wanted.reference || image.bundleReference !== wanted.bundleReference ||
        image.component !== wanted.component || image.firstParty !== wanted.firstParty) {
      fail("Docker image receipt differs from the exact fixed reference inventory");
    }
    if (!DOCKER_SHA256.test(image.imageId) || imageIds.has(image.imageId)) fail("Docker image IDs must be unique sha256 values");
    imageIds.add(image.imageId);
    if (image.platform !== "linux/arm64") fail("Docker image platform is invalid");
    if (image.firstParty) {
      if (image.sourceDigest !== null || image.registry !== null) fail("first-party image must not claim third-party registry provenance");
      assertExactKeys(image.labels, ["dk.andersmadsen.ai-pin-revival.component", "dk.andersmadsen.ai-pin-revival.product", "dk.andersmadsen.ai-pin-revival.release", "dk.andersmadsen.ai-pin-revival.source-commit", "dk.andersmadsen.ai-pin-revival.source-tree", "org.opencontainers.image.revision"], "first-party image labels");
      if (image.labels["dk.andersmadsen.ai-pin-revival.product"] !== "Ai Pin Revival" ||
          image.labels["dk.andersmadsen.ai-pin-revival.component"] !== image.component ||
          image.labels["dk.andersmadsen.ai-pin-revival.release"] !== releaseId ||
          image.labels["dk.andersmadsen.ai-pin-revival.source-commit"] !== git.commit ||
          image.labels["dk.andersmadsen.ai-pin-revival.source-tree"] !== git.tree ||
          image.labels["org.opencontainers.image.revision"] !== git.commit) fail("first-party image labels do not bind the release, source, and component");
    } else {
      if (image.component !== null || image.labels !== null || !DOCKER_SHA256.test(image.sourceDigest)) fail("third-party image provenance is invalid");
      if (!image.reference.endsWith(`@${image.sourceDigest}`) || explicitDockerTag(image.reference) !== image.bundleReference) {
        fail("third-party image is not pinned to its exact recorded source digest and local bundle tag");
      }
      registryClosure(image);
    }
  }
}

const TAR_BLOCK_BYTES = 512;

function tarString(header, offset, length, label) {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  const value = field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
  if (value.includes("\ufffd") || /[\u0000-\u001f\u007f\\]/u.test(value)) fail(`invalid tar ${label}`);
  return value;
}

function tarOctal(header, offset, length, label) {
  const raw = header.subarray(offset, offset + length).toString("ascii").replace(/\0.*$/u, "").trim();
  if (!/^[0-7]+$/u.test(raw)) fail(`invalid tar ${label}`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail(`invalid tar ${label}`);
  return value;
}

function tarChecksum(header) {
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  return copy.reduce((sum, byte) => sum + byte, 0);
}

function validateTarPath(value, label, { directory = false } = {}) {
  const normalized = directory && value.endsWith("/") ? value.slice(0, -1) : value;
  assertString(normalized, null, label, 4096);
  if (normalized.startsWith("/") || normalized.includes("//") || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    fail(`${label} is unsafe or non-canonical`);
  }
  return normalized;
}

function bufferReader(buffer) {
  return {
    size: buffer.length,
    read(offset, length) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) fail("tar read is outside the archive");
      return Buffer.from(buffer.subarray(offset, offset + length));
    },
  };
}

function fileReader(file, maxBytes) {
  const before = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!before || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maxBytes)) fail("tar source is not one bounded regular file");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const opened = fs.fstatSync(descriptor, { bigint: true });
  if (statIdentity(opened) !== statIdentity(before)) { fs.closeSync(descriptor); fail("tar source changed before open"); }
  return {
    size: Number(opened.size),
    read(offset, length) {
      const result = Buffer.alloc(length);
      let consumed = 0;
      while (consumed < length) {
        const count = fs.readSync(descriptor, result, consumed, length - consumed, offset + consumed);
        if (count === 0) fail("tar source was truncated while reading");
        consumed += count;
      }
      if (statIdentity(fs.fstatSync(descriptor, { bigint: true })) !== statIdentity(opened)) fail("tar source changed while reading");
      return result;
    },
    close() {
      const afterOpen = fs.fstatSync(descriptor, { bigint: true });
      fs.closeSync(descriptor);
      const after = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
      if (!after || statIdentity(afterOpen) !== statIdentity(opened) || statIdentity(after) !== statIdentity(before)) fail("tar source changed during verification");
    },
  };
}

function parseTarIndex(reader, { allowGlobalPax = false, captureJson = false } = {}) {
  if (!Number.isSafeInteger(reader.size) || reader.size < TAR_BLOCK_BYTES * 2 || reader.size % TAR_BLOCK_BYTES !== 0) fail("tar archive has an invalid bounded size");
  const entries = new Map();
  let capturedBytes = 0;
  let offset = 0;
  let sawEnd = false;
  let globalPax = null;
  while (offset + TAR_BLOCK_BYTES <= reader.size) {
    const header = reader.read(offset, TAR_BLOCK_BYTES);
    offset += TAR_BLOCK_BYTES;
    if (header.every((byte) => byte === 0)) {
      sawEnd = true;
      break;
    }
    if (tarChecksum(header) !== tarOctal(header, 148, 8, "checksum")) fail("tar header checksum mismatch");
    const typeByte = header[156];
    const regular = typeByte === 0 || typeByte === 0x30;
    const directory = typeByte === 0x35;
    const pax = allowGlobalPax && typeByte === 0x67;
    if (!regular && !directory && !pax) fail("tar archive contains a link or unsupported special entry");
    const name = tarString(header, 0, 100, "name");
    const prefix = tarString(header, 345, 155, "prefix");
    const entryPath = validateTarPath(prefix ? `${prefix}/${name}` : name, "tar entry path", { directory });
    if (entries.has(entryPath)) fail(`tar archive contains duplicate path: ${entryPath}`);
    const size = tarOctal(header, 124, 12, "size");
    if (directory && size !== 0) fail("tar directory has nonzero content");
    const padded = size + ((TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES);
    if (!Number.isSafeInteger(padded) || offset + padded > reader.size) fail(`tar entry is truncated: ${entryPath}`);
    let data = null;
    if (pax) {
      if (globalPax !== null || entryPath !== "pax_global_header" || size > 1024 * 1024) fail("source archive has an unsupported global PAX header");
      globalPax = reader.read(offset, size);
    } else if (regular && captureJson && (entryPath === "manifest.json" || entryPath === "repositories" || entryPath.endsWith(".json") || entryPath.endsWith("/json") || entryPath.endsWith("/VERSION"))) {
      if (size > MAX_JSON_RECEIPT_BYTES || capturedBytes + size > MAX_DOCKER_METADATA_BYTES) fail("Docker image archive metadata exceeds its limit");
      data = reader.read(offset, size);
      capturedBytes += size;
    }
    if (!pax) entries.set(entryPath, { data, directory, mode: tarOctal(header, 100, 8, "mode"), offset, size });
    offset += padded;
  }
  if (!sawEnd) fail("tar archive has no end marker");
  while (offset < reader.size) {
    const length = Math.min(1024 * 1024, reader.size - offset);
    if (reader.read(offset, length).some((byte) => byte !== 0)) fail("tar archive contains trailing nonzero data");
    offset += length;
  }
  Object.defineProperty(entries, "globalPax", { enumerable: false, value: globalPax });
  return entries;
}

function jsonFromTar(entries, name, label) {
  const entry = entries.get(name);
  if (!entry || entry.directory || !Buffer.isBuffer(entry.data)) fail(`${label} is missing from the Docker image archive`);
  let value;
  try { value = JSON.parse(entry.data.toString("utf8")); } catch { fail(`${label} is invalid JSON`); }
  return { entry, value };
}

function verifyDockerBundleReader(reader, imageReceipt) {
  const entries = parseTarIndex(reader, { captureJson: true });
  const { value: manifest } = jsonFromTar(entries, "manifest.json", "Docker save manifest");
  if (!Array.isArray(manifest) || manifest.length !== imageReceipt.images.length) fail("Docker save manifest does not contain the exact ten-image receipt inventory");
  const expectedByTag = new Map(imageReceipt.images.map((image) => [image.bundleReference, image]));
  const allowedFiles = new Set(["manifest.json"]);
  const repositoryBindings = new Map();
  if (!entries.has("repositories")) fail("Docker save archive lacks mandatory repositories metadata");
  allowedFiles.add("repositories");
  const seen = new Set();
  for (const item of manifest) {
    assertExactKeys(item, ["Config", "Layers", "RepoTags"], "Docker save manifest entry");
    if (!Array.isArray(item.RepoTags) || item.RepoTags.length !== 1 || typeof item.RepoTags[0] !== "string") fail("Docker save image must carry exactly one sealed tag");
    const bundleReference = item.RepoTags[0];
    const expected = expectedByTag.get(bundleReference);
    if (!expected || seen.has(bundleReference)) fail("Docker save tag inventory differs from the sealed receipt");
    seen.add(bundleReference);
    const configPath = validateTarPath(item.Config, "Docker image config path");
    if (configPath !== `${expected.imageId.slice("sha256:".length)}.json`) fail("Docker image config path does not match its sealed image ID");
    const { entry: configEntry, value: config } = jsonFromTar(entries, configPath, "Docker image config");
    if (`sha256:${sha256Bytes(configEntry.data)}` !== expected.imageId) fail("Docker image config bytes do not match the sealed image ID");
    if (config?.architecture !== "arm64" || config?.os !== "linux") fail("Docker image config platform is not linux/arm64");
    if (expected.firstParty) {
      const labels = config?.config?.Labels;
      if (!labels || Object.entries(expected.labels).some(([key, value]) => labels[key] !== value)) fail("Docker image config labels do not match the release receipt");
    }
    if (!Array.isArray(item.Layers) || item.Layers.length === 0) fail("Docker image manifest has no layers");
    const diffIds = config?.rootfs?.diff_ids;
    if (config?.rootfs?.type !== "layers" || !Array.isArray(diffIds) || diffIds.length !== item.Layers.length) {
      fail("Docker image config does not bind its exact layer inventory");
    }
    if (!expected.firstParty) {
      const closure = registryClosure(expected);
      if (closure.config.size !== configEntry.size || closure.layers.length !== diffIds.length) {
        fail("third-party registry manifest does not bind the Docker config size and ordered layer count");
      }
    }
    allowedFiles.add(configPath);
    for (let layerIndex = 0; layerIndex < item.Layers.length; layerIndex += 1) {
      const layer = item.Layers[layerIndex];
      const layerPath = validateTarPath(layer, "Docker image layer path");
      const layerEntry = entries.get(layerPath);
      if (!layerEntry || layerEntry.directory) fail("Docker image manifest names a missing layer");
      if (!DOCKER_SHA256.test(diffIds[layerIndex])) fail("Docker image config contains an invalid layer DiffID");
      const layerHash = crypto.createHash("sha256");
      for (let layerOffset = 0; layerOffset < layerEntry.size; layerOffset += 1024 * 1024) {
        layerHash.update(reader.read(layerEntry.offset + layerOffset, Math.min(1024 * 1024, layerEntry.size - layerOffset)));
      }
      if (`sha256:${layerHash.digest("hex")}` !== diffIds[layerIndex]) fail("Docker layer bytes do not reproduce the sealed image DiffID");
      allowedFiles.add(layerPath);
      const directory = path.posix.dirname(layerPath);
      if (directory !== ".") {
        const versionPath = `${directory}/VERSION`;
        const legacyPath = `${directory}/json`;
        const version = entries.get(versionPath);
        if (!version || version.directory || !Buffer.isBuffer(version.data) || !version.data.equals(Buffer.from("1.0\n", "ascii"))) {
          fail("Docker legacy layer VERSION metadata is missing or not exactly 1.0");
        }
        const { value: legacy } = jsonFromTar(entries, legacyPath, "Docker legacy layer metadata");
        assertPlainObject(legacy, "Docker legacy layer metadata");
        const expectedParent = layerIndex === 0 ? null : path.posix.dirname(item.Layers[layerIndex - 1]);
        if (legacy.id !== directory || (expectedParent === null ? (Object.hasOwn(legacy, "parent") && legacy.parent !== "") : legacy.parent !== expectedParent)) {
          fail("Docker legacy layer metadata ID/parent chain differs from manifest order");
        }
        allowedFiles.add(versionPath);
        allowedFiles.add(legacyPath);
      }
    }
    const separator = bundleReference.lastIndexOf(":");
    if (separator <= bundleReference.lastIndexOf("/") || separator === bundleReference.length - 1) fail(`Docker bundle reference has no explicit tag: ${bundleReference}`);
    const repository = bundleReference.slice(0, separator);
    const tag = bundleReference.slice(separator + 1);
    if (repositoryBindings.has(repository) && repositoryBindings.get(repository).has(tag)) fail("Docker repository metadata would duplicate a sealed tag");
    if (!repositoryBindings.has(repository)) repositoryBindings.set(repository, new Map());
    repositoryBindings.get(repository).set(tag, path.posix.dirname(item.Layers.at(-1)));
  }
  if (seen.size !== expectedByTag.size) fail("Docker save archive is missing a sealed image reference");
  {
    const { value: repositories } = jsonFromTar(entries, "repositories", "Docker repositories metadata");
    assertPlainObject(repositories, "Docker repositories metadata");
    const expectedRepositories = [...repositoryBindings.keys()].sort();
    if (canonicalStringify(Object.keys(repositories).sort()) !== canonicalStringify(expectedRepositories)) {
      fail("Docker repositories metadata contains an extra or missing repository");
    }
    for (const repository of expectedRepositories) {
      assertPlainObject(repositories[repository], `Docker repositories metadata for ${repository}`);
      const expectedTags = [...repositoryBindings.get(repository).keys()].sort();
      if (canonicalStringify(Object.keys(repositories[repository]).sort()) !== canonicalStringify(expectedTags)) {
        fail("Docker repositories metadata contains an extra or missing tag");
      }
      for (const tag of expectedTags) {
        if (repositories[repository][tag] !== repositoryBindings.get(repository).get(tag)) {
          fail("Docker repositories metadata does not bind the sealed tag to its final layer");
        }
      }
    }
  }
  const allowedDirectories = new Set();
  for (const name of allowedFiles) {
    let parent = path.posix.dirname(name);
    while (parent !== ".") { allowedDirectories.add(parent); parent = path.posix.dirname(parent); }
  }
  for (const [name, entry] of entries) {
    if (entry.directory ? !allowedDirectories.has(name) : !allowedFiles.has(name)) fail(`Docker save archive contains unreferenced content: ${name}`);
  }
  return true;
}

function verifyDockerBundlePath(file, imageReceipt) {
  const reader = fileReader(file, MAX_IMAGE_BUNDLE_BYTES);
  try {
    const hash = crypto.createHash("sha256");
    let offset = 0;
    while (offset < reader.size) {
      const length = Math.min(1024 * 1024, reader.size - offset);
      hash.update(reader.read(offset, length));
      offset += length;
    }
    if (reader.size !== imageReceipt.bundle.size || hash.digest("hex") !== imageReceipt.bundle.sha256) fail("Docker image archive bytes differ from the sealed receipt");
    return verifyDockerBundleReader(reader, imageReceipt);
  } finally { reader.close(); }
}

function verifyDockerBundleBuffer(buffer, imageReceipt) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_IMAGE_BUNDLE_BYTES) fail("Docker image archive is oversized");
  return verifyDockerBundleReader(bufferReader(buffer), imageReceipt);
}

function gitAlgorithm(objectId) {
  if (!GIT_OBJECT_ID.test(objectId)) fail("Git object ID uses an unsupported format");
  return objectId.length === 40 ? "sha1" : "sha256";
}

function gitObjectHash(algorithm, type, size, chunks) {
  const hash = crypto.createHash(algorithm);
  hash.update(Buffer.from(`${type} ${size}\0`, "ascii"));
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
}

function treeNode() {
  return { directories: new Map(), files: new Map() };
}

function addGitFile(root, entryPath, mode, objectId) {
  const parts = entryPath.split("/");
  let node = root;
  for (const part of parts.slice(0, -1)) {
    if (node.files.has(part)) fail("source archive has a file/directory collision");
    if (!node.directories.has(part)) node.directories.set(part, treeNode());
    node = node.directories.get(part);
  }
  const name = parts.at(-1);
  if (node.files.has(name) || node.directories.has(name)) fail("source archive has a duplicate Git path");
  node.files.set(name, { mode, objectId });
}

function hashGitTree(node, algorithm) {
  const records = [
    ...[...node.files].map(([name, entry]) => ({ directory: false, mode: entry.mode, name, objectId: entry.objectId })),
    ...[...node.directories].map(([name, child]) => ({ directory: true, mode: "40000", name, objectId: hashGitTree(child, algorithm) })),
  ].sort((left, right) => Buffer.compare(
    Buffer.from(`${left.name}${left.directory ? "/" : ""}`, "utf8"),
    Buffer.from(`${right.name}${right.directory ? "/" : ""}`, "utf8"),
  ));
  const chunks = records.map((record) => Buffer.concat([
    Buffer.from(`${record.mode} ${record.name}\0`, "utf8"),
    Buffer.from(record.objectId, "hex"),
  ]));
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return gitObjectHash(algorithm, "tree", size, chunks);
}

function parsePaxGlobal(buffer, expectedCommit) {
  if (buffer === null) return;
  let offset = 0;
  const fields = new Map();
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) fail("source archive PAX record is malformed");
    const lengthText = buffer.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/u.test(lengthText)) fail("source archive PAX record length is invalid");
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > buffer.length || buffer[offset + length - 1] !== 0x0a) fail("source archive PAX record is truncated");
    const payload = buffer.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = payload.indexOf("=");
    if (equals <= 0 || payload.includes("\ufffd")) fail("source archive PAX field is invalid");
    const key = payload.slice(0, equals);
    if (fields.has(key)) fail("source archive PAX field is duplicated");
    fields.set(key, payload.slice(equals + 1));
    offset += length;
  }
  if (fields.size !== 1 || fields.get("comment") !== expectedCommit) fail("source archive PAX commit marker differs from the sealed commit");
}

function sourceTreeFromReader(reader, algorithm, expectedCommit) {
  const entries = parseTarIndex(reader, { allowGlobalPax: true });
  parsePaxGlobal(entries.globalPax, expectedCommit);
  const root = treeNode();
  const explicitDirectories = new Set();
  const requiredDirectories = new Set();
  for (const [entryPath, entry] of entries) {
    if (entry.directory) {
      explicitDirectories.add(entryPath);
      continue;
    }
    let parent = path.posix.dirname(entryPath);
    while (parent !== ".") { requiredDirectories.add(parent); parent = path.posix.dirname(parent); }
    const mode = (entry.mode & 0o111) === 0 ? "100644" : "100755";
    const hash = crypto.createHash(algorithm);
    hash.update(Buffer.from(`blob ${entry.size}\0`, "ascii"));
    let offset = 0;
    while (offset < entry.size) {
      const length = Math.min(1024 * 1024, entry.size - offset);
      hash.update(reader.read(entry.offset + offset, length));
      offset += length;
    }
    addGitFile(root, entryPath, mode, hash.digest("hex"));
  }
  if (canonicalStringify([...explicitDirectories].sort()) !== canonicalStringify([...requiredDirectories].sort())) fail("source archive directory inventory is not the exact Git tree closure");
  return hashGitTree(root, algorithm);
}

function verifySourceProvenance(root, receipt, enforceStorePolicy) {
  const commitObject = readRegularFile(root, "source-commit.txt", 2 * 1024 * 1024, { enforceStorePolicy });
  const algorithm = gitAlgorithm(receipt.commit);
  if (gitAlgorithm(receipt.tree) !== algorithm) fail("source commit and tree object formats differ");
  if (gitObjectHash(algorithm, "commit", commitObject.length, [commitObject]) !== receipt.commit) fail("source commit-object bytes do not reproduce the sealed commit ID");
  const headerEnd = commitObject.indexOf(Buffer.from("\n\n", "ascii"));
  if (headerEnd < 0) fail("source commit object has no header boundary");
  const headers = commitObject.subarray(0, headerEnd).toString("utf8").split("\n");
  if (headers[0] !== `tree ${receipt.tree}` || headers.filter((line) => line.startsWith("tree ")).length !== 1) fail("source commit object does not name the sealed tree");
  const reader = fileReader(path.join(root, "source-snapshot.tar"), MAX_SOURCE_ARCHIVE_BYTES);
  try {
    const archiveHash = crypto.createHash("sha256");
    for (let offset = 0; offset < reader.size; offset += 1024 * 1024) archiveHash.update(reader.read(offset, Math.min(1024 * 1024, reader.size - offset)));
    if (archiveHash.digest("hex") !== receipt.archiveSha256) fail("source-snapshot.tar bytes differ from their independently recomputable receipt");
    if (sourceTreeFromReader(reader, algorithm, receipt.commit) !== receipt.tree) fail("source-snapshot.tar does not reproduce the sealed Git tree");
  } finally { reader.close(); }
}

function hashFilesystemBlob(file, algorithm) {
  const before = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!before || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(MAX_SOURCE_ARCHIVE_BYTES)) fail("tracked source is not one bounded regular file", "CANDIDATE_PREPARE_FAILED");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const opened = fs.fstatSync(descriptor, { bigint: true });
  if (statIdentity(opened) !== statIdentity(before)) { fs.closeSync(descriptor); fail("tracked source moved before hashing", "CANDIDATE_PREPARE_FAILED"); }
  const hash = crypto.createHash(algorithm);
  hash.update(Buffer.from(`blob ${opened.size}\0`, "ascii"));
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    if (BigInt(offset) !== opened.size || statIdentity(fs.fstatSync(descriptor, { bigint: true })) !== statIdentity(opened)) fail("tracked source moved while hashing", "CANDIDATE_PREPARE_FAILED");
  } finally { fs.closeSync(descriptor); }
  const after = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!after || statIdentity(after) !== statIdentity(before)) fail("tracked source moved during hashing", "CANDIDATE_PREPARE_FAILED");
  return hash.digest("hex");
}

function assertSourceArchiveTree(file, commit, expectedTree) {
  const reader = fileReader(file, MAX_SOURCE_ARCHIVE_BYTES);
  try {
    if (sourceTreeFromReader(reader, gitAlgorithm(expectedTree), commit) !== expectedTree) fail("git archive bytes differ from the exact committed source tree", "CANDIDATE_PREPARE_FAILED");
  } finally { reader.close(); }
}

function splitUstarPath(value) {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= 100) return { name: value, prefix: "" };
  for (let index = value.lastIndexOf("/"); index > 0; index = value.lastIndexOf("/", index - 1)) {
    const prefix = value.slice(0, index);
    const name = value.slice(index + 1);
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) return { name, prefix };
  }
  fail(`source path cannot be represented in a deterministic ustar archive: ${value}`, "CANDIDATE_PREPARE_FAILED");
}

function writeTarField(header, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) fail("source tar header field is too long", "CANDIDATE_PREPARE_FAILED");
  bytes.copy(header, offset);
}

function writeTarNumber(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 2, "0");
  if (encoded.length > length - 2) fail("source tar numeric field is too large", "CANDIDATE_PREPARE_FAILED");
  writeTarField(header, offset, length, `${encoded}\0`);
}

function deterministicTarHeader(entryPath, mode, size, directory) {
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  const { name, prefix } = splitUstarPath(directory ? `${entryPath}/` : entryPath);
  writeTarField(header, 0, 100, name);
  writeTarNumber(header, 100, 8, mode);
  writeTarNumber(header, 108, 8, 0);
  writeTarNumber(header, 116, 8, 0);
  writeTarNumber(header, 124, 12, size);
  writeTarNumber(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = directory ? 0x35 : 0x30;
  writeTarField(header, 257, 6, "ustar\0");
  writeTarField(header, 263, 2, "00");
  writeTarField(header, 345, 155, prefix);
  writeTarField(header, 148, 8, `${tarChecksum(header).toString(8).padStart(6, "0")}\0 `);
  return header;
}

function listGitTree(commit, gitEnv, repositoryRoot = ROOT) {
  const result = childProcess.spawnSync(commandPath("git"), ["ls-tree", "-r", "-z", "--full-tree", commit], { cwd: repositoryRoot, env: gitEnv, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) fail("Git tree inventory could not be captured", "CANDIDATE_PREPARE_FAILED");
  const records = result.stdout.toString("utf8").split("\0");
  if (records.at(-1) !== "") fail("Git tree inventory is not NUL terminated", "CANDIDATE_PREPARE_FAILED");
  records.pop();
  return records.map((record) => {
    const match = record.match(/^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/u);
    if (!match) fail("Git tree contains an unsupported object type or mode", "CANDIDATE_PREPARE_FAILED");
    return { mode: match[1], objectId: match[2], path: validateTarPath(match[3], "Git tree path") };
  });
}

export function createRawGitArchive(commit, destination, gitEnv, repositoryRoot = ROOT) {
  const files = listGitTree(commit, gitEnv, repositoryRoot);
  const batch = childProcess.spawnSync(commandPath("git"), ["cat-file", "--batch"], {
    cwd: repositoryRoot,
    env: gitEnv,
    input: Buffer.from(`${files.map((file) => file.objectId).join("\n")}\n`, "ascii"),
    maxBuffer: MAX_SOURCE_ARCHIVE_BYTES,
  });
  if (batch.error || batch.status !== 0 || !Buffer.isBuffer(batch.stdout)) fail("Git blob objects could not be captured", "CANDIDATE_PREPARE_FAILED");
  let offset = 0;
  const blobs = new Map();
  for (const file of files) {
    const newline = batch.stdout.indexOf(0x0a, offset);
    if (newline < 0) fail("Git blob batch response is truncated", "CANDIDATE_PREPARE_FAILED");
    const header = batch.stdout.subarray(offset, newline).toString("ascii").match(/^([0-9a-f]{40}|[0-9a-f]{64}) blob ([0-9]+)$/u);
    if (!header || header[1] !== file.objectId) fail("Git blob batch response changed object identity", "CANDIDATE_PREPARE_FAILED");
    const size = Number.parseInt(header[2], 10);
    offset = newline + 1;
    if (!Number.isSafeInteger(size) || size < 0 || offset + size >= batch.stdout.length || batch.stdout[offset + size] !== 0x0a) fail("Git blob batch response has an invalid size", "CANDIDATE_PREPARE_FAILED");
    const data = Buffer.from(batch.stdout.subarray(offset, offset + size));
    if (gitObjectHash(gitAlgorithm(file.objectId), "blob", data.length, [data]) !== file.objectId) fail("Git returned blob bytes that do not reproduce their object ID", "CANDIDATE_PREPARE_FAILED");
    blobs.set(file.objectId, data);
    offset += size + 1;
  }
  if (offset !== batch.stdout.length) fail("Git blob batch response has trailing data", "CANDIDATE_PREPARE_FAILED");
  const directories = new Set();
  for (const file of files) {
    let parent = path.posix.dirname(file.path);
    while (parent !== ".") { directories.add(parent); parent = path.posix.dirname(parent); }
  }
  const records = [
    ...[...directories].map((entryPath) => ({ directory: true, path: entryPath })),
    ...files.map((file) => ({ ...file, data: blobs.get(file.objectId), directory: false })),
  ].sort((left, right) => Buffer.compare(Buffer.from(`${left.path}${left.directory ? "/" : ""}`), Buffer.from(`${right.path}${right.directory ? "/" : ""}`)));
  const chunks = [];
  for (const record of records) {
    const data = record.data ?? Buffer.alloc(0);
    chunks.push(deterministicTarHeader(record.path, record.directory ? 0o755 : record.mode === "100755" ? 0o755 : 0o644, data.length, record.directory));
    if (!record.directory) chunks.push(data, Buffer.alloc((TAR_BLOCK_BYTES - (data.length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK_BYTES * 2));
  const archive = Buffer.concat(chunks);
  if (archive.length > MAX_SOURCE_ARCHIVE_BYTES) fail("raw Git source archive exceeds its bound", "CANDIDATE_PREPARE_FAILED");
  writeExclusive(destination, archive);
  return files;
}

function extractSourceArchive(archivePath, destination, expectedCommit, expectedTree) {
  const rootDescriptor = destination;
  fs.fchmodSync(rootDescriptor, 0o700);
  requirePrivateDirectory(rootDescriptor, "extracted source root");
  const reader = fileReader(archivePath, MAX_SOURCE_ARCHIVE_BYTES);
  const directories = new Map([["", rootDescriptor]]);
  const ensureDirectory = (relative) => {
    if (directories.has(relative)) return directories.get(relative);
    let parent = "";
    for (const component of relative.split("/")) {
      const next = parent ? `${parent}/${component}` : component;
      if (!directories.has(next)) {
        const parentDescriptor = directories.get(parent);
        const child = descriptorPath(parentDescriptor, component);
        fs.mkdirSync(child, { mode: 0o755 });
        const created = fs.lstatSync(child, { bigint: true });
        const descriptor = fs.openSync(child, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW ?? 0));
        fs.fchmodSync(descriptor, 0o755);
        const metadata = fs.fstatSync(descriptor, { bigint: true });
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== BigInt(process.getuid()) ||
            metadata.gid !== BigInt(process.getgid()) || Number(metadata.mode & 0o777n) !== 0o755 ||
            metadata.dev !== created.dev || metadata.ino !== created.ino) {
          fs.closeSync(descriptor);
          fail("extracted source directory authority is unsafe", "CANDIDATE_PREPARE_FAILED");
        }
        directories.set(next, descriptor);
      }
      parent = next;
    }
    return directories.get(relative);
  };
  let succeeded = false;
  try {
    if (sourceTreeFromReader(reader, gitAlgorithm(expectedTree), expectedCommit) !== expectedTree) fail("raw Git source archive does not reproduce the selected tree", "CANDIDATE_PREPARE_FAILED");
    const entries = parseTarIndex(reader, { allowGlobalPax: true });
    for (const [entryPath, entry] of entries) {
      if (entry.directory) {
        ensureDirectory(entryPath);
      } else {
        const parent = path.posix.dirname(entryPath);
        const parentDescriptor = ensureDirectory(parent === "." ? "" : parent);
        const target = descriptorPath(parentDescriptor, path.posix.basename(entryPath));
        const data = reader.read(entry.offset, entry.size);
        writeExclusive(target, data, (entry.mode & 0o111) === 0 ? 0o644 : 0o755);
      }
    }
    succeeded = true;
    return rootDescriptor;
  } finally {
    reader.close();
    for (const [name, descriptor] of [...directories].reverse()) {
      if (name) try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function assertExtractedSourceMatches(archivePath, sourceRoot, expectedCommit, expectedTree) {
  const reader = fileReader(archivePath, MAX_SOURCE_ARCHIVE_BYTES);
  try {
    const entries = parseTarIndex(reader, { allowGlobalPax: true });
    const seen = new Set();
    const root = treeNode();
    const walk = (directory, relative = "") => {
      for (const name of fs.readdirSync(directory).sort()) {
        const child = path.join(directory, name);
        const childRelative = relative ? `${relative}/${name}` : name;
        const stat = fs.lstatSync(child, { throwIfNoEntry: false });
        const expected = entries.get(childRelative);
        if (!stat || stat.isSymbolicLink() || !expected || stat.isDirectory() !== expected.directory || (!stat.isDirectory() && !stat.isFile())) fail("extracted source contains an extra or unsafe build-context entry", "CANDIDATE_PREPARE_FAILED");
        seen.add(childRelative);
        if (stat.isDirectory()) {
          walk(child, childRelative);
        } else {
          const mode = (stat.mode & 0o111) === 0 ? "100644" : "100755";
          const expectedMode = (expected.mode & 0o111) === 0 ? "100644" : "100755";
          if (mode !== expectedMode || stat.size !== expected.size) fail("extracted source mode or size differs from the sealed archive", "CANDIDATE_PREPARE_FAILED");
          const actualId = hashFilesystemBlob(child, gitAlgorithm(expectedTree));
          const archiveData = reader.read(expected.offset, expected.size);
          const archiveId = gitObjectHash(gitAlgorithm(expectedTree), "blob", archiveData.length, [archiveData]);
          if (actualId !== archiveId) fail("extracted source bytes differ from the sealed archive", "CANDIDATE_PREPARE_FAILED");
          addGitFile(root, childRelative, mode, actualId);
        }
      }
    };
    walk(sourceRoot);
    if (seen.size !== entries.size || [...entries.keys()].some((name) => !seen.has(name))) fail("extracted source inventory differs from the sealed archive", "CANDIDATE_PREPARE_FAILED");
    if (hashGitTree(root, gitAlgorithm(expectedTree)) !== expectedTree || sourceTreeFromReader(reader, gitAlgorithm(expectedTree), expectedCommit) !== expectedTree) fail("extracted source does not reproduce the selected Git tree", "CANDIDATE_PREPARE_FAILED");
  } finally { reader.close(); }
}

function validateReleasePayload(descriptor, manifest, body, files) {
  assertExactKeys(descriptor, ["archivePath", "manifestPath", "profile", "releaseId"], "release descriptor");
  if (descriptor.profile !== "vps" || !SHA256.test(descriptor.releaseId)) fail("release descriptor is not a VPS release");
  if (path.basename(descriptor.archivePath) !== `vps-${descriptor.releaseId}.tar.gz` ||
      path.basename(descriptor.manifestPath) !== `vps-${descriptor.releaseId}.manifest.json`) fail("release descriptor paths are not release-bound");
  assertExactKeys(manifest, ["entries", "profile", "releaseId", "schemaVersion"], "release manifest");
  if (manifest.schemaVersion !== 1 || manifest.profile !== "vps" || manifest.releaseId !== descriptor.releaseId || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    fail("release manifest does not match the release descriptor");
  }
  let previous = "";
  const paths = new Set();
  for (const entry of manifest.entries) {
    assertExactKeys(entry, ["mode", "path", "sha256", "size"], "release manifest entry");
    const entryPath = validateTarPath(entry.path, "release manifest path");
    if (paths.has(entryPath) || (previous && previous.localeCompare(entryPath, "en") >= 0)) fail("release manifest paths are not strictly sorted and unique");
    paths.add(entryPath); previous = entryPath;
    if (!SHA256.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^(?:0644|0755)$/u.test(entry.mode)) fail("release manifest entry metadata is invalid");
  }
  const calculatedRelease = sha256Bytes(Buffer.from(JSON.stringify({ schemaVersion: manifest.schemaVersion, profile: manifest.profile, entries: manifest.entries }), "utf8"));
  if (calculatedRelease !== descriptor.releaseId) fail("release manifest identity is invalid");
  assertExactKeys(body.release, ["archiveRole", "descriptorRole", "id", "manifestRole", "profile", "verifierRole"], "candidate release binding");
  if (body.release.id !== descriptor.releaseId || body.release.profile !== "vps" ||
      body.release.archiveRole !== "release-archive" || body.release.manifestRole !== "release-manifest" ||
      body.release.descriptorRole !== "release-descriptor" || body.release.verifierRole !== "release-verifier") {
    fail("candidate release binding does not match payload");
  }
  if (!files.has(body.release.archiveRole) || !files.has(body.release.manifestRole) ||
      !files.has(body.release.descriptorRole) || !files.has(body.release.verifierRole)) fail("candidate release roles are missing");
}

function verifyReleaseArchive(archive, manifest, verifierBytes) {
  let tar;
  try { tar = gunzipSync(archive, { maxOutputLength: MAX_RELEASE_TREE_BYTES }); }
  catch (error) { fail(`cannot decompress candidate release archive: ${error.message}`); }
  const reader = bufferReader(tar);
  const entries = parseTarIndex(reader);
  const actual = [...entries.entries()];
  if (actual.length !== manifest.entries.length) fail("release archive file set differs from release.manifest.json");
  let total = 0;
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const expected = manifest.entries[index];
    const [name, entry] = actual[index];
    if (entry.directory || name !== expected.path || entry.size !== expected.size) fail(`release archive metadata mismatch for ${expected.path}`);
    const data = reader.read(entry.offset, entry.size);
    total += data.length;
    if (total > MAX_RELEASE_TREE_BYTES || sha256Bytes(data) !== expected.sha256) fail(`release archive digest mismatch for ${expected.path}`);
    const headerOffset = entry.offset - TAR_BLOCK_BYTES;
    const header = reader.read(headerOffset, TAR_BLOCK_BYTES);
    if (tarOctal(header, 100, 8, "mode").toString(8).padStart(4, "0") !== expected.mode) fail(`release archive mode mismatch for ${expected.path}`);
  }
  const verifier = manifest.entries.find((entry) => entry.path === "platform/deploy/vps/verify-release.py");
  if (!verifier || verifier.size !== verifierBytes.length || verifier.sha256 !== sha256Bytes(verifierBytes)) fail("candidate release verifier is not independently bound by release.manifest.json");
}

function validateTrustedReleaseConfig(config) {
  assertExactKeys(config, ["forbiddenDirectoryNames", "forbiddenExtensions", "forbiddenRootDirectories", "ignoredDirectoryNames", "ignoredExtensions", "ignoredFileNames", "profiles", "schemaVersion"], "trusted release config");
  if (config.schemaVersion !== 1) fail("trusted release config schema is unsupported");
  assertPlainObject(config.profiles, "trusted release profiles");
  const profile = config.profiles.vps;
  assertExactKeys(profile, ["description", "exclude", "include"], "trusted VPS release profile");
  for (const [label, values] of [
    ["VPS includes", profile.include], ["VPS excludes", profile.exclude],
    ["ignored directories", config.ignoredDirectoryNames], ["ignored files", config.ignoredFileNames],
    ["ignored extensions", config.ignoredExtensions], ["forbidden roots", config.forbiddenRootDirectories],
    ["forbidden directories", config.forbiddenDirectoryNames], ["forbidden extensions", config.forbiddenExtensions],
  ]) {
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.length === 0)) fail(`trusted release config ${label} are invalid`);
  }
  return config;
}

function releasePathWithin(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function sourceEntryBytes(reader, entry, maximum, label) {
  if (!entry || entry.directory || entry.size > maximum) fail(`${label} is missing or oversized in the source snapshot`);
  return reader.read(entry.offset, entry.size);
}

function deriveVpsReleaseEntries(reader) {
  const sourceEntries = parseTarIndex(reader, { allowGlobalPax: true });
  const authorityBytes = readAuthorityFile(ROOT, PRODUCTION_AUTHORITY_PATH).bytes;
  let authority;
  try { authority = JSON.parse(authorityBytes.toString("utf8")); }
  catch { fail("trusted production authority is invalid JSON"); }
  validateComposeAuthority(authority);
  const configRelative = authority.releaseConfig.path;
  const configBytes = sourceEntryBytes(reader, sourceEntries.get(configRelative), MAX_JSON_RECEIPT_BYTES, "trusted release config");
  const trustedConfig = readAuthorityFile(ROOT, configRelative, MAX_JSON_RECEIPT_BYTES);
  if (!configBytes.equals(trustedConfig.bytes) || sha256Bytes(configBytes) !== authority.releaseConfig.sha256) {
    fail("source snapshot release profile differs from the currently trusted release config");
  }
  let config;
  try { config = JSON.parse(configBytes.toString("utf8")); }
  catch { fail("source snapshot release config is invalid JSON"); }
  validateTrustedReleaseConfig(config);
  const profile = config.profiles.vps;
  const ignoredDirectories = new Set(config.ignoredDirectoryNames);
  const ignoredFiles = new Set(config.ignoredFileNames);
  const ignoredExtensions = config.ignoredExtensions.map((value) => value.toLowerCase());
  const canonicalPolicyName = (value) => value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/^[. ]+|[. ]+$/gu, "");
  const forbiddenDirectories = new Set(config.forbiddenDirectoryNames.map(canonicalPolicyName));
  const forbiddenRoots = new Set(config.forbiddenRootDirectories.map(canonicalPolicyName));
  const privateKeyName = (value) => {
    const lowerName = value.toLowerCase();
    return /(?:^|[._-])private[._-]?key(?:[._-]|$)/u.test(lowerName) ||
      /(?:^|\.)(?:pk8|pkcs8)(?:\.|$)/u.test(lowerName);
  };
  const liveKeySnapshot = (value) => [
    /^\.cosmos-channel-key\.json(?:\..+)?$/iu,
    /^channel-key\.json(?:\..+)?$/iu,
    /^(?:[a-z0-9._-]+-)?key[-_]?material\.json(?:\..+)?$/iu,
    /^\.?(?:cosmos[._-])?(?:channel[._-](?:key|keys|store)|wearer[._-]channel|(?:[a-z0-9._-]+[._-])?key[._-]?material)\.json(?:[._-].+)?$/iu,
  ].some((pattern) => pattern.test(value));
  const records = [];
  let total = 0;
  for (const [entryPath, entry] of sourceEntries) {
    if (entry.directory) continue;
    if (!profile.include.some((included) => releasePathWithin(included, entryPath))) continue;
    if (profile.exclude.some((excluded) => releasePathWithin(excluded, entryPath))) continue;
    const parts = entryPath.split("/");
    const basename = parts.at(-1);
    if (parts.slice(0, -1).some((part) => ignoredDirectories.has(part)) || ignoredFiles.has(basename) ||
        ignoredExtensions.some((extension) => basename.toLowerCase().endsWith(extension))) continue;
    if (forbiddenRoots.has(canonicalPolicyName(parts[0])) || parts.some((part) => forbiddenDirectories.has(canonicalPolicyName(part)))) {
      fail(`source snapshot contains a forbidden VPS release member: ${entryPath}`);
    }
    const lowerName = basename.toLowerCase();
    if (basename === ".env" || (basename.startsWith(".env.") && basename !== ".env.example") || basename === ".npmrc" ||
        privateKeyName(basename) || liveKeySnapshot(basename) ||
        config.forbiddenExtensions.some((extension) => lowerName.endsWith(extension.toLowerCase()) || lowerName.includes(`${extension.toLowerCase()}.`))) {
      fail(`source snapshot contains a forbidden VPS release file: ${entryPath}`);
    }
    const hash = crypto.createHash("sha256");
    for (let offset = 0; offset < entry.size; offset += 1024 * 1024) {
      hash.update(reader.read(entry.offset + offset, Math.min(1024 * 1024, entry.size - offset)));
    }
    total += entry.size;
    if (total > MAX_RELEASE_TREE_BYTES) fail("source-derived VPS release exceeds its bound");
    records.push({
      mode: (entry.mode & 0o111) === 0 ? "0644" : "0755",
      path: entryPath,
      sha256: hash.digest("hex"),
      size: entry.size,
    });
  }
  records.sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (records.length === 0) fail("source snapshot derives an empty VPS release");
  return records;
}

function verifyReleaseDerivedFromSource(root, manifest) {
  const reader = fileReader(path.join(root, "source-snapshot.tar"), MAX_SOURCE_ARCHIVE_BYTES);
  try {
    const expected = deriveVpsReleaseEntries(reader);
    if (canonicalStringify(expected) !== canonicalStringify(manifest.entries)) {
      fail("VPS release manifest is not the exact deterministic projection of the sealed source snapshot");
    }
  } finally { reader.close(); }
}

function verifyComposeModelDerivedFromRelease(manifest, composeModel) {
  const entries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  for (const relative of COMPOSE_AUTHORITY_INPUTS) {
    const entry = entries.get(relative);
    if (!entry || entry.sha256 !== composeModel.composeFiles[relative]) {
      fail(`production Compose model is not bound to sealed release/source bytes: ${relative}`);
    }
  }
  const authority = entries.get(PRODUCTION_AUTHORITY_PATH);
  if (!authority || authority.sha256 !== composeModel.authority.sha256) {
    fail("production Compose model is not bound to its sealed reviewed authority bytes");
  }
}

function validateSourceReceipt(receipt, body, files) {
  assertExactKeys(receipt, ["archiveRole", "archiveSha256", "clean", "commit", "commitObjectRole", "detached", "schema", "schemaVersion", "tree"], "source snapshot receipt");
  if (receipt.schema !== "revival.source-snapshot-receipt" || receipt.schemaVersion !== 2 || receipt.clean !== true || receipt.detached !== true ||
      receipt.archiveRole !== "source-snapshot" || receipt.archiveSha256 !== files.get("source-snapshot").sha256 ||
      receipt.commitObjectRole !== "source-commit-object" ||
      !GIT_OBJECT_ID.test(receipt.commit) || !GIT_OBJECT_ID.test(receipt.tree) || !SHA256.test(receipt.archiveSha256)) fail("source snapshot receipt is invalid");
  assertExactKeys(body.git, ["commit", "tree"], "candidate Git binding");
  assertExactKeys(body.sourceSnapshot, ["archiveDigest", "archiveRole", "commitObjectDigest", "commitObjectRole", "receiptDigest", "receiptRole"], "candidate source binding");
  if (body.git.commit !== receipt.commit || body.git.tree !== receipt.tree ||
      body.sourceSnapshot.archiveRole !== "source-snapshot" || body.sourceSnapshot.archiveDigest !== files.get("source-snapshot").sha256 ||
      body.sourceSnapshot.commitObjectRole !== "source-commit-object" || body.sourceSnapshot.commitObjectDigest !== files.get("source-commit-object").sha256 ||
      body.sourceSnapshot.receiptRole !== "source-snapshot-receipt" ||
      body.sourceSnapshot.receiptDigest !== files.get("source-snapshot-receipt").sha256) fail("candidate source binding does not match receipt");
}

export function createCandidateDescriptor({ payloads, release, git, sourceReceipt, composeModel, productionState, toolchainReceipt, imageReceipt, authority = LOCAL_CANDIDATE_AUTHORITY, trustedThirdPartyImages = THIRD_PARTY_IMAGES }) {
  const files = PAYLOAD_SPECS.map((spec) => {
    const source = payloads[spec.role];
    const metadata = Buffer.isBuffer(source)
      ? { sha256: sha256Bytes(source), size: source.length }
      : source?.fileMetadata;
    if (!metadata || !SHA256.test(metadata.sha256) || !Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > spec.maxBytes) {
      fail(`missing or oversized candidate payload: ${spec.role}`);
    }
    return { basename: spec.basename, mediaType: spec.mediaType, role: spec.role, sha256: metadata.sha256, size: metadata.size };
  }).sort((left, right) => left.role.localeCompare(right.role));
  const fileByRole = new Map(files.map((entry) => [entry.role, entry]));
  const body = {
    authority: structuredClone(authority),
    files,
    git: { commit: git.commit, tree: git.tree },
    images: { bundleDigest: fileByRole.get("docker-image-bundle").sha256, bundleRole: "docker-image-bundle", receiptDigest: fileByRole.get("docker-image-receipt").sha256, receiptRole: "docker-image-receipt" },
    composeModel: { digest: fileByRole.get("production-compose-model").sha256, role: "production-compose-model" },
    productionState: { digest: fileByRole.get("production-state-contract").sha256, role: "production-state-contract" },
    release: { archiveRole: "release-archive", descriptorRole: "release-descriptor", id: release.releaseId, manifestRole: "release-manifest", profile: "vps", verifierRole: "release-verifier" },
    sourceSnapshot: {
      archiveDigest: fileByRole.get("source-snapshot").sha256,
      archiveRole: "source-snapshot",
      commitObjectDigest: fileByRole.get("source-commit-object").sha256,
      commitObjectRole: "source-commit-object",
      receiptDigest: fileByRole.get("source-snapshot-receipt").sha256,
      receiptRole: "source-snapshot-receipt",
    },
    toolchain: { digest: fileByRole.get("toolchain-receipt").sha256, role: "toolchain-receipt" },
  };
  // Validate all cross-receipt invariants before assigning the identity.
  validateCandidateBody(body, { release, sourceReceipt, composeModel, productionState, toolchainReceipt, imageReceipt }, fileByRole, trustedThirdPartyImages);
  return { schema: CANDIDATE_SCHEMA, schemaVersion: CANDIDATE_SCHEMA_VERSION, candidateId: candidateIdForBody(body), body };
}

function validateCandidateBody(body, receipts, files = roleMap(body.files), trustedThirdPartyImages = THIRD_PARTY_IMAGES) {
  assertExactKeys(body, ["authority", "composeModel", "files", "git", "images", "productionState", "release", "sourceSnapshot", "toolchain"], "candidate body");
  assertExactKeys(body.authority, ["origin", "productionUse"], "candidate authority origin");
  const local = canonicalStringify(body.authority) === canonicalStringify(LOCAL_CANDIDATE_AUTHORITY);
  const hosted = canonicalStringify(body.authority) === canonicalStringify(HOSTED_CANDIDATE_AUTHORITY);
  if (!local && !hosted) fail("candidate authority origin is unsupported");
  files = files ?? roleMap(body.files);
  validateProductionState(receipts.productionState);
  validateToolchainReceipt(receipts.toolchainReceipt);
  validateSourceReceipt(receipts.sourceReceipt, body, files);
  validateProductionComposeModel(receipts.composeModel, body.release.id, trustedThirdPartyImages,
    receipts.imageReceipt);
  assertExactKeys(body.composeModel, ["digest", "role"], "candidate production Compose model binding");
  if (body.composeModel.role !== "production-compose-model" ||
      body.composeModel.digest !== files.get("production-compose-model").sha256) {
    fail("candidate production Compose model binding is invalid");
  }
  assertExactKeys(body.productionState, ["digest", "role"], "candidate production-state binding");
  if (body.productionState.role !== "production-state-contract" || body.productionState.digest !== files.get("production-state-contract").sha256) fail("candidate production-state binding is invalid");
  assertExactKeys(body.toolchain, ["digest", "role"], "candidate toolchain binding");
  if (body.toolchain.role !== "toolchain-receipt" || body.toolchain.digest !== files.get("toolchain-receipt").sha256) fail("candidate toolchain binding is invalid");
  assertExactKeys(body.images, ["bundleDigest", "bundleRole", "receiptDigest", "receiptRole"], "candidate image binding");
  if (body.images.bundleRole !== "docker-image-bundle" || body.images.receiptRole !== "docker-image-receipt" ||
      body.images.bundleDigest !== files.get("docker-image-bundle").sha256 || body.images.receiptDigest !== files.get("docker-image-receipt").sha256) fail("candidate image binding is invalid");
  validateImageReceipt(receipts.imageReceipt, body.release.id, files.get("docker-image-bundle"), body.git, trustedThirdPartyImages);
  const configuredReferences = new Set(Object.values(receipts.composeModel.services)
    .map((mapping) => mapping.reference));
  configuredReferences.add(imageRoleReferences(body.release.id, trustedThirdPartyImages)["backup-helper"]);
  const receiptReferences = new Set(receipts.imageReceipt.images.map((image) => image.reference));
  if (canonicalStringify([...configuredReferences].sort()) !==
      canonicalStringify([...receiptReferences].sort())) {
    fail("production Compose model and backup helper do not consume the exact sealed image inventory");
  }
}

function statIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].map(String).join(":");
}

function inodeIdentity(stat) {
  return [stat.dev, stat.ino].map(String).join(":");
}

function hashRegularPath(file, maxBytes, { requireSingleLink = true } = {}) {
  const before = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!before || !before.isFile() || before.isSymbolicLink() || (requireSingleLink && before.nlink !== 1n) || before.size > BigInt(maxBytes)) {
    fail("candidate source must be one bounded regular file");
  }
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const hash = crypto.createHash("sha256");
  let total = 0;
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (statIdentity(opened) !== statIdentity(before)) fail("candidate source changed before open");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, total);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) fail("candidate source exceeds its size limit");
      hash.update(buffer.subarray(0, count));
    }
    if (BigInt(total) !== opened.size || statIdentity(fs.fstatSync(descriptor, { bigint: true })) !== statIdentity(opened)) {
      fail("candidate source changed while hashing");
    }
  } finally {
    fs.closeSync(descriptor);
  }
  if (statIdentity(fs.lstatSync(file, { bigint: true })) !== statIdentity(before)) fail("candidate source changed during hashing");
  return { sha256: hash.digest("hex"), size: total, identity: statIdentity(before) };
}

function hashCandidatePayload(root, basename, maxBytes, enforceStorePolicy) {
  const file = path.join(root, basename);
  const before = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!before || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    fail(`candidate ${basename} must be one bounded, unlinked regular file`);
  }
  if (enforceStorePolicy && before && ((Number(before.mode) & 0o777) !== 0o600 || before.uid !== BigInt(process.getuid?.() ?? Number(before.uid)))) {
    fail(`candidate ${basename} must be owner-owned mode 0600`);
  }
  return hashRegularPath(file, maxBytes);
}

function readRegularFile(root, basename, maxBytes, { enforceStorePolicy = true } = {}) {
  if (path.basename(basename) !== basename || !EXPECTED_CANDIDATE_FILES.includes(basename)) fail("candidate basename is outside the fixed inventory");
  const file = path.join(root, basename);
  const before = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!before || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maxBytes)) fail(`candidate ${basename} must be one bounded, unlinked regular file`);
  if (enforceStorePolicy && ((Number(before.mode) & 0o777) !== 0o600 || before.uid !== BigInt(process.getuid?.() ?? Number(before.uid)))) {
    fail(`candidate ${basename} must be owner-owned mode 0600`);
  }
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let buffer;
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (statIdentity(opened) !== statIdentity(before) || !opened.isFile() || opened.nlink !== 1n) fail(`candidate ${basename} changed before open`);
    if (opened.size > BigInt(maxBytes)) fail(`candidate ${basename} exceeds its size limit`);
    buffer = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) fail(`candidate ${basename} was truncated while reading`);
      offset += count;
    }
    const probe = Buffer.alloc(1);
    if (fs.readSync(descriptor, probe, 0, 1, buffer.length) !== 0) fail(`candidate ${basename} grew while reading`);
    const afterOpen = fs.fstatSync(descriptor, { bigint: true });
    if (statIdentity(afterOpen) !== statIdentity(opened)) fail(`candidate ${basename} changed while reading`);
  } finally {
    fs.closeSync(descriptor);
  }
  const after = fs.lstatSync(file, { bigint: true });
  if (statIdentity(after) !== statIdentity(before)) fail(`candidate ${basename} changed during verification`);
  return buffer;
}

function captureDirectoryChain(directory) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  const relative = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  const chain = [];
  for (const component of relative) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current, { bigint: true, throwIfNoEntry: false });
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) fail("candidate path ancestry must contain only real directories");
    chain.push([current, inodeIdentity(stat)]);
  }
  return chain;
}

function verifyDirectoryChain(chain) {
  for (const [directory, identity] of chain) {
    const stat = fs.lstatSync(directory, { bigint: true, throwIfNoEntry: false });
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || inodeIdentity(stat) !== identity) fail(`candidate path ancestry changed during verification: ${directory}`);
  }
}

function resolveCandidateRoot(candidatePath) {
  const absolute = path.resolve(candidatePath);
  const root = path.basename(absolute) === CANDIDATE_BASENAME ? path.dirname(absolute) : absolute;
  const heldDescriptorPath = /^\/proc\/(?:self|[0-9]+)\/fd\/[0-9]+(?:\/[A-Za-z0-9._-]+)?$/u.test(root);
  const chain = heldDescriptorPath ? [] : captureDirectoryChain(root);
  const stat = fs.lstatSync(root, { bigint: true, throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) fail("candidate path must be a real directory or its candidate.json");
  const canonical = fs.realpathSync.native(root);
  if (!heldDescriptorPath && canonical !== root) fail("candidate directory must use its canonical non-link path");
  return { chain, root, stat };
}

export function verifyCandidate(candidatePath, options = {}) {
  const { chain, root, stat: rootBefore } = resolveCandidateRoot(candidatePath);
  const enforceStorePolicy = options.enforceStorePolicy !== false;
  const expectedId = options.expectedId ?? "";
  if (expectedId && !SHA256.test(expectedId)) fail("expected candidate ID must be a lowercase SHA-256 digest");
  if (enforceStorePolicy && ((Number(rootBefore.mode) & 0o777) !== 0o700 || rootBefore.uid !== BigInt(process.getuid?.() ?? Number(rootBefore.uid)))) {
    fail("candidate directory must be owner-owned mode 0700");
  }
  const names = fs.readdirSync(root).sort();
  if (canonicalStringify(names) !== canonicalStringify(EXPECTED_CANDIDATE_FILES)) fail("candidate directory has missing or extra entries");
  const descriptorBytes = readRegularFile(root, CANDIDATE_BASENAME, MAX_DESCRIPTOR_BYTES, { enforceStorePolicy });
  const descriptor = parseCanonicalJson(descriptorBytes, "candidate descriptor");
  assertExactKeys(descriptor, ["body", "candidateId", "schema", "schemaVersion"], "candidate descriptor");
  if (descriptor.schema !== CANDIDATE_SCHEMA || descriptor.schemaVersion !== CANDIDATE_SCHEMA_VERSION || !SHA256.test(descriptor.candidateId)) fail("candidate descriptor schema or identity is unsupported");
  if (candidateIdForBody(descriptor.body) !== descriptor.candidateId) fail("candidate ID does not match its canonical body");
  if ((expectedId && descriptor.candidateId !== expectedId) || (SHA256.test(path.basename(root)) && path.basename(root) !== descriptor.candidateId)) {
    fail("requested candidate ID, directory identity, and internal candidate ID differ");
  }
  const files = roleMap(descriptor.body.files);
  const buffers = {};
  for (const spec of PAYLOAD_SPECS) {
    const inventory = files.get(spec.role);
    if (!spec.json && !spec.releaseJson) {
      const metadata = hashCandidatePayload(root, spec.basename, spec.maxBytes, enforceStorePolicy);
      if (metadata.size !== inventory.size || metadata.sha256 !== inventory.sha256) fail(`candidate payload does not match inventory: ${spec.role}`);
      continue;
    }
    const bytes = readRegularFile(root, spec.basename, spec.maxBytes, { enforceStorePolicy });
    if (bytes.length !== inventory.size || sha256Bytes(bytes) !== inventory.sha256) fail(`candidate payload does not match inventory: ${spec.role}`);
    if (spec.json) parseCanonicalJson(bytes, spec.role);
    if (spec.releaseJson) parseReleaseJson(bytes, spec.role);
    buffers[spec.role] = bytes;
  }
  const release = parseCanonicalJson(buffers["release-descriptor"], "release descriptor");
  const manifest = parseReleaseJson(buffers["release-manifest"], "release manifest");
  const receipts = {
    sourceReceipt: parseCanonicalJson(buffers["source-snapshot-receipt"], "source snapshot receipt"),
    composeModel: parseCanonicalJson(buffers["production-compose-model"], "production Compose model"),
    productionState: parseCanonicalJson(buffers["production-state-contract"], "production-state contract"),
    toolchainReceipt: parseCanonicalJson(buffers["toolchain-receipt"], "toolchain receipt"),
    imageReceipt: parseCanonicalJson(buffers["docker-image-receipt"], "Docker image receipt"),
  };
  validateReleasePayload(release, manifest, descriptor.body, files);
  const trustedImages = options.trustedThirdPartyImages ?? THIRD_PARTY_IMAGES;
  validateCandidateBody(descriptor.body, { release, ...receipts }, files, trustedImages);
  verifyComposeModelDerivedFromRelease(manifest, receipts.composeModel);
  if (options.enforceTrustedProtocol === true) {
    assertOfflineProductionAuthority(manifest, receipts.productionState, receipts.composeModel,
      options.trustedRoot ?? ROOT);
  }
  const releaseArchive = readRegularFile(root, "release.tar.gz", MAX_RELEASE_ARCHIVE_BYTES, { enforceStorePolicy });
  const releaseVerifier = readRegularFile(root, "verify-release.py", 2 * 1024 * 1024, { enforceStorePolicy });
  if (sha256Bytes(releaseArchive) !== files.get("release-archive").sha256 ||
      sha256Bytes(releaseVerifier) !== files.get("release-verifier").sha256) fail("release verification bytes moved after inventory hashing");
  verifyReleaseArchive(releaseArchive, manifest, releaseVerifier);
  verifySourceProvenance(root, receipts.sourceReceipt, enforceStorePolicy);
  verifyReleaseDerivedFromSource(root, manifest);
  verifyDockerBundlePath(path.join(root, "images.tar"), receipts.imageReceipt);
  const rootAfter = fs.lstatSync(root, { bigint: true });
  if (statIdentity(rootAfter) !== statIdentity(rootBefore)) fail("candidate directory changed during verification");
  verifyDirectoryChain(chain);
  return deepFreeze({
    ok: true,
    candidateId: descriptor.candidateId,
    root,
    authority: descriptor.body.authority,
    descriptor,
    release,
    manifest,
    ...receipts,
  });
}

function candidateStoreHelper(args, parentDescriptor = null) {
  const stdio = parentDescriptor === null ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", parentDescriptor];
  const result = childProcess.spawnSync("/usr/bin/python3", ["-I", "-B", CANDIDATE_STORE_HELPER, ...args], {
    encoding: "utf8",
    env: { HOME: "/nonexistent", PATH: "/usr/bin:/usr/sbin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" },
    stdio,
  });
  if (result.error || result.status !== 0) fail((result.stderr || "candidate store transaction failed").trim(), "CANDIDATE_PUBLICATION_FAILED");
  return result.stdout.trim();
}

function openDirectoryNoFollow(absolute) {
  const parsed = path.parse(absolute);
  let descriptor = fs.openSync(parsed.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      if (component === "." || component === "..") fail("managed directory path is unsafe", "CANDIDATE_USAGE");
      const child = fs.openSync(path.join("/proc/self/fd", String(descriptor), component), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW ?? 0));
      fs.closeSync(descriptor); descriptor = child;
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function requirePrivateDirectory(descriptor, label) {
  const metadata = fs.fstatSync(descriptor, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || Number(metadata.mode & 0o777n) !== 0o700 ||
      metadata.uid !== BigInt(process.getuid?.() ?? Number(metadata.uid))) fail(`${label} must be an owner-owned mode-0700 real directory`, "CANDIDATE_USAGE");
  return metadata;
}

function descriptorPath(descriptor, child = "") {
  return path.join("/proc", String(process.pid), "fd", String(descriptor), child);
}

function openOrCreatePrivateChild(parentDescriptor, name, { exclusive = false } = {}) {
  if (!/^[A-Za-z0-9._-]+$/u.test(name) || name === "." || name === "..") fail("managed child name is unsafe", "CANDIDATE_USAGE");
  const childPath = descriptorPath(parentDescriptor, name);
  const expected = candidateStoreHelper(["create-child", "--name", name, ...(exclusive ? ["--exclusive"] : [])], parentDescriptor)
    .match(/^([0-9]+):([0-9]+)$/u);
  if (!expected) fail("candidate store returned an invalid child identity", "CANDIDATE_PUBLICATION_FAILED");
  const descriptor = fs.openSync(childPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = requirePrivateDirectory(descriptor, `managed child ${name}`);
    if (metadata.dev !== BigInt(expected[1]) || metadata.ino !== BigInt(expected[2])) {
      fail("managed child was replaced after descriptor-relative creation", "CANDIDATE_PUBLICATION_FAILED");
    }
  }
  catch (error) { fs.closeSync(descriptor); throw error; }
  return descriptor;
}

function ensureExternalDataRoot(dataDir) {
  const absolute = path.resolve(dataDir);
  const source = fs.realpathSync.native(ROOT);
  if (absolute === source || absolute.startsWith(`${source}${path.sep}`)) fail("candidate store must be outside the source tree", "CANDIDATE_USAGE");
  const expected = candidateStoreHelper(["ensure-root", "--path", absolute])
    .match(/^([0-9]+):([0-9]+)$/u);
  if (!expected) fail("candidate store returned an invalid root identity", "CANDIDATE_PUBLICATION_FAILED");
  const descriptor = openDirectoryNoFollow(absolute);
  try {
    const metadata = requirePrivateDirectory(descriptor, "REVIVAL_DATA_DIR");
    if (metadata.dev !== BigInt(expected[1]) || metadata.ino !== BigInt(expected[2])) {
      fail("REVIVAL_DATA_DIR was replaced after descriptor-relative creation", "CANDIDATE_PUBLICATION_FAILED");
    }
  }
  catch (error) { fs.closeSync(descriptor); throw error; }
  return { absolute, descriptor };
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeExclusive(file, bytes, mode = 0o600) {
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), mode);
  try {
    fs.fchmodSync(descriptor, mode);
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function copyExclusive(file, source, expected) {
  const before = fs.lstatSync(source, { bigint: true, throwIfNoEntry: false });
  if (!before || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(expected.size)) {
    fail("candidate file source is unsafe or moved");
  }
  const input = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const output = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  const hash = crypto.createHash("sha256");
  let total = 0;
  try {
    const opened = fs.fstatSync(input, { bigint: true });
    if (statIdentity(opened) !== statIdentity(before)) fail("candidate file source changed before copy");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const count = fs.readSync(input, buffer, 0, buffer.length, total);
      if (count === 0) break;
      let written = 0;
      while (written < count) written += fs.writeSync(output, buffer, written, count - written, total + written);
      total += count;
      hash.update(buffer.subarray(0, count));
    }
    fs.fsyncSync(output);
    if (BigInt(total) !== opened.size || statIdentity(fs.fstatSync(input, { bigint: true })) !== statIdentity(opened)) fail("candidate file source changed while copying");
  } finally {
    fs.closeSync(output);
    fs.closeSync(input);
  }
  if (statIdentity(fs.lstatSync(source, { bigint: true })) !== statIdentity(before) || total !== expected.size || hash.digest("hex") !== expected.sha256) {
    fail("candidate file source does not match its sealed receipt");
  }
}

export function publishCandidate({ dataDir = DEFAULT_DATA_DIR, descriptor, payloads, trustedThirdPartyImages = THIRD_PARTY_IMAGES }) {
  const managedRoot = ensureExternalDataRoot(dataDir);
  const candidatesDescriptor = openOrCreatePrivateChild(managedRoot.descriptor, "release-candidates");
  const candidatesRoot = descriptorPath(candidatesDescriptor);
  const descriptorBytes = canonicalJsonBytes(descriptor);
  if (descriptorBytes.length > MAX_DESCRIPTOR_BYTES || candidateIdForBody(descriptor.body) !== descriptor.candidateId) fail("candidate descriptor is invalid before publication");
  const releasePath = path.join(managedRoot.absolute, "release-candidates", descriptor.candidateId);
  let stageName = "";
  let stageIdentity = null;
  let stageDescriptor = null;
  try {
    const heldReleasePath = descriptorPath(candidatesDescriptor, descriptor.candidateId);
    if (fs.existsSync(heldReleasePath)) {
      const existing = verifyCandidate(heldReleasePath, { expectedId: descriptor.candidateId, trustedThirdPartyImages });
      if (existing.candidateId !== descriptor.candidateId || !readRegularFile(heldReleasePath, CANDIDATE_BASENAME, MAX_DESCRIPTOR_BYTES).equals(descriptorBytes)) {
        fail("preexisting candidate conflicts with requested candidate", "CANDIDATE_COLLISION");
      }
      return deepFreeze({ ...existing, root: releasePath });
    }
    stageName = `.candidate-staging-${descriptor.candidateId.slice(0, 16)}-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
    stageDescriptor = openOrCreatePrivateChild(candidatesDescriptor, stageName, { exclusive: true });
    const stage = descriptorPath(candidatesDescriptor, stageName);
    const stageStat = fs.fstatSync(stageDescriptor, { bigint: true });
    stageIdentity = { dev: stageStat.dev, ino: stageStat.ino };
    for (const spec of PAYLOAD_SPECS) {
      const source = payloads[spec.role];
      const inventory = descriptor.body.files.find((entry) => entry.role === spec.role);
      if (Buffer.isBuffer(source)) writeExclusive(path.join(stage, spec.basename), source);
      else if (typeof source?.file === "string" && source.fileMetadata) copyExclusive(path.join(stage, spec.basename), source.file, inventory);
      else fail(`candidate payload is missing: ${spec.role}`);
    }
    writeExclusive(path.join(stage, CANDIDATE_BASENAME), descriptorBytes);
    fsyncDirectory(stage);
    verifyCandidate(stage, { expectedId: descriptor.candidateId, trustedThirdPartyImages });
    candidateStoreHelper(["publish", "--stage", stageName, "--candidate-id", descriptor.candidateId,
      "--dev", String(stageIdentity.dev), "--ino", String(stageIdentity.ino)], candidatesDescriptor);
    const publishedStage = fs.fstatSync(stageDescriptor, { bigint: true });
    if (publishedStage.dev !== stageIdentity.dev || publishedStage.ino !== stageIdentity.ino) {
      fail("candidate publication did not retain the exact staged inode", "CANDIDATE_PUBLICATION_FAILED");
    }
    fs.closeSync(stageDescriptor);
    stageDescriptor = null;
    stageName = "";
    const checked = verifyCandidate(heldReleasePath, { expectedId: descriptor.candidateId, trustedThirdPartyImages });
    return deepFreeze({ ...checked, root: releasePath });
  } finally {
    if (stageDescriptor !== null) fs.closeSync(stageDescriptor);
    if (stageName && stageIdentity) {
      try {
        candidateStoreHelper(["cleanup", "--name", stageName, "--dev", String(stageIdentity.dev), "--ino", String(stageIdentity.ino)], candidatesDescriptor);
      } catch {}
    }
    fs.closeSync(candidatesDescriptor);
    fs.closeSync(managedRoot.descriptor);
  }
}

export function sealCandidateFromBuffers({ dataDir = DEFAULT_DATA_DIR, releaseArchive, releaseManifest, releaseDescriptor, releaseVerifier, sourceArchive, sourceCommitObject, sourceReceipt, composeModel, productionState, toolchainReceipt, imageReceipt, imageBundle, authority = LOCAL_CANDIDATE_AUTHORITY, trustedThirdPartyImages = THIRD_PARTY_IMAGES }) {
  const releaseArchiveBytes = Buffer.from(releaseArchive);
  const releaseVerifierBytes = Buffer.from(releaseVerifier);
  const sourceArchiveBytes = Buffer.from(sourceArchive);
  const sourceCommitBytes = Buffer.from(sourceCommitObject);
  const imageBundleBytes = Buffer.from(imageBundle);
  verifyDockerBundleBuffer(imageBundleBytes, imageReceipt);
  const canonicalPayloads = {
    "release-archive": releaseArchiveBytes,
    "release-manifest": Buffer.from(`${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8"),
    "release-descriptor": canonicalJsonBytes(releaseDescriptor),
    "release-verifier": releaseVerifierBytes,
    "source-snapshot": sourceArchiveBytes,
    "source-commit-object": sourceCommitBytes,
    "source-snapshot-receipt": canonicalJsonBytes(sourceReceipt),
    "production-compose-model": canonicalJsonBytes(composeModel),
    "production-state-contract": canonicalJsonBytes(productionState),
    "toolchain-receipt": canonicalJsonBytes(toolchainReceipt),
    "docker-image-receipt": canonicalJsonBytes(imageReceipt),
    "docker-image-bundle": imageBundleBytes,
  };
  const descriptor = createCandidateDescriptor({
    payloads: canonicalPayloads,
    release: releaseDescriptor,
    git: { commit: sourceReceipt.commit, tree: sourceReceipt.tree },
    sourceReceipt,
    composeModel,
    productionState,
    toolchainReceipt,
    imageReceipt,
    authority,
    trustedThirdPartyImages,
  });
  return publishCandidate({ dataDir, descriptor, payloads: canonicalPayloads, trustedThirdPartyImages });
}

export function sealCandidateFromFiles({ dataDir = DEFAULT_DATA_DIR, releaseArchivePath, releaseManifest, releaseDescriptor, releaseVerifierPath, sourceArchivePath, sourceCommitObjectPath, sourceReceipt, composeModel, productionState, toolchainReceipt, imageReceipt, imageBundlePath, authority = LOCAL_CANDIDATE_AUTHORITY, trustedThirdPartyImages = THIRD_PARTY_IMAGES }) {
  const releaseMetadata = hashRegularPath(releaseArchivePath, MAX_RELEASE_ARCHIVE_BYTES);
  const releaseVerifierMetadata = hashRegularPath(releaseVerifierPath, 2 * 1024 * 1024);
  const sourceMetadata = hashRegularPath(sourceArchivePath, MAX_SOURCE_ARCHIVE_BYTES);
  const sourceCommitMetadata = hashRegularPath(sourceCommitObjectPath, 2 * 1024 * 1024);
  const imageMetadata = hashRegularPath(imageBundlePath, MAX_IMAGE_BUNDLE_BYTES);
  verifyDockerBundlePath(imageBundlePath, imageReceipt);
  const canonicalPayloads = {
    "release-archive": { file: releaseArchivePath, fileMetadata: releaseMetadata },
    "release-manifest": Buffer.from(`${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8"),
    "release-descriptor": canonicalJsonBytes(releaseDescriptor),
    "release-verifier": { file: releaseVerifierPath, fileMetadata: releaseVerifierMetadata },
    "source-snapshot": { file: sourceArchivePath, fileMetadata: sourceMetadata },
    "source-commit-object": { file: sourceCommitObjectPath, fileMetadata: sourceCommitMetadata },
    "source-snapshot-receipt": canonicalJsonBytes(sourceReceipt),
    "production-compose-model": canonicalJsonBytes(composeModel),
    "production-state-contract": canonicalJsonBytes(productionState),
    "toolchain-receipt": canonicalJsonBytes(toolchainReceipt),
    "docker-image-receipt": canonicalJsonBytes(imageReceipt),
    "docker-image-bundle": { file: imageBundlePath, fileMetadata: imageMetadata },
  };
  const descriptor = createCandidateDescriptor({
    payloads: canonicalPayloads,
    release: releaseDescriptor,
    git: { commit: sourceReceipt.commit, tree: sourceReceipt.tree },
    sourceReceipt,
    composeModel,
    productionState,
    toolchainReceipt,
    imageReceipt,
    authority,
    trustedThirdPartyImages,
  });
  return publishCandidate({ dataDir, descriptor, payloads: canonicalPayloads, trustedThirdPartyImages });
}

function run(executable, args, { cwd = ROOT, env, input, maxBuffer = 64 * 1024 * 1024 } = {}) {
  const authority = path.isAbsolute(executable) ? executable : commandPath(executable);
  const result = childProcess.spawnSync(authority, args, { cwd, env, input, encoding: "utf8", maxBuffer });
  if (result.error || result.status !== 0) fail(`${path.basename(authority)} failed while preparing the candidate`, "CANDIDATE_PREPARE_FAILED");
  return result.stdout.trim();
}

function runBytes(executable, args, { cwd = ROOT, env, input, maxBuffer = 64 * 1024 * 1024 } = {}) {
  const authority = path.isAbsolute(executable) ? executable : commandPath(executable);
  const result = childProcess.spawnSync(authority, args, { cwd, env, input, maxBuffer });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) fail(`${path.basename(authority)} failed while preparing the candidate`, "CANDIDATE_PREPARE_FAILED");
  return result.stdout;
}

function candidateLoginHome() {
  try {
    const home = os.userInfo().homedir;
    if (path.isAbsolute(home)) return home;
  } catch {}
  return "/nonexistent";
}

function fixedCommandCandidates(name) {
  const home = candidateLoginHome();
  const candidates = {
    cargo: [path.join(home, ".cargo/bin/cargo"), "/usr/bin/cargo", "/usr/local/bin/cargo", "/opt/homebrew/bin/cargo"],
    docker: process.platform === "darwin"
      ? ["/usr/local/bin/docker", "/opt/homebrew/bin/docker"]
      : ["/usr/bin/docker", "/usr/local/bin/docker"],
    git: process.platform === "darwin"
      ? ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]
      : ["/usr/bin/git", "/usr/local/bin/git"],
    node: process.platform === "darwin"
      ? ["/opt/homebrew/opt/node@22/bin/node", "/usr/local/opt/node@22/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node"]
      : ["/usr/bin/node", "/usr/local/bin/node"],
    npm: process.platform === "darwin"
      ? ["/opt/homebrew/opt/node@22/bin/npm", "/usr/local/opt/node@22/bin/npm", "/opt/homebrew/bin/npm", "/usr/local/bin/npm"]
      : ["/usr/bin/npm", "/usr/local/bin/npm"],
    rustc: [path.join(home, ".cargo/bin/rustc"), "/usr/bin/rustc", "/usr/local/bin/rustc", "/opt/homebrew/bin/rustc"],
    sh: ["/bin/sh", "/usr/bin/sh"],
  };
  return candidates[name] ?? [];
}

function commandPath(name, ignoredSearchPath) {
  // Kept as a second argument for callers/tests written against the old API.
  // It is deliberately ignored: ambient PATH is not executable authority.
  void ignoredSearchPath;
  for (const candidate of fixedCommandCandidates(name)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {}
  }
  fail(`required candidate tool is unavailable: ${name}`, "CANDIDATE_PREPARE_FAILED");
}

export function candidateGitEnvironment(home, searchPath) {
  void searchPath;
  const gitDirectory = path.dirname(commandPath("git"));
  const environment = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "xdg"),
    PATH: [gitDirectory, "/usr/local/bin", "/usr/bin", "/bin"].filter((entry, index, values) => values.indexOf(entry) === index).join(path.delimiter),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "diff.external",
    GIT_CONFIG_VALUE_2: "",
    GIT_CONFIG_KEY_3: "core.attributesFile",
    GIT_CONFIG_VALUE_3: "/dev/null",
  };
  fs.mkdirSync(environment.XDG_CONFIG_HOME, { recursive: true, mode: 0o700 });
  return environment;
}

function cleanBuildEnvironment(home, gitEnvironment) {
  const required = ["cargo", "docker", "git", "node", "npm", "rustc", "sh"];
  const toolDirectories = required.map((name) => path.dirname(commandPath(name)));
  const searchPath = [...new Set([...toolDirectories, "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"])].join(path.delimiter);
  const environment = {
    HOME: home,
    PATH: searchPath,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    SOURCE_DATE_EPOCH: "0",
    DOCKER_BUILDKIT: "1",
    DOCKER_CONFIG: path.join(home, "docker"),
    DOCKER_HOST: "unix:///var/run/docker.sock",
    CARGO_HOME: path.join(home, "cargo"),
    NPM_CONFIG_CACHE: path.join(home, "npm-cache"),
    ...Object.fromEntries(Object.entries(gitEnvironment).filter(([key]) => key.startsWith("GIT_"))),
  };
  fs.mkdirSync(environment.DOCKER_CONFIG, { mode: 0o700 });
  const rustupHome = path.join(candidateLoginHome(), ".rustup");
  if (path.isAbsolute(rustupHome) && fs.existsSync(rustupHome)) environment.RUSTUP_HOME = fs.realpathSync.native(rustupHome);
  return environment;
}

function executableDigest(command, env) {
  const executable = commandPath(command, env.PATH);
  return hashRegularPath(fs.realpathSync.native(executable), 1024 * 1024 * 1024, { requireSingleLink: false }).sha256;
}

function captureToolchains(env) {
  const commands = {
    cargo: ["cargo", ["--version"]],
    docker: ["docker", ["version", "--format", "client={{.Client.Version}} server={{.Server.Version}} api={{.Server.APIVersion}} os={{.Server.Os}} arch={{.Server.Arch}}"]],
    "docker-buildx": ["docker", ["buildx", "version"]],
    git: ["git", ["--version"]],
    node: ["node", ["--version"]],
    npm: ["npm", ["--version"]],
    rustc: ["rustc", ["--version"]],
  };
  return {
    schema: "revival.toolchain-receipt",
    schemaVersion: 1,
    platform: "linux/amd64",
    tools: Object.entries(commands).map(([name, [command, args]]) => ({ name, version: run(command, args, { env }), sha256: executableDigest(command, env) })),
  };
}

function inspectDockerImage(reference, { bundleReference, firstParty, component, releaseId, registry = null, env }) {
  const raw = run("docker", ["image", "inspect", reference], { env });
  let record;
  try { [record] = JSON.parse(raw); } catch { fail("Docker returned invalid image inspection data", "CANDIDATE_PREPARE_FAILED"); }
  const architecture = record?.Architecture;
  const platform = `${record?.Os}/${architecture}`;
  if (platform !== "linux/arm64" || !DOCKER_SHA256.test(record?.Id)) fail("Docker image is not the required linux/arm64 object", "CANDIDATE_PREPARE_FAILED");
  if (firstParty) {
    const labels = record?.Config?.Labels ?? {};
    return { component, firstParty: true, imageId: record.Id, labels: {
      "dk.andersmadsen.ai-pin-revival.component": labels["dk.andersmadsen.ai-pin-revival.component"],
      "dk.andersmadsen.ai-pin-revival.product": labels["dk.andersmadsen.ai-pin-revival.product"],
      "dk.andersmadsen.ai-pin-revival.release": labels["dk.andersmadsen.ai-pin-revival.release"],
      "dk.andersmadsen.ai-pin-revival.source-commit": labels["dk.andersmadsen.ai-pin-revival.source-commit"],
      "dk.andersmadsen.ai-pin-revival.source-tree": labels["dk.andersmadsen.ai-pin-revival.source-tree"],
      "org.opencontainers.image.revision": labels["org.opencontainers.image.revision"],
    }, bundleReference, platform, reference, registry: null, sourceDigest: null };
  }
  const sourceDigest = reference.slice(reference.lastIndexOf("@") + 1);
  const exactDigest = Array.isArray(record.RepoDigests)
    ? record.RepoDigests.find((entry) => entry.endsWith(`@${sourceDigest}`))
    : null;
  if (!exactDigest) fail("pulled third-party image does not expose its requested source digest", "CANDIDATE_PREPARE_FAILED");
  const image = { bundleReference, component: null, firstParty: false, imageId: record.Id, labels: null, platform, reference, registry, sourceDigest };
  registryClosure(image);
  return image;
}

function dockerRawManifest(reference, expectedDigest, mediaType, env) {
  let bytes = runBytes("docker", ["buildx", "imagetools", "inspect", "--raw", reference], { env, maxBuffer: MAX_JSON_RECEIPT_BYTES });
  if (`sha256:${sha256Bytes(bytes)}` !== expectedDigest && bytes.at(-1) === 0x0a && `sha256:${sha256Bytes(bytes.subarray(0, -1))}` === expectedDigest) {
    bytes = bytes.subarray(0, -1);
  }
  if (`sha256:${sha256Bytes(bytes)}` !== expectedDigest || bytes.length === 0 || bytes.length > MAX_JSON_RECEIPT_BYTES) {
    fail("registry returned bytes that do not reproduce the requested manifest digest", "CANDIDATE_PREPARE_FAILED");
  }
  let document;
  try { document = JSON.parse(bytes.toString("utf8")); }
  catch { fail("registry returned an invalid manifest preimage", "CANDIDATE_PREPARE_FAILED"); }
  const resolvedMediaType = mediaType ?? document.mediaType;
  return {
    document,
    record: { bytesBase64: bytes.toString("base64"), digest: expectedDigest, mediaType: resolvedMediaType, size: bytes.length },
  };
}

function captureRegistryProvenance(reference, env) {
  const sourceDigest = reference.slice(reference.lastIndexOf("@") + 1);
  const index = dockerRawManifest(reference, sourceDigest, null, env);
  if (!OCI_INDEX_MEDIA_TYPES.has(index.record.mediaType) || !Array.isArray(index.document.manifests)) {
    fail("fixed third-party reference is not a supported multi-platform index", "CANDIDATE_PREPARE_FAILED");
  }
  const selected = index.document.manifests.filter((descriptor) => descriptor?.platform?.os === "linux" && descriptor?.platform?.architecture === "arm64");
  if (selected.length !== 1 || !DOCKER_SHA256.test(selected[0].digest) || !Number.isSafeInteger(selected[0].size) || !OCI_MANIFEST_MEDIA_TYPES.has(selected[0].mediaType)) {
    fail("fixed third-party reference does not select one supported linux/arm64 manifest", "CANDIDATE_PREPARE_FAILED");
  }
  const base = reference.slice(0, reference.lastIndexOf("@"));
  const manifest = dockerRawManifest(`${base}@${selected[0].digest}`, selected[0].digest, selected[0].mediaType, env);
  if (manifest.record.size !== selected[0].size) fail("registry child manifest size differs from its index descriptor", "CANDIDATE_PREPARE_FAILED");
  return { index: index.record, manifest: manifest.record };
}

function prepareDockerImages(snapshot, releaseId, sourceCommit, sourceTree, destination, env) {
  const records = [];
  // Fetch and digest every immutable registry preimage before the first image
  // build/pull mutates the daemon. The same raw evidence is later verified
  // offline against Docker save's configs and layers.
  const registryByReference = new Map(THIRD_PARTY_IMAGES.map((reference) => [reference, captureRegistryProvenance(reference, env)]));
  for (const image of FIRST_PARTY_IMAGES) {
    const reference = `ai-pin-revival/${image.component}:${releaseId}`;
    const bundleReference = reference;
    const args = ["buildx", "build", "--platform", "linux/arm64", "--load", "--pull", "--provenance=false", "--sbom=false", "--file", path.join(snapshot, image.context, image.dockerfile), "--tag", reference];
    if (image.additionalContext) args.push("--build-context", `${image.additionalContext.split("=")[0]}=${path.join(snapshot, image.additionalContext.split("=")[1])}`);
    if (image.component === "center") args.push("--build-arg", `REVIVAL_RELEASE_ID=${releaseId}`);
    for (const [label, value] of Object.entries({
      "dk.andersmadsen.ai-pin-revival.product": "Ai Pin Revival",
      "dk.andersmadsen.ai-pin-revival.release": releaseId,
      "dk.andersmadsen.ai-pin-revival.component": image.component,
      "dk.andersmadsen.ai-pin-revival.source-commit": sourceCommit,
      "dk.andersmadsen.ai-pin-revival.source-tree": sourceTree,
      "org.opencontainers.image.revision": sourceCommit,
    })) args.push("--label", `${label}=${value}`);
    args.push(path.join(snapshot, image.context));
    run("docker", args, { env, maxBuffer: 256 * 1024 * 1024 });
    records.push(inspectDockerImage(reference, { bundleReference, firstParty: true, component: image.component, releaseId, env }));
  }
  for (const reference of THIRD_PARTY_IMAGES) {
    run("docker", ["pull", "--platform", "linux/arm64", reference], { env, maxBuffer: 256 * 1024 * 1024 });
    const bundleReference = explicitDockerTag(reference);
    const record = inspectDockerImage(reference, { bundleReference, firstParty: false, releaseId, registry: registryByReference.get(reference), env });
    run("docker", ["image", "tag", record.imageId, bundleReference], { env });
    const rebound = run("docker", ["image", "inspect", "--format", "{{.Id}}", bundleReference], { env });
    if (rebound !== record.imageId) fail("Docker bundle tag could not be bound to the inspected image ID", "CANDIDATE_PREPARE_FAILED");
    records.push(record);
  }
  records.sort((left, right) => left.reference.localeCompare(right.reference));
  run("docker", ["image", "save", "--output", destination, ...records.map((entry) => entry.bundleReference)], { env, maxBuffer: 256 * 1024 * 1024 });
  for (const record of records) {
    const rebound = run("docker", ["image", "inspect", "--format", "{{.Id}}", record.bundleReference], { env });
    if (rebound !== record.imageId) fail("Docker tag moved between inspection and image export", "CANDIDATE_PREPARE_FAILED");
  }
  return records;
}

function resolveExactGitIdentity(ref, gitEnv) {
  assertString(ref, /^[A-Za-z0-9._/@{}^~:-]+$/u, "Git commit", 256);
  const commit = run("git", ["rev-parse", "--verify", `${ref}^{commit}`], { env: gitEnv });
  const tree = run("git", ["rev-parse", "--verify", `${commit}^{tree}`], { env: gitEnv });
  if (!GIT_OBJECT_ID.test(commit) || !GIT_OBJECT_ID.test(tree)) fail("Git returned unsupported object IDs", "CANDIDATE_PREPARE_FAILED");
  return { commit, tree };
}

function readAuthorityFile(root, relative, maximum = MAX_JSON_RECEIPT_BYTES) {
  const absolute = path.join(root, ...relative.split("/"));
  const metadata = hashRegularPath(absolute, maximum);
  const bytes = fs.readFileSync(absolute);
  if (bytes.length !== metadata.size || sha256Bytes(bytes) !== metadata.sha256) {
    fail(`production authority input moved while reading: ${relative}`, "PRODUCTION_STATE_INCOMPATIBLE");
  }
  return { bytes, sha256: metadata.sha256 };
}

function validateComposeAuthority(authority) {
  assertExactKeys(authority, ["composeFiles", "effective", "forbiddenRenamedResources", "productionState", "releaseConfig", "remoteCommon", "schema", "schemaVersion"], "production Compose authority");
  if (authority.schema !== "revival.production-compose-authority" || authority.schemaVersion !== 3) {
    fail("production Compose authority schema is unsupported", "PRODUCTION_STATE_INCOMPATIBLE");
  }
  assertExactKeys(authority.composeFiles, COMPOSE_AUTHORITY_INPUTS, "production Compose authority files");
  for (const [relative, digest] of Object.entries(authority.composeFiles)) {
    if (!COMPOSE_AUTHORITY_INPUTS.includes(relative) || !SHA256.test(digest)) fail("production Compose authority has an invalid file digest", "PRODUCTION_STATE_INCOMPATIBLE");
  }
  for (const [label, value] of [["remote common", authority.remoteCommon], ["release config", authority.releaseConfig]]) {
    assertExactKeys(value, ["path", "sha256"], `production authority ${label}`);
    assertString(value.path, /^[A-Za-z0-9][A-Za-z0-9._/-]+$/u, `production authority ${label} path`, 256);
    if (!SHA256.test(value.sha256)) fail(`production authority ${label} digest is invalid`, "PRODUCTION_STATE_INCOMPATIBLE");
  }
  validateProductionState(authority.productionState);
  if (canonicalStringify(authority.productionState) !== canonicalStringify(LEGACY_PRODUCTION_STATE)) {
    fail("production Compose authority differs from the exact live legacy resource contract",
      "PRODUCTION_STATE_INCOMPATIBLE");
  }
  assertExactKeys(authority.forbiddenRenamedResources,
    ["centerDataPaths", "networks", "projects", "stateTargets", "volumes"],
    "forbidden renamed production resources");
  if (canonicalStringify(authority.forbiddenRenamedResources) !==
      canonicalStringify(FORBIDDEN_RENAMED_PRODUCTION_RESOURCES)) {
    fail("production Compose authority lost the closed renamed-resource refusal set",
      "PRODUCTION_STATE_INCOMPATIBLE");
  }
  const effective = authority.effective;
  assertExactKeys(effective, ["activeServices", "centerData", "projectName", "protectedNetworks", "protectedVolumes", "resources", "serviceImages"], "effective production Compose authority");
  assertString(effective.projectName, /^[a-z0-9][a-z0-9._-]+$/u, "effective Compose project name", 128);
  sortedUnique(effective.activeServices, "effective Compose services");
  for (const service of effective.activeServices) assertString(service, /^[a-z0-9][a-z0-9-]+$/u, "effective Compose service", 128);
  const expectedServiceImages = productionServiceImageTemplates();
  assertExactKeys(effective.serviceImages, Object.keys(expectedServiceImages), "effective Compose service images");
  if (canonicalStringify(effective.activeServices) !== canonicalStringify(Object.keys(expectedServiceImages).sort())) {
    fail("effective Compose service image authority has a different service set", "PRODUCTION_STATE_INCOMPATIBLE");
  }
  for (const [service, mapping] of Object.entries(effective.serviceImages)) {
    assertExactKeys(mapping, ["reference", "role"], `effective Compose service image ${service}`);
    if (canonicalStringify(mapping) !== canonicalStringify(expectedServiceImages[service])) {
      fail(`effective Compose service image ${service} differs from the reviewed role/reference`, "PRODUCTION_STATE_INCOMPATIBLE");
    }
  }
  assertExactKeys(effective.centerData, ["readOnly", "service", "source", "target", "type"], "effective Center data grant");
  if (effective.centerData.type !== "bind" || effective.centerData.target !== "/data" || effective.centerData.readOnly !== false ||
      !effective.activeServices.includes(effective.centerData.service) || path.posix.normalize(effective.centerData.source) !== effective.centerData.source ||
      !effective.centerData.source.startsWith("/")) fail("effective Center data grant is invalid", "PRODUCTION_STATE_INCOMPATIBLE");
  assertExactKeys(effective.resources, ["networks", "volumes"], "effective Compose resources");
  for (const [kind, resources] of Object.entries(effective.resources)) {
    assertPlainObject(resources, `effective Compose ${kind}`);
    for (const [logical, external] of Object.entries(resources)) {
      assertString(logical, /^[a-z0-9][a-z0-9-]+$/u, `effective Compose ${kind} key`, 128);
      if (external !== null) assertString(external, /^[A-Za-z0-9][A-Za-z0-9_.-]+$/u, `effective Compose ${kind} external name`, 256);
    }
  }
  for (const [logical, volume] of Object.entries(effective.protectedVolumes)) {
    assertExactKeys(volume, ["externalName", "grants"], `protected volume ${logical}`);
    if (effective.resources.volumes[logical] !== volume.externalName || !Array.isArray(volume.grants) || volume.grants.length === 0) {
      fail(`protected volume ${logical} is not an exact used external resource`, "PRODUCTION_STATE_INCOMPATIBLE");
    }
    const normalized = volume.grants.map((grant) => {
      assertExactKeys(grant, ["readOnly", "service", "target"], `protected volume ${logical} grant`);
      if (!effective.activeServices.includes(grant.service) || typeof grant.readOnly !== "boolean" || !String(grant.target).startsWith("/")) {
        fail(`protected volume ${logical} grant is invalid`, "PRODUCTION_STATE_INCOMPATIBLE");
      }
      return grant;
    });
    if (canonicalStringify(normalized) !== canonicalStringify([...normalized].sort((a, b) => `${a.service}\0${a.target}`.localeCompare(`${b.service}\0${b.target}`, "en")))) {
      fail(`protected volume ${logical} grants are not canonical`, "PRODUCTION_STATE_INCOMPATIBLE");
    }
  }
  for (const [logical, network] of Object.entries(effective.protectedNetworks)) {
    assertExactKeys(network, ["externalName", "services"], `protected network ${logical}`);
    if (effective.resources.networks[logical] !== network.externalName) fail(`protected network ${logical} is not an exact external resource`, "PRODUCTION_STATE_INCOMPATIBLE");
    sortedUnique(network.services, `protected network ${logical} services`);
    if (network.services.some((service) => !effective.activeServices.includes(service))) fail(`protected network ${logical} names an inactive service`, "PRODUCTION_STATE_INCOMPATIBLE");
  }
  const volumes = Object.values(effective.protectedVolumes).map((entry) => entry.externalName).sort();
  const networks = Object.values(effective.protectedNetworks).map((entry) => entry.externalName).sort();
  if (effective.projectName !== authority.productionState.runtimeProject || effective.centerData.source !== authority.productionState.centerDataPath ||
      canonicalStringify(volumes) !== canonicalStringify(authority.productionState.volumes) ||
      canonicalStringify(networks) !== canonicalStringify(authority.productionState.externalNetworks)) {
    fail("effective Compose model and production-state contract disagree", "PRODUCTION_STATE_INCOMPATIBLE");
  }
  const stateTargets = Object.values(effective.protectedVolumes)
    .flatMap((entry) => entry.grants.map((grant) => grant.target));
  if (authority.forbiddenRenamedResources.projects.includes(effective.projectName) ||
      authority.forbiddenRenamedResources.centerDataPaths.includes(effective.centerData.source) ||
      volumes.some((entry) => authority.forbiddenRenamedResources.volumes.includes(entry)) ||
      networks.some((entry) => authority.forbiddenRenamedResources.networks.includes(entry)) ||
      stateTargets.some((entry) => authority.forbiddenRenamedResources.stateTargets.includes(entry))) {
    fail("effective Compose model selects a forbidden undeployed Cosmos resource",
      "PRODUCTION_STATE_INCOMPATIBLE");
  }
  return authority;
}

function composeResourceProjection(resources, kind) {
  assertPlainObject(resources, `hosted Compose ${kind}`);
  const result = {};
  for (const logical of Object.keys(resources).sort()) {
    const value = resources[logical];
    assertPlainObject(value, `hosted Compose ${kind} ${logical}`);
    result[logical] = value.external === true ? value.name : null;
  }
  return result;
}

export function validateEffectiveComposeConfig(config, authority,
                                               releaseId = "compose-authority-probe") {
  validateComposeAuthority(authority);
  assertPlainObject(config, "hosted effective Compose model");
  assertPlainObject(config.services, "hosted effective Compose services");
  const actualServices = Object.keys(config.services).sort();
  if (config.name !== authority.effective.projectName || canonicalStringify(actualServices) !== canonicalStringify(authority.effective.activeServices)) {
    fail("hosted Compose active project or service set differs from the reviewed authority", "PRODUCTION_STATE_INCOMPATIBLE");
  }
  for (const [name, service] of Object.entries(config.services)) {
    assertPlainObject(service, `hosted Compose service ${name}`);
    if (Array.isArray(service.profiles) && service.profiles.length > 0) fail("hosted production Compose contains an inactive profiled service", "PRODUCTION_STATE_INCOMPATIBLE");
    if (service.extends !== undefined) fail("hosted production Compose retains an unresolved extends directive", "PRODUCTION_STATE_INCOMPATIBLE");
    const expectedImage = authority.effective.serviceImages[name].reference
      .replace("{releaseId}", releaseId);
    if (service.image !== expectedImage) {
      fail(`hosted Compose service ${name} image differs from the reviewed role/reference`, "PRODUCTION_STATE_INCOMPATIBLE");
    }
  }
  const resources = {
    networks: composeResourceProjection(config.networks ?? {}, "networks"),
    volumes: composeResourceProjection(config.volumes ?? {}, "volumes"),
  };
  if (canonicalStringify(resources) !== canonicalStringify(authority.effective.resources)) {
    fail("hosted Compose logical resource map differs from the reviewed authority", "PRODUCTION_STATE_INCOMPATIBLE");
  }
  const volumeGrants = (logical) => actualServices.flatMap((serviceName) => {
    const volumes = config.services[serviceName].volumes ?? [];
    if (!Array.isArray(volumes)) fail(`hosted Compose service ${serviceName} volumes are unresolved`, "PRODUCTION_STATE_INCOMPATIBLE");
    return volumes.filter((volume) => volume?.type === "volume" && volume.source === logical).map((volume) => ({
      readOnly: volume.read_only === true,
      service: serviceName,
      target: volume.target,
    }));
  }).sort((a, b) => `${a.service}\0${a.target}`.localeCompare(`${b.service}\0${b.target}`, "en"));
  for (const [logical, expected] of Object.entries(authority.effective.protectedVolumes)) {
    if (canonicalStringify(volumeGrants(logical)) !== canonicalStringify(expected.grants)) {
      fail(`hosted Compose grants for protected volume ${logical} differ from the reviewed authority`, "PRODUCTION_STATE_INCOMPATIBLE");
    }
  }
  for (const [logical, expected] of Object.entries(authority.effective.protectedNetworks)) {
    const services = actualServices.filter((serviceName) => {
      const networks = config.services[serviceName].networks ?? {};
      return Array.isArray(networks) ? networks.includes(logical) : Object.hasOwn(networks, logical);
    });
    if (canonicalStringify(services) !== canonicalStringify(expected.services)) {
      fail(`hosted Compose grants for protected network ${logical} differ from the reviewed authority`, "PRODUCTION_STATE_INCOMPATIBLE");
    }
  }
  const centerVolumes = config.services[authority.effective.centerData.service].volumes ?? [];
  const centerData = centerVolumes.filter((volume) => volume?.target === "/data");
  if (centerData.length !== 1 || canonicalStringify({
    readOnly: centerData[0].read_only === true,
    service: authority.effective.centerData.service,
    source: centerData[0].source,
    target: centerData[0].target,
    type: centerData[0].type,
  }) !== canonicalStringify(authority.effective.centerData)) {
    fail("hosted Compose Center /data grant differs from the reviewed authority", "PRODUCTION_STATE_INCOMPATIBLE");
  }
  return true;
}

function loadProductionAuthority(snapshot, trustedRoot = ROOT) {
  const selectedAuthority = readAuthorityFile(snapshot, PRODUCTION_AUTHORITY_PATH);
  const trustedAuthority = readAuthorityFile(trustedRoot, PRODUCTION_AUTHORITY_PATH);
  if (!selectedAuthority.bytes.equals(trustedAuthority.bytes)) {
    fail("selected production authority is not byte-identical to the reviewed authority", "PRODUCTION_STATE_INCOMPATIBLE");
  }
  let authority;
  try { authority = JSON.parse(selectedAuthority.bytes.toString("utf8")); }
  catch { fail("production Compose authority is invalid JSON", "PRODUCTION_STATE_INCOMPATIBLE"); }
  validateComposeAuthority(authority);
  for (const relative of COMPOSE_AUTHORITY_INPUTS) {
    const selected = readAuthorityFile(snapshot, relative, 16 * 1024 * 1024);
    const trusted = readAuthorityFile(trustedRoot, relative, 16 * 1024 * 1024);
    if (!selected.bytes.equals(trusted.bytes) || selected.sha256 !== authority.composeFiles[relative]) {
      fail(`selected Compose input differs from the exact reviewed bytes: ${relative}`, "PRODUCTION_STATE_INCOMPATIBLE");
    }
  }
  for (const binding of [authority.remoteCommon, authority.releaseConfig]) {
    const selected = readAuthorityFile(snapshot, binding.path, 16 * 1024 * 1024);
    const trusted = readAuthorityFile(trustedRoot, binding.path, 16 * 1024 * 1024);
    if (!selected.bytes.equals(trusted.bytes) || selected.sha256 !== binding.sha256) {
      fail(`selected production contract differs from the exact reviewed bytes: ${binding.path}`, "PRODUCTION_STATE_INCOMPATIBLE");
    }
  }
  return authority;
}

export function productionStateForSnapshot(snapshot, trustedRoot = ROOT) {
  return structuredClone(loadProductionAuthority(snapshot, trustedRoot).productionState);
}

function assertHostedComposeAuthority(snapshot, authority, env,
                                      releaseId = "compose-authority-probe") {
  const required = new Set(["REVIVAL_RELEASE_ID"]);
  for (const relative of COMPOSE_AUTHORITY_INPUTS) {
    const source = fs.readFileSync(path.join(snapshot, ...relative.split("/")), "utf8");
    for (const match of source.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):\?[^}]*\}/gu)) required.add(match[1]);
  }
  const composeEnv = { ...env };
  for (const name of required) composeEnv[name] = name === "REVIVAL_RELEASE_ID" ? releaseId : "compose-authority-probe";
  let config;
  try {
    config = JSON.parse(run("docker", ["compose", "-f", path.join(snapshot, "compose.yaml"), "-f", path.join(snapshot, "platform/compose/production.yaml"), "config", "--format", "json"], { cwd: snapshot, env: composeEnv, maxBuffer: 64 * 1024 * 1024 }));
  } catch {
    fail("Docker Compose could not produce the effective production model", "PRODUCTION_STATE_INCOMPATIBLE");
  }
  validateEffectiveComposeConfig(config, authority, releaseId);
  return createProductionComposeModel({
    releaseId,
    authoritySha256: readAuthorityFile(snapshot, PRODUCTION_AUTHORITY_PATH).sha256,
    composeFiles: authority.composeFiles,
  });
}

function protocolInventory(root) {
  const fixed = [
    "compose.yaml",
    "platform/compose/production.yaml",
    "platform/deploy/candidate-store.py",
    "platform/deploy/production-compose-authority.json",
    "platform/deploy/release-candidate.mjs",
    "platform/deploy/release.json",
    "platform/deploy/release.mjs",
    "platform/cli/production.js",
  ];
  const vpsRoot = path.join(root, "platform/deploy/vps");
  const walk = (directory, relative) => {
    const records = [];
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const childRelative = `${relative}/${name}`;
      const metadata = fs.lstatSync(absolute, { throwIfNoEntry: false });
      if (!metadata || metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) fail("candidate protocol tree contains an unsafe entry", "CANDIDATE_PREPARE_FAILED");
      if (metadata.isDirectory()) records.push(...walk(absolute, childRelative));
      else records.push(childRelative);
    }
    return records;
  };
  const paths = [...fixed, ...walk(vpsRoot, "platform/deploy/vps")].sort();
  return paths.map((relative) => {
    const absolute = path.join(root, ...relative.split("/"));
    const metadata = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) fail(`candidate protocol file is unsafe: ${relative}`, "CANDIDATE_PREPARE_FAILED");
    return { relative, executable: (metadata.mode & 0o111) !== 0, sha256: hashRegularPath(absolute, 64 * 1024 * 1024).sha256 };
  });
}

export function assertImmutableCandidateProtocol(snapshot) {
  const trusted = protocolInventory(ROOT);
  const selected = protocolInventory(snapshot);
  if (canonicalStringify(selected) !== canonicalStringify(trusted)) {
    fail("selected commit does not contain the byte-identical reviewed candidate/deployment protocol", "CANDIDATE_PREPARE_FAILED");
  }
  return true;
}

export function assertReleaseProtocolManifestMatchesTrusted(manifest, trustedRoot = ROOT) {
  if (!manifest || !Array.isArray(manifest.entries)) {
    fail("selected release manifest lacks its protocol inventory", "CANDIDATE_INVALID");
  }
  const trusted = protocolInventory(trustedRoot);
  const fixed = new Set([
    "compose.yaml",
    "platform/compose/production.yaml",
    "platform/deploy/candidate-store.py",
    "platform/deploy/production-compose-authority.json",
    "platform/deploy/release-candidate.mjs",
    "platform/deploy/release.json",
    "platform/deploy/release.mjs",
    "platform/cli/production.js",
  ]);
  const isProtocolPath = (entryPath) => fixed.has(entryPath) || entryPath.startsWith("platform/deploy/vps/");
  const selected = manifest.entries.filter((entry) => entry && typeof entry.path === "string" && isProtocolPath(entry.path));
  const selectedByPath = new Map(selected.map((entry) => [entry.path, entry]));
  if (selectedByPath.size !== selected.length || canonicalStringify([...selectedByPath.keys()].sort()) !==
      canonicalStringify(trusted.map((entry) => entry.relative).sort())) {
    fail("selected release protocol file set differs from the currently reviewed protocol", "CANDIDATE_INVALID");
  }
  for (const expected of trusted) {
    const entry = selectedByPath.get(expected.relative);
    const mode = expected.executable ? "0755" : "0644";
    if (entry.sha256 !== expected.sha256 || entry.mode !== mode) {
      fail(`selected release protocol bytes differ from the currently reviewed protocol: ${expected.relative}`, "CANDIDATE_INVALID");
    }
  }
  return true;
}

export function assertOfflineProductionAuthority(manifest, productionState, composeModel,
                                                  trustedRoot = ROOT) {
  const selected = readAuthorityFile(trustedRoot, PRODUCTION_AUTHORITY_PATH);
  let authority;
  try { authority = JSON.parse(selected.bytes.toString("utf8")); }
  catch { fail("trusted production authority is invalid JSON", "CANDIDATE_INVALID"); }
  validateComposeAuthority(authority);
  validateProductionState(productionState);
  if (canonicalStringify(productionState) !== canonicalStringify(authority.productionState)) {
    fail("candidate production-state receipt differs from the reviewed effective Compose authority",
      "PRODUCTION_STATE_INCOMPATIBLE");
  }
  validateProductionComposeModel(composeModel, composeModel?.releaseId);
  if (composeModel.authority.sha256 !== selected.sha256 ||
      canonicalStringify(composeModel.composeFiles) !== canonicalStringify(authority.composeFiles) ||
      canonicalStringify(Object.fromEntries(Object.entries(composeModel.services)
        .map(([service, mapping]) => [service, { reference: mapping.reference, role: mapping.role }]))) !==
        canonicalStringify(Object.fromEntries(Object.entries(authority.effective.serviceImages)
          .map(([service, mapping]) => [service, {
            ...mapping,
            reference: mapping.reference.replace("{releaseId}", composeModel.releaseId),
          }])))) {
    fail("candidate Compose model differs from the exact reviewed source/model authority",
      "PRODUCTION_STATE_INCOMPATIBLE");
  }
  assertReleaseProtocolManifestMatchesTrusted(manifest, trustedRoot);
  return true;
}

export function prepareCandidate({ commitRef = "HEAD", dataDir = DEFAULT_DATA_DIR, hostedWorkflow = false } = {}) {
  const dataRoot = ensureExternalDataRoot(dataDir);
  const buildDescriptor = openOrCreatePrivateChild(dataRoot.descriptor, "candidate-build");
  const workName = `.prepare-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  const workDescriptor = openOrCreatePrivateChild(buildDescriptor, workName, { exclusive: true });
  const workMetadata = fs.fstatSync(workDescriptor, { bigint: true });
  const artifactsDescriptor = openOrCreatePrivateChild(workDescriptor, "artifacts", { exclusive: true });
  const homeDescriptor = openOrCreatePrivateChild(workDescriptor, "home", { exclusive: true });
  let snapshotDescriptor = openOrCreatePrivateChild(workDescriptor, "detached-worktree", { exclusive: true });
  let sourceDescriptor = openOrCreatePrivateChild(workDescriptor, "source", { exclusive: true });
  const work = descriptorPath(buildDescriptor, workName);
  const snapshot = path.join(work, "detached-worktree");
  let buildSource = path.join(work, "source");
  const artifacts = descriptorPath(artifactsDescriptor);
  const isolatedHome = descriptorPath(homeDescriptor);
  const gitEnvironment = candidateGitEnvironment(isolatedHome);
  const identityBefore = resolveExactGitIdentity(commitRef, gitEnvironment);
  let worktreeAdded = false;
  try {
    // The worktree is an identity anchor only. --no-checkout prevents Git
    // filters, attributes, or checkout helpers from producing the bytes used by
    // the build; those bytes come directly from verified blob objects below.
    const snapshotIdentity = fs.fstatSync(snapshotDescriptor, { bigint: true });
    run("git", ["worktree", "add", "--detach", "--no-checkout", snapshot, identityBefore.commit], { env: gitEnvironment });
    worktreeAdded = true;
    fs.fchmodSync(snapshotDescriptor, 0o700);
    const snapshotAfterGit = requirePrivateDirectory(snapshotDescriptor, "detached candidate worktree");
    if (snapshotAfterGit.dev !== snapshotIdentity.dev || snapshotAfterGit.ino !== snapshotIdentity.ino) {
      fail("detached candidate worktree was replaced during Git setup", "CANDIDATE_PREPARE_FAILED");
    }
    // Git creates this administrative pointer subject to the caller's umask.
    // Normalize it before any work and before descriptor-relative cleanup so a
    // permissive host umask cannot turn our managed tree into writable input.
    const gitPointerDescriptor = fs.openSync(descriptorPath(snapshotDescriptor, ".git"), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const gitPointer = fs.fstatSync(gitPointerDescriptor, { bigint: true });
      if (!gitPointer.isFile() || gitPointer.isSymbolicLink() || gitPointer.nlink !== 1n ||
          gitPointer.uid !== BigInt(process.getuid()) || gitPointer.gid !== BigInt(process.getgid())) {
        fail("detached candidate worktree Git pointer is unsafe", "CANDIDATE_PREPARE_FAILED");
      }
      fs.fchmodSync(gitPointerDescriptor, 0o600);
    } finally {
      fs.closeSync(gitPointerDescriptor);
    }
    const heldSnapshot = descriptorPath(snapshotDescriptor);
    const head = run("git", ["rev-parse", "HEAD"], { cwd: heldSnapshot, env: gitEnvironment });
    const tree = run("git", ["rev-parse", "HEAD^{tree}"], { cwd: heldSnapshot, env: gitEnvironment });
    const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: heldSnapshot, env: gitEnvironment });
    if (head !== identityBefore.commit || tree !== identityBefore.tree || branch !== "HEAD") fail("candidate worktree is not the exact selected detached identity", "CANDIDATE_PREPARE_FAILED");

    const gitArchivePath = path.join(artifacts, "source-snapshot.tar");
    createRawGitArchive(identityBefore.commit, gitArchivePath, gitEnvironment);
    const gitArchiveMetadata = hashRegularPath(gitArchivePath, MAX_SOURCE_ARCHIVE_BYTES);
    assertSourceArchiveTree(gitArchivePath, head, tree);
    sourceDescriptor = extractSourceArchive(gitArchivePath, sourceDescriptor, head, tree);
    buildSource = descriptorPath(sourceDescriptor);
    assertExtractedSourceMatches(gitArchivePath, buildSource, head, tree);

    // This semantic gate consumes the same exact source bytes as packaging and
    // Docker. It is deliberately before the native-builder check and every
    // Docker command, so the current Cosmos-renamed HEAD is always refused.
    const productionAuthority = loadProductionAuthority(buildSource);
    const productionState = structuredClone(productionAuthority.productionState);
    assertLegacyProductionCompatible(productionState);
    assertImmutableCandidateProtocol(buildSource);

    const sourceCommitObjectPath = path.join(artifacts, "source-commit.txt");
    const sourceCommit = childProcess.spawnSync(commandPath("git"), ["cat-file", "commit", identityBefore.commit], {
      cwd: ROOT,
      env: gitEnvironment,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (sourceCommit.error || sourceCommit.status !== 0 || !Buffer.isBuffer(sourceCommit.stdout)) fail("Git commit object could not be captured", "CANDIDATE_PREPARE_FAILED");
    if (gitObjectHash(gitAlgorithm(head), "commit", sourceCommit.stdout.length, [sourceCommit.stdout]) !== head) fail("Git commit bytes moved while being captured", "CANDIDATE_PREPARE_FAILED");
    writeExclusive(sourceCommitObjectPath, sourceCommit.stdout);

    // This boundary deliberately precedes every Docker command.  QEMU on the
    // ARM development server is a known-bad build path; native x64 CI prepares
    // the candidate and the sealed bytes are then deployable from any host.
    if (process.platform !== "linux" || process.arch !== "x64") {
      fail("release candidate preparation requires a native linux/amd64 builder and refused before Docker", "NATIVE_X64_REQUIRED");
    }
    const env = cleanBuildEnvironment(isolatedHome, gitEnvironment);
    assertHostedComposeAuthority(buildSource, productionAuthority, env);
    const toolchainBefore = captureToolchains(env);
    const packageOutput = run("node", [path.join(buildSource, "platform/deploy/release.mjs"), "build", "--profile", "vps", "--output", artifacts, "--json"], { cwd: buildSource, env });
    let release;
    try { release = JSON.parse(packageOutput); } catch { fail("release packager returned an invalid descriptor", "CANDIDATE_PREPARE_FAILED"); }
    const archivePath = path.resolve(release.archivePath);
    const manifestPath = path.resolve(release.manifestPath);
    const releaseManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assertHostedComposeAuthority(buildSource, productionAuthority, env, release.releaseId);
    assertExtractedSourceMatches(gitArchivePath, buildSource, head, tree);
    const imageBundlePath = path.join(artifacts, "images.tar");
    const images = prepareDockerImages(buildSource, release.releaseId, head, tree, imageBundlePath, env);
    const { sha256: bundleSha256, size: bundleSize } = hashRegularPath(imageBundlePath, MAX_IMAGE_BUNDLE_BYTES);
    const imageReceipt = {
      schema: "revival.docker-image-receipt",
      schemaVersion: 4,
      // `platform` is the native, attested producer. Every image has its own
      // target platform and the receipt binds that common target explicitly.
      platform: "linux/amd64",
      targetPlatform: "linux/arm64",
      bundle: { sha256: bundleSha256, size: bundleSize },
      images,
    };
    verifyDockerBundlePath(imageBundlePath, imageReceipt);
    const composeModel = createProductionComposeModel({
      releaseId: release.releaseId,
      authoritySha256: readAuthorityFile(buildSource, PRODUCTION_AUTHORITY_PATH).sha256,
      composeFiles: productionAuthority.composeFiles,
      imageReceipt,
    });
    const sourceReceipt = {
      schema: "revival.source-snapshot-receipt",
      schemaVersion: 2,
      archiveRole: "source-snapshot",
      commitObjectRole: "source-commit-object",
      commit: head,
      tree,
      clean: true,
      detached: true,
      archiveSha256: gitArchiveMetadata.sha256,
    };
    const toolchainAfter = captureToolchains(env);
    if (canonicalStringify(toolchainAfter) !== canonicalStringify(toolchainBefore)) {
      fail("toolchain identity moved during candidate preparation", "CANDIDATE_PREPARE_FAILED");
    }
    const toolchainReceipt = toolchainBefore;
    const identityAfter = resolveExactGitIdentity(identityBefore.commit, gitEnvironment);
    const postSnapshot = descriptorPath(snapshotDescriptor);
    const postHead = run("git", ["rev-parse", "HEAD"], { cwd: postSnapshot, env: gitEnvironment });
    const postTree = run("git", ["rev-parse", "HEAD^{tree}"], { cwd: postSnapshot, env: gitEnvironment });
    const postBranch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: postSnapshot, env: gitEnvironment });
    if (canonicalStringify(identityAfter) !== canonicalStringify(identityBefore) || postHead !== head || postTree !== tree || postBranch !== "HEAD") {
      fail("Git identity or detached source snapshot moved during candidate preparation", "CANDIDATE_PREPARE_FAILED");
    }
    assertExtractedSourceMatches(gitArchivePath, buildSource, head, tree);
    return sealCandidateFromFiles({
      dataDir: dataRoot.absolute,
      releaseArchivePath: archivePath,
      releaseManifest,
      releaseDescriptor: release,
      releaseVerifierPath: path.join(buildSource, "platform/deploy/vps/verify-release.py"),
      sourceArchivePath: gitArchivePath,
      sourceCommitObjectPath,
      sourceReceipt,
      composeModel,
      productionState,
      toolchainReceipt,
      imageReceipt,
      imageBundlePath,
      authority: hostedWorkflow ? HOSTED_CANDIDATE_AUTHORITY : LOCAL_CANDIDATE_AUTHORITY,
    });
  } finally {
    for (const descriptor of [sourceDescriptor, snapshotDescriptor, homeDescriptor, artifactsDescriptor, workDescriptor]) {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch {}
      }
    }
    try {
      candidateStoreHelper(["cleanup", "--name", workName, "--dev", String(workMetadata.dev), "--ino", String(workMetadata.ino)], buildDescriptor);
      // `git worktree remove --force <path>` recursively deletes the pathname it
      // is handed and is therefore not an acceptable cleanup primitive if a
      // same-UID process swaps that name. The descriptor helper above logically
      // retired only the exact held inode. Prune now drops Git's stale
      // administrative record; it never traverses or deletes a worktree path.
      if (worktreeAdded) {
        const pruned = childProcess.spawnSync(commandPath("git"), ["worktree", "prune", "--expire", "now"], {
          cwd: ROOT, env: gitEnvironment, stdio: "ignore",
        });
        if (pruned.error || pruned.status !== 0) fail("detached worktree administration could not be pruned safely", "CANDIDATE_PREPARE_FAILED");
      }
    } finally {
      fs.closeSync(buildDescriptor);
      fs.closeSync(dataRoot.descriptor);
    }
  }
}

function usage() {
  return [
    "usage:",
    "  release-candidate.mjs prepare [--commit COMMIT] [--data-dir DIR] [--hosted-workflow] [--json]",
    "  release-candidate.mjs verify (--candidate PATH [--expect-id SHA256] | --id SHA256) [--data-dir DIR] [--json]",
    "  release-candidate.mjs inspect (--candidate PATH [--expect-id SHA256] | --id SHA256) [--data-dir DIR] [--json]",
    "",
    "prepare resolves one commit, uses a detached clean snapshot, and requires native linux/amd64 before Docker.",
    "Ordinary prepare output is candidate/debug-only. --hosted-workflow marks signed workflow bytes but still requires fresh provider evidence at deploy.",
    "verify and inspect are read-only and never execute candidate code or load images.",
  ].join("\n");
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!["prepare", "verify", "inspect"].includes(command)) fail(usage(), "CANDIDATE_USAGE");
  const options = { command, dataDir: DEFAULT_DATA_DIR, json: false, commitRef: "HEAD", candidate: "", id: "", expectedId: "", hostedWorkflow: false };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--hosted-workflow" && !options.hostedWorkflow) options.hostedWorkflow = true;
    else if (["--data-dir", "--commit", "--candidate", "--id", "--expect-id"].includes(arg)) {
      const value = rest[++index];
      if (!value || value.startsWith("-")) fail(`${arg} requires a value\n${usage()}`, "CANDIDATE_USAGE");
      if (arg === "--data-dir") options.dataDir = path.resolve(value);
      if (arg === "--commit") options.commitRef = value;
      if (arg === "--candidate") options.candidate = value;
      if (arg === "--id") options.id = value;
      if (arg === "--expect-id") options.expectedId = value;
    } else fail(`unsupported candidate option: ${arg}\n${usage()}`, "CANDIDATE_USAGE");
  }
  if (options.hostedWorkflow && command !== "prepare") fail("--hosted-workflow is accepted only by prepare", "CANDIDATE_USAGE");
  if (command === "prepare" && (options.candidate || options.id || options.expectedId)) fail(`prepare does not accept a prebuilt candidate\n${usage()}`, "CANDIDATE_USAGE");
  if (command !== "prepare") {
    if (Boolean(options.candidate) === Boolean(options.id)) fail(`exactly one of --candidate or --id is required\n${usage()}`, "CANDIDATE_USAGE");
    if (options.id && !SHA256.test(options.id)) fail("candidate ID must be a lowercase SHA-256 digest", "CANDIDATE_USAGE");
    if (options.expectedId && !SHA256.test(options.expectedId)) fail("expected candidate ID must be a lowercase SHA-256 digest", "CANDIDATE_USAGE");
    if (options.id && options.expectedId) fail("--expect-id is implicit with --id", "CANDIDATE_USAGE");
  }
  return options;
}

export function candidatePathForId(dataDir, id) {
  if (!SHA256.test(id)) fail("candidate ID must be a lowercase SHA-256 digest", "CANDIDATE_USAGE");
  return path.join(path.resolve(dataDir), "release-candidates", id);
}

async function main(argv) {
  const options = parseCli(argv);
  const result = options.command === "prepare"
    ? prepareCandidate({ commitRef: options.commitRef, dataDir: options.dataDir, hostedWorkflow: options.hostedWorkflow })
    : verifyCandidate(options.candidate || candidatePathForId(options.dataDir, options.id), {
      expectedId: options.id || options.expectedId,
      enforceTrustedProtocol: true,
    });
  const output = options.command === "inspect"
    ? { ok: true, candidateId: result.candidateId, root: result.root, releaseId: result.release.releaseId, authority: result.descriptor.body.authority, git: result.descriptor.body.git, productionCompatible: productionCompatibilityDifferences(result.productionState).length === 0, productionDifferences: productionCompatibilityDifferences(result.productionState), files: result.descriptor.body.files, images: result.imageReceipt.images }
    : { ok: true, candidateId: result.candidateId, root: result.root, releaseId: result.release.releaseId, authority: result.descriptor.body.authority, productionCompatible: productionCompatibilityDifferences(result.productionState).length === 0 };
  process.stdout.write(options.json ? `${canonicalStringify(output)}\n` : `${options.command} passed: candidate=${result.candidateId} release=${result.release.releaseId} path=${result.root}\n`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main(HELD_RELEASE.argv).catch((error) => {
    process.stderr.write(`error: ${error?.message ?? "candidate operation failed"}\n`);
    process.exitCode = error?.code === "CANDIDATE_USAGE" ? 64 : 1;
  });
}
