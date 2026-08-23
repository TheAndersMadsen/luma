#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseCanonicalPinReleaseManifestDocument,
  parsePinReleaseHistory,
  parsePinReleaseJson,
} from "./release.mjs";
import { defaultOperatorPaths } from "./build.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
export const PIN_RELEASE_STORE_SCHEMA_VERSION = 1;
export const MAX_STORE_DOCUMENT_BYTES = 1024 * 1024;
export const MAX_REMOTE_REPORT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_REMOTE_RELEASE_ROOT = "/home/anders/ai-pin-revival/data/pin-releases";
export const RSYNC_UPLOAD_ATTEMPTS = 3;
export const RSYNC_UPLOAD_OPTIONS = Object.freeze(["--archive", "--partial", "--compress"]);

export class PinReleaseShipError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PinReleaseShipError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PinReleaseShipError(code, message);
}

async function sha256File(filename) {
  const bytes = await readFile(filename);
  return Object.freeze({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  });
}

async function readBounded(filename, label) {
  const metadata = await lstat(filename).catch((error) => {
    if (error?.code === "ENOENT") fail("store-missing", `${label} is missing`);
    throw error;
  });
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size < 1 || metadata.size > MAX_STORE_DOCUMENT_BYTES) {
    fail("store-invalid", `${label} must be a bounded regular file`);
  }
  return await readFile(filename, "utf8");
}

async function realDirectory(filename, label) {
  const selected = resolve(filename);
  const metadata = await lstat(selected).catch((error) => {
    if (error?.code === "ENOENT") fail("store-missing", `${label} is missing`);
    throw error;
  });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail("store-invalid", `${label} must be a directory`);
  return selected;
}

export async function readLocalPinReleaseStore({ root, label = "local Pin release store" }) {
  const storeRoot = await realDirectory(root, label);
  const currentSource = await readBounded(join(storeRoot, "current.json"), `${label} current release`);
  const historySource = await readBounded(join(storeRoot, "history.json"), `${label} history`);
  const manifest = parseCanonicalPinReleaseManifestDocument(currentSource);
  const history = parsePinReleaseHistory(parsePinReleaseJson(historySource, `${label} history`));
  const tail = history.releases.at(-1);
  if (!tail || tail.releaseId !== manifest.releaseId) {
    fail("store-invalid", `${label} history does not end at current.json`);
  }
  const releaseDirectory = await realDirectory(
    join(storeRoot, "releases", manifest.releaseId),
    `${label} release ${manifest.releaseId}`,
  );
  const expected = new Set([
    "manifest.json",
    ...manifest.artifacts.map((artifact) => artifact.name),
  ]);
  const names = (await readdir(releaseDirectory)).sort();
  if (names.length !== expected.size || names.some((name) => !expected.has(name))) {
    fail("store-invalid", `${label} current release has missing or unexpected files`);
  }
  const immutableManifest = await readBounded(
    join(releaseDirectory, "manifest.json"),
    `${label} immutable manifest`,
  );
  if (immutableManifest !== currentSource) fail("store-invalid", `${label} immutable manifest differs from current.json`);
  const entries = new Map();
  entries.set("manifest.json", await sha256File(join(releaseDirectory, "manifest.json")));
  for (const artifact of manifest.artifacts) {
    const identity = await sha256File(join(releaseDirectory, artifact.name));
    if (identity.sha256 !== artifact.sha256 || identity.size !== artifact.size) {
      fail("store-invalid", `${label} ${artifact.role} APK differs from the manifest`);
    }
    entries.set(artifact.name, identity);
  }
  return Object.freeze({
    root: storeRoot,
    releaseDirectory,
    manifest,
    history,
    tail,
    entries,
    currentSource,
    historySource,
  });
}

