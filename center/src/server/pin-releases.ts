import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  realpath,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { logInfo, logWarn } from "./log";

/**
 * Implemented: Center serves only independently packaged Pin releases from an
 * operator-mounted directory. It never discovers APKs in the source tree and
 * never synthesizes a fallback manifest.
 */
export const PIN_RELEASE_SCHEMA_VERSION = 1;
export const PIN_RELEASE_CURRENT_MANIFEST = "current.json";
export const PIN_RELEASE_IMMUTABLE_MANIFEST = "manifest.json";
export const MAX_PIN_RELEASE_MANIFEST_BYTES = 64 * 1024;
export const MAX_PIN_RELEASE_ARTIFACT_BYTES = 512 * 1024 * 1024;

export const PIN_RELEASE_ROLES = [
  "installer",
  "bootstrap",
  "hook",
  "server",
  "hook-injector",
] as const;

export type PinReleaseRole = (typeof PIN_RELEASE_ROLES)[number];

export const PIN_RELEASE_PACKAGE_BY_ROLE: Readonly<Record<PinReleaseRole, string>> =
  Object.freeze({
    installer: "com.penumbraos.systeminjector",
    bootstrap: "com.penumbraos.systeminjector.exploit",
    hook: "com.penumbraos.hook",
    server: "com.penumbraos.server",
    "hook-injector": "com.penumbraos.hook.injector",
  });

export interface PinReleaseArtifactIdentity {
  readonly role: PinReleaseRole;
  readonly name: string;
  readonly package: string;
  readonly versionCode: number;
  readonly size: number;
  readonly sha256: string;
}

export interface PinReleaseArtifact extends PinReleaseArtifactIdentity {
  readonly url: string;
}

export interface PinReleaseManifest {
  readonly schemaVersion: 1;
  readonly releaseId: string;
  readonly version: string;
  readonly artifacts: readonly PinReleaseArtifact[];
}

export interface PinReleaseIdentityInput {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly artifacts: readonly PinReleaseArtifactIdentity[];
}

export interface PinReleaseEnvironment {
  readonly REVIVAL_PIN_RELEASE_DIR?: string;
  readonly REVIVAL_PIN_SETUP_ORIGIN?: string;
}

interface ReleaseStore {
  readonly root: string;
  readonly realRoot: string;
}

interface LoadedManifest {
  readonly manifest: PinReleaseManifest;
  readonly canonical: string;
}

interface VerifiedArtifact {
  readonly artifact: PinReleaseArtifact;
  readonly handle: FileHandle;
  /** The (dev, ino, size, mtime, ctime) tuple this verification covered. */
  readonly identity: string;
}

interface ArtifactSnapshotBacking {
  readonly approvalKey: string;
  readonly handle: FileHandle;
  readonly size: number;
  readonly reservationBytes: number;
  references: number;
  closing: boolean;
  closed: boolean;
  closePromise: Promise<void> | null;
}

interface ArtifactSnapshotLease {
  readonly backing: ArtifactSnapshotBacking;
  released: boolean;
}

interface ArtifactByteRange {
  readonly start: number;
  readonly end: number;
  readonly partial: boolean;
}

type MissingPathPolicy = "not-found" | "unavailable";

/**
 * Why this request failed, for the operator only.
 *
 * Every refusal in this file used to be the same sentence with no log line
 * behind it, so an operator who had just published a release could not tell a
 * symlinked store from a byte-for-byte manifest mismatch from a truncated APK —
 * roughly fifty-seven distinct causes arriving as "Pin release unavailable." and
 * empty container logs. The reason is REQUIRED at construction (a union, so a
 * typo will not compile), is logged exactly once in `errorResponse`, and is
 * deliberately NOT in the response body: this route is unauthenticated, and the
 * public answer stays one opaque sentence.
 */
type PinReleaseFailureReason =
  | "release_dir_unset"
  | "release_dir_not_absolute"
  | "release_root_missing"
  | "release_root_stat_failed"
  | "release_root_not_directory"
  | "release_root_realpath_failed"
  | "path_segment_unsafe"
  | "path_escapes_root"
  | "path_missing"
  | "path_stat_failed"
  | "path_is_symlink"
  | "path_not_directory"
  | "path_not_file"
  | "path_realpath_failed"
  | "path_realpath_escapes_root"
  | "file_missing"
  | "file_open_failed"
  | "file_stat_invalid"
  | "manifest_size_out_of_range"
  | "manifest_short_read"
  | "manifest_size_drift"
  | "manifest_not_utf8"
  | "manifest_not_json"
  | "manifest_not_object"
  | "manifest_root_fields"
  | "manifest_schema_version"
  | "manifest_release_id_shape"
  | "manifest_release_id_mismatch"
  | "manifest_release_id_unexpected"
  | "manifest_version_shape"
  | "manifest_artifacts_not_array"
  | "manifest_not_canonical"
  | "manifest_pair_mismatch"
  | "manifest_serialize_missing_role"
  | "artifact_not_object"
  | "artifact_fields"
  | "artifact_role_unknown"
  | "artifact_role_duplicate"
  | "artifact_role_missing"
  | "artifact_count"
  | "artifact_name_shape"
  | "artifact_package_mismatch"
  | "artifact_sha256_shape"
  | "artifact_sha256_mismatch"
  | "artifact_size_shape"
  | "artifact_size_mismatch"
  | "artifact_version_code_shape"
  | "artifact_version_code_mismatch"
  | "artifact_url_not_canonical"
  | "artifact_short_read"
  | "artifact_size_drift"
  | "artifact_changed_during_read"
  | "release_changed_during_verification"
  | "artifact_range_invalid"
  | "snapshot_capacity_exhausted"
  | "snapshot_create_failed"
  | "snapshot_copy_failed"
  | "snapshot_source_changed"
  | "snapshot_size_mismatch"
  | "snapshot_sha256_mismatch"
  | "artifact_absent_from_manifest"
  | "artifact_route_unknown"
  | "artifact_stream_failed"
  | "setup_origin_shape"
  | "setup_origin_not_url"
  | "setup_origin_not_allowed"
  | "request_url_invalid"
  | "origin_not_serializable"
  | "origin_not_allowed"
  | "preflight_method_not_allowed"
  | "preflight_header_not_allowed"
  | "unexpected_error";

class PinReleaseServingError extends Error {
  readonly status: 403 | 404 | 503;
  readonly reason: PinReleaseFailureReason;

  constructor(status: 403 | 404 | 503, message: string, reason: PinReleaseFailureReason) {
    super(message);
    this.name = "PinReleaseServingError";
    this.status = status;
    this.reason = reason;
  }
}

