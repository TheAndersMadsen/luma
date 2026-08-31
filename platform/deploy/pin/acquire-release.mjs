#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { fileURLToPath } from "node:url";

import { validatePinPayload } from "../../distribution/release-descriptor.mjs";
import {
  fetchPublishedReleaseAsset,
  resolvePublishedReleaseAsset,
  verifyPublishedReleaseBinding,
} from "../../distribution/release-proof.mjs";
import { describePinReleaseArchive, importPinRelease } from "./import-release.mjs";
import { canonicalPinReleaseRoot } from "./release-store-path.mjs";
import { canonicalPinReleaseManifestJson, compareInstallVersions } from "./release.mjs";
import { validateReleaseStore } from "./validate-release-store.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const DEFAULT_VERSION_FILE = fileURLToPath(new URL("../../distribution/version.json", import.meta.url));
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const APPLICATION = /^oci:\/\/ghcr\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/u;
const APK_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const DEFAULT_FETCH_TIMEOUT_MS = 120_000;
const DEFAULT_LOCK_TIMEOUT_MS = 120_000;

function defaultStagingRoot(releaseRoot) {
  return join(dirname(resolve(releaseRoot)), "pin-release-staging");
}

function exactRoots(releaseRoot, stagingRoot) {
  const active = resolve(releaseRoot);
  const staging = resolve(stagingRoot);
  const activeToStaging = relative(active, staging);
  const stagingToActive = relative(staging, active);
  const contains = (value) => !value ||
    (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
  if (contains(activeToStaging) || contains(stagingToActive)) {
    throw new Error("Pin release staging must be outside the active Center-mounted store");
  }
  return Object.freeze({ active, staging });
}

function exactSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== "repository\0tag" ||
      typeof value.repository !== "string" || !REPOSITORY.test(value.repository) ||
      typeof value.tag !== "string" || !TAG.test(value.tag)) {
    throw new Error("operator release source coordinates are invalid");
  }
  return Object.freeze({ repository: value.repository, tag: value.tag });
}

export async function loadBoundPinRelease(versionFile = DEFAULT_VERSION_FILE) {
  const document = JSON.parse(await readFile(versionFile, "utf8"));
  const fields = document && typeof document === "object" && !Array.isArray(document)
    ? Object.keys(document).sort().join("\0")
    : "";
  if (fields !== "application\0pin\0revision\0schemaVersion\0source\0version" ||
      document.schemaVersion !== 2 || !VERSION.test(document.version) ||
      !REVISION.test(document.revision) || !APPLICATION.test(document.application) ||
      document.source?.tag !== `v${document.version}`) {
    throw new Error("this operator release does not contain a supported matching Pin descriptor");
  }
  return Object.freeze({
    schemaVersion: 2,
    version: document.version,
    source: exactSource(document.source),
    pin: validatePinPayload(document.pin),
  });
}

async function authenticatedRelease(versionFile, fetchImpl, verifyBindingImpl) {
  const embedded = await loadBoundPinRelease(versionFile);
  return verifyBindingImpl({ embedded, fetchImpl });
}

async function exactLocalArchive(archiveFile, expected) {
  const selected = resolve(archiveFile);
  const metadata = await lstat(selected).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`bound Pin release archive does not exist: ${selected}`);
    throw error;
  });
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("bound Pin release archive must be a real regular file");
  }
  if (metadata.size !== expected.size || (await sha256File(selected)) !== expected.sha256) {
    throw new Error("bound Pin release archive does not match its embedded size and SHA-256");
  }
  return selected;
}

export function exactPinReleaseUrl({ source, pin }) {
  return `https://github.com/${source.repository}/releases/download/${source.tag}/${pin.archive}`;
}

function assertExpected(actual, expected) {
  for (const field of [
    "archive", "sha256", "size", "releaseId", "version", "versionCode",
    "signerSha256", "manifestSha256", "receiptsSha256",
  ]) {
    if (actual[field] !== expected[field]) {
      throw new Error(`downloaded Pin release ${field} does not match this operator release`);
    }
  }
}