export function createPinReleaseShipPlan({ local, remote }) {
  const unchanged = remote?.manifest?.releaseId === local.manifest.releaseId;
  const uploads = unchanged ? [] : [
    ...[...local.entries].map(([name, identity]) => Object.freeze({ name, ...identity })),
    Object.freeze({ name: "current.json", size: Buffer.byteLength(local.currentSource) }),
    Object.freeze({ name: "history.json", size: Buffer.byteLength(local.historySource) }),
  ];
  return Object.freeze({
    releaseId: local.manifest.releaseId,
    version: local.manifest.version,
    versionCode: local.manifest.artifacts[0].versionCode,
    unchanged,
    uploads: Object.freeze(uploads),
    uploadBytes: uploads.reduce((sum, entry) => sum + entry.size, 0),
    local,
  });
}

async function atomicWrite(filename, source) {
  const temporary = `${filename}.tmp-${process.pid}`;
  await writeFile(temporary, source, { mode: 0o600 });
  await rename(temporary, filename);
}

export function createLocalTransport() {
  return Object.freeze({
    describe: () => "local",
    async inspect(remoteRoot) {
      try {
        return await readLocalPinReleaseStore({ root: remoteRoot, label: "local target Pin release store" });
      } catch (error) {
        if (error instanceof PinReleaseShipError && error.code === "store-missing") return null;
        throw error;
      }
    },
    async publish({ local, remoteRoot }) {
      await mkdir(join(remoteRoot, "releases", local.manifest.releaseId), { recursive: true, mode: 0o700 });
      for (const name of local.entries.keys()) {
        await copyFile(
          join(local.releaseDirectory, name),
          join(remoteRoot, "releases", local.manifest.releaseId, name),
        );
      }
      await atomicWrite(join(remoteRoot, "history.json"), local.historySource);
      await atomicWrite(join(remoteRoot, "current.json"), local.currentSource);
    },
  });
}

function run(command, args, { capture = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      encoding: "utf8",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (signal) rejectPromise(new Error(`${command} stopped by ${signal}`));
      else resolvePromise({ status: code, stdout, stderr });
    });
  });
}

function validateRemote(remote) {
  if (!/^[A-Za-z0-9._@-]+$/u.test(remote)) fail("usage", `unsafe SSH target: ${remote}`);
  return remote;
}

export function validateRemoteRoot(candidate) {
  if (
    typeof candidate !== "string" ||
    !candidate.startsWith("/") ||
    !/^\/[A-Za-z0-9._/-]+$/u.test(candidate) ||
    candidate.includes("//") ||
    candidate.split("/").some((part) => part === "..")
  ) fail("usage", `unsafe remote release store path: ${String(candidate)}`);
  return candidate;
}

export function createSshTransport({ remote }) {
  const target = validateRemote(remote);
  return Object.freeze({
    describe: () => target,
    async inspect(remoteRoot) {
      const root = validateRemoteRoot(remoteRoot);
      const result = await run("ssh", [target, "cat", `${root}/current.json`], { capture: true });
      if (result.status !== 0 || !result.stdout.trim()) return null;
      return Object.freeze({ manifest: parseCanonicalPinReleaseManifestDocument(result.stdout) });
    },
    async publish({ local, remoteRoot }) {
      const root = validateRemoteRoot(remoteRoot);
      const prepared = await run("ssh", [target, "mkdir", "-p", `${root}/releases`]);
      if (prepared.status !== 0) fail("remote", "could not create the remote release store");
      let lastError = null;
      for (let attempt = 1; attempt <= RSYNC_UPLOAD_ATTEMPTS; attempt += 1) {
        const result = await run("rsync", [
          ...RSYNC_UPLOAD_OPTIONS,
          `${local.root}/`,
          `${target}:${root}/`,
        ]);
        if (result.status === 0) return;
        lastError = result.status;
      }
      fail("remote", `rsync failed after ${RSYNC_UPLOAD_ATTEMPTS} attempts (status ${lastError})`);
    },
  });
}