const RELEASE_ID_RE = /^[0-9a-f]{64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const APK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.apk$/;
const INSTALL_VERSION_RE = /^(\d{4})-(\d{2})-(\d{2})\.(\d+)$/;
const ROOT_FIELDS = ["schemaVersion", "releaseId", "version", "artifacts"];
const ARTIFACT_FIELDS = [
  "role",
  "url",
  "name",
  "package",
  "versionCode",
  "size",
  "sha256",
];
const HASH_CHUNK_BYTES = 1024 * 1024;
const SNAPSHOT_CHUNK_BYTES = 1024 * 1024;
const SNAPSHOT_DIRECTORY_PREFIX = "/tmp/revival-pin-release-snapshot-";
const MAX_ACTIVE_SNAPSHOT_FILES = 2;
const MAX_ACTIVE_SNAPSHOT_BYTES = MAX_PIN_RELEASE_ARTIFACT_BYTES;
const MIN_SNAPSHOT_RESERVATION_BYTES = MAX_ACTIVE_SNAPSHOT_BYTES / MAX_ACTIVE_SNAPSHOT_FILES;
export const PIN_RELEASE_SNAPSHOT_MAX_LEASES = 8;
// A continuously progressing 211 MiB download may take hours on a very slow
// connection, while an abandoned body must not pin one of the two anonymous
// descriptors forever. Progress renews the five-minute idle deadline, but no
// unauthenticated response may retain a snapshot beyond four hours in total.
export const PIN_RELEASE_SNAPSHOT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
export const PIN_RELEASE_SNAPSHOT_MAX_LIFETIME_MS = 4 * 60 * 60 * 1000;

function runtimeEnvironment(): PinReleaseEnvironment {
  return {
    REVIVAL_PIN_RELEASE_DIR: process.env.REVIVAL_PIN_RELEASE_DIR,
    REVIVAL_PIN_SETUP_ORIGIN: process.env.REVIVAL_PIN_SETUP_ORIGIN,
  };
}

function notFound(reason: PinReleaseFailureReason): PinReleaseServingError {
  return new PinReleaseServingError(404, "Pin release not found.", reason);
}

function unavailable(reason: PinReleaseFailureReason): PinReleaseServingError {
  return new PinReleaseServingError(503, "Pin release unavailable.", reason);
}

function forbiddenOrigin(reason: PinReleaseFailureReason): PinReleaseServingError {
  return new PinReleaseServingError(403, "Origin is not allowed.", reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function exactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
  reason: PinReleaseFailureReason,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((field, index) => field !== wanted[index])
  ) {
    throw unavailable(reason);
  }
}

function requiredString(
  value: unknown,
  maximum: number,
  reason: PinReleaseFailureReason,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim()
  ) {
    throw unavailable(reason);
  }
  return value;
}

function positiveInteger(
  value: unknown,
  maximum: number,
  reason: PinReleaseFailureReason,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw unavailable(reason);
  }
  return value;
}

function validInstallVersion(value: string): boolean {
  const match = INSTALL_VERSION_RE.exec(value);
  if (!match) return false;

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const increment = Number.parseInt(match[4], 10);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    Number.isSafeInteger(increment) &&
    increment >= 0 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function canonicalArtifactUrl(releaseId: string, role: PinReleaseRole): string {
  return `./${releaseId}/${role}.apk`;
}

function orderedIdentityArtifacts(
  artifacts: readonly PinReleaseArtifactIdentity[],
): readonly PinReleaseArtifactIdentity[] {
  if (artifacts.length !== PIN_RELEASE_ROLES.length) throw unavailable("artifact_count");
  const byRole = new Map<PinReleaseRole, PinReleaseArtifactIdentity>();
  for (const artifact of artifacts) {
    if (byRole.has(artifact.role)) throw unavailable("artifact_role_duplicate");
    byRole.set(artifact.role, artifact);
  }
  return PIN_RELEASE_ROLES.map((role) => {
    const artifact = byRole.get(role);
    if (!artifact) throw unavailable("artifact_role_missing");
    return artifact;
  });
}

/**
 * Implemented identity contract shared with the host-side publisher. URLs and
 * releaseId are excluded so the digest has no circular input; all APK hashes,
 * sizes, names, packages, and the atomic versionCode remain bound.
 */
export function canonicalPinReleaseIdentity(input: PinReleaseIdentityInput): string {
  return JSON.stringify({
    schemaVersion: input.schemaVersion,
    version: input.version,
    artifacts: orderedIdentityArtifacts(input.artifacts).map((artifact) => ({
      role: artifact.role,
      name: artifact.name,
      package: artifact.package,
      versionCode: artifact.versionCode,
      size: artifact.size,
      sha256: artifact.sha256,
    })),
  });
}

export function computePinReleaseId(input: PinReleaseIdentityInput): string {
  return createHash("sha256").update(canonicalPinReleaseIdentity(input)).digest("hex");
}

export function serializePinReleaseManifest(manifest: PinReleaseManifest): string {
  return `${JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    releaseId: manifest.releaseId,
    version: manifest.version,
    artifacts: PIN_RELEASE_ROLES.map((role) => {
      const artifact = manifest.artifacts.find((candidate) => candidate.role === role);
      if (!artifact) throw unavailable("manifest_serialize_missing_role");
      return {
        role: artifact.role,
        url: artifact.url,
        name: artifact.name,
        package: artifact.package,
        versionCode: artifact.versionCode,
        size: artifact.size,
        sha256: artifact.sha256,
      };
    }),
  })}\n`;
}

/** Independently authored parser for Setup's observed schema-v1 wire contract. */
export function parsePinReleaseManifest(payload: unknown): PinReleaseManifest {
  if (!isRecord(payload)) throw unavailable("manifest_not_object");
  exactFields(payload, ROOT_FIELDS, "manifest_root_fields");
  if (payload.schemaVersion !== PIN_RELEASE_SCHEMA_VERSION) {
    throw unavailable("manifest_schema_version");
  }

  const releaseId = requiredString(payload.releaseId, 64, "manifest_release_id_shape");
  if (!RELEASE_ID_RE.test(releaseId)) throw unavailable("manifest_release_id_shape");
  const version = requiredString(payload.version, 32, "manifest_version_shape");
  if (!validInstallVersion(version)) throw unavailable("manifest_version_shape");
  if (!Array.isArray(payload.artifacts)) throw unavailable("manifest_artifacts_not_array");

  const parsed: PinReleaseArtifact[] = payload.artifacts.map((candidate) => {
    if (!isRecord(candidate)) throw unavailable("artifact_not_object");
    exactFields(candidate, ARTIFACT_FIELDS, "artifact_fields");

    const roleValue = requiredString(candidate.role, 32, "artifact_role_unknown");
    if (!(PIN_RELEASE_ROLES as readonly string[]).includes(roleValue)) {
      throw unavailable("artifact_role_unknown");
    }
    const role = roleValue as PinReleaseRole;
    const name = requiredString(candidate.name, 259, "artifact_name_shape");
    if (!APK_NAME_RE.test(name)) throw unavailable("artifact_name_shape");
    const packageName = requiredString(candidate.package, 128, "artifact_package_mismatch");
    if (packageName !== PIN_RELEASE_PACKAGE_BY_ROLE[role]) {
      throw unavailable("artifact_package_mismatch");
    }
    const sha256 = requiredString(candidate.sha256, 64, "artifact_sha256_shape");
    if (!SHA256_RE.test(sha256)) throw unavailable("artifact_sha256_shape");
    const url = requiredString(candidate.url, 160, "artifact_url_not_canonical");
    if (url !== canonicalArtifactUrl(releaseId, role)) {
      throw unavailable("artifact_url_not_canonical");
    }

    return Object.freeze({
      role,
      url,
      name,
      package: packageName,
      versionCode: positiveInteger(
        candidate.versionCode,
        2_147_483_647,
        "artifact_version_code_shape",
      ),
      size: positiveInteger(
        candidate.size,
        MAX_PIN_RELEASE_ARTIFACT_BYTES,
        "artifact_size_shape",
      ),
      sha256,
    });
  });

  const artifacts = orderedIdentityArtifacts(parsed) as readonly PinReleaseArtifact[];
  const versionCodes = new Set(artifacts.map((artifact) => artifact.versionCode));
  if (versionCodes.size !== 1) throw unavailable("artifact_version_code_mismatch");
  const computedReleaseId = computePinReleaseId({
    schemaVersion: 1,
    version,
    artifacts,
  });
  if (computedReleaseId !== releaseId) throw unavailable("manifest_release_id_mismatch");

  return Object.freeze({
    schemaVersion: 1,
    releaseId,
    version,
    artifacts: Object.freeze([...artifacts]),
  });
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function getReleaseStore(environment: PinReleaseEnvironment): Promise<ReleaseStore> {
  const configured = environment.REVIVAL_PIN_RELEASE_DIR;
  if (configured === undefined || configured.trim() === "") throw notFound("release_dir_unset");
  if (
    configured !== configured.trim() ||
    configured.includes("\0") ||
    !path.isAbsolute(configured)
  ) {
    throw unavailable("release_dir_not_absolute");
  }

  const root = path.resolve(configured);
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) throw notFound("release_root_missing");
    throw unavailable("release_root_stat_failed");
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw unavailable("release_root_not_directory");
  }

  try {
    return Object.freeze({ root, realRoot: await realpath(root) });
  } catch {
    throw unavailable("release_root_realpath_failed");
  }
}

