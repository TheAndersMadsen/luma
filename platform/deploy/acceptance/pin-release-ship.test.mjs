import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PIN_RELEASE_ARTIFACT_ROLES,
  PIN_RELEASE_PACKAGE_BY_ROLE,
  canonicalPinReleaseManifestJson,
  createPinReleaseManifest,
  parsePinReleaseReceiptBundle,
} from "../pin/release.mjs";
import {
  STORE_MANIFEST_URL,
  createReleaseStoreFetch,
  readRelease,
  verifyReleaseArtifacts,
} from "../pin/install.mjs";
import {
  createPinReleaseShipPlan,
  createSshTransport,
  readLocalPinReleaseStore,
  shipPinRelease,
  validateRemoteRoot,
  validateSshTarget,
} from "../pin/ship.mjs";

const SIGNER = "a".repeat(64);

async function releaseStore(parent, version = "2026-08-23.1", versionCode = 202_608_231) {
  const root = await mkdtemp(join(parent, "release-"));
  const bytes = new Map();
  const receipts = parsePinReleaseReceiptBundle({
    schemaVersion: 1,
    artifacts: PIN_RELEASE_ARTIFACT_ROLES.map((role) => {
      const value = Buffer.from(`${version}:${versionCode}:${role}`);
      bytes.set(`${role}.apk`, value);
      return {
        role,
        path: `${role}.apk`,
        name: `${role}.apk`,
        package: PIN_RELEASE_PACKAGE_BY_ROLE[role],
        versionName: version,
        versionCode,
        size: value.length,
        sha256: createHash("sha256").update(value).digest("hex"),
        signerSha256: SIGNER,
      };
    }),
  });
  const manifest = createPinReleaseManifest({ version, receipts });
  const currentSource = canonicalPinReleaseManifestJson(manifest);
  const releaseDirectory = join(root, "releases", manifest.releaseId);
  await mkdir(releaseDirectory, { recursive: true });
  for (const [name, value] of bytes) await writeFile(join(releaseDirectory, name), value);
  await writeFile(join(releaseDirectory, "manifest.json"), currentSource);
  await writeFile(join(root, "current.json"), currentSource);
  return { root, releaseDirectory, manifest, currentSource };
}

function localSshExecutor(target, calls, { failRemovePath } = {}) {
  return async (command, args, options = {}) => {
    calls.push({ command, args: [...args], options });
    if (command === "rsync") {
      const source = args.at(-2);
      const destination = args.at(-1);
      const prefix = `${target}:`;
      assert.ok(destination.startsWith(prefix));
      const localDestination = destination.slice(prefix.length);
      if (source.endsWith("/")) await cp(source, localDestination, { recursive: true, force: true });
      else await copyFile(source, localDestination);
      return { status: 0, stdout: "", stderr: "" };
    }
    assert.equal(command, "ssh");
    const remoteArgs = args.slice(args.indexOf(target) + 1);
    const remoteCommand = remoteArgs.join(" ");
    if (failRemovePath && remoteCommand.includes("'rm' '-rf'") && remoteCommand.includes(failRemovePath)) {
      return { status: 1, stdout: "", stderr: "injected remove failure" };
    }
    const result = spawnSync("sh", ["-c", remoteCommand], { encoding: "utf8" });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? String(result.error ?? ""),
    };
  };
}

test("the verified local store feeds the real headless install adapter", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "revival-install-store-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const fixture = await releaseStore(temporary);
  const release = await readRelease(fixture.root);
  const verified = await verifyReleaseArtifacts(release);
  const fetchStore = createReleaseStoreFetch(release, verified);
  assert.deepEqual(await (await fetchStore(STORE_MANIFEST_URL)).json(), fixture.manifest);
  const server = fixture.manifest.artifacts.find((artifact) => artifact.role === "server");
  const response = await fetchStore(new URL(server.url, STORE_MANIFEST_URL));
  assert.deepEqual(
    Buffer.from(await (await response.blob()).arrayBuffer()),
    await readFile(join(fixture.releaseDirectory, server.name)),
  );
});

