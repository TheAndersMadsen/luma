import { compareInstallVersions, parseInstallVersion } from "../domain/versions";
import { MANAGED_PACKAGES } from "../domain/managedPackages";

export const DEFAULT_PIN_RELEASE_MANIFEST_URL = "/api/pin/releases/current";
export const PIN_RELEASE_MANIFEST_SCHEMA_VERSION = 1;
export const MAX_PIN_ARTIFACT_SIZE_BYTES = 512 * 1024 * 1024;

export const PIN_RELEASE_ARTIFACT_ROLES = [
  "installer",
  "bootstrap",
  "hook",
  "server",
  "hook-injector",
] as const;

export type PinReleaseArtifactRole =
  (typeof PIN_RELEASE_ARTIFACT_ROLES)[number];

export const PIN_RELEASE_PACKAGE_BY_ROLE: Readonly<
  Record<PinReleaseArtifactRole, string>
> = Object.freeze({
  installer: MANAGED_PACKAGES.installer,
  bootstrap: MANAGED_PACKAGES.exploitHelper,
  hook: MANAGED_PACKAGES.hook,
  server: MANAGED_PACKAGES.server,
  "hook-injector": MANAGED_PACKAGES.injector,
});

export interface PinReleaseArtifact {
  readonly role: PinReleaseArtifactRole;
  readonly url: string;
  readonly name: string;
  readonly package: string;
  readonly versionCode: number;
  readonly size: number;
  readonly sha256: string;
}

export interface PinReleaseManifest {
  readonly schemaVersion: 1;
  readonly releaseId: string;
  readonly version: string;
  readonly artifacts: readonly PinReleaseArtifact[];
}

export interface AcceptedPinRelease {
  readonly releaseId: string;
  readonly version: string;
  readonly versionCode: number;
  readonly canonicalManifest: string;
}

export interface PinReleaseHistory {
  read(channelKey: string): AcceptedPinRelease | null;
  write(channelKey: string, release: AcceptedPinRelease): void;
}

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly url?: string;
  json(): Promise<unknown>;
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<FetchResponseLike>;

export type PinReleaseErrorCode =
  | "release-manifest-fetch-failed"
  | "release-manifest-invalid"
  | "release-manifest-untrusted"
  | "release-manifest-version-regression"
  | "release-manifest-equivocation"
  | "release-asset-download-failed"
  | "release-asset-integrity-failed";

export interface PinReleaseErrorOptions {
  readonly code: PinReleaseErrorCode;
  readonly message: string;
  readonly manifestUrl?: string;
  readonly releaseId?: string;
  readonly role?: string;
  readonly assetName?: string;
  readonly status?: number;
  readonly statusText?: string;
}

export class PinReleaseError extends Error {
  readonly code: PinReleaseErrorCode;
  readonly manifestUrl?: string;
  readonly releaseId?: string;
  readonly role?: string;
  readonly assetName?: string;
  readonly status?: number;
  readonly statusText?: string;

  constructor(options: PinReleaseErrorOptions) {
    super(options.message);
    this.name = "PinReleaseError";
    this.code = options.code;
    this.manifestUrl = options.manifestUrl;
    this.releaseId = options.releaseId;
    this.role = options.role;
    this.assetName = options.assetName;
    this.status = options.status;
    this.statusText = options.statusText;
  }
}

export function isPinReleaseError(error: unknown): error is PinReleaseError {
  return error instanceof PinReleaseError;
}

const RELEASE_ID_RE = /^[0-9a-f]{64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const APK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.apk$/;
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
const HISTORY_STORAGE_PREFIX = "ai-pin-revival.pin-release.v1:";

function invalidManifest(
  message: string,
  options: Omit<PinReleaseErrorOptions, "code" | "message"> = {},
): never {
  throw new PinReleaseError({
    code: "release-manifest-invalid",
    message,
    ...options,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((field, index) => field !== wanted[index])
  ) {
    invalidManifest(`${label} contains missing or unexpected fields.`);
  }
}

function requiredTrimmedString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    invalidManifest(`${field} must be a non-empty, trimmed string.`);
  }
  return value;
}

