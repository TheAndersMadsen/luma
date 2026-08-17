#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PIN_RELEASE_ARTIFACT_ROLES,
  PIN_RELEASE_PACKAGE_BY_ROLE,
  canonicalPinReleaseManifestJson,
  createPinReleaseManifest,
  parseCanonicalPinReleaseManifestDocument,
  parsePinReleaseJson,
  parsePinReleaseHistory,
  parsePinReleaseReceiptBundle,
  verifyPinReleaseMetadata,
} from "./release.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
export const SOURCE_ROOT = resolve(dirname(SELF_PATH), "../../..");
export const PIN_COMPATIBILITY_CERT_SHA256 =
  "d8a64e1c3a1afdc340c4b86feaacb88e2d81d66972afbd58e743b7c5b8d1cbdb";

const SIGNING_NAMES = Object.freeze([
  "PIN_SIGNING_STORE_FILE",
  "PIN_SIGNING_STORE_PASSWORD",
  "PIN_SIGNING_KEY_ALIAS",
  "PIN_SIGNING_KEY_PASSWORD",
]);
const VERSION_RE = /^(\d{4})-(\d{2})-(\d{2})\.(\d+)$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const MAX_VERSION_CODE = 2_147_483_647;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_CURRENT_BYTES = 1024 * 1024;
const MAX_HISTORY_BYTES = 1024 * 1024;
const LOCK_HELPER = String.raw`
import errno, fcntl, os, stat, sys
path = sys.argv[1]
flags = os.O_RDWR | os.O_CREAT
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
fd = os.open(path, flags, 0o600)
metadata = os.fstat(fd)
if not stat.S_ISREG(metadata.st_mode):
    print("INVALID", flush=True)
    sys.exit(74)
os.fchmod(fd, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError as error:
    if error.errno in (errno.EACCES, errno.EAGAIN):
        print("BUSY", flush=True)
        sys.exit(73)
    raise
print("READY", flush=True)
sys.stdin.buffer.read()
fcntl.flock(fd, fcntl.LOCK_UN)
os.close(fd)
`;
const PRIVATE_ASSETS = Object.freeze([
  Object.freeze({
    path: "codex-0.144.3/codex-app-server-aarch64-unknown-linux-musl",
    sha256: "3f364d7813feb8807ac0b38fb8e02654774da1f3dd93c399a695b9e24714afc1",
  }),
  Object.freeze({
    path: "tflite-2.11.0/libtensorflowlite_jni.so",
    sha256: "8e2acc968c1a2c6b92a641fe016a2f75de0bfde87548cba9972bcc36905f57ea",
  }),
]);

export class PinReleaseBuildError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PinReleaseBuildError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PinReleaseBuildError(code, message);
}

function pathIsWithin(root, candidate) {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

async function canonicalCandidate(candidate) {
  let existing = resolve(candidate);
  const suffix = [];
  while (true) {
    try {
      const canonical = await realpath(existing);
      return join(canonical, ...suffix);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      suffix.unshift(basename(existing));
      existing = parent;
    }
  }
}

async function requireOutsideSource(candidate, label, sourceRoot = SOURCE_ROOT) {
  const [selected, source] = await Promise.all([
    canonicalCandidate(candidate),
    realpath(sourceRoot),
  ]);
  if (pathIsWithin(source, selected)) {
    fail("source-boundary", `${label} must live outside the source tree`);
  }
}

async function requireProtectedFile(candidate, label, sourceRoot = SOURCE_ROOT) {
  const selected = resolve(candidate);
  await requireOutsideSource(selected, label, sourceRoot);
  let metadata;
  try {
    metadata = await lstat(selected);
  } catch (error) {
    if (error?.code === "ENOENT") fail("input-missing", `${label} is missing`);
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0) {
    fail("input-invalid", `${label} must be a nonempty regular file, not a link`);
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    fail("input-permissions", `${label} must have mode 0600`);
  }
  return selected;
}

async function requireOwnerDirectory(candidate, label, { create = false, sourceRoot = SOURCE_ROOT } = {}) {
  const selected = resolve(candidate);
  await requireOutsideSource(selected, label, sourceRoot);
  if (create) await mkdir(selected, { recursive: true, mode: 0o700 });
  let metadata;
  try {
    metadata = await lstat(selected);
  } catch (error) {
    if (error?.code === "ENOENT") fail("input-missing", `${label} is missing`);
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail("input-invalid", `${label} must be a real directory`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    fail("input-permissions", `${label} must not be accessible by group or other users`);
  }
  return selected;
}

async function sha256File(filename) {
  return new Promise((resolvePromise, rejectPromise) => {
    const digest = createHash("sha256");
    const input = createReadStream(filename);
    input.on("error", rejectPromise);
    input.on("data", (chunk) => digest.update(chunk));
    input.on("end", () => resolvePromise(digest.digest("hex")));
  });
}

export function parseLiteralSigningEnvironment(source, label = "signing.env") {
  const values = {};
  const allowed = new Set(SIGNING_NAMES);
  for (const [index, rawLine] of String(source).split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) fail("signing-env-invalid", `${label}:${index + 1} is not a literal export NAME=value`);
    const name = match[1];
    if (!allowed.has(name)) fail("signing-env-invalid", `${label}:${index + 1} exports an unsupported name`);
    if (Object.hasOwn(values, name)) fail("signing-env-invalid", `${label}:${index + 1} repeats ${name}`);
    const raw = match[2];
    let value;
    if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
      const parts = raw.slice(1, -1).split("'\\''");
      if (parts.some((part) => part.includes("'"))) {
        fail("signing-env-invalid", `${label}:${index + 1} contains an invalid single-quoted literal`);
      }
      value = parts.join("'");
    } else if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      const body = raw.slice(1, -1);
      if (body.includes('"') || body.includes("\\")) {
        fail("signing-env-invalid", `${label}:${index + 1} contains an invalid double-quoted literal`);
      }
      value = body;
    } else if (/^[^\s#]+$/u.test(raw)) {
      value = raw;
    } else {
      fail("signing-env-invalid", `${label}:${index + 1} is not a literal export NAME=value`);
    }
    if (value.length === 0) fail("signing-env-invalid", `${label}:${index + 1} defines blank ${name}`);
    values[name] = value;
  }
  for (const name of SIGNING_NAMES) {
    if (!Object.hasOwn(values, name)) fail("signing-env-invalid", `${label} is missing ${name}`);
  }
  return Object.freeze(values);
}

