import { createHash } from "node:crypto";
import {
  basename,
  isAbsolute,
} from "node:path";

const PIN_RELEASE_SCHEMA_VERSION = 1;
export const PIN_RELEASE_ARTIFACT_ROLES = Object.freeze([
  "installer",
  "bootstrap",
  "hook",
  "server",
  "hook-injector",
]);
export const PIN_RELEASE_PACKAGE_BY_ROLE = Object.freeze({
  installer: "com.penumbraos.systeminjector",
  bootstrap: "com.penumbraos.systeminjector.exploit",
  hook: "com.penumbraos.hook",
  server: "com.penumbraos.server",
  "hook-injector": "com.penumbraos.hook.injector",
});
const MAX_PIN_ARTIFACT_SIZE_BYTES = 512 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
const APK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.apk$/;
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const VERSION_RE = /^(\d{4})-(\d{2})-(\d{2})\.(\d+)$/;
const MAX_VERSION_CODE = 2_147_483_647;

const MANIFEST_FIELDS = Object.freeze([
  "schemaVersion",
  "releaseId",
  "version",
  "artifacts",
]);
const MANIFEST_ARTIFACT_FIELDS = Object.freeze([
  "role",
  "url",
  "name",
  "package",
  "versionCode",
  "size",
  "sha256",
]);
const RECEIPT_BUNDLE_FIELDS = Object.freeze(["schemaVersion", "artifacts"]);
const RECEIPT_FIELDS = Object.freeze([
  "role",
  "path",
  "name",
  "package",
  "versionName",
  "versionCode",
  "size",
  "sha256",
  "signerSha256",
]);
const HISTORY_FIELDS = Object.freeze(["schemaVersion", "releases"]);
const HISTORY_ENTRY_FIELDS = Object.freeze([
  "releaseId",
  "version",
  "versionCode",
  "manifestSha256",
]);

export class PinReleaseContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PinReleaseContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PinReleaseContractError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactFields(value, expected, label) {
  if (!isRecord(value)) {
    fail("invalid-shape", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((field, index) => field !== wanted[index])
  ) {
    fail("invalid-shape", `${label} contains missing or unexpected fields`);
  }
}

function requiredTrimmedString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    fail("invalid-value", `${label} must be a non-empty trimmed string`);
  }
  return value;
}

function requiredPositiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    fail(
      "invalid-value",
      `${label} must be a positive integer no greater than ${maximum}`,
    );
  }
  return value;
}

function requiredSha256(value, label) {
  const digest = requiredTrimmedString(value, label);
  if (!SHA256_RE.test(digest)) {
    fail("invalid-digest", `${label} must be 64 lowercase hexadecimal characters`);
  }
  return digest;
}

function requiredRole(value, label) {
  const role = requiredTrimmedString(value, label);
  if (!PIN_RELEASE_ARTIFACT_ROLES.includes(role)) {
    fail("unknown-role", `${label} is not a recognized Pin release role`);
  }
  return role;
}

function validatePinReleaseRelativePath(value, label = "path") {
  const path = requiredTrimmedString(value, label);
  if (
    path.length > 1024 ||
    path.includes("\\") ||
    path.includes("\0") ||
    isAbsolute(path)
  ) {
    fail("unsafe-path", `${label} must be a portable relative path`);
  }
  const parts = path.split("/");
  if (
    parts.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        !SAFE_PATH_SEGMENT_RE.test(part),
    )
  ) {
    fail("unsafe-path", `${label} contains an unsafe path segment`);
  }
  return path;
}