function safeChildPath(store: ReleaseStore, segments: readonly string[]): string {
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\0") ||
        segment.includes("/") ||
        segment.includes("\\"),
    )
  ) {
    throw unavailable("path_segment_unsafe");
  }
  const candidate = path.join(store.root, ...segments);
  if (!pathIsWithin(store.root, candidate)) throw unavailable("path_escapes_root");
  return candidate;
}

async function inspectStorePath(
  store: ReleaseStore,
  segments: readonly string[],
  expected: "file" | "directory",
  missingPolicy: MissingPathPolicy,
): Promise<string> {
  const candidate = safeChildPath(store, segments);
  let cursor = store.root;

  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    let stat;
    try {
      stat = await lstat(cursor);
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) {
        throw missingPolicy === "not-found" ? notFound("path_missing") : unavailable("path_missing");
      }
      throw unavailable("path_stat_failed");
    }

    if (stat.isSymbolicLink()) throw unavailable("path_is_symlink");
    const isLast = index === segments.length - 1;
    if (!isLast && !stat.isDirectory()) throw unavailable("path_not_directory");
    if (isLast && expected === "file" && !stat.isFile()) throw unavailable("path_not_file");
    if (isLast && expected === "directory" && !stat.isDirectory()) {
      throw unavailable("path_not_directory");
    }
  }

  try {
    const canonical = await realpath(candidate);
    if (!pathIsWithin(store.realRoot, canonical)) {
      throw unavailable("path_realpath_escapes_root");
    }
  } catch (error) {
    if (error instanceof PinReleaseServingError) throw error;
    throw unavailable("path_realpath_failed");
  }
  return candidate;
}

async function openRegularFile(
  store: ReleaseStore,
  segments: readonly string[],
  missingPolicy: MissingPathPolicy,
): Promise<{ readonly handle: FileHandle; readonly stat: Stats }> {
  const filename = await inspectStorePath(store, segments, "file", missingPolicy);
  let handle: FileHandle | undefined;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(filename, fsConstants.O_RDONLY | noFollow);
    const stat: Stats = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
      throw unavailable("file_stat_invalid");
    }
    return { handle, stat };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof PinReleaseServingError) throw error;
    if (hasNodeErrorCode(error, "ENOENT")) {
      throw missingPolicy === "not-found" ? notFound("file_missing") : unavailable("file_missing");
    }
    throw unavailable("file_open_failed");
  }
}

async function readBoundedManifest(
  store: ReleaseStore,
  segments: readonly string[],
  missingPolicy: MissingPathPolicy,
): Promise<string> {
  const { handle, stat } = await openRegularFile(store, segments, missingPolicy);
  try {
    if (stat.size <= 0 || stat.size > MAX_PIN_RELEASE_MANIFEST_BYTES) {
      throw unavailable("manifest_size_out_of_range");
    }
    const content = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(
        content,
        offset,
        content.length - offset,
        offset,
      );
      if (bytesRead === 0) throw unavailable("manifest_short_read");
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, content.length)).bytesRead !== 0) {
      throw unavailable("manifest_size_drift");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw unavailable("manifest_not_utf8");
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function loadManifest(
  store: ReleaseStore,
  segments: readonly string[],
  missingPolicy: MissingPathPolicy,
  expectedReleaseId?: string,
): Promise<LoadedManifest> {
  const document = await readBoundedManifest(store, segments, missingPolicy);
  let payload: unknown;
  try {
    payload = JSON.parse(document) as unknown;
  } catch {
    throw unavailable("manifest_not_json");
  }
  const manifest = parsePinReleaseManifest(payload);
  if (expectedReleaseId !== undefined && manifest.releaseId !== expectedReleaseId) {
    throw unavailable("manifest_release_id_unexpected");
  }
  const canonical = serializePinReleaseManifest(manifest);
  // Canonical bytes (including one trailing LF) reject duplicate JSON fields,
  // ambiguous ordering, whitespace, and equivocation between representations.
  if (document !== canonical) throw unavailable("manifest_not_canonical");
  return Object.freeze({ manifest, canonical });
}

async function hashOpenFile(handle: FileHandle, expectedSize: number): Promise<string> {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, expectedSize));
  let position = 0;
  while (position < expectedSize) {
    const length = Math.min(chunk.length, expectedSize - position);
    const { bytesRead } = await handle.read(chunk, 0, length, position);
    if (bytesRead === 0) throw unavailable("artifact_short_read");
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  const extra = Buffer.allocUnsafe(1);
  if ((await handle.read(extra, 0, 1, expectedSize)).bytesRead !== 0) {
    throw unavailable("artifact_size_drift");
  }
  return hash.digest("hex");
}

/* ------------------------------------------------- verification cache ----- */

/**
 * What "these exact bytes" means without reading them.
 *
 * The store is an operator-mounted directory, so a published release is
 * immutable in practice and a republish is an atomic rename: a new inode, a new
 * mtime, or a new size. Binding the cache to (dev, ino, size, mtimeMs, ctimeMs)
 * means any of those invalidates it, including a same-size in-place overwrite —
 * ctime moves even when mtime is forged backwards.
 */
