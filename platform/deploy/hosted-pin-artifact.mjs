#!/usr/bin/env node

/** Register and verify a downloaded Attested Pin release workflow artifact. */

import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultHostedVerifierCacheRoot,
  reverifyPersistedHostedRelease,
} from "./pin/build.mjs";
import { readLocalPinReleaseStore } from "./pin/ship.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const SOURCE_ROOT = resolve(dirname(SELF_PATH), "../..");
const STATE_NAME = "hosted-pin-release-import";
const SHA256_RE = /^[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(message);
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function canonicalJson(value) {
  return `${canonical(value)}\n`;
}

function pathWithin(parent, child) {
  const offset = relative(resolve(parent), resolve(child));
  return offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

function outsideSource(pathValue, label) {
  const selected = resolve(pathValue);
  if (pathWithin(SOURCE_ROOT, selected)) fail(`${label} must be outside the source tree`);
  return selected;
}

async function realDirectory(pathValue, label, { create = false, privateMode = false } = {}) {
  const selected = outsideSource(pathValue, label);
  if (create) await mkdir(selected, { recursive: true, mode: 0o700 });
  const metadata = await lstat(selected);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(selected) !== selected) {
    fail(`${label} must be one canonical real directory`);
  }
  if (privateMode && (metadata.mode & 0o077) !== 0) fail(`${label} must be owner-only`);
  return selected;
}

async function makePrivateFile(pathValue, label) {
  const metadata = await lstat(pathValue);
  if (metadata.isSymbolicLink() || !metadata.isFile() || await realpath(pathValue) !== resolve(pathValue)) {
    fail(`${label} must be one canonical regular file`);
  }
  await chmod(pathValue, 0o600);
}

async function privatizeCurrentStore(local) {
  await chmod(local.root, 0o700);
  await makePrivateFile(join(local.root, "history.json"), "Pin release history");
  await makePrivateFile(join(local.root, "current.json"), "Pin current release");
  const releasesRoot = join(local.root, "releases");
  await realDirectory(releasesRoot, "Pin immutable releases root");
  await chmod(releasesRoot, 0o700);
  await chmod(local.releaseDirectory, 0o700);
  for (const name of await readdir(local.releaseDirectory)) {
    await makePrivateFile(join(local.releaseDirectory, name), `Pin release ${name}`);
  }
}

async function writeExclusive(pathValue, source) {
  const handle = await open(pathValue, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try { await handle.writeFile(source); await handle.sync(); } finally { await handle.close(); }
}

async function atomicWrite(pathValue, source) {
  const temporary = `${pathValue}.${process.pid}.tmp`;
  try {
    await writeExclusive(temporary, source);
    await rename(temporary, pathValue);
    await chmod(pathValue, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function importHostedPinArtifact({
  releaseRoot,
  dataDir,
  verifierCacheRoot = defaultHostedVerifierCacheRoot(),
}) {
  const selectedReleaseRoot = await realDirectory(releaseRoot, "downloaded Pin release store");
  let local = await readLocalPinReleaseStore({ root: selectedReleaseRoot, label: "downloaded Pin release store" });
  if (local.tail === null || local.current === null) fail("downloaded Pin release store is empty");
  await privatizeCurrentStore(local);
  local = await readLocalPinReleaseStore({ root: selectedReleaseRoot, label: "downloaded Pin release store" });
  const authority = await reverifyPersistedHostedRelease({
    releaseDirectory: local.releaseDirectory,
    manifest: local.current.manifest,
    verifierCacheRoot,
  });
  const stateRoot = await realDirectory(join(outsideSource(dataDir, "operator data root"), STATE_NAME), "hosted Pin import state", {
    create: true,
    privateMode: true,
  });
  const record = {
    schema: "revival.hosted-pin-release-import",
    version: 1,
    releaseRoot: local.root,
    releaseId: local.tail.releaseId,
    versionName: local.tail.version,
    versionCode: local.tail.versionCode,
    manifestSha256: local.tail.manifestSha256,
    requestSha256: authority.requestSha256,
    releaseBundleSha256: authority.releaseBundleSha256,
    runnerInvocationUri: authority.runnerInvocationUri,
  };
  await atomicWrite(join(stateRoot, "current.json"), canonicalJson(record));
  return Object.freeze({ ok: true, ...record });
}

export async function hostedPinArtifactStatus({ dataDir, verifierCacheRoot = defaultHostedVerifierCacheRoot() }) {
  const stateRoot = await realDirectory(join(outsideSource(dataDir, "operator data root"), STATE_NAME), "hosted Pin import state", { privateMode: true });
  const source = await readFile(join(stateRoot, "current.json"), "utf8");
  let record;
  try { record = JSON.parse(source); } catch { fail("hosted Pin import state is not JSON"); }
  if (
    source !== canonicalJson(record) || record.schema !== "revival.hosted-pin-release-import" ||
    record.version !== 1 || !SHA256_RE.test(record.releaseId) || !SHA256_RE.test(record.manifestSha256) ||
    !SHA256_RE.test(record.requestSha256) || !SHA256_RE.test(record.releaseBundleSha256)
  ) fail("hosted Pin import state is invalid");
  const local = await readLocalPinReleaseStore({ root: record.releaseRoot, label: "registered Pin release store" });
  if (
    local.tail?.releaseId !== record.releaseId || local.tail?.manifestSha256 !== record.manifestSha256 ||
    local.tail?.version !== record.versionName || local.tail?.versionCode !== record.versionCode
  ) fail("registered Pin release store changed after import");
  const authority = await reverifyPersistedHostedRelease({
    releaseDirectory: local.releaseDirectory,
    manifest: local.current.manifest,
    verifierCacheRoot,
  });
  if (
    authority.requestSha256 !== record.requestSha256 ||
    authority.releaseBundleSha256 !== record.releaseBundleSha256 ||
    authority.runnerInvocationUri !== record.runnerInvocationUri
  ) fail("registered Pin release provider evidence changed after import");
  return Object.freeze({ ok: true, ...record, providerEvidence: "point-of-use-reverified" });
}

function defaultDataDir(environment = process.env) {
  return resolve(environment.REVIVAL_DATA_DIR ?? join(environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "ai-pin-revival"));
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!["import", "status"].includes(command)) fail("usage: hosted-pin-artifact.mjs import --release-root DIR [--data-dir DIR] [--verifier-cache-root DIR] [--json] | status [--data-dir DIR] [--verifier-cache-root DIR] [--json]");
  const options = { command, json: false, dataDir: defaultDataDir(), verifierCacheRoot: defaultHostedVerifierCacheRoot() };
  const seen = new Set();
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (name === "--json" && !options.json) { options.json = true; continue; }
    if (!["--release-root", "--data-dir", "--verifier-cache-root"].includes(name) || seen.has(name)) fail(`unsupported or repeated option: ${name}`);
    const value = rest[++index];
    if (!value || value.startsWith("-")) fail(`${name} requires a value`);
    seen.add(name);
    options[name.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
  }
  if (command === "import" && !options.releaseRoot) fail("--release-root is required");
  return options;
}

async function main(argv) {
  const options = parseCli(argv);
  const result = options.command === "import"
    ? await importHostedPinArtifact(options)
    : await hostedPinArtifactStatus(options);
  process.stdout.write(options.json ? canonicalJson(result) : `${options.command} passed: ${result.versionName} ${result.releaseId}\n`);
}

if (resolve(process.argv[1] ?? "") === SELF_PATH) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`hosted-pin-artifact: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