test("ship planning verifies the source and requires both version axes to advance", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "revival-ship-plan-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const local = await readLocalPinReleaseStore({
    root: (await releaseStore(temporary, "2026-08-23.3", 202_608_233)).root,
  });
  for (const fixture of [
    await releaseStore(temporary, "2026-08-23.3", 202_608_232),
    await releaseStore(temporary, "2026-08-23.2", 202_608_233),
  ]) {
    const remote = await readLocalPinReleaseStore({ root: fixture.root });
    assert.throws(() => createPinReleaseShipPlan({ local, remote }), /both advance/u);
  }
  assert.throws(
    () => createPinReleaseShipPlan({ local, remote: { ...local, verified: false } }),
    /not fully verified/u,
  );
  await writeFile(join(local.root, "history.json"), "{}\n");
  await assert.rejects(
    readLocalPinReleaseStore({ root: local.root }),
    /obsolete history\.json; rebuild/u,
  );
});

test("SSH publication resumes every pre-pointer crash state with real remote-shell parsing", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "revival-ship-resume-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const desired = await releaseStore(temporary);
  const target = "operator@example.test";
  const expectedRsync = new Map([
    ["after-mkdir", 2],
    ["after-staging", 2],
    ["after-final-mv", 1],
    ["after-pointer-upload", 0],
  ]);

  for (const state of expectedRsync.keys()) {
    const root = join(temporary, state);
    const releases = join(root, "releases");
    const final = join(releases, desired.manifest.releaseId);
    const staging = join(releases, `.incoming-${desired.manifest.releaseId}`);
    const pointer = join(releases, `.current-${desired.manifest.releaseId}.tmp`);
    await mkdir(root);
    if (state !== "after-mkdir") await mkdir(releases);
    if (state === "after-staging") {
      await mkdir(staging);
      await copyFile(join(desired.releaseDirectory, "server.apk"), join(staging, "server.apk"));
    }
    if (["after-final-mv", "after-pointer-upload"].includes(state)) {
      await cp(desired.releaseDirectory, final, { recursive: true });
    }
    if (state === "after-pointer-upload") await writeFile(pointer, desired.currentSource);

    const calls = [];
    const result = await shipPinRelease({
      releaseRoot: desired.root,
      remoteRoot: root,
      transport: createSshTransport({ remote: target, execute: localSshExecutor(target, calls) }),
      confirm: true,
    });
    assert.equal(result.unchanged, false);
    assert.equal(await readFile(join(root, "current.json"), "utf8"), desired.currentSource);
    assert.deepEqual(await readdir(releases), [desired.manifest.releaseId]);
    const rsync = calls.filter(({ command }) => command === "rsync");
    assert.equal(rsync.length, expectedRsync.get(state), state);
    assert.ok(rsync.every(({ options }) => options.timeoutMs > 60_000));

    const sshCalls = calls.filter(({ command }) => command === "ssh");
    assert.ok(sshCalls.every(({ args }) => args.slice(args.indexOf(target) + 1).length === 1));
    const listing = sshCalls.find(({ args }) => args.at(-1).includes("'-printf'"));
    assert.match(listing.args.at(-1), /'-printf' '%f\\0%y\\0'/u);
    const flock = sshCalls.find(({ args }) => args.at(-1).startsWith("flock -x "));
    assert.ok(flock.args.at(-1).includes("[ ! -L "));
    assert.ok(flock.args.at(-1).includes(".tmp"));
    assert.ok(flock.args.at(-1).includes(" ] && [ -f "));
    if (state === "after-mkdir") {
      assert.ok(rsync[0].args.at(-2).endsWith("/"));
      assert.match(rsync[0].args.at(-1), /\.incoming-[0-9a-f]{64}\/$/u);
    }
    const stale = spawnSync("sh", ["-c", flock.args.at(-1)], { encoding: "utf8" });
    assert.equal(stale.status, 73, "the flock script propagates the stale-pointer CAS status");
  }
});

