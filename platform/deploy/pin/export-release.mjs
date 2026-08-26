#!/usr/bin/env node

import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createReproducibleTar } from "../../archive-tar.mjs";

import {
  PIN_COMPATIBILITY_CERT_SHA256,
  parsePinReleaseReceiptBundle,
} from "./release.mjs";
import { validateReleaseStore } from "./validate-release-store.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);

function defaultReleaseRoot(environment = process.env) {
  const data = resolve(
    environment.REVIVAL_DATA_DIR ??
      join(environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "ai-pin-revival"),
  );
  return resolve(environment.REVIVAL_PIN_RELEASE_OUTPUT_DIR ?? join(data, "pin-releases"));
}

export async function exportPinRelease({ output, releaseRoot = defaultReleaseRoot() }) {
  const target = resolve(output);
  const existing = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) throw new Error(`refusing to replace release archive: ${target}`);
  await mkdir(dirname(target), { recursive: true });

  const root = resolve(releaseRoot);
  const manifest = await validateReleaseStore(root);
  const releaseDirectory = join(root, "releases", manifest.releaseId);
  const receipts = parsePinReleaseReceiptBundle({
    schemaVersion: 1,
    artifacts: manifest.artifacts.map((artifact) => ({
      role: artifact.role,
      path: artifact.name,
      name: artifact.name,
      package: artifact.package,
      versionName: manifest.version,
      versionCode: artifact.versionCode,
      size: artifact.size,
      sha256: artifact.sha256,
      signerSha256: PIN_COMPATIBILITY_CERT_SHA256,
    })),
  });
  const stageParent = await mkdtemp(join(dirname(target), ".pin-export-"));
  const directoryName = `ai-pin-revival-pin-${manifest.version}`;
  const stage = join(stageParent, directoryName);
  const temporary = join(stageParent, "release.tar.gz");
  try {
    await mkdir(stage, { mode: 0o700 });
    await copyFile(join(releaseDirectory, "manifest.json"), join(stage, "manifest.json"));
    await writeFile(join(stage, "receipts.json"), `${JSON.stringify(receipts)}\n`, { mode: 0o600 });
    for (const artifact of manifest.artifacts) {
      await copyFile(join(releaseDirectory, artifact.name), join(stage, artifact.name));
    }
    for (const name of ["manifest.json", "receipts.json", ...manifest.artifacts.map(({ name }) => name)]) {
      await chmod(join(stage, name), 0o600);
    }
    await createReproducibleTar({
      parent: stageParent,
      directory: directoryName,
      archive: temporary,
    });
    await rename(temporary, target);
    return Object.freeze({
      schemaVersion: 1,
      version: manifest.version,
      releaseId: manifest.releaseId,
      archive: target,
    });
  } finally {
    await rm(stageParent, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  let output = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output" && !output) output = argv[++index];
    else if (argv[index] === "--json" && !json) json = true;
    else throw new Error(`unknown or repeated option: ${argv[index] ?? ""}`);
  }
  if (!output) throw new Error("usage: revival pin release export --output ARCHIVE [--json]");
  return { output, json };
}

async function main(argv) {
  const options = parseArguments(argv);
  const result = await exportPinRelease({ output: options.output });
  process.stdout.write(options.json
    ? `${JSON.stringify(result)}\n`
    : `Exported Pin release ${result.version} (${result.releaseId}) to ${result.archive}\n`);
}

if (resolve(process.argv[1] || "") === resolve(SELF_PATH)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
