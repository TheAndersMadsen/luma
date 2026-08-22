#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename as fsRename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRelease, readStableReleaseProfile } from "../deploy/release.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(SCRIPT_PATH), "../..");
const DISTRIBUTION_PROFILE = "distribution";
const VERSION_RECORD = "platform/distribution/version.json";
const VERSION_PATTERN = /^[0-9A-Za-z](?:[0-9A-Za-z.-]{0,62}[0-9A-Za-z])?$/;

function fail(message) {
  throw new Error(message);
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function validateVersion(version) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    fail("--version must be a portable 1-64 character release identity");
  }
  if (version.includes("..")) fail("--version must not contain consecutive dots");
  return version;
}

function pathIsWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function assertAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  fail(`refusing to replace existing distribution output: ${path}`);
}

function inodeReceipt(stat) {
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

export async function cleanupOwnedOutput(path, receipt, testHooks = {}) {
  let current;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!current.isFile() || current.isSymbolicLink() ||
      current.dev.toString() !== receipt.dev || current.ino.toString() !== receipt.ino) {
    return false;
  }
  if (typeof testHooks.afterOwnershipCheck === "function") {
    await testHooks.afterOwnershipCheck();
  }
  const quarantine = `${path}.cleanup-${process.pid}-${randomUUID()}`;
  await fsRename(path, quarantine);
  const moved = await lstat(quarantine, { bigint: true });
  if (moved.dev.toString() !== receipt.dev || moved.ino.toString() !== receipt.ino) {
    if (typeof testHooks.beforeForeignRestore === "function") {
      await testHooks.beforeForeignRestore({ quarantine });
    }
    try {
      await link(quarantine, path);
      await unlink(quarantine);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        // A foreign directory or unsupported node cannot be restored with a
        // no-replace hard link. Preserve it under quarantine for recovery.
      }
    }
    return false;
  }
  await unlink(quarantine);
  return true;
}

async function publishLinkedNoReplace(source, target) {
  const sourceStat = await lstat(source, { bigint: true });
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || sourceStat.nlink !== 1n) {
    fail(`distribution staging artifact is not one owned regular file: ${source}`);
  }
  await link(source, target);
  const receipt = inodeReceipt(sourceStat);
  try {
    const installed = await lstat(target, { bigint: true });
    if (!installed.isFile() || installed.isSymbolicLink() ||
        installed.dev !== sourceStat.dev || installed.ino !== sourceStat.ino) {
      fail(`distribution output changed during no-replace publication: ${target}`);
    }
    await unlink(source);
    const finalized = await lstat(target, { bigint: true });
    if (finalized.dev !== sourceStat.dev || finalized.ino !== sourceStat.ino ||
        finalized.nlink !== 1n) {
      fail(`distribution output changed while finalizing publication: ${target}`);
    }
    return receipt;
  } catch (error) {
    await cleanupOwnedOutput(target, receipt).catch(() => false);
    throw error;
  }
}