export function validatePinReleaseVersion(version, versionCode) {
  if (typeof version !== "string" || version !== version.trim()) {
    fail("invalid-version", "--version must use YYYY-MM-DD.N");
  }
  const match = VERSION_RE.exec(version);
  if (!match) fail("invalid-version", "--version must use YYYY-MM-DD.N");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const increment = Number(match[4]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isSafeInteger(increment) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    fail("invalid-version", "--version must name a real UTC date and safe increment");
  }
  if (
    typeof versionCode !== "number" ||
    !Number.isSafeInteger(versionCode) ||
    versionCode <= 1 ||
    versionCode > MAX_VERSION_CODE
  ) {
    fail("invalid-version-code", `--version-code must be an integer from 2 through ${MAX_VERSION_CODE}`);
  }
  return Object.freeze({ version, versionCode });
}

// Exported so `ship.mjs` resolves the SAME local store this command publishes
// to. A second copy of this path logic is how a ship would silently read an
// empty directory and report success against a release nobody built.
export function defaultOperatorPaths(environment = process.env) {
  const configDir = resolve(
    environment.REVIVAL_CONFIG_DIR ??
      join(environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ai-pin-revival"),
  );
  const secretsDir = resolve(environment.REVIVAL_SECRETS_DIR ?? join(configDir, "secrets"));
  const dataDir = resolve(
    environment.REVIVAL_DATA_DIR ??
      join(environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "ai-pin-revival"),
  );
  return Object.freeze({
    configDir,
    secretsDir,
    dataDir,
    buildDir: resolve(environment.REVIVAL_BUILD_DIR ?? join(dataDir, "build")),
    signingEnvironment: join(secretsDir, "pin", "signing.env"),
    privateAssets: resolve(environment.REVIVAL_PIN_PRIVATE_ASSETS_DIR ?? join(configDir, "pin-assets")),
    releaseRoot: resolve(environment.REVIVAL_PIN_RELEASE_OUTPUT_DIR ?? join(dataDir, "pin-releases")),
  });
}

export async function validatePinReleaseBuildInputs(options = {}) {
  const sourceRoot = resolve(options.sourceRoot ?? SOURCE_ROOT);
  const environment = options.environment ?? process.env;
  const defaults = defaultOperatorPaths(environment);
  const signingEnvironment = await requireProtectedFile(
    options.signingEnvironment ?? defaults.signingEnvironment,
    "Pin signing environment",
    sourceRoot,
  );
  const signing = parseLiteralSigningEnvironment(
    await readFile(signingEnvironment, "utf8"),
    signingEnvironment,
  );
  if (!isAbsolute(signing.PIN_SIGNING_STORE_FILE)) {
    fail("input-invalid", "PIN_SIGNING_STORE_FILE must be an absolute external path");
  }
  const compatibilitySigningStore = await requireProtectedFile(
    resolve(signing.PIN_SIGNING_STORE_FILE),
    "Pin compatibility signing store",
    sourceRoot,
  );
  const embeddedPatchSigningStore = await requireProtectedFile(
    options.embeddedPatchSigningStore ??
      environment.REVIVAL_PIN_EMBEDDED_PATCH_SIGNING_STORE_FILE ??
      compatibilitySigningStore,
    "Pin embedded-patch signing store",
    sourceRoot,
  );
  const privateAssets = await requireOwnerDirectory(
    options.privateAssets ?? defaults.privateAssets,
    "Pin private assets",
    { sourceRoot },
  );
  for (const asset of PRIVATE_ASSETS) {
    const assetPath = join(privateAssets, asset.path);
    const metadata = await lstat(assetPath).catch((error) => {
      if (error?.code === "ENOENT") fail("input-missing", `Pin private asset ${asset.path} is missing`);
      throw error;
    });
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0) {
      fail("input-invalid", `Pin private asset ${asset.path} must be a nonempty regular file`);
    }
    if (!pathIsWithin(await realpath(privateAssets), await realpath(assetPath))) {
      fail("input-invalid", `Pin private asset ${asset.path} escapes its external root`);
    }
    if ((await sha256File(assetPath)) !== asset.sha256) {
      fail("input-digest", `Pin private asset ${asset.path} has the wrong SHA-256`);
    }
  }
  const buildDir = await requireOwnerDirectory(options.buildDir ?? defaults.buildDir, "Pin build state", {
    create: true,
    sourceRoot,
  });
  const releaseRoot = await requireOwnerDirectory(options.releaseRoot ?? defaults.releaseRoot, "Pin release store", {
    create: true,
    sourceRoot,
  });
  return Object.freeze({
    sourceRoot,
    signingEnvironment,
    compatibilitySigningStore,
    embeddedPatchSigningStore,
    privateAssets,
    buildDir,
    releaseRoot,
  });
}