function fileIdentity(stat: Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

async function pathIdentity(
  store: ReleaseStore,
  segments: readonly string[],
  missingPolicy: MissingPathPolicy,
): Promise<string> {
  // Deliberately re-runs the full path inspection (no symlink anywhere on the
  // way, canonical path still inside the real root) on every request. That part
  // is five lstats; it is the SHA-256 sweep over ~200 MB of APKs that had to
  // stop being per-request, not the safety checks.
  const filename = await inspectStorePath(store, segments, "file", missingPolicy);
  try {
    return fileIdentity(await lstat(filename));
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      throw missingPolicy === "not-found" ? notFound("path_missing") : unavailable("path_missing");
    }
    throw unavailable("path_stat_failed");
  }
}

/**
 * The last release this process verified end to end, and the exact file
 * identities that verification covered.
 *
 * Why this exists: `/api/pin/releases/current` is public (middleware lets
 * `isPublicPinReleaseRequest` through with no session), `force-dynamic`, and
 * used to stream-SHA256 every artifact in the store on every GET. With a 202 MB
 * server.apk published, an anonymous client could force hundreds of megabytes of
 * disk read and hashing per request on the same box that serves the dashboard.
 *
 * Integrity is NOT traded away for that: the hash sweep still runs on the first
 * load and on any stat drift, and a cached verdict is only reused for the exact
 * (dev, ino, size, mtimeMs, ctimeMs) tuple it was computed from. A tampered or
 * republished artifact fails the identity check and is re-hashed before a byte
 * of it is served.
 */
interface VerifiedRelease {
  readonly realRoot: string;
  readonly loaded: LoadedManifest;
  /** Identity of `current.json`, or null when only the immutable pair was read. */
  readonly currentIdentity: string | null;
  readonly manifestIdentity: string;
  /** Artifact file name -> identity that the SHA-256 verification covered. */
  readonly artifactIdentities: ReadonlyMap<string, string>;
}

let verifiedRelease: VerifiedRelease | null = null;

interface ReleaseVerificationFlight {
  readonly key: string;
  readonly promise: Promise<VerifiedRelease>;
}

// One bounded, process-local flight prevents concurrent cold artifact requests
// from each performing the same five-APK sweep. A different release waits for
// the active flight instead of growing an attacker-controlled map of release
// IDs. Only a complete VerifiedRelease is ever published through this slot.
let releaseVerificationFlight: ReleaseVerificationFlight | null = null;

interface ArtifactSnapshotFlight {
  readonly key: string;
  readonly promise: Promise<ArtifactSnapshotBacking>;
}

// Snapshot construction is intentionally a single bounded lane. Requests for
// the same immutable artifact share its copy; a different artifact is refused
// while that copy is in flight instead of forming an unauthenticated disk-I/O
// queue.
let artifactSnapshotFlight: ArtifactSnapshotFlight | null = null;

// This map is only a discoverability index for descriptor backings already held
// by response leases. It owns no reference of its own, is bounded by the two-fd
// reservation gate, and loses an entry synchronously before the last lease
// starts closing its descriptor.
const completedArtifactSnapshots = new Map<string, ArtifactSnapshotBacking>();

let activeSnapshotFiles = 0;
let activeSnapshotLeases = 0;
let activeSnapshotBytes = 0;
let buildingSnapshots = 0;
let createdSnapshots = 0;
let rejectedSnapshots = 0;
let expiredSnapshotLeases = 0;
let snapshotCopiedBytes = 0;

let releaseVerifications = 0;
let releaseHashedBytes = 0;

/**
 * How much work the store has actually cost this process.
 *
 * `hashedBytes` is the number that mattered: it used to grow by the whole store
 * (~200 MB with the current server.apk) on every unauthenticated GET of
 * /api/pin/releases/current, and now grows only when a release is verified for
 * the first time or after its files change. Exported so the property can be
 * asserted rather than assumed, and so an operator can see re-verification churn.
 */
export function pinReleaseVerificationStats(): {
  readonly verifications: number;
  readonly hashedBytes: number;
} {
  return { verifications: releaseVerifications, hashedBytes: releaseHashedBytes };
}

/** Bounded snapshot state, exported for operability and lifecycle regression. */
export function pinReleaseSnapshotStats(): {
  readonly activeFiles: number;
  readonly activeLeases: number;
  readonly reservedBytes: number;
  readonly building: number;
  readonly created: number;
  readonly rejected: number;
  readonly expiredLeases: number;
  readonly copiedBytes: number;
} {
  return {
    activeFiles: activeSnapshotFiles,
    activeLeases: activeSnapshotLeases,
    reservedBytes: activeSnapshotBytes,
    building: buildingSnapshots,
    created: createdSnapshots,
    rejected: rejectedSnapshots,
    expiredLeases: expiredSnapshotLeases,
    copiedBytes: snapshotCopiedBytes,
  };
}

function cachedReleaseFor(store: ReleaseStore, releaseId: string): VerifiedRelease | null {
  const cached = verifiedRelease;
  if (!cached) return null;
  if (cached.realRoot !== store.realRoot) return null;
  if (cached.loaded.manifest.releaseId !== releaseId) return null;
  return cached;
}

/**
 * Every file the cached verdict covers still has the identity it was verified
 * at. Callers treat a THROW from here as "not unchanged": the cold path that
 * follows re-runs the same inspection and reports the same reason properly, so
 * nothing is hidden by probing first.
 */
async function releaseUnchanged(
  store: ReleaseStore,
  cached: VerifiedRelease,
  includeCurrent: boolean,
): Promise<boolean> {
  const releaseId = cached.loaded.manifest.releaseId;
  if (includeCurrent) {
    if (cached.currentIdentity === null) return false;
    const current = await pathIdentity(store, [PIN_RELEASE_CURRENT_MANIFEST], "not-found");
    if (current !== cached.currentIdentity) return false;
  }
  const immutable = await pathIdentity(
    store,
    ["releases", releaseId, PIN_RELEASE_IMMUTABLE_MANIFEST],
    includeCurrent ? "unavailable" : "not-found",
  );
  if (immutable !== cached.manifestIdentity) return false;

  for (const artifact of cached.loaded.manifest.artifacts) {
    const identity = await pathIdentity(
      store,
      ["releases", releaseId, artifact.name],
      "unavailable",
    );
    if (identity !== cached.artifactIdentities.get(artifact.name)) return false;
  }
  return true;
}

/**
 * Open one artifact and prove it is the manifest's artifact.
 *
 * The hash sweep is skipped only when the OPEN HANDLE's own identity equals the
 * one a previous full verification covered — not the path's, so a file swapped
 * between the stat that primed the cache and this open cannot slip through. Any
 * other outcome re-hashes before a byte is served.
 */
async function openVerifiedArtifact(
  store: ReleaseStore,
  manifest: PinReleaseManifest,
  artifact: PinReleaseArtifact,
): Promise<VerifiedArtifact> {
  const opened = await openRegularFile(
    store,
    ["releases", manifest.releaseId, artifact.name],
    "unavailable",
  );
  try {
    if (opened.stat.size !== artifact.size) throw unavailable("artifact_size_mismatch");

    const identity = fileIdentity(opened.stat);
    const cached = cachedReleaseFor(store, manifest.releaseId);
    if (cached?.artifactIdentities.get(artifact.name) === identity) {
      return Object.freeze({ artifact, handle: opened.handle, identity });
    }

    releaseHashedBytes += artifact.size;
    const digest = await hashOpenFile(opened.handle, artifact.size);
    if (digest !== artifact.sha256) throw unavailable("artifact_sha256_mismatch");
    const after = await opened.handle.stat();
    if (
      after.size !== opened.stat.size ||
      after.dev !== opened.stat.dev ||
      after.ino !== opened.stat.ino ||
      after.mtimeMs !== opened.stat.mtimeMs ||
      after.ctimeMs !== opened.stat.ctimeMs
    ) {
      throw unavailable("artifact_changed_during_read");
    }
    return Object.freeze({ artifact, handle: opened.handle, identity });
  } catch (error) {
    await opened.handle.close().catch(() => undefined);
    throw error instanceof PinReleaseServingError ? error : unavailable("unexpected_error");
  }
}