async function writeExclusive(path, data, mode = 0o644) {
  let handle;
  let receipt;
  try {
    handle = await open(path, "wx", mode);
    await handle.writeFile(data);
    await handle.sync();
    const opened = await handle.stat({ bigint: true });
    const installed = await lstat(path, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !installed.isFile() ||
        installed.isSymbolicLink() || opened.dev !== installed.dev || opened.ino !== installed.ino) {
      fail(`distribution output changed during exclusive publication: ${path}`);
    }
    receipt = inodeReceipt(opened);
    return receipt;
  } catch (error) {
    if (handle && !receipt) {
      try {
        receipt = inodeReceipt(await handle.stat({ bigint: true }));
      } catch {
        // Without an inode receipt, preserving the path is safer than guessing ownership.
      }
    }
    if (handle) {
      await handle.close().catch(() => {});
      handle = null;
    }
    if (receipt) await cleanupOwnedOutput(path, receipt).catch(() => false);
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function copyProfileInputs({ root, stageRoot, releaseVersion, beforeSourceStabilityCheck }) {
  const snapshot = await readStableReleaseProfile({
    profile: DISTRIBUTION_PROFILE,
    root,
    beforeSourceStabilityCheck,
  });
  let stampedVersion = false;
  for (const record of snapshot.records) {
    const target = join(stageRoot, ...record.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    const mode = Number.parseInt(record.mode, 8);
    const data = record.path === VERSION_RECORD
      ? `${JSON.stringify({ schemaVersion: 1, version: releaseVersion }, null, 2)}\n`
      : record.data;
    if (record.path === VERSION_RECORD) stampedVersion = true;
    await writeFile(target, data, { flag: "wx", mode });
    await chmod(target, mode);
  }
  if (!stampedVersion) fail(`distribution input is missing: ${VERSION_RECORD}`);
}

async function writeChecksums(outputDirectory, names) {
  const rows = [];
  for (const name of names.toSorted((left, right) => left.localeCompare(right, "en"))) {
    const data = await readFile(join(outputDirectory, name));
    rows.push(`${sha256(data)}  ${name}`);
  }
  const path = join(outputDirectory, "SHA256SUMS");
  const receipt = await writeExclusive(path, `${rows.join("\n")}\n`);
  return { path, receipt };
}

export async function buildDistribution({
  version,
  outputDirectory,
  root = DEFAULT_ROOT,
  beforeSourceStabilityCheck,
}) {
  const releaseVersion = validateVersion(version);
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0) {
    fail("build requires --output");
  }

  const sourceRoot = resolve(root);
  const outputRoot = resolve(outputDirectory);
  if (pathIsWithin(sourceRoot, outputRoot)) fail("--output must be outside the source root");
  await mkdir(outputRoot, { recursive: true });
  const outputStat = await lstat(outputRoot);
  if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) {
    fail(`distribution output must be a real directory: ${outputRoot}`);
  }
  const temporaryRoot = await mkdtemp(join(outputRoot, ".ai-pin-revival-build-"));
  const stageRoot = join(temporaryRoot, "source");
  const buildRoot = join(temporaryRoot, "build");
  const publications = [];

  try {
    await mkdir(stageRoot, { recursive: true });
    await copyProfileInputs({
      root: sourceRoot,
      stageRoot,
      releaseVersion,
      beforeSourceStabilityCheck,
    });

    const built = await buildRelease({
      profile: DISTRIBUTION_PROFILE,
      outputDirectory: buildRoot,
      root: stageRoot,
    });
    const archiveName = `ai-pin-revival-${releaseVersion}.tar.gz`;
    const manifestName = `ai-pin-revival-${releaseVersion}.manifest.json`;
    const descriptorName = `ai-pin-revival-${releaseVersion}.distribution.json`;
    for (const name of [archiveName, manifestName, descriptorName, "SHA256SUMS"]) {
      await assertAbsent(join(outputRoot, name));
    }
    const archivePath = join(outputRoot, archiveName);
    const manifestPath = join(outputRoot, manifestName);
    publications.push({
      path: archivePath,
      receipt: await publishLinkedNoReplace(built.archivePath, archivePath),
    });
    publications.push({
      path: manifestPath,
      receipt: await publishLinkedNoReplace(built.manifestPath, manifestPath),
    });

    const descriptor = {
      schemaVersion: 1,
      version: releaseVersion,
      profile: DISTRIBUTION_PROFILE,
      releaseId: built.releaseId,
      runtime: { node: "22" },
      payload: {
        kind: "full-product-source",
        archive: archiveName,
        archiveSha256: sha256(await readFile(join(outputRoot, archiveName))),
        manifest: manifestName,
        manifestSha256: sha256(await readFile(join(outputRoot, manifestName))),
      },
    };
    const descriptorPath = join(outputRoot, descriptorName);
    publications.push({
      path: descriptorPath,
      receipt: await writeExclusive(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`),
    });
    const checksum = await writeChecksums(outputRoot, [
      archiveName,
      manifestName,
      descriptorName,
    ]);
    publications.push(checksum);

    return {
      ...descriptor,
      outputDirectory: outputRoot,
      descriptor: descriptorName,
      checksums: basename(checksum.path),
    };
  } catch (error) {
    for (const publication of publications.reverse()) {
      await cleanupOwnedOutput(publication.path, publication.receipt).catch(() => false);
    }
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function parseCli(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (options.json) fail("--json may only be specified once");
      options.json = true;
      continue;
    }
    const names = { "--version": "version", "--output": "outputDirectory" };
    const key = names[argument];
    if (!key) fail(`unknown option: ${argument}`);
    if (options[key] !== undefined) fail(`${argument} may only be specified once`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${argument} requires a value`);
    options[key] = value;
    index += 1;
  }
  if (!options.version || !options.outputDirectory) {
    fail("usage: build.mjs --version VERSION --output DIR [--json]");
  }
  return options;
}

async function main(argv) {
  const options = parseCli(argv);
  const result = await buildDistribution(options);
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`built ${result.payload.archive} (${result.releaseId})\n`);
}

if (resolve(process.argv[1] ?? "") === resolve(SCRIPT_PATH)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`distribution: ${error.message}\n`);
    process.exitCode = 1;
  });
}
