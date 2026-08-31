import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const IMAGE_NAMES = Object.freeze([
  "center",
  "center-iroh-bridge",
  "cosmos",
  "keycloak",
  "spotify-adapter",
]);
export const IMAGE_PLATFORMS = Object.freeze(["linux/amd64", "linux/arm64"]);

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const REGISTRY_PATH = /^ghcr\.io\/[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PIN_VERSION = /^\d{4}-\d{2}-\d{2}\.\d+$/u;

function exactFields(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    throw new Error(`${label} contains missing or unexpected fields`);
  }
}

function required(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function immutableReference(value, digest, label, { oci = false } = {}) {
  const prefix = oci ? "oci://" : "";
  if (typeof value !== "string" || !value.startsWith(prefix)) throw new Error(`${label} is invalid`);
  const reference = value.slice(prefix.length);
  const suffix = `@${digest}`;
  if (!reference.endsWith(suffix) || !REGISTRY_PATH.test(reference.slice(0, -suffix.length))) {
    throw new Error(`${label} must be a digest-pinned GHCR reference`);
  }
  return value;
}

export function validateImageReceipt(value, expectedName = null) {
  exactFields(value, ["schemaVersion", "name", "reference", "digest", "platforms"], "image receipt");
  if (value.schemaVersion !== 2) throw new Error("image receipt schemaVersion must be 2");
  if (!IMAGE_NAMES.includes(value.name) || (expectedName !== null && value.name !== expectedName)) {
    throw new Error(`unexpected image receipt name: ${value.name}`);
  }
  required(value.digest, DIGEST, `${value.name} digest`);
  immutableReference(value.reference, value.digest, `${value.name} reference`);
  if (!value.reference.endsWith(`/${value.name}@${value.digest}`)) {
    throw new Error(`${value.name} reference must use the matching image repository`);
  }
  if (!Array.isArray(value.platforms) ||
      value.platforms.length !== IMAGE_PLATFORMS.length ||
      value.platforms.some((platform, index) => platform !== IMAGE_PLATFORMS[index])) {
    throw new Error(`${value.name} platforms must be linux/amd64 and linux/arm64`);
  }
  return Object.freeze({ ...value, platforms: Object.freeze([...value.platforms]) });
}

export function validateApplicationReceipt(value) {
  exactFields(value, ["schemaVersion", "reference", "digest"], "application receipt");
  if (value.schemaVersion !== 1) throw new Error("application receipt schemaVersion must be 1");
  required(value.digest, DIGEST, "application digest");
  immutableReference(value.reference, value.digest, "application reference", { oci: true });
  if (!value.reference.endsWith(`/application@${value.digest}`)) {
    throw new Error("application reference must use the application repository");
  }
  return Object.freeze({ ...value });
}

export async function loadImageReceipts(directory) {
  const images = {};
  for (const name of IMAGE_NAMES) {
    const value = JSON.parse(await readFile(join(directory, `${name}.json`), "utf8"));
    images[name] = validateImageReceipt(value, name);
  }
  const names = Object.keys(images).sort();
  if (names.length !== IMAGE_NAMES.length || names.some((name, index) => name !== IMAGE_NAMES[index])) {
    throw new Error("release inputs must contain the exact image set");
  }
  return Object.freeze(images);
}

export async function loadReleaseInputs(directory) {
  const images = await loadImageReceipts(directory);
  const application = validateApplicationReceipt(
    JSON.parse(await readFile(join(directory, "application.json"), "utf8")),
  );
  return Object.freeze({ application, images });
}

export function validatePinPayload(value) {
  exactFields(value, [
    "schemaVersion",
    "archive",
    "sha256",
    "size",
    "releaseId",
    "version",
    "versionCode",
    "signerSha256",
    "manifestSha256",
    "receiptsSha256",
  ], "Pin payload");
  if (value.schemaVersion !== 1) throw new Error("Pin payload schemaVersion must be 1");
  required(value.version, PIN_VERSION, "Pin release version");
  if (value.archive !== `ai-pin-revival-pin-${value.version}.tar.gz`) {
    throw new Error("Pin archive name does not match its internal release version");
  }
  for (const field of ["sha256", "releaseId", "signerSha256", "manifestSha256", "receiptsSha256"]) {
    required(value[field], SHA256, `Pin ${field}`);
  }
  if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > 3 * 1024 * 1024 * 1024) {
    throw new Error("Pin archive size is invalid");
  }
  if (!Number.isSafeInteger(value.versionCode) || value.versionCode < 1 || value.versionCode > 2_147_483_647) {
    throw new Error("Pin versionCode is invalid");
  }
  return Object.freeze({ ...value });
}

export function createReleaseDescriptor({
  version,
  revision,
  repository,
  tag,
  application,
  images,
  operator,
  pin,
}) {
  required(version, VERSION, "release version");
  required(revision, REVISION, "release revision");
  required(repository, REPOSITORY, "source repository");
  if (tag !== `v${version}`) throw new Error("source tag must exactly match vVERSION");
  validateApplicationReceipt(application);
  const normalizedImages = {};
  exactFields(images, IMAGE_NAMES, "release images");
  for (const name of IMAGE_NAMES) normalizedImages[name] = validateImageReceipt(images[name], name);
  exactFields(operator, ["archive", "sha256", "size"], "operator payload");
  if (operator.archive !== `ai-pin-revival-operator-${version}-linux.tar.gz`) {
    throw new Error("operator archive name does not match the release version");
  }
  required(operator.sha256, /^[0-9a-f]{64}$/u, "operator archive sha256");
  if (!Number.isSafeInteger(operator.size) || operator.size < 1 || operator.size > 2 * 1024 * 1024 * 1024) {
    throw new Error("operator archive size is invalid");
  }
  const normalizedPin = validatePinPayload(pin);
  return Object.freeze({
    schemaVersion: 3,
    product: "Ai Pin Revival",
    version,
    revision,
    source: Object.freeze({ repository, tag }),
    platforms: IMAGE_PLATFORMS,
    application,
    images: Object.freeze(normalizedImages),
    operator: Object.freeze({ ...operator }),
    pin: normalizedPin,
  });
}

export function validateReleaseDescriptor(value) {
  exactFields(value, [
    "schemaVersion",
    "product",
    "version",
    "revision",
    "source",
    "platforms",
    "application",
    "images",
    "operator",
    "pin",
  ], "release descriptor");
  if (value.schemaVersion !== 3) throw new Error("release descriptor schemaVersion must be 3");
  if (value.product !== "Ai Pin Revival") throw new Error("release descriptor product is invalid");
  exactFields(value.source, ["repository", "tag"], "release source");
  if (!Array.isArray(value.platforms) ||
      value.platforms.length !== IMAGE_PLATFORMS.length ||
      value.platforms.some((platform, index) => platform !== IMAGE_PLATFORMS[index])) {
    throw new Error("release descriptor platforms must be linux/amd64 and linux/arm64");
  }
  return createReleaseDescriptor({
    version: value.version,
    revision: value.revision,
    repository: value.source.repository,
    tag: value.source.tag,
    application: value.application,
    images: value.images,
    operator: value.operator,
    pin: value.pin,
  });
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