function reserveArtifactSnapshot(size: number): number {
  const reservationBytes = Math.max(size, MIN_SNAPSHOT_RESERVATION_BYTES);
  if (
    activeSnapshotLeases >= PIN_RELEASE_SNAPSHOT_MAX_LEASES ||
    activeSnapshotFiles >= MAX_ACTIVE_SNAPSHOT_FILES ||
    reservationBytes > MAX_ACTIVE_SNAPSHOT_BYTES - activeSnapshotBytes
  ) {
    rejectedSnapshots += 1;
    throw unavailable("snapshot_capacity_exhausted");
  }
  activeSnapshotFiles += 1;
  activeSnapshotBytes += reservationBytes;
  buildingSnapshots += 1;
  return reservationBytes;
}

function releaseArtifactSnapshotReservation(reservationBytes: number): void {
  activeSnapshotFiles -= 1;
  activeSnapshotBytes -= reservationBytes;
  if (activeSnapshotFiles < 0 || activeSnapshotBytes < 0) {
    // An accounting underflow would make the public quota porous. Pin it shut
    // and leave an operator-visible diagnostic instead of silently widening it.
    activeSnapshotFiles = MAX_ACTIVE_SNAPSHOT_FILES;
    activeSnapshotBytes = MAX_ACTIVE_SNAPSHOT_BYTES;
    logWarn("pin release snapshot accounting failed closed");
  }
}

async function createAnonymousSnapshotHandle(): Promise<FileHandle> {
  let directory: string | undefined;
  let filename: string | undefined;
  let handle: FileHandle | undefined;
  try {
    if (typeof process.geteuid !== "function") throw unavailable("snapshot_create_failed");
    const ownerUid = process.geteuid();
    directory = await mkdtemp(SNAPSHOT_DIRECTORY_PREFIX);
    const directoryStat = await lstat(directory);
    if (
      !directoryStat.isDirectory() || directoryStat.uid !== ownerUid ||
      (directoryStat.mode & 0o777) !== 0o700
    ) {
      throw unavailable("snapshot_create_failed");
    }

    filename = path.join(directory, "artifact.snapshot");
    if (typeof fsConstants.O_NOFOLLOW !== "number") throw unavailable("snapshot_create_failed");
    handle = await open(
      filename,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const linked = await handle.stat();
    if (
      !linked.isFile() || linked.uid !== ownerUid || linked.nlink !== 1 || linked.size !== 0 ||
      (linked.mode & 0o777) !== 0o600
    ) throw unavailable("snapshot_create_failed");

    // Remove both names before a source byte is copied. From here onward the
    // snapshot is reachable only through this held descriptor: no path exists
    // for another request or process to replace, reopen, or retain.
    await unlink(filename);
    filename = undefined;
    await rmdir(directory);
    directory = undefined;
    if ((await handle.stat()).nlink !== 0) throw unavailable("snapshot_create_failed");

    const result = handle;
    handle = undefined;
    return result;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (filename !== undefined) await unlink(filename).catch(() => undefined);
    if (directory !== undefined) await rmdir(directory).catch(() => undefined);
    throw error instanceof PinReleaseServingError ? error : unavailable("snapshot_create_failed");
  }
}

async function writeSnapshotChunk(
  handle: FileHandle,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < length) {
    const result = await handle.write(buffer, written, length - written, position + written);
    if (result.bytesWritten <= 0) throw unavailable("snapshot_copy_failed");
    written += result.bytesWritten;
  }
}

async function closeSnapshotBacking(backing: ArtifactSnapshotBacking): Promise<void> {
  if (backing.closePromise !== null) return backing.closePromise;
  if (completedArtifactSnapshots.get(backing.approvalKey) === backing) {
    completedArtifactSnapshots.delete(backing.approvalKey);
  }
  backing.closing = true;
  backing.closePromise = backing.handle.close().then(() => {
    backing.closed = true;
    releaseArtifactSnapshotReservation(backing.reservationBytes);
  }).catch((error: unknown) => {
    // Keep the reservation charged when close fails: claiming the descriptor
    // was gone would permit unbounded anonymous files after an I/O failure.
    logWarn("pin release snapshot close failed", error);
    throw error;
  });
  return backing.closePromise;
}

function retainSnapshot(backing: ArtifactSnapshotBacking): ArtifactSnapshotLease {
  if (
    backing.closing || backing.closed ||
    activeSnapshotLeases >= PIN_RELEASE_SNAPSHOT_MAX_LEASES
  ) {
    rejectedSnapshots += 1;
    throw unavailable("snapshot_capacity_exhausted");
  }
  backing.references += 1;
  activeSnapshotLeases += 1;
  return { backing, released: false };
}

async function releaseSnapshot(lease: ArtifactSnapshotLease): Promise<void> {
  if (lease.released) return;
  lease.released = true;
  lease.backing.references -= 1;
  activeSnapshotLeases -= 1;
  if (lease.backing.references < 0 || activeSnapshotLeases < 0) {
    // Do not make a corrupt counter look like spare public capacity. Retain
    // the descriptor and pin the global lease gate shut for operator review.
    lease.backing.references = 1;
    activeSnapshotLeases = PIN_RELEASE_SNAPSHOT_MAX_LEASES;
    logWarn("pin release snapshot lease accounting failed closed");
    return;
  }
  if (lease.backing.references === 0) {
    // Delete before the first await. A request entering after this point may
    // construct a new generation, and the old close must never delete it.
    if (completedArtifactSnapshots.get(lease.backing.approvalKey) === lease.backing) {
      completedArtifactSnapshots.delete(lease.backing.approvalKey);
    }
    await closeSnapshotBacking(lease.backing);
  }
}

function artifactSnapshotApprovalKey(
  release: VerifiedRelease,
  artifact: PinReleaseArtifact,
): string {
  const manifest = release.loaded.manifest;
  const identities = manifest.artifacts.map((candidate) => [
    candidate.name,
    release.artifactIdentities.get(candidate.name),
  ] as const);
  if (identities.some(([, identity]) => identity === undefined)) {
    throw unavailable("release_changed_during_verification");
  }
  return JSON.stringify([
    release.realRoot,
    release.manifestIdentity,
    manifest.releaseId,
    artifact.role,
    artifact.name,
    artifact.size,
    artifact.sha256,
    identities,
  ]);
}

