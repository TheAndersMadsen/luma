#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compareInstallVersions, parseCanonicalPinReleaseManifestDocument } from "./release.mjs";
import { defaultOperatorPaths } from "./build.mjs";
const SELF_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REMOTE_ROOT = "/home/anders/ai-pin-revival/data/pin-releases";
const MAX_DOCUMENT_BYTES = 1024 * 1024, SSH_TIMEOUT_MS = 30_000, TRANSFER_TIMEOUT_MS = 30 * 60_000;
const RSYNC_OPTIONS = Object.freeze(["--recursive", "--partial", "--delete"]);
class PinReleaseShipError extends Error { constructor(code, message) { super(message); this.name = "PinReleaseShipError"; this.code = code; } }
function fail(code, message) { throw new PinReleaseShipError(code, message); }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
async function fileIdentity(filename, label) {
  const metadata = await lstat(filename).catch((error) => {
    if (error?.code === "ENOENT") fail("store-missing", `${label} is missing`); throw error;
  });
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size < 1)
    fail("store-invalid", `${label} must be a nonempty regular file`);
  const bytes = await readFile(filename);
  if (bytes.length !== metadata.size) fail("store-invalid", `${label} changed while read`);
  return { bytes, size: bytes.length, sha256: digest(bytes) };
}
async function readDocument(filename, label) {
  const selected = await fileIdentity(filename, label);
  if (selected.size > MAX_DOCUMENT_BYTES) fail("store-invalid", `${label} is too large`);
  return selected.bytes.toString("utf8");
}
async function realDirectory(filename, label) {
  const selected = resolve(filename);
  const metadata = await lstat(selected).catch((error) => {
    if (error?.code === "ENOENT") fail("store-missing", `${label} is missing`); throw error;
  });
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(selected) !== selected)
    fail("store-invalid", `${label} must be a canonical real directory`);
  return selected;
}
const expectedNames = (manifest) => ["manifest.json", ...manifest.artifacts.map((artifact) => artifact.name)].sort();
function requireSafeMembers(entries, allowed, label, complete = false) {
  if ((complete && entries.length !== allowed.length) ||
      entries.some((entry) => !entry.isFile() || !allowed.includes(entry.name)))
    fail("store-invalid", `${label} has unsafe, missing, or unexpected files`);
}
async function verifyLocalRelease(directory, manifest, canonical, label) {
  const root = await realDirectory(directory, label);
  requireSafeMembers(await readdir(root, { withFileTypes: true }), expectedNames(manifest), label, true);
  if (await readDocument(posix.join(root, "manifest.json"), `${label} manifest`) !== canonical)
    fail("store-invalid", `${label} manifest differs from current.json`);
  const files = new Map([["manifest.json", { size: Buffer.byteLength(canonical), sha256: digest(canonical) }]]);
  for (const artifact of manifest.artifacts) {
    const selected = await fileIdentity(posix.join(root, artifact.name), `${label} ${artifact.role} APK`);
    if (selected.size !== artifact.size || selected.sha256 !== artifact.sha256)
      fail("store-invalid", `${label} ${artifact.role} APK differs from its manifest`);
    files.set(artifact.name, { size: selected.size, sha256: selected.sha256 });
  }
  return { root, files };
}
export async function readLocalPinReleaseStore({ root, label = "local Pin release store" }) {
  const storeRoot = await realDirectory(root, label);
  const entries = await readdir(storeRoot, { withFileTypes: true });
  if (entries.length !== 2 ||
      !entries.some((entry) => entry.name === "current.json" && entry.isFile()) ||
      !entries.some((entry) => entry.name === "releases" && entry.isDirectory()))
    fail("store-invalid", `${label} must contain only current.json and releases`);
  const currentSource = await readDocument(posix.join(storeRoot, "current.json"), `${label} current.json`);
  const manifest = parseCanonicalPinReleaseManifestDocument(currentSource);
  const release = await verifyLocalRelease(posix.join(storeRoot, "releases", manifest.releaseId),
    manifest, currentSource, `${label} immutable release`);
  return Object.freeze({ root: storeRoot, releaseDirectory: release.root, entries: release.files,
    manifest, currentSource, verified: true });
}
export function createPinReleaseShipPlan({ local, remote }) {
  if (remote && remote.verified !== true) fail("remote", "remote release was not fully verified");
  const same = remote?.manifest?.releaseId === local.manifest.releaseId;
  if (same && remote.currentSource !== local.currentSource) fail("remote", "matching releaseId has different manifest bytes");
  if (remote?.manifest && !same) {
    const localCode = local.manifest.artifacts[0].versionCode;
    const remoteCode = remote.manifest.artifacts[0].versionCode;
    if (compareInstallVersions(local.manifest.version, remote.manifest.version) !== 1 || localCode <= remoteCode)
      fail("version-regression", "version and versionCode must both advance beyond remote current");
  }
  const uploads = same ? [] : [
    ...[...local.entries].map(([name, value]) => ({ name, ...value })),
    { name: "current.json", size: Buffer.byteLength(local.currentSource) },
  ];
  return Object.freeze({ releaseId: local.manifest.releaseId, version: local.manifest.version,
    versionCode: local.manifest.artifacts[0].versionCode, unchanged: same, uploads: Object.freeze(uploads),
    uploadBytes: uploads.reduce((sum, file) => sum + file.size, 0) });
}
async function missing(filename) {
  return await lstat(filename).then(() => false, (error) => {
    if (error?.code === "ENOENT") return true;
    throw error;
  });
}
async function inspectPreparedLocal(root, desired) {
  if (!desired) fail("store-invalid", "target exists without current.json");
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length !== 1 || entries[0].name !== "releases" || !entries[0].isDirectory())
    fail("store-invalid", "partial target root is corrupt");
  const releases = await realDirectory(posix.join(root, "releases"), "target releases");
  const staging = `.incoming-${desired.manifest.releaseId}`;
  const partial = await readdir(releases, { withFileTypes: true });
  if (partial.length !== 1 || partial[0].name !== staging || !partial[0].isDirectory())
    fail("store-invalid", "partial target releases are corrupt");
  await realDirectory(posix.join(releases, staging), "release staging");
  requireSafeMembers(await readdir(posix.join(releases, staging), { withFileTypes: true }),
    expectedNames(desired.manifest), "release staging");
  return Object.freeze({ prepared: true, verified: true, manifest: null, currentSource: null });
}
export function createLocalTransport() {
  const transport = {
    describe: () => "local",
    async inspect(remoteRoot, desired) {
      const root = resolve(remoteRoot);
      if (await missing(root)) return null;
      await realDirectory(root, "local target Pin release store");
      return await missing(posix.join(root, "current.json"))
        ? inspectPreparedLocal(root, desired)
        : readLocalPinReleaseStore({ root, label: "local target Pin release store" });
    },
    async publish({ local, remote, remoteRoot }) {
      const root = resolve(remoteRoot);
      await realDirectory(dirname(root), "local target parent");
      if (await missing(root)) await mkdir(root, { mode: 0o700 });
      await realDirectory(root, "local target root");
      const releases = posix.join(root, "releases");
      if (await missing(releases)) await mkdir(releases, { mode: 0o700 });
      await realDirectory(releases, "local target releases");
      const final = posix.join(releases, local.manifest.releaseId);
      const staging = posix.join(releases, `.incoming-${local.manifest.releaseId}`);
      if (await missing(final)) {
        if (await missing(staging)) await mkdir(staging, { mode: 0o700 });
        else {
          await realDirectory(staging, "local release staging");
          requireSafeMembers(await readdir(staging, { withFileTypes: true }),
            expectedNames(local.manifest), "local release staging");
        }
        for (const name of local.entries.keys())
          await copyFile(posix.join(local.releaseDirectory, name), posix.join(staging, name));
        await verifyLocalRelease(staging, local.manifest, local.currentSource, "local staged release");
        await rename(staging, final);
      }
      await verifyLocalRelease(final, local.manifest, local.currentSource, "local published release");
      if (!await missing(staging)) {
        await realDirectory(staging, "local stale release staging");
        requireSafeMembers(await readdir(staging, { withFileTypes: true }),
          expectedNames(local.manifest), "local stale release staging");
        await rm(staging, { recursive: true });
      }
      const pointer = posix.join(releases, `.current-${local.manifest.releaseId}.tmp`);
      await writeFile(pointer, local.currentSource, { mode: 0o600 });
      const current = posix.join(root, "current.json");
      const actual = await missing(current) ? null : await readDocument(current, "local current.json");
      if (actual !== (remote?.currentSource ?? null)) {
        const installed = await transport.inspect(root, local);
        if (installed?.currentSource === local.currentSource) return await rm(pointer, { force: true });
        fail("remote", "local current.json changed during publication");
      }
      await rename(pointer, current);
    },
  };
  return Object.freeze(transport);
}
function run(command, args, { capture = false, timeoutMs = SSH_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "", stderr = "", timedOut = false;
    if (capture) { child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); }
    const timer = setTimeout(() => {
      timedOut = true; child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    timer.unref();
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => { clearTimeout(timer);
      if (timedOut) rejectPromise(new Error(`${command} exceeded ${timeoutMs}ms`));
      else if (signal) rejectPromise(new Error(`${command} stopped by ${signal}`));
      else resolvePromise({ status: code, stdout, stderr });
    });
  });
}
export function validateSshTarget(value) {
  const match = typeof value === "string" &&
    /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u.exec(value);
  const host = value?.split("@").at(-1);
  if (!match || value.startsWith("-") || host.split(".").some((part) =>
    !part || part.length > 63 || part.startsWith("-") || part.endsWith("-")))
    fail("usage", `unsafe SSH target: ${String(value)}`);
  return value;
}
export function validateRemoteRoot(value) {
  if (typeof value !== "string" || value === "/" || !posix.isAbsolute(value) || value.endsWith("/") ||
      posix.normalize(value) !== value || !/^\/[A-Za-z0-9._/-]+$/u.test(value))
    fail("usage", `unsafe remote release store path: ${String(value)}`);
  return value;
}
export function createSshTransport({ remote, execute = run }) {
  const target = validateSshTarget(remote);
  const options = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
  const ssh = (args, capture = false) => execute("ssh", [...options, target, ...args], { capture, timeoutMs: SSH_TIMEOUT_MS });
  const quote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
  const requireSsh = async (args, label) => {
    const result = await ssh(args);
    if (result.status !== 0) fail("remote", `${label} failed (status ${result.status})`);
  };
  const info = async (path) => {
    const result = await ssh(["stat", "--format=%f:%s", "--", path], true);
    if (result.status !== 0) return null;
    const match = /^([0-9a-f]+):(\d+)\n?$/u.exec(result.stdout ?? "");
    if (!match) fail("remote", `invalid metadata for ${path}`);
    return { mode: Number.parseInt(match[1], 16) & 0xf000, size: Number(match[2]) };
  };
  const requireDirectory = async (path, label) => {
    const metadata = await info(path), canonical = await ssh(["realpath", "-e", "--", path], true);
    if (metadata?.mode !== 0x4000 || canonical.status !== 0 || canonical.stdout.trimEnd() !== path)
      fail("remote", `${label} must be a canonical real directory`);
  };
  const remoteDocument = async (path, label) => {
    const metadata = await info(path);
    if (metadata?.mode !== 0x8000 || metadata.size < 1 || metadata.size > MAX_DOCUMENT_BYTES)
      fail("remote", `${label} must be a bounded regular file`);
    const result = await ssh(["cat", "--", path], true);
    if (result.status !== 0 || Buffer.byteLength(result.stdout ?? "") !== metadata.size) fail("remote", `could not read ${label}`);
    return result.stdout;
  };
  const list = async (path) => {
    const result = await ssh(["find", path, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\0%y\0"], true);
    if (result.status !== 0) fail("remote", `could not list ${path}`);
    const fields = (result.stdout ?? "").split("\0"); fields.pop();
    if (fields.length % 2) fail("remote", `invalid listing for ${path}`);
    return Array.from({ length: fields.length / 2 }, (_, index) =>
      ({ name: fields[index * 2], type: fields[index * 2 + 1] }));
  };
  const verifyRelease = async (path, manifest, canonical) => {
    await requireDirectory(path, "remote release directory");
    const entries = await list(path), expected = expectedNames(manifest);
    if (entries.length !== expected.length || entries.some((entry) => entry.type !== "f" || !expected.includes(entry.name)))
      fail("remote", "remote release has missing or unexpected files");
    if (await remoteDocument(posix.join(path, "manifest.json"), "remote manifest") !== canonical)
      fail("remote", "remote immutable manifest differs from current.json");
    for (const artifact of manifest.artifacts) {
      const filename = posix.join(path, artifact.name);
      const metadata = await info(filename);
      const hashed = await ssh(["sha256sum", "--", filename], true);
      if (metadata?.mode !== 0x8000 || metadata.size !== artifact.size || hashed.status !== 0 ||
          hashed.stdout !== `${artifact.sha256}  ${filename}\n`)
        fail("remote", `remote ${artifact.role} APK differs from its manifest`);
    }
  };
  const upload = async (source, destination) => {
    let status;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await execute("rsync", [...RSYNC_OPTIONS,
        "--rsh=ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3",
        source, `${target}:${destination}`], { timeoutMs: TRANSFER_TIMEOUT_MS });
      status = result.status;
      if (status === 0) return;
    }
    fail("remote", `rsync failed after 3 attempts (status ${status})`);
  };
  const transport = {
    describe: () => target,
    async inspect(remoteRoot, desired) {
      const root = validateRemoteRoot(remoteRoot);
      if (await info(root) === null) return null;
      await requireDirectory(root, "remote release root");
      const entries = await list(root);
      if (!entries.some((entry) => entry.name === "current.json")) {
        if (!desired || entries.length !== 1 || entries[0].name !== "releases" || entries[0].type !== "d") {
          fail("store-invalid", "remote root exists without a valid current.json");
        }
        const releases = posix.join(root, "releases");
        await requireDirectory(releases, "remote releases");
        const partial = await list(releases);
        const staging = `.incoming-${desired.manifest.releaseId}`;
        if (partial.length !== 1 || partial[0].name !== staging || partial[0].type !== "d") {
          fail("store-invalid", "remote partial release root is corrupt");
        }
        await requireDirectory(posix.join(releases, staging), "remote staging");
        const staged = await list(posix.join(releases, staging)), expected = expectedNames(desired.manifest);
        if (staged.some((entry) => entry.type !== "f" || !expected.includes(entry.name)))
          fail("store-invalid", "remote staging contains unsafe or unexpected files");
        return Object.freeze({ prepared: true, verified: true, manifest: null, currentSource: null });
      }
      if (entries.length !== 2 || entries.some((entry) =>
        !((entry.name === "current.json" && entry.type === "f") || (entry.name === "releases" && entry.type === "d")))) {
        fail("store-invalid", "remote release root has unexpected files");
      }
      const currentSource = await remoteDocument(posix.join(root, "current.json"), "remote current.json");
      const manifest = parseCanonicalPinReleaseManifestDocument(currentSource);
      await verifyRelease(posix.join(root, "releases", manifest.releaseId), manifest, currentSource);
      return Object.freeze({ manifest, currentSource, verified: true });
    },
    async publish({ local, remote: previous, remoteRoot }) {
      const root = validateRemoteRoot(remoteRoot);
      await requireDirectory(posix.dirname(root), "remote release parent");
      if (await info(root) === null) await requireSsh(["mkdir", "--", root], "remote release root creation");
      await requireDirectory(root, "remote release root");
      const releases = posix.join(root, "releases");
      if (await info(releases) === null) await requireSsh(["mkdir", "--", releases], "remote releases creation");
      await requireDirectory(releases, "remote releases");
      const final = posix.join(releases, local.manifest.releaseId);
      const staging = posix.join(releases, `.incoming-${local.manifest.releaseId}`);
      if (await info(final) === null) {
        if (await info(staging) === null) await requireSsh(["mkdir", "--", staging], "remote staging creation");
        await requireDirectory(staging, "remote staging");
        const partial = await list(staging), expected = expectedNames(local.manifest);
        if (partial.some((entry) => entry.type !== "f" || !expected.includes(entry.name))) {
          fail("remote", "remote staging contains unsafe or unexpected files");
        }
        await upload(`${local.releaseDirectory}/`, `${staging}/`);
        await verifyRelease(staging, local.manifest, local.currentSource);
        const moved = await ssh(["mv", "-T", "--", staging, final]);
        if (moved.status !== 0) {
          await verifyRelease(final, local.manifest, local.currentSource);
          await requireSsh(["rm", "-rf", "--", staging], "remote staging cleanup");
        }
      }
      await verifyRelease(final, local.manifest, local.currentSource);
      if (await info(staging) !== null) {
        await requireDirectory(staging, "remote stale staging");
        const stale = await list(staging), expected = expectedNames(local.manifest);
        if (stale.some((entry) => entry.type !== "f" || !expected.includes(entry.name)))
          fail("remote", "remote stale staging contains unsafe or unexpected files");
        await requireSsh(["rm", "-rf", "--", staging], "remote stale staging cleanup");
      }
      const pointer = posix.join(releases, `.current-${local.manifest.releaseId}.tmp`);
      const pointerInfo = await info(pointer);
      if (pointerInfo && pointerInfo.mode !== 0x8000) fail("remote", "remote current staging is unsafe");
      await upload(posix.join(local.root, "current.json"), pointer);
      if (await remoteDocument(pointer, "remote current staging") !== local.currentSource) {
        fail("remote", "remote current staging differs from release");
      }
      const current = posix.join(root, "current.json");
      const expected = previous?.currentSource == null
        ? `[ ! -e ${quote(current)} ] && [ ! -L ${quote(current)} ]`
        : `[ ! -L ${quote(current)} ] && [ "$(sha256sum -- ${quote(current)} | cut -d ' ' -f 1)" = ${quote(digest(previous.currentSource))} ]`;
      const script = `set -eu; ${expected} || exit 73; [ "$(sha256sum -- ${quote(pointer)} | cut -d ' ' -f 1)" = ${quote(digest(local.currentSource))} ] || exit 74; mv -T -f -- ${quote(pointer)} ${quote(current)}`;
      const committed = await ssh([`flock -x ${quote(root)} sh -c ${quote(script)}`]);
      if (committed.status === 73) {
        const installed = await transport.inspect(root, local);
        if (installed?.currentSource === local.currentSource) {
          await requireSsh(["rm", "-f", "--", pointer], "remote current staging cleanup");
          return;
        }
        fail("remote", "remote current.json changed during publication");
      }
      if (committed.status !== 0) fail("remote", `remote current publication failed (status ${committed.status})`);
    },
  };
  return Object.freeze(transport);
}
export async function shipPinRelease({ releaseRoot, remoteRoot, transport, confirm = false }) {
  const local = await readLocalPinReleaseStore({ root: releaseRoot });
  const destination = validateRemoteRoot(remoteRoot);
  const remote = await transport.inspect(destination, local);
  const plan = createPinReleaseShipPlan({ local, remote });
  const summary = {
    releaseId: plan.releaseId, version: plan.version, versionCode: plan.versionCode,
    target: transport.describe(), remoteRoot: destination, uploads: plan.uploads, uploadBytes: plan.uploadBytes,
  };
  if (!confirm) return Object.freeze({ ...summary, applied: false, unchanged: plan.unchanged });
  if (!plan.unchanged) await transport.publish({ local, remote, remoteRoot: destination });
  const verified = await transport.inspect(destination, local);
  if (verified?.currentSource !== local.currentSource || verified?.manifest?.releaseId !== plan.releaseId) {
    fail("remote", "published release did not become current");
  }
  return Object.freeze({ ...summary, applied: true, unchanged: plan.unchanged });
}
function help() {
  process.stdout.write("Usage: ./revival pin release ship [--remote NAME | --local] [--remote-root PATH]\n" +
    "                                  [--release-root DIR] [--confirm] [--json]\n");
}
function parseCli(args) {
  let values;
  try {
    ({ values } = parseArgs({ args, strict: true, options: {
      confirm: { type: "boolean", default: false }, json: { type: "boolean", default: false },
      local: { type: "boolean", default: false }, remote: { type: "string" },
      "remote-root": { type: "string" }, "release-root": { type: "string" },
    } }));
  } catch (error) { fail("usage", error.message); }
  if (values.local && values.remote) fail("usage", "--local and --remote are mutually exclusive");
  return { ...values, remoteRoot: values["remote-root"], releaseRoot: values["release-root"] };
}
async function main(args) {
  if (args.length === 0 || ["help", "--help", "-h"].includes(args[0])) return help();
  if (args.shift() !== "ship") fail("usage", "expected ship");
  if (args.length === 1 && ["help", "--help", "-h"].includes(args[0])) return help();
  const options = parseCli(args);
  const releaseRoot = resolve(options.releaseRoot ?? defaultOperatorPaths().releaseRoot);
  const remoteRoot = options.local ? resolve(options.remoteRoot ??
    posix.join(dirname(releaseRoot), `${basename(releaseRoot)}-served`)) : validateRemoteRoot(options.remoteRoot ?? DEFAULT_REMOTE_ROOT);
  const transport = options.local ? createLocalTransport() :
    createSshTransport({ remote: options.remote ?? process.env.REVIVAL_DEPLOY_REMOTE ?? "vps" });
  const result = await shipPinRelease({ releaseRoot, remoteRoot, transport, confirm: options.confirm });
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (!result.applied) process.stdout.write(`[plan] ${result.releaseId} (${result.version}) -> ` +
    `${result.target}:${result.remoteRoot}\n[plan] ${result.uploads.length} file(s), ` +
    `${result.uploadBytes} bytes; re-run with --confirm.\n`);
  else process.stdout.write(result.unchanged
    ? `[implemented] ${result.releaseId} is already current on ${result.target}\n`
    : `[implemented] published ${result.releaseId} to ${result.target}:${result.remoteRoot}\n`);
}
if (resolve(process.argv[1] ?? "") === SELF_PATH) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`pin-release-ship: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error?.code === "usage" ? 64 : 1;
  });
}