function manifestIdentity(manifest) {
  return Object.freeze({
    manifest,
    manifestSha256: createHash("sha256")
      .update(canonicalPinReleaseManifestJson(manifest))
      .digest("hex"),
  });
}

async function currentRelease(releaseRoot) {
  const currentPath = join(releaseRoot, "current.json");
  const metadata = await lstat(currentPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return null;
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("current Pin release pointer is not a regular file");
  }
  return manifestIdentity(await validateReleaseStore(releaseRoot));
}

function matchingCurrent(current, expected) {
  if (!current) return false;
  const versionCode = current.manifest.artifacts[0].versionCode;
  return current.manifest.releaseId === expected.releaseId &&
    current.manifest.version === expected.version &&
    versionCode === expected.versionCode &&
    current.manifestSha256 === expected.manifestSha256;
}

async function currentForAcquisition(releaseRoot, expected) {
  const current = await currentRelease(releaseRoot);
  if (!current || matchingCurrent(current, expected)) return current;
  if (compareInstallVersions(current.manifest.version, expected.version) < 0) return null;
  throw new Error(
    `installed Pin release ${current.manifest.version} (${current.manifest.releaseId}) does not match ` +
    `operator release Pin ${expected.version} (${expected.releaseId}); use the matching operator release`,
  );
}

async function downloadExact({
  asset,
  target,
  expected,
  fetchImpl,
  timeoutMs,
  githubToken,
  fetchAssetImpl,
}) {
  if (asset.name !== expected.archive || asset.size !== expected.size) {
    throw new Error("Pin release asset metadata does not match this operator release");
  }
  const response = await fetchAssetImpl({ asset, fetchImpl, githubToken, timeoutMs });
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) !== expected.size) {
    throw new Error("Pin release download size does not match this operator release");
  }
  let size = 0;
  const digest = createHash("sha256");
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > expected.size) {
        callback(new Error("Pin release download exceeded its descriptor-bound size"));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(target, { flags: "wx", mode: 0o600 }));
  await chmod(target, 0o400);
  if (size !== expected.size || digest.digest("hex") !== expected.sha256) {
    throw new Error("Pin release download does not match its descriptor-bound size and SHA-256");
  }
}

function stagedDirectory(stagingRoot, expected) {
  return join(stagingRoot, "releases", expected.releaseId);
}

async function stagedRelease(stagingRoot, expected) {
  const directory = stagedDirectory(stagingRoot, expected);
  const metadata = await lstat(directory).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return null;
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("staged Pin release is not a real directory");
  }
  const entries = (await readdir(directory)).sort();
  if (entries.join("\0") !== [expected.archive, "store"].sort().join("\0")) {
    throw new Error("staged Pin release has an unexpected layout");
  }
  const archive = join(directory, expected.archive);
  const archiveMetadata = await lstat(archive);
  const storeMetadata = await lstat(join(directory, "store"));
  if (archiveMetadata.isSymbolicLink() || !archiveMetadata.isFile() ||
      storeMetadata.isSymbolicLink() || !storeMetadata.isDirectory()) {
    throw new Error("staged Pin release contains an unsafe archive or store");
  }
  const described = await describePinReleaseArchive({ archive, expectedSigner: expected.signerSha256 });
  assertExpected(described, expected);
  const stored = manifestIdentity(await validateReleaseStore(join(directory, "store")));
  if (!matchingCurrent(stored, expected)) {
    throw new Error("staged Pin release store does not match this operator release");
  }
  return Object.freeze({ archive, directory, manifest: stored.manifest });
}

function result(expected, { acquired = false, activated = false, active = false, staged = false } = {}) {
  return Object.freeze({
    schemaVersion: 1,
    compatible: active || staged,
    acquired,
    activated,
    active,
    staged,
    version: expected.version,
    versionCode: expected.versionCode,
    releaseId: expected.releaseId,
    manifestSha256: expected.manifestSha256,
  });
}

