#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRelease, loadReleaseConfig } from "../deploy/release.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(SCRIPT_PATH), "../..");
const DISTRIBUTION_PROFILE = "distribution";
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

async function copyProfileInputs({ root, stageRoot, config }) {
  const profile = config.profiles[DISTRIBUTION_PROFILE];
  if (!profile) fail(`release config has no ${DISTRIBUTION_PROFILE} profile`);

  for (const relativePath of profile.include) {
    const source = join(root, relativePath);
    const target = join(stageRoot, relativePath);
    let stat;
    try {
      stat = await lstat(source);
    } catch (error) {
      if (error?.code === "ENOENT") fail(`distribution input is missing: ${relativePath}`);
      throw error;
    }
    await mkdir(dirname(target), { recursive: true });
    if (stat.isDirectory()) {
      await cp(source, target, { recursive: true, verbatimSymlinks: true });
    } else {
      await cp(source, target, { verbatimSymlinks: true });
    }
  }
}

async function writeChecksums(outputDirectory, names) {
  const rows = [];
  for (const name of names.toSorted((left, right) => left.localeCompare(right, "en"))) {
    const data = await readFile(join(outputDirectory, name));
    rows.push(`${sha256(data)}  ${name}`);
  }
  const path = join(outputDirectory, "SHA256SUMS");
  await writeFile(path, `${rows.join("\n")}\n`, { flag: "wx" });
  return path;
}

export async function buildDistribution({ version, outputDirectory, root = DEFAULT_ROOT }) {
  const releaseVersion = validateVersion(version);
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0) {
    fail("build requires --output");
  }

  const sourceRoot = resolve(root);
  const outputRoot = resolve(outputDirectory);
  if (pathIsWithin(sourceRoot, outputRoot)) fail("--output must be outside the source root");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ai-pin-revival-distribution-"));
  const stageRoot = join(temporaryRoot, "source");
  const buildRoot = join(temporaryRoot, "build");

  try {
    await mkdir(stageRoot, { recursive: true });
    const configPath = join(sourceRoot, "platform", "deploy", "release.json");
    const config = await loadReleaseConfig(configPath);
    await copyProfileInputs({ root: sourceRoot, stageRoot, config });
    await writeFile(
      join(stageRoot, "platform", "distribution", "version.json"),
      `${JSON.stringify({ schemaVersion: 1, version: releaseVersion }, null, 2)}\n`,
    );

    const built = await buildRelease({
      profile: DISTRIBUTION_PROFILE,
      outputDirectory: buildRoot,
      root: stageRoot,
    });
    await mkdir(outputRoot, { recursive: true });

    const archiveName = `ai-pin-revival-${releaseVersion}.tar.gz`;
    const manifestName = `ai-pin-revival-${releaseVersion}.manifest.json`;
    const descriptorName = `ai-pin-revival-${releaseVersion}.distribution.json`;
    for (const name of [archiveName, manifestName, descriptorName, "SHA256SUMS"]) {
      await assertAbsent(join(outputRoot, name));
    }
    await rename(built.archivePath, join(outputRoot, archiveName));
    await rename(built.manifestPath, join(outputRoot, manifestName));

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
    await writeFile(
      join(outputRoot, descriptorName),
      `${JSON.stringify(descriptor, null, 2)}\n`,
      { flag: "wx" },
    );
    const checksumPath = await writeChecksums(outputRoot, [
      archiveName,
      manifestName,
      descriptorName,
    ]);

    return {
      ...descriptor,
      outputDirectory: outputRoot,
      descriptor: descriptorName,
      checksums: basename(checksumPath),
    };
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
