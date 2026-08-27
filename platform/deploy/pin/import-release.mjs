#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
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
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import {
  PIN_COMPATIBILITY_CERT_SHA256,
  PIN_RELEASE_ARTIFACT_ROLES,
  canonicalPinReleaseManifestJson,
  parseCanonicalPinReleaseManifestDocument,
  parsePinReleaseJson,
  parsePinReleaseReceiptBundle,
  verifyPinReleaseMetadata,
} from "./release.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const TAR = "/usr/bin/tar";
const APK_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const MAX_ARCHIVE_BYTES = 3 * 1024 * 1024 * 1024;
const TOP_LEVEL_RE = /^ai-pin-revival-pin-(\d{4}-\d{2}-\d{2}\.\d+)$/u;

function fail(message) {
  throw new Error(message);
}

function defaultReleaseRoot(environment = process.env) {
  const data = resolve(
    environment.REVIVAL_DATA_DIR ??
      join(environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "ai-pin-revival"),
  );
  return resolve(environment.REVIVAL_PIN_RELEASE_OUTPUT_DIR ?? join(data, "pin-releases"));
}

function runTar(args, options = {}) {
  const result = spawnSync(TAR, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    fail(result.stderr?.trim() || result.error?.message || "tar failed");
  }
  return result.stdout;
}

function inspectArchive(archive) {
  const names = runTar(["--list", "--gzip", "--file", archive])
    .split(/\r?\n/u)
    .filter(Boolean);
  const verbose = runTar(["--list", "--verbose", "--gzip", "--file", archive])
    .split(/\r?\n/u)
    .filter(Boolean);
  if (names.length !== verbose.length || names.length < 7 || names.length > 8) {
    fail("Pin release archive must contain one directory and exactly seven release files");
  }
  if (new Set(names).size !== names.length) fail("Pin release archive contains duplicate paths");
  for (const line of verbose) {
    if (line[0] !== "-" && line[0] !== "d") {
      fail("Pin release archive may contain only regular files and its top-level directory");
    }
  }

  const first = names[0].replace(/\/$/u, "").split("/")[0];
  const match = TOP_LEVEL_RE.exec(first);
  if (!match) fail("Pin release archive has an invalid top-level directory");
  const expectedFiles = new Set([
    `${first}/manifest.json`,
    `${first}/receipts.json`,
    ...PIN_RELEASE_ARTIFACT_ROLES.map((role) => `${first}/${role}.apk`),
  ]);
  const actualFiles = names.filter((name) => name !== `${first}/`);
  if (actualFiles.length !== expectedFiles.size || actualFiles.some((name) => !expectedFiles.has(name))) {
    fail("Pin release archive contains missing or unexpected files");
  }
  return Object.freeze({ directory: first, version: match[1] });
}

async function sha256File(filename) {
  const digest = createHash("sha256");
  await pipeline(createReadStream(filename), digest);
  return digest.digest("hex");
}

async function verifyApk(filename, artifact) {
  const metadata = await lstat(filename);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== artifact.size) {
    fail(`${artifact.role}.apk does not match its manifest size`);
  }
  if ((await sha256File(filename)) !== artifact.sha256) {
    fail(`${artifact.role}.apk does not match its manifest digest`);
  }
  const descriptor = await open(filename, "r");
  try {
    const header = Buffer.alloc(APK_HEADER.length);
    const { bytesRead } = await descriptor.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || !header.equals(APK_HEADER)) {
      fail(`${artifact.role}.apk is not an APK/ZIP file`);
    }
  } finally {
    await descriptor.close();
  }
}

async function atomicWrite(filename, contents, mode = 0o600) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, contents, { mode, flag: "wx" });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function verifyExtracted(directory, archiveVersion) {
  const entries = (await readdir(directory)).sort();
  const expected = [
    "manifest.json",
    "receipts.json",
    ...PIN_RELEASE_ARTIFACT_ROLES.map((role) => `${role}.apk`),
  ].sort();
  if (entries.join("\0") !== expected.join("\0")) fail("extracted Pin release has an unexpected layout");
  for (const name of entries) {
    const metadata = await lstat(join(directory, name));
    if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`Pin release member is not a regular file: ${name}`);
  }

  const manifestSource = await readFile(join(directory, "manifest.json"), "utf8");
  const manifest = parseCanonicalPinReleaseManifestDocument(manifestSource);
  if (manifest.version !== archiveVersion) fail("archive name and Pin release version disagree");
  const receipts = parsePinReleaseReceiptBundle(
    parsePinReleaseJson(await readFile(join(directory, "receipts.json"), "utf8"), "Pin release receipts"),
  );
  for (const receipt of receipts.artifacts) {
    if (receipt.path !== receipt.name) fail(`${receipt.role} receipt path must be exactly ${receipt.name}`);
  }
  verifyPinReleaseMetadata({
    manifest,
    receipts,
    expectedSigner: PIN_COMPATIBILITY_CERT_SHA256,
  });
  for (const artifact of manifest.artifacts) {
    await verifyApk(join(directory, artifact.name), artifact);
  }
  return Object.freeze({ manifest, manifestSource });
}

