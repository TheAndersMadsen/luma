#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
const SELF_PATH = fileURLToPath(import.meta.url);

export const PIN_RELEASE_SCHEMA_VERSION = 1;
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
export const MAX_PIN_ARTIFACT_SIZE_BYTES = 512 * 1024 * 1024;
const RELEASE_ID_RE = /^[0-9a-f]{64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const APK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.apk$/;
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const SERIAL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION_RE = /^(\d{4})-(\d{2})-(\d{2})\.(\d+)$/;
const MAX_VERSION_CODE = 2_147_483_647;
const STEADY_INSTALLED_ROLES = Object.freeze([
  "installer",
  "hook",
  "server",
  "hook-injector",
]);

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
const INSTALLED_STATE_FIELDS = Object.freeze([
  "schemaVersion",
  "serial",
  "mode",
  "currentRelease",
  "artifacts",
]);
const INSTALLED_ARTIFACT_FIELDS = Object.freeze([
  "role",
  "package",
  "versionName",
  "versionCode",
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

function requiredSerial(value, label = "serial") {
  const serial = requiredTrimmedString(value, label);
  if (!SERIAL_RE.test(serial)) {
    fail("invalid-serial", `${label} is not a safe device serial`);
  }
  return serial;
}

export function validatePinReleaseRelativePath(value, label = "path") {
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

function parseJsonString(source, state) {
  const start = state.index;
  state.index += 1;
  let escaped = false;
  while (state.index < source.length) {
    const character = source[state.index];
    if (!escaped && character === '"') {
      state.index += 1;
      try {
        return JSON.parse(source.slice(start, state.index));
      } catch {
        fail("invalid-json", "JSON contains an invalid string escape");
      }
    }
    if (!escaped && character.charCodeAt(0) < 0x20) {
      fail("invalid-json", "JSON strings may not contain control characters");
    }
    if (!escaped && character === "\\") {
      escaped = true;
    } else {
      escaped = false;
    }
    state.index += 1;
  }
  fail("invalid-json", "JSON contains an unterminated string");
}

function skipJsonWhitespace(source, state) {
  while (/[\t\n\r ]/.test(source[state.index] ?? "")) state.index += 1;
}

function parseJsonValue(source, state) {
  skipJsonWhitespace(source, state);
  const character = source[state.index];
  if (character === '"') return parseJsonString(source, state);
  if (character === "{") {
    state.index += 1;
    const result = Object.create(null);
    const keys = new Set();
    skipJsonWhitespace(source, state);
    if (source[state.index] === "}") {
      state.index += 1;
      return result;
    }
    while (state.index < source.length) {
      skipJsonWhitespace(source, state);
      if (source[state.index] !== '"') fail("invalid-json", "JSON object key must be a string");
      const key = parseJsonString(source, state);
      if (keys.has(key)) fail("duplicate-json-key", `JSON object contains duplicate key ${JSON.stringify(key)}`);
      keys.add(key);
      skipJsonWhitespace(source, state);
      if (source[state.index] !== ":") fail("invalid-json", "JSON object key must be followed by a colon");
      state.index += 1;
      result[key] = parseJsonValue(source, state);
      skipJsonWhitespace(source, state);
      if (source[state.index] === "}") {
        state.index += 1;
        return result;
      }
      if (source[state.index] !== ",") fail("invalid-json", "JSON object fields must be comma-separated");
      state.index += 1;
    }
    fail("invalid-json", "JSON contains an unterminated object");
  }
  if (character === "[") {
    state.index += 1;
    const result = [];
    skipJsonWhitespace(source, state);
    if (source[state.index] === "]") {
      state.index += 1;
      return result;
    }
    while (state.index < source.length) {
      result.push(parseJsonValue(source, state));
      skipJsonWhitespace(source, state);
      if (source[state.index] === "]") {
        state.index += 1;
        return result;
      }
      if (source[state.index] !== ",") fail("invalid-json", "JSON array values must be comma-separated");
      state.index += 1;
    }
    fail("invalid-json", "JSON contains an unterminated array");
  }
  for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
    if (source.startsWith(literal, state.index)) {
      state.index += literal.length;
      return value;
    }
  }
  const numberMatch = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(state.index));
  if (numberMatch) {
    state.index += numberMatch[0].length;
    const value = Number(numberMatch[0]);
    if (!Number.isFinite(value)) fail("invalid-json", "JSON number is not finite");
    return value;
  }
  fail("invalid-json", `JSON contains an unexpected token at byte ${state.index}`);
}

export function parsePinReleaseJson(source, label = "JSON") {
  if (typeof source !== "string") fail("invalid-json", `${label} must be text`);
  const state = { index: 0 };
  const value = parseJsonValue(source, state);
  skipJsonWhitespace(source, state);
  if (state.index !== source.length) fail("invalid-json", `${label} contains trailing data`);
  return value;
}

async function readJsonFile(path, label) {
  try {
    return parsePinReleaseJson(await readFile(path, "utf8"), label);
  } catch (error) {
    if (error instanceof PinReleaseContractError) throw error;
    fail("read-failed", `cannot read ${label} ${path}: ${error.message}`);
  }
}

async function readCanonicalManifestFile(path) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    fail("read-failed", `cannot read manifest ${path}: ${error.message}`);
  }
  return parseCanonicalPinReleaseManifestDocument(source);
}

function pathIsWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function writeEntireBuffer(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (bytesWritten <= 0) fail("snapshot-failed", "could not write the private APK snapshot");
    offset += bytesWritten;
  }
}

async function inspectArtifactBytes(apkRoot, relativePath, options = {}) {
  const safePath = validatePinReleaseRelativePath(relativePath, "artifact path");
  const rootPath = resolve(apkRoot);
  let rootStat;
  try {
    rootStat = await lstat(rootPath);
  } catch (error) {
    fail("unsafe-path", `artifact root is not readable: ${error.message}`);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail("unsafe-path", "artifact root must be a real directory");
  }
  const canonicalRoot = await realpath(rootPath);
  const candidate = resolve(rootPath, ...safePath.split("/"));
  if (!pathIsWithin(rootPath, candidate)) fail("unsafe-path", "artifact path escapes its root");
  let candidateStat;
  try {
    candidateStat = await lstat(candidate);
  } catch (error) {
    fail("artifact-unreadable", `artifact is not readable: ${safePath}: ${error.message}`);
  }
  if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
    fail("unsafe-path", `artifact must be a regular non-symlink file: ${safePath}`);
  }
  const canonicalCandidate = await realpath(candidate);
  if (!pathIsWithin(canonicalRoot, canonicalCandidate)) {
    fail("unsafe-path", `artifact resolves outside its root: ${safePath}`);
  }

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(canonicalCandidate, flags);
  let snapshotHandle = null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PIN_ARTIFACT_SIZE_BYTES) {
      fail("invalid-artifact-size", `artifact size is outside the supported range: ${safePath}`);
    }
    const digest = createHash("sha256");
    let size = 0;
    if (options.snapshotPath) {
      snapshotHandle = await open(
        options.snapshotPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o400,
      );
    }
    for await (const chunk of createReadStream(canonicalCandidate, { fd: handle.fd, autoClose: false })) {
      size += chunk.length;
      if (size > MAX_PIN_ARTIFACT_SIZE_BYTES) fail("invalid-artifact-size", `artifact exceeded its size bound: ${safePath}`);
      digest.update(chunk);
      if (snapshotHandle) await writeEntireBuffer(snapshotHandle, chunk, size - chunk.length);
    }
    if (snapshotHandle) await snapshotHandle.sync();
    const finalStat = await handle.stat();
    if (
      size !== stat.size ||
      finalStat.size !== stat.size ||
      finalStat.mtimeMs !== stat.mtimeMs ||
      finalStat.ino !== stat.ino ||
      finalStat.dev !== stat.dev
    ) {
      fail("artifact-changed", `artifact changed while it was inspected: ${safePath}`);
    }
    return Object.freeze({
      path: safePath,
      absolutePath: canonicalCandidate,
      name: basename(safePath),
      size,
      sha256: digest.digest("hex"),
      dev: finalStat.dev,
      ino: finalStat.ino,
    });
  } finally {
    if (snapshotHandle) await snapshotHandle.close();
    await handle.close();
  }
}

