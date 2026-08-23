#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PIN_RELEASE_ARTIFACT_ROLES,
  PIN_RELEASE_PACKAGE_BY_ROLE,
  canonicalPinReleaseManifestJson,
  createPinReleaseManifest,
  parseCanonicalPinReleaseManifestDocument,
  parsePinReleaseHistory,
  parsePinReleaseJson,
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
const SHA256_RE = /^[0-9a-f]{64}$/u;
const MAX_VERSION_CODE = 2_147_483_647;

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

async function regularFile(filename, label) {
  const metadata = await lstat(filename).catch((error) => {
    if (error?.code === "ENOENT") fail("input-missing", `${label} is missing: ${filename}`);
    throw error;
  });
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0) {
    fail("input-invalid", `${label} must be a nonempty regular file: ${filename}`);
  }
  return resolve(filename);
}

async function directory(filename, label, { create = false } = {}) {
  if (create) await mkdir(filename, { recursive: true, mode: 0o700 });
  const metadata = await lstat(filename).catch((error) => {
    if (error?.code === "ENOENT") fail("input-missing", `${label} is missing: ${filename}`);
    throw error;
  });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail("input-invalid", `${label} must be a directory: ${filename}`);
  }
  return resolve(filename);
}

async function sha256File(filename) {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

async function atomicWrite(filename, contents) {
  const temporary = `${filename}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, filename);
}

export function parseLiteralSigningEnvironment(source, label = "signing.env") {
  const values = {};
  const allowed = new Set(SIGNING_NAMES);
  for (const [index, rawLine] of String(source).split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) fail("signing-env-invalid", `${label}:${index + 1} is not a literal export NAME=value`);
    const [, name, raw] = match;
    if (!allowed.has(name)) fail("signing-env-invalid", `${label}:${index + 1} exports an unsupported name`);
    if (Object.hasOwn(values, name)) fail("signing-env-invalid", `${label}:${index + 1} repeats ${name}`);
    let value;
    if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
      const parts = raw.slice(1, -1).split("'\\''");
      if (parts.some((part) => part.includes("'"))) {
        fail("signing-env-invalid", `${label}:${index + 1} contains an invalid single-quoted literal`);
      }
      value = parts.join("'");
    } else if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      value = raw.slice(1, -1);
      if (value.includes('"') || value.includes("\\")) {
        fail("signing-env-invalid", `${label}:${index + 1} contains an invalid double-quoted literal`);
      }
    } else if (/^[^\s#]+$/u.test(raw)) {
      value = raw;
    } else {
      fail("signing-env-invalid", `${label}:${index + 1} is not a literal export NAME=value`);
    }
    if (!value) fail("signing-env-invalid", `${label}:${index + 1} defines blank ${name}`);
    values[name] = value;
  }
  for (const name of SIGNING_NAMES) {
    if (!Object.hasOwn(values, name)) fail("signing-env-invalid", `${label} is missing ${name}`);
  }
  return Object.freeze(values);
}

export function validatePinReleaseVersion(version, versionCode) {
  const match = /^(\d{4})-(\d{2})-(\d{2})\.(\d+)$/u.exec(String(version));
  if (!match) fail("version-invalid", "version must use YYYY-MM-DD.N");
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (
    Number.isNaN(date.valueOf()) ||
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() + 1 !== Number(match[2]) ||
    date.getUTCDate() !== Number(match[3]) ||
    Number(match[4]) < 1
  ) fail("version-invalid", "version must contain a real date and positive sequence");
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > MAX_VERSION_CODE) {
    fail("version-invalid", "versionCode must be a positive Android integer");
  }
  return Object.freeze({ version: String(version), versionCode });
}

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
  const sourceRoot = await directory(resolve(options.sourceRoot ?? SOURCE_ROOT), "source root");
  const environment = options.environment ?? process.env;
  const defaults = defaultOperatorPaths(environment);
  const signingEnvironment = await regularFile(
    options.signingEnvironment ?? defaults.signingEnvironment,
    "Pin signing environment",
  );
  const signing = parseLiteralSigningEnvironment(
    await readFile(signingEnvironment, "utf8"),
    signingEnvironment,
  );
  if (!isAbsolute(signing.PIN_SIGNING_STORE_FILE)) {
    fail("input-invalid", "PIN_SIGNING_STORE_FILE must be absolute");
  }
  const compatibilitySigningStore = await regularFile(
    options.compatibilitySigningStore ??
      environment.REVIVAL_PIN_SIGNING_STORE_FILE ??
      signing.PIN_SIGNING_STORE_FILE,
    "Pin compatibility signing store",
  );
  const embeddedPatchSigningStore = await regularFile(
    options.embeddedPatchSigningStore ??
      environment.REVIVAL_PIN_EMBEDDED_PATCH_SIGNING_STORE_FILE ??
      compatibilitySigningStore,
    "Pin embedded-patch signing store",
  );
  const privateAssets = await directory(options.privateAssets ?? defaults.privateAssets, "Pin private assets");
  for (const asset of PRIVATE_ASSETS) {
    const filename = await regularFile(join(privateAssets, asset.path), `Pin private asset ${asset.path}`);
    if ((await sha256File(filename)) !== asset.sha256) {
      fail("input-digest", `Pin private asset ${asset.path} has the wrong SHA-256`);
    }
  }
  const buildDir = await directory(options.buildDir ?? defaults.buildDir, "Pin build directory", { create: true });
  const releaseRoot = await directory(options.releaseRoot ?? defaults.releaseRoot, "Pin release store", { create: true });
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

function mount(source, target, readOnly = false) {
  return `type=bind,src=${source},dst=${target}${readOnly ? ",readonly" : ""}`;
}

export function createDockerBuildInvocation({ sourceRoot = SOURCE_ROOT, image }) {
  return Object.freeze({
    command: "docker",
    args: Object.freeze([
      "build", "--platform", "linux/amd64",
      "--file", join(sourceRoot, "platform/containers/pin-builder/Dockerfile"),
      "--tag", image,
      sourceRoot,
    ]),
  });
}

function baseRunArguments({ sourceRoot, stateDir, cacheDir, image }) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  return [
    "run", "--rm", "--init", "--platform", "linux/amd64",
    "--user", `${uid}:${gid}`,
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777,size=2g",
    "--mount", mount(sourceRoot, "/workspace", true),
    "--mount", mount(stateDir, "/state"),
    "--mount", mount(cacheDir, "/cache"),
    image,
  ];
}

export function createDockerPrefetchInvocation(options) {
  return Object.freeze({
    command: "docker",
    args: Object.freeze([
      ...baseRunArguments(options),
      "prefetch-release",
      "--version", options.version,
      "--version-code", String(options.versionCode),
    ]),
  });
}

export function createDockerRunInvocation(options) {
  const args = baseRunArguments(options);
  args.splice(args.length - 1, 0,
    "--network", "none",
    "--mount", mount(options.signingEnvironment, "/run/secrets/pin/signing.env", true),
    "--mount", mount(options.compatibilitySigningStore, "/run/secrets/pin/compatibility.keystore", true),
    "--mount", mount(options.embeddedPatchSigningStore, "/run/secrets/pin/embedded-patch.keystore", true),
    "--mount", mount(options.privateAssets, "/run/private-assets", true),
  );
  return Object.freeze({
    command: "docker",
    args: Object.freeze([
      ...args,
      "build-release",
      "--version", options.version,
      "--version-code", String(options.versionCode),
    ]),
  });
}

async function runProcess(command, args, { cwd = SOURCE_ROOT, environment = process.env } = {}) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: "inherit" });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (signal) rejectPromise(new Error(`${command} stopped by ${signal}`));
      else if (code !== 0) rejectPromise(new Error(`${command} exited with status ${code}`));
      else resolvePromise();
    });
  });
}

export async function parseBuilderMetadata({ stagingRoot, version, versionCode }) {
  const source = await readFile(join(stagingRoot, "release-metadata.tsv"), "utf8").catch(() => {
    fail("builder-output", "builder did not emit release-metadata.tsv");
  });
  const lines = source.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== PIN_RELEASE_ARTIFACT_ROLES.length) {
    fail("builder-output", "builder did not emit exactly five release roles");
  }
  const artifacts = [];
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length !== 7) fail("builder-output", "release metadata row is malformed");
    const [role, packageName, actualVersion, rawCode, signerSha256, recordedSha256, rawSize] = fields;
    if (!PIN_RELEASE_ARTIFACT_ROLES.includes(role) || packageName !== PIN_RELEASE_PACKAGE_BY_ROLE[role]) {
      fail("builder-output", "builder emitted an unknown role or package");
    }
    if (actualVersion !== version || rawCode !== String(versionCode)) {
      fail("builder-output", `${role} version identity changed`);
    }
    if (signerSha256 !== PIN_COMPATIBILITY_CERT_SHA256 || !SHA256_RE.test(recordedSha256)) {
      fail("builder-output", `${role} signing or digest identity changed`);
    }
    const size = Number(rawSize);
    const name = `${role}.apk`;
    const filename = await regularFile(join(stagingRoot, name), `${role} APK`);
    const metadata = await lstat(filename);
    if (!Number.isSafeInteger(size) || size < 1 || metadata.size !== size || (await sha256File(filename)) !== recordedSha256) {
      fail("builder-output", `${role} APK differs from builder metadata`);
    }
    artifacts.push({
      role,
      path: name,
      name,
      package: packageName,
      versionName: version,
      versionCode,
      size,
      sha256: recordedSha256,
      signerSha256,
    });
  }
  return parsePinReleaseReceiptBundle({ schemaVersion: 1, artifacts });
}

async function readHistory(releaseRoot) {
  const source = await readFile(join(releaseRoot, "history.json"), "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  return source === null
    ? parsePinReleaseHistory({ schemaVersion: 1, releases: [] })
    : parsePinReleaseHistory(parsePinReleaseJson(source, "Pin release history"));
}

async function verifyExistingRelease(directoryPath, manifest, canonical) {
  const names = (await readdir(directoryPath)).sort();
  const expected = ["manifest.json", ...manifest.artifacts.map((artifact) => artifact.name)].sort();
  if (names.join("\0") !== expected.join("\0")) fail("release-conflict", "existing release has unexpected files");
  if ((await readFile(join(directoryPath, "manifest.json"), "utf8")) !== canonical) {
    fail("release-conflict", "existing release manifest differs");
  }
  for (const artifact of manifest.artifacts) {
    const filename = join(directoryPath, artifact.name);
    const metadata = await lstat(filename);
    if (!metadata.isFile() || metadata.size !== artifact.size || (await sha256File(filename)) !== artifact.sha256) {
      fail("release-conflict", `${artifact.role} differs in existing release`);
    }
  }
}

async function publishRelease({ releaseRoot, stagingRoot, version, receipts }) {
  const history = await readHistory(releaseRoot);
  const manifest = createPinReleaseManifest({ version, receipts });
  const canonical = canonicalPinReleaseManifestJson(manifest);
  const verified = verifyPinReleaseMetadata({
    manifest,
    receipts,
    expectedSigner: PIN_COMPATIBILITY_CERT_SHA256,
    history,
  });
  const releasesRoot = join(releaseRoot, "releases");
  await mkdir(releasesRoot, { recursive: true, mode: 0o700 });
  const finalDirectory = join(releasesRoot, manifest.releaseId);
  const existing = await lstat(finalDirectory).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) fail("release-conflict", "release path is not a directory");
    await verifyExistingRelease(finalDirectory, manifest, canonical);
  } else {
    const incoming = await mkdtemp(join(releasesRoot, `.${manifest.releaseId}.`));
    try {
      await chmod(incoming, 0o700);
      for (const artifact of manifest.artifacts) {
        await copyFile(join(stagingRoot, artifact.name), join(incoming, artifact.name));
        await chmod(join(incoming, artifact.name), 0o600);
      }
      await writeFile(join(incoming, "manifest.json"), canonical, { mode: 0o600 });
      await rename(incoming, finalDirectory);
    } catch (error) {
      await rm(incoming, { recursive: true, force: true });
      throw error;
    }
  }
  const releases = history.releases.at(-1)?.releaseId === verified.historyEntry.releaseId
    ? [...history.releases]
    : [...history.releases, verified.historyEntry];
  const nextHistory = parsePinReleaseHistory({ schemaVersion: 1, releases });
  await atomicWrite(join(releaseRoot, "history.json"), `${JSON.stringify(nextHistory)}\n`);
  await atomicWrite(join(releaseRoot, "current.json"), canonical);
  return Object.freeze({
    schemaVersion: 1,
    releaseId: manifest.releaseId,
    version,
    versionCode: manifest.artifacts[0].versionCode,
    signerSha256: PIN_COMPATIBILITY_CERT_SHA256,
    releaseDirectory: finalDirectory,
    currentManifest: join(releaseRoot, "current.json"),
    artifacts: manifest.artifacts,
  });
}

export async function buildAndPublishPinRelease(options) {
  const { version, versionCode } = validatePinReleaseVersion(options.version, options.versionCode);
  const inputs = await validatePinReleaseBuildInputs(options);
  const stateDir = await directory(join(inputs.buildDir, "pin-release-state"), "Pin release state", { create: true });
  const cacheDir = await directory(join(inputs.buildDir, "pin-release-cache"), "Pin release cache", { create: true });
  const imageDigest = createHash("sha256")
    .update(await readFile(join(inputs.sourceRoot, "platform/containers/pin-builder/Dockerfile")))
    .update(await readFile(join(inputs.sourceRoot, "platform/containers/pin-builder/entrypoint.sh")))
    .digest("hex")
    .slice(0, 16);
  const image = `ai-pin-revival/pin-builder:release-${imageDigest}`;
  const runner = options.runner ?? runProcess;
  for (const invocation of [
    createDockerBuildInvocation({ sourceRoot: inputs.sourceRoot, image }),
    createDockerPrefetchInvocation({ ...inputs, stateDir, cacheDir, image, version, versionCode }),
    createDockerRunInvocation({ ...inputs, stateDir, cacheDir, image, version, versionCode }),
  ]) {
    await runner(invocation.command, invocation.args, {
      cwd: inputs.sourceRoot,
      environment: options.environment ?? process.env,
    });
  }
  const stagingRoot = join(stateDir, "release-output");
  const receipts = await parseBuilderMetadata({ stagingRoot, version, versionCode });
  return await publishRelease({ releaseRoot: inputs.releaseRoot, stagingRoot, version, receipts });
}

function help() {
  process.stdout.write(
    "Usage: ./revival pin release build --version YYYY-MM-DD.N --version-code INTEGER [--json]\n\n" +
    "Builds and signs the five Pin APKs in the pinned Docker builder, verifies their\n" +
    "packages, versions, signer, sizes, and SHA-256 digests, then publishes them to\n" +
    "the local Pin release store. It never runs ADB or touches a device.\n",
  );
}

function parseCli(argumentsList) {
  const values = { json: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--version") values.version = argumentsList[++index];
    else if (argument === "--version-code") values.versionCode = Number(argumentsList[++index]);
    else if (argument === "--json") values.json = true;
    else fail("usage", `unknown build option: ${argument ?? ""}`);
  }
  if (!values.version || !Number.isSafeInteger(values.versionCode)) {
    fail("usage", "build requires --version YYYY-MM-DD.N and --version-code INTEGER");
  }
  return values;
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
  process.stdout.write(request.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `[implemented] built and published Pin release ${result.releaseId}\n`);
}

if (resolve(process.argv[1] ?? "") === SELF_PATH) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`pin-release-build: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error?.code === "usage" ? 64 : 1;
  });
}