async function buildArtifactSnapshot(
  store: ReleaseStore,
  manifest: PinReleaseManifest,
  artifact: PinReleaseArtifact,
  approvalKey: string,
  reservationBytes: number,
): Promise<ArtifactSnapshotBacking> {
  let source: VerifiedArtifact | undefined;
  let snapshot: FileHandle | undefined;
  let reservationOwned = true;
  try {
    source = await openVerifiedArtifact(store, manifest, artifact);
    const sourceBefore = await source.handle.stat();
    if (
      sourceBefore.size !== artifact.size ||
      fileIdentity(sourceBefore) !== source.identity
    ) throw unavailable("snapshot_source_changed");

    snapshot = await createAnonymousSnapshotHandle();
    const digest = createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.min(SNAPSHOT_CHUNK_BYTES, artifact.size));
    let position = 0;
    while (position < artifact.size) {
      const length = Math.min(chunk.length, artifact.size - position);
      const { bytesRead } = await source.handle.read(chunk, 0, length, position);
      if (bytesRead !== length) throw unavailable("snapshot_size_mismatch");
      digest.update(chunk.subarray(0, bytesRead));
      await writeSnapshotChunk(snapshot, chunk, bytesRead, position);
      snapshotCopiedBytes += bytesRead;
      position += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await source.handle.read(extra, 0, 1, artifact.size)).bytesRead !== 0) {
      throw unavailable("snapshot_size_mismatch");
    }
    if (digest.digest("hex") !== artifact.sha256) {
      throw unavailable("snapshot_sha256_mismatch");
    }

    const sourceAfter = await source.handle.stat();
    if (fileIdentity(sourceAfter) !== fileIdentity(sourceBefore)) {
      throw unavailable("snapshot_source_changed");
    }
    const snapshotStat = await snapshot.stat();
    if (
      !snapshotStat.isFile() || snapshotStat.nlink !== 0 ||
      snapshotStat.size !== artifact.size || (snapshotStat.mode & 0o777) !== 0o600
    ) throw unavailable("snapshot_size_mismatch");

    await source.handle.close();
    source = undefined;
    const backing: ArtifactSnapshotBacking = {
      approvalKey,
      handle: snapshot,
      size: artifact.size,
      reservationBytes,
      references: 0,
      closing: false,
      closed: false,
      closePromise: null,
    };
    snapshot = undefined;
    reservationOwned = false;
    createdSnapshots += 1;
    return backing;
  } catch (error) {
    throw error instanceof PinReleaseServingError ? error : unavailable("snapshot_copy_failed");
  } finally {
    buildingSnapshots -= 1;
    await source?.handle.close().catch(() => undefined);
    await snapshot?.close().catch(() => undefined);
    if (reservationOwned) releaseArtifactSnapshotReservation(reservationBytes);
  }
}

async function acquireArtifactSnapshot(
  store: ReleaseStore,
  release: VerifiedRelease,
  artifact: PinReleaseArtifact,
): Promise<ArtifactSnapshotLease> {
  const manifest = release.loaded.manifest;
  const key = artifactSnapshotApprovalKey(release, artifact);
  const completed = completedArtifactSnapshots.get(key);
  if (completed !== undefined) {
    if (!completed.closing && !completed.closed && completed.references > 0) {
      return retainSnapshot(completed);
    }
    if (completedArtifactSnapshots.get(key) === completed) {
      completedArtifactSnapshots.delete(key);
    }
    if (completed.references === 0) await closeSnapshotBacking(completed).catch(() => undefined);
  }

  const active = artifactSnapshotFlight;
  if (active !== null) {
    if (active.key !== key) {
      rejectedSnapshots += 1;
      throw unavailable("snapshot_capacity_exhausted");
    }
    return retainSnapshot(await active.promise);
  }

  const reservationBytes = reserveArtifactSnapshot(artifact.size);
  const promise = (async () => {
    const backing = await buildArtifactSnapshot(store, manifest, artifact, key, reservationBytes);
    const prior = completedArtifactSnapshots.get(key);
    if (prior !== undefined && prior !== backing) {
      await closeSnapshotBacking(backing).catch(() => undefined);
      throw unavailable("snapshot_capacity_exhausted");
    }
    completedArtifactSnapshots.set(key, backing);
    return backing;
  })();
  artifactSnapshotFlight = Object.freeze({ key, promise });
  try {
    const backing = await promise;
    try {
      return retainSnapshot(backing);
    } catch (error) {
      // A lease can fill while this descriptor is being constructed. If no
      // waiter retained the completed backing, close it here rather than leave
      // an unreferenced discoverable anonymous file charged to the quota.
      if (backing.references === 0) await closeSnapshotBacking(backing).catch(() => undefined);
      throw error;
    }
  } finally {
    if (artifactSnapshotFlight?.promise === promise) artifactSnapshotFlight = null;
  }
}

function requestedArtifactRange(request: Request, size: number): ArtifactByteRange {
  const value = request.headers.get("range");
  if (value === null) return { start: 0, end: size - 1, partial: false };
  if (value.length > 128 || value.includes(",")) throw unavailable("artifact_range_invalid");
  const match = /^bytes=([0-9]*)-([0-9]*)$/u.exec(value);
  if (!match || (match[1] === "" && match[2] === "")) {
    throw unavailable("artifact_range_invalid");
  }

  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw unavailable("artifact_range_invalid");
    return { start: Math.max(0, size - suffix), end: size - 1, partial: true };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] === "" ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) ||
    start < 0 || requestedEnd < start || start >= size
  ) throw unavailable("artifact_range_invalid");
  return { start, end: Math.min(requestedEnd, size - 1), partial: true };
}

function snapshotResponseBody(
  lease: ArtifactSnapshotLease,
  range: ArtifactByteRange,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let position = range.start;
  let finished = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null;

  const armTimer = (callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(callback, milliseconds);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref(): void }).unref();
    }
    return timer;
  };

  const finish = (streamError?: Error): void => {
    if (finished) return;
    finished = true;
    if (idleTimer !== null) clearTimeout(idleTimer);
    if (lifetimeTimer !== null) clearTimeout(lifetimeTimer);
    signal.removeEventListener("abort", abort);
    if (streamError !== undefined) streamController?.error(streamError);
    void releaseSnapshot(lease).catch(() => undefined);
  };
  const abort = (): void => {
    finish(new Error("Pin release response aborted."));
  };
  const expire = (): void => {
    if (finished) return;
    expiredSnapshotLeases += 1;
    finish(new Error("Pin release snapshot lease expired."));
  };
  const renewIdleDeadline = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = armTimer(expire, PIN_RELEASE_SNAPSHOT_IDLE_TIMEOUT_MS);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      if (signal.aborted) abort();
      else {
        signal.addEventListener("abort", abort, { once: true });
        renewIdleDeadline();
        lifetimeTimer = armTimer(expire, PIN_RELEASE_SNAPSHOT_MAX_LIFETIME_MS);
      }
    },
    async pull(controller) {
      if (finished) return;
      const length = Math.min(SNAPSHOT_CHUNK_BYTES, range.end - position + 1);
      if (length <= 0) {
        controller.close();
        finish();
        return;
      }
      try {
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await lease.backing.handle.read(buffer, 0, length, position);
        if (bytesRead !== length) throw new Error("snapshot short read");
        if (finished) return;
        position += bytesRead;
        controller.enqueue(buffer);
        renewIdleDeadline();
        if (position > range.end) {
          controller.close();
          finish();
        }
      } catch {
        if (!finished) controller.error(new Error("Pin release artifact stream failed."));
        finish();
      }
    },
    cancel() {
      finish();
    },
  });
}