function requiredPositiveInteger(
  value: unknown,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    invalidManifest(`${field} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

function isExplicitUrl(value: string): boolean {
  return /^[A-Za-z][A-Za-z\d+.-]*:/u.test(value) || value.startsWith("//");
}

function resolveTrustedManifestUrl(rawUrl: string, baseUrl: string): {
  readonly requestUrl: string;
  readonly absoluteUrl: string;
  readonly historyKey: string;
} {
  const requestUrl = requiredTrimmedString(rawUrl, "release manifest URL");
  let base: URL;
  let resolved: URL;
  try {
    base = new URL(baseUrl);
    resolved = new URL(requestUrl, base);
  } catch {
    throw new PinReleaseError({
      code: "release-manifest-untrusted",
      message: "The configured Pin release manifest URL is invalid.",
      manifestUrl: requestUrl,
    });
  }

  if (isExplicitUrl(requestUrl) && resolved.protocol !== "https:") {
    throw new PinReleaseError({
      code: "release-manifest-untrusted",
      message: "An absolute Pin release manifest URL must use HTTPS.",
      manifestUrl: requestUrl,
    });
  }

  if (resolved.origin !== base.origin) {
    throw new PinReleaseError({
      code: "release-manifest-untrusted",
      message: "The Pin release manifest must use the Setup application origin.",
      manifestUrl: requestUrl,
    });
  }

  if (resolved.username || resolved.password || resolved.hash) {
    throw new PinReleaseError({
      code: "release-manifest-untrusted",
      message: "The Pin release manifest URL must not contain credentials or a fragment.",
      manifestUrl: requestUrl,
    });
  }

  return {
    requestUrl,
    absoluteUrl: resolved.toString(),
    historyKey: `${resolved.origin}${resolved.pathname}`,
  };
}

function resolveTrustedArtifactUrl(
  rawUrl: unknown,
  manifestUrl: string,
  role: PinReleaseArtifactRole,
): string {
  const artifactUrl = requiredTrimmedString(rawUrl, `${role}.url`);
  let resolved: URL;
  const manifest = new URL(manifestUrl);

  try {
    resolved = new URL(artifactUrl, manifest);
  } catch {
    throw new PinReleaseError({
      code: "release-manifest-untrusted",
      message: `The ${role} artifact URL is invalid.`,
      manifestUrl,
      role,
    });
  }

  if (isExplicitUrl(artifactUrl) && resolved.protocol !== "https:") {
    throw new PinReleaseError({
      code: "release-manifest-untrusted",
      message: `The absolute ${role} artifact URL must use HTTPS.`,
      manifestUrl,
      role,
    });
  }

  if (
    resolved.origin !== manifest.origin ||
    resolved.username ||
    resolved.password ||
    resolved.hash
  ) {
    throw new PinReleaseError({
      code: "release-manifest-untrusted",
      message: `The ${role} artifact must use the release manifest origin.`,
      manifestUrl,
      role,
    });
  }

  return resolved.toString();
}

function parseArtifact(
  value: unknown,
  manifestUrl: string,
  index: number,
): PinReleaseArtifact {
  if (!isRecord(value)) {
    invalidManifest(`artifacts[${index}] must be an object.`);
  }
  assertExactFields(value, ARTIFACT_FIELDS, `artifacts[${index}]`);

  const rawRole = requiredTrimmedString(value.role, `artifacts[${index}].role`);
  if (!(PIN_RELEASE_ARTIFACT_ROLES as readonly string[]).includes(rawRole)) {
    invalidManifest(`artifacts[${index}].role is unknown.`, { role: rawRole });
  }
  const role = rawRole as PinReleaseArtifactRole;
  const name = requiredTrimmedString(value.name, `${role}.name`);
  if (!APK_NAME_RE.test(name)) {
    invalidManifest(`${role}.name must be a safe APK filename.`, {
      role,
      assetName: name,
    });
  }

  const packageName = requiredTrimmedString(value.package, `${role}.package`);
  if (packageName !== PIN_RELEASE_PACKAGE_BY_ROLE[role]) {
    invalidManifest(`${role}.package does not match its required package identity.`, {
      role,
      assetName: name,
    });
  }

  const sha256 = requiredTrimmedString(value.sha256, `${role}.sha256`);
  if (!SHA256_RE.test(sha256)) {
    invalidManifest(`${role}.sha256 must be 64 lowercase hexadecimal characters.`, {
      role,
      assetName: name,
    });
  }

  return Object.freeze({
    role,
    url: resolveTrustedArtifactUrl(value.url, manifestUrl, role),
    name,
    package: packageName,
    versionCode: requiredPositiveInteger(
      value.versionCode,
      `${role}.versionCode`,
      2_147_483_647,
    ),
    size: requiredPositiveInteger(
      value.size,
      `${role}.size`,
      MAX_PIN_ARTIFACT_SIZE_BYTES,
    ),
    sha256,
  });
}

function canonicalizeManifest(manifest: PinReleaseManifest): string {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    releaseId: manifest.releaseId,
    version: manifest.version,
    artifacts: PIN_RELEASE_ARTIFACT_ROLES.map((role) =>
      manifest.artifacts.find((artifact) => artifact.role === role),
    ),
  });
}

export function parsePinReleaseManifest(
  payload: unknown,
  manifestUrl: string,
): PinReleaseManifest {
  if (!isRecord(payload)) {
    invalidManifest("The Pin release manifest must be an object.", { manifestUrl });
  }
  assertExactFields(payload, ROOT_FIELDS, "release manifest");

  if (payload.schemaVersion !== PIN_RELEASE_MANIFEST_SCHEMA_VERSION) {
    invalidManifest("The Pin release manifest schemaVersion must be 1.", {
      manifestUrl,
    });
  }

  const releaseId = requiredTrimmedString(payload.releaseId, "releaseId");
  if (!RELEASE_ID_RE.test(releaseId)) {
    invalidManifest("releaseId must be an immutable 64-character lowercase hexadecimal identifier.", {
      manifestUrl,
      releaseId,
    });
  }

  const version = requiredTrimmedString(payload.version, "version");
  if (!parseInstallVersion(version)) {
    invalidManifest("version must use the monotonic YYYY-MM-DD.N format.", {
      manifestUrl,
      releaseId,
    });
  }

  if (!Array.isArray(payload.artifacts)) {
    invalidManifest("artifacts must be an array.", { manifestUrl, releaseId });
  }

  const artifacts = payload.artifacts.map((artifact, index) =>
    parseArtifact(artifact, manifestUrl, index),
  );
  const roles = new Set(artifacts.map((artifact) => artifact.role));
  if (
    artifacts.length !== PIN_RELEASE_ARTIFACT_ROLES.length ||
    roles.size !== PIN_RELEASE_ARTIFACT_ROLES.length
  ) {
    invalidManifest("The manifest must contain each required artifact role exactly once.", {
      manifestUrl,
      releaseId,
    });
  }
  for (const role of PIN_RELEASE_ARTIFACT_ROLES) {
    if (!roles.has(role)) {
      invalidManifest(`The manifest is missing the ${role} artifact.`, {
        manifestUrl,
        releaseId,
        role,
      });
    }
  }

  const versionCodes = new Set(artifacts.map((artifact) => artifact.versionCode));
  if (versionCodes.size !== 1) {
    invalidManifest("All artifacts in an atomic Pin release must have the same versionCode.", {
      manifestUrl,
      releaseId,
    });
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    releaseId,
    version,
    artifacts: Object.freeze(
      PIN_RELEASE_ARTIFACT_ROLES.map(
        (role) => artifacts.find((artifact) => artifact.role === role)!,
      ),
    ),
  });
}

function isAcceptedPinRelease(value: unknown): value is AcceptedPinRelease {
  if (!isRecord(value)) {
    return false;
  }
  const actualFields = Object.keys(value).sort();
  const acceptedFields = [
    "canonicalManifest",
    "releaseId",
    "version",
    "versionCode",
  ];
  return (
    actualFields.length === acceptedFields.length &&
    actualFields.every((field, index) => field === acceptedFields[index]) &&
    typeof value.releaseId === "string" &&
    RELEASE_ID_RE.test(value.releaseId) &&
    typeof value.version === "string" &&
    parseInstallVersion(value.version) !== null &&
    typeof value.versionCode === "number" &&
    Number.isSafeInteger(value.versionCode) &&
    value.versionCode > 0 &&
    value.versionCode <= 2_147_483_647 &&
    typeof value.canonicalManifest === "string" &&
    value.canonicalManifest.length > 0
  );
}

export function createMemoryPinReleaseHistory(): PinReleaseHistory {
  const entries = new Map<string, AcceptedPinRelease>();
  return {
    read(manifestUrl) {
      return entries.get(manifestUrl) ?? null;
    },
    write(manifestUrl, release) {
      entries.set(manifestUrl, release);
    },
  };
}

function getBrowserStorage(): Storage | null {
  return typeof globalThis.localStorage === "undefined"
    ? null
    : globalThis.localStorage;
}

function releaseHistoryUnavailable(message: string): never {
  throw new PinReleaseError({
    code: "release-manifest-untrusted",
    message,
  });
}

export function createPersistentPinReleaseHistory(
  storageProvider: () => Pick<Storage, "getItem" | "setItem"> | null =
    getBrowserStorage,
): PinReleaseHistory {
  function requireStorage(): Pick<Storage, "getItem" | "setItem"> {
    try {
      const storage = storageProvider();
      if (storage) {
        return storage;
      }
    } catch {
      // Converted to a stable, redacted release trust error below.
    }

    return releaseHistoryUnavailable(
      "Persistent Pin release history is unavailable; release installation is disabled.",
    );
  }

  return {
    read(channelKey) {
      const storage = requireStorage();
      let raw: string | null;
      try {
        raw = storage.getItem(`${HISTORY_STORAGE_PREFIX}${channelKey}`);
      } catch {
        return releaseHistoryUnavailable(
          "Persistent Pin release history could not be read; release installation is disabled.",
        );
      }

      if (raw === null) {
        return null;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return releaseHistoryUnavailable(
          "Persistent Pin release history is corrupt; release installation is disabled.",
        );
      }

      if (!isAcceptedPinRelease(parsed)) {
        return releaseHistoryUnavailable(
          "Persistent Pin release history is invalid; release installation is disabled.",
        );
      }
      return Object.freeze({ ...parsed });
    },
    write(channelKey, release) {
      if (!isAcceptedPinRelease(release)) {
        return releaseHistoryUnavailable(
          "The accepted Pin release record is invalid; release installation is disabled.",
        );
      }

      try {
        requireStorage().setItem(
          `${HISTORY_STORAGE_PREFIX}${channelKey}`,
          JSON.stringify(release),
        );
      } catch (error) {
        if (isPinReleaseError(error)) {
          throw error;
        }
        return releaseHistoryUnavailable(
          "Persistent Pin release history could not be updated; release installation is disabled.",
        );
      }
    },
  };
}

const defaultHistory = createPersistentPinReleaseHistory();

function assertMonotonicRelease(
  manifest: PinReleaseManifest,
  manifestUrl: string,
  historyKey: string,
  history: PinReleaseHistory,
): void {
  const versionCode = manifest.artifacts[0].versionCode;
  const canonicalManifest = canonicalizeManifest(manifest);
  const previous = history.read(historyKey);

  if (previous?.releaseId === manifest.releaseId) {
    if (previous.canonicalManifest !== canonicalManifest) {
      throw new PinReleaseError({
        code: "release-manifest-equivocation",
        message: "The release manifest changed while retaining the same immutable releaseId.",
        manifestUrl,
        releaseId: manifest.releaseId,
      });
    }
    return;
  }

  if (previous) {
    const versionOrder = compareInstallVersions(manifest.version, previous.version);
    if (versionOrder !== 1 || versionCode <= previous.versionCode) {
      throw new PinReleaseError({
        code: "release-manifest-version-regression",
        message: "The release manifest version and versionCode must increase monotonically.",
        manifestUrl,
        releaseId: manifest.releaseId,
      });
    }
  }

  history.write(historyKey, {
    releaseId: manifest.releaseId,
    version: manifest.version,
    versionCode,
    canonicalManifest,
  });
}

function getDefaultBaseUrl(): string {
  return typeof globalThis.location?.href === "string"
    ? globalThis.location.href
    : "https://setup.invalid/";
}

function getDefaultFetch(): FetchLike {
  return (input, init) =>
    globalThis.fetch(input, init) as Promise<FetchResponseLike>;
}

/**
 * Next inlines `process.env.NEXT_PUBLIC_*` into the client bundle at build
 * time, so this must stay written out literally — do not destructure it.
 * Unset (the normal case) falls back to the same-origin default, which is what
 * every deploy gate and `center/verify/public-assets.test.mjs` pin.
 */
// prettier-ignore
export function getPinReleaseManifestUrl(
  configuredUrl: string | undefined = process.env.NEXT_PUBLIC_PIN_RELEASE_MANIFEST_URL,
): string {
  return configuredUrl?.trim() || DEFAULT_PIN_RELEASE_MANIFEST_URL;
}

export interface FetchPinReleaseManifestOptions {
  readonly fetchImpl?: FetchLike;
  readonly manifestUrl?: string;
  readonly baseUrl?: string;
  readonly history?: PinReleaseHistory;
}

export async function fetchPinReleaseManifest(
  options: FetchPinReleaseManifestOptions = {},
): Promise<{ readonly manifest: PinReleaseManifest; readonly manifestUrl: string }> {
  const source = resolveTrustedManifestUrl(
    options.manifestUrl ?? getPinReleaseManifestUrl(),
    options.baseUrl ?? getDefaultBaseUrl(),
  );
  const fetchImpl = options.fetchImpl ?? getDefaultFetch();
  let response: FetchResponseLike;

  try {
    response = await fetchImpl(source.requestUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  } catch (error) {
    throw new PinReleaseError({
      code: "release-manifest-fetch-failed",
      message: "Could not load the Pin release manifest.",
      manifestUrl: source.absoluteUrl,
      statusText: error instanceof Error ? error.message : String(error),
    });
  }

  if (!response.ok) {
    throw new PinReleaseError({
      code: "release-manifest-fetch-failed",
      message: `Pin release manifest lookup failed (${response.status} ${response.statusText}).`,
      manifestUrl: source.absoluteUrl,
      status: response.status,
      statusText: response.statusText,
    });
  }

  if (response.url) {
    const responseUrl = new URL(response.url, source.absoluteUrl);
    if (
      responseUrl.origin !== new URL(source.absoluteUrl).origin ||
      responseUrl.username ||
      responseUrl.password ||
      responseUrl.hash
    ) {
      throw new PinReleaseError({
        code: "release-manifest-untrusted",
        message: "The Pin release manifest response crossed an origin boundary.",
        manifestUrl: source.absoluteUrl,
      });
    }
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new PinReleaseError({
      code: "release-manifest-invalid",
      message: "The Pin release manifest response was not valid JSON.",
      manifestUrl: source.absoluteUrl,
    });
  }

  const manifest = parsePinReleaseManifest(payload, source.absoluteUrl);
  assertMonotonicRelease(
    manifest,
    source.absoluteUrl,
    source.historyKey,
    options.history ?? defaultHistory,
  );
  return Object.freeze({ manifest, manifestUrl: source.absoluteUrl });
}