async function inspectOpenedArtifactHandle(handle, label) {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PIN_ARTIFACT_SIZE_BYTES) {
    fail("invalid-artifact-size", `${label} size is outside the supported range`);
  }
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let size = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
    if (bytesRead === 0) break;
    size += bytesRead;
    if (size > MAX_PIN_ARTIFACT_SIZE_BYTES) {
      fail("invalid-artifact-size", `${label} exceeded its size bound`);
    }
    digest.update(buffer.subarray(0, bytesRead));
  }
  const finalStat = await handle.stat();
  if (
    size !== stat.size ||
    finalStat.size !== stat.size ||
    finalStat.mtimeMs !== stat.mtimeMs ||
    finalStat.ino !== stat.ino ||
    finalStat.dev !== stat.dev
  ) {
    fail("artifact-changed", `${label} changed while it was inspected`);
  }
  return Object.freeze({
    size,
    sha256: digest.digest("hex"),
    dev: finalStat.dev,
    ino: finalStat.ino,
  });
}

async function defaultToolRunner({ executable, args, label, inheritedFd }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let stdout = "";
    let stderrBytes = 0;
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio:
        inheritedFd === undefined
          ? ["ignore", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe", inheritedFd],
    });
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => rejectPromise(new PinReleaseContractError(
        "android-tool-failed",
        `${label} exceeded its 30 second deadline`,
      )));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > 1024 * 1024) {
        child.kill("SIGKILL");
        finish(() => rejectPromise(new PinReleaseContractError(
          "android-tool-failed",
          `${label} exceeded its output bound`,
        )));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 1024 * 1024) {
        child.kill("SIGKILL");
        finish(() => rejectPromise(new PinReleaseContractError(
          "android-tool-failed",
          `${label} exceeded its error-output bound`,
        )));
      }
    });
    child.once("error", (error) => {
      finish(() => rejectPromise(new PinReleaseContractError(
        "android-tool-failed",
        `${label} could not start: ${error.message}`,
      )));
    });
    child.once("close", (code, signal) => {
      finish(() => {
        if (code === 0 && signal === null) resolvePromise(stdout);
        else rejectPromise(new PinReleaseContractError(
          "android-tool-failed",
          `${label} exited unsuccessfully`,
        ));
      });
    });
  });
}

function oneOutputLine(output, label) {
  const lines = String(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) fail("android-metadata-invalid", `${label} returned an ambiguous value`);
  return lines[0];
}