test("rsync retries a partial transfer once and resumes it", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "revival-ship-retry-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const desired = await releaseStore(temporary);
  const root = join(temporary, "remote");
  const target = "operator@example.test";
  const calls = [];
  const executeNormally = localSshExecutor(target, calls);
  let failed = false;
  const execute = async (command, args, options) => {
    const isReleaseTransfer = command === "rsync" &&
      args.at(-1).endsWith(`.incoming-${desired.manifest.releaseId}/`);
    if (isReleaseTransfer && !failed) {
      failed = true;
      calls.push({ command, args: [...args], options });
      return { status: 12, stdout: "", stderr: "injected transfer interruption" };
    }
    return await executeNormally(command, args, options);
  };

  await shipPinRelease({
    releaseRoot: desired.root,
    remoteRoot: root,
    transport: createSshTransport({ remote: target, execute }),
    confirm: true,
  });
  const transfers = calls.filter(({ command, args }) => command === "rsync" &&
    args.at(-1).endsWith(`.incoming-${desired.manifest.releaseId}/`));
  assert.equal(transfers.length, 2);
  assert.ok(transfers.every(({ args }) => args.includes("--partial")));
});

test("a different release prunes stale releases only after the pointer commits", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "revival-ship-retain-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const stale = await releaseStore(temporary, "2026-08-23.1", 202_608_231);
  const current = await releaseStore(temporary, "2026-08-23.2", 202_608_232);
  const desired = await releaseStore(temporary, "2026-08-23.3", 202_608_233);
  const root = join(temporary, "remote");
  const releases = join(root, "releases");
  await mkdir(releases, { recursive: true });
  await cp(stale.releaseDirectory, join(releases, stale.manifest.releaseId), { recursive: true });
  await cp(current.releaseDirectory, join(releases, current.manifest.releaseId), { recursive: true });
  await writeFile(join(root, "current.json"), current.currentSource);
  const calls = [];
  const target = "operator@example.test";
  await shipPinRelease({
    releaseRoot: desired.root,
    remoteRoot: root,
    transport: createSshTransport({ remote: target, execute: localSshExecutor(target, calls) }),
    confirm: true,
  });
  assert.deepEqual(
    (await readdir(releases)).sort(),
    [current.manifest.releaseId, desired.manifest.releaseId].sort(),
  );
  const prune = calls.findIndex(({ command, args }) => command === "ssh" && args.at(-1).includes(stale.manifest.releaseId) && args.at(-1).includes("'rm' '-rf'"));
  const upload = calls.findIndex(({ command }) => command === "rsync");
  const commit = calls.findIndex(({ command, args }) => command === "ssh" && args.at(-1).startsWith("flock -x "));
  assert.ok(upload >= 0 && commit > upload && prune > commit,
    "a stale release is removed only after the pointer CAS");

  const blockedRoot = join(temporary, "blocked");
  const blockedReleases = join(blockedRoot, "releases");
  await mkdir(blockedReleases, { recursive: true });
  await cp(stale.releaseDirectory, join(blockedReleases, stale.manifest.releaseId), { recursive: true });
  await cp(current.releaseDirectory, join(blockedReleases, current.manifest.releaseId), { recursive: true });
  await writeFile(join(blockedRoot, "current.json"), current.currentSource);
  const blockedCalls = [];
  const warnings = [];
  const result = await shipPinRelease({
    releaseRoot: desired.root,
    remoteRoot: blockedRoot,
    transport: createSshTransport({
      remote: target,
      execute: localSshExecutor(target, blockedCalls, {
        failRemovePath: join(blockedReleases, stale.manifest.releaseId),
      }),
      warn: (message) => warnings.push(message),
    }),
    confirm: true,
  });
  assert.equal(result.applied, true);
  assert.match(warnings[0], /post-publication cleanup skipped.*cleanup failed/u);
  assert.equal(blockedCalls.some(({ command }) => command === "rsync"), true);
  assert.equal(await readFile(join(blockedRoot, "current.json"), "utf8"), desired.currentSource);
});