export async function checkMatchingPinRelease({
  releaseRoot = canonicalPinReleaseRoot(),
  stagingRoot = defaultStagingRoot(releaseRoot),
  versionFile = DEFAULT_VERSION_FILE,
} = {}) {
  const release = await loadBoundPinRelease(versionFile);
  const { active: root, staging: stageRoot } = exactRoots(releaseRoot, stagingRoot);
  const current = await currentForAcquisition(root, release.pin);
  if (matchingCurrent(current, release.pin)) {
    return result(release.pin, { active: true });
  }
  const staged = await stagedRelease(stageRoot, release.pin);
  if (!staged) {
    throw new Error("the matching Pin release is neither active nor staged; rerun ./revival setup production");
  }
  return result(release.pin, { staged: true });
}

export async function acquireMatchingPinRelease({
  releaseRoot = canonicalPinReleaseRoot(),
  stagingRoot = defaultStagingRoot(releaseRoot),
  versionFile = DEFAULT_VERSION_FILE,
  archiveFile = null,
  fetchImpl = globalThis.fetch,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  githubToken = process.env.GH_TOKEN,
  verifyBindingImpl = verifyPublishedReleaseBinding,
  resolveAssetImpl = resolvePublishedReleaseAsset,
  fetchAssetImpl = fetchPublishedReleaseAsset,
} = {}) {
  if (!Number.isSafeInteger(fetchTimeoutMs) || fetchTimeoutMs < 1) {
    throw new Error("Pin release fetch timeout must be a positive integer");
  }
  const release = archiveFile === null
    ? await authenticatedRelease(
      versionFile,
      fetchImpl,
      (options) => verifyBindingImpl({ ...options, githubToken }),
    )
    : await loadBoundPinRelease(versionFile);
  const localArchive = archiveFile === null ? null : await exactLocalArchive(archiveFile, release.pin);
  const { active: root, staging: stageRoot } = exactRoots(releaseRoot, stagingRoot);
  const current = await currentForAcquisition(root, release.pin);
  if (matchingCurrent(current, release.pin)) return result(release.pin, { active: true });
  if (await stagedRelease(stageRoot, release.pin)) return result(release.pin, { staged: true });

  const remoteAsset = archiveFile === null
    ? await resolveAssetImpl({
      tag: release.source.tag,
      name: release.pin.archive,
      fetchImpl,
      githubToken,
      timeoutMs: fetchTimeoutMs,
    })
    : null;

  const releases = join(stageRoot, "releases");
  await mkdir(releases, { recursive: true, mode: 0o700 });
  await chmod(stageRoot, 0o700);
  await chmod(releases, 0o700);
  let incoming = await mkdtemp(join(stageRoot, ".incoming-"));
  const archive = join(incoming, release.pin.archive);
  try {
    await chmod(incoming, 0o700);
    if (archiveFile === null) {
      await downloadExact({
        asset: remoteAsset,
        target: archive,
        expected: release.pin,
        fetchImpl,
        timeoutMs: fetchTimeoutMs,
        githubToken,
        fetchAssetImpl,
      });
    } else {
      await copyFile(localArchive, archive);
      await chmod(archive, 0o400);
    }
    const described = await describePinReleaseArchive({ archive, expectedSigner: release.pin.signerSha256 });
    assertExpected(described, release.pin);
    await importPinRelease({
      archive,
      releaseRoot: join(incoming, "store"),
      expectedSigner: release.pin.signerSha256,
    });
    // Verify the private store directly. The final staged layout is checked
    // again after the atomic publication below.
    const imported = manifestIdentity(await validateReleaseStore(join(incoming, "store")));
    if (!matchingCurrent(imported, release.pin)) {
      throw new Error("imported Pin release identity changed after verification");
    }

    const rechecked = await currentForAcquisition(root, release.pin);
    if (matchingCurrent(rechecked, release.pin)) return result(release.pin, { active: true });

    const destination = stagedDirectory(stageRoot, release.pin);
    let published = false;
    try {
      await rename(incoming, destination);
      incoming = null;
      published = true;
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
    }
    const winner = await stagedRelease(stageRoot, release.pin);
    if (!winner) throw new Error("matching Pin release staging publication disappeared");
    return result(release.pin, { acquired: published, staged: true });
  } finally {
    if (incoming) await rm(incoming, { recursive: true, force: true });
  }
}

