import { createHash } from "node:crypto";
import fs from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { logWarn } from "./log";

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
  readonly LUMA_PIN_RELEASE_DIR?: string;
  readonly LUMA_PIN_SETUP_ORIGIN?: string;
  readonly LUMA_PIN_RELEASE_EXPECTED_ID?: string;
  readonly LUMA_PIN_RELEASE_EXPECTED_MANIFEST_SHA256?: string;
}

export interface PinReleaseResponseOptions {
  readonly environment?: PinReleaseEnvironment;
  readonly head?: boolean;
}

interface ReleaseStore {
  readonly root: string;
}

interface LoadedManifest {
  readonly manifest: PinReleaseManifest;
  readonly canonical: string;
}

interface VerifiedRelease extends LoadedManifest {
  readonly paths: ReadonlyMap<PinReleaseRole, string>;
}

interface ExpectedPinRelease {
  readonly releaseId: string;
  readonly manifestSha256: string;
}

class PinReleaseServingError extends Error {
  readonly status: 403 | 404 | 416 | 503;
  readonly reason: string;

  constructor(
    status: 403 | 404 | 416 | 503,
    message: string,
    reason: string,
  ) {
    super(message);
    this.name = "PinReleaseServingError";
    this.status = status;
    this.reason = reason;
  }
}

const RELEASE_ID_RE = /^[0-9a-f]{64}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const VERSION_RE = /^(\d{4})-(\d{2})-(\d{2})\.(\d+)$/u;
const ROOT_FIELDS = ["schemaVersion", "releaseId", "version", "artifacts"];
const ARTIFACT_FIELDS = ["role", "url", "name", "package", "versionCode", "size", "sha256"];
const VERIFIED_RELEASE_CACHE_LIMIT = 2;
const verificationInFlight = new Map<string, Promise<VerifiedRelease>>();
const verifiedReleaseCache = new Map<string, VerifiedRelease>();

function runtimeEnvironment(): PinReleaseEnvironment {
  return {
    LUMA_PIN_RELEASE_DIR: process.env.LUMA_PIN_RELEASE_DIR,
    LUMA_PIN_SETUP_ORIGIN: process.env.LUMA_PIN_SETUP_ORIGIN,
    LUMA_PIN_RELEASE_EXPECTED_ID: process.env.LUMA_PIN_RELEASE_EXPECTED_ID,
    LUMA_PIN_RELEASE_EXPECTED_MANIFEST_SHA256:
      process.env.LUMA_PIN_RELEASE_EXPECTED_MANIFEST_SHA256,
  };
}

function unavailable(reason: string): PinReleaseServingError {
  return new PinReleaseServingError(503, "Pin release unavailable.", reason);
}

function notFound(reason: string): PinReleaseServingError {
  return new PinReleaseServingError(404, "Pin release not found.", reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function exactFields(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    throw unavailable("unexpected_fields");
  }
}

function requiredString(value: unknown, maximum: number, reason: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw unavailable(reason);
  }
  return value;
}

function positiveInteger(value: unknown, maximum: number, reason: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw unavailable(reason);
  }
  return value as number;
}