async function builderImageTag(sourceRoot) {
  const digest = createHash("sha256");
  for (const filename of [
    "platform/containers/pin-builder/Dockerfile",
    "platform/containers/pin-builder/entrypoint.sh",
    "platform/containers/pin-builder/toolchain.json",
    "pin/gradle/wrapper/gradle-wrapper.properties",
    "pin/injector/gradle/wrapper/gradle-wrapper.properties",
  ]) {
    digest.update(filename);
    digest.update(await readFile(join(sourceRoot, filename)));
  }
  return `ai-pin-revival/pin-builder:release-${digest.digest("hex").slice(0, 20)}`;
}

export function createDockerBuildInvocation({ sourceRoot, image }) {
  return Object.freeze({
    command: "docker",
    args: Object.freeze([
      "build",
      "--platform", "linux/amd64",
      "--file", join(sourceRoot, "platform/containers/pin-builder/Dockerfile"),
      "--tag", image,
      sourceRoot,
    ]),
  });
}

function mount(source, destination, readOnly = false) {
  return `type=bind,src=${source},dst=${destination}${readOnly ? ",readonly" : ""}`;
}

export function createDockerRunInvocation({
  sourceRoot,
  stateRoot,
  cacheRoot,
  signingEnvironment,
  compatibilitySigningStore,
  embeddedPatchSigningStore,
  privateAssets,
  image,
  version,
  versionCode,
  uid = typeof process.getuid === "function" ? process.getuid() : 1000,
  gid = typeof process.getgid === "function" ? process.getgid() : 1000,
  cargoJobs = 4,
}) {
  return Object.freeze({
    command: "docker",
    args: Object.freeze([
      "run", "--rm", "--init", "--platform", "linux/amd64", "--read-only",
      "--network", "none",
      "--user", `${uid}:${gid}`,
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--pids-limit", "512",
      "--memory", "6g",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=2147483648",
      "--mount", mount(sourceRoot, "/workspace", true),
      "--mount", mount(stateRoot, "/state"),
      "--mount", mount(cacheRoot, "/cache"),
      "--mount", mount(signingEnvironment, "/run/secrets/pin/signing.env", true),
      "--mount", mount(compatibilitySigningStore, "/run/secrets/pin/compatibility.keystore", true),
      "--mount", mount(embeddedPatchSigningStore, "/run/secrets/pin/embedded-patch.keystore", true),
      "--mount", mount(privateAssets, "/run/private-assets", true),
      "--env", "HOME=/state/home",
      "--env", "GRADLE_USER_HOME=/cache/gradle",
      "--env", "CARGO_HOME=/cache/cargo",
      "--env", "NPM_CONFIG_CACHE=/cache/npm",
      "--env", "ANDROID_USER_HOME=/cache/android",
      // runtime/core's build script embeds a pinned MiniLM ONNX model that it
      // pulls from the Hugging Face hub. Point it at the shared cache so the
      // networked phase can populate it and the offline phase can read it back;
      // the files are SHA-256 verified there, so a warm cache is not a weaker input.
      "--env", "EMBED_MODEL_CACHE_DIR=/cache/hf",
      // Cargo defaults to one rustc per visible CPU, and the container sees the
      // host's full count while being held to the memory limit above. The Rust
      // graph here has several crates that each need most of a gigabyte to
      // compile, so the default fan-out drives the cgroup out of memory and the
      // kernel reaps the Gradle daemon — which surfaces as the daemon
      // "disappearing" rather than as an OOM. Cap the fan-out to fit the cap,
      // which also makes the build's resource profile the same on any host.
      "--env", `CARGO_BUILD_JOBS=${cargoJobs}`,
      image,
      "build-release",
      "--version", version,
      "--version-code", String(versionCode),
    ]),
  });
}