test("a failed pointer commit removes its temp and the next ship succeeds", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "revival-ship-pointer-failure-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const desired = await releaseStore(temporary);
  const root = join(temporary, "remote");
  const releases = join(root, "releases");
  const pointer = join(releases, `.current-${desired.manifest.releaseId}.tmp`);
  const target = "operator@example.test";
  const calls = [];
  const executeNormally = localSshExecutor(target, calls);
  let failed = false;
  const execute = async (command, args, options) => {
    if (!failed && command === "ssh" && args.at(-1).startsWith("flock -x ")) {
      failed = true;
      calls.push({ command, args: [...args], options });
      return { status: 75, stdout: "", stderr: "injected commit failure" };
    }
    return await executeNormally(command, args, options);
  };

  await assert.rejects(
    shipPinRelease({
      releaseRoot: desired.root,
      remoteRoot: root,
      transport: createSshTransport({ remote: target, execute }),
      confirm: true,
    }),
    /status 75/u,
  );
  assert.equal((await readdir(releases)).includes(pointer.split("/").at(-1)), false);

  const retry = await shipPinRelease({
    releaseRoot: desired.root,
    remoteRoot: root,
    transport: createSshTransport({
      remote: target,
      execute: localSshExecutor(target, []),
    }),
    confirm: true,
  });
  assert.equal(retry.applied, true);
  assert.equal(await readFile(join(root, "current.json"), "utf8"), desired.currentSource);
});

test("a concurrent CAS loser never prunes the winning release", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "revival-ship-concurrent-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const previous = await releaseStore(temporary, "2026-08-23.1", 202_608_231);
  const releaseB = await releaseStore(temporary, "2026-08-23.2", 202_608_232);
  const releaseC = await releaseStore(temporary, "2026-08-23.3", 202_608_233);
  const releaseD = await releaseStore(temporary, "2026-08-23.4", 202_608_234);
  const root = join(temporary, "remote");
  const releases = join(root, "releases");
  await mkdir(releases, { recursive: true });
  await cp(previous.releaseDirectory, join(releases, previous.manifest.releaseId), { recursive: true });
  await writeFile(join(root, "current.json"), previous.currentSource);

  const target = "operator@example.test";
  const callsB = [];
  const executeBNormally = localSshExecutor(target, callsB);
  let releasePointerUpload;
  let continuePointerUpload;
  let bCasStatus;
  const pointerUploadReached = new Promise((resolvePromise) => { releasePointerUpload = resolvePromise; });
  const pointerUploadMayContinue = new Promise((resolvePromise) => { continuePointerUpload = resolvePromise; });
  const executeB = async (command, args, options) => {
    if (command === "rsync" && args.at(-1).endsWith(`.current-${releaseB.manifest.releaseId}.tmp`)) {
      releasePointerUpload();
      await pointerUploadMayContinue;
    }
    const result = await executeBNormally(command, args, options);
    if (command === "ssh" && args.at(-1).startsWith("flock -x ")) bCasStatus = result.status;
    return result;
  };
  const publicationB = shipPinRelease({
    releaseRoot: releaseB.root,
    remoteRoot: root,
    transport: createSshTransport({ remote: target, execute: executeB }),
    confirm: true,
  });
  await pointerUploadReached;

  const callsC = [];
  await shipPinRelease({
    releaseRoot: releaseC.root,
    remoteRoot: root,
    transport: createSshTransport({
      remote: target,
      execute: localSshExecutor(target, callsC),
    }),
    confirm: true,
  });
  continuePointerUpload();
  await assert.rejects(publicationB, /changed|staging/u);

  assert.equal(bCasStatus, 73);
  assert.equal(await readFile(join(root, "current.json"), "utf8"), releaseC.currentSource);
  assert.ok((await readdir(releases)).includes(releaseC.manifest.releaseId));
  assert.equal(
    (await readdir(releases)).includes(`.current-${releaseB.manifest.releaseId}.tmp`),
    false,
  );
  assert.equal(callsB.some(({ command, args }) =>
    command === "ssh" && args.at(-1).includes("'rm' '-rf'")), false);
  const cCommit = callsC.findIndex(({ command, args }) =>
    command === "ssh" && args.at(-1).startsWith("flock -x "));
  const cPrune = callsC.findIndex(({ command, args }) =>
    command === "ssh" && args.at(-1).includes(releaseB.manifest.releaseId) &&
      args.at(-1).includes("'rm' '-rf'"));
  assert.ok(cCommit >= 0 && cPrune > cCommit);

  await shipPinRelease({
    releaseRoot: releaseD.root,
    remoteRoot: root,
    transport: createSshTransport({
      remote: target,
      execute: localSshExecutor(target, []),
    }),
    confirm: true,
  });
  assert.equal(await readFile(join(root, "current.json"), "utf8"), releaseD.currentSource);
});