async function lockOwner(lock) {
  try {
    return JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function reclaimAbandonedLock(lock, stagingRoot) {
  const metadata = await lstat(lock).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return true;
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Pin release activation lock is not a real directory");
  }
  const owner = await lockOwner(lock);
  if (owner && processExists(owner.pid)) return false;
  if (!owner && Date.now() - metadata.mtimeMs < 5_000) return false;
  const abandoned = join(stagingRoot, `.abandoned-activation-${randomBytes(8).toString("hex")}`);
  try {
    await rename(lock, abandoned);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  await rm(abandoned, { recursive: true, force: true });
  return true;
}

async function acquireActivationLock(stagingRoot, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Pin release activation lock timeout must be a positive integer");
  }
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  await chmod(stagingRoot, 0o700);
  const lock = join(stagingRoot, ".activation-lock");
  const token = randomBytes(16).toString("hex");
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let created = false;
    try {
      await mkdir(lock, { mode: 0o700 });
      created = true;
      await writeFile(join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, token })}\n`, {
        mode: 0o400,
        flag: "wx",
      });
      return Object.freeze({ lock, token });
    } catch (error) {
      if (created) await rm(lock, { recursive: true, force: true });
      if (error?.code !== "EEXIST") throw error;
    }
    if (await reclaimAbandonedLock(lock, stagingRoot)) continue;
    if (Date.now() >= deadline) throw new Error("timed out waiting for Pin release activation lock");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

async function releaseActivationLock({ lock, token }) {
  const owner = await lockOwner(lock);
  if (owner?.pid === process.pid && owner?.token === token) {
    await rm(lock, { recursive: true, force: true });
  }
}

async function sha256File(filename) {
  const digest = createHash("sha256");
  await pipeline(createReadStream(filename), digest);
  return digest.digest("hex");
}

async function verifyReleaseDirectory(directory, manifestSource, manifest) {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("active Pin release destination is not a real directory");
  }
  const expectedEntries = ["manifest.json", ...manifest.artifacts.map(({ name }) => name)].sort();
  if ((await readdir(directory)).sort().join("\0") !== expectedEntries.join("\0")) {
    throw new Error("active Pin release destination has an unexpected layout");
  }
  const manifestPath = join(directory, "manifest.json");
  const manifestMetadata = await lstat(manifestPath);
  if (manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile() ||
      (await readFile(manifestPath, "utf8")) !== manifestSource) {
    throw new Error("active Pin release destination conflicts with the staged release");
  }
  for (const artifact of manifest.artifacts) {
    const filename = join(directory, artifact.name);
    const artifactMetadata = await lstat(filename);
    if (artifactMetadata.isSymbolicLink() || !artifactMetadata.isFile() ||
        artifactMetadata.size !== artifact.size || (await sha256File(filename)) !== artifact.sha256) {
      throw new Error(`active ${artifact.role} artifact conflicts with the staged release`);
    }
    const handle = await open(filename, "r");
    try {
      const header = Buffer.alloc(APK_HEADER.length);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (bytesRead !== header.length || !header.equals(APK_HEADER)) {
        throw new Error(`active ${artifact.role} artifact is not an APK/ZIP file`);
      }
    } finally {
      await handle.close();
    }
  }
}

async function atomicCurrent(filename, contents) {
  const temporary = `${filename}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o400, flag: "wx" });
    await chmod(temporary, 0o444);
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function publishStagedRelease(releaseRoot, staged, expected) {
  const root = resolve(releaseRoot);
  const releases = join(root, "releases");
  await mkdir(releases, { recursive: true, mode: 0o755 });
  await chmod(root, 0o755);
  await chmod(releases, 0o755);
  const source = join(staged.directory, "store", "releases", expected.releaseId);
  const manifestSource = canonicalPinReleaseManifestJson(staged.manifest);
  let incoming = await mkdtemp(join(releases, `.${expected.releaseId}.`));
  try {
    await chmod(incoming, 0o700);
    for (const artifact of staged.manifest.artifacts) {
      const target = join(incoming, artifact.name);
      await copyFile(join(source, artifact.name), target);
      await chmod(target, 0o444);
    }
    await writeFile(join(incoming, "manifest.json"), manifestSource, { mode: 0o444, flag: "wx" });
    await verifyReleaseDirectory(incoming, manifestSource, staged.manifest);
    await chmod(incoming, 0o755);

    const destination = join(releases, expected.releaseId);
    try {
      await rename(incoming, destination);
      incoming = null;
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
      await verifyReleaseDirectory(destination, manifestSource, staged.manifest);
    }

    // This atomic pointer replacement is the activation commit. Every fallible
    // archive, copy, and APK check has completed while the previous pointer was
    // still untouched.
    await atomicCurrent(join(root, "current.json"), manifestSource);

    // Keep earlier immutable releases after the pointer switch. Requests that
    // already resolved an old manifest may still be streaming its APK URLs;
    // deletion belongs to a separate retention policy with client-safe age
    // evidence, not the activation transaction.
  } finally {
    if (incoming) await rm(incoming, { recursive: true, force: true });
  }
}