export function createDockerPrefetchInvocation({
  sourceRoot,
  stateRoot,
  cacheRoot,
  image,
  version,
  versionCode,
  uid = typeof process.getuid === "function" ? process.getuid() : 1000,
  gid = typeof process.getgid === "function" ? process.getgid() : 1000,
}) {
  return Object.freeze({
    command: "docker",
    args: Object.freeze([
      "run", "--rm", "--init", "--platform", "linux/amd64", "--read-only",
      "--user", `${uid}:${gid}`,
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--pids-limit", "512",
      "--memory", "6g",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=2147483648",
      "--mount", mount(sourceRoot, "/workspace", true),
      "--mount", mount(stateRoot, "/state"),
      "--mount", mount(cacheRoot, "/cache"),
      "--env", "HOME=/state/home",
      "--env", "GRADLE_USER_HOME=/cache/gradle",
      "--env", "CARGO_HOME=/cache/cargo",
      "--env", "NPM_CONFIG_CACHE=/cache/npm",
      "--env", "ANDROID_USER_HOME=/cache/android",
      // runtime/core's build script embeds a pinned MiniLM ONNX model that it
      // pulls from the Hugging Face hub. Point it at the shared cache so the
      // networked phase can populate it and the offline phase can read it back;
      // the files are SHA-256 verified there, so a warm cache is not a weaker input.
      "--env", "EMBED_MODEL_CACHE_DIR=/cache/hf",
      image,
      "prefetch-release",
      "--version", version,
      "--version-code", String(versionCode),
    ]),
  });
}

async function defaultCommandRunner(invocation) {
  const environment = { ...process.env };
  for (const name of SIGNING_NAMES) delete environment[name];
  delete environment.REVIVAL_PIN_LEGACY_DEBUG_SIGNING_STORE_FILE;
  delete environment.REVIVAL_PIN_EMBEDDED_PATCH_SIGNING_STORE_FILE;
  await new Promise((resolvePromise, rejectPromise) => {
    const processHandle = spawn(invocation.command, invocation.args, {
      cwd: SOURCE_ROOT,
      stdio: "inherit",
      env: environment,
    });
    processHandle.once("error", (error) => rejectPromise(new PinReleaseBuildError(
      "command-failed",
      `${basename(invocation.command)} could not start: ${error.message}`,
    )));
    processHandle.once("close", (code, signal) => {
      if (code === 0 && signal === null) resolvePromise();
      else rejectPromise(new PinReleaseBuildError(
        "command-failed",
        `${basename(invocation.command)} exited unsuccessfully`,
      ));
    });
  });
}