function parseInstallVersion(value, label = "version") {
  const version = requiredTrimmedString(value, label);
  const match = VERSION_RE.exec(version);
  if (!match) {
    fail("invalid-version", `${label} must use valid YYYY-MM-DD.N syntax`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const increment = Number(match[4]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    !Number.isSafeInteger(increment)
  ) {
    fail("invalid-version", `${label} must use a real UTC date and safe increment`);
  }
  return Object.freeze({ value: version, dateKey: year * 10000 + month * 100 + day, increment });
}

function compareInstallVersions(left, right) {
  const a = parseInstallVersion(left, "left version");
  const b = parseInstallVersion(right, "right version");
  if (a.dateKey !== b.dateKey) return a.dateKey < b.dateKey ? -1 : 1;
  if (a.increment !== b.increment) return a.increment < b.increment ? -1 : 1;
  return 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parsePinReleaseJson(source, label = "JSON") {
  if (typeof source !== "string") fail("invalid-json", `${label} must be text`);
  try {
    return JSON.parse(source);
  } catch (error) {
    fail("invalid-json", `${label} is invalid: ${error.message}`);
  }
}

function parseManifestArtifact(value, index, releaseId) {
  assertExactFields(value, MANIFEST_ARTIFACT_FIELDS, `artifacts[${index}]`);
  const role = requiredRole(value.role, `artifacts[${index}].role`);
  const expectedUrl = `./${releaseId}/${role}.apk`;
  if (value.url !== expectedUrl) {
    fail("url-mismatch", `${role}.url must be exactly ${expectedUrl}`);
  }
  const name = requiredTrimmedString(value.name, `${role}.name`);
  if (!APK_NAME_RE.test(name)) fail("unsafe-path", `${role}.name must be a safe APK filename`);
  const packageName = requiredTrimmedString(value.package, `${role}.package`);
  if (packageName !== PIN_RELEASE_PACKAGE_BY_ROLE[role]) {
    fail("package-mismatch", `${role}.package does not match its fixed package identity`);
  }
  return Object.freeze({
    role,
    url: expectedUrl,
    name,
    package: packageName,
    versionCode: requiredPositiveInteger(value.versionCode, `${role}.versionCode`, MAX_VERSION_CODE),
    size: requiredPositiveInteger(value.size, `${role}.size`, MAX_PIN_ARTIFACT_SIZE_BYTES),
    sha256: requiredSha256(value.sha256, `${role}.sha256`),
  });
}

function canonicalRoleOrder(artifacts, label) {
  if (!Array.isArray(artifacts)) fail("invalid-shape", `${label} must be an array`);
  const byRole = new Map();
  for (const artifact of artifacts) {
    if (byRole.has(artifact.role)) fail("duplicate-role", `${label} contains duplicate role ${artifact.role}`);
    byRole.set(artifact.role, artifact);
  }
  if (byRole.size !== PIN_RELEASE_ARTIFACT_ROLES.length) {
    fail("partial-bundle", `${label} must contain all five Pin artifact roles`);
  }
  for (const role of PIN_RELEASE_ARTIFACT_ROLES) {
    if (!byRole.has(role)) fail("partial-bundle", `${label} is missing role ${role}`);
  }
  return Object.freeze(PIN_RELEASE_ARTIFACT_ROLES.map((role) => byRole.get(role)));
}

function releaseIdentityPayload(version, artifacts) {
  return {
    schemaVersion: PIN_RELEASE_SCHEMA_VERSION,
    version,
    artifacts: artifacts.map((artifact) => ({
      role: artifact.role,
      name: artifact.name,
      package: artifact.package,
      versionCode: artifact.versionCode,
      size: artifact.size,
      sha256: artifact.sha256,
    })),
  };
}

function derivePinReleaseId(value) {
  const version = parseInstallVersion(value?.version, "version").value;
  if (!Array.isArray(value?.artifacts)) fail("invalid-shape", "artifacts must be an array");
  const parsed = value.artifacts.map((artifact, index) => {
    if (!isRecord(artifact)) fail("invalid-shape", `artifacts[${index}] must be an object`);
    const role = requiredRole(artifact.role, `artifacts[${index}].role`);
    const name = requiredTrimmedString(artifact.name, `${role}.name`);
    if (!APK_NAME_RE.test(name)) fail("unsafe-path", `${role}.name must be a safe APK filename`);
    const packageName = requiredTrimmedString(artifact.package, `${role}.package`);
    if (packageName !== PIN_RELEASE_PACKAGE_BY_ROLE[role]) fail("package-mismatch", `${role}.package is invalid`);
    return {
      role,
      name,
      package: packageName,
      versionCode: requiredPositiveInteger(artifact.versionCode, `${role}.versionCode`, MAX_VERSION_CODE),
      size: requiredPositiveInteger(artifact.size, `${role}.size`, MAX_PIN_ARTIFACT_SIZE_BYTES),
      sha256: requiredSha256(artifact.sha256, `${role}.sha256`),
    };
  });
  const ordered = canonicalRoleOrder(parsed, "release identity artifacts");
  const versionCodes = new Set(ordered.map((artifact) => artifact.versionCode));
  if (versionCodes.size !== 1) fail("version-mismatch", "all release artifacts must share one versionCode");
  return sha256(JSON.stringify(releaseIdentityPayload(version, ordered)));
}

function parsePinReleaseManifest(value) {
  assertExactFields(value, MANIFEST_FIELDS, "Pin release manifest");
  if (value.schemaVersion !== PIN_RELEASE_SCHEMA_VERSION) {
    fail("schema-version", "Pin release manifest schemaVersion must be 1");
  }
  const releaseId = requiredSha256(value.releaseId, "releaseId");
  const version = parseInstallVersion(value.version, "version").value;
  if (!Array.isArray(value.artifacts)) fail("invalid-shape", "artifacts must be an array");
  const artifacts = canonicalRoleOrder(
    value.artifacts.map((artifact, index) => parseManifestArtifact(artifact, index, releaseId)),
    "manifest artifacts",
  );
  const versionCodes = new Set(artifacts.map((artifact) => artifact.versionCode));
  if (versionCodes.size !== 1) fail("version-mismatch", "all manifest artifacts must share one versionCode");
  const manifest = Object.freeze({
    schemaVersion: value.schemaVersion,
    releaseId,
    version,
    artifacts,
  });
  const derived = derivePinReleaseId(manifest);
  if (derived !== releaseId) fail("release-id-mismatch", "releaseId does not match canonical artifact metadata");
  return manifest;
}

export function canonicalPinReleaseManifestJson(value) {
  const manifest = parsePinReleaseManifest(value);
  const document = {
    schemaVersion: manifest.schemaVersion,
    releaseId: manifest.releaseId,
    version: manifest.version,
    artifacts: manifest.artifacts.map((artifact) => ({
      role: artifact.role,
      url: artifact.url,
      name: artifact.name,
      package: artifact.package,
      versionCode: artifact.versionCode,
      size: artifact.size,
      sha256: artifact.sha256,
    })),
  };
  return `${JSON.stringify(document)}\n`;
}

export function parseCanonicalPinReleaseManifestDocument(source) {
  const manifest = parsePinReleaseManifest(parsePinReleaseJson(source, "Pin release manifest"));
  if (source !== canonicalPinReleaseManifestJson(manifest)) {
    fail("manifest-noncanonical", "Pin release manifest bytes are not canonical compact JSON plus one LF");
  }
  return manifest;
}

export function createPinReleaseManifest({ version, receipts }) {
  const parsedReceipts = parsePinReleaseReceiptBundle(receipts);
  const normalizedVersion = parseInstallVersion(version, "version").value;
  for (const receipt of parsedReceipts.artifacts) {
    if (receipt.versionName !== normalizedVersion) {
      fail("version-mismatch", `${receipt.role} APK versionName does not match release version`);
    }
  }
  const releaseId = derivePinReleaseId({
    version: normalizedVersion,
    artifacts: parsedReceipts.artifacts,
  });
  return parsePinReleaseManifest({
    schemaVersion: PIN_RELEASE_SCHEMA_VERSION,
    releaseId,
    version: normalizedVersion,
    artifacts: parsedReceipts.artifacts.map((receipt) => ({
      role: receipt.role,
      url: `./${releaseId}/${receipt.role}.apk`,
      name: receipt.name,
      package: receipt.package,
      versionCode: receipt.versionCode,
      size: receipt.size,
      sha256: receipt.sha256,
    })),
  });
}

function parseReceipt(value, index) {
  assertExactFields(value, RECEIPT_FIELDS, `receipt artifacts[${index}]`);
  const role = requiredRole(value.role, `receipt artifacts[${index}].role`);
  const path = validatePinReleaseRelativePath(value.path, `${role}.path`);
  const name = requiredTrimmedString(value.name, `${role}.name`);
  if (!APK_NAME_RE.test(name) || basename(path) !== name) {
    fail("unsafe-path", `${role}.name must be the safe APK basename of its receipt path`);
  }
  const packageName = requiredTrimmedString(value.package, `${role}.package`);
  if (packageName !== PIN_RELEASE_PACKAGE_BY_ROLE[role]) fail("package-mismatch", `${role}.package is invalid`);
  return Object.freeze({
    role,
    path,
    name,
    package: packageName,
    versionName: parseInstallVersion(value.versionName, `${role}.versionName`).value,
    versionCode: requiredPositiveInteger(value.versionCode, `${role}.versionCode`, MAX_VERSION_CODE),
    size: requiredPositiveInteger(value.size, `${role}.size`, MAX_PIN_ARTIFACT_SIZE_BYTES),
    sha256: requiredSha256(value.sha256, `${role}.sha256`),
    signerSha256: requiredSha256(value.signerSha256, `${role}.signerSha256`),
  });
}

export function parsePinReleaseReceiptBundle(value) {
  assertExactFields(value, RECEIPT_BUNDLE_FIELDS, "Pin release receipt bundle");
  if (value.schemaVersion !== PIN_RELEASE_SCHEMA_VERSION) fail("schema-version", "receipt schemaVersion must be 1");
  if (!Array.isArray(value.artifacts)) fail("invalid-shape", "receipt artifacts must be an array");
  const artifacts = canonicalRoleOrder(
    value.artifacts.map((artifact, index) => parseReceipt(artifact, index)),
    "receipt artifacts",
  );
  if (new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length) {
    fail("duplicate-path", "receipt artifacts must use distinct paths");
  }
  if (new Set(artifacts.map((artifact) => artifact.versionCode)).size !== 1) {
    fail("version-mismatch", "all receipt artifacts must share one versionCode");
  }
  if (new Set(artifacts.map((artifact) => artifact.versionName)).size !== 1) {
    fail("version-mismatch", "all receipt artifacts must share one versionName");
  }
  return Object.freeze({ schemaVersion: 1, artifacts });
}

export function parsePinReleaseHistory(value) {
  assertExactFields(value, HISTORY_FIELDS, "release history");
  if (value.schemaVersion !== PIN_RELEASE_SCHEMA_VERSION) fail("schema-version", "release history schemaVersion must be 1");
  if (!Array.isArray(value.releases)) fail("invalid-shape", "release history releases must be an array");
  const seen = new Set();
  const releases = value.releases.map((entry, index) => {
    assertExactFields(entry, HISTORY_ENTRY_FIELDS, `release history[${index}]`);
    const releaseId = requiredSha256(entry.releaseId, `release history[${index}].releaseId`);
    if (seen.has(releaseId)) fail("release-equivocation", `release history duplicates releaseId ${releaseId}`);
    seen.add(releaseId);
    return Object.freeze({
      releaseId,
      version: parseInstallVersion(entry.version, `release history[${index}].version`).value,
      versionCode: requiredPositiveInteger(entry.versionCode, `release history[${index}].versionCode`, MAX_VERSION_CODE),
      manifestSha256: requiredSha256(entry.manifestSha256, `release history[${index}].manifestSha256`),
    });
  });
  for (let index = 1; index < releases.length; index += 1) {
    if (
      compareInstallVersions(releases[index].version, releases[index - 1].version) !== 1 ||
      releases[index].versionCode <= releases[index - 1].versionCode
    ) {
      fail("version-regression", "release history is not strictly monotonic");
    }
  }
  return Object.freeze({ schemaVersion: 1, releases: Object.freeze(releases) });
}

function assertAntiEquivocation(manifest, manifestSha256, historyValue) {
  const versionCode = manifest.artifacts[0].versionCode;
  const entry = Object.freeze({
    releaseId: manifest.releaseId,
    version: manifest.version,
    versionCode,
    manifestSha256,
  });
  if (historyValue === undefined || historyValue === null) return entry;
  const history = parsePinReleaseHistory(historyValue);
  const existingIndex = history.releases.findIndex((release) => release.releaseId === manifest.releaseId);
  if (existingIndex >= 0) {
    const existing = history.releases[existingIndex];
    if (
      existing.manifestSha256 !== manifestSha256 ||
      existing.version !== manifest.version ||
      existing.versionCode !== versionCode
    ) {
      fail("release-equivocation", "release history tuple changed while retaining the same releaseId");
    }
    if (existingIndex !== history.releases.length - 1) {
      fail("version-regression", "an older accepted release cannot become current again");
    }
    return existing;
  }
  const previous = history.releases.at(-1);
  if (
    previous &&
    (compareInstallVersions(manifest.version, previous.version) !== 1 || versionCode <= previous.versionCode)
  ) {
    fail("version-regression", "release version and versionCode must both increase monotonically");
  }
  return entry;
}

function compareReceiptToManifest(receipt, artifact, version, expectedSigner) {
  for (const field of ["role", "name", "package", "versionCode", "size", "sha256"]) {
    if (receipt[field] !== artifact[field]) fail("receipt-mismatch", `${artifact.role} receipt ${field} does not match manifest`);
  }
  if (receipt.versionName !== version) fail("version-mismatch", `${artifact.role} APK versionName does not match manifest version`);
  if (receipt.signerSha256 !== expectedSigner) fail("signer-mismatch", `${artifact.role} receipt signer is not approved`);
}

export function verifyPinReleaseMetadata({ manifest: manifestValue, receipts: receiptValue, expectedSigner, history }) {
  const manifest = parsePinReleaseManifest(manifestValue);
  const receipts = parsePinReleaseReceiptBundle(receiptValue);
  const signerSha256 = requiredSha256(expectedSigner, "expected signer fingerprint");
  for (const role of PIN_RELEASE_ARTIFACT_ROLES) {
    compareReceiptToManifest(
      receipts.artifacts.find((artifact) => artifact.role === role),
      manifest.artifacts.find((artifact) => artifact.role === role),
      manifest.version,
      signerSha256,
    );
  }
  const manifestSha256 = sha256(canonicalPinReleaseManifestJson(manifest));
  const historyEntry = assertAntiEquivocation(manifest, manifestSha256, history);
  return Object.freeze({ manifest, receipts, signerSha256, manifestSha256, historyEntry });
}