async function verifyPublished(directory, manifestSource, manifest) {
  const entries = (await readdir(directory)).sort();
  const expected = ["manifest.json", ...manifest.artifacts.map(({ name }) => name)].sort();
  const manifestPath = join(directory, "manifest.json");
  const manifestMetadata = await lstat(manifestPath);
  if (entries.join("\0") !== expected.join("\0") ||
      manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile() ||
      (await readFile(manifestPath, "utf8")) !== manifestSource) {
    fail("an existing release conflicts with the imported release identity");
  }
  for (const artifact of manifest.artifacts) await verifyApk(join(directory, artifact.name), artifact);
}

export async function importPinRelease({ archive, releaseRoot = defaultReleaseRoot() }) {
  const selectedArchive = resolve(archive);
  const archiveMetadata = await lstat(selectedArchive).catch((error) => {
    if (error?.code === "ENOENT") fail(`Pin release archive does not exist: ${selectedArchive}`);
    throw error;
  });
  if (archiveMetadata.isSymbolicLink() || !archiveMetadata.isFile() ||
      archiveMetadata.size < 1 || archiveMetadata.size > MAX_ARCHIVE_BYTES) {
    fail("Pin release archive must be a nonempty regular file no larger than 3 GiB");
  }
  const layout = inspectArchive(selectedArchive);
  const root = resolve(releaseRoot);
  await mkdir(root, { recursive: true, mode: 0o755 });
  await chmod(root, 0o755);
  const staging = await mkdtemp(join(root, ".import-"));
  try {
    runTar([
      "--extract", "--gzip", "--file", selectedArchive,
      "--directory", staging,
      "--no-same-owner", "--no-same-permissions",
    ]);
    const extracted = join(staging, layout.directory);
    const { manifest, manifestSource } = await verifyExtracted(extracted, layout.version);
    const releases = join(root, "releases");
    await mkdir(releases, { recursive: true, mode: 0o755 });
    await chmod(releases, 0o755);
    const destination = join(releases, manifest.releaseId);
    const existing = await lstat(destination).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) fail("release destination is not a real directory");
      await verifyPublished(destination, manifestSource, manifest);
      for (const artifact of manifest.artifacts) await chmod(join(destination, artifact.name), 0o444);
      await chmod(join(destination, "manifest.json"), 0o444);
      await chmod(destination, 0o755);
    } else {
      const incoming = await mkdtemp(join(releases, `.${manifest.releaseId}.`));
      try {
        await chmod(incoming, 0o700);
        for (const artifact of manifest.artifacts) {
          const target = join(incoming, artifact.name);
          await copyFile(join(extracted, artifact.name), target);
          await chmod(target, 0o444);
        }
        const manifestPath = join(incoming, "manifest.json");
        await writeFile(manifestPath, manifestSource, { mode: 0o444, flag: "wx" });
        await chmod(manifestPath, 0o444);
        await chmod(incoming, 0o755);
        await rename(incoming, destination);
      } catch (error) {
        await rm(incoming, { recursive: true, force: true });
        throw error;
      }
    }
    await atomicWrite(join(root, "current.json"), canonicalPinReleaseManifestJson(manifest));
    await chmod(join(root, "current.json"), 0o444);
    for (const entry of await readdir(releases)) {
      if (entry !== manifest.releaseId) await rm(join(releases, entry), { recursive: true, force: true });
    }
    return Object.freeze({
      schemaVersion: 1,
      version: manifest.version,
      releaseId: manifest.releaseId,
      releaseRoot: root,
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const args = [...argv];
  const jsonIndex = args.indexOf("--json");
  const json = jsonIndex !== -1;
  if (json) args.splice(jsonIndex, 1);
  if (args.length !== 1 || args[0].startsWith("-")) {
    fail("usage: revival pin release import ARCHIVE [--json]");
  }
  return { archive: args[0], json };
}

async function main(argv) {
  const options = parseArguments(argv);
  const result = await importPinRelease({ archive: options.archive });
  process.stdout.write(options.json
    ? `${JSON.stringify(result)}\n`
    : `Imported Pin release ${result.version} (${result.releaseId}) into ${result.releaseRoot}\n`);
}

if (resolve(process.argv[1] || "") === resolve(SELF_PATH)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
