#!/usr/bin/env node

import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import rootedSource from "../cli/rooted-source.js";

const {
  readStableRootedEntries,
} = rootedSource;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(SCRIPT_PATH), "../..");
const DEFAULT_CONFIG = join(DEFAULT_ROOT, "platform", "deploy", "release.json");
const MANIFEST_SCHEMA_VERSION = 1;
const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXTRACTED_ARCHIVE_BYTES = 1024 * 1024 * 1024;

export const HIGH_CONFIDENCE_SECRET_PATTERNS = Object.freeze([
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["GitHub access token", /gh[pousr]_[A-Za-z0-9]{30,}/],
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["OpenAI project key", /sk-proj-[A-Za-z0-9_-]{40,}/],
  ["Slack access token", /xox[baprs]-[A-Za-z0-9-]{20,}/],
  ["Azure Storage account key", /AccountKey=[A-Za-z0-9+/=]{32,}/],
  [
    "private key material",
    /-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{32,}-----END (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ],
]);

// Reviewed server paths are part of the release contract, not build-host
// residue. Keep this list narrow: exact entries do not allow descendants, and
// directory entries require either the exact root or a slash boundary. In
// particular, approving the deployment account's home as an exact filesystem
// probe does not approve arbitrary ~/.ssh, checkout, or secret paths.
export const APPROVED_CANONICAL_PRODUCTION_PATHS = Object.freeze([
  Object.freeze({ path: "/home/anders/ai-pin-revival", descendants: true }),
  Object.freeze({ path: "/home/anders/carry-center-data", descendants: true }),
  Object.freeze({ path: "/home/anders/humane-carry-clone", descendants: true }),
  Object.freeze({ path: "/home/anders/carry-backends.env", descendants: false }),
  Object.freeze({ path: "/home/anders/carry-center.env", descendants: false }),
  Object.freeze({ path: "/home/anders/carry-edge", descendants: true }),
  Object.freeze({ path: "/home/anders/carry-attest", descendants: true }),
  Object.freeze({ path: "/home/anders/carry-duc", descendants: true }),
  Object.freeze({ path: "/home/anders/keycloak-themes/humane", descendants: true }),
  Object.freeze({ path: "/home/anders/.cloudflared", descendants: false }),
  Object.freeze({ path: "/home/anders/.cloudflared/config.yml", descendants: false }),
  Object.freeze({ path: "/home/anders", descendants: false }),
]);
const POLICY_SLASH = String.fromCodePoint(47);
const APPROVED_CANONICAL_PRODUCTION_PATH_PATTERNS = Object.freeze([
  new RegExp(
    ["^", "home", "anders", "\\.cloudflared", "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.json$"]
      .join(String.fromCodePoint(92, 47)),
    "u",
  ),
]);
const CANONICAL_PRODUCTION_HOME = "/home/anders";
const NORMALIZED_PATH_WINDOW_BYTES = 16384;
const NORMALIZED_PATH_WINDOW_OVERLAP = 2048;
const MAX_MACHINE_PATH_BYTES = 1024;
const MAX_NORMALIZATION_PASSES = 16;
const MAX_STATIC_CONNECTOR_BYTES = 2048;
const MAX_EMBEDDED_DER_BYTES = 1024 * 1024;
const MAX_EMBEDDED_DER_CANDIDATES = 8192;
const TRUNCATED_POLICY_SEGMENT = "\u0002";
const STATIC_APPEND_POLICY_SEGMENT = "\u0003";
const LEGACY_ENCRYPTED_PRIVATE_KEY_OIDS = new Set([
  // PKCS#5 PBES1 password-based encryption schemes. PBKDF2 (.12) is a
  // key-derivation function, not a valid top-level EncryptedPrivateKeyInfo
  // algorithm, and deliberately does not appear here.
  "1.2.840.113549.1.5.1",
  "1.2.840.113549.1.5.3",
  "1.2.840.113549.1.5.4",
  "1.2.840.113549.1.5.6",
  "1.2.840.113549.1.5.10",
  "1.2.840.113549.1.5.11",
]);
const PBES2_OID = "1.2.840.113549.1.5.13";
const PBKDF2_OID = "1.2.840.113549.1.5.12";
const SCRYPT_OID = "1.3.6.1.4.1.11591.4.11";
const PBKDF2_PRF_OIDS = new Set([
  "1.2.840.113549.2.7", // HMAC-SHA1 (the PBKDF2 default)
  "1.2.840.113549.2.8", // HMAC-SHA224
  "1.2.840.113549.2.9", // HMAC-SHA256
  "1.2.840.113549.2.10", // HMAC-SHA384
  "1.2.840.113549.2.11", // HMAC-SHA512
]);
const PBES2_CIPHERS = new Map([
  ["1.2.840.113549.3.7", Object.freeze({ parameter: "iv", ivBytes: 8, blockBytes: 8 })],
  ["2.16.840.1.101.3.4.1.2", Object.freeze({ parameter: "iv", ivBytes: 16, blockBytes: 16 })],
  ["2.16.840.1.101.3.4.1.22", Object.freeze({ parameter: "iv", ivBytes: 16, blockBytes: 16 })],
  ["2.16.840.1.101.3.4.1.42", Object.freeze({ parameter: "iv", ivBytes: 16, blockBytes: 16 })],
  ["2.16.840.1.101.3.4.1.6", Object.freeze({ parameter: "gcm" })],
  ["2.16.840.1.101.3.4.1.26", Object.freeze({ parameter: "gcm" })],
  ["2.16.840.1.101.3.4.1.46", Object.freeze({ parameter: "gcm" })],
]);
// `.git` is repository structure, not source. No other directory is exempt:
// tracked diagrams and any future .claude/.gstack source are scanned exactly
// like application code.
const SOURCE_POLICY_EXCLUDED_ROOT_DIRECTORIES = new Set([".git"]);
// These two ignored, harness-injected safety documents contain two deliberate
// historical path literals. Approval is bound to the exact file AND exact
// literal; every other byte (including a newly injected token or key) remains
// under the ordinary source policy.
const REVIEWED_SOURCE_POLICY_PATH_LITERALS = new Map([
  ["AGENTS.md", Object.freeze([
    ["", "Users", "andersmadsen", "Desktop", "Ai Pin Revival"].join(POLICY_SLASH),
    ["", "home", "anders", "carry-cent*"].join(POLICY_SLASH),
  ])],
  ["CLAUDE.md", Object.freeze([
    ["", "Users", "andersmadsen", "Desktop", "Ai Pin Revival"].join(POLICY_SLASH),
    ["", "home", "anders", "carry-cent*"].join(POLICY_SLASH),
  ])],
]);
const LIVE_KEY_SNAPSHOT_BASENAME_PATTERNS = Object.freeze([
  /^\.cosmos-channel-key\.json(?:\..+)?$/iu,
  /^channel-key\.json(?:\..+)?$/iu,
  /^(?:[a-z0-9._-]+-)?key[-_]?material\.json(?:\..+)?$/iu,
  /^\.?(?:cosmos[._-])?(?:channel[._-](?:key|keys|store)|wearer[._-]channel|(?:[a-z0-9._-]+[._-])?key[._-]?material)\.json(?:[._-].+)?$/iu,
]);

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function toPosixPath(value) {
  return value.split(sep).join("/");
}

function pathIsWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function validateRelativePath(value, label = "path") {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  if (value.includes("\\") || value.includes("\0") || isAbsolute(value)) {
    fail(`${label} must be a portable relative path: ${JSON.stringify(value)}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    fail(`${label} contains an unsafe path segment: ${JSON.stringify(value)}`);
  }
  return value;
}

function releasePathIsWithin(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

async function optionalLstat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function optionalBigIntLstat(path) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readStableSourceFile(sourceRoot, sourcePath, releasePath, expectedRoot = null) {
  const canonicalRoot = resolve(sourceRoot);
  const absolutePath = resolve(sourcePath);
  if (!pathIsWithin(canonicalRoot, absolutePath)) {
    fail(`release source config escapes the source root: ${sourcePath}`);
  }
  const rootedPath = toPosixPath(relative(canonicalRoot, absolutePath));
  validateRelativePath(rootedPath, "release source config path");
  const stable = readStableRootedEntries(
    canonicalRoot,
    [rootedPath],
    "release source",
    { expectedRoot },
  ).entries[0];
  if (!stable || stable.kind !== "file") {
    fail(`release source config is not a regular file: ${sourcePath}`);
  }
  return { ...stable, receipt: { ...stable.receipt, path: releasePath } };
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`${label} must be an array of strings`);
  }
  return value;
}

function validateReleaseConfig(config) {
  if (config?.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail(`unsupported release source schema: ${String(config?.schemaVersion)}`);
  }
  if (!config.profiles || typeof config.profiles !== "object") {
    fail("release source config must define profiles");
  }
  for (const [profileName, profile] of Object.entries(config.profiles)) {
    assertStringArray(profile?.include, `profiles.${profileName}.include`);
    assertStringArray(profile?.exclude ?? [], `profiles.${profileName}.exclude`);
    for (const includedPath of profile.include) {
      validateRelativePath(includedPath, `profiles.${profileName}.include entry`);
    }
    for (const excludedPath of profile.exclude ?? []) {
      validateRelativePath(excludedPath, `profiles.${profileName}.exclude entry`);
      if (!profile.include.some((includedPath) => releasePathIsWithin(includedPath, excludedPath))) {
        fail(
          `profiles.${profileName}.exclude entry is not beneath an included path: ${excludedPath}`,
        );
      }
    }
  }
  for (const key of [
    "ignoredDirectoryNames",
    "ignoredFileNames",
    "ignoredExtensions",
    "forbiddenRootDirectories",
    "forbiddenDirectoryNames",
    "forbiddenExtensions",
  ]) {
    assertStringArray(config[key], key);
  }
  return config;
}

async function loadReleaseConfigDocument(
  configPath = DEFAULT_CONFIG,
  sourceRoot = DEFAULT_ROOT,
  expectedRoot = null,
) {
  let config;
  let source;
  try {
    source = await readStableSourceFile(
      sourceRoot,
      configPath,
      toPosixPath(relative(resolve(sourceRoot), resolve(configPath))),
      expectedRoot,
    );
    config = JSON.parse(source.data.toString("utf8"));
  } catch (error) {
    fail(`cannot read release source config ${configPath}: ${error.message}`);
  }

  validateReleaseConfig(config);
  return { config, receipt: source.receipt };
}

export async function loadReleaseConfig(
  configPath = DEFAULT_CONFIG,
  sourceRoot = DEFAULT_ROOT,
  expectedRoot = null,
) {
  return (await loadReleaseConfigDocument(configPath, sourceRoot, expectedRoot)).config;
}

function canonicalManifestPayload(profile, entries) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    profile,
    entries,
  };
}

function manifestReleaseId(profile, entries) {
  return sha256(JSON.stringify(canonicalManifestPayload(profile, entries)));
}

function normalizedMode(stat) {
  return Number(stat.mode) & 0o111 ? "0755" : "0644";
}

function looksLikeText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return !sample.includes(0);
}

function policyText(buffer) {
  if (looksLikeText(buffer)) return buffer.toString("utf8");
  // A NUL must not turn an otherwise ordinary ASCII token, machine path, or
  // credential into an opaque "binary" file. Preserve the complete printable
  // ASCII surface and replace every other byte with a hard policy boundary.
  return buffer.toString("latin1").replace(/[^\x09\x0a\x0d\x20-\x7e]/gu, "\0");
}

function canonicalPolicyName(value) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/^[. ]+|[. ]+$/gu, "");
}

export function isPrivateKeyFileName(fileName) {
  const lowerName = basename(fileName).toLowerCase();
  return /(?:^|[._-])private[._-]?key(?:[._-]|$)/u.test(lowerName) ||
    /(?:^|\.)(?:pk8|pkcs8)(?:\.|$)/u.test(lowerName);
}

function parsesAsPrivateKey(value) {
  if (!Buffer.isBuffer(value) || value.length === 0) return false;
  const root = readDerNode(value);
  if (!root || root.tag !== 0x30 || root.end !== value.length) return false;
  const children = derChildren(value, root);
  if (!children || children.length < 2) return false;
  const integer = (node) => {
    if (node?.tag !== 0x02 || node.contentOffset >= node.end) return null;
    const bytes = value.subarray(node.contentOffset, node.end);
    if ((bytes[0] & 0x80) !== 0 ||
        (bytes.length > 1 && bytes[0] === 0 && (bytes[1] & 0x80) === 0)) return null;
    let number = 0;
    for (const byte of bytes) {
      if (number > Number.MAX_SAFE_INTEGER / 256) return null;
      number = (number * 256) + byte;
    }
    return number;
  };
  const version = integer(children[0]);
  const candidateTypes = [];
  // PrivateKeyInfo / OneAsymmetricKey: version, AlgorithmIdentifier, and a
  // non-empty privateKey OCTET STRING. OpenSSL remains the final authority.
  if ([0, 1].includes(version) && children[1]?.tag === 0x30 &&
      algorithmIdentifier(value, children[1]) && children[2]?.tag === 0x04 &&
      children[2].end > children[2].contentOffset) {
    candidateTypes.push("pkcs8");
  }
  // RSAPrivateKey has version plus eight required INTEGER fields.
  if ([0, 1].includes(version) && children.length >= 9 &&
      children.slice(1, 9).every((node) => node.tag === 0x02)) {
    candidateTypes.push("pkcs1");
  }
  // ECPrivateKey has version 1 and a private-key OCTET STRING.
  if (version === 1 && children[1]?.tag === 0x04 &&
      children[1].end - children[1].contentOffset >= 16) {
    candidateTypes.push("sec1");
  }
  for (const type of candidateTypes) {
    try {
      createPrivateKey({ key: value, format: "der", type });
      return true;
    } catch {
      // Try the next standard DER private-key container.
    }
  }
  return false;
}

function readDerNode(buffer, offset = 0) {
  if (!Buffer.isBuffer(buffer) || offset < 0 || offset + 2 > buffer.length) return null;
  const tag = buffer[offset];
  if ((tag & 0x1f) === 0x1f) return null;
  const firstLength = buffer[offset + 1];
  let length = firstLength;
  let contentOffset = offset + 2;
  if ((firstLength & 0x80) !== 0) {
    const lengthBytes = firstLength & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || contentOffset + lengthBytes > buffer.length) {
      return null;
    }
    if (buffer[contentOffset] === 0) return null;
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = (length * 256) + buffer[contentOffset + index];
    }
    if (length < 128) return null;
    contentOffset += lengthBytes;
  }
  const end = contentOffset + length;
  if (!Number.isSafeInteger(end) || end > buffer.length) return null;
  return { tag, offset, contentOffset, end };
}

function derChildren(buffer, node) {
  const children = [];
  let offset = node.contentOffset;
  while (offset < node.end) {
    const child = readDerNode(buffer, offset);
    if (!child || child.end > node.end) return null;
    children.push(child);
    offset = child.end;
  }
  return offset === node.end ? children : null;
}

function decodeDerOid(buffer, node) {
  if (node?.tag !== 0x06 || node.contentOffset >= node.end) return null;
  const bytes = buffer.subarray(node.contentOffset, node.end);
  const first = bytes[0];
  const values = [Math.min(2, Math.floor(first / 40)), first % 40];
  let value = 0;
  let open = false;
  for (const byte of bytes.subarray(1)) {
    if (value > Number.MAX_SAFE_INTEGER / 128) return null;
    value = (value * 128) + (byte & 0x7f);
    open = (byte & 0x80) !== 0;
    if (!open) {
      values.push(value);
      value = 0;
    }
  }
  return open ? null : values.join(".");
}

function positiveDerInteger(buffer, node) {
  if (node?.tag !== 0x02 || node.contentOffset >= node.end) return null;
  const bytes = buffer.subarray(node.contentOffset, node.end);
  if ((bytes[0] & 0x80) !== 0 ||
      (bytes.length > 1 && bytes[0] === 0 && (bytes[1] & 0x80) === 0)) {
    return null;
  }
  let value = 0;
  for (const byte of bytes) {
    if (value > Number.MAX_SAFE_INTEGER / 256) return null;
    value = (value * 256) + byte;
  }
  return value > 0 ? value : null;
}

function algorithmIdentifier(buffer, node) {
  if (node?.tag !== 0x30) return null;
  const children = derChildren(buffer, node);
  if (!children || children.length < 1 || children.length > 2) return null;
  const oid = decodeDerOid(buffer, children[0]);
  return oid === null ? null : { oid, parameters: children[1] ?? null };
}

function validPbkdf2Parameters(buffer, node) {
  if (node?.tag !== 0x30) return false;
  const parameters = derChildren(buffer, node);
  if (!parameters || parameters.length < 2 || parameters.length > 4) return false;
  if (parameters[0].tag !== 0x04 ||
      parameters[0].end - parameters[0].contentOffset < 8 ||
      positiveDerInteger(buffer, parameters[1]) === null) {
    return false;
  }
  let cursor = 2;
  if (parameters[cursor]?.tag === 0x02) {
    if (positiveDerInteger(buffer, parameters[cursor]) === null) return false;
    cursor += 1;
  }
  if (cursor === parameters.length) return true;
  const prf = algorithmIdentifier(buffer, parameters[cursor]);
  if (!prf || !PBKDF2_PRF_OIDS.has(prf.oid)) return false;
  return prf.parameters === null ||
    (prf.parameters.tag === 0x05 && prf.parameters.contentOffset === prf.parameters.end);
}

function validScryptParameters(buffer, node) {
  if (node?.tag !== 0x30) return false;
  const parameters = derChildren(buffer, node);
  if (!parameters || parameters.length < 4 || parameters.length > 5 ||
      parameters[0].tag !== 0x04 ||
      parameters[0].end - parameters[0].contentOffset < 8) {
    return false;
  }
  const cost = positiveDerInteger(buffer, parameters[1]);
  const blockSize = positiveDerInteger(buffer, parameters[2]);
  const parallelization = positiveDerInteger(buffer, parameters[3]);
  const keyLength = parameters[4] === undefined ? 1 : positiveDerInteger(buffer, parameters[4]);
  return cost !== null && (cost & (cost - 1)) === 0 && blockSize !== null &&
    parallelization !== null && keyLength !== null;
}

function validPbes2Kdf(buffer, node) {
  const identifier = algorithmIdentifier(buffer, node);
  if (!identifier?.parameters) return false;
  if (identifier.oid === PBKDF2_OID) {
    return validPbkdf2Parameters(buffer, identifier.parameters);
  }
  return identifier.oid === SCRYPT_OID && validScryptParameters(buffer, identifier.parameters);
}

function validPbes2Cipher(buffer, node, ciphertextBytes) {
  const identifier = algorithmIdentifier(buffer, node);
  const cipher = identifier && PBES2_CIPHERS.get(identifier.oid);
  if (!cipher || !identifier.parameters) return false;
  if (cipher.parameter === "iv") {
    return identifier.parameters.tag === 0x04 &&
      identifier.parameters.end - identifier.parameters.contentOffset === cipher.ivBytes &&
      ciphertextBytes % cipher.blockBytes === 0;
  }
  if (identifier.parameters.tag !== 0x30 || ciphertextBytes < 16) return false;
  const gcm = derChildren(buffer, identifier.parameters);
  if (!gcm || gcm.length < 1 || gcm.length > 2 || gcm[0].tag !== 0x04) return false;
  const nonceBytes = gcm[0].end - gcm[0].contentOffset;
  return nonceBytes >= 8 && nonceBytes <= 32 &&
    (gcm[1] === undefined || positiveDerInteger(buffer, gcm[1]) !== null);
}

/** Strict structural recognition of PKCS#8 EncryptedPrivateKeyInfo DER. */
export function isEncryptedPkcs8Der(value) {
  if (!Buffer.isBuffer(value) || value.length < 32) return false;
  const root = readDerNode(value);
  if (!root || root.tag !== 0x30 || root.end !== value.length) return false;
  const children = derChildren(value, root);
  if (!children || children.length !== 2 || children[0].tag !== 0x30 ||
      children[1].tag !== 0x04 || children[1].end - children[1].contentOffset < 16) {
    return false;
  }
  const algorithm = derChildren(value, children[0]);
  if (!algorithm || algorithm.length !== 2 || algorithm[1].tag !== 0x30) return false;
  const oid = decodeDerOid(value, algorithm[0]);
  const parameters = derChildren(value, algorithm[1]);
  if (!parameters) return false;
  if (oid === PBES2_OID) {
    if (parameters.length !== 2 || parameters.some((node) => node.tag !== 0x30)) return false;
    const ciphertextBytes = children[1].end - children[1].contentOffset;
    return validPbes2Kdf(value, parameters[0]) &&
      validPbes2Cipher(value, parameters[1], ciphertextBytes);
  }
  // PBES1 and PKCS#12 PBE parameters are salt OCTET STRING + iteration INTEGER.
  const legacyPbe = LEGACY_ENCRYPTED_PRIVATE_KEY_OIDS.has(oid) ||
    (typeof oid === "string" && oid.startsWith("1.2.840.113549.1.12.1."));
  const ciphertextBytes = children[1].end - children[1].contentOffset;
  return legacyPbe && parameters.length === 2 && parameters[0].tag === 0x04 &&
    parameters[0].end - parameters[0].contentOffset >= 8 &&
    positiveDerInteger(value, parameters[1]) !== null && ciphertextBytes % 8 === 0;
}

function parsesAsPrivateKeyDer(value) {
  return parsesAsPrivateKey(value) || isEncryptedPkcs8Der(value);
}

function containsPrivateJwk(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  if (!Array.isArray(value) && typeof value.kty === "string" &&
      typeof value.d === "string" && value.d.length > 0) {
    try {
      createPrivateKey({ key: value, format: "jwk" });
      return true;
    } catch {
      // Not a complete standard private JWK; continue into nested values.
    }
  }
  return Object.values(value).some((child) => containsPrivateJwk(child, depth + 1));
}

function matchingTemplateExpressionEnd(text, openBrace) {
  let depth = 1;
  let quote = null;
  for (let cursor = openBrace + 1; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (quote !== null) {
      if (character === "\\") cursor += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (["\"", "'", "`"].includes(character)) quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

function staticStringAt(text, start, stringBindings = new Map()) {
  let cursor = start;
  while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
  const quote = text[cursor];
  if (!["\"", "'", "`"].includes(quote)) return null;
  const quoteStart = cursor;
  cursor += 1;
  let value = "";
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === quote) return { value, quote, start: quoteStart, end: cursor + 1 };
    if (quote === "`" && character === "$" && text[cursor + 1] === "{") {
      const close = matchingTemplateExpressionEnd(text, cursor + 1);
      if (close === -1) return null;
      const expression = text.slice(cursor + 2, close);
      const interpolation = staticExpressionValue(expression, stringBindings);
      // Unknown interpolation remains a hard boundary; fully static literal
      // or previously-bound interpolation is folded into the policy value.
      value += interpolation === null ? "\0" : interpolation;
      cursor = close + 1;
      continue;
    }
    if (character === "\\") {
      const next = text[cursor + 1];
      if (next === "\n") {
        cursor += 2;
        continue;
      }
      if (next === "\r" && text[cursor + 2] === "\n") {
        cursor += 3;
        continue;
      }
      if (next === quote || next === "\\" || next === "/") {
        value += next;
        cursor += 2;
        continue;
      }
      const hex = text.slice(cursor + 2, cursor + 4);
      if (next?.toLowerCase() === "x" && /^[0-9a-f]{2}$/iu.test(hex)) {
        value += String.fromCodePoint(Number.parseInt(hex, 16));
        cursor += 4;
        continue;
      }
      const unicode = text.slice(cursor + 2, cursor + 6);
      if (next?.toLowerCase() === "u" && /^[0-9a-f]{4}$/iu.test(unicode)) {
        value += String.fromCodePoint(Number.parseInt(unicode, 16));
        cursor += 6;
        continue;
      }
      if (next?.toLowerCase() === "u" && text[cursor + 2] === "{") {
        const close = text.indexOf("}", cursor + 3);
        const codePoint = close === -1 ? "" : text.slice(cursor + 3, close);
        if (/^[0-9a-f]{1,6}$/iu.test(codePoint) && Number.parseInt(codePoint, 16) <= 0x10ffff) {
          value += String.fromCodePoint(Number.parseInt(codePoint, 16));
          cursor = close + 1;
          continue;
        }
      }
      const octal = /^(?:[0-7]{1,3})/u.exec(text.slice(cursor + 1))?.[0] ?? "";
      if (octal.length > 0) {
        value += String.fromCodePoint(Number.parseInt(octal, 8));
        cursor += 1 + octal.length;
        continue;
      }
      const simple = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" };
      if (Object.hasOwn(simple, next)) {
        value += simple[next];
        cursor += 2;
        continue;
      }
      // Keep an unknown escape's slash. That is conservative for generic
      // Windows paths and avoids silently erasing a policy boundary.
      value += `\\${next ?? ""}`;
      cursor += next === undefined ? 1 : 2;
      continue;
    }
    value += character;
    cursor += 1;
  }
  return null;
}

function staticStringExpressionAt(text, start) {
  const first = staticStringAt(text, start);
  if (!first) return null;
  let value = first.value;
  let end = first.end;
  let parts = 1;
  while (parts < 1024) {
    let cursor = end;
    while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
    if (text[cursor] !== "+") break;
    cursor += 1;
    const next = staticStringAt(text, cursor);
    if (!next) break;
    value += next.value;
    end = next.end;
    parts += 1;
  }
  return { value, end, parts };
}

function literalPrefixStart(text, quoteStart) {
  const prefix = text.slice(Math.max(0, quoteStart - 20), quoteStart);
  const match = /(?:\$|(?:br|rb|r|b)#{0,16})$/u.exec(prefix);
  return match ? quoteStart - match[0].length : quoteStart;
}

function scanStaticLiterals(text, stringBindings = new Map()) {
  const literals = [];
  const quotePattern = /["'`]/gu;
  let match;
  while ((match = quotePattern.exec(text)) !== null) {
    const parsed = staticStringAt(text, match.index, stringBindings);
    if (!parsed) continue;
    literals.push({
      ...parsed,
      start: literalPrefixStart(text, parsed.start),
      quoteStart: parsed.start,
    });
    quotePattern.lastIndex = parsed.end;
  }
  return literals;
}

function foldComments(text) {
  let folded = text;
  if (folded.includes("/*")) folded = folded.replace(/\/\*[\s\S]*?\*\//gu, "");
  if (folded.includes("//")) folded = folded.replace(/\/\/[^\r\n]*/gu, "");
  if (folded.includes("#")) folded = folded.replace(/(^|[\r\n])[\t ]*#[^\r\n]*/gu, "$1");
  return folded;
}

function maskComments(text) {
  let masked = text;
  if (masked.includes("/*")) {
    masked = masked.replace(
      /\/\*[\s\S]*?\*\//gu,
      (comment) => comment.replace(/[^\r\n]/g, " "),
    );
  }
  if (masked.includes("//")) {
    masked = masked.replace(/\/\/[^\r\n]*/gu, (comment) => " ".repeat(comment.length));
  }
  if (masked.includes("#")) {
    masked = masked.replace(/(^|[\r\n])([\t ]*)#[^\r\n]*/gu, (comment, newline) =>
      `${newline}${" ".repeat(comment.length - newline.length)}`);
  }
  return masked;
}

function compactStaticConnector(text) {
  if (text.length > MAX_STATIC_CONNECTOR_BYTES) return null;
  return foldComments(text)
    .replace(/\\\r?\n/gu, "")
    .replace(/\s+/gu, "");
}

function staticConnector(text, left, right) {
  const compact = compactStaticConnector(text);
  if (compact === null) return null;
  if (compact === "+") return "";
  if ((compact === "" || /^\$+$/u.test(compact)) &&
      left.quote !== "`" && right.quote !== "`") {
    return "";
  }
  if (/^\+(?:(?:path\.)?sep|File\.separator|(?:std::path::)?MAIN_SEPARATOR)\+$/u.test(compact)) {
    return "/";
  }
  if (/^\)\.(?:join|resolve)\($/u.test(compact)) return "/";
  return null;
}

function maskStaticLiterals(text, literals) {
  if (literals.length === 0) return text;
  const maskRange = (start, end) => {
    const pieces = [];
    let cursor = start;
    while (cursor < end) {
      const lineFeed = text.indexOf("\n", cursor);
      const carriageReturn = text.indexOf("\r", cursor);
      let newline = -1;
      if (lineFeed !== -1 && lineFeed < end) newline = lineFeed;
      if (carriageReturn !== -1 && carriageReturn < end &&
          (newline === -1 || carriageReturn < newline)) {
        newline = carriageReturn;
      }
      if (newline === -1) {
        pieces.push(" ".repeat(end - cursor));
        break;
      }
      pieces.push(" ".repeat(newline - cursor));
      if (text[newline] === "\r" && text[newline + 1] === "\n" && newline + 1 < end) {
        pieces.push("\r\n");
        cursor = newline + 2;
      } else {
        pieces.push(text[newline]);
        cursor = newline + 1;
      }
    }
    return pieces.join("");
  };
  const chunks = [];
  let cursor = 0;
  for (const literal of literals) {
    chunks.push(text.slice(cursor, literal.start));
    // Nearly every source literal is single-line. `String#replace` with a
    // Unicode regexp was one of the dominant whole-tree costs, while a plain
    // repeated-space mask preserves the exact offsets just as well.
    chunks.push(maskRange(literal.start, literal.end));
    cursor = literal.end;
  }
  chunks.push(text.slice(cursor));
  return chunks.join("");
}

// The source policy deliberately uses a small, non-executing evaluator rather
// than JavaScript's parser/runtime.  Besides keeping shell, Rust, Java, and
// Kotlin source on equal footing, this makes every accepted operation an
// explicit allowlist entry.  Limits are per normalized source window.
const STATIC_EVALUATOR_LIMITS = Object.freeze({
  sourceBytes: 64 * 1024,
  tokens: 16000,
  bindings: 1024,
  candidates: 1024,
  expressionDepth: 32,
  outputBytes: 16 * 1024,
  arrayMembers: 2048,
  // Lexer, function-scope map, ambiguous-scope map, and ordered evaluation.
  passes: 4,
});
const STATIC_UNKNOWN = Symbol("static-unknown");
const STATIC_TOKEN_MATCH_CACHE = new WeakMap();

function staticEvaluatorLimit(kind) {
  fail(`source static evaluator ${kind} limit exceeded`);
}

function consumeStaticEvaluatorPass(budget) {
  budget.passes += 1;
  if (budget.passes > STATIC_EVALUATOR_LIMITS.passes) staticEvaluatorLimit("pass");
}

function addStaticToken(tokens, token) {
  if (tokens.length >= STATIC_EVALUATOR_LIMITS.tokens) staticEvaluatorLimit("token");
  tokens.push(token);
}

function rawStaticStringAt(text, start) {
  const rawPrefix = /(?:br|rb|r|b)(#{0,16})"/yu;
  rawPrefix.lastIndex = start;
  const raw = rawPrefix.exec(text);
  if (!raw) return null;
  const prefix = raw[0];
  const hashes = raw[1];
  const bodyStart = start + prefix.length;
  const terminator = `"${hashes}`;
  const end = text.indexOf(terminator, bodyStart);
  if (end === -1) return null;
  return {
    start,
    end: end + terminator.length,
    quote: "raw",
    value: text.slice(bodyStart, end),
  };
}

function tripleStaticStringAt(text, start) {
  if (!text.startsWith('\"\"\"', start)) return null;
  const end = text.indexOf('\"\"\"', start + 3);
  if (end === -1) return null;
  return { start, end: end + 3, quote: "triple", value: text.slice(start + 3, end) };
}

/** Tokenize only syntax needed by the static allowlist. Comments never run. */
function staticEvaluatorTokens(text) {
  if (Buffer.byteLength(text, "utf8") > STATIC_EVALUATOR_LIMITS.sourceBytes) {
    staticEvaluatorLimit("source byte");
  }
  const tokens = [];
  let cursor = 0;
  let lineHasCode = false;
  const operators = [
    "===", "!==", "??=", "&&=", "||=", "**=", "<<=", ">>=", "=>", "?.", "::",
    "++", "--", "+=", "-=", "*=", "/=", "==", "!=", "<=", ">=", "&&", "||", "??",
  ];
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === "\\" && (text[cursor + 1] === "\n" ||
        (text[cursor + 1] === "\r" && text[cursor + 2] === "\n"))) {
      cursor += text[cursor + 1] === "\r" ? 3 : 2;
      continue;
    }
    if (character === "\r" || character === "\n") {
      const end = character === "\r" && text[cursor + 1] === "\n" ? cursor + 2 : cursor + 1;
      addStaticToken(tokens, { kind: "newline", value: "\n", start: cursor, end });
      cursor = end;
      lineHasCode = false;
      continue;
    }
    if (/\s/u.test(character)) {
      cursor += 1;
      continue;
    }
    if (text.startsWith("//", cursor)) {
      const end = text.indexOf("\n", cursor + 2);
      cursor = end === -1 ? text.length : end;
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      const end = text.indexOf("*/", cursor + 2);
      const commentEnd = end === -1 ? text.length : end + 2;
      for (let index = cursor; index < commentEnd; index += 1) {
        if (text[index] === "\n") {
          addStaticToken(tokens, { kind: "newline", value: "\n", start: index, end: index + 1 });
          lineHasCode = false;
        }
      }
      cursor = commentEnd;
      continue;
    }
    if (character === "#" && !lineHasCode) {
      const end = text.indexOf("\n", cursor + 1);
      cursor = end === -1 ? text.length : end;
      continue;
    }
    const triple = tripleStaticStringAt(text, cursor);
    const raw = triple ?? rawStaticStringAt(text, cursor);
    if (raw) {
      addStaticToken(tokens, { kind: "string", ...raw, raw: text.slice(raw.start, raw.end) });
      cursor = raw.end;
      lineHasCode = true;
      continue;
    }
    if (["\"", "'", "`"].includes(character)) {
      const parsed = staticStringAt(text, cursor);
      if (!parsed) {
        addStaticToken(tokens, { kind: "unknown", value: character, start: cursor, end: cursor + 1 });
        cursor += 1;
      } else {
        addStaticToken(tokens, {
          kind: "string",
          ...parsed,
          raw: text.slice(parsed.start, parsed.end),
        });
        cursor = parsed.end;
      }
      lineHasCode = true;
      continue;
    }
    const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(text.slice(cursor));
    if (identifier) {
      addStaticToken(tokens, {
        kind: "identifier",
        value: identifier[0],
        start: cursor,
        end: cursor + identifier[0].length,
      });
      cursor += identifier[0].length;
      lineHasCode = true;
      continue;
    }
    const number = /^(?:0x[0-9a-f](?:_?[0-9a-f])*|\d(?:_?\d)*)/iu.exec(text.slice(cursor));
    if (number) {
      addStaticToken(tokens, {
        kind: "number",
        value: number[0],
        start: cursor,
        end: cursor + number[0].length,
      });
      cursor += number[0].length;
      lineHasCode = true;
      continue;
    }
    const operator = operators.find((candidate) => text.startsWith(candidate, cursor));
    const value = operator ?? character;
    addStaticToken(tokens, {
      kind: "punctuation",
      value,
      start: cursor,
      end: cursor + value.length,
    });
    cursor += value.length;
    lineHasCode = true;
  }
  return tokens;
}

function staticBuiltin(name) {
  return { kind: "builtin", name };
}

function staticCallable(name, receiver = null) {
  return { kind: "callable", name, receiver };
}

function staticPathValue(value) {
  return { kind: "path", value };
}

function staticValueText(value) {
  if (typeof value === "string") return value;
  return value?.kind === "path" ? value.value : null;
}

function boundedStaticString(value) {
  if (Buffer.byteLength(value, "utf8") > STATIC_EVALUATOR_LIMITS.outputBytes) {
    staticEvaluatorLimit("output byte");
  }
  return value;
}

function recordStaticCandidate(state, value) {
  const candidate = staticValueText(value);
  if (candidate === null) return;
  boundedStaticString(candidate);
  observeStaticCandidate(state, candidate);
  if (state.candidateSet.has(candidate)) return;
  state.candidateSet.add(candidate);
  state.values.push(candidate);
}

function observeStaticCandidate(state, value) {
  const candidate = staticValueText(value);
  if (candidate === null || state.observedSet.has(candidate)) return;
  if (state.observedSet.size >= STATIC_EVALUATOR_LIMITS.candidates) {
    staticEvaluatorLimit("candidate");
  }
  state.observedSet.add(candidate);
}

function recordStaticScopeCandidates(state, scope) {
  for (const value of scope.bindings.values()) recordStaticCandidate(state, value);
}

function markStaticHandledRange(context, tokens, start, end) {
  const first = skipStaticNewlines(tokens, start, end);
  let last = end - 1;
  while (last >= first && tokens[last]?.kind === "newline") last -= 1;
  if (first <= last) {
    context.state.handledRanges.push({ start: tokens[first].start, end: tokens[last].end });
  }
}

function visibleStaticStringBindings(scopes) {
  const visible = new Map();
  for (const scope of scopes) {
    for (const [name, value] of scope.bindings) {
      if (typeof value === "string") visible.set(name, value);
      else visible.delete(name);
    }
  }
  return visible;
}

function lookupStaticBinding(scopes, name) {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    if (scopes[index].bindings.has(name)) {
      return { found: true, value: scopes[index].bindings.get(name), scope: index };
    }
  }
  return { found: false, value: STATIC_UNKNOWN, scope: -1 };
}

function builtinStaticIdentifier(name) {
  if (["path", "Paths", "Path", "File", "os", "std", "String"].includes(name)) {
    return staticBuiltin(name);
  }
  if (["MAIN_SEPARATOR"].includes(name)) return "/";
  return STATIC_UNKNOWN;
}

function staticIdentifierValue(scopes, name) {
  const exact = lookupStaticBinding(scopes, name);
  if (exact.found) return exact.value;
  if (name.startsWith("$") && name.length > 1) {
    const shell = lookupStaticBinding(scopes, name.slice(1));
    if (shell.found) return shell.value;
  }
  return builtinStaticIdentifier(name);
}

function staticPropertyValue(receiver, property) {
  if (receiver === STATIC_UNKNOWN || typeof property !== "string") return STATIC_UNKNOWN;
  if (receiver?.kind === "builtin") {
    const key = `${receiver.name}.${property}`;
    if (key === "path.posix" || key === "os.path" || key === "std.path") {
      return staticBuiltin(key);
    }
    if (["path.sep", "path.posix.sep", "File.separator", "std.path.MAIN_SEPARATOR"].includes(key)) {
      return "/";
    }
    if (["path.join", "path.posix.join", "os.path.join"].includes(key)) {
      return staticCallable("pathJoin");
    }
    if (key === "Paths.get" || key === "Path.of") return staticCallable("pathObject");
    if (key === "String.join") return staticCallable("stringJoin");
    if (key === "String.from") return staticCallable("stringFrom");
    return STATIC_UNKNOWN;
  }
  if (typeof receiver === "string") {
    if (property === "concat") return staticCallable("stringConcat", receiver);
    if (["to_owned", "to_string"].includes(property)) {
      return staticCallable("stringIdentity", receiver);
    }
    return STATIC_UNKNOWN;
  }
  if (Array.isArray(receiver)) {
    if (property === "join") return staticCallable("arrayJoin", receiver);
    if (property === "concat") return staticCallable("arrayConcat", receiver);
    return STATIC_UNKNOWN;
  }
  if (receiver?.kind === "path" && property === "resolve") {
    return staticCallable("pathResolve", receiver);
  }
  return STATIC_UNKNOWN;
}

function staticCallValue(callable, argumentsValues) {
  if (callable === STATIC_UNKNOWN || callable?.kind !== "callable") return STATIC_UNKNOWN;
  if (callable.name === "stringConcat") {
    const values = argumentsValues.map(staticValueText);
    if (values.some((value) => value === null)) return STATIC_UNKNOWN;
    return boundedStaticString(callable.receiver + values.join(""));
  }
  if (callable.name === "stringIdentity") {
    return argumentsValues.length === 0 ? callable.receiver : STATIC_UNKNOWN;
  }
  if (callable.name === "stringFrom") {
    return argumentsValues.length === 1 && typeof argumentsValues[0] === "string"
      ? argumentsValues[0]
      : STATIC_UNKNOWN;
  }
  if (callable.name === "arrayJoin") {
    if (argumentsValues.length > 1) return STATIC_UNKNOWN;
    const separator = argumentsValues.length === 0 ? "," : staticValueText(argumentsValues[0]);
    if (separator === null || callable.receiver.some((value) => typeof value !== "string")) {
      return STATIC_UNKNOWN;
    }
    return boundedStaticString(callable.receiver.join(separator));
  }
  if (callable.name === "arrayConcat") {
    const result = [...callable.receiver];
    for (const argument of argumentsValues) {
      if (Array.isArray(argument)) result.push(...argument);
      else if (typeof argument === "string") result.push(argument);
      else return STATIC_UNKNOWN;
      if (result.length > STATIC_EVALUATOR_LIMITS.arrayMembers) staticEvaluatorLimit("array member");
    }
    return result;
  }
  if (callable.name === "concatMacro") {
    const values = argumentsValues.map(staticValueText);
    if (values.some((value) => value === null)) return STATIC_UNKNOWN;
    return boundedStaticString(values.join(""));
  }
  if (callable.name === "stringJoin") {
    if (argumentsValues.length < 2) return STATIC_UNKNOWN;
    const separator = staticValueText(argumentsValues[0]);
    const values = argumentsValues.slice(1).map(staticValueText);
    if (separator === null || values.some((value) => value === null)) return STATIC_UNKNOWN;
    return boundedStaticString(values.join(separator));
  }
  if (callable.name === "pathJoin" || callable.name === "pathObject") {
    const values = argumentsValues.map(staticValueText);
    if (values.length === 0 || values.some((value) => value === null)) return STATIC_UNKNOWN;
    const joined = boundedStaticString(posix.join(...values));
    return callable.name === "pathObject" ? staticPathValue(joined) : joined;
  }
  if (callable.name === "pathResolve") {
    const values = argumentsValues.map(staticValueText);
    if (values.some((value) => value === null)) return STATIC_UNKNOWN;
    return staticPathValue(boundedStaticString(posix.join(callable.receiver.value, ...values)));
  }
  return STATIC_UNKNOWN;
}

function skipStaticNewlines(tokens, index, end) {
  let cursor = index;
  while (cursor < end && tokens[cursor].kind === "newline") cursor += 1;
  return cursor;
}

function staticTokenMatches(tokens) {
  const cached = STATIC_TOKEN_MATCH_CACHE.get(tokens);
  if (cached) return cached;
  const matches = new Map();
  const stacks = new Map([["(", []], ["[", []], ["{", []], ["<", []]]);
  const openingFor = new Map([[")", "("], ["]", "["], ["}", "{"], [">", "<"]]);
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (stacks.has(value)) {
      stacks.get(value).push(index);
      continue;
    }
    const opening = openingFor.get(value);
    if (!opening || stacks.get(opening).length === 0) continue;
    const open = stacks.get(opening).pop();
    matches.set(open, index);
    matches.set(index, open);
  }
  STATIC_TOKEN_MATCH_CACHE.set(tokens, matches);
  return matches;
}

function matchingStaticToken(tokens, openIndex, opening, closing, end = tokens.length) {
  if (tokens[openIndex]?.value !== opening) return -1;
  const close = staticTokenMatches(tokens).get(openIndex);
  return close !== undefined && close < end && tokens[close]?.value === closing ? close : -1;
}

function staticTemplateTokenValue(token, scopes) {
  if (token.quote !== "`") return token.value;
  const parsed = staticStringAt(token.raw, 0, visibleStaticStringBindings(scopes));
  return parsed && !parsed.value.includes("\0") ? boundedStaticString(parsed.value) : STATIC_UNKNOWN;
}

function parseStaticPrimary(tokens, index, end, context, depth) {
  if (depth > STATIC_EVALUATOR_LIMITS.expressionDepth) staticEvaluatorLimit("expression depth");
  let cursor = skipStaticNewlines(tokens, index, end);
  const token = tokens[cursor];
  if (!token) return { value: STATIC_UNKNOWN, index: cursor };
  if (token.kind === "string") {
    return { value: staticTemplateTokenValue(token, context.scopes), index: cursor + 1 };
  }
  if (token.kind === "identifier") {
    if (token.value === "concat" && tokens[cursor + 1]?.value === "!") {
      return { value: staticCallable("concatMacro"), index: cursor + 2 };
    }
    return { value: staticIdentifierValue(context.scopes, token.value), index: cursor + 1 };
  }
  if (token.value === "&") return parseStaticPrimary(tokens, cursor + 1, end, context, depth + 1);
  if (token.value === "(") {
    const close = matchingStaticToken(tokens, cursor, "(", ")", end);
    if (close === -1) return { value: STATIC_UNKNOWN, index: end };
    const nested = parseStaticExpression(tokens, cursor + 1, close, context, depth + 1);
    return {
      value: skipStaticNewlines(tokens, nested.index, close) === close ? nested.value : STATIC_UNKNOWN,
      index: close + 1,
    };
  }
  if (token.value === "[") {
    const close = matchingStaticToken(tokens, cursor, "[", "]", end);
    if (close === -1) return { value: STATIC_UNKNOWN, index: end };
    const values = [];
    let member = cursor + 1;
    while (skipStaticNewlines(tokens, member, close) < close) {
      if (values.length >= STATIC_EVALUATOR_LIMITS.arrayMembers) staticEvaluatorLimit("array member");
      const parsed = parseStaticExpression(tokens, member, close, context, depth + 1, false);
      if (parsed.index <= member) return { value: STATIC_UNKNOWN, index: close + 1 };
      if (typeof parsed.value !== "string") return { value: STATIC_UNKNOWN, index: close + 1 };
      values.push(parsed.value);
      member = skipStaticNewlines(tokens, parsed.index, close);
      if (member < close && tokens[member].value === ",") member += 1;
      else if (member < close) return { value: STATIC_UNKNOWN, index: close + 1 };
    }
    return { value: values, index: close + 1 };
  }
  if (token.value === "{") {
    const close = matchingStaticToken(tokens, cursor, "{", "}", end);
    if (close === -1) return { value: STATIC_UNKNOWN, index: cursor + 1 };
    const values = new Map();
    for (const part of topLevelStaticTokenParts(tokens, cursor + 1, close, ",")) {
      const keyIndex = skipStaticNewlines(tokens, part.start, part.end);
      if (keyIndex >= part.end) continue;
      const keyToken = tokens[keyIndex];
      const key = keyToken.kind === "identifier" || keyToken.kind === "string"
        ? keyToken.value
        : null;
      let colon = keyIndex + 1;
      while (colon < part.end && tokens[colon].value !== ":") colon += 1;
      if (key === null || colon >= part.end) {
        return { value: STATIC_UNKNOWN, index: close + 1 };
      }
      const member = parseStaticExpression(tokens, colon + 1, part.end, context, depth + 1, false);
      if (skipStaticNewlines(tokens, member.index, part.end) !== part.end) {
        return { value: STATIC_UNKNOWN, index: close + 1 };
      }
      values.set(key, member.value);
      if (values.size > STATIC_EVALUATOR_LIMITS.arrayMembers) staticEvaluatorLimit("array member");
    }
    return { value: { kind: "object", values }, index: close + 1 };
  }
  if (token.value === "<") {
    const close = matchingStaticToken(tokens, cursor, "<", ">", end);
    return { value: STATIC_UNKNOWN, index: close === -1 ? cursor + 1 : close + 1 };
  }
  return { value: STATIC_UNKNOWN, index: cursor + 1 };
}

function parseStaticPostfix(tokens, index, end, context, depth) {
  let parsed = parseStaticPrimary(tokens, index, end, context, depth);
  let value = parsed.value;
  let cursor = parsed.index;
  while (cursor < end) {
    cursor = skipStaticNewlines(tokens, cursor, end);
    const token = tokens[cursor];
    if (!token) break;
    if ([".", "::"].includes(token.value) ||
        (token.value === "?." && tokens[cursor + 1]?.value !== "(" && tokens[cursor + 1]?.value !== "[")) {
      const property = tokens[cursor + 1];
      if (property?.kind !== "identifier") break;
      value = staticPropertyValue(value, property.value);
      cursor += 2;
      continue;
    }
    if (token.value === "[" || (token.value === "?." && tokens[cursor + 1]?.value === "[")) {
      const open = token.value === "[" ? cursor : cursor + 1;
      const close = matchingStaticToken(tokens, open, "[", "]", end);
      if (close === -1) return { value: STATIC_UNKNOWN, index: end };
      const property = parseStaticExpression(tokens, open + 1, close, context, depth + 1);
      value = skipStaticNewlines(tokens, property.index, close) === close
        ? staticPropertyValue(value, staticValueText(property.value))
        : STATIC_UNKNOWN;
      cursor = close + 1;
      continue;
    }
    const optionalCall = token.value === "?." && tokens[cursor + 1]?.value === "(";
    if (token.value === "(" || optionalCall) {
      const open = optionalCall ? cursor + 1 : cursor;
      const close = matchingStaticToken(tokens, open, "(", ")", end);
      if (close === -1) return { value: STATIC_UNKNOWN, index: end };
      const argumentsValues = [];
      let argument = open + 1;
      while (skipStaticNewlines(tokens, argument, close) < close) {
        const argumentValue = parseStaticExpression(tokens, argument, close, context, depth + 1, false);
        if (argumentValue.index <= argument) {
          value = STATIC_UNKNOWN;
          break;
        }
        argumentsValues.push(argumentValue.value);
        argument = skipStaticNewlines(tokens, argumentValue.index, close);
        if (argument < close && tokens[argument].value === ",") argument += 1;
        else if (argument < close) {
          value = STATIC_UNKNOWN;
          break;
        }
      }
      value = staticCallValue(value, argumentsValues);
      recordStaticCandidate(context.state, value);
      cursor = close + 1;
      continue;
    }
    if (token.value === "as" && tokens[cursor + 1]?.value === "const") {
      cursor += 2;
      continue;
    }
    break;
  }
  return { value, index: cursor };
}

function parseStaticAdditive(tokens, index, end, context, depth = 0) {
  let left = parseStaticPostfix(tokens, index, end, context, depth + 1);
  let cursor = left.index;
  while (cursor < end) {
    cursor = skipStaticNewlines(tokens, cursor, end);
    if (tokens[cursor]?.value !== "+") break;
    const right = parseStaticPostfix(tokens, cursor + 1, end, context, depth + 1);
    const leftText = staticValueText(left.value);
    const rightText = staticValueText(right.value);
    left = {
      value: leftText === null || rightText === null
        ? STATIC_UNKNOWN
        : boundedStaticString(leftText + rightText),
      index: right.index,
    };
    if (right.index <= cursor + 1) break;
    cursor = right.index;
  }
  return left;
}

function staticAssignmentTarget(tokens, index, end) {
  const cursor = skipStaticNewlines(tokens, index, end);
  if (tokens[cursor]?.kind === "identifier") {
    const operator = tokens[cursor + 1]?.value;
    if (["=", "+=", "-=", "*=", "/=", "??=", "&&=", "||=", "**=", "<<=", ">>="].includes(operator)) {
      return { kind: "identifier", names: [tokens[cursor].value], operator, equals: cursor + 1 };
    }
  }
  if (tokens[cursor]?.value === "[") {
    const close = matchingStaticToken(tokens, cursor, "[", "]", end);
    if (close !== -1 && tokens[close + 1]?.value === "=") {
      const names = [];
      for (const part of topLevelStaticTokenParts(tokens, cursor + 1, close, ",")) {
        const member = skipStaticNewlines(tokens, part.start, part.end);
        if (member >= part.end) names.push(null);
        else if (tokens[member]?.kind === "identifier" &&
                 skipStaticNewlines(tokens, member + 1, part.end) === part.end) {
          names.push(tokens[member].value);
        } else {
          return null;
        }
      }
      return { kind: "array", names, operator: "=", equals: close + 1 };
    }
  }
  if (tokens[cursor]?.value === "{") {
    const close = matchingStaticToken(tokens, cursor, "{", "}", end);
    if (close !== -1 && tokens[close + 1]?.value === "=") {
      const entries = [];
      for (const part of topLevelStaticTokenParts(tokens, cursor + 1, close, ",")) {
        const keyIndex = skipStaticNewlines(tokens, part.start, part.end);
        if (keyIndex >= part.end) continue;
        const keyToken = tokens[keyIndex];
        const key = keyToken.kind === "identifier" || keyToken.kind === "string"
          ? keyToken.value
          : null;
        let colon = keyIndex + 1;
        while (colon < part.end && tokens[colon].value !== ":") colon += 1;
        const nameToken = colon < part.end ? tokens[colon + 1] : keyToken;
        if (key === null || nameToken?.kind !== "identifier") return null;
        entries.push({ key, name: nameToken.value });
      }
      return { kind: "object", entries, operator: "=", equals: close + 1 };
    }
  }
  return null;
}

function applyStaticAssignment(context, target, value) {
  if (target.kind === "object") {
    for (const entry of target.entries) {
      assignStaticBinding(
        context,
        entry.name,
        value?.kind === "object" ? value.values.get(entry.key) ?? STATIC_UNKNOWN : STATIC_UNKNOWN,
      );
    }
    return value;
  }
  if (target.kind === "array") {
    for (let index = 0; index < target.names.length; index += 1) {
      const name = target.names[index];
      if (name !== null) assignStaticBinding(
        context,
        name,
        Array.isArray(value) ? value[index] ?? STATIC_UNKNOWN : STATIC_UNKNOWN,
      );
    }
    return value;
  }
  let assigned = value;
  if (target.operator === "+=") {
    const previous = staticValueText(staticIdentifierValue(context.scopes, target.names[0]));
    const suffix = staticValueText(value);
    assigned = previous === null || suffix === null
      ? STATIC_UNKNOWN
      : boundedStaticString(previous + suffix);
  } else if (target.operator !== "=") {
    assigned = STATIC_UNKNOWN;
  }
  assignStaticBinding(context, target.names[0], assigned);
  return assigned;
}

function declareStaticDestructuring(context, target, value, kind) {
  if (target.kind === "array") {
    for (let index = 0; index < target.names.length; index += 1) {
      const name = target.names[index];
      if (name !== null) declareStaticBinding(
        context,
        name,
        Array.isArray(value) ? value[index] ?? STATIC_UNKNOWN : STATIC_UNKNOWN,
        kind,
      );
    }
    return;
  }
  for (const entry of target.entries) {
    declareStaticBinding(
      context,
      entry.name,
      value?.kind === "object" ? value.values.get(entry.key) ?? STATIC_UNKNOWN : STATIC_UNKNOWN,
      kind,
    );
  }
}

function parseStaticAssignment(tokens, index, end, context, depth = 0) {
  if (depth > STATIC_EVALUATOR_LIMITS.expressionDepth) staticEvaluatorLimit("expression depth");
  const target = staticAssignmentTarget(tokens, index, end);
  if (!target) return parseStaticAdditive(tokens, index, end, context, depth + 1);
  const rightStart = target.equals + 1;
  const right = parseStaticAssignment(tokens, rightStart, end, context, depth + 1);
  if (right.index <= rightStart) return { value: STATIC_UNKNOWN, index: right.index };
  const value = applyStaticAssignment(context, target, right.value);
  if (value !== STATIC_UNKNOWN) markStaticHandledRange(context, tokens, rightStart, right.index);
  return { value, index: right.index };
}

function parseStaticExpression(tokens, index, end, context, depth = 0, allowComma = true) {
  let value = parseStaticAssignment(tokens, index, end, context, depth + 1);
  let cursor = skipStaticNewlines(tokens, value.index, end);
  while (allowComma && cursor < end && tokens[cursor]?.value === ",") {
    const next = parseStaticAssignment(tokens, cursor + 1, end, context, depth + 1);
    if (next.index <= cursor + 1) return { value: STATIC_UNKNOWN, index: next.index };
    value = next;
    cursor = skipStaticNewlines(tokens, value.index, end);
  }
  return value;
}

function evaluateStaticTokenRange(tokens, start, end, context) {
  const first = skipStaticNewlines(tokens, start, end);
  const parsed = parseStaticExpression(tokens, first, end, context);
  let cursor = skipStaticNewlines(tokens, parsed.index, end);
  while (cursor < end && tokens[cursor]?.value === ";") {
    cursor = skipStaticNewlines(tokens, cursor + 1, end);
  }
  return cursor === end ? parsed.value : STATIC_UNKNOWN;
}

function shellStaticValue(source, scopes) {
  let cursor = 0;
  let value = "";
  const appendBinding = (name) => {
    const bound = lookupStaticBinding(scopes, name);
    if (!bound.found || typeof bound.value !== "string") return false;
    value += bound.value;
    return true;
  };
  const variableAt = (start) => {
    if (source[start] !== "$") return null;
    if (source[start + 1] === "(" || source[start + 1] === "`") return { invalid: true };
    if (source[start + 1] === "{") {
      const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/u.exec(source.slice(start));
      return match ? { name: match[1], end: start + match[0].length } : { invalid: true };
    }
    const match = /^\$([A-Za-z_][A-Za-z0-9_]*)/u.exec(source.slice(start));
    return match ? { name: match[1], end: start + match[0].length } : { invalid: true };
  };
  while (cursor < source.length) {
    if (/\s/u.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    const quote = source[cursor];
    if (quote === "'") {
      const end = source.indexOf("'", cursor + 1);
      if (end === -1) return STATIC_UNKNOWN;
      value += source.slice(cursor + 1, end);
      cursor = end + 1;
      continue;
    }
    if (quote === "\"") {
      cursor += 1;
      while (cursor < source.length && source[cursor] !== "\"") {
        if (source[cursor] === "`") return STATIC_UNKNOWN;
        if (source[cursor] === "$" ) {
          const variable = variableAt(cursor);
          if (!variable || variable.invalid || !appendBinding(variable.name)) return STATIC_UNKNOWN;
          cursor = variable.end;
          continue;
        }
        if (source[cursor] === "\\") {
          if (cursor + 1 >= source.length) return STATIC_UNKNOWN;
          value += source[cursor + 1];
          cursor += 2;
          continue;
        }
        value += source[cursor];
        cursor += 1;
      }
      if (source[cursor] !== "\"") return STATIC_UNKNOWN;
      cursor += 1;
      continue;
    }
    if (source[cursor] === "$") {
      const variable = variableAt(cursor);
      if (!variable || variable.invalid || !appendBinding(variable.name)) return STATIC_UNKNOWN;
      cursor = variable.end;
      continue;
    }
    if (source[cursor] === "`" || /[;&|<>()[\]{}*?]/u.test(source[cursor])) return STATIC_UNKNOWN;
    if (source[cursor] === "\\") {
      if (cursor + 1 >= source.length) return STATIC_UNKNOWN;
      if (source[cursor + 1] === "\n") {
        cursor += 2;
        continue;
      }
      if (source[cursor + 1] === "\r" && source[cursor + 2] === "\n") {
        cursor += 3;
        continue;
      }
      value += source[cursor + 1];
      cursor += 2;
      continue;
    }
    value += source[cursor];
    cursor += 1;
  }
  return boundedStaticString(value);
}

function staticStatementEnd(tokens, start) {
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let cursor = start; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (token.value === "(") parentheses += 1;
    else if (token.value === ")") parentheses = Math.max(0, parentheses - 1);
    else if (token.value === "[") brackets += 1;
    else if (token.value === "]") brackets = Math.max(0, brackets - 1);
    else if (token.value === "{") braces += 1;
    else if (token.value === "}") {
      if (parentheses === 0 && brackets === 0 && braces === 0) return cursor;
      braces = Math.max(0, braces - 1);
    }
    if (parentheses === 0 && brackets === 0 && braces === 0) {
      if (token.value === ";") return cursor;
      if (token.kind === "newline") {
        let previous = cursor - 1;
        while (previous >= start && tokens[previous].kind === "newline") previous -= 1;
        let next = cursor + 1;
        while (next < tokens.length && tokens[next].kind === "newline") next += 1;
        if (!["+", ".", "?.", ",", "=", "("].includes(tokens[previous]?.value) &&
            !["+", ".", "?.", ",", ")", "]"].includes(tokens[next]?.value)) {
          return cursor;
        }
      }
    }
  }
  return tokens.length;
}

function topLevelStaticTokenParts(tokens, start, end, delimiter) {
  const parts = [];
  let partStart = start;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let cursor = start; cursor < end; cursor += 1) {
    const value = tokens[cursor].value;
    if (value === "(") parentheses += 1;
    else if (value === ")") parentheses -= 1;
    else if (value === "[") brackets += 1;
    else if (value === "]") brackets -= 1;
    else if (value === "{") braces += 1;
    else if (value === "}") braces -= 1;
    else if (value === delimiter && parentheses === 0 && brackets === 0 && braces === 0) {
      parts.push({ start: partStart, end: cursor });
      partStart = cursor + 1;
    }
    if (parentheses < 0 || brackets < 0 || braces < 0) return [];
  }
  if (parentheses !== 0 || brackets !== 0 || braces !== 0) return [];
  parts.push({ start: partStart, end });
  return parts;
}

function staticDeclarators(tokens, start, end) {
  const declarators = [];
  for (const part of topLevelStaticTokenParts(tokens, start, end, ",")) {
    let cursor = skipStaticNewlines(tokens, part.start, part.end);
    if (tokens[cursor]?.value === "mut") cursor += 1;
    const name = tokens[cursor];
    if (name?.kind !== "identifier") continue;
    let equals = cursor + 1;
    while (equals < part.end && tokens[equals].value !== "=") equals += 1;
    declarators.push({
      name: name.value,
      equals: equals < part.end ? equals : -1,
      end: part.end,
    });
  }
  return declarators;
}

const STATIC_DECLARATION_MODIFIERS = new Set([
  "export", "default", "public", "private", "protected", "final", "lateinit", "internal",
]);

function staticDeclarationAt(tokens, start) {
  let cursor = start;
  if (tokens[cursor]?.value === "export" && tokens[cursor + 1]?.kind === "identifier" &&
      tokens[cursor + 2]?.value === "=") {
    return {
      kind: "shell",
      name: tokens[cursor + 1].value,
      equals: cursor + 2,
      end: staticStatementEnd(tokens, cursor + 3),
      shell: true,
    };
  }
  while (STATIC_DECLARATION_MODIFIERS.has(tokens[cursor]?.value)) cursor += 1;
  let kind = tokens[cursor]?.value;
  if (["const", "let", "var", "val"].includes(kind)) {
    cursor += 1;
    const end = staticStatementEnd(tokens, cursor);
    const declarators = staticDeclarators(tokens, cursor, end);
    if (declarators.length === 0) return null;
    return { kind, ...declarators[0], end, shell: false, declarators };
  }
  if (kind === "static" && tokens[cursor + 1]?.kind === "identifier" &&
      tokens[cursor + 2]?.value === ":") {
    const end = staticStatementEnd(tokens, cursor + 2);
    let equals = cursor + 2;
    while (equals < end && tokens[equals].value !== "=") equals += 1;
    return {
      kind: "static",
      name: tokens[cursor + 1].value,
      equals: equals < end ? equals : -1,
      end,
      shell: false,
    };
  }
  if (["local", "readonly"].includes(kind) ||
      (kind === "export" && tokens[cursor + 1]?.kind === "identifier" &&
       tokens[cursor + 2]?.value === "=")) {
    if (kind === "export") cursor += 1;
    else cursor += 1;
    const name = tokens[cursor];
    if (name?.kind !== "identifier" || tokens[cursor + 1]?.value !== "=") return null;
    return {
      kind: "shell",
      name: name.value,
      equals: cursor + 1,
      end: staticStatementEnd(tokens, cursor + 2),
      shell: true,
    };
  }

  const end = staticStatementEnd(tokens, cursor);
  let equals = cursor;
  let hasCall = false;
  while (equals < end && tokens[equals].value !== "=") {
    if (tokens[equals].value === "(") hasCall = true;
    equals += 1;
  }
  if (equals >= end || hasCall) return null;
  let nameIndex = equals - 1;
  while (nameIndex > cursor && ["]", "["].includes(tokens[nameIndex].value)) nameIndex -= 1;
  const name = tokens[nameIndex];
  const type = tokens[cursor];
  const plausibleType = type?.kind === "identifier" && name?.kind === "identifier" &&
    nameIndex > cursor && (/^[A-Z]/u.test(type.value) || ["var", "String", "Path", "CharSequence"].includes(type.value));
  return plausibleType
    ? { kind: "typed", name: name.value, equals, end, shell: false }
    : null;
}

function staticDestructuringDeclarationAt(tokens, start) {
  let cursor = start;
  while (STATIC_DECLARATION_MODIFIERS.has(tokens[cursor]?.value)) cursor += 1;
  const kind = tokens[cursor]?.value;
  if (!["const", "let", "var", "val"].includes(kind)) return null;
  const end = staticStatementEnd(tokens, cursor + 1);
  const target = staticAssignmentTarget(tokens, cursor + 1, end);
  return target && ["array", "object"].includes(target.kind)
    ? { kind, target, equals: target.equals, end }
    : null;
}

function staticAssignmentAt(tokens, start) {
  const name = tokens[start];
  const operator = tokens[start + 1];
  if (name?.kind !== "identifier" ||
      !["=", "+=", "-=", "*=", "/=", "??=", "&&=", "||=", "**=", "<<=", ">>=", "++", "--"]
        .includes(operator?.value)) {
    return null;
  }
  const end = staticStatementEnd(tokens, start + 2);
  return {
    name: name.value,
    operator: operator.value,
    equals: start + 1,
    end,
    shell: operator.value === "=" && name.end === operator.start,
  };
}

function declareStaticBinding(context, name, value, kind) {
  let target = context.scopes.length - 1;
  if (kind === "var") {
    while (target > 0 && context.scopes[target].type !== "function") target -= 1;
  }
  if (!context.scopes[target].bindings.has(name)) {
    context.state.bindings += 1;
    if (context.state.bindings > STATIC_EVALUATOR_LIMITS.bindings) staticEvaluatorLimit("binding");
  }
  context.scopes[target].bindings.set(name, value);
}

function assignStaticBinding(context, name, value) {
  const binding = lookupStaticBinding(context.scopes, name);
  if (!binding.found) {
    declareStaticBinding(context, name, value, "shell");
    return;
  }
  const ambiguousIndex = context.scopes.findLastIndex((scope) => scope.type === "ambiguous");
  if (ambiguousIndex !== -1 && binding.scope < ambiguousIndex) {
    const ambiguous = context.scopes[ambiguousIndex];
    if (!ambiguous.bindings.has(name)) {
      context.state.bindings += 1;
      if (context.state.bindings > STATIC_EVALUATOR_LIMITS.bindings) staticEvaluatorLimit("binding");
    }
    ambiguous.bindings.set(name, value);
    ambiguous.invalidates.add(name);
    return;
  }
  const functionIndex = context.scopes.findLastIndex((scope) => scope.type === "function");
  if (functionIndex !== -1 && binding.scope < functionIndex) {
    if (!context.scopes[functionIndex].bindings.has(name)) {
      context.state.bindings += 1;
      if (context.state.bindings > STATIC_EVALUATOR_LIMITS.bindings) staticEvaluatorLimit("binding");
    }
    context.scopes[functionIndex].bindings.set(name, value);
    return;
  }
  context.scopes[binding.scope].bindings.set(name, value);
}

function staticFunctionScopes(tokens) {
  const scopes = new Map();
  const register = (open, close, brace) => {
    if (open === -1 || close === -1 || brace === -1) return;
    const parameters = [];
    let start = open + 1;
    for (let cursor = open + 1; cursor <= close; cursor += 1) {
      if (cursor === close || tokens[cursor].value === ",") {
        const identifiers = tokens.slice(start, cursor).filter((token) => token.kind === "identifier");
        if (identifiers.length > 0) parameters.push(identifiers.at(-1).value);
        start = cursor + 1;
      }
    }
    scopes.set(brace, parameters);
  };
  for (let index = 0; index < tokens.length; index += 1) {
    if (["function", "fun"].includes(tokens[index].value)) {
      let open = index + 1;
      const headerLimit = Math.min(tokens.length, index + 256);
      while (open < headerLimit && tokens[open].value !== "(" &&
             tokens[open].kind !== "newline") open += 1;
      if (tokens[open]?.value !== "(") continue;
      const close = matchingStaticToken(tokens, open, "(", ")");
      let brace = close + 1;
      const bodyLimit = Math.min(tokens.length, close + 256);
      while (brace < bodyLimit && tokens[brace].value !== "{" &&
             tokens[brace].value !== ";") brace += 1;
      register(open, close, tokens[brace]?.value === "{" ? brace : -1);
    }
    if (tokens[index].value === "=>" && tokens[index + 1]?.value === "{") {
      if (tokens[index - 1]?.value === ")") {
        const open = staticTokenMatches(tokens).get(index - 1) ?? -1;
        register(open, index - 1, index + 1);
      } else if (tokens[index - 1]?.kind === "identifier") {
        scopes.set(index + 1, [tokens[index - 1].value]);
      }
    }
  }
  return scopes;
}

function staticAmbiguousScopes(tokens) {
  const scopes = new Set();
  const conditional = new Set(["if", "for", "while", "switch", "catch", "with"]);
  const direct = new Set(["else", "try", "finally", "do"]);
  for (let index = 0; index < tokens.length; index += 1) {
    let brace = -1;
    if (conditional.has(tokens[index].value)) {
      let open = index + 1;
      while (open < tokens.length && tokens[open].kind === "newline") open += 1;
      if (tokens[open]?.value !== "(") continue;
      const close = matchingStaticToken(tokens, open, "(", ")");
      if (close === -1) continue;
      brace = close + 1;
      while (brace < tokens.length && tokens[brace].kind === "newline") brace += 1;
    } else if (direct.has(tokens[index].value)) {
      brace = index + 1;
      while (brace < tokens.length && tokens[brace].kind === "newline") brace += 1;
      if (tokens[index].value === "else" && tokens[brace]?.value === "if") continue;
    }
    if (tokens[brace]?.value === "{") scopes.add(brace);
  }
  return scopes;
}

function staticInitializerValue(text, tokens, declaration, context) {
  if (declaration.equals === -1 || declaration.equals + 1 >= declaration.end) return STATIC_UNKNOWN;
  const start = declaration.equals + 1;
  const sourceStart = tokens[start].start;
  const sourceEnd = declaration.end < tokens.length ? tokens[declaration.end].start : text.length;
  const raw = text.slice(sourceStart, sourceEnd);
  if (declaration.shell && (raw.includes("$") || /['"]/u.test(raw))) {
    return shellStaticValue(raw, context.scopes);
  }
  const value = evaluateStaticTokenRange(tokens, start, declaration.end, context);
  if (value !== STATIC_UNKNOWN) return value;
  return declaration.shell ? shellStaticValue(raw, context.scopes) : STATIC_UNKNOWN;
}

/** Evaluate declarations, assignments, and calls in lexical/source order. */
function evaluateStaticSource(text) {
  const budget = { passes: 0 };
  consumeStaticEvaluatorPass(budget);
  const tokens = staticEvaluatorTokens(text);
  const state = {
    values: [],
    candidateSet: new Set(),
    observedSet: new Set(),
    bindings: 0,
    handledRanges: [],
  };
  const context = {
    scopes: [{ type: "global", bindings: new Map() }],
    state,
  };
  consumeStaticEvaluatorPass(budget);
  const functionScopes = staticFunctionScopes(tokens);
  consumeStaticEvaluatorPass(budget);
  const ambiguousScopes = staticAmbiguousScopes(tokens);
  consumeStaticEvaluatorPass(budget);
  let statementStart = true;
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];
    if (token.kind === "newline" || token.value === ";") {
      statementStart = true;
      index += 1;
      continue;
    }
    if (token.value === "{") {
      const parameters = functionScopes.get(index);
      const type = parameters ? "function" : ambiguousScopes.has(index) ? "ambiguous" : "block";
      context.scopes.push({ type, bindings: new Map(), invalidates: new Set() });
      if (parameters) {
        for (const name of parameters) declareStaticBinding(context, name, STATIC_UNKNOWN, "parameter");
      }
      statementStart = true;
      index += 1;
      continue;
    }
    if (token.value === "}") {
      if (context.scopes.length > 1) {
        const scope = context.scopes.pop();
        recordStaticScopeCandidates(state, scope);
        if (scope.type === "ambiguous") {
          for (const name of scope.invalidates) {
            const binding = lookupStaticBinding(context.scopes, name);
            if (binding.found) {
              const target = context.scopes[binding.scope];
              target.bindings.set(name, STATIC_UNKNOWN);
              if (target.type === "ambiguous") target.invalidates.add(name);
            }
          }
        }
      }
      statementStart = true;
      index += 1;
      continue;
    }
    if (!statementStart) {
      index += 1;
      continue;
    }
    if (["function", "fun", "class", "interface", "enum"].includes(token.value)) {
      const name = tokens[index + 1];
      if (name?.kind === "identifier") {
        declareStaticBinding(context, name.value, STATIC_UNKNOWN, "declaration");
      }
      statementStart = false;
      index += 1;
      continue;
    }
    if (["if", "for", "while", "switch", "catch", "with"].includes(token.value)) {
      let open = index + 1;
      while (open < tokens.length && tokens[open].kind === "newline") open += 1;
      const close = tokens[open]?.value === "("
        ? matchingStaticToken(tokens, open, "(", ")")
        : -1;
      if (close !== -1) {
        const parts = topLevelStaticTokenParts(tokens, open + 1, close, ";");
        const definiteParts = token.value === "for" ? parts.slice(0, 2) : parts;
        for (const part of definiteParts) {
          const value = evaluateStaticTokenRange(tokens, part.start, part.end, context);
          recordStaticCandidate(state, value);
        }
        if (token.value === "for" && parts.length > 2) {
          context.scopes.push({ type: "ambiguous", bindings: new Map(), invalidates: new Set() });
          const update = parts[2];
          const value = evaluateStaticTokenRange(tokens, update.start, update.end, context);
          recordStaticCandidate(state, value);
          const scope = context.scopes.pop();
          recordStaticScopeCandidates(state, scope);
          for (const name of scope.invalidates) {
            const binding = lookupStaticBinding(context.scopes, name);
            if (binding.found) context.scopes[binding.scope].bindings.set(name, STATIC_UNKNOWN);
          }
        }
      }
      index = close === -1 ? index + 1 : close + 1;
      statementStart = true;
      continue;
    }
    if (["else", "try", "finally", "do"].includes(token.value)) {
      index += 1;
      statementStart = true;
      continue;
    }
    const destructuring = staticDestructuringDeclarationAt(tokens, index);
    if (destructuring) {
      const value = evaluateStaticTokenRange(
        tokens,
        destructuring.equals + 1,
        destructuring.end,
        context,
      );
      observeStaticCandidate(state, value);
      declareStaticDestructuring(context, destructuring.target, value, destructuring.kind);
      if (value !== STATIC_UNKNOWN) {
        markStaticHandledRange(context, tokens, destructuring.equals + 1, destructuring.end);
      }
      index = destructuring.end;
      statementStart = false;
      continue;
    }
    const declaration = staticDeclarationAt(tokens, index);
    if (declaration) {
      for (const declarator of declaration.declarators ?? [declaration]) {
        const item = { ...declaration, ...declarator };
        const value = staticInitializerValue(text, tokens, item, context);
        observeStaticCandidate(state, value);
        declareStaticBinding(context, item.name, value, declaration.kind);
        if (value !== STATIC_UNKNOWN) {
          markStaticHandledRange(context, tokens, item.equals + 1, item.end);
        }
      }
      index = declaration.end;
      statementStart = false;
      continue;
    }
    const assignment = staticAssignmentAt(tokens, index);
    if (assignment) {
      let value = staticInitializerValue(text, tokens, assignment, context);
      if (assignment.operator === "+=") {
        const previous = staticValueText(staticIdentifierValue(context.scopes, assignment.name));
        const suffix = staticValueText(value);
        value = previous === null || suffix === null
          ? STATIC_UNKNOWN
          : boundedStaticString(previous + suffix);
      } else if (assignment.operator !== "=") {
        value = STATIC_UNKNOWN;
      }
      observeStaticCandidate(state, value);
      assignStaticBinding(context, assignment.name, value);
      if (value !== STATIC_UNKNOWN) {
        markStaticHandledRange(context, tokens, assignment.equals + 1, assignment.end);
      }
      index = assignment.end;
      statementStart = false;
      continue;
    }
    const expressionStart = ["return", "throw", "yield"].includes(token.value) ? index + 1 : index;
    const end = staticStatementEnd(tokens, expressionStart);
    const value = evaluateStaticTokenRange(tokens, expressionStart, end, context);
    recordStaticCandidate(state, value);
    index = end > index ? end : index + 1;
    statementStart = false;
  }
  for (const scope of context.scopes) recordStaticScopeCandidates(state, scope);
  const bindings = new Map(
    [...context.scopes[0].bindings].filter(([, value]) => typeof value === "string"),
  );
  return { values: state.values, bindings, handledRanges: state.handledRanges };
}

/** Static source values synthesized without evaluating any language. */
function staticSourceValues(text) {
  if (!/["'`]/u.test(text)) {
    const hasComments = text.includes("/*") || text.includes("//") || /(^|[\r\n])[\t ]*#/u.test(text);
    return {
      literals: [],
      values: [],
      masked: text,
      skeleton: hasComments ? maskComments(text) : text,
      folded: hasComments ? foldComments(text) : text,
    };
  }
  const initialLiterals = scanStaticLiterals(text);
  const initialMasked = maskStaticLiterals(text, initialLiterals);
  const initialHasComments = initialMasked.includes("/*") || initialMasked.includes("//") ||
    /(^|[\r\n])[\t ]*#/u.test(initialMasked);
  const initialSkeleton = initialHasComments ? maskComments(initialMasked) : initialMasked;
  const evaluation = evaluateStaticSource(text);
  const literals = initialLiterals;
  const masked = initialMasked;
  const hasComments = masked.includes("/*") || masked.includes("//") || /(^|[\r\n])[\t ]*#/u.test(masked);
  const skeleton = hasComments ? maskComments(masked) : masked;
  const folded = hasComments ? foldComments(masked) : masked;
  const consumed = new Set();
  const values = [];
  const candidateSet = new Set();
  const addValue = (value) => {
    boundedStaticString(value);
    if (candidateSet.has(value)) return;
    if (values.length >= STATIC_EVALUATOR_LIMITS.candidates) {
      staticEvaluatorLimit("candidate");
    }
    candidateSet.add(value);
    values.push(value);
  };
  for (const value of evaluation.values) addValue(value);
  for (let index = 0; index < literals.length; index += 1) {
    if (consumed.has(literals[index])) continue;
    const members = [literals[index]];
    let value = literals[index].value;
    let cursor = index;
    while (cursor + 1 < literals.length && !consumed.has(literals[cursor + 1])) {
      const foldedInsideHandledRange = evaluation.handledRanges.some((range) =>
        literals[index].start >= range.start && literals[cursor + 1].end <= range.end);
      if (foldedInsideHandledRange) break;
      const connector = staticConnector(
        text.slice(literals[cursor].end, literals[cursor + 1].start),
        literals[cursor],
        literals[cursor + 1],
      );
      if (connector === null) break;
      // Appending a suffix directly to an already complete reviewed path is
      // not the same operation as joining a descendant. Preserve that source
      // boundary so an allowlisted prefix cannot bless a changed token.
      if (connector === "" && approvedNormalizedProductionPath(value)) {
        value += STATIC_APPEND_POLICY_SEGMENT;
      }
      value += connector + literals[cursor + 1].value;
      members.push(literals[cursor + 1]);
      cursor += 1;
    }
    addValue(value);
    for (const member of members) consumed.add(member);
    index = cursor;
  }
  return { literals, values, masked, skeleton, folded };
}

function staticStringRuns(text) {
  if (text.length <= NORMALIZED_PATH_WINDOW_BYTES &&
      Buffer.byteLength(text, "utf8") <= STATIC_EVALUATOR_LIMITS.sourceBytes) {
    return staticSourceValues(text).values;
  }
  const values = [];
  const windowCharacters = 16 * 1024;
  const overlapCharacters = 2 * 1024;
  for (let offset = 0; offset < text.length; offset += windowCharacters - overlapCharacters) {
    const source = text.slice(offset, offset + windowCharacters);
    values.push(...staticSourceValues(source).values);
    if (source.length < windowCharacters) break;
  }
  return values;
}

function matchingClosingDelimiter(text, openIndex, opening, closing) {
  let depth = 0;
  for (let cursor = openIndex; cursor < text.length; cursor += 1) {
    if (text[cursor] === opening) depth += 1;
    else if (text[cursor] === closing) {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

function matchingOpeningParenthesis(text, closeIndex) {
  let depth = 0;
  for (let cursor = closeIndex; cursor >= 0; cursor -= 1) {
    if (text[cursor] === ")") depth += 1;
    else if (text[cursor] === "(") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

function topLevelStaticExpressions(expression, skeleton, delimiter) {
  const parts = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let cursor = 0; cursor < skeleton.length; cursor += 1) {
    const character = skeleton[cursor];
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === delimiter && parentheses === 0 && brackets === 0 && braces === 0) {
      parts.push(expression.slice(start, cursor));
      start = cursor + 1;
    }
    if (parentheses < 0 || brackets < 0 || braces < 0) return null;
  }
  if (parentheses !== 0 || brackets !== 0 || braces !== 0) return null;
  parts.push(expression.slice(start));
  return parts;
}

function staticConstantValue(expression, stringBindings = new Map(), depth = 0) {
  if (depth > 32 || expression.length > 65536) return null;
  let source = expression.trim();
  source = source.replace(/;\s*$/u, "").trim();
  source = source.replace(/\s+(?:as\s+const|satisfies\s+[A-Za-z_$][A-Za-z0-9_$.<>]*)\s*$/u, "").trim();
  if (source === "") return null;

  const parsedLiterals = scanStaticLiterals(source, stringBindings);
  const masked = maskComments(maskStaticLiterals(source, parsedLiterals));
  const trimmedSkeleton = masked.trim();
  const skeletonOffset = masked.indexOf(trimmedSkeleton);

  if (trimmedSkeleton.startsWith("(") &&
      matchingClosingDelimiter(trimmedSkeleton, 0, "(", ")") === trimmedSkeleton.length - 1) {
    return staticConstantValue(trimmedSkeleton.slice(1, -1), stringBindings, depth + 1);
  }
  const identifier = /^(?:\$)?([A-Za-z_$][A-Za-z0-9_$]*)$/u.exec(trimmedSkeleton);
  if (identifier) return stringBindings.get(identifier[1]) ?? null;
  if (/^(?:path\.sep|File\.separator|(?:std::path::)?MAIN_SEPARATOR)$/u.test(trimmedSkeleton)) {
    return "/";
  }

  if (trimmedSkeleton.startsWith("[") &&
      matchingClosingDelimiter(trimmedSkeleton, 0, "[", "]") === trimmedSkeleton.length - 1) {
    const innerStart = skeletonOffset + 1;
    const innerEnd = skeletonOffset + trimmedSkeleton.length - 1;
    const inner = source.slice(innerStart, innerEnd);
    const innerSkeleton = masked.slice(innerStart, innerEnd);
    if (inner.trim() === "") return [];
    const members = topLevelStaticExpressions(inner, innerSkeleton, ",");
    if (!members) return null;
    const values = members.map((member) =>
      staticConstantValue(member, stringBindings, depth + 1));
    return values.every((value) => typeof value === "string") ? values : null;
  }

  if (trimmedSkeleton.endsWith(")")) {
    const close = skeletonOffset + trimmedSkeleton.length - 1;
    const open = matchingOpeningParenthesis(masked, close);
    if (open !== -1) {
      const prefix = source.slice(0, open).trim();
      const argumentSource = source.slice(open + 1, close);
      const argumentSkeleton = masked.slice(open + 1, close);
      const argumentsList = argumentSource.trim() === "" ? [] :
        topLevelStaticExpressions(argumentSource, argumentSkeleton, ",");
      if (argumentsList) {
        const argumentsValues = argumentsList.map((argument) =>
          staticConstantValue(argument, stringBindings, depth + 1));
        if (argumentsValues.every((value) => typeof value === "string")) {
          if (/^(?:concat!)$/u.test(prefix)) return argumentsValues.join("");
          if (/^(?:(?:path(?:\.posix)?|os\.path)\.join|Paths\.get)$/u.test(prefix)) {
            return argumentsValues.join("/");
          }
          const method = /^(.*)\.(concat|join)\s*$/su.exec(prefix);
          if (method) {
            const receiver = staticConstantValue(method[1], stringBindings, depth + 1);
            if (method[2] === "concat" && typeof receiver === "string") {
              return receiver + argumentsValues.join("");
            }
            if (method[2] === "join" && Array.isArray(receiver) &&
                argumentsValues.length <= 1) {
              return receiver.join(argumentsValues[0] ?? ",");
            }
          }
        }
      }
    }
  }

  const plusParts = topLevelStaticExpressions(source, masked, "+");
  if (plusParts && plusParts.length > 1) {
    const values = plusParts.map((part) => staticConstantValue(part, stringBindings, depth + 1));
    if (values.every((value) => typeof value === "string")) return values.join("");
  }

  // Literal/template and shell-adjacent fallback. Gaps may contain only plus,
  // static identifiers, comments, line continuations, or shell `$name` forms.
  const literals = scanStaticLiterals(expression, stringBindings);
  const values = [];
  let cursor = 0;
  let invalid = false;
  const addGap = (gap, final = false) => {
    let compact = foldComments(gap)
      .replace(/\\\r?\n/gu, "")
      .replace(/\s+/gu, "");
    if (final) compact = compact.replace(/(?:asconst|satisfies[A-Za-z_$][A-Za-z0-9_$.<>]*)$/u, "");
    compact = compact.replace(/\$\{([A-Za-z_$][A-Za-z0-9_$]*)\}/gu, "$1");
    if (compact === "") return;
    const tokens = compact.match(/\+|\$?[A-Za-z_$][A-Za-z0-9_$]*/gu) ?? [];
    if (tokens.join("") !== compact) {
      invalid = true;
      return;
    }
    for (const token of tokens) {
      if (token === "+") continue;
      const name = token.startsWith("$") ? token.slice(1) : token;
      const bound = stringBindings.get(name);
      if (typeof bound !== "string") {
        invalid = true;
        return;
      }
      values.push(bound);
    }
  };
  for (const literal of literals) {
    addGap(expression.slice(cursor, literal.start));
    if (invalid) return null;
    values.push(literal.value);
    cursor = literal.end;
  }
  addGap(expression.slice(cursor), true);
  if (invalid || values.length === 0) return null;
  return values.join("");
}

function staticExpressionValue(expression, stringBindings = new Map()) {
  const value = staticConstantValue(expression, stringBindings);
  return typeof value === "string" ? value : null;
}

function sourceStringBindings(text, skeleton) {
  void skeleton;
  return evaluateStaticSource(text).bindings;
}

function sourceObjectRanges(skeleton) {
  const stack = [];
  const ranges = [];
  for (let cursor = 0; cursor < skeleton.length; cursor += 1) {
    if (skeleton[cursor] === "{") stack.push(cursor);
    else if (skeleton[cursor] === "}" && stack.length > 0) {
      const start = stack.pop();
      if (cursor - start <= 65536) ranges.push({ start, end: cursor });
    }
  }
  return ranges.sort((left, right) => left.start - right.start);
}

function topLevelObjectEntries(source, skeleton, start, end) {
  const entries = [];
  let entryStart = start + 1;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let cursor = start + 1; cursor < end; cursor += 1) {
    const character = skeleton[cursor];
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    else if (character === "{") braces += 1;
    else if (character === "}") braces = Math.max(0, braces - 1);
    else if (character === "," && parentheses === 0 && brackets === 0 && braces === 0) {
      entries.push(source.slice(entryStart, cursor));
      entryStart = cursor + 1;
    }
  }
  entries.push(source.slice(entryStart, end));
  return entries;
}

function objectBindingName(skeleton, objectStart) {
  const prefixStart = Math.max(0, objectStart - 512);
  const prefix = skeleton.slice(prefixStart, objectStart);
  return /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=;\r\n]{0,256})?=\s*$/u
    .exec(prefix)?.[1] ?? null;
}

function parseSourceJwkObject(entries, stringBindings, objectBindings) {
  const jwk = {};
  let recognized = 0;
  for (const sourceEntry of entries) {
    const entry = sourceEntry.trim();
    if (entry === "") continue;
    const spread = /^\.\.\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:as\s+const)?$/u.exec(entry);
    if (spread) {
      const object = objectBindings.get(spread[1]);
      if (object) Object.assign(jwk, object);
      continue;
    }
    const property = /^(?:["']([A-Za-z_$][A-Za-z0-9_$]*)["']|([A-Za-z_$][A-Za-z0-9_$]*))\s*:\s*([\s\S]*)$/u
      .exec(entry);
    if (property) {
      const name = property[1] ?? property[2];
      const value = staticExpressionValue(property[3], stringBindings);
      if (value === null) delete jwk[name];
      else jwk[name] = value;
      recognized += 1;
      continue;
    }
    const shorthand = /^([A-Za-z_$][A-Za-z0-9_$]*)$/u.exec(entry)?.[1];
    if (shorthand && stringBindings.has(shorthand)) {
      jwk[shorthand] = stringBindings.get(shorthand);
      recognized += 1;
    }
  }
  return recognized > 0 || Object.keys(jwk).length > 0 ? jwk : null;
}

function containsSourcePrivateJwk(text) {
  if (text.length > NORMALIZED_PATH_WINDOW_BYTES ||
      Buffer.byteLength(text, "utf8") > STATIC_EVALUATOR_LIMITS.sourceBytes) {
    const windowCharacters = 16 * 1024;
    const overlapCharacters = 2 * 1024;
    for (let offset = 0; offset < text.length; offset += windowCharacters - overlapCharacters) {
      const source = text.slice(offset, offset + windowCharacters);
      if (containsSourcePrivateJwk(source)) return true;
      if (source.length < windowCharacters) break;
    }
    return false;
  }
  const literals = scanStaticLiterals(text);
  const skeleton = maskComments(maskStaticLiterals(text, literals));
  const stringBindings = sourceStringBindings(text, skeleton);
  const ranges = sourceObjectRanges(skeleton);
  const objectBindings = new Map();
  for (let pass = 0; pass < 16; pass += 1) {
    let changed = false;
    for (const range of ranges) {
      const object = parseSourceJwkObject(
        topLevelObjectEntries(text, skeleton, range.start, range.end),
        stringBindings,
        objectBindings,
      );
      if (!object) continue;
      if (containsPrivateJwk(object)) return true;
      const name = objectBindingName(skeleton, range.start);
      if (name && JSON.stringify(objectBindings.get(name)) !== JSON.stringify(object)) {
        objectBindings.set(name, object);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return false;
}

function strictBase64Decode(value) {
  const compact = value.replace(/\s+/gu, "");
  if (compact.length < 44 || compact.length % 4 === 1 ||
      !/^[A-Za-z0-9+/_-]+={0,2}$/u.test(compact)) {
    return null;
  }
  const decoded = Buffer.from(compact, "base64url");
  return decoded.length > 0 ? decoded : null;
}

function genericPemBodies(text) {
  const bodies = [];
  const pattern = /-----BEGIN ([A-Z0-9][A-Z0-9 -]{0,63})-----([\s\S]*?)-----END \1-----/gu;
  for (const match of text.matchAll(pattern)) {
    const decoded = strictBase64Decode(match[2]);
    if (decoded) bodies.push(decoded);
  }
  return bodies;
}

function sourceByteArrays(text) {
  const candidates = [];
  for (const match of text.matchAll(/\[[^\[\]]{63,262144}\]/gsu)) {
    const body = foldComments(match[0].slice(1, -1));
    const tokens = body.split(",").map((token) => token.trim()).filter(Boolean);
    if (tokens.length < 32) continue;
    const values = [];
    let valid = true;
    for (const token of tokens) {
      let digits;
      let radix;
      const hexadecimal = /^0x([0-9a-f](?:_?[0-9a-f])*)(?:_?u8)?$/iu.exec(token);
      const decimal = /^(\d(?:_?\d)*)(?:_?u8)?$/u.exec(token);
      if (hexadecimal) {
        digits = hexadecimal[1].replaceAll("_", "");
        radix = 16;
      } else if (decimal) {
        digits = decimal[1].replaceAll("_", "");
        radix = 10;
      } else {
        valid = false;
        break;
      }
      const value = Number.parseInt(digits, radix);
      if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
        valid = false;
        break;
      }
      values.push(value);
    }
    if (valid) candidates.push(Buffer.from(values));
  }
  return candidates;
}

function containsEmbeddedPrivateKeyDer(buffer) {
  let offset = 0;
  let candidates = 0;
  while (offset < buffer.length) {
    const start = buffer.indexOf(0x30, offset);
    if (start === -1) return false;
    offset = start + 1;
    const node = readDerNode(buffer, start);
    const bytes = node?.tag === 0x30 ? node.end - start : 0;
    if (!node || bytes < 32 || bytes > MAX_EMBEDDED_DER_BYTES) continue;
    candidates += 1;
    // An attacker must not be able to exhaust the bounded structural scan with
    // junk SEQUENCE values placed before a real key. Ordinary source and model
    // fixtures do not contain thousands of bounded DER objects, so overflow is
    // itself rejected as unreviewable private-material-like binary content.
    if (candidates > MAX_EMBEDDED_DER_CANDIDATES) return true;
    if (parsesAsPrivateKeyDer(buffer.subarray(start, node.end))) return true;
  }
  return false;
}

function canonicalBase64Bytes(value, bytes) {
  if (typeof value !== "string") return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === bytes && decoded.toString("base64") === value;
}

function centerStoreKid(value) {
  if (typeof value !== "string" || value.length > 1024 ||
      !value.endsWith("/center/ephemeral") || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    return false;
  }
  const principal = value.slice(0, -"/center/ephemeral".length);
  return /^U:[A-Za-z0-9._-]+$/u.test(principal) ||
    /^V:[0-9A-Fa-f]{2}:D:[A-Za-z0-9._-]+:U:[A-Za-z0-9._-]+$/u.test(principal);
}

function isPlainJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function looksLikeCenterLiveKeyStore(value) {
  if (!isPlainJsonObject(value)) return false;
  const fields = Object.keys(value).sort();
  const expected = value.keys === undefined ? ["key", "kid"] : ["key", "keys", "kid"];
  if (fields.length !== expected.length ||
      fields.some((field, index) => field !== expected[index]) ||
      !centerStoreKid(value.kid) || !canonicalBase64Bytes(value.key, 16)) {
    return false;
  }
  if (value.keys === undefined) return true;
  if (!isPlainJsonObject(value.keys) || Object.keys(value.keys).length > 256) return false;
  return Object.entries(value.keys).every(([kid, key]) =>
    centerStoreKid(kid) && canonicalBase64Bytes(key, 16));
}

function looksLikeCosmosLiveKeyStore(value) {
  if (!isPlainJsonObject(value) ||
      Object.keys(value).sort().join(",") !== "channel_keys,wrapping_private_key" ||
      !(value.wrapping_private_key === null || typeof value.wrapping_private_key === "string") ||
      !isPlainJsonObject(value.channel_keys) || Object.keys(value.channel_keys).length > 4096) {
    return false;
  }
  return Object.entries(value.channel_keys).every(([kid, key]) =>
    typeof kid === "string" && kid.length > 0 && Buffer.byteLength(kid, "utf8") <= 1024 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(kid) && canonicalBase64Bytes(key, 16));
}

function containsLiveKeyStore(buffer) {
  if (!looksLikeText(buffer) || buffer.length === 0 || buffer.length > 8 * 1024 * 1024) return false;
  const text = buffer.toString("utf8").trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return false;
  try {
    const value = JSON.parse(text);
    return looksLikeCenterLiveKeyStore(value) || looksLikeCosmosLiveKeyStore(value);
  } catch {
    return false;
  }
}

/**
 * Detect raw DER and common persisted text encodings of standard private-key
 * containers (PKCS#8, RSA PKCS#1, and EC SEC1).
 * This is defense against ordinary fixture formats, not a claim to recognize
 * arbitrary obfuscation; every decoded candidate is independently accepted by
 * Node's private-key parser before it is rejected.
 */
export function containsEncodedPrivateKey(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (parsesAsPrivateKeyDer(buffer) || containsEmbeddedPrivateKeyDer(buffer)) return true;
  if (!looksLikeText(buffer)) return false;

  const text = buffer.toString("utf8");
  if (/-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text)) {
    return true;
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      if (containsPrivateJwk(JSON.parse(text))) return true;
    } catch {
      // Most source files are not JSON; continue with encoded DER candidates.
    }
  }
  if (/\bkty\b/u.test(text) && /\bd\b/u.test(text) && containsSourcePrivateJwk(text)) return true;
  const candidates = [];
  const addCandidate = (encoding, value) => candidates.push([encoding, value]);
  if (/^[A-Za-z0-9+/_=-]+(?:\s+[A-Za-z0-9+/_=-]+)*$/u.test(trimmed)) {
    addCandidate("base64url", trimmed.replace(/\s+/gu, ""));
  }
  // One exhaustive pass is cheaper than a full-file preflight followed by
  // the same full-file match pass. Every contiguous candidate is still seen.
  for (const match of text.matchAll(/M[A-Za-z0-9+/_=-]{63,}/gu)) {
    addCandidate("base64url", match[0]);
  }
  const mightContainStaticEncoding = /["'`]M(?:["'`]|[A-Za-z0-9+/_=-])/u.test(text) &&
    (text.includes("+") || text.includes("concat!") || text.includes("\\\n") ||
      /["'`]\s*["'`]/u.test(text) || text.includes("/*"));
  if (mightContainStaticEncoding) {
    for (const value of staticStringRuns(text)) {
      if (/^M[A-Za-z0-9+/_=-]{43,}$/u.test(value)) addCandidate("base64url", value);
    }
  }
  if (text.includes("-----BEGIN ")) {
    for (const value of genericPemBodies(text)) addCandidate("bytes", value);
  }
  if (text.includes("\\x")) {
    for (const match of text.matchAll(/(?:\\x[0-9a-f]{2}){32,}/giu)) {
      addCandidate("bytes", Buffer.from(
        [...match[0].matchAll(/\\x([0-9a-f]{2})/giu)].map((item) => Number.parseInt(item[1], 16)),
      ));
    }
  }
  if (text.includes("30")) {
    for (const match of text.matchAll(/\b30(?:[0-9a-f]{2}){31,}\b/giu)) {
      addCandidate("hex", match[0]);
    }
  }
  if (text.includes("0x") || text.includes("0X")) {
    for (const match of text.matchAll(/(?:0x)?[0-9a-f]{2}(?:[\s,:-]+(?:0x)?[0-9a-f]{2}){31,}/giu)) {
      addCandidate("hex", match[0].replace(/0x|[\s,:-]/giu, ""));
    }
  }
  if (text.includes("[") && text.includes(",") && /\d/u.test(text)) {
    for (const value of sourceByteArrays(text)) addCandidate("bytes", value);
  }

  for (const [encoding, candidate] of candidates) {
    let decoded;
    if (encoding === "bytes") {
      decoded = candidate;
    } else if (encoding === "hex") {
      if (candidate.length % 2 !== 0) continue;
      decoded = Buffer.from(candidate, "hex");
    } else {
      if (candidate.length < 64 || candidate.length % 4 === 1 ||
          !/^[A-Za-z0-9+/_-]+={0,2}$/u.test(candidate)) {
        continue;
      }
      decoded = Buffer.from(candidate, "base64url");
    }
    if (decoded.length > 0 && parsesAsPrivateKeyDer(decoded)) return true;
  }
  return false;
}

// Compatibility name retained for policy callers introduced with the first
// PKCS#8-only detector. The implementation now covers PKCS#8, RSA PKCS#1, and
// EC SEC1 containers.
export const containsPkcs8PrivateKey = containsEncodedPrivateKey;

function normalizePolicySegment(value) {
  if (!value.includes("\\") && !value.includes("%") && !value.includes("}")) {
    return value;
  }
  let normalized = value;
  for (let pass = 0; pass < MAX_NORMALIZATION_PASSES; pass += 1) {
    let next = normalized;
    if (next.includes("\\")) {
      next = next
        .replace(/\\\r?\n[\t ]*/gu, "")
        .replace(/\\x([0-9a-f]{2})/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/\\u\{([0-9a-f]{1,6})\}/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/\\u([0-9a-f]{4})/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/\\0?57(?![0-7])/gu, "/")
        .replace(/\\134(?![0-7])/gu, "\\")
        .replace(/\\\//gu, "/")
        .replace(/\\\\/gu, "\\")
        .replace(/\\t/gu, "\t")
        .replace(/\\r/gu, "\r")
        .replace(/\\n/gu, "\n");
    }
    if (next.includes("%")) {
      next = next.replace(
        /%([0-9a-f]{2})/giu,
        (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)),
      );
    }
    if (next.includes("}")) {
      // A parameter expansion can contribute a default directory and append a
      // child. Preserve that path relation in the normalized policy view.
      next = next.replace(/\}(?=\/)/gu, "");
    }
    if (next === normalized) return normalized;
    normalized = next;
  }
  fail(`source policy normalization did not reach a fixed point within ${MAX_NORMALIZATION_PASSES} passes`);
}

function normalizedPathViews(text) {
  const views = [];
  const step = NORMALIZED_PATH_WINDOW_BYTES - NORMALIZED_PATH_WINDOW_OVERLAP;
  for (let offset = 0; offset < Math.max(1, text.length); offset += step) {
    const source = text.slice(offset, offset + NORMALIZED_PATH_WINDOW_BYTES);
    const staticValues = staticSourceValues(source);
    // Direct comment text remains scanned in `masked`; the folded skeleton is
    // an additional view that catches a token deliberately split by comments.
    // Static values are synthesized once for this window and reused by every
    // detector rather than re-normalized for each candidate machine root.
    const truncatedEnd = offset + NORMALIZED_PATH_WINDOW_BYTES < text.length;
    const suffix = truncatedEnd ? TRUNCATED_POLICY_SEGMENT : "";
    const rawSegments = [`${staticValues.masked}${suffix}`];
    if (staticValues.folded !== staticValues.masked) {
      rawSegments.push(`${staticValues.folded}${suffix}`);
    }
    rawSegments.push(...staticValues.values);
    const segments = [...new Set(rawSegments.map(normalizePolicySegment))];
    views.push({
      text: segments.join("\0"),
      truncatedEnd,
    });
    if (source.length < NORMALIZED_PATH_WINDOW_BYTES) break;
  }
  return views;
}

function hasMachinePathBoundary(text, index) {
  if (index === 0) return true;
  const previous = text[index - 1];
  if (text.slice(Math.max(0, index - 2), index) === ":-") return true;
  if (text.slice(Math.max(0, index - 2), index) === "*|") return true;
  return /[\0\s="'`([{,;]/u.test(previous);
}

function normalizedProductionPathTokenAt(text, index) {
  let cursor = index;
  let truncated = false;
  while (cursor < text.length && cursor - index < MAX_MACHINE_PATH_BYTES) {
    const character = text[cursor];
    const next = text[cursor + 1];
    if (character === TRUNCATED_POLICY_SEGMENT) {
      truncated = true;
      break;
    }
    if (character === "\0" || /\s/u.test(character) ||
        ["\"", "'", "`", "}", ")", "]", ","].includes(character)) {
      break;
    }
    if (character === ":" && next === "/") break;
    if (character === ";" && (next === undefined || /\s/u.test(next))) break;
    if (character === "|" && text.slice(index, cursor).endsWith("/*")) break;
    cursor += 1;
  }
  if (cursor - index >= MAX_MACHINE_PATH_BYTES) return null;
  const candidate = text.slice(index, cursor);
  if (candidate.includes("\0") || !candidate.startsWith("/") ||
      !/^\/[A-Za-z0-9._~+/*-]+$/u.test(candidate)) {
    return null;
  }
  const pathWithoutGlob = candidate.endsWith("/*") ? candidate.slice(0, -1) : candidate;
  if (pathWithoutGlob.split("/").some((segment) => segment === "." || segment === "..") ||
      posix.normalize(pathWithoutGlob) !== pathWithoutGlob) {
    return null;
  }
  return { path: candidate, end: cursor, truncated };
}

function approvedNormalizedProductionPath(candidate) {
  const pathWithoutGlob = candidate.endsWith("/*") ? candidate.slice(0, -1) : candidate;
  for (const approved of APPROVED_CANONICAL_PRODUCTION_PATHS) {
    if (pathWithoutGlob === approved.path) return true;
    if (approved.descendants && pathWithoutGlob.startsWith(`${approved.path}/`)) return true;
  }
  return APPROVED_CANONICAL_PRODUCTION_PATH_PATTERNS.some((pattern) => pattern.test(candidate));
}

function approvedProductionPathAt(text, index) {
  if (!hasMachinePathBoundary(text, index)) return false;
  const token = normalizedProductionPathTokenAt(text, index);
  if (token === null || !approvedNormalizedProductionPath(token.path)) return false;
  // A Compose destination is a separate token, except when it immediately
  // starts by navigating upward. Likewise, a second whitespace-delimited path
  // beginning with `..` is attached traversal, while unrelated prose/code
  // containing `..` later on the same line is not.
  const remainder = text.slice(token.end, token.end + 128);
  return !/^(?::|\s+)\/\.\.(?:\/|$)/u.test(remainder);
}

function findUnapprovedMachinePathInViews(normalizedViews, machinePaths = []) {
  const explicitNeedles = machinePaths
    .filter((value) => typeof value === "string" && value.length > 1)
    .map((value) => normalizePolicySegment(value).replace(/\/+$/u, ""));
  for (const normalized of normalizedViews) {
    const view = normalized.text;
    const occurrences = [];
    for (const explicitNeedle of explicitNeedles) {
      if (explicitNeedle.length > 1) {
        let cursor = 0;
        while (cursor < view.length) {
          const index = view.indexOf(explicitNeedle, cursor);
          if (index === -1) break;
          occurrences.push({ index, label: explicitNeedle });
          cursor = index + explicitNeedle.length;
        }
      }
    }
    for (const match of view.matchAll(/\/(?:home|Users)\/[^\s/\\"'`()\[\]{},:=;|?!#@\0]+/gu)) {
      occurrences.push({ index: match.index, label: match[0] });
    }
    for (const match of view.matchAll(/(?:^|[\s="'`([{,;])(?:[A-Za-z]:)?[\\/]Users[\\/][^\s/\\"'`()\[\]{},:=;|?!#@\0]+/giu)) {
      const leading = match[0].match(/^[\s="'`([{,;]/u)?.[0] ?? "";
      occurrences.push({
        index: match.index + leading.length,
        label: match[0].slice(leading.length),
        windowsHome: true,
      });
    }
    for (const match of view.matchAll(/\/private\/var\/folders(?:\/|$)/gu)) {
      occurrences.push({
        index: match.index,
        label: ["", "private", "var", "folders"].join(POLICY_SLASH),
      });
    }
    occurrences.sort((left, right) => left.index - right.index);
    for (const occurrence of occurrences) {
      if (occurrence.windowsHome) {
        return explicitNeedles[0] ?? occurrence.label;
      }
      const token = normalizedProductionPathTokenAt(view, occurrence.index);
      // An overlapping window may cut an otherwise approved token. Defer that
      // occurrence to the next view, where the complete token is available.
      if (token?.truncated || (normalized.truncatedEnd && token?.end === view.length)) continue;
      if (!approvedProductionPathAt(view, occurrence.index)) {
        return explicitNeedles[0] ?? occurrence.label;
      }
    }
  }
  return null;
}

/** First machine-specific path occurrence not covered by the canonical server contract. */
export function findUnapprovedMachinePath(text, machinePath = null) {
  if (typeof text !== "string") return null;
  return findUnapprovedMachinePathInViews(
    normalizedPathViews(text),
    typeof machinePath === "string" ? [machinePath] : [],
  );
}

function applyReviewedSourcePolicyPathLiterals(text, releasePath) {
  const literals = REVIEWED_SOURCE_POLICY_PATH_LITERALS.get(releasePath);
  if (!literals) return text;
  let reviewed = text;
  for (const literal of literals) reviewed = reviewed.replaceAll(literal, "[reviewed historical path]");
  return reviewed;
}

function inspectContent(buffer, releasePath, context) {
  if (containsEncodedPrivateKey(buffer)) {
    fail(`encoded private key material detected in release source: ${releasePath}`);
  }
  if (containsLiveKeyStore(buffer)) {
    fail(`live channel/key-material snapshot content detected in release source: ${releasePath}`);
  }
  const text = applyReviewedSourcePolicyPathLiterals(policyText(buffer), releasePath);
  // Explicit roots catch non-home CI/workspace layouts. The generic normalized
  // view catches generic Unix and macOS home roots, including encoded or
  // statically concatenated spellings, before the reviewed production
  // allowlist is applied.
  const machinePaths = [context.root, context.home, CANONICAL_PRODUCTION_HOME]
    .filter((value) => typeof value === "string" && value.length > 1);

  const normalizedViews = normalizedPathViews(text);
  if (findUnapprovedMachinePathInViews(normalizedViews, machinePaths)) {
    fail(`machine-local path found in release source: ${releasePath}`);
  }
  for (const [kind, pattern] of HIGH_CONFIDENCE_SECRET_PATTERNS) {
    if (normalizedViews.some((view) => pattern.test(view.text))) {
      fail(`${kind} detected in release source: ${releasePath}`);
    }
  }
}

/**
 * Cheap whole-tree policy used by `check changed` and source-policy.sh. It
 * intentionally rejects generated directories rather than pruning them: a
 * credential, link, or forbidden subtree must never become invisible merely
 * because it was placed under dist-center, test-runs, or another build name.
 */
export async function validateSourceTreePolicy({
  root = DEFAULT_ROOT,
  configPath = join(root, "platform", "deploy", "release.json"),
  beforeSourceStabilityCheck,
} = {}) {
  const resolvedRoot = resolve(root);
  const absoluteConfig = resolve(configPath);
  if (!pathIsWithin(resolvedRoot, absoluteConfig)) {
    fail(`release source config escapes the source root: ${configPath}`);
  }
  const configRelative = toPosixPath(relative(resolvedRoot, absoluteConfig));
  validateRelativePath(configRelative, "release source config path");
  const initialBatch = readStableRootedEntries(
    resolvedRoot,
    ["."],
    "release source policy",
    { walk: true, prune: [".git"] },
  );
  const configEntry = initialBatch.entries.find((entry) => entry.receipt.path === configRelative);
  if (!configEntry || configEntry.kind !== "file") {
    fail(`release source config is missing from the source manifest: ${configRelative}`);
  }
  let config;
  try {
    config = JSON.parse(configEntry.data.toString("utf8"));
  } catch (error) {
    fail(`cannot read release source config ${configPath}: ${error.message}`);
  }
  validateReleaseConfig(config);
  const generated = new Set(config.ignoredDirectoryNames);
  const forbidden = new Set(config.forbiddenDirectoryNames.map(canonicalPolicyName));
  const forbiddenRoots = new Set(config.forbiddenRootDirectories.map(canonicalPolicyName));
  for (const entry of initialBatch.entries) {
    const sourcePath = entry.receipt.path;
    if (sourcePath === ".") continue;
    const segments = sourcePath.split("/");
    const depth = segments.length;
    const name = segments.at(-1);
    if (depth === 1 && SOURCE_POLICY_EXCLUDED_ROOT_DIRECTORIES.has(name)) continue;
    if (entry.kind === "directory") {
      if (generated.has(name)) {
        fail(`generated directory is forbidden in release source: ${sourcePath}`);
      }
      const canonicalName = canonicalPolicyName(name);
      if (forbidden.has(canonicalName) || (depth === 1 && forbiddenRoots.has(canonicalName))) {
        fail(`proprietary or private directory found in release source: ${sourcePath}`);
      }
      continue;
    }
    validateFileName(sourcePath, config);
    const lowerName = name.toLowerCase();
    if (config.ignoredExtensions.some((extension) => lowerName.endsWith(extension.toLowerCase()))) {
      fail(`generated file is forbidden in release source: ${sourcePath}`);
    }
    inspectContent(entry.data, sourcePath, {
      root: resolvedRoot,
      home: homedir(),
    });
  }
  if (beforeSourceStabilityCheck !== undefined) {
    if (typeof beforeSourceStabilityCheck !== "function") {
      fail("source policy beforeSourceStabilityCheck must be a function");
    }
    await beforeSourceStabilityCheck();
  }
  const stableBatch = readStableRootedEntries(
    resolvedRoot,
    ["."],
    "release source policy",
    { walk: true, prune: [".git"], expectedRoot: initialBatch.rootReceipt },
  );
  const initialReceipt = initialBatch.entries.map((entry) => entry.receipt);
  const stableReceipt = stableBatch.entries.map((entry) => entry.receipt);
  if (JSON.stringify(stableReceipt) !== JSON.stringify(initialReceipt)) {
    fail("release source manifest changed while applying source policy; retry from stable source");
  }
  return { ok: true };
}

function validateFileName(releasePath, config) {
  const name = basename(releasePath);
  const lowerName = name.toLowerCase();
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) {
    fail(`environment file is forbidden in a release: ${releasePath}`);
  }
  if (name === ".npmrc") {
    fail(`credential-bearing npm config is forbidden in a release: ${releasePath}`);
  }
  if (isPrivateKeyFileName(name)) {
    fail(`private-key filename is forbidden in a release: ${releasePath}`);
  }
  if (LIVE_KEY_SNAPSHOT_BASENAME_PATTERNS.some((pattern) => pattern.test(name))) {
    fail(`live channel/key-material snapshot filename is forbidden in a release: ${releasePath}`);
  }
  if (
    config.forbiddenExtensions.some((extension) => {
      const lowerExtension = extension.toLowerCase();
      return lowerName.endsWith(lowerExtension) || lowerName.includes(`${lowerExtension}.`);
    })
  ) {
    fail(`forbidden artifact type in release source: ${releasePath}`);
  }
}

function validateIncludedPath(includedPath, config) {
  const firstSegment = includedPath.split("/")[0];
  const forbiddenRoots = new Set(config.forbiddenRootDirectories.map(canonicalPolicyName));
  const forbiddenDirectories = new Set(config.forbiddenDirectoryNames.map(canonicalPolicyName));
  if (forbiddenRoots.has(canonicalPolicyName(firstSegment))) {
    fail(`profile cannot include forbidden root directory: ${includedPath}`);
  }
  const segments = includedPath.split("/");
  for (const segment of segments) {
    if (config.ignoredDirectoryNames.includes(segment)) {
      fail(`profile cannot explicitly include generated directory: ${includedPath}`);
    }
    if (forbiddenDirectories.has(canonicalPolicyName(segment))) {
      fail(`profile cannot include proprietary or private directory: ${includedPath}`);
    }
  }
}

async function collectReleaseFiles({ root, profile, config, expectedRoot = null }) {
  const profileConfig = config.profiles[profile];
  if (!profileConfig) {
    fail(`unknown release profile ${JSON.stringify(profile)}; expected ${Object.keys(config.profiles).join(", ")}`);
  }

  const canonicalRoot = resolve(root);
  const rootDirectory = readStableRootedEntries(
    canonicalRoot,
    ["."],
    "release source",
    { expectedRoot },
  ).entries[0];
  const { path: _rootPath, ...rootReceipt } = rootDirectory.receipt.ancestry[0];
  const files = new Map();
  const ignoredDirectories = new Set(config.ignoredDirectoryNames);
  const ignoredFiles = new Set(config.ignoredFileNames);
  const ignoredExtensions = config.ignoredExtensions.map((extension) => extension.toLowerCase());
  const forbiddenDirectories = new Set(config.forbiddenDirectoryNames.map(canonicalPolicyName));
  const excludedPaths = profileConfig.exclude ?? [];
  const directoryReceipts = [rootDirectory.receipt];

  for (const includedPath of profileConfig.include) {
    validateIncludedPath(includedPath, config);
    const absolutePath = resolve(canonicalRoot, includedPath);
    if (!pathIsWithin(canonicalRoot, absolutePath)) {
      fail(`included path escapes release root: ${includedPath}`);
    }
  }

  const sourceBatch = readStableRootedEntries(
    canonicalRoot,
    profileConfig.include.map(toPosixPath),
    "release source",
    { walk: true, expectedRoot: rootReceipt },
  );
  const prunedDirectories = [];
  for (const stable of sourceBatch.entries) {
    const releasePath = stable.receipt.path;
    if (excludedPaths.some((excludedPath) => releasePathIsWithin(excludedPath, releasePath)) ||
        prunedDirectories.some((directory) => releasePathIsWithin(directory, releasePath))) {
      continue;
    }
    if (stable.kind === "directory") {
      const directoryName = basename(releasePath);
      if (ignoredDirectories.has(directoryName)) {
        prunedDirectories.push(releasePath);
        continue;
      }
      if (forbiddenDirectories.has(canonicalPolicyName(directoryName))) {
        fail(`proprietary or private directory found in release source: ${releasePath}`);
      }
      directoryReceipts.push(stable.receipt);
      continue;
    }
    if (ignoredFiles.has(basename(releasePath))) continue;
    const lowerName = basename(releasePath).toLowerCase();
    if (ignoredExtensions.some((extension) => lowerName.endsWith(extension))) continue;
    validateRelativePath(releasePath, "release path");
    validateFileName(releasePath, config);
    if (files.has(releasePath)) fail(`duplicate release path: ${releasePath}`);
    const { data } = stable;
    inspectContent(data, releasePath, {
      root: canonicalRoot,
      home: homedir(),
    });
    files.set(releasePath, {
      data,
      mode: normalizedMode(stable.stat),
      path: releasePath,
      receipt: stable.receipt,
      sha256: sha256(data),
      size: data.length,
    });
  }

  const records = [...files.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
  directoryReceipts.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    records,
    receipt: {
      directories: directoryReceipts,
      files: records.map((record) => record.receipt),
    },
  };
}

export async function readStableReleaseProfile({
  profile,
  root = DEFAULT_ROOT,
  configPath = join(root, "platform", "deploy", "release.json"),
  beforeSourceStabilityCheck,
}) {
  if (typeof profile !== "string" || !profile) fail("release profile snapshot requires a profile");
  const resolvedRoot = resolve(root);
  const openedRoot = readStableRootedEntries(
    resolvedRoot,
    ["."],
    "release source",
  ).entries[0];
  const { path: _rootPath, ...rootReceipt } = openedRoot.receipt.ancestry[0];
  const canonicalRoot = await realpath(resolvedRoot);
  const canonicalRootDirectory = readStableRootedEntries(
    canonicalRoot,
    ["."],
    "release source",
    { expectedRoot: rootReceipt },
  ).entries[0];
  for (const boundary of ["private", "state"]) {
    if (canonicalRootDirectory.names.includes(boundary)) {
      fail(`forbidden top-level private/state boundary exists in release source: ${boundary}`);
    }
  }
  const configDocument = await loadReleaseConfigDocument(configPath, canonicalRoot, rootReceipt);
  const initialCollection = await collectReleaseFiles({
    root: canonicalRoot,
    profile,
    config: configDocument.config,
    expectedRoot: rootReceipt,
  });
  if (beforeSourceStabilityCheck !== undefined) {
    if (typeof beforeSourceStabilityCheck !== "function") {
      fail("profile snapshot beforeSourceStabilityCheck must be a function");
    }
    await beforeSourceStabilityCheck();
  }
  const stableConfig = await readStableSourceFile(
    canonicalRoot,
    configPath,
    configDocument.receipt.path,
    rootReceipt,
  );
  const stableCollection = await collectReleaseFiles({
    root: canonicalRoot,
    profile,
    config: configDocument.config,
    expectedRoot: rootReceipt,
  });
  if (JSON.stringify(configDocument.receipt) !== JSON.stringify(stableConfig.receipt) ||
      JSON.stringify(initialCollection.receipt) !== JSON.stringify(stableCollection.receipt)) {
    fail("release source manifest changed while taking a profile snapshot; retry from stable source");
  }
  return {
    canonicalRoot,
    config: configDocument.config,
    records: initialCollection.records,
    receipt: initialCollection.receipt,
  };
}

async function resolveProspectivePath(path) {
  let cursor = path;
  const missingSegments = [];
  while (!(await optionalLstat(cursor))) {
    const parent = dirname(cursor);
    if (parent === cursor) fail(`cannot resolve prospective output path: ${path}`);
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(await realpath(cursor), ...missingSegments);
}

function writeString(target, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) fail(`tar header field is too long: ${value}`);
  encoded.copy(target, offset);
}

function writeOctal(target, offset, length, value) {
  const encoded = Math.trunc(value).toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1) fail(`tar numeric field is too large: ${value}`);
  writeString(target, offset, length - 1, encoded);
  target[offset + length - 1] = 0;
}

function splitTarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const separators = [...path.matchAll(/\//g)].map((match) => match.index);
  for (let index = separators.length - 1; index >= 0; index -= 1) {
    const splitAt = separators[index];
    const prefix = path.slice(0, splitAt);
    const name = path.slice(splitAt + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  fail(`release path cannot be represented safely in a ustar archive: ${path}`);
}

function tarHeader(entry) {
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  const { name, prefix } = splitTarPath(entry.path);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, Number.parseInt(entry.mode, 8));
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function createTarGzip(records) {
  const chunks = [];
  for (const record of records) {
    chunks.push(tarHeader(record), record.data);
    const padding = (TAR_BLOCK_BYTES - (record.size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(TAR_END_BYTES));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

async function atomicWrite(path, data, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true });
  const existing = await optionalLstat(path);
  if (existing) fail(`refusing to replace existing release output: ${path}`);
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  let receipt;
  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.chmod(mode);
    const staged = await handle.stat({ bigint: true });
    if (!staged.isFile() || staged.nlink !== 1n) {
      fail(`atomic publication staging is not one regular file: ${path}`);
    }
    receipt = { dev: staged.dev.toString(), ino: staged.ino.toString() };
    await handle.close();
    handle = null;
    await link(temporaryPath, path);
    const installed = await lstat(path, { bigint: true });
    if (installed.isSymbolicLink() || !installed.isFile() ||
        installed.dev.toString() !== receipt.dev || installed.ino.toString() !== receipt.ino) {
      fail(`atomic publication did not install a regular file: ${path}`);
    }
    await unlink(temporaryPath);
    const finalized = await lstat(path, { bigint: true });
    if (finalized.dev.toString() !== receipt.dev || finalized.ino.toString() !== receipt.ino ||
        finalized.nlink !== 1n) {
      fail(`atomic publication output changed while finalizing: ${path}`);
    }
    return receipt;
  } catch (error) {
    if (handle && !receipt) {
      try {
        const staged = await handle.stat({ bigint: true });
        receipt = { dev: staged.dev.toString(), ino: staged.ino.toString() };
      } catch {
        // Preserve an unproven path instead of unlinking a possible replacement.
      }
    }
    if (handle) await handle.close().catch(() => {});
    if (receipt) {
      await cleanupOwnedPublication(path, receipt).catch(() => false);
      await cleanupOwnedPublication(temporaryPath, receipt).catch(() => false);
    }
    throw error;
  }
}

export async function cleanupOwnedPublication(path, receipt, testHooks = {}) {
  const current = await optionalBigIntLstat(path);
  if (!current || current.isSymbolicLink() || !current.isFile() ||
      current.dev.toString() !== receipt.dev || current.ino.toString() !== receipt.ino) {
    return false;
  }
  if (typeof testHooks.afterOwnershipCheck === "function") {
    await testHooks.afterOwnershipCheck();
  }
  // Rename first, then verify the inode that actually moved. If a concurrent
  // writer replaced the path after the lstat, its inode is restored or retained
  // under the unique quarantine name; it is never unlinked as our artifact.
  const quarantine = `${path}.cleanup-${process.pid}-${randomUUID()}`;
  await rename(path, quarantine);
  const moved = await lstat(quarantine, { bigint: true });
  if (moved.dev.toString() !== receipt.dev || moved.ino.toString() !== receipt.ino) {
    if (typeof testHooks.beforeForeignRestore === "function") {
      await testHooks.beforeForeignRestore({ quarantine });
    }
    try {
      await link(quarantine, path);
      await rm(quarantine);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        // A foreign directory or unsupported node cannot be restored with a
        // no-replace hard link. Preserve it under quarantine for recovery.
      }
    }
    return false;
  }
  await rm(quarantine);
  return true;
}

function parseOctal(buffer, offset, length, label) {
  const raw = buffer
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/\0.*$/, "")
    .trim();
  if (!/^[0-7]+$/.test(raw)) fail(`invalid tar ${label}`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail(`invalid tar ${label}`);
  return value;
}

function readTarString(buffer, offset, length) {
  const field = buffer.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function tarHeaderChecksum(header) {
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  return copy.reduce((sum, byte) => sum + byte, 0);
}

function parseTarGzip(archive) {
  let tar;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_EXTRACTED_ARCHIVE_BYTES });
  } catch (error) {
    fail(`cannot decompress release archive: ${error.message}`);
  }
  const records = [];
  const seen = new Set();
  let offset = 0;
  let sawEnd = false;
  while (offset + TAR_BLOCK_BYTES <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    offset += TAR_BLOCK_BYTES;
    if (header.every((byte) => byte === 0)) {
      sawEnd = true;
      break;
    }
    const expectedChecksum = parseOctal(header, 148, 8, "checksum");
    if (tarHeaderChecksum(header) !== expectedChecksum) fail("tar header checksum mismatch");
    const type = String.fromCharCode(header[156]);
    if (type !== "0" && type !== "\0") {
      fail(`release archive contains a non-regular entry of type ${JSON.stringify(type)}`);
    }
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    validateRelativePath(path, "archive path");
    if (seen.has(path)) fail(`release archive contains duplicate path: ${path}`);
    seen.add(path);
    const size = parseOctal(header, 124, 12, "size");
    const mode = parseOctal(header, 100, 8, "mode");
    if (offset + size > tar.length) fail(`truncated release archive entry: ${path}`);
    const data = Buffer.from(tar.subarray(offset, offset + size));
    offset += size;
    offset += (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    records.push({ data, mode: mode.toString(8).padStart(4, "0"), path, size });
  }
  if (!sawEnd) fail("release archive has no end marker");
  if (tar.subarray(offset).some((byte) => byte !== 0)) {
    fail("release archive contains trailing non-zero data");
  }
  return records;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("release manifest must be an object");
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail(`unsupported release manifest schema: ${String(manifest.schemaVersion)}`);
  }
  if (typeof manifest.profile !== "string" || !manifest.profile) {
    fail("release manifest profile is invalid");
  }
  if (!Array.isArray(manifest.entries)) fail("release manifest entries must be an array");
  let priorPath = "";
  const paths = new Set();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry !== "object") fail("release manifest entry is invalid");
    validateRelativePath(entry.path, "manifest path");
    if (paths.has(entry.path)) fail(`duplicate manifest path: ${entry.path}`);
    if (priorPath && priorPath.localeCompare(entry.path, "en") >= 0) {
      fail("release manifest entries are not strictly sorted by path");
    }
    paths.add(entry.path);
    priorPath = entry.path;
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) fail(`invalid sha256 for ${entry.path}`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) fail(`invalid size for ${entry.path}`);
    if (!/^(?:0644|0755)$/.test(entry.mode)) fail(`invalid mode for ${entry.path}`);
    const keys = Object.keys(entry).sort().join(",");
    if (keys !== "mode,path,sha256,size") fail(`unexpected manifest fields for ${entry.path}`);
  }
  const expectedReleaseId = manifestReleaseId(manifest.profile, manifest.entries);
  if (manifest.releaseId !== expectedReleaseId) {
    fail("release manifest digest does not match releaseId");
  }
  const keys = Object.keys(manifest).sort().join(",");
  if (keys !== "entries,profile,releaseId,schemaVersion") {
    fail("release manifest contains unexpected fields");
  }
  return manifest;
}

async function assertRegularFile(path, label) {
  const stat = await optionalLstat(path);
  if (!stat) fail(`${label} does not exist: ${path}`);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`${label} must be a regular file, not a symbolic link or special file: ${path}`);
  }
  return stat;
}

export async function verifyRelease({ archivePath, manifestPath }) {
  await assertRegularFile(manifestPath, "release manifest");
  const archiveStat = await assertRegularFile(archivePath, "release archive");
  if (archiveStat.size > MAX_ARCHIVE_BYTES) fail("release archive exceeds the verification size limit");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    fail(`cannot read release manifest ${manifestPath}: ${error.message}`);
  }
  validateManifest(manifest);
  const records = parseTarGzip(await readFile(archivePath));
  if (records.length !== manifest.entries.length) {
    fail(`archive has ${records.length} files but manifest has ${manifest.entries.length}`);
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "ai-pin-revival-verify-"));
  try {
    for (let index = 0; index < manifest.entries.length; index += 1) {
      const expected = manifest.entries[index];
      const actual = records[index];
      if (actual.path !== expected.path) {
        fail(`archive path mismatch: expected ${expected.path}, got ${actual.path}`);
      }
      if (actual.size !== expected.size || actual.data.length !== expected.size) {
        fail(`archive size mismatch for ${expected.path}`);
      }
      if (actual.mode !== expected.mode) fail(`archive mode mismatch for ${expected.path}`);
      if (sha256(actual.data) !== expected.sha256) fail(`archive hash mismatch for ${expected.path}`);

      const destination = resolve(temporaryRoot, expected.path);
      if (!pathIsWithin(temporaryRoot, destination)) fail(`archive path escapes extraction root: ${expected.path}`);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, actual.data, { flag: "wx", mode: Number.parseInt(expected.mode, 8) });
      await chmod(destination, Number.parseInt(expected.mode, 8));
    }

    for (const expected of manifest.entries) {
      const extractedPath = resolve(temporaryRoot, expected.path);
      const stat = await lstat(extractedPath);
      if (!stat.isFile() || stat.isSymbolicLink()) fail(`extracted entry is not a regular file: ${expected.path}`);
      const data = await readFile(extractedPath);
      if (data.length !== expected.size || sha256(data) !== expected.sha256) {
        fail(`extracted file verification failed: ${expected.path}`);
      }
      if (normalizedMode(stat) !== expected.mode) fail(`extracted mode verification failed: ${expected.path}`);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  return {
    ok: true,
    releaseId: manifest.releaseId,
    profile: manifest.profile,
    files: manifest.entries.length,
  };
}

export async function buildRelease({
  profile,
  outputDirectory,
  root = DEFAULT_ROOT,
  configPath = join(root, "platform", "deploy", "release.json"),
  beforeSourceStabilityCheck,
  beforeManifestPublication,
}) {
  if (typeof profile !== "string" || !profile) fail("build requires --profile");
  if (typeof outputDirectory !== "string" || !outputDirectory) fail("build requires --output");
  const resolvedRoot = resolve(root);
  const outputPath = resolve(outputDirectory);
  const openedRoot = readStableRootedEntries(
    resolvedRoot,
    ["."],
    "release source",
  ).entries[0];
  const { path: _rootPath, ...rootReceipt } = openedRoot.receipt.ancestry[0];
  const canonicalRoot = await realpath(resolvedRoot);
  const canonicalRootDirectory = readStableRootedEntries(
    canonicalRoot,
    ["."],
    "release source",
    { expectedRoot: rootReceipt },
  ).entries[0];
  for (const boundary of ["private", "state"]) {
    if (canonicalRootDirectory.names.includes(boundary)) {
      fail(`forbidden top-level private/state boundary exists in release source: ${boundary}`);
    }
  }
  const canonicalOutput = await resolveProspectivePath(outputPath);
  if (pathIsWithin(canonicalRoot, canonicalOutput)) {
    fail(`release output must be outside the source root: ${outputPath}`);
  }
  const outputStat = await optionalLstat(outputPath);
  if (outputStat?.isSymbolicLink()) fail(`release output cannot be a symbolic link: ${outputPath}`);
  if (outputStat && !outputStat.isDirectory()) fail(`release output is not a directory: ${outputPath}`);
  await mkdir(outputPath, { recursive: true });

  const configDocument = await loadReleaseConfigDocument(configPath, canonicalRoot, rootReceipt);
  const config = configDocument.config;
  const initialCollection = await collectReleaseFiles({
    root: canonicalRoot,
    profile,
    config,
    expectedRoot: rootReceipt,
  });
  const records = initialCollection.records;
  if (beforeSourceStabilityCheck !== undefined) {
    if (typeof beforeSourceStabilityCheck !== "function") {
      fail("build beforeSourceStabilityCheck must be a function");
    }
    await beforeSourceStabilityCheck();
  }
  const stableConfig = await readStableSourceFile(
    canonicalRoot,
    configPath,
    toPosixPath(relative(canonicalRoot, resolve(configPath))),
    rootReceipt,
  );
  const stableCollection = await collectReleaseFiles({
    root: canonicalRoot,
    profile,
    config,
    expectedRoot: rootReceipt,
  });
  if (JSON.stringify(configDocument.receipt) !== JSON.stringify(stableConfig.receipt) ||
      JSON.stringify(initialCollection.receipt) !== JSON.stringify(stableCollection.receipt)) {
    fail("release source manifest changed while packaging; retry from stable source");
  }
  const entries = records.map(({ mode, path, sha256: digest, size }) => ({
    path,
    sha256: digest,
    size,
    mode,
  }));
  const releaseId = manifestReleaseId(profile, entries);
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    profile,
    releaseId,
    entries,
  };
  const archivePath = join(outputPath, `${profile}-${releaseId}.tar.gz`);
  const manifestPath = join(outputPath, `${profile}-${releaseId}.manifest.json`);
  for (const publicationPath of [archivePath, manifestPath]) {
    if (await optionalLstat(publicationPath)) {
      fail(`refusing to replace existing release output: ${publicationPath}`);
    }
  }
  const publications = [];
  try {
    publications.push({
      path: archivePath,
      receipt: await atomicWrite(
        archivePath,
        createTarGzip(records.map(({ receipt: _receipt, ...record }) => record)),
      ),
    });
    if (beforeManifestPublication !== undefined) {
      if (typeof beforeManifestPublication !== "function") {
        fail("build beforeManifestPublication must be a function");
      }
      await beforeManifestPublication({ archivePath, manifestPath });
    }
    publications.push({
      path: manifestPath,
      receipt: await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
    });
    await verifyRelease({ archivePath, manifestPath });
    return { releaseId, archivePath, manifestPath };
  } catch (error) {
    for (const publication of publications.reverse()) {
      await cleanupOwnedPublication(publication.path, publication.receipt).catch(() => false);
    }
    throw error;
  }
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!command || !["build", "verify"].includes(command)) {
    fail("usage: release.mjs <build|verify> [options]");
  }
  const options = { command, json: false };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--json") {
      if (options.json) fail("--json may only be specified once");
      options.json = true;
      continue;
    }
    const optionNames = {
      "--archive": "archivePath",
      "--manifest": "manifestPath",
      "--output": "outputDirectory",
      "--profile": "profile",
    };
    const key = optionNames[argument];
    if (!key) fail(`unknown option: ${argument}`);
    if (options[key] !== undefined) fail(`${argument} may only be specified once`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) fail(`${argument} requires a value`);
    options[key] = value;
    index += 1;
  }
  return options;
}

async function main(argv) {
  const options = parseCli(argv);
  if (options.command === "build") {
    if (options.archivePath || options.manifestPath) fail("build does not accept --archive or --manifest");
    const result = await buildRelease(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write(`built ${result.releaseId} at ${result.archivePath}\n`);
    return;
  }
  if (options.profile || options.outputDirectory) fail("verify does not accept --profile or --output");
  if (!options.archivePath) fail("verify requires --archive");
  if (!options.manifestPath) fail("verify requires --manifest");
  const result = await verifyRelease(options);
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`verified ${result.releaseId} (${result.files} files, ${result.profile})\n`);
}

if (resolve(process.argv[1] ?? "") === resolve(SCRIPT_PATH)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`release: ${error.message}\n`);
    process.exitCode = 1;
  });
}