export async function parseBuilderMetadata({ stagingRoot, version, versionCode }) {
  const metadataPath = join(stagingRoot, "release-metadata.tsv");
  const metadataStat = await lstat(metadataPath).catch((error) => {
    if (error?.code === "ENOENT") fail("builder-output", "pinned builder did not emit release metadata");
    throw error;
  });
  if (metadataStat.isSymbolicLink() || !metadataStat.isFile() || metadataStat.size > MAX_METADATA_BYTES) {
    fail("builder-output", "pinned builder release metadata is not a bounded regular file");
  }
  const lines = (await readFile(metadataPath, "utf8")).split(/\r?\n/u).filter(Boolean);
  if (lines.length !== PIN_RELEASE_ARTIFACT_ROLES.length) {
    fail("builder-output", "pinned builder did not emit exactly five release roles");
  }
  const artifacts = [];
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length !== 7) fail("builder-output", "pinned builder metadata has an invalid row");
    const [role, packageName, actualVersion, rawVersionCode, signerSha256, recordedSha256, rawSize] = fields;
    if (!PIN_RELEASE_ARTIFACT_ROLES.includes(role)) fail("builder-output", "pinned builder emitted an unknown role");
    if (packageName !== PIN_RELEASE_PACKAGE_BY_ROLE[role]) fail("builder-output", `${role} package identity changed`);
    if (actualVersion !== version || rawVersionCode !== String(versionCode)) {
      fail("builder-output", `${role} version identity changed`);
    }
    if (signerSha256 !== PIN_COMPATIBILITY_CERT_SHA256) fail("builder-output", `${role} signer identity changed`);
    if (!SHA256_RE.test(recordedSha256) || !/^[1-9][0-9]*$/u.test(rawSize)) {
      fail("builder-output", `${role} byte identity is invalid`);
    }
    const name = `${role}.apk`;
    const apk = join(stagingRoot, name);
    const apkStat = await lstat(apk).catch((error) => {
      if (error?.code === "ENOENT") fail("builder-output", `${role} APK is missing`);
      throw error;
    });
    if (apkStat.isSymbolicLink() || !apkStat.isFile() || apkStat.size !== Number(rawSize)) {
      fail("builder-output", `${role} APK size or file type changed after pinned verification`);
    }
    if ((await sha256File(apk)) !== recordedSha256) {
      fail("builder-output", `${role} APK changed after pinned verification`);
    }
    artifacts.push({
      role,
      path: name,
      name,
      package: packageName,
      versionName: actualVersion,
      versionCode,
      size: apkStat.size,
      sha256: recordedSha256,
      signerSha256,
    });
  }
  return parsePinReleaseReceiptBundle({ schemaVersion: 1, artifacts });
}