export async function shipPinRelease({ releaseRoot, remoteRoot, transport, confirm = false }) {
  const local = await readLocalPinReleaseStore({ root: releaseRoot });
  const destination = validateRemoteRoot(remoteRoot);
  const remote = await transport.inspect(destination);
  const plan = createPinReleaseShipPlan({ local, remote });
  const summary = Object.freeze({
    releaseId: plan.releaseId,
    version: plan.version,
    versionCode: plan.versionCode,
    target: transport.describe(),
    remoteRoot: destination,
    uploads: plan.uploads,
    uploadBytes: plan.uploadBytes,
  });
  if (!confirm) return Object.freeze({ ...summary, applied: false, unchanged: plan.unchanged });
  if (!plan.unchanged) await transport.publish({ local, remoteRoot: destination });
  const verified = await transport.inspect(destination);
  if (verified?.manifest?.releaseId !== plan.releaseId) {
    fail("remote", "remote current.json does not match the shipped release");
  }
  return Object.freeze({ ...summary, applied: true, unchanged: plan.unchanged });
}

function help() {
  process.stdout.write(
    "Usage: ./revival pin release ship [--remote NAME | --local] [--remote-root PATH]\n" +
    "                                  [--release-root DIR] [--confirm] [--json]\n\n" +
    "Verifies the five-APK release store and copies it with resumable rsync. Without\n" +
    "--confirm it prints the plan and changes nothing. It never touches a Pin.\n",
  );
}

function parseCli(argumentsList) {
  const values = { confirm: false, json: false, local: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--confirm") values.confirm = true;
    else if (argument === "--json") values.json = true;
    else if (argument === "--local") values.local = true;
    else if (argument === "--remote") values.remote = argumentsList[++index];
    else if (argument === "--remote-root") values.remoteRoot = argumentsList[++index];
    else if (argument === "--release-root") values.releaseRoot = argumentsList[++index];
    else fail("usage", `unknown ship option: ${argument ?? ""}`);
  }
  if (values.local && values.remote) fail("usage", "--local and --remote are mutually exclusive");
  return values;
}

async function main(argumentsList) {
  if (argumentsList.length === 0 || ["help", "--help", "-h"].includes(argumentsList[0])) {
    help();
    return;
  }
  const command = argumentsList.shift();
  if (command !== "ship") fail("usage", "expected ship");
  if (argumentsList.length === 1 && ["help", "--help", "-h"].includes(argumentsList[0])) {
    help();
    return;
  }
  const options = parseCli(argumentsList);
  const releaseRoot = resolve(options.releaseRoot ?? defaultOperatorPaths().releaseRoot);
  const remoteRoot = options.local
    ? resolve(options.remoteRoot ?? join(dirname(releaseRoot), `${basename(releaseRoot)}-served`))
    : validateRemoteRoot(options.remoteRoot ?? DEFAULT_REMOTE_RELEASE_ROOT);
  const transport = options.local
    ? createLocalTransport()
    : createSshTransport({ remote: options.remote ?? process.env.REVIVAL_DEPLOY_REMOTE ?? "vps" });
  const result = await shipPinRelease({
    releaseRoot,
    remoteRoot,
    transport,
    confirm: options.confirm,
  });
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (!result.applied) {
    process.stdout.write(
      `[plan] ${result.releaseId} (${result.version}) -> ${result.target}:${result.remoteRoot}\n` +
      `[plan] ${result.uploads.length} file(s), ${result.uploadBytes} bytes; re-run with --confirm.\n`,
    );
  } else {
    process.stdout.write(result.unchanged
      ? `[implemented] ${result.releaseId} is already current on ${result.target}\n`
      : `[implemented] published ${result.releaseId} to ${result.target}:${result.remoteRoot}\n`);
  }
}

if (resolve(process.argv[1] ?? "") === SELF_PATH) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`pin-release-ship: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error?.code === "usage" ? 64 : 1;
  });
}
