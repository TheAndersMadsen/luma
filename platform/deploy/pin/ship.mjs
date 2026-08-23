#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compareInstallVersions, parseCanonicalPinReleaseManifestDocument } from "./release.mjs";
import { defaultOperatorPaths } from "./build.mjs";
const SELF_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REMOTE_ROOT = "/home/anders/ai-pin-revival/data/pin-releases";
const MAX_DOCUMENT_BYTES = 1024 * 1024, SSH_TIMEOUT_MS = 30_000, TRANSFER_TIMEOUT_MS = 30 * 60_000;
const RSYNC_OPTIONS = Object.freeze(["--recursive", "--partial", "--delete"]);
const RELEASE_ID_RE = /^[0-9a-f]{64}$/u;
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
  if (entries.some((entry) => entry.name === "history.json")) {
    fail("store-invalid", `${label} uses obsolete history.json; rebuild the local release store`);
  }
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
    ...(remote?.desiredFinalized === true
      ? []
      : [...local.entries].map(([name, value]) => ({ name, ...value }))),
    ...(remote?.desiredPointerReady === true
      ? []
      : [{ name: "current.json", size: Buffer.byteLength(local.currentSource) }]),
  ];
  return Object.freeze({ releaseId: local.manifest.releaseId, version: local.manifest.version,
    versionCode: local.manifest.artifacts[0].versionCode, unchanged: same, uploads: Object.freeze(uploads),
    uploadBytes: uploads.reduce((sum, file) => sum + file.size, 0) });
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
export function createSshTransport({
  remote,
  execute = run,
  warn = (message) => process.stderr.write(`${message}\n`),
}) {
  const target = validateSshTarget(remote);
  const options = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
  const quote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
  const ssh = (args, capture = false) => execute(
    "ssh",
    [...options, target, args.map(quote).join(" ")],
    { capture, timeoutMs: SSH_TIMEOUT_MS },
  );
  const sshScript = (script, capture = false) => execute(
    "ssh",
    [...options, target, script],
    { capture, timeoutMs: SSH_TIMEOUT_MS },
  );
  const requireSsh = async (args, label) => {
    const result = await ssh(args);
    if (result.status !== 0) fail("remote", `${label} failed (status ${result.status})`);
  };
  const info = async (path) => {
    // GNU stat does not follow symlinks unless --dereference is requested.
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
    const result = await ssh(["find", path, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\\0%y\\0"], true);
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
  const verifyStaging = async (path, manifest, label = "remote staging") => {
    await requireDirectory(path, label);
    const entries = await list(path), expected = expectedNames(manifest);
    if (entries.some((entry) => entry.type !== "f" || !expected.includes(entry.name))) {
      fail("store-invalid", `${label} contains unsafe or unexpected files`);
    }
  };
  const inspectReleaseMembers = async ({ releases, desired, currentManifest, currentCanonical, allowOlder }) => {
    const desiredId = desired?.manifest.releaseId;
    const stagingName = desiredId ? `.incoming-${desiredId}` : null;
    const pointerName = desiredId ? `.current-${desiredId}.tmp` : null;
    let currentFound = false, desiredFinalized = false, desiredPointerReady = false;
    for (const entry of await list(releases)) {
      const selected = posix.join(releases, entry.name);
      if (entry.name === desiredId) {
        if (entry.type !== "d") fail("store-invalid", "desired remote release is unsafe");
        await verifyRelease(selected, desired.manifest, desired.currentSource);
        desiredFinalized = true;
        if (entry.name === currentManifest?.releaseId) currentFound = true;
      } else if (entry.name === currentManifest?.releaseId) {
        if (entry.type !== "d") fail("store-invalid", "current remote release is unsafe");
        await verifyRelease(selected, currentManifest, currentCanonical);
        currentFound = true;
      } else if (entry.name === stagingName) {
        if (entry.type !== "d") fail("store-invalid", "remote staging is unsafe");
        await verifyStaging(selected, desired.manifest);
      } else if (entry.name === pointerName) {
        if (entry.type !== "f" || await remoteDocument(selected, "remote current staging") !== desired.currentSource) {
          fail("store-invalid", "remote current staging is unsafe");
        }
        desiredPointerReady = true;
      } else if (allowOlder && RELEASE_ID_RE.test(entry.name) && entry.type === "d") {
        await requireDirectory(selected, "older remote release");
      } else {
        fail("store-invalid", `remote releases contains unexpected member ${entry.name}`);
      }
    }
    if (currentManifest && !currentFound) fail("store-invalid", "current remote release is missing");
    if (desiredPointerReady && !desiredFinalized) {
      fail("store-invalid", "remote current staging exists without its finalized release");
    }
    return { desiredFinalized, desiredPointerReady };
  };
  const pruneOlderReleases = async (releases, currentId, desiredId) => {
    // Keep the immediately previous release so downloads opened before the
    // pointer swap can finish against the same immutable files.
    const kept = new Set([
      currentId,
      desiredId,
      `.incoming-${desiredId}`,
      `.current-${desiredId}.tmp`,
    ]);
    for (const entry of await list(releases)) {
      const selected = posix.join(releases, entry.name);
      if (kept.has(entry.name)) {
        if (entry.name.startsWith(".current-")) {
          if (entry.type !== "f") fail("remote", "remote current staging is unsafe");
        } else {
          if (entry.type !== "d") fail("remote", `remote release member ${entry.name} is unsafe`);
          await requireDirectory(selected, `retained remote release member ${entry.name}`);
        }
        continue;
      }
      if (!RELEASE_ID_RE.test(entry.name) || entry.type !== "d") {
        fail("remote", `remote releases contains unexpected member ${entry.name}`);
      }
      await requireDirectory(selected, "older remote release");
      await requireSsh(["rm", "-rf", "--", selected], `older remote release ${entry.name} cleanup`);
    }
  };
  const cleanupPublisherTemps = async ({ staging, pointer, manifest, canonical }) => {
    const pointerMetadata = await info(pointer);
    if (pointerMetadata) {
      if (pointerMetadata.mode !== 0x8000 ||
          await remoteDocument(pointer, "remote current staging") !== canonical) {
        fail("remote", "remote current staging became unsafe");
      }
      await requireSsh(["rm", "-f", "--", pointer], "remote current staging cleanup");
    }
    if (await info(staging) !== null) {
      await verifyStaging(staging, manifest, "remote stale staging");
      await requireSsh(["rm", "-rf", "--", staging], "remote stale staging cleanup");
    }
  };
  const transport = {
    describe: () => target,
    async inspect(remoteRoot, desired) {
      const root = validateRemoteRoot(remoteRoot);
      if (await info(root) === null) return null;
      await requireDirectory(root, "remote release root");
      const entries = await list(root);
      const currentEntry = entries.find((entry) => entry.name === "current.json");
      const releasesEntry = entries.find((entry) => entry.name === "releases");
      if (entries.some((entry) => !["current.json", "releases"].includes(entry.name)) ||
          (currentEntry && currentEntry.type !== "f") ||
          (releasesEntry && releasesEntry.type !== "d") ||
          (currentEntry && (!releasesEntry || entries.length !== 2)) ||
          (!currentEntry && entries.length > (releasesEntry ? 1 : 0))) {
        fail("store-invalid", "remote release root has unexpected files");
      }
      const releases = posix.join(root, "releases");
      if (!currentEntry) {
        if (!desired) fail("store-invalid", "remote root exists without current.json");
        const state = releasesEntry
          ? await requireDirectory(releases, "remote releases").then(() => inspectReleaseMembers({
            releases, desired, currentManifest: null, currentCanonical: undefined, allowOlder: false,
          }))
          : { desiredFinalized: false, desiredPointerReady: false };
        return Object.freeze({
          prepared: true, ...state, verified: true,
          manifest: null, currentSource: null,
        });
      }
      await requireDirectory(releases, "remote releases");
      const currentSource = await remoteDocument(posix.join(root, "current.json"), "remote current.json");
      const manifest = parseCanonicalPinReleaseManifestDocument(currentSource);
      const state = await inspectReleaseMembers({
        releases, desired, currentManifest: manifest, currentCanonical: currentSource, allowOlder: true,
      });
      return Object.freeze({ manifest, currentSource, ...state, verified: true });
    },
    async publish({ local, remote: previous, remoteRoot }) {
      const root = validateRemoteRoot(remoteRoot);
      await requireDirectory(posix.dirname(root), "remote release parent");
      if (await info(root) === null) await requireSsh(["mkdir", "--", root], "remote release root creation");
      await requireDirectory(root, "remote release root");
      const releases = posix.join(root, "releases");
      if (await info(releases) === null) await requireSsh(["mkdir", "--", releases], "remote releases creation");
      await requireDirectory(releases, "remote releases");
      const previousId = previous?.manifest?.releaseId;
      if (previousId && !RELEASE_ID_RE.test(previousId)) fail("remote", "unsafe previous releaseId");
      const final = posix.join(releases, local.manifest.releaseId);
      const staging = posix.join(releases, `.incoming-${local.manifest.releaseId}`);
      if (await info(final) === null) {
        if (await info(staging) === null) await requireSsh(["mkdir", "--", staging], "remote staging creation");
        await verifyStaging(staging, local.manifest);
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
        await verifyStaging(staging, local.manifest, "remote stale staging");
        await requireSsh(["rm", "-rf", "--", staging], "remote stale staging cleanup");
      }
      const pointer = posix.join(releases, `.current-${local.manifest.releaseId}.tmp`);
      const pointerInfo = await info(pointer);
      if (pointerInfo && pointerInfo.mode !== 0x8000) fail("remote", "remote current staging is unsafe");
      if (!previous?.desiredPointerReady) await upload(posix.join(local.root, "current.json"), pointer);
      if (await remoteDocument(pointer, "remote current staging") !== local.currentSource) {
        fail("remote", "remote current staging differs from release");
      }
      const current = posix.join(root, "current.json");
      const expected = previous?.currentSource == null
        ? `[ ! -e ${quote(current)} ] && [ ! -L ${quote(current)} ]`
        : `[ ! -L ${quote(current)} ] && [ -f ${quote(current)} ] && [ "$(sha256sum -- ${quote(current)} | cut -d ' ' -f 1)" = ${quote(digest(previous.currentSource))} ]`;
      const pointerReady = `[ ! -L ${quote(pointer)} ] && [ -f ${quote(pointer)} ] && [ "$(sha256sum -- ${quote(pointer)} | cut -d ' ' -f 1)" = ${quote(digest(local.currentSource))} ]`;
      const script = `set -eu; ${expected} || exit 73; ${pointerReady} || exit 74; mv -T -f -- ${quote(pointer)} ${quote(current)}`;
      let committed;
      try {
        committed = await sshScript(`flock -x ${quote(root)} sh -c ${quote(script)}`);
      } catch (error) {
        await cleanupPublisherTemps({
          staging,
          pointer,
          manifest: local.manifest,
          canonical: local.currentSource,
        });
        const installed = await transport.inspect(root, local);
        if (installed?.currentSource === local.currentSource) return;
        throw error;
      }
      if (committed.status !== 0) {
        await cleanupPublisherTemps({
          staging,
          pointer,
          manifest: local.manifest,
          canonical: local.currentSource,
        });
        const installed = await transport.inspect(root, local);
        if (installed?.currentSource === local.currentSource) return;
        if (committed.status === 73) fail("remote", "remote current.json changed during publication");
        fail("remote", `remote current publication failed (status ${committed.status})`);
      }
      if (await remoteDocument(current, "remote current.json") !== local.currentSource) {
        fail("remote", "remote current.json did not commit the desired release");
      }
      if (previousId && previousId !== local.manifest.releaseId) {
        try {
          await pruneOlderReleases(releases, previousId, local.manifest.releaseId);
        } catch (error) {
          warn(`pin-release-ship: post-publication cleanup skipped: ${
            error instanceof Error ? error.message : String(error)}`);
        }
      }
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
  process.stdout.write("Usage: ./revival pin release ship [--remote NAME] [--remote-root PATH]\n" +
    "                                  [--release-root DIR] [--confirm] [--json]\n");
}
function parseCli(args) {
  let values;
  try {
    ({ values } = parseArgs({ args, strict: true, options: {
      confirm: { type: "boolean", default: false }, json: { type: "boolean", default: false },
      remote: { type: "string" },
      "remote-root": { type: "string" }, "release-root": { type: "string" },
    } }));
  } catch (error) { fail("usage", error.message); }
  return { ...values, remoteRoot: values["remote-root"], releaseRoot: values["release-root"] };
}
async function main(args) {
  if (args.length === 0 || ["help", "--help", "-h"].includes(args[0])) return help();
  if (args.shift() !== "ship") fail("usage", "expected ship");
  if (args.length === 1 && ["help", "--help", "-h"].includes(args[0])) return help();
  const options = parseCli(args);
  const releaseRoot = resolve(options.releaseRoot ?? defaultOperatorPaths().releaseRoot);
  const remoteRoot = validateRemoteRoot(options.remoteRoot ?? DEFAULT_REMOTE_ROOT);
  const transport = createSshTransport({
    remote: options.remote ?? process.env.REVIVAL_DEPLOY_REMOTE ?? "vps",
  });
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