async function syncFile(filename) {
  const handle = await open(filename, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!(["EINVAL", "ENOTSUP"].includes(error?.code))) throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicWrite(filename, contents) {
  const temporary = join(dirname(filename), `.${basename(filename)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
    await chmod(filename, 0o600);
    await syncDirectory(dirname(filename));
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function acquirePublishLock(releaseRoot) {
  const lockPath = join(releaseRoot, ".publish.lock");
  const existing = await lstat(lockPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    fail("publish-lock-invalid", "Pin release publication lock is not a regular file");
  }

  const helper = spawn("python3", ["-c", LOCK_HELPER, lockPath], {
    cwd: releaseRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  let settled = false;
  let ready = false;
  let released = false;
  let lockFailure = null;
  let stdout = "";
  let stderr = "";
  await new Promise((resolvePromise, rejectPromise) => {
    const reject = (error) => {
      if (settled) return;
      settled = true;
      helper.stdin.destroy();
      helper.kill("SIGTERM");
      rejectPromise(error);
    };
    const timeout = setTimeout(() => reject(new PinReleaseBuildError(
      "publish-lock-failed",
      "Pin release publication lock helper did not become ready",
    )), 5_000);
    helper.once("error", (error) => {
      clearTimeout(timeout);
      if (ready) {
        lockFailure = new PinReleaseBuildError(
          "publish-lock-lost",
          `publication lock helper failed after acquisition: ${error.message}`,
        );
        return;
      }
      reject(new PinReleaseBuildError(
        "publish-lock-failed",
        `python3 could not start the publication lock helper: ${error.message}`,
      ));
    });
    helper.stdout.on("data", (chunk) => {
      if (settled) return;
      stdout += chunk.toString("utf8");
      if (stdout.length > 1024) {
        clearTimeout(timeout);
        reject(new PinReleaseBuildError("publish-lock-failed", "publication lock helper output was invalid"));
        return;
      }
      const response = stdout.split(/\r?\n/u)[0];
      if (response === "READY") {
        clearTimeout(timeout);
        ready = true;
        settled = true;
        resolvePromise();
      } else if (response === "BUSY") {
        clearTimeout(timeout);
        reject(new PinReleaseBuildError("publish-locked", "another Pin release publication is active"));
      } else if (response === "INVALID") {
        clearTimeout(timeout);
        reject(new PinReleaseBuildError("publish-lock-invalid", "Pin release publication lock is invalid"));
      }
    });
    helper.stderr.on("data", (chunk) => {
      if (stderr.length <= 4096) stderr += chunk.toString("utf8");
    });
    helper.once("close", (code) => {
      if (ready) {
        if (!released) {
          lockFailure = new PinReleaseBuildError(
            "publish-lock-lost",
            `publication lock helper exited unexpectedly with status ${code ?? "unknown"}`,
          );
        }
        return;
      }
      if (settled) return;
      clearTimeout(timeout);
      settled = true;
      rejectPromise(new PinReleaseBuildError(
        code === 73 ? "publish-locked" : "publish-lock-failed",
        code === 73
          ? "another Pin release publication is active"
          : `publication lock helper exited before acquiring the lock${stderr ? `: ${stderr.trim()}` : ""}`,
      ));
    });
  });

  return Object.freeze({
    assertHeld() {
      if (lockFailure || helper.exitCode !== null) {
        throw lockFailure ?? new PinReleaseBuildError(
          "publish-lock-lost",
          "publication lock helper exited unexpectedly",
        );
      }
    },
    async release() {
      if (released) return;
      released = true;
      if (helper.exitCode !== null) return;
      await new Promise((resolvePromise) => {
        helper.once("close", resolvePromise);
        helper.stdin.end();
      });
    },
  });
}

async function readHistory(releaseRoot) {
  const historyPath = join(releaseRoot, "history.json");
  let metadata;
  try {
    metadata = await lstat(historyPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_HISTORY_BYTES) {
    fail("history-invalid", "Pin release history must be a bounded regular file");
  }
  const source = await readFile(historyPath, "utf8");
  return parsePinReleaseHistory(parsePinReleaseJson(source, "Pin release history"));
}

async function readCurrentManifest(releaseRoot) {
  const currentPath = join(releaseRoot, "current.json");
  const metadata = await lstat(currentPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (metadata === null) return null;
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_CURRENT_BYTES) {
    fail("current-invalid", "Pin current release must be a bounded regular file");
  }
  const canonical = await readFile(currentPath, "utf8");
  const manifest = parseCanonicalPinReleaseManifestDocument(canonical);
  return Object.freeze({ manifest, canonical });
}

async function verifyPublishedRelease(directory, manifest, canonical) {
  const expectedEntries = ["manifest.json", ...manifest.artifacts.map((artifact) => artifact.name)].sort();
  const actualEntries = (await readdir(directory)).sort();
  if (
    actualEntries.length !== expectedEntries.length ||
    actualEntries.some((entry, index) => entry !== expectedEntries[index])
  ) {
    fail("release-equivocation", "immutable release contains missing or unexpected entries");
  }
  const manifestPath = join(directory, "manifest.json");
  const manifestStat = await lstat(manifestPath).catch(() => null);
  if (!manifestStat || manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    fail("release-equivocation", "immutable release manifest is not a regular file");
  }
  const actualManifest = await readFile(manifestPath, "utf8").catch(() => "");
  if (actualManifest !== canonical) fail("release-equivocation", "immutable release manifest differs for the same releaseId");
  for (const artifact of manifest.artifacts) {
    const filename = join(directory, artifact.name);
    const metadata = await lstat(filename).catch(() => null);
    if (!metadata || metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== artifact.size) {
      fail("release-equivocation", `${artifact.role} immutable artifact differs for the same releaseId`);
    }
    if ((await sha256File(filename)) !== artifact.sha256) {
      fail("release-equivocation", `${artifact.role} immutable artifact hash differs for the same releaseId`);
    }
  }
}

async function verifyHistoryRelease(releasesRoot, entry) {
  const immutableDirectory = join(releasesRoot, entry.releaseId);
  const immutableDirectoryStat = await lstat(immutableDirectory).catch(() => null);
  if (!immutableDirectoryStat || immutableDirectoryStat.isSymbolicLink() || !immutableDirectoryStat.isDirectory()) {
    fail("history-current-mismatch", "Pin release history entry has no real immutable directory");
  }
  const immutableCanonical = await readFile(join(immutableDirectory, "manifest.json"), "utf8").catch(() => {
    fail("history-current-mismatch", "Pin release history entry has no immutable manifest");
  });
  const immutableManifest = parseCanonicalPinReleaseManifestDocument(immutableCanonical);
  const immutableDigest = createHash("sha256").update(immutableCanonical).digest("hex");
  if (
    immutableManifest.releaseId !== entry.releaseId ||
    immutableManifest.version !== entry.version ||
    immutableManifest.artifacts[0].versionCode !== entry.versionCode ||
    immutableDigest !== entry.manifestSha256
  ) {
    fail("history-current-mismatch", "Pin release history entry differs from its immutable manifest");
  }
  await verifyPublishedRelease(immutableDirectory, immutableManifest, immutableCanonical);
  return Object.freeze({ manifest: immutableManifest, canonical: immutableCanonical });
}

async function verifyPublicationState(releaseRoot, releasesRoot) {
  const [historyValue, current] = await Promise.all([
    readHistory(releaseRoot),
    readCurrentManifest(releaseRoot),
  ]);
  if (historyValue === null) {
    if (current !== null) {
      fail("history-missing", "Pin current release exists without its anti-rollback history");
    }
    if ((await readdir(releasesRoot)).length !== 0) {
      fail("history-missing", "immutable Pin releases exist without anti-rollback metadata");
    }
    return Object.freeze({ schemaVersion: 1, releases: Object.freeze([]) });
  }
  const history = historyValue;
  const tail = history.releases.at(-1);
  if (!tail) {
    if (current !== null) fail("history-current-mismatch", "empty Pin release history has a current release");
    return history;
  }

  const immutable = await verifyHistoryRelease(releasesRoot, tail);
  if (current === null) {
    // Publication writes history before current. Recover only that exact,
    // byte-verified interrupted state while the kernel lock is held.
    await atomicWrite(join(releaseRoot, "current.json"), immutable.canonical);
  } else if (current.canonical !== immutable.canonical) {
    const previous = history.releases.at(-2);
    if (!previous || current.manifest.releaseId !== previous.releaseId) {
      fail("history-current-mismatch", "Pin current release differs from the anti-rollback history tail");
    }
    const priorImmutable = await verifyHistoryRelease(releasesRoot, previous);
    if (current.canonical !== priorImmutable.canonical) {
      fail("history-current-mismatch", "Pin current release differs from its prior anti-rollback entry");
    }
    // A crash after history publication can leave current exactly one entry
    // behind. No other mismatch is eligible for automatic repair.
    await atomicWrite(join(releaseRoot, "current.json"), immutable.canonical);
  }
  return history;
}

export async function publishPinRelease({ releaseRoot, stagingRoot, version, receipts }) {
  const safeReleaseRoot = await requireOwnerDirectory(releaseRoot, "Pin release store", { create: true });
  const safeStagingRoot = await requireOwnerDirectory(stagingRoot, "Pin release staging", { create: false });
  const releasesRoot = await requireOwnerDirectory(join(safeReleaseRoot, "releases"), "Pin immutable releases", {
    create: true,
  });
  const publicationLock = await acquirePublishLock(safeReleaseRoot);

  let incoming;
  try {
    publicationLock.assertHeld();
    const history = await verifyPublicationState(safeReleaseRoot, releasesRoot);
    publicationLock.assertHeld();
    const manifest = createPinReleaseManifest({ version, receipts });
    const canonical = canonicalPinReleaseManifestJson(manifest);
    const verified = verifyPinReleaseMetadata({
      manifest,
      receipts,
      expectedSigner: PIN_COMPATIBILITY_CERT_SHA256,
      history,
    });
    const finalDirectory = join(releasesRoot, manifest.releaseId);
    let finalStat = null;
    try {
      finalStat = await lstat(finalDirectory);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (finalStat) {
      if (finalStat.isSymbolicLink() || !finalStat.isDirectory()) {
        fail("release-equivocation", "immutable release path is not a real directory");
      }
      await verifyPublishedRelease(finalDirectory, manifest, canonical);
    } else {
      incoming = await mkdtemp(join(releasesRoot, `.${manifest.releaseId}.incoming-`));
      await chmod(incoming, 0o700);
      for (const artifact of manifest.artifacts) {
        const source = join(safeStagingRoot, artifact.name);
        const destination = join(incoming, artifact.name);
        await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
        await chmod(destination, 0o600);
        const copiedStat = await lstat(destination);
        if (copiedStat.size !== artifact.size || (await sha256File(destination)) !== artifact.sha256) {
          fail("artifact-changed", `${artifact.role} APK changed while it was published`);
        }
        await syncFile(destination);
      }
      const immutableManifest = join(incoming, "manifest.json");
      await writeFile(immutableManifest, canonical, { mode: 0o600, flag: "wx" });
      await syncFile(immutableManifest);
      await syncDirectory(incoming);
      publicationLock.assertHeld();
      await rename(incoming, finalDirectory);
      incoming = undefined;
      await syncDirectory(releasesRoot);
    }

    const lastHistory = history.releases.at(-1);
    const releases = lastHistory?.releaseId === verified.historyEntry.releaseId
      ? [...history.releases]
      : [...history.releases, verified.historyEntry];
    const nextHistory = parsePinReleaseHistory({ schemaVersion: 1, releases });
    publicationLock.assertHeld();
    await atomicWrite(join(safeReleaseRoot, "history.json"), `${JSON.stringify(nextHistory)}\n`);
    publicationLock.assertHeld();
    await atomicWrite(join(safeReleaseRoot, "current.json"), canonical);
    publicationLock.assertHeld();

    return Object.freeze({
      schemaVersion: 1,
      releaseId: manifest.releaseId,
      version: manifest.version,
      versionCode: manifest.artifacts[0].versionCode,
      signerSha256: PIN_COMPATIBILITY_CERT_SHA256,
      releaseDirectory: finalDirectory,
      currentManifest: join(safeReleaseRoot, "current.json"),
      artifacts: Object.freeze(manifest.artifacts.map((artifact) => Object.freeze({
        role: artifact.role,
        sha256: artifact.sha256,
        size: artifact.size,
      }))),
    });
  } finally {
    if (incoming) await rm(incoming, { recursive: true, force: true }).catch(() => undefined);
    await publicationLock.release();
  }
}

export async function buildAndPublishPinRelease(options) {
  const request = validatePinReleaseVersion(options.version, options.versionCode);
  const inputs = await validatePinReleaseBuildInputs(options);
  const runsRoot = await requireOwnerDirectory(join(inputs.buildDir, "pin-release-runs"), "Pin release runs", {
    create: true,
    sourceRoot: inputs.sourceRoot,
  });
  const cacheRoot = await requireOwnerDirectory(join(inputs.buildDir, "pin-builder-cache"), "Pin builder cache", {
    create: true,
    sourceRoot: inputs.sourceRoot,
  });
  for (const child of ["android", "cargo", "gradle", "hf", "npm"]) {
    await requireOwnerDirectory(join(cacheRoot, child), `Pin builder ${child} cache`, {
      create: true,
      sourceRoot: inputs.sourceRoot,
    });
  }
  const runRoot = await mkdtemp(join(runsRoot, "release-"));
  await chmod(runRoot, 0o700);
  await mkdir(join(runRoot, "home"), { mode: 0o700 });
  const image = await builderImageTag(inputs.sourceRoot);
  const runner = options.commandRunner ?? defaultCommandRunner;
  try {
    await runner(createDockerBuildInvocation({ sourceRoot: inputs.sourceRoot, image }));
    await runner(createDockerPrefetchInvocation({
      sourceRoot: inputs.sourceRoot,
      stateRoot: runRoot,
      cacheRoot,
      image,
      ...request,
      uid: options.uid,
      gid: options.gid,
    }));
    await runner(createDockerRunInvocation({
      ...inputs,
      stateRoot: runRoot,
      cacheRoot,
      image,
      ...request,
      uid: options.uid,
      gid: options.gid,
    }));
    const stagingRoot = join(runRoot, "release-output");
    const receipts = await parseBuilderMetadata({ stagingRoot, ...request });
    return await publishPinRelease({
      releaseRoot: inputs.releaseRoot,
      stagingRoot,
      version: request.version,
      receipts,
    });
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}

function help() {
  process.stdout.write(
    "Usage: ./revival pin release build --version YYYY-MM-DD.N --version-code INTEGER\n" +
    "\nBuilds five compatibility-signed APK roles in the pinned container and atomically publishes\n" +
    "them to the external Center release store. It never runs ADB or mutates a device.\n",
  );
}

function parseCli(argumentsList) {
  let version;
  let rawVersionCode;
  let json = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--version") version = argumentsList[++index];
    else if (argument === "--version-code") rawVersionCode = argumentsList[++index];
    else if (argument === "--json") json = true;
    else fail("usage", `unknown build option: ${argument ?? ""}`);
  }
  if (!version || !rawVersionCode || !/^[1-9][0-9]*$/u.test(rawVersionCode)) {
    fail("usage", "build requires --version YYYY-MM-DD.N and --version-code INTEGER");
  }
  return Object.freeze({ version, versionCode: Number(rawVersionCode), json });
}

async function main(argumentsList) {
  if (argumentsList.length === 0 || ["help", "--help", "-h"].includes(argumentsList[0])) {
    help();
    return;
  }
  const command = argumentsList.shift();
  if (command !== "build") fail("usage", "expected build");
  if (argumentsList.length === 1 && ["help", "--help", "-h"].includes(argumentsList[0])) {
    help();
    return;
  }
  const request = parseCli(argumentsList);
  const result = await buildAndPublishPinRelease(request);
  if (request.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`[implemented] built and published Pin release ${result.releaseId}\n`);
    process.stdout.write(`[unknown] no physical Pin was inspected or modified by this host-only command.\n`);
  }
}

if (resolve(process.argv[1] ?? "") === SELF_PATH) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pin-release-build: ${message}\n`);
    process.exitCode = error?.code === "usage" ? 64 : 1;
  });
}