test("remote release inspection rejects current, staging, pointer symlinks and corrupt members", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "revival-ship-unsafe-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const desired = await releaseStore(temporary);
  const target = "operator@example.test";
  const cases = [
    ["current-link", async (root, releases) => {
      await symlink(join(desired.root, "current.json"), join(root, "current.json"));
      await cp(desired.releaseDirectory, join(releases, desired.manifest.releaseId), { recursive: true });
    }],
    ["staging-link", async (_root, releases) => {
      await symlink(desired.releaseDirectory, join(releases, `.incoming-${desired.manifest.releaseId}`));
    }],
    ["pointer-link", async (_root, releases) => {
      await cp(desired.releaseDirectory, join(releases, desired.manifest.releaseId), { recursive: true });
      await symlink(join(desired.root, "current.json"), join(releases, `.current-${desired.manifest.releaseId}.tmp`));
    }],
    ["unexpected", async (_root, releases) => writeFile(join(releases, "unexpected"), "x")],
    ["corrupt-final", async (_root, releases) => {
      const final = join(releases, desired.manifest.releaseId);
      await cp(desired.releaseDirectory, final, { recursive: true });
      await writeFile(join(final, "server.apk"), "corrupt");
    }],
  ];
  for (const [name, prepare] of cases) {
    const root = join(temporary, name);
    const releases = join(root, "releases");
    await mkdir(releases, { recursive: true });
    await prepare(root, releases);
    await assert.rejects(
      shipPinRelease({
        releaseRoot: desired.root,
        remoteRoot: root,
        transport: createSshTransport({ remote: target, execute: localSshExecutor(target, []) }),
        confirm: true,
      }),
      /unsafe|unexpected|differs/u,
      name,
    );
  }
});

test("CLI values and remote destinations fail closed", () => {
  for (const value of ["-oProxyCommand=x", "user@host;touch-x", "user@@host", "host..name"]) {
    assert.throws(() => validateSshTarget(value), /unsafe SSH target/u);
  }
  for (const value of ["/", "/srv/../tmp", "relative", "/srv/path/"]) {
    assert.throws(() => validateRemoteRoot(value), /unsafe remote release store path/u);
  }
  for (const argumentsList of [["--remote", "--confirm"], ["--local"]]) {
    const result = spawnSync(process.execPath, [
      new URL("../pin/ship.mjs", import.meta.url).pathname, "ship", ...argumentsList,
    ], { encoding: "utf8" });
    assert.equal(result.status, 64);
  }
});