/** Verify every artifact and record the identities that verdict covers. */
async function verifyArtifacts(
  store: ReleaseStore,
  manifest: PinReleaseManifest,
): Promise<ReadonlyMap<string, string>> {
  const identities = new Map<string, string>();
  for (const artifact of manifest.artifacts) {
    const verified = await openVerifiedArtifact(store, manifest, artifact);
    identities.set(artifact.name, verified.identity);
    await verified.handle.close().catch(() => undefined);
  }
  return identities;
}

async function loadCurrentManifest(store: ReleaseStore): Promise<LoadedManifest> {
  const cached = verifiedRelease;
  if (
    cached &&
    cached.realRoot === store.realRoot &&
    (await releaseUnchanged(store, cached, true).catch(() => false))
  ) {
    return cached.loaded;
  }

  // Identities are read BEFORE the bytes they describe, so a file rewritten
  // mid-load caches the OLD identity against the NEW verdict and is re-verified
  // on the next request. Reading them afterwards would cache the new identity
  // against a verdict formed from the old bytes — a stale release served as
  // verified, which is the failure this cache exists to avoid creating.
  const currentIdentity = await pathIdentity(
    store,
    [PIN_RELEASE_CURRENT_MANIFEST],
    "not-found",
  );
  const current = await loadManifest(
    store,
    [PIN_RELEASE_CURRENT_MANIFEST],
    "not-found",
  );
  const manifestIdentity = await pathIdentity(
    store,
    ["releases", current.manifest.releaseId, PIN_RELEASE_IMMUTABLE_MANIFEST],
    "unavailable",
  );
  const immutable = await loadManifest(
    store,
    ["releases", current.manifest.releaseId, PIN_RELEASE_IMMUTABLE_MANIFEST],
    "unavailable",
    current.manifest.releaseId,
  );
  if (immutable.canonical !== current.canonical) throw unavailable("manifest_pair_mismatch");

  const artifactIdentities = await verifyArtifacts(store, current.manifest);
  releaseVerifications += 1;
  verifiedRelease = Object.freeze({
    realRoot: store.realRoot,
    loaded: current,
    currentIdentity,
    manifestIdentity,
    artifactIdentities,
  });
  // The one line an operator wants after publishing: the release Center now
  // serves, named, with the sweep that accepted it. Silence here used to be the
  // only feedback a good publish produced.
  logInfo(
    `pin release verified: ${current.manifest.releaseId} (${current.manifest.version}), ${artifactIdentities.size} artifacts`,
  );
  return current;
}

async function verifyImmutableRelease(
  store: ReleaseStore,
  releaseId: string,
): Promise<VerifiedRelease> {
  // Capture the immutable manifest identity before reading its bytes. The
  // post-verification identity sweep below therefore rejects a rewrite at any
  // point during the full manifest/evidence/artifact verification.
  const manifestIdentity = await pathIdentity(
    store,
    ["releases", releaseId, PIN_RELEASE_IMMUTABLE_MANIFEST],
    "not-found",
  );
  const loaded = await loadManifest(
    store,
    ["releases", releaseId, PIN_RELEASE_IMMUTABLE_MANIFEST],
    "not-found",
    releaseId,
  );
  const artifactIdentities = await verifyArtifacts(store, loaded.manifest);
  const candidate: VerifiedRelease = Object.freeze({
    realRoot: store.realRoot,
    loaded,
    currentIdentity: null,
    manifestIdentity,
    artifactIdentities,
  });

  // Do not publish a verdict assembled across two filesystem generations. This
  // second complete identity pass also covers evidence and all five APK names,
  // not just the artifact the caller asked to download.
  if (!(await releaseUnchanged(store, candidate, false).catch(() => false))) {
    throw unavailable("release_changed_during_verification");
  }

  releaseVerifications += 1;
  verifiedRelease = candidate;
  logInfo(
    `pin release verified: ${loaded.manifest.releaseId} (${loaded.manifest.version}), ${artifactIdentities.size} artifacts`,
  );
  return candidate;
}

/**
 * Resolve an immutable artifact URL to a complete end-to-end release verdict.
 *
 * A browser normally learns this URL from `/current`, but immutable URLs are
 * public and can be requested directly after a process restart. Consequently a
 * cold GET or HEAD verifies the complete five-APK release before returning.
 * Concurrent cold requests share that verification.
 */
async function loadImmutableRelease(
  store: ReleaseStore,
  releaseId: string,
): Promise<VerifiedRelease> {
  const cached = cachedReleaseFor(store, releaseId);
  if (cached && (await releaseUnchanged(store, cached, false).catch(() => false))) {
    return cached;
  }

  const key = `${store.realRoot}\0${releaseId}`;
  const active = releaseVerificationFlight;
  if (active) {
    if (active.key === key) return active.promise;
    await active.promise.catch(() => undefined);
    return loadImmutableRelease(store, releaseId);
  }

  const promise = verifyImmutableRelease(store, releaseId);
  releaseVerificationFlight = Object.freeze({ key, promise });
  try {
    return await promise;
  } finally {
    if (releaseVerificationFlight?.promise === promise) releaseVerificationFlight = null;
  }
}

/**
 * The single extra origin allowed to fetch release artifacts, or null for none.
 *
 * The variable is named for the standalone Setup SPA that used to be the client
 * here, on its own origin. That SPA is gone and the installer is part of Center
 * (`@/lib/pin-install`), so in every current deployment this is set to Center's
 * OWN origin — which the same-origin branch of `publicRequestOrigins` would
 * allow anyway. It is kept because it is the only seam for a client that is not
 * Center: a staging Center, or a recovery console served from somewhere else
 * while Center itself is the thing being recovered.
 *
 * DO NOT UNSET IT AS A HARDENING STEP. Narrower in CORS terms it may be, but
 * three deployment gates pin it to Center's exact origin — canary.sh and two
 * checks in staging-smoke.sh — so an empty value fails the deploy rather than
 * tightening anything. Removing it means changing those gates in the same
 * change, deliberately, not dropping the variable and finding out at cutover.
 *
 * Shape is validated rather than trusted: exactly one origin, no wildcard, no
 * credentials, https unless loopback. A malformed value fails the request
 * instead of widening the allowlist.
 */
function configuredSetupOrigin(environment: PinReleaseEnvironment): string | null {
  const configured = environment.REVIVAL_PIN_SETUP_ORIGIN;
  if (configured === undefined || configured.trim() === "") return null;
  if (configured !== configured.trim() || configured === "*" || configured.length > 2048) {
    throw unavailable("setup_origin_shape");
  }

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw unavailable("setup_origin_not_url");
  }
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (
    parsed.origin !== configured ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
  ) {
    throw unavailable("setup_origin_not_allowed");
  }
  return parsed.origin;
}