function parseSignerOutput(output) {
  const matches = [...String(output).matchAll(/Signer #([0-9]+) certificate SHA-256 digest:\s*([0-9A-Fa-f: ]+)/g)];
  if (matches.length !== 1 || matches[0][1] !== "1") {
    fail("android-signature-invalid", "APK must have exactly one current signer certificate digest");
  }
  const normalized = matches[0][2].replace(/[: ]/g, "").toLowerCase();
  if (!SHA256_RE.test(normalized)) {
    fail("android-signature-invalid", "APK signer digest is not a SHA-256 fingerprint");
  }
  return normalized;
}

async function readAndroidMetadata(absolutePath, options = {}) {
  const injectedToolRunner = options.toolRunner;
  const toolRunner = injectedToolRunner ?? defaultToolRunner;
  const apkanalyzer = options.apkanalyzer ?? process.env.APKANALYZER ?? "apkanalyzer";
  const apksigner = options.apksigner ?? process.env.APKSIGNER ?? "apksigner";
  const inspectionFds = options.inspectionFds ?? [];
  let invocation = 0;
  const runTool = async (executable, argsForPath, label) => {
    const inheritedFd = inspectionFds[invocation];
    invocation += 1;
    const inspectionPath =
      inheritedFd === undefined
        ? absolutePath
        : injectedToolRunner
          ? `/dev/fd/${inheritedFd}`
          : "/dev/fd/3";
    try {
      return await toolRunner({
        executable,
        args: argsForPath(inspectionPath),
        label,
        inheritedFd,
      });
    } catch (error) {
      if (error instanceof PinReleaseContractError) throw error;
      fail("android-tool-failed", `${label} failed: ${error.message}`);
    }
  };
  const analyzer = async (verb) => runTool(
    apkanalyzer,
    (inspectionPath) => ["manifest", verb, inspectionPath],
    `apkanalyzer manifest ${verb}`,
  );
  const packageName = oneOutputLine(await analyzer("application-id"), "APK application ID");
  const versionName = oneOutputLine(await analyzer("version-name"), "APK versionName");
  parseInstallVersion(versionName, "APK versionName");
  const rawVersionCode = oneOutputLine(await analyzer("version-code"), "APK versionCode");
  if (!/^[1-9][0-9]*$/.test(rawVersionCode)) {
    fail("android-metadata-invalid", "APK versionCode is not a positive decimal integer");
  }
  const versionCode = requiredPositiveInteger(
    Number(rawVersionCode),
    "APK versionCode",
    MAX_VERSION_CODE,
  );
  const signerSha256 = parseSignerOutput(await runTool(
    apksigner,
    (inspectionPath) => ["verify", "--print-certs", "--Werr", inspectionPath],
    "apksigner verify --print-certs --Werr",
  ));
  return Object.freeze({ package: packageName, versionName, versionCode, signerSha256 });
}

export async function inspectPinReleaseArtifact(options) {
  const role = requiredRole(options?.role, "artifact role");
  const snapshotDirectory = await mkdtemp(join(tmpdir(), "ai-pin-release-inspect-"));
  const snapshotPath = join(snapshotDirectory, "artifact.apk");
  const inspectionHandles = [];
  try {
    await chmod(snapshotDirectory, 0o700);
    const bytes = await inspectArtifactBytes(options?.apkRoot, options?.path, { snapshotPath });
    if (!APK_NAME_RE.test(bytes.name)) {
      fail("unsafe-path", `artifact filename is not a safe APK name: ${bytes.name}`);
    }
    const snapshotBefore = await inspectArtifactBytes(snapshotDirectory, "artifact.apk");
    if (snapshotBefore.size !== bytes.size || snapshotBefore.sha256 !== bytes.sha256) {
      fail("snapshot-failed", `${role} private APK snapshot does not match the opened source file`);
    }
    for (let index = 0; index < 5; index += 1) {
      const handle = await open(
        snapshotPath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      inspectionHandles.push(handle);
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.dev !== snapshotBefore.dev ||
        stat.ino !== snapshotBefore.ino ||
        stat.size !== snapshotBefore.size
      ) {
        fail("artifact-changed", `${role} private APK snapshot changed before tool inspection`);
      }
    }
    try {
      await unlink(snapshotPath);
    } catch (error) {
      fail("snapshot-failed", `${role} private APK snapshot could not be unlinked: ${error.message}`);
    }
    const metadata = await readAndroidMetadata(snapshotPath, {
      ...options,
      inspectionFds: inspectionHandles.slice(0, 4).map((handle) => handle.fd),
    });
    const snapshotAfter = await inspectOpenedArtifactHandle(
      inspectionHandles[4],
      `${role} unlinked private APK snapshot`,
    );
    const finalBytes = await inspectArtifactBytes(options?.apkRoot, options?.path);
    if (
      snapshotAfter.dev !== snapshotBefore.dev ||
      snapshotAfter.ino !== snapshotBefore.ino ||
      snapshotAfter.size !== bytes.size ||
      snapshotAfter.sha256 !== bytes.sha256 ||
      finalBytes.absolutePath !== bytes.absolutePath ||
      finalBytes.dev !== bytes.dev ||
      finalBytes.ino !== bytes.ino ||
      finalBytes.size !== bytes.size ||
      finalBytes.sha256 !== bytes.sha256
    ) {
      fail("artifact-changed", `${role} APK changed while Android metadata was inspected`);
    }
    if (metadata.package !== PIN_RELEASE_PACKAGE_BY_ROLE[role]) {
      fail(
        "package-mismatch",
        `${role} APK package ${metadata.package} does not match ${PIN_RELEASE_PACKAGE_BY_ROLE[role]}`,
      );
    }
    if (options.expectedSigner !== undefined) {
      const expectedSigner = requiredSha256(options.expectedSigner, "expected signer fingerprint");
      if (metadata.signerSha256 !== expectedSigner) {
        fail("signer-mismatch", `${role} APK signer does not match the approved fingerprint`);
      }
    }
    return Object.freeze({
      role,
      path: finalBytes.path,
      name: finalBytes.name,
      package: metadata.package,
      versionName: metadata.versionName,
      versionCode: metadata.versionCode,
      size: finalBytes.size,
      sha256: finalBytes.sha256,
      signerSha256: metadata.signerSha256,
    });
  } finally {
    await Promise.allSettled(inspectionHandles.map((handle) => handle.close()));
    await rm(snapshotDirectory, { recursive: true, force: true });
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

export function derivePinReleaseId(value) {
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

export function parsePinReleaseManifest(value) {
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

export function parsePinInstalledState(value) {
  assertExactFields(value, INSTALLED_STATE_FIELDS, "installed-state descriptor");
  if (value.schemaVersion !== PIN_RELEASE_SCHEMA_VERSION) fail("schema-version", "installed-state schemaVersion must be 1");
  const serial = requiredSerial(value.serial);
  const mode = requiredTrimmedString(value.mode, "installed-state mode");
  if (!["empty", "atomic"].includes(mode)) {
    fail("installed-state-invalid", "installed-state mode must be empty or atomic");
  }
  let currentRelease = null;
  if (value.currentRelease !== null) {
    assertExactFields(value.currentRelease, HISTORY_ENTRY_FIELDS, "installed currentRelease");
    currentRelease = Object.freeze({
      releaseId: requiredSha256(value.currentRelease.releaseId, "installed currentRelease.releaseId"),
      version: parseInstallVersion(value.currentRelease.version, "installed currentRelease.version").value,
      versionCode: requiredPositiveInteger(
        value.currentRelease.versionCode,
        "installed currentRelease.versionCode",
        MAX_VERSION_CODE,
      ),
      manifestSha256: requiredSha256(
        value.currentRelease.manifestSha256,
        "installed currentRelease.manifestSha256",
      ),
    });
  }
  if (!Array.isArray(value.artifacts)) fail("invalid-shape", "installed-state artifacts must be an array");
  const byRole = new Map();
  const artifacts = value.artifacts.map((artifact, index) => {
    assertExactFields(artifact, INSTALLED_ARTIFACT_FIELDS, `installed artifacts[${index}]`);
    const role = requiredRole(artifact.role, `installed artifacts[${index}].role`);
    if (byRole.has(role)) fail("duplicate-role", `installed state contains duplicate role ${role}`);
    const packageName = requiredTrimmedString(artifact.package, `${role}.package`);
    if (packageName !== PIN_RELEASE_PACKAGE_BY_ROLE[role]) fail("package-mismatch", `${role}.package is invalid`);
    const parsed = Object.freeze({
      role,
      package: packageName,
      versionName: parseInstallVersion(
        artifact.versionName,
        `${role}.installed versionName`,
      ).value,
      versionCode: requiredPositiveInteger(artifact.versionCode, `${role}.versionCode`, MAX_VERSION_CODE),
      sha256: requiredSha256(artifact.sha256, `${role}.installed sha256`),
      signerSha256: requiredSha256(
        artifact.signerSha256,
        `${role}.installed signerSha256`,
      ),
    });
    byRole.set(role, parsed);
    return parsed;
  });
  const roleSet = new Set(artifacts.map((artifact) => artifact.role));
  const hasAllSteadyRoles = STEADY_INSTALLED_ROLES.every((role) => roleSet.has(role));
  if (mode === "empty" && (currentRelease !== null || artifacts.length !== 0)) {
    fail("installed-state-invalid", "empty installed state must have null currentRelease and no artifacts");
  }
  if (
    mode === "atomic" &&
    (currentRelease === null ||
      !hasAllSteadyRoles ||
      artifacts.some(
        (artifact) =>
          artifact.versionCode !== currentRelease.versionCode ||
          artifact.versionName !== currentRelease.version,
      ))
  ) {
    fail("installed-state-invalid", "atomic installed state must bind every steady role to currentRelease");
  }
  return Object.freeze({
    schemaVersion: 1,
    serial,
    mode,
    currentRelease,
    artifacts: Object.freeze(PIN_RELEASE_ARTIFACT_ROLES.filter((role) => byRole.has(role)).map((role) => byRole.get(role))),
  });
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

function compareReceipts(expected, actual) {
  for (const field of RECEIPT_FIELDS) {
    if (expected[field] !== actual[field]) fail("receipt-mismatch", `${expected.role} live ${field} does not match its receipt`);
  }
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

async function verifyLiveReceiptArtifacts(receipts, options, expectedSigner) {
  const liveReceipts = [];
  for (const expected of receipts) {
    if (expected.signerSha256 !== expectedSigner) {
      fail("signer-mismatch", `${expected.role} receipt signer is not approved`);
    }
    const actual = await inspectPinReleaseArtifact({
      role: expected.role,
      apkRoot: options.apkRoot,
      path: expected.path,
      expectedSigner,
      apkanalyzer: options.apkanalyzer,
      apksigner: options.apksigner,
      toolRunner: options.toolRunner,
    });
    compareReceipts(expected, actual);
    liveReceipts.push(actual);
  }
  return Object.freeze(liveReceipts);
}

export async function verifyPinReleaseBundle(options) {
  const metadata = verifyPinReleaseMetadata(options);
  const liveReceipts = await verifyLiveReceiptArtifacts(
    metadata.receipts.artifacts,
    options,
    metadata.signerSha256,
  );
  return Object.freeze({
    schemaVersion: 1,
    releaseId: metadata.manifest.releaseId,
    version: metadata.manifest.version,
    versionCode: metadata.manifest.artifacts[0].versionCode,
    signerSha256: metadata.signerSha256,
    manifestSha256: metadata.manifestSha256,
    artifacts: Object.freeze(liveReceipts.map((receipt) => Object.freeze({
      role: receipt.role,
      path: receipt.path,
      sha256: receipt.sha256,
    }))),
    historyEntry: metadata.historyEntry,
  });
}

export async function planPinRelease(options) {
  const serial = requiredSerial(options?.serial, "requested serial");
  const installed = parsePinInstalledState(options?.installedState);
  if (installed.serial !== serial) fail("serial-mismatch", "requested serial does not exactly match installed-state descriptor");
  const verified = await verifyPinReleaseBundle(options);
  const installedMaximum = installed.artifacts.reduce(
    (maximum, artifact) => Math.max(maximum, artifact.versionCode),
    installed.currentRelease?.versionCode ?? 0,
  );
  if (verified.versionCode <= installedMaximum) {
    fail("version-regression", "release versionCode must be greater than the installed maximum");
  }
  if (
    installed.artifacts.some(
      (artifact) => artifact.signerSha256 !== verified.signerSha256,
    )
  ) {
    fail("signer-mismatch", "target signer is not update-compatible with every installed package");
  }
  if (
    installed.mode === "atomic" &&
    compareInstallVersions(verified.version, installed.currentRelease.version) !== 1
  ) {
    fail("version-regression", "release version must be newer than the installed current release");
  }
  return Object.freeze({
    schemaVersion: 1,
    serial,
    releaseId: verified.releaseId,
    fromVersionCode: installedMaximum,
    toVersionCode: verified.versionCode,
    operations: Object.freeze(verified.artifacts.map((artifact, index) => Object.freeze({
      order: index + 1,
      role: artifact.role,
      package: PIN_RELEASE_PACKAGE_BY_ROLE[artifact.role],
      path: artifact.path,
      sha256: artifact.sha256,
    }))),
  });
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help") return { command: "help", values: new Map() };
  if (!new Set(["inspect", "verify", "plan"]).has(command)) fail("cli-usage", `unknown command ${command}`);
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) fail("cli-usage", `expected --option value near ${flag ?? "end of input"}`);
    const key = flag.slice(2);
    if (values.has(key) && key !== "artifact") fail("cli-usage", `duplicate --${key}`);
    if (key === "artifact") values.set(key, [...(values.get(key) ?? []), value]);
    else values.set(key, value);
  }
  return { command, values };
}

function cliValue(values, key, { required = false } = {}) {
  const value = values.get(key);
  if (required && value === undefined) fail("cli-usage", `missing required --${key}`);
  return value;
}

function assertCliKeys(values, allowed) {
  for (const key of values.keys()) if (!allowed.includes(key)) fail("cli-usage", `unknown option --${key}`);
}

function cliTools(values) {
  return {
    apkanalyzer: cliValue(values, "apkanalyzer"),
    apksigner: cliValue(values, "apksigner"),
  };
}

async function runCli(argv) {
  const { command, values } = parseCli(argv);
  if (command === "help") {
    process.stdout.write(
      "Pin release host contract (read-only)\n\n" +
      "  inspect --root DIR --artifact ROLE=PATH (five times) [--signer SHA256] [--apkanalyzer PATH] [--apksigner PATH]\n" +
      "  verify --root DIR --manifest FILE --receipts FILE --signer SHA256 --history FILE [tool options]\n" +
      "  plan --root DIR --manifest FILE --receipts FILE --signer SHA256 --history FILE --installed FILE --serial SERIAL [tool options]\n",
    );
    return;
  }
  if (command === "inspect") {
    assertCliKeys(values, ["root", "artifact", "signer", "apkanalyzer", "apksigner"]);
    const artifactArgs = cliValue(values, "artifact", { required: true });
    if (artifactArgs.length !== PIN_RELEASE_ARTIFACT_ROLES.length) fail("partial-bundle", "inspect requires exactly five --artifact ROLE=PATH values");
    const artifacts = [];
    for (const entry of artifactArgs) {
      const separator = entry.indexOf("=");
      if (separator <= 0) fail("cli-usage", `invalid --artifact ${entry}; expected ROLE=PATH`);
      artifacts.push(await inspectPinReleaseArtifact({
        role: entry.slice(0, separator),
        path: entry.slice(separator + 1),
        apkRoot: cliValue(values, "root", { required: true }),
        expectedSigner: cliValue(values, "signer"),
        ...cliTools(values),
      }));
    }
    process.stdout.write(`${JSON.stringify(parsePinReleaseReceiptBundle({ schemaVersion: 1, artifacts }), null, 2)}\n`);
    return;
  }
  const commonAllowed = ["root", "manifest", "receipts", "signer", "history", "apkanalyzer", "apksigner"];
  assertCliKeys(values, command === "plan" ? [...commonAllowed, "installed", "serial"] : commonAllowed);
  const manifest = await readCanonicalManifestFile(cliValue(values, "manifest", { required: true }));
  const receipts = await readJsonFile(cliValue(values, "receipts", { required: true }), "receipts");
  const historyPath = cliValue(values, "history", { required: true });
  const common = {
    manifest,
    receipts,
    history: await readJsonFile(historyPath, "history"),
    apkRoot: cliValue(values, "root", { required: true }),
    expectedSigner: cliValue(values, "signer", { required: true }),
    ...cliTools(values),
  };
  if (command === "verify") {
    process.stdout.write(`${JSON.stringify(await verifyPinReleaseBundle(common), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(await planPinRelease({
    ...common,
    installedState: await readJsonFile(cliValue(values, "installed", { required: true }), "installed state"),
    serial: cliValue(values, "serial", { required: true }),
  }), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SELF_PATH)) {
  runCli(process.argv.slice(2)).catch((error) => {
    const code = error instanceof PinReleaseContractError ? error.code : "unexpected";
    process.stderr.write(`pin-release ${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