function validInstallVersion(value: string): boolean {
  const match = VERSION_RE.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function canonicalArtifactUrl(releaseId: string, role: PinReleaseRole): string {
  return `./${releaseId}/${role}.apk`;
}

function orderedArtifacts<T extends PinReleaseArtifactIdentity>(artifacts: readonly T[]): readonly T[] {
  if (artifacts.length !== PIN_RELEASE_ROLES.length) throw unavailable("artifact_count");
  const byRole = new Map<PinReleaseRole, T>();
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

export function canonicalPinReleaseIdentity(input: PinReleaseIdentityInput): string {
  return JSON.stringify({
    schemaVersion: input.schemaVersion,
    version: input.version,
    artifacts: orderedArtifacts(input.artifacts).map((artifact) => ({
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

export function parsePinReleaseManifest(payload: unknown): PinReleaseManifest {
  if (!isRecord(payload)) throw unavailable("manifest_not_object");
  exactFields(payload, ROOT_FIELDS);
  if (payload.schemaVersion !== PIN_RELEASE_SCHEMA_VERSION) throw unavailable("manifest_schema_version");

  const releaseId = requiredString(payload.releaseId, 64, "manifest_release_id");
  if (!RELEASE_ID_RE.test(releaseId)) throw unavailable("manifest_release_id");
  const version = requiredString(payload.version, 32, "manifest_version");
  if (!validInstallVersion(version)) throw unavailable("manifest_version");
  if (!Array.isArray(payload.artifacts)) throw unavailable("manifest_artifacts");

  const parsed = payload.artifacts.map((value): PinReleaseArtifact => {
    if (!isRecord(value)) throw unavailable("artifact_not_object");
    exactFields(value, ARTIFACT_FIELDS);
    const roleValue = requiredString(value.role, 32, "artifact_role");
    if (!(PIN_RELEASE_ROLES as readonly string[]).includes(roleValue)) throw unavailable("artifact_role");
    const role = roleValue as PinReleaseRole;
    const name = requiredString(value.name, 259, "artifact_name");
    if (name !== `${role}.apk`) throw unavailable("artifact_name");
    const packageName = requiredString(value.package, 128, "artifact_package");
    if (packageName !== PIN_RELEASE_PACKAGE_BY_ROLE[role]) throw unavailable("artifact_package");
    const sha256 = requiredString(value.sha256, 64, "artifact_sha256");
    if (!SHA256_RE.test(sha256)) throw unavailable("artifact_sha256");
    const url = requiredString(value.url, 160, "artifact_url");
    if (url !== canonicalArtifactUrl(releaseId, role)) throw unavailable("artifact_url");
    return Object.freeze({
      role,
      url,
      name,
      package: packageName,
      versionCode: positiveInteger(value.versionCode, 2_147_483_647, "artifact_version_code"),
      size: positiveInteger(value.size, MAX_PIN_RELEASE_ARTIFACT_BYTES, "artifact_size"),
      sha256,
    });
  });

  const artifacts = orderedArtifacts(parsed) as readonly PinReleaseArtifact[];
  if (new Set(artifacts.map((artifact) => artifact.versionCode)).size !== 1) {
    throw unavailable("artifact_version_code_mismatch");
  }
  if (computePinReleaseId({ schemaVersion: 1, version, artifacts }) !== releaseId) {
    throw unavailable("manifest_release_id_mismatch");
  }
  return Object.freeze({ schemaVersion: 1, releaseId, version, artifacts: Object.freeze([...artifacts]) });
}

export function serializePinReleaseManifest(manifest: PinReleaseManifest): string {
  return `${JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    releaseId: manifest.releaseId,
    version: manifest.version,
    artifacts: PIN_RELEASE_ROLES.map((role) => {
      const artifact = manifest.artifacts.find((candidate) => candidate.role === role);
      if (!artifact) throw unavailable("manifest_missing_role");
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

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function getReleaseStore(environment: PinReleaseEnvironment): Promise<ReleaseStore> {
  const configured = environment.LUMA_PIN_RELEASE_DIR;
  if (!configured || configured.trim() !== configured || !path.isAbsolute(configured)) {
    throw notFound("release_dir_unset");
  }
  const selected = path.resolve(configured);
  let metadata;
  try {
    metadata = await lstat(selected);
  } catch (error) {
    if (hasCode(error, "ENOENT")) throw notFound("release_root_missing");
    throw unavailable("release_root_stat");
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw unavailable("release_root_type");
  return Object.freeze({ root: await realpath(selected) });
}

async function regularFile(
  store: ReleaseStore,
  segments: readonly string[],
  missing: "not-found" | "unavailable" = "unavailable",
): Promise<string> {
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\\/\0]/u.test(segment))) {
    throw unavailable("unsafe_path");
  }
  const selected = path.join(store.root, ...segments);
  if (!pathWithin(store.root, selected)) throw unavailable("path_escape");
  let metadata;
  try {
    metadata = await lstat(selected);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      throw missing === "not-found" ? notFound("file_missing") : unavailable("file_missing");
    }
    throw unavailable("file_stat");
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw unavailable("file_type");
  const canonical = await realpath(selected);
  if (!pathWithin(store.root, canonical)) throw unavailable("path_escape");
  return canonical;
}

async function loadManifest(
  store: ReleaseStore,
  segments: readonly string[],
  missing: "not-found" | "unavailable",
): Promise<LoadedManifest> {
  const file = await regularFile(store, segments, missing);
  const metadata = await lstat(file);
  if (metadata.size < 2 || metadata.size > MAX_PIN_RELEASE_MANIFEST_BYTES) throw unavailable("manifest_size");
  const bytes = await readFile(file);
  const canonical = bytes.toString("utf8");
  if (!Buffer.from(canonical, "utf8").equals(bytes)) throw unavailable("manifest_utf8");
  let payload: unknown;
  try {
    payload = JSON.parse(canonical);
  } catch {
    throw unavailable("manifest_json");
  }
  const manifest = parsePinReleaseManifest(payload);
  if (serializePinReleaseManifest(manifest) !== canonical) throw unavailable("manifest_noncanonical");
  return Object.freeze({ manifest, canonical });
}

async function hashArtifact(file: string, artifact: PinReleaseArtifact): Promise<void> {
  if ((await lstat(file)).size !== artifact.size) throw unavailable("artifact_size_mismatch");
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== artifact.sha256) {
    throw unavailable("artifact_sha256_mismatch");
  }
}

async function verifyRelease(
  store: ReleaseStore,
  releaseId: string,
  expectedCanonical?: string,
): Promise<VerifiedRelease> {
  const loaded = await loadManifest(
    store,
    ["releases", releaseId, PIN_RELEASE_IMMUTABLE_MANIFEST],
    "not-found",
  );
  if (loaded.manifest.releaseId !== releaseId) throw unavailable("manifest_release_id_unexpected");
  if (expectedCanonical !== undefined && loaded.canonical !== expectedCanonical) {
    throw unavailable("manifest_pair_mismatch");
  }
  const files = await Promise.all(loaded.manifest.artifacts.map(async (artifact) => {
    const file = await regularFile(store, ["releases", releaseId, artifact.name]);
    const metadata = await lstat(file);
    if (metadata.size !== artifact.size) throw unavailable("artifact_size_mismatch");
    return {
      artifact,
      file,
      dev: metadata.dev,
      ino: metadata.ino,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      ctimeMs: metadata.ctimeMs,
    };
  }));
  const cacheKey = JSON.stringify([
    store.root,
    loaded.canonical,
    files.map(({ dev, ino, size, mtimeMs, ctimeMs }) => [dev, ino, size, mtimeMs, ctimeMs]),
  ]);
  const cached = verifiedReleaseCache.get(cacheKey);
  if (cached) {
    verifiedReleaseCache.delete(cacheKey);
    verifiedReleaseCache.set(cacheKey, cached);
    return cached;
  }
  const active = verificationInFlight.get(cacheKey);
  if (active) return await active;

  const promise = (async (): Promise<VerifiedRelease> => {
    const paths = new Map<PinReleaseRole, string>();
    for (const { artifact, file } of files) paths.set(artifact.role, file);
    await Promise.all(files.map(({ artifact, file }) =>
      hashArtifact(file, artifact),
    ));
    return Object.freeze({
      ...loaded,
      paths: paths as ReadonlyMap<PinReleaseRole, string>,
    });
  })();
  verificationInFlight.set(cacheKey, promise);
  try {
    const verified = await promise;
    verifiedReleaseCache.set(cacheKey, verified);
    while (verifiedReleaseCache.size > VERIFIED_RELEASE_CACHE_LIMIT) {
      verifiedReleaseCache.delete(verifiedReleaseCache.keys().next().value!);
    }
    return verified;
  } finally {
    if (verificationInFlight.get(cacheKey) === promise) verificationInFlight.delete(cacheKey);
  }
}

function expectedPinRelease(environment: PinReleaseEnvironment): ExpectedPinRelease {
  const releaseId = environment.LUMA_PIN_RELEASE_EXPECTED_ID?.trim() ?? "";
  const manifestSha256 = environment.LUMA_PIN_RELEASE_EXPECTED_MANIFEST_SHA256?.trim() ?? "";
  if (!RELEASE_ID_RE.test(releaseId) || !SHA256_RE.test(manifestSha256)) {
    throw unavailable("expected_release_invalid");
  }
  return Object.freeze({ releaseId, manifestSha256 });
}

async function verifyActiveRelease(
  store: ReleaseStore,
  environment: PinReleaseEnvironment,
): Promise<VerifiedRelease> {
  const expected = expectedPinRelease(environment);
  const current = await loadManifest(store, [PIN_RELEASE_CURRENT_MANIFEST], "not-found");
  const manifestSha256 = createHash("sha256").update(current.canonical).digest("hex");
  if (current.manifest.releaseId !== expected.releaseId || manifestSha256 !== expected.manifestSha256) {
    throw unavailable("active_release_mismatch");
  }
  return verifyRelease(store, current.manifest.releaseId, current.canonical);
}

function configuredSetupOrigin(environment: PinReleaseEnvironment): string | null {
  const configured = environment.LUMA_PIN_SETUP_ORIGIN?.trim();
  if (!configured) return null;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw unavailable("setup_origin_invalid");
  }
  if (!/^https?:$/u.test(parsed.protocol) || parsed.origin !== configured || parsed.username || parsed.password) {
    throw unavailable("setup_origin_invalid");
  }
  return parsed.origin;
}

function corsHeaders(request: Request, environment: PinReleaseEnvironment): Headers {
  const headers = new Headers();
  const origin = request.headers.get("origin");
  if (!origin) return headers;
  let requestOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    throw unavailable("request_url_invalid");
  }
  const allowed = new Set([requestOrigin]);
  const configured = configuredSetupOrigin(environment);
  if (configured) allowed.add(configured);
  if (!allowed.has(origin)) throw new PinReleaseServingError(403, "Origin is not allowed.", "origin_not_allowed");
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "Origin");
  return headers;
}

function hardenedHeaders(cors = new Headers()): Headers {
  const headers = new Headers(cors);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  return headers;
}

function errorResponse(error: unknown, head: boolean, cors: Headers, context: string): Response {
  const known = error instanceof PinReleaseServingError
    ? error
    : unavailable("unexpected_error");
  logWarn(`${context}: ${known.reason}`);
  const body = JSON.stringify({ error: known.message });
  const headers = hardenedHeaders(cors);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("content-length", String(Buffer.byteLength(body)));
  return new Response(head ? null : body, { status: known.status, headers });
}

function routeRole(assetName: string): PinReleaseRole | null {
  return PIN_RELEASE_ROLES.find((role) => `${role}.apk` === assetName) ?? null;
}

function requestedRange(request: Request, size: number): { start: number; end: number; partial: boolean } {
  const value = request.headers.get("range");
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || (!match[1] && !match[2])) {
    throw new PinReleaseServingError(416, "Invalid byte range.", "range_invalid");
  }
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw new PinReleaseServingError(416, "Invalid byte range.", "range_invalid");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    throw new PinReleaseServingError(416, "Invalid byte range.", "range_invalid");
  }
  return { start, end: Math.min(end, size - 1), partial: true };
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
    const current = await verifyActiveRelease(store, environment);
    const headers = hardenedHeaders(cors);
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set("content-length", String(Buffer.byteLength(current.canonical)));
    return new Response(head ? null : current.canonical, { status: 200, headers });
  } catch (error) {
    return errorResponse(error, head, cors, "pin release current");
  }
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
    await verifyActiveRelease(store, environment);
    const release = await verifyRelease(store, releaseId);
    const artifact = release.manifest.artifacts.find((candidate) => candidate.role === role)!;
    const range = requestedRange(request, artifact.size);
    const headers = hardenedHeaders(cors);
    headers.set("content-type", "application/vnd.android.package-archive");
    headers.set("accept-ranges", "bytes");
    headers.set("content-length", String(range.end - range.start + 1));
    if (range.partial) headers.set("content-range", `bytes ${range.start}-${range.end}/${artifact.size}`);
    if (head) return new Response(null, { status: range.partial ? 206 : 200, headers });
    const stream = Readable.toWeb(fs.createReadStream(release.paths.get(role)!, {
      start: range.start,
      end: range.end,
    })) as ReadableStream<Uint8Array>;
    return new Response(stream, { status: range.partial ? 206 : 200, headers });
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
    const method = request.headers.get("access-control-request-method");
    if (method && method !== "GET" && method !== "HEAD") {
      throw new PinReleaseServingError(403, "Origin is not allowed.", "method_not_allowed");
    }
    const requestedHeaders = request.headers.get("access-control-request-headers")
      ?.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean) ?? [];
    if (requestedHeaders.some((value) => value !== "accept" && value !== "range")) {
      throw new PinReleaseServingError(403, "Origin is not allowed.", "header_not_allowed");
    }
    const headers = hardenedHeaders(cors);
    headers.set("allow", "GET, HEAD, OPTIONS");
    if (request.headers.has("origin")) {
      headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
      headers.set("access-control-allow-headers", "Accept, Range");
      headers.set("access-control-max-age", "300");
    }
    return new Response(null, { status: 204, headers });
  } catch (error) {
    return errorResponse(error, false, cors, "pin release preflight");
  }
}