function publicRequestOrigins(request: Request): ReadonlySet<string> {
  const origins = new Set<string>();
  try {
    origins.add(new URL(request.url).origin);
  } catch {
    throw forbiddenOrigin("request_url_invalid");
  }

  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",", 1)[0].trim();
  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",", 1)[0]
    .trim()
    .toLowerCase();
  if (
    forwardedHost &&
    (forwardedProtocol === "http" || forwardedProtocol === "https") &&
    /^[A-Za-z0-9.:[\]-]+$/.test(forwardedHost)
  ) {
    try {
      origins.add(new URL(`${forwardedProtocol}://${forwardedHost}`).origin);
    } catch {
      // An invalid forwarded pair is ignored; it can never widen the allowlist.
    }
  }
  return origins;
}

function corsHeaders(request: Request, environment: PinReleaseEnvironment): Headers {
  const configured = configuredSetupOrigin(environment);
  const rawOrigin = request.headers.get("origin");
  const headers = new Headers();
  if (rawOrigin === null) return headers;

  let origin: string;
  try {
    const parsed = new URL(rawOrigin);
    if (parsed.origin !== rawOrigin) throw forbiddenOrigin("origin_not_serializable");
    origin = parsed.origin;
  } catch (error) {
    if (error instanceof PinReleaseServingError) throw error;
    throw forbiddenOrigin("origin_not_serializable");
  }

  if (origin !== configured && !publicRequestOrigins(request).has(origin)) {
    throw forbiddenOrigin("origin_not_allowed");
  }
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-expose-headers", "Content-Length, Content-Type");
  headers.set("vary", "Origin");
  return headers;
}

function hardenedHeaders(cors: Headers): Headers {
  const headers = new Headers(cors);
  headers.set("cache-control", "no-store, max-age=0");
  headers.set("pragma", "no-cache");
  headers.set("expires", "0");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

/**
 * One sentence on the wire, one reason in the log.
 *
 * The body stays exactly what it was — this route is unauthenticated and must
 * not narrate the store's internals to the internet — but the reason and, for an
 * unexpected throw, the error itself now reach the container log. Publishing a
 * release used to produce one opaque sentence and no log line at all.
 */
function errorResponse(
  error: unknown,
  head: boolean,
  cors = new Headers(),
  route = "pin release",
): Response {
  const failure =
    error instanceof PinReleaseServingError ? error : unavailable("unexpected_error");
  logWarn(`${route}: ${failure.status} ${failure.reason}`);
  if (!(error instanceof PinReleaseServingError)) {
    // An exception this module never classified. It is the one case where the
    // reason above says nothing useful, so the original goes to the log intact.
    logWarn(`${route}: unclassified failure`, error);
  }
  const body = JSON.stringify({ error: failure.message });
  const headers = hardenedHeaders(cors);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("content-length", String(Buffer.byteLength(body)));
  return new Response(head ? null : body, { status: failure.status, headers });
}

export interface PinReleaseResponseOptions {
  readonly environment?: PinReleaseEnvironment;
  readonly head?: boolean;
}

export async function serveCurrentPinRelease(
  request: Request,
  options: PinReleaseResponseOptions = {},
): Promise<Response> {
  const environment = options.environment ?? runtimeEnvironment();
  const head = options.head === true;
  let cors = new Headers();
  try {
    cors = corsHeaders(request, environment);
    const store = await getReleaseStore(environment);
    const loaded = await loadCurrentManifest(store);
    const headers = hardenedHeaders(cors);
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set("content-length", String(Buffer.byteLength(loaded.canonical)));
    return new Response(head ? null : loaded.canonical, { status: 200, headers });
  } catch (error) {
    return errorResponse(error, head, cors, "pin release current");
  }
}

function routeRole(assetName: string): PinReleaseRole | null {
  for (const role of PIN_RELEASE_ROLES) {
    if (assetName === `${role}.apk`) return role;
  }
  return null;
}

export async function servePinReleaseArtifact(
  request: Request,
  releaseId: string,
  assetName: string,
  options: PinReleaseResponseOptions = {},
): Promise<Response> {
  const environment = options.environment ?? runtimeEnvironment();
  const head = options.head === true;
  let cors = new Headers();
  try {
    cors = corsHeaders(request, environment);
    const role = routeRole(assetName);
    if (!RELEASE_ID_RE.test(releaseId) || role === null) throw notFound("artifact_route_unknown");

    const store = await getReleaseStore(environment);
    const release = await loadImmutableRelease(store, releaseId);
    const artifact = release.loaded.manifest.artifacts.find((candidate) => candidate.role === role);
    if (!artifact) throw unavailable("artifact_absent_from_manifest");
    const range = requestedArtifactRange(request, artifact.size);
    const snapshot = await acquireArtifactSnapshot(store, release, artifact);
    let snapshotOwned = true;

    try {
      // Snapshot construction re-hashes the held source descriptor into an
      // unlinked private descriptor and rechecks that source's identity. Check
      // the complete release once more after the copy so no sidecar, manifest,
      // or other-role replacement can authorize a response from stale state.
      if (!(await releaseUnchanged(store, release, false).catch(() => false))) {
        throw unavailable("release_changed_during_verification");
      }
      if (request.signal.aborted) throw unavailable("artifact_stream_failed");

      const headers = hardenedHeaders(cors);
      headers.set("content-type", "application/vnd.android.package-archive");
      headers.set("accept-ranges", "bytes");
      headers.set("content-length", String(range.end - range.start + 1));
      const status = range.partial ? 206 : 200;
      if (range.partial) {
        headers.set("content-range", `bytes ${range.start}-${range.end}/${artifact.size}`);
      }
      if (head) {
        await releaseSnapshot(snapshot);
        snapshotOwned = false;
        return new Response(null, { status, headers });
      }

      const body = snapshotResponseBody(snapshot, range, request.signal);
      const response = new Response(body, { status, headers });
      snapshotOwned = false;
      return response;
    } finally {
      if (snapshotOwned) await releaseSnapshot(snapshot).catch(() => undefined);
    }
  } catch (error) {
    return errorResponse(error, head, cors, `pin release artifact ${assetName}`);
  }
}

export function servePinReleaseOptions(
  request: Request,
  environment: PinReleaseEnvironment = runtimeEnvironment(),
): Response {
  let cors = new Headers();
  try {
    cors = corsHeaders(request, environment);
    const requestedMethod = request.headers.get("access-control-request-method");
    if (requestedMethod && requestedMethod !== "GET" && requestedMethod !== "HEAD") {
      throw forbiddenOrigin("preflight_method_not_allowed");
    }
    const requestedHeaders =
      request.headers
        .get("access-control-request-headers")
        ?.split(",")
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean) ?? [];
    if (requestedHeaders.some((header) => header !== "accept")) {
      throw forbiddenOrigin("preflight_header_not_allowed");
    }

    const headers = hardenedHeaders(cors);
    headers.set("allow", "GET, HEAD, OPTIONS");
    if (request.headers.has("origin")) {
      headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
      headers.set("access-control-allow-headers", "Accept");
      headers.set("access-control-max-age", "300");
    }
    return new Response(null, { status: 204, headers });
  } catch (error) {
    return errorResponse(error, false, cors, "pin release preflight");
  }
}