export async function activateMatchingPinRelease({
  releaseRoot = canonicalPinReleaseRoot(),
  stagingRoot = defaultStagingRoot(releaseRoot),
  versionFile = DEFAULT_VERSION_FILE,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
} = {}) {
  const release = await loadBoundPinRelease(versionFile);
  const { active: root, staging: stageRoot } = exactRoots(releaseRoot, stagingRoot);
  const lock = await acquireActivationLock(stageRoot, lockTimeoutMs);
  try {
    const current = await currentForAcquisition(root, release.pin);
    if (matchingCurrent(current, release.pin)) {
      return result(release.pin, { active: true });
    }
    const staged = await stagedRelease(stageRoot, release.pin);
    if (!staged) {
      throw new Error("the matching Pin release is not staged; rerun ./revival setup production");
    }
    await publishStagedRelease(root, staged, release.pin);
    await rm(staged.directory, { recursive: true, force: true }).catch(() => {});
    return result(release.pin, { activated: true, active: true });
  } finally {
    await releaseActivationLock(lock);
  }
}

function parseArguments(argv) {
  let mode = "acquire";
  let json = false;
  let archiveFile = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check" && mode === "acquire") mode = "check";
    else if (argument === "--activate" && mode === "acquire") mode = "activate";
    else if (argument === "--archive" && archiveFile === null) {
      const value = argv[++index];
      if (!value || value.startsWith("-")) {
        throw new Error("--archive requires a file path");
      }
      archiveFile = value;
    }
    else if (argument === "--json" && !json) json = true;
    else throw new Error("usage: revival pin release acquire [--archive FILE | --check | --activate] [--json]");
  }
  if (archiveFile !== null && mode !== "acquire") {
    throw new Error("usage: revival pin release acquire [--archive FILE | --check | --activate] [--json]");
  }
  return { mode, json, archiveFile };
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.mode === "activate" && process.env.REVIVAL_DEPLOY_CONFIRMED !== "1") {
    throw new Error("Pin release activation is reserved for a confirmed, verified production deployment");
  }
  const selected = options.mode === "check"
    ? checkMatchingPinRelease
    : options.mode === "activate"
      ? activateMatchingPinRelease
      : acquireMatchingPinRelease;
  const output = await selected(options.archiveFile === null ? undefined : { archiveFile: options.archiveFile });
  let message = `Verified matching Pin release ${output.version} (${output.releaseId})`;
  if (output.acquired) message = `Acquired and staged matching Pin release ${output.version} (${output.releaseId})`;
  if (output.activated) message = `Activated matching Pin release ${output.version} (${output.releaseId})`;
  process.stdout.write(options.json ? `${JSON.stringify(output)}\n` : `${message}\n`);
}

if (resolve(process.argv[1] || "") === resolve(SELF_PATH)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
