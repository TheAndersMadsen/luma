import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
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
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  PIN_COMPATIBILITY_CERT_SHA256,
  parseBuilderMetadata,
  publishPinReleaseFixture as publishPinRelease,
} from "../pin/build.mjs";
import { PIN_RELEASE_ARTIFACT_ROLES, PIN_RELEASE_PACKAGE_BY_ROLE } from "../pin/release.mjs";
import {
  PAYLOAD_DELIMITER,
  PinReleaseShipError,
  LOCAL_UPLOAD_SCRIPT,
  REMOTE_APPLY_SCRIPT,
  REMOTE_RSYNC_LAUNCHER_SOURCE,
  REMOTE_STAGING_SCRIPT,
  RSYNC_UPLOAD_ATTEMPTS,
  RSYNC_UPLOAD_OPTIONS,
  composeRemoteInvocation,
  createApplyPayload,
  createLocalTransport,
  createPinReleaseShipPlan,
  createSshTransport,
  inspectRemotePinReleaseStore,
  readLocalPinReleaseStore,
  shellQuote,
  shipPinReleaseFixture as shipPinRelease,
  validateRemoteRoot,
} from "../pin/ship.mjs";

process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES = "1";

const ROOT = resolve(import.meta.dirname, "../../..");
const SHIP_TOOL = join(ROOT, "platform", "deploy", "pin", "ship.mjs");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "revival-pin-ship-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/**
 * A local store built by the REAL publisher.
 *
 * `publishPinRelease` is what `./revival pin release build` ends with, so a
 * fixture that hand-writes the four files would prove the ship agrees with a
 * store shape nothing else produces. This one cannot drift from the publisher.
 */
async function publishLocally(
  root,
  {
    version,
    versionCode,
    marker = "one",
    serverBytes = 0,
    releaseRoot = join(root, "local-store"),
    stagingRoot = join(root, `staging-${versionCode}`),
  },
) {
  await mkdir(stagingRoot, { mode: 0o700 });
  const rows = [];
  for (const role of PIN_RELEASE_ARTIFACT_ROLES) {
    const head = Buffer.from(`synthetic-apk:${marker}:${role}:${version}:${versionCode}\n`);
    const bytes =
      role === "server" && serverBytes > head.length
        ? Buffer.concat([head, Buffer.alloc(serverBytes - head.length, 0x41)])
        : head;
    await writeFile(join(stagingRoot, `${role}.apk`), bytes, { mode: 0o600 });
    rows.push(
      [
        role,
        PIN_RELEASE_PACKAGE_BY_ROLE[role],
        version,
        String(versionCode),
        PIN_COMPATIBILITY_CERT_SHA256,
        sha256(bytes),
        String(bytes.length),
      ].join("\t"),
    );
  }
  await writeFile(join(stagingRoot, "release-metadata.tsv"), `${rows.join("\n")}\n`, {
    mode: 0o600,
  });

  await mkdir(releaseRoot, { recursive: true, mode: 0o700 });
  const receipts = await parseBuilderMetadata({ stagingRoot, version, versionCode });
  return await publishPinRelease({ releaseRoot, stagingRoot, version, receipts });
}

async function remoteStore(root, name = "served-store") {
  const path = join(root, name);
  await mkdir(path, { mode: 0o700 });
  return path;
}

async function fakeRsync(root, mode) {
  const executable = join(root, `fake-rsync-${mode}.mjs`);
  const log = join(root, `fake-rsync-${mode}.jsonl`);
  const state = join(root, `fake-rsync-${mode}.state.json`);
  const source = [
    "#!/usr/bin/env node",
    'import fs from "node:fs";',
    'import path from "node:path";',
    `const mode = ${JSON.stringify(mode)};`,
    `const logPath = ${JSON.stringify(log)};`,
    `const statePath = ${JSON.stringify(state)};`,
    "const args = process.argv.slice(2);",
    "const localSource = args.at(-2);",
    "const remoteEndpoint = args.at(-1);",
    'const separator = remoteEndpoint.indexOf(":");',
    "if (!localSource || separator <= 0) process.exit(64);",
    'const rsyncPath = args.find((value) => value.startsWith("--rsync-path="));',
    'const authorityMatch = rsyncPath?.match(/REVIVAL_PIN_RSYNC_AUTHORITY=([A-Za-z0-9+/=]+)/u);',
    "if (!authorityMatch) process.exit(65);",
    'const authority = JSON.parse(Buffer.from(authorityMatch[1], "base64").toString("utf8"));',
    "const destination = path.join(authority.releasesRoot, authority.incoming, authority.sealedName);",
    "const name = authority.filename;",
    'let attempts = {}; try { attempts = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}',
    "const attempt = (attempts[destination] ?? 0) + 1;",
    "attempts[destination] = attempt;",
    'fs.writeFileSync(statePath, JSON.stringify(attempts), { mode: 0o600 });',
    "const sourceSize = fs.statSync(localSource).size;",
    "const before = fs.existsSync(destination) ? fs.statSync(destination).size : 0;",
    "let start = 0; let end = sourceSize; let fail = false;",
    'if (name === "server.apk" && mode === "resume" && attempt === 1) {',
    "  end = Math.max(1, Math.floor(sourceSize / 3)); fail = true;",
    ' } else if (name === "server.apk" && mode === "always-fail") {',
    "  start = before; end = Math.min(sourceSize, before + Math.max(1, Math.floor(sourceSize / 4))); fail = true;",
    "} else if (before > 0 && before < sourceSize) { start = before; }",
    'const sourceFd = fs.openSync(localSource, "r");',
    'const targetFd = fs.openSync(destination, start === 0 ? "w" : "r+");',
    "try {",
    "  const buffer = Buffer.allocUnsafe(64 * 1024); let position = start;",
    "  while (position < end) {",
    "    const wanted = Math.min(buffer.length, end - position);",
    "    const count = fs.readSync(sourceFd, buffer, 0, wanted, position);",
    "    if (count === 0) break;",
    "    fs.writeSync(targetFd, buffer, 0, count, position); position += count;",
    "  }",
    "  fs.fsyncSync(targetFd);",
    "} finally { fs.closeSync(targetFd); fs.closeSync(sourceFd); }",
    'if (name === "server.apk" && mode === "corrupt" && sourceSize > 0) {',
    '  const fd = fs.openSync(destination, "r+");',
    "  try { const byte = Buffer.alloc(1); fs.readSync(fd, byte, 0, 1, sourceSize - 1); byte[0] ^= 0xff; fs.writeSync(fd, byte, 0, 1, sourceSize - 1); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }",
    "}",
    "fs.chmodSync(destination, 0o600);",
    "const after = fs.statSync(destination).size;",
    'fs.appendFileSync(logPath, JSON.stringify({ kind: "attempt", name, attempt, destination, before, after, sourceSize, args }) + "\\n");',
    'if (fail) { process.stderr.write("simulated mid-transfer disconnect\\n"); process.exit(12); }',
    "",
  ].join("\n");
  await writeFile(executable, source, { mode: 0o700 });
  await writeFile(log, "", { mode: 0o600 });
  return { executable, log, sshExecutable: await localSshExecutable(root) };
}

async function localSshExecutable(root) {
  const executable = join(root, "local-ssh.mjs");
  const source = [
    "#!/usr/bin/env node",
    'import { spawnSync } from "node:child_process";',
    "const args = process.argv.slice(2);",
    "let index = 0;",
    'while (args[index] === "-o") index += 2;',
    "if (index >= args.length) process.exit(64);",
    "index += 1; // syntactic remote name",
    'const command = args.slice(index).join(" ");',
    'if (command.length === 0) process.exit(64);',
    'const result = spawnSync("bash", ["-c", command], { stdio: "inherit", env: process.env });',
    "if (result.error) { process.stderr.write(result.error.message + \"\\n\"); process.exit(255); }",
    "process.exit(result.status ?? 255);",
    "",
  ].join("\n");
  await writeFile(executable, source, { mode: 0o700 });
  return executable;
}

function hybridRsyncTransport({ fixture, operationLog }) {
  const local = createLocalTransport();
  const ssh = createSshTransport({
    remote: "vps",
    rsyncExecutable: fixture.executable,
    sshExecutable: fixture.sshExecutable,
  });
  const note = async (kind, detail = {}) => {
    await appendFile(operationLog, `${JSON.stringify({ kind, ...detail })}\n`, { mode: 0o600 });
  };
  return Object.freeze({
    describe: ssh.describe,
    async run(request) {
      if (request.label === "remote release publication") await note("apply");
      return await local.run(request);
    },
    upload: ssh.upload,
    async makeIncomingDirectory(request) {
      await note("mkdir", { name: request.name });
      return await local.makeIncomingDirectory(request);
    },
    async removeIncomingDirectory(request) {
      await note("remove", { name: request.name });
      return await local.removeIncomingDirectory(request);
    },
  });
}

async function jsonLines(path) {
  const document = await readFile(path, "utf8");
  return document.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function filesystemAuthority(path) {
  const metadata = await lstat(path, { bigint: true });
  const handle = await open(path, "r");
  try {
    const fdinfo = await readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8");
    const mountMatch = fdinfo.match(/^mnt_id:\s*([0-9]+)$/mu);
    assert.notEqual(mountMatch, null, "the test host must expose the statx mount identity");
    const billion = 1_000_000_000n;
    const seconds = metadata.birthtimeNs / billion;
    const nanoseconds = metadata.birthtimeNs % billion;
    return Object.freeze({
      dev: String(metadata.dev),
      ino: String(metadata.ino),
      mntId: mountMatch[1],
      btime: `${seconds}.${String(nanoseconds).padStart(9, "0")}`,
      uid: Number(metadata.uid),
      gid: Number(metadata.gid),
      mode: Number(metadata.mode & 0o7777n),
    });
  } finally {
    await handle.close();
  }
}

async function emptyStoreAuthority(served) {
  return Object.freeze({
    root: await filesystemAuthority(served),
    releases: null,
    retainedRelease: null,
  });
}

async function stagedFilesystemAuthority(served, incoming) {
  const targets = Object.fromEntries(await Promise.all(
    (await readdir(incoming)).map(async (name) => [
      name,
      await filesystemAuthority(join(incoming, name)),
    ]),
  ));
  return Object.freeze({
    root: await filesystemAuthority(served),
    releases: await filesystemAuthority(join(served, "releases")),
    incoming: await filesystemAuthority(incoming),
    targets: Object.freeze(targets),
  });
}

async function stagePlan(served, plan, incomingName) {
  const incoming = join(served, "releases", incomingName);
  await mkdir(incoming, { recursive: true, mode: 0o700 });
  for (const upload of plan.uploads) {
    await copyFile(upload.source, join(incoming, upload.name));
    await chmod(join(incoming, upload.name), 0o600);
  }
  return Object.freeze({
    path: incoming,
    authority: await stagedFilesystemAuthority(served, incoming),
  });
}

function replaceApplyScriptOnce(script, needle, replacement, label) {
  const first = script.indexOf(needle);
  assert.notEqual(first, -1, `${label} injection boundary is missing`);
  assert.equal(script.indexOf(needle, first + needle.length), -1, `${label} injection boundary is ambiguous`);
  return `${script.slice(0, first)}${replacement}${script.slice(first + needle.length)}`;
}

function replaceRsyncLauncherOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  assert.notEqual(first, -1, `${label} launcher boundary is missing`);
  assert.equal(source.indexOf(needle, first + needle.length), -1, `${label} launcher boundary is ambiguous`);
  return `${source.slice(0, first)}${replacement}${source.slice(first + needle.length)}`;
}

function replaceLocalUploadOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  assert.notEqual(first, -1, `${label} local-upload boundary is missing`);
  assert.equal(
    source.indexOf(needle, first + needle.length),
    -1,
    `${label} local-upload boundary is ambiguous`,
  );
  return `${source.slice(0, first)}${replacement}${source.slice(first + needle.length)}`;
}

function injectDirectoryFsyncFailure({ targetLabel, ordinal, errorName }) {
  const original = [
    "def sync_directory_fd(descriptor, label):",
    "    os.fsync(descriptor)",
  ].join("\n");
  const injected = [
    "_test_directory_sync_counts = {}",
    "",
    "",
    "def sync_directory_fd(descriptor, label):",
    "    _test_directory_sync_counts[label] = _test_directory_sync_counts.get(label, 0) + 1",
    `    if label == ${JSON.stringify(targetLabel)} and _test_directory_sync_counts[label] == ${ordinal}:`,
    `        raise OSError(errno.${errorName}, "injected directory fsync ${errorName}")`,
    "    os.fsync(descriptor)",
  ].join("\n");
  return replaceApplyScriptOnce(REMOTE_APPLY_SCRIPT, original, injected, "directory fsync");
}

function injectAtomicWriteBehavior(lines, label) {
  const boundary = "import base64, ctypes, errno, fcntl, hashlib, json, os, re, secrets, stat, sys\n";
  return replaceApplyScriptOnce(
    REMOTE_APPLY_SCRIPT,
    boundary,
    `${boundary}${lines.join("\n")}\n`,
    label,
  );
}

async function stagedReleaseUpdate(t, suffix) {
  const root = await workspace(t);
  const localRoot = join(root, "local-store");
  const served = await remoteStore(root, `served-${suffix}`);
  const transport = createLocalTransport();
  const first = await publishLocally(root, {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
  });
  await shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true });
  const before = {
    current: await readFile(join(served, "current.json"), "utf8"),
    history: await readFile(join(served, "history.json"), "utf8"),
  };
  const second = await publishLocally(root, {
    version: "2026-08-09.2",
    versionCode: 202_608_092,
    marker: `two-${suffix}`,
  });
  const local = await readLocalPinReleaseStore({ root: localRoot });
  const remote = await inspectRemotePinReleaseStore({
    transport,
    remoteRoot: served,
    releaseIds: [first.releaseId, second.releaseId],
  });
  const plan = createPinReleaseShipPlan({ local, remote });
  const incomingName = `.incoming-${suffix}`;
  const staged = await stagePlan(served, plan, incomingName);
  return {
    root,
    localRoot,
    served,
    transport,
    first,
    second,
    before,
    plan,
    incomingName,
    authority: staged.authority,
  };
}

function observePublicationRuns(transport) {
  let applyRuns = 0;
  return {
    transport: Object.freeze({
      ...transport,
      async run(request) {
        if (request.label === "remote release publication") applyRuns += 1;
        return await transport.run(request);
      },
    }),
    count: () => applyRuns,
  };
}

async function assertNoAtomicTemporary(served) {
  assert.deepEqual(
    (await readdir(served)).filter((name) => name.startsWith(".") && name.endsWith(".tmp")),
    [],
  );
}

async function digestTree(root) {
  const digests = new Map();
  async function walk(relative) {
    for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    )) {
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else digests.set(next, sha256(await readFile(join(root, next))));
    }
  }
  await walk("");
  return digests;
}

test("a shipped store is byte-identical and confirmed re-shipping is content-idempotent", async (t) => {
  const root = await workspace(t);
  const published = await publishLocally(root, {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
  });
  const localRoot = join(root, "local-store");
  const served = await remoteStore(root);
  const transport = createLocalTransport();

  const first = await shipPinRelease({
    releaseRoot: localRoot,
    remoteRoot: served,
    transport,
    confirm: true,
  });
  assert.equal(first.applied, true);
  assert.equal(first.unchanged, false);
  assert.equal(first.releaseId, published.releaseId);
  assert.equal(first.uploads.length, 7);

  // The four things Center reads, byte for byte.
  assert.equal(
    await readFile(join(served, "current.json"), "utf8"),
    await readFile(join(localRoot, "current.json"), "utf8"),
  );
  assert.equal(
    await readFile(join(served, "history.json"), "utf8"),
    await readFile(join(localRoot, "history.json"), "utf8"),
  );
  const releasePath = ["releases", published.releaseId];
  assert.deepEqual(
    (await readdir(join(served, ...releasePath))).sort(),
    (await readdir(join(localRoot, ...releasePath))).sort(),
  );
  for (const name of await readdir(join(served, ...releasePath))) {
    assert.equal(
      sha256(await readFile(join(served, ...releasePath, name))),
      sha256(await readFile(join(localRoot, ...releasePath, name))),
    );
  }
  // Nothing beyond the store layout Center understands and its persistent
  // publication lock is left behind — no incoming directory or partial upload.
  const lock = await lstat(join(served, ".publish.lock"));
  assert.equal(lock.isFile(), true);
  assert.equal(lock.isSymbolicLink(), false);
  assert.equal(lock.mode & 0o777, 0o600);
  assert.deepEqual((await readdir(served)).sort(), [".publish.lock", "current.json", "history.json", "releases"]);
  assert.deepEqual(await readdir(join(served, "releases")), [published.releaseId]);

  const before = await digestTree(served);
  const again = await shipPinRelease({
    releaseRoot: localRoot,
    remoteRoot: served,
    transport,
    confirm: true,
  });
  assert.equal(again.applied, true);
  assert.equal(again.unchanged, true);
  assert.equal(again.uploads.length, 0);
  assert.deepEqual([...(await digestTree(served))], [...before]);
});

test("the caller rejects an applied ACK not bound to the actual pointer and release hashes", async (t) => {
  const root = await workspace(t);
  const localRoot = join(root, "local-ack-binding");
  const served = await remoteStore(root, "served-ack-binding");
  await publishLocally(root, {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
    releaseRoot: localRoot,
  });
  const local = createLocalTransport();
  const transport = Object.freeze({
    ...local,
    async run(request) {
      const stdout = await local.run(request);
      if (request.label !== "remote release publication") return stdout;
      const report = JSON.parse(stdout);
      report.historySha256 = "0".repeat(64);
      report.releaseEntries = {};
      return `${JSON.stringify(report)}\n`;
    },
  });
  await assert.rejects(
    () => shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true }),
    (error) => error instanceof PinReleaseShipError && error.code === "apply-failed",
  );
});

test("without --confirm the ship reads both stores and changes nothing", async (t) => {
  const root = await workspace(t);
  await publishLocally(root, { version: "2026-08-09.1", versionCode: 202_608_091 });
  const served = await remoteStore(root);

  const plan = await shipPinRelease({
    releaseRoot: join(root, "local-store"),
    remoteRoot: served,
    transport: createLocalTransport(),
  });
  assert.equal(plan.applied, false);
  assert.equal(plan.uploads.length, 7);
  assert.ok(plan.uploadBytes > 0);
  assert.deepEqual(await readdir(served), []);
});

test("the served release cannot be rolled back, forked, or silently rewritten", async (t) => {
  const root = await workspace(t);
  const localRoot = join(root, "local-store");
  const served = await remoteStore(root);
  const transport = createLocalTransport();

  await publishLocally(root, { version: "2026-08-09.1", versionCode: 202_608_091 });
  await shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true });
  const second = await publishLocally(root, {
    version: "2026-08-09.2",
    versionCode: 202_608_092,
    marker: "two",
  });
  await shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true });
  assert.equal(
    JSON.parse(await readFile(join(served, "current.json"), "utf8")).releaseId,
    second.releaseId,
  );
  const settled = await digestTree(served);

  // An older store — one that only ever published the first release — is
  // exactly what a rollback looks like from the server's side.
  const olderRoot = join(root, "older-store");
  await mkdir(olderRoot, { recursive: true, mode: 0o700 });
  const olderStaging = join(root, "staging-202608091");
  const olderReceipts = await parseBuilderMetadata({
    stagingRoot: olderStaging,
    version: "2026-08-09.1",
    versionCode: 202_608_091,
  });
  await publishPinRelease({
    releaseRoot: olderRoot,
    stagingRoot: olderStaging,
    version: "2026-08-09.1",
    receipts: olderReceipts,
  });
  await assert.rejects(
    () =>
      shipPinRelease({ releaseRoot: olderRoot, remoteRoot: served, transport, confirm: true }),
    (error) => error instanceof PinReleaseShipError && error.code === "history-diverged",
  );

  // A store whose first accepted release is a DIFFERENT build of the same
  // version is a fork, not a rollback, and is refused on the same rule.
  const forkedRoot = join(root, "forked-store");
  await mkdir(forkedRoot, { recursive: true, mode: 0o700 });
  const forkedStaging = join(root, "staging-fork");
  await mkdir(forkedStaging, { mode: 0o700 });
  const rows = [];
  for (const role of PIN_RELEASE_ARTIFACT_ROLES) {
    const bytes = Buffer.from(`forked-apk:${role}\n`);
    await writeFile(join(forkedStaging, `${role}.apk`), bytes, { mode: 0o600 });
    rows.push(
      [
        role,
        PIN_RELEASE_PACKAGE_BY_ROLE[role],
        "2026-08-09.1",
        "202608091",
        PIN_COMPATIBILITY_CERT_SHA256,
        sha256(bytes),
        String(bytes.length),
      ].join("\t"),
    );
  }
  await writeFile(join(forkedStaging, "release-metadata.tsv"), `${rows.join("\n")}\n`, {
    mode: 0o600,
  });
  await publishPinRelease({
    releaseRoot: forkedRoot,
    stagingRoot: forkedStaging,
    version: "2026-08-09.1",
    receipts: await parseBuilderMetadata({
      stagingRoot: forkedStaging,
      version: "2026-08-09.1",
      versionCode: 202_608_091,
    }),
  });
  await assert.rejects(
    () =>
      shipPinRelease({ releaseRoot: forkedRoot, remoteRoot: served, transport, confirm: true }),
    (error) => error instanceof PinReleaseShipError && error.code === "history-diverged",
  );

  // THE PREFIX RULE ITSELF, not the length rule standing in for it. Both cases
  // above are shorter than what the server has accepted, so a ship that only
  // compared lengths would refuse them and still be wrong. This one is exactly
  // as long as the served history and diverges at its FIRST entry: whatever the
  // server already accepted must appear entry for entry at the front, or the
  // server can be made to serve a different build under a history it thinks it
  // has seen.
  await publishLocally(root, {
    version: "2026-08-09.2",
    versionCode: 202_608_092,
    marker: "forked-two",
    releaseRoot: forkedRoot,
    stagingRoot: join(root, "staging-fork-2"),
  });
  const forkedHistory = JSON.parse(await readFile(join(forkedRoot, "history.json"), "utf8"));
  const servedHistory = JSON.parse(await readFile(join(served, "history.json"), "utf8"));
  assert.equal(
    forkedHistory.releases.length,
    servedHistory.releases.length,
    "the point of this case is that the length rule cannot be what refuses it",
  );
  assert.notEqual(forkedHistory.releases[0].releaseId, servedHistory.releases[0].releaseId);
  await assert.rejects(
    () =>
      shipPinRelease({ releaseRoot: forkedRoot, remoteRoot: served, transport, confirm: true }),
    (error) =>
      error instanceof PinReleaseShipError &&
      error.code === "history-diverged" &&
      /position 1/u.test(error.message),
  );

  // And the comparison is entry-for-entry, not id-for-id. A served history that
  // keeps the right release identifiers but misdescribes what it accepted under
  // one of them is still a history this store never published. Only the rest of
  // the entry notices, and only for entries behind the tail -- the tail itself
  // is independently re-derived from current.json.
  const honestHistory = await readFile(join(served, "history.json"));
  const forged = JSON.parse(honestHistory.toString("utf8"));
  forged.releases[0] = {
    ...forged.releases[0],
    manifestSha256: sha256("a manifest document this store never published"),
  };
  await writeFile(join(served, "history.json"), `${JSON.stringify(forged)}\n`, { mode: 0o600 });
  await assert.rejects(
    () => shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true }),
    (error) =>
      error instanceof PinReleaseShipError &&
      error.code === "history-diverged" &&
      /position 1/u.test(error.message),
  );
  await writeFile(join(served, "history.json"), honestHistory, { mode: 0o600 });

  assert.deepEqual([...(await digestTree(served))], [...settled]);
});

test("a tampered served artifact is caught before anything is swapped", async (t) => {
  const root = await workspace(t);
  const localRoot = join(root, "local-store");
  const served = await remoteStore(root);
  const transport = createLocalTransport();

  const first = await publishLocally(root, {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
  });
  await shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true });

  const victim = join(served, "releases", first.releaseId, "hook.apk");
  const original = await readFile(victim);
  const tampered = Buffer.from(original);
  tampered[0] ^= 0xff;
  await writeFile(victim, tampered, { mode: 0o600 });

  await publishLocally(root, {
    version: "2026-08-09.2",
    versionCode: 202_608_092,
    marker: "two",
  });
  await assert.rejects(
    () => shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true }),
    (error) => error instanceof PinReleaseShipError && error.code === "release-equivocation",
  );
  // The refusal happened during inspection: the served release is untouched.
  assert.equal(
    JSON.parse(await readFile(join(served, "current.json"), "utf8")).releaseId,
    first.releaseId,
  );
  assert.deepEqual(await readdir(join(served, "releases")), [first.releaseId]);
});

test("an anti-rollback history that is not canonical bytes is refused on either side", async (t) => {
  // The compare-and-swap on the far side is a swap on BYTES: the apply refuses
  // unless history.json still hashes to what the inspection saw. That is only a
  // meaningful anti-rollback control if the bytes are the single canonical
  // encoding of the parsed history — otherwise two documents that parse the same
  // way have two digests, and "the history I verified" stops naming one file.
  // Reparsing alone does not catch it: a pretty-printed history parses fine and
  // its entries still match every manifest digest.
  const root = await workspace(t);
  const localRoot = join(root, "local-store");
  const served = await remoteStore(root);
  const transport = createLocalTransport();

  await publishLocally(root, { version: "2026-08-09.1", versionCode: 202_608_091 });
  await shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true });

  const reindent = async (path) => {
    const source = await readFile(path, "utf8");
    const parsed = JSON.parse(source);
    assert.notEqual(`${JSON.stringify(parsed, null, 2)}\n`, source, "the fixture must actually re-encode");
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    return source;
  };

  const servedSource = await reindent(join(served, "history.json"));
  await assert.rejects(
    () => inspectRemotePinReleaseStore({ transport, remoteRoot: served, releaseIds: [] }),
    (error) => error instanceof PinReleaseShipError && error.code === "history-noncanonical",
  );
  await writeFile(join(served, "history.json"), servedSource, { mode: 0o600 });

  await reindent(join(localRoot, "history.json"));
  await assert.rejects(
    () => readLocalPinReleaseStore({ root: localRoot }),
    (error) => error instanceof PinReleaseShipError && error.code === "history-noncanonical",
  );
});

test("the far side swaps only when the store still hashes to what the plan saw", async (t) => {
  const root = await workspace(t);
  const localRoot = join(root, "local-store");
  const served = await remoteStore(root);
  const transport = createLocalTransport();

  await publishLocally(root, { version: "2026-08-09.1", versionCode: 202_608_091 });
  await shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true });

  const local = await readLocalPinReleaseStore({ root: localRoot });
  const remote = await inspectRemotePinReleaseStore({
    transport,
    remoteRoot: served,
    releaseIds: [local.tail.releaseId],
  });
  const plan = createPinReleaseShipPlan({ local, remote });
  assert.equal(plan.alreadyCurrent, true);

  const stale = {
    ...plan,
    expectedHistorySha256: sha256("a history document this store never had"),
  };
  await assert.rejects(
    () =>
      transport.run({
        script: REMOTE_APPLY_SCRIPT,
        args: [served],
        document: createApplyPayload(stale, ".incoming-unused"),
        label: "remote release publication",
      }),
    (error) => error instanceof PinReleaseShipError && error.code === "remote-failed",
  );

  // And an immutable release directory is never rewritten in place, even when
  // the caller hands the helper a complete, correctly digested incoming tree.
  const incoming = join(served, "releases", ".incoming-rewrite");
  await mkdir(incoming, { mode: 0o700 });
  for (const upload of [
    { name: "manifest.json", source: join(localRoot, "current.json") },
    ...local.current.manifest.artifacts.map((artifact) => ({
      name: artifact.name,
      source: join(local.releaseDirectory, artifact.name),
    })),
    {
      name: local.current.manifest.authority.name,
      source: join(local.releaseDirectory, local.current.manifest.authority.name),
    },
  ]) {
    await writeFile(join(incoming, upload.name), await readFile(upload.source), { mode: 0o600 });
  }
  const rewrite = {
    ...plan,
    uploads: [
      {
        name: "manifest.json",
        size: Buffer.byteLength(local.current.canonical),
        sha256: sha256(local.current.canonical),
      },
      ...local.current.manifest.artifacts.map((artifact) => ({
        name: artifact.name,
        size: artifact.size,
        sha256: artifact.sha256,
      })),
      {
        name: local.current.manifest.authority.name,
        size: local.current.manifest.authority.size,
        sha256: local.current.manifest.authority.sha256,
      },
    ],
  };
  const rewriteAuthority = await stagedFilesystemAuthority(served, incoming);
  await assert.rejects(
    () =>
      transport.run({
        script: REMOTE_APPLY_SCRIPT,
        args: [served],
        document: createApplyPayload(rewrite, ".incoming-rewrite", rewriteAuthority),
        label: "remote release publication",
      }),
    (error) =>
      error instanceof PinReleaseShipError &&
      error.code === "remote-failed" &&
      // The named refusal, not an incidental rename error. A non-empty target
      // directory makes rename(2) fail on its own, so a test that accepted any
      // failure here would pass against a helper with no immutability rule at
      // all -- and would then say nothing about a release directory that had
      // been emptied.
      /immutable release already exists/u.test(error.message),
  );
  assert.equal(
    JSON.parse(await readFile(join(served, "current.json"), "utf8")).releaseId,
    local.tail.releaseId,
  );
});

test("the per-store lock admits at most one concurrent publisher and preserves one accepted tail", async (t) => {
  const root = await workspace(t);
  const served = await remoteStore(root);
  const transport = createLocalTransport();
  const firstPublished = await publishLocally(root, {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
    marker: "race-a",
    releaseRoot: join(root, "local-a"),
    stagingRoot: join(root, "staging-race-a"),
  });
  const secondPublished = await publishLocally(root, {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
    marker: "race-b",
    releaseRoot: join(root, "local-b"),
    stagingRoot: join(root, "staging-race-b"),
  });
  assert.notEqual(firstPublished.releaseId, secondPublished.releaseId);

  const firstLocal = await readLocalPinReleaseStore({ root: join(root, "local-a") });
  const secondLocal = await readLocalPinReleaseStore({ root: join(root, "local-b") });
  const emptyRemote = await inspectRemotePinReleaseStore({
    transport,
    remoteRoot: served,
    releaseIds: [firstPublished.releaseId, secondPublished.releaseId],
  });
  const firstPlan = createPinReleaseShipPlan({ local: firstLocal, remote: emptyRemote });
  const secondPlan = createPinReleaseShipPlan({ local: secondLocal, remote: emptyRemote });
  const firstStaged = await stagePlan(served, firstPlan, ".incoming-race-a");
  const secondStaged = await stagePlan(served, secondPlan, ".incoming-race-b");

  // Hold the REAL helper immediately after its real nonblocking flock. This is
  // a test-only timing seam in the script text, not a second lock model.
  const lockBoundary = "    lock_fd = acquire_store_lock(root_descriptor)\n    try:";
  assert.ok(REMOTE_APPLY_SCRIPT.includes(lockBoundary));
  const delayedFirstScript = REMOTE_APPLY_SCRIPT.replace(
    lockBoundary,
    [
      "    lock_fd = acquire_store_lock(root_descriptor)",
      "    try:",
      "        import time",
      '        held_path = os.path.join(root, ".test-publish-lock-held")',
      "        held_fd = os.open(held_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)",
      '        os.write(held_fd, b"held\\n")',
      "        os.close(held_fd)",
      '        release_path = os.path.join(root, ".test-publish-lock-release")',
      "        deadline = time.monotonic() + 5",
      "        while not os.path.exists(release_path):",
      "            if time.monotonic() >= deadline:",
      '                raise RuntimeError("test lock hold timed out")',
      "            time.sleep(0.005)",
    ].join("\n"),
  );
  const firstApply = transport.run({
    script: delayedFirstScript,
    args: [served],
    document: createApplyPayload(firstPlan, ".incoming-race-a", firstStaged.authority),
    label: "first concurrent publication",
  });
  const heldMarker = join(served, ".test-publish-lock-held");
  const releaseMarker = join(served, ".test-publish-lock-release");
  let lockObserved = false;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      await lstat(heldMarker);
      lockObserved = true;
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
  }
  if (!lockObserved) {
    await writeFile(releaseMarker, "release\n", { mode: 0o600 });
    await Promise.allSettled([firstApply]);
    assert.fail("the first helper never reported owning the real publication flock");
  }
  const secondApply = transport.run({
    script: REMOTE_APPLY_SCRIPT,
    args: [served],
    document: createApplyPayload(secondPlan, ".incoming-race-b", secondStaged.authority),
    label: "second concurrent publication",
  });
  const [secondOutcome] = await Promise.allSettled([secondApply]);
  await writeFile(releaseMarker, "release\n", { mode: 0o600 });
  const [firstOutcome] = await Promise.allSettled([firstApply]);
  assert.equal(firstOutcome.status, "fulfilled");
  assert.equal(secondOutcome.status, "rejected");
  assert.match(secondOutcome.reason.message, /holds the store lock/u);
  await unlink(heldMarker);
  await unlink(releaseMarker);

  const current = JSON.parse(await readFile(join(served, "current.json"), "utf8"));
  const history = JSON.parse(await readFile(join(served, "history.json"), "utf8"));
  assert.equal(current.releaseId, firstPublished.releaseId);
  assert.equal(history.releases.at(-1).releaseId, current.releaseId);
  assert.deepEqual(
    (await readdir(join(served, "releases"))).filter((name) => !name.startsWith(".")),
    [firstPublished.releaseId],
  );
  assert.equal((await lstat(join(served, ".publish.lock"))).mode & 0o777, 0o600);
});

test("the publication lock refuses symlinks and permissive regular files before CAS", async (t) => {
  const root = await workspace(t);
  const localRoot = join(root, "local-store");
  const transport = createLocalTransport();
  const published = await publishLocally(root, {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
    releaseRoot: localRoot,
  });
  const local = await readLocalPinReleaseStore({ root: localRoot });

  for (const kind of ["symlink", "wrong-mode"]) {
    const served = await remoteStore(root, `served-${kind}`);
    const remote = await inspectRemotePinReleaseStore({
      transport,
      remoteRoot: served,
      releaseIds: [published.releaseId],
    });
    const plan = createPinReleaseShipPlan({ local, remote });
    const incomingName = `.incoming-${kind}`;
    const staged = await stagePlan(served, plan, incomingName);
    const lockPath = join(served, ".publish.lock");
    if (kind === "symlink") {
      const outside = join(root, "outside-lock");
      await writeFile(outside, "outside\n", { mode: 0o600 });
      await symlink(outside, lockPath);
    } else {
      await writeFile(lockPath, "", { mode: 0o600 });
      await chmod(lockPath, 0o644);
    }

    await assert.rejects(
      () => transport.run({
        script: REMOTE_APPLY_SCRIPT,
        args: [served],
        document: createApplyPayload(plan, incomingName, staged.authority),
        label: `${kind} publication lock`,
      }),
      (error) =>
        error instanceof PinReleaseShipError &&
        error.code === "remote-failed" &&
        /publication lock/u.test(error.message),
    );
    assert.equal((await readdir(served)).includes("current.json"), false);
    assert.equal((await readdir(served)).includes("history.json"), false);
    assert.equal((await readdir(join(served, "releases"))).includes(incomingName), true);
  }
});

test("preexisting linked store roots and releases directories are rejected before upload", async (t) => {
  const root = await workspace(t);
  const localRoot = join(root, "local-store");
  await publishLocally(root, {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
    releaseRoot: localRoot,
  });

  for (const target of ["root", "releases"]) {
    await t.test(target, async () => {
      const outside = join(root, `outside-preexisting-${target}`);
      const sentinel = join(outside, "DO-NOT-TOUCH");
      await mkdir(outside, { mode: 0o700 });
      await writeFile(sentinel, `sentinel-${target}\n`, { mode: 0o600 });

      let served;
      if (target === "root") {
        served = join(root, "served-preexisting-root");
        await symlink(outside, served);
      } else {
        served = await remoteStore(root, "served-preexisting-releases");
        await symlink(outside, join(served, "releases"));
      }

      let uploads = 0;
      const local = createLocalTransport();
      const transport = Object.freeze({
        ...local,
        async upload(request) {
          uploads += 1;
          return await local.upload(request);
        },
      });
      await assert.rejects(
        () => shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true }),
        (error) =>
          error instanceof PinReleaseShipError &&
          /(?:real directory|without following links)/u.test(error.message),
      );

      assert.equal(uploads, 0, "linked parents must be refused before the first artifact upload");
      assert.equal(await readFile(sentinel, "utf8"), `sentinel-${target}\n`);
      assert.deepEqual(await readdir(outside), ["DO-NOT-TOUCH"]);
    });
  }
});

test("a root or releases swap after staging cannot redirect upload or cleanup into a sentinel", async (t) => {
  const root = await workspace(t);
  const localRoot = join(root, "local-store");
  await publishLocally(root, {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
    releaseRoot: localRoot,
  });

  for (const target of ["root", "releases"]) {
    await t.test(target, async () => {
      const served = await remoteStore(root, `served-swap-${target}`);
      const outside = join(root, `outside-swap-${target}`);
      const sentinel = join(outside, "DO-NOT-TOUCH");
      await mkdir(outside, { mode: 0o700 });
      await writeFile(sentinel, `sentinel-${target}\n`, { mode: 0o600 });

      let uploads = 0;
      let heldPath;
      const local = createLocalTransport();
      const transport = Object.freeze({
        ...local,
        async makeIncomingDirectory(request) {
          const directory = await local.makeIncomingDirectory(request);
          if (target === "root") {
            heldPath = `${served}.held`;
            await rename(served, heldPath);
            await symlink(outside, served);
          } else {
            heldPath = join(served, "releases.held");
            await rename(join(served, "releases"), heldPath);
            await symlink(outside, join(served, "releases"));
          }
          return directory;
        },
        async upload(request) {
          uploads += 1;
          return await local.upload(request);
        },
      });

      await assert.rejects(
        () => shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true }),
        (error) =>
          error instanceof PinReleaseShipError &&
          error.code === "remote-failed" &&
          /(?:real directory|without following links)/u.test(error.message),
      );

      assert.equal(uploads, 0, "the fresh no-follow validation must run before rsync");
      assert.equal(await readFile(sentinel, "utf8"), `sentinel-${target}\n`);
      assert.deepEqual(await readdir(outside), ["DO-NOT-TOUCH"]);
      assert.equal(
        (await readdir(target === "root" ? join(heldPath, "releases") : heldPath))
          .some((name) => name.startsWith(".incoming-")),
        true,
        "refusing cleanup through the swapped pathname must leave the original staging inode alone",
      );
    });
  }
});

test("directory fsync failures never ACK a rename or pointer replacement, and a retry converges", async (t) => {
  const cases = [
    {
      name: "incoming-rename-eio",
      target: "releases",
      ordinal: 1,
      errorName: "EIO",
      visibleHistory: "before",
      visibleCurrent: "before",
      unchangedOnRetry: false,
    },
    {
      name: "history-replace-enospc",
      target: "root",
      ordinal: 2,
      errorName: "ENOSPC",
      visibleHistory: "after",
      visibleCurrent: "before",
      unchangedOnRetry: false,
    },
    {
      name: "current-replace-eio",
      target: "root",
      ordinal: 3,
      errorName: "EIO",
      visibleHistory: "after",
      visibleCurrent: "after",
      unchangedOnRetry: true,
    },
  ];

  for (const failure of cases) {
    await t.test(failure.name, async (child) => {
      const fixture = await stagedReleaseUpdate(child, failure.name);
      const script = injectDirectoryFsyncFailure({
        targetLabel: failure.target === "root"
          ? "release store root"
          : "immutable releases directory",
        ordinal: failure.ordinal,
        errorName: failure.errorName,
      });

      await assert.rejects(
        () => fixture.transport.run({
          script,
          args: [fixture.served],
          document: createApplyPayload(fixture.plan, fixture.incomingName, fixture.authority),
          label: `injected ${failure.name}`,
        }),
        (error) =>
          error instanceof PinReleaseShipError &&
          error.code === "remote-failed" &&
          error.message.includes(`injected directory fsync ${failure.errorName}`),
      );

      // rename(2)/replace(2) may already be visible when the parent-directory
      // fsync fails. The helper must reject, and every visible pointer must be
      // one complete old or new canonical document — never a partial write.
      assert.equal(
        await readFile(join(fixture.served, "history.json"), "utf8"),
        failure.visibleHistory === "after" ? fixture.plan.historyDocument : fixture.before.history,
      );
      assert.equal(
        await readFile(join(fixture.served, "current.json"), "utf8"),
        failure.visibleCurrent === "after" ? fixture.plan.currentDocument : fixture.before.current,
      );
      assert.equal((await lstat(join(fixture.served, "releases", fixture.second.releaseId))).isDirectory(), true);
      assert.equal((await readdir(join(fixture.served, "releases"))).includes(fixture.incomingName), false);
      await assertNoAtomicTemporary(fixture.served);

      // A confirmed operator retry must run the REAL helper even if both new
      // pointers were already visible, re-establishing the missing durability
      // boundary instead of treating visible-but-unacknowledged bytes as done.
      const observed = observePublicationRuns(fixture.transport);
      const retried = await shipPinRelease({
        releaseRoot: fixture.localRoot,
        remoteRoot: fixture.served,
        transport: observed.transport,
        confirm: true,
      });
      assert.equal(observed.count(), 1);
      assert.equal(retried.applied, true);
      assert.equal(retried.unchanged, failure.unchangedOnRetry);
      assert.equal(retried.uploads.length, 0);
      assert.equal(await readFile(join(fixture.served, "history.json"), "utf8"), fixture.plan.historyDocument);
      assert.equal(await readFile(join(fixture.served, "current.json"), "utf8"), fixture.plan.currentDocument);
      await assertNoAtomicTemporary(fixture.served);
    });
  }
});

test("atomic pointer writes loop through positive short writes before replacing either document", async (t) => {
  const fixture = await stagedReleaseUpdate(t, "short-write");
  const script = injectAtomicWriteBehavior([
    "_test_real_write = os.write",
    "def _test_short_write(handle, data):",
    "    return _test_real_write(handle, data[:max(1, min(len(data), 11))])",
    "os.write = _test_short_write",
    "",
  ], "short atomic write");

  const stdout = await fixture.transport.run({
    script,
    args: [fixture.served],
    document: createApplyPayload(fixture.plan, fixture.incomingName, fixture.authority),
    label: "short atomic writes",
  });
  assert.equal(JSON.parse(stdout).applied, true);
  assert.equal(await readFile(join(fixture.served, "history.json"), "utf8"), fixture.plan.historyDocument);
  assert.equal(await readFile(join(fixture.served, "current.json"), "utf8"), fixture.plan.currentDocument);
  assert.equal((await lstat(join(fixture.served, "history.json"))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(fixture.served, "current.json"))).mode & 0o777, 0o600);
  await assertNoAtomicTemporary(fixture.served);
});

test("zero-progress and mid-write errors preserve old pointers and unlink the partial temporary", async (t) => {
  for (const failure of [
    { name: "zero-progress", action: 'return 0', message: "made no safe progress" },
    {
      name: "mid-write-eio",
      action: 'raise OSError(errno.EIO, "injected atomic write EIO")',
      message: "injected atomic write EIO",
    },
  ]) {
    await t.test(failure.name, async (child) => {
      const fixture = await stagedReleaseUpdate(child, failure.name);
      const script = injectAtomicWriteBehavior([
        "_test_real_write = os.write",
        "_test_write_calls = 0",
        "def _test_failed_write(handle, data):",
        "    global _test_write_calls",
        "    _test_write_calls += 1",
        "    if _test_write_calls == 1:",
        "        return _test_real_write(handle, data[:max(1, min(len(data), 13))])",
        "    if _test_write_calls == 2:",
        `        ${failure.action}`,
        "    return _test_real_write(handle, data)",
        "os.write = _test_failed_write",
        "",
      ], failure.name);

      await assert.rejects(
        () => fixture.transport.run({
          script,
          args: [fixture.served],
          document: createApplyPayload(fixture.plan, fixture.incomingName, fixture.authority),
          label: failure.name,
        }),
        (error) =>
          error instanceof PinReleaseShipError &&
          error.code === "remote-failed" &&
          error.message.includes(failure.message),
      );

      assert.equal(await readFile(join(fixture.served, "history.json"), "utf8"), fixture.before.history);
      assert.equal(await readFile(join(fixture.served, "current.json"), "utf8"), fixture.before.current);
      assert.equal((await lstat(join(fixture.served, "releases", fixture.second.releaseId))).isDirectory(), true);
      assert.equal((await readdir(join(fixture.served, "releases"))).includes(fixture.incomingName), false);
      await assertNoAtomicTemporary(fixture.served);

      const observed = observePublicationRuns(fixture.transport);
      const retried = await shipPinRelease({
        releaseRoot: fixture.localRoot,
        remoteRoot: fixture.served,
        transport: observed.transport,
        confirm: true,
      });
      assert.equal(observed.count(), 1);
      assert.equal(retried.applied, true);
      assert.equal(retried.unchanged, false);
      assert.equal(retried.uploads.length, 0);
      assert.equal(await readFile(join(fixture.served, "history.json"), "utf8"), fixture.plan.historyDocument);
      assert.equal(await readFile(join(fixture.served, "current.json"), "utf8"), fixture.plan.currentDocument);
      await assertNoAtomicTemporary(fixture.served);
    });
  }
});

test("pointer temporaries remain unnamed through every content write", async (t) => {
  const fixture = await stagedReleaseUpdate(t, "unnamed-pointer-temp");
  const outside = join(fixture.root, "outside-unnamed-pointer-temp");
  const sentinel = join(outside, "DO-NOT-TOUCH");
  const exported = join(outside, "EXPORTED-POINTER");
  const barriers = join(fixture.root, "unnamed-pointer-temp-barriers");
  await mkdir(outside, { mode: 0o700 });
  await writeFile(sentinel, "pointer-sentinel\n", { mode: 0o640 });

  const boundary = '    handle = os.open(".", flags, 0o600, dir_fd=root_descriptor)\n';
  const script = replaceApplyScriptOnce(
    REMOTE_APPLY_SCRIPT,
    boundary,
    [
      boundary.trimEnd(),
      "    if os.fstat(handle).st_nlink != 0:",
      '        refuse("test observed a named writable pointer inode")',
      "    try:",
      `        os.link(temporary, ${JSON.stringify(exported)}, src_dir_fd=root_descriptor, follow_symlinks=False)`,
      "    except FileNotFoundError:",
      "        pass",
      "    else:",
      '        refuse("test exported a writable pointer inode")',
      `    with open(${JSON.stringify(barriers)}, "ab", buffering=0) as _test_barrier:`,
      '        _test_barrier.write((name + "\\n").encode("utf-8"))',
      "",
    ].join("\n"),
    "unnamed pointer temporary",
  );
  const stdout = await fixture.transport.run({
    script,
    args: [fixture.served],
    document: createApplyPayload(fixture.plan, fixture.incomingName, fixture.authority),
    label: "unnamed pointer temporary",
  });

  assert.equal(JSON.parse(stdout).applied, true);
  assert.deepEqual((await readFile(barriers, "utf8")).trim().split("\n"), [
    "history.json",
    "current.json",
  ]);
  await assert.rejects(() => lstat(exported), (error) => error?.code === "ENOENT");
  assert.equal(await readFile(sentinel, "utf8"), "pointer-sentinel\n");
  const sentinelInfo = await lstat(sentinel);
  assert.equal(sentinelInfo.mode & 0o777, 0o640);
  assert.equal(sentinelInfo.nlink, 1);
});

test("apply payload is withheld until nondumpable READY and cannot be reached through procfs", async (t) => {
  const fixture = await stagedReleaseUpdate(t, "protected-apply-input");
  const marker = join(fixture.root, "protected-apply-ready");
  const gate = join(fixture.root, "protected-apply-continue");
  const beforeTmp = new Set(await readdir(tmpdir()));
  const boundary = [
    '    sys.stdout.write("READY\\n")',
    "    sys.stdout.flush()",
    "",
  ].join("\n");
  const script = replaceApplyScriptOnce(
    REMOTE_APPLY_SCRIPT,
    boundary,
    [
      boundary.trimEnd(),
      "    import time",
      `    with open(${JSON.stringify(marker)}, "w", encoding="ascii") as _test_marker:`,
      "        _test_marker.write(str(os.getpid()))",
      `    while not os.path.exists(${JSON.stringify(gate)}):`,
      "        time.sleep(0.005)",
      "",
    ].join("\n"),
    "protected apply input pre-read",
  );
  const application = fixture.transport.run({
    script,
    args: [fixture.served],
    document: createApplyPayload(fixture.plan, fixture.incomingName, fixture.authority),
    label: "protected apply input",
  });
  t.after(() => writeFile(gate, "continue\n", { mode: 0o600 }).catch(() => undefined));

  let pid = null;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    try {
      const candidate = (await readFile(marker, "utf8")).trim();
      if (/^[1-9][0-9]*$/u.test(candidate)) {
        pid = candidate;
        break;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
  }
  assert.match(pid ?? "", /^[1-9][0-9]*$/u);
  const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
  assert.equal(cmdline.includes("REVIVAL_PIN_PAYLOAD"), false);
  assert.equal(cmdline.includes(fixture.plan.historyDocument), false);
  assert.equal(cmdline.includes(Buffer.from(fixture.plan.currentDocument).toString("base64")), false);
  const afterTmp = await readdir(tmpdir());
  assert.deepEqual(
    afterTmp.filter((name) => name.startsWith("tmp.") && !beforeTmp.has(name)),
    [],
    "apply must not materialize a named mktemp payload",
  );
  let exposed = null;
  try {
    exposed = await open(`/proc/${pid}/fd/0`, "r");
  } catch (error) {
    assert.ok(["EACCES", "EPERM", "ENOENT"].includes(error?.code));
  }
  if (exposed !== null) {
    await exposed.close();
    assert.fail("a same-UID peer opened the protected framed-input pipe through procfs");
  }
  await writeFile(gate, "continue\n", { mode: 0o600 });
  const result = JSON.parse(await application);
  assert.equal(result.applied, true);
  assert.equal(result.historySha256, sha256(fixture.plan.historyDocument));
  assert.equal(result.currentSha256, sha256(fixture.plan.currentDocument));
});

test("every post-publication pointer boundary reopens and rehashes exact bytes", async (t) => {
  const boundaries = new Map([
    ["history.json", 4],
    ["current.json", 2],
  ]);
  for (const [name, count] of boundaries) {
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
      for (const action of ["in-place", "replacement"]) {
        await t.test(`${name}-${ordinal}-${action}`, async (child) => {
          const suffix = `${name.replace(".json", "")}-${ordinal}-${action}`;
          const fixture = await stagedReleaseUpdate(child, `pointer-${suffix}`);
          const outside = join(fixture.root, `outside-pointer-${suffix}`);
          const sentinel = join(outside, "DO-NOT-TOUCH");
          await mkdir(outside, { mode: 0o700 });
          await writeFile(sentinel, `sentinel-${suffix}\n`, { mode: 0o640 });
          const functionBoundary = [
            "def verify_published_document(root_descriptor, name, observation):",
            '    descriptor = observation.get("descriptor")',
          ].join("\n");
          const attack = action === "in-place"
            ? [
                "        _test_pointer = os.open(name, os.O_WRONLY | os.O_NOFOLLOW, dir_fd=root_descriptor)",
                "        try:",
                "            os.ftruncate(_test_pointer, 0)",
                '            os.write(_test_pointer, b\'{"attacker":true}\\n\')',
                "            os.fsync(_test_pointer)",
                "        finally:",
                "            os.close(_test_pointer)",
              ]
            : [
                "        os.rename(name, name + \".attacker-held\", src_dir_fd=root_descriptor, dst_dir_fd=root_descriptor)",
                `        os.symlink(${JSON.stringify(sentinel)}, name, dir_fd=root_descriptor)`,
              ];
          const script = replaceApplyScriptOnce(
            REMOTE_APPLY_SCRIPT,
            functionBoundary,
            [
              "_test_pointer_verify_counts = globals().get(\"_test_pointer_verify_counts\", {})",
              "",
              "",
              "def verify_published_document(root_descriptor, name, observation):",
              "    _test_pointer_verify_counts[name] = _test_pointer_verify_counts.get(name, 0) + 1",
              `    if name == ${JSON.stringify(name)} and _test_pointer_verify_counts[name] == ${ordinal}:`,
              ...attack,
              '    descriptor = observation.get("descriptor")',
            ].join("\n"),
            `pointer ${suffix}`,
          );

          await assert.rejects(
            () => fixture.transport.run({
              script,
              args: [fixture.served],
              document: createApplyPayload(fixture.plan, fixture.incomingName, fixture.authority),
              label: `pointer ${suffix}`,
            }),
            (error) =>
              error instanceof PinReleaseShipError &&
              error.code === "remote-failed" &&
              /changed/u.test(error.message) &&
              !/"applied":true/u.test(error.message),
          );
          assert.equal(await readFile(sentinel, "utf8"), `sentinel-${suffix}\n`);
          const sentinelInfo = await lstat(sentinel);
          assert.equal(sentinelInfo.mode & 0o777, 0o640);
          assert.equal(sentinelInfo.nlink, 1);
        });
      }
    }
  }
});

test("apply rejects a manifest name replaced after its genuine fd digest without touching the target", async (t) => {
  const fixture = await stagedReleaseUpdate(t, "post-hash-manifest-swap");
  const outside = join(fixture.root, "outside-post-hash-manifest");
  const sentinel = join(outside, "DO-NOT-TOUCH");
  await mkdir(outside, { mode: 0o700 });
  await writeFile(sentinel, "sentinel-post-hash\n", { mode: 0o640 });

  const boundary = "                size, sha256 = digest_fd(descriptor)\n";
  const replacement = [
    boundary.trimEnd(),
    '                if name == "manifest.json":',
    "                    os.rename(",
    "                        name, name + \".verified-held\",",
    "                        src_dir_fd=incoming_descriptor,",
    "                        dst_dir_fd=incoming_descriptor,",
    "                    )",
    `                    os.symlink(${JSON.stringify(sentinel)}, name, dir_fd=incoming_descriptor)`,
    "",
  ].join("\n");
  const script = replaceApplyScriptOnce(
    REMOTE_APPLY_SCRIPT,
    boundary,
    replacement,
    "post-hash manifest replacement",
  );

  await assert.rejects(
    () => fixture.transport.run({
      script,
      args: [fixture.served],
      document: createApplyPayload(fixture.plan, fixture.incomingName, fixture.authority),
      label: "post-hash manifest replacement",
    }),
    (error) =>
      error instanceof PinReleaseShipError &&
      error.code === "remote-failed" &&
      /incoming entry manifest\.json changed after it was opened/u.test(error.message),
  );

  assert.equal(await readFile(sentinel, "utf8"), "sentinel-post-hash\n");
  assert.equal((await lstat(sentinel)).mode & 0o777, 0o640);
  assert.equal(await readFile(join(fixture.served, "history.json"), "utf8"), fixture.before.history);
  assert.equal(await readFile(join(fixture.served, "current.json"), "utf8"), fixture.before.current);
  await assert.rejects(
    () => lstat(join(fixture.served, "releases", fixture.second.releaseId)),
    (error) => error?.code === "ENOENT",
  );
  const incoming = join(fixture.served, "releases", fixture.incomingName);
  assert.equal((await lstat(join(incoming, "manifest.json"))).isSymbolicLink(), true);
  assert.equal((await lstat(join(incoming, "manifest.json.verified-held"))).isFile(), true);
});

test("apply keeps release descriptors through pointer writes and rejects a post-rename directory swap", async (t) => {
  const fixture = await stagedReleaseUpdate(t, "post-rename-directory-swap");
  const releases = join(fixture.served, "releases");
  const preparedName = `${fixture.second.releaseId}.prepared`;
  const prepared = join(releases, preparedName);
  const sentinel = join(prepared, "DO-NOT-TOUCH");
  await mkdir(prepared, { mode: 0o700 });
  await writeFile(sentinel, "post-rename-directory-sentinel\n", { mode: 0o640 });

  const boundary = [
    '            sync_directory_fd(releases_descriptor, "immutable releases directory")',
    "            # Keep every descriptor that proved the release alive through both",
  ].join("\n");
  const injected = [
    '            sync_directory_fd(releases_descriptor, "immutable releases directory")',
    `            os.rename(release_id, release_id + ".verified-held", src_dir_fd=releases_descriptor, dst_dir_fd=releases_descriptor)`,
    `            os.rename(${JSON.stringify(preparedName)}, release_id, src_dir_fd=releases_descriptor, dst_dir_fd=releases_descriptor)`,
    "            # Keep every descriptor that proved the release alive through both",
  ].join("\n");
  const script = replaceApplyScriptOnce(
    REMOTE_APPLY_SCRIPT,
    boundary,
    injected,
    "post-rename release directory swap",
  );

  await assert.rejects(
    () => fixture.transport.run({
      script,
      args: [fixture.served],
      document: createApplyPayload(fixture.plan, fixture.incomingName, fixture.authority),
      label: "post-rename release directory swap",
    }),
    (error) =>
      error instanceof PinReleaseShipError &&
      error.code === "remote-failed" &&
      /published immutable release changed after verification/u.test(error.message),
  );

  await assert.rejects(
    () => lstat(join(releases, fixture.second.releaseId)),
    (error) => error?.code === "ENOENT",
  );
  const quarantines = (await readdir(releases)).filter((name) =>
    name.startsWith(`.rejected-${fixture.second.releaseId.slice(0, 16)}-`),
  );
  assert.equal(quarantines.length, 1);
  const movedSentinel = join(releases, quarantines[0], "DO-NOT-TOUCH");
  assert.equal(await readFile(movedSentinel, "utf8"), "post-rename-directory-sentinel\n");
  assert.equal((await lstat(movedSentinel)).mode & 0o777, 0o640);
  assert.equal(await readFile(join(fixture.served, "history.json"), "utf8"), fixture.before.history);
  assert.equal(await readFile(join(fixture.served, "current.json"), "utf8"), fixture.before.current);
  assert.equal(
    (await lstat(join(releases, `${fixture.second.releaseId}.verified-held`, "manifest.json"))).isFile(),
    true,
  );
});

test("the publication rename atomically refuses a prepared empty release directory", async (t) => {
  const fixture = await stagedReleaseUpdate(t, "rename-noreplace-race");
  const releases = join(fixture.served, "releases");
  const preparedName = `${fixture.second.releaseId}.prepared-empty`;
  const prepared = join(releases, preparedName);
  await mkdir(prepared, { mode: 0o711 });
  const preparedIdentity = await filesystemAuthority(prepared);

  const boundary = [
    "            rename_noreplace(",
    "                releases_descriptor,",
    "                incoming_name,",
  ].join("\n");
  const injected = [
    `            os.rename(${JSON.stringify(preparedName)}, release_id, src_dir_fd=releases_descriptor, dst_dir_fd=releases_descriptor)`,
    "            rename_noreplace(",
    "                releases_descriptor,",
    "                incoming_name,",
  ].join("\n");
  const script = replaceApplyScriptOnce(
    REMOTE_APPLY_SCRIPT,
    boundary,
    injected,
    "atomic no-replace publication",
  );

  await assert.rejects(
    () => fixture.transport.run({
      script,
      args: [fixture.served],
      document: createApplyPayload(fixture.plan, fixture.incomingName, fixture.authority),
      label: "atomic no-replace publication",
    }),
    (error) =>
      error instanceof PinReleaseShipError &&
      error.code === "remote-failed" &&
      /immutable release already exists; it must never be rewritten/u.test(error.message),
  );

  const final = join(releases, fixture.second.releaseId);
  assert.deepEqual(await filesystemAuthority(final), preparedIdentity);
  assert.deepEqual(await readdir(final), []);
  assert.equal((await lstat(join(releases, fixture.incomingName, "manifest.json"))).isFile(), true);
  assert.equal(await readFile(join(fixture.served, "history.json"), "utf8"), fixture.before.history);
  assert.equal(await readFile(join(fixture.served, "current.json"), "utf8"), fixture.before.current);
});

test("the far side re-hashes what it received before it publishes any of it", async (t) => {
  // Everything upstream of this is digest-pinned, but the bytes still crossed a
  // network. The far side is the last place a corrupted or substituted artifact
  // can be caught, and it is the only place that has seen the bytes that landed
  // rather than the bytes that were sent.
  const root = await workspace(t);
  const localRoot = join(root, "local-store");
  const served = await remoteStore(root);
  const transport = createLocalTransport();

  const first = await publishLocally(root, { version: "2026-08-09.1", versionCode: 202_608_091 });
  await shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true });
  const settled = await digestTree(served);

  const second = await publishLocally(root, {
    version: "2026-08-09.2",
    versionCode: 202_608_092,
    marker: "two",
  });
  const local = await readLocalPinReleaseStore({ root: localRoot });
  const remote = await inspectRemotePinReleaseStore({
    transport,
    remoteRoot: served,
    releaseIds: [first.releaseId, second.releaseId],
  });
  const plan = createPinReleaseShipPlan({ local, remote });
  assert.ok(plan.uploads.length > 1, "release 2 is not on the server yet, so it is a real upload");

  // Stage the upload the way the transport would, then corrupt one landed byte.
  const incoming = join(served, "releases", ".incoming-corrupt");
  await mkdir(incoming, { mode: 0o700 });
  const victim = plan.uploads.find((upload) => upload.name.endsWith(".apk"));
  for (const upload of plan.uploads) {
    const bytes = Buffer.from(await readFile(upload.source));
    if (upload.name === victim.name) bytes[bytes.length - 1] ^= 0xff;
    await writeFile(join(incoming, upload.name), bytes, { mode: 0o600 });
  }
  const corruptAuthority = await stagedFilesystemAuthority(served, incoming);

  await assert.rejects(
    () =>
      transport.run({
        script: REMOTE_APPLY_SCRIPT,
        args: [served],
        document: createApplyPayload(plan, ".incoming-corrupt", corruptAuthority),
        label: "remote release publication",
      }),
    (error) =>
      error instanceof PinReleaseShipError &&
      error.code === "remote-failed" &&
      /does not match its pinned digest/u.test(error.message),
  );

  // Nothing was published: no second release directory, and the pointers still
  // name the release that was already being served.
  assert.deepEqual(
    (await readdir(join(served, "releases"))).filter((name) => !name.startsWith(".")),
    [first.releaseId],
  );
  assert.equal(
    JSON.parse(await readFile(join(served, "current.json"), "utf8")).releaseId,
    first.releaseId,
  );
  const after = await digestTree(served);
  for (const [name, value] of settled) assert.equal(after.get(name), value, `${name} moved`);
});

test("the far side publishes exactly the planned files, not whatever landed", async (t) => {
  // Re-hashing each file it finds is not the same as knowing it found them all.
  // A transfer that dies partway leaves a SHORT directory whose every present
  // file hashes correctly, and renaming that into place publishes an immutable
  // release with an artifact missing — which Center then serves as the current
  // release, and which can never be corrected because releases are never
  // rewritten. The inventory has to be checked as a set, in both directions.
  const root = await workspace(t);
  const localRoot = join(root, "local-store");
  const served = await remoteStore(root);
  const transport = createLocalTransport();

  const first = await publishLocally(root, { version: "2026-08-09.1", versionCode: 202_608_091 });
  await shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true });
  const settled = await digestTree(served);

  const second = await publishLocally(root, {
    version: "2026-08-09.2",
    versionCode: 202_608_092,
    marker: "two",
  });
  const local = await readLocalPinReleaseStore({ root: localRoot });
  const remote = await inspectRemotePinReleaseStore({
    transport,
    remoteRoot: served,
    releaseIds: [first.releaseId, second.releaseId],
  });
  const plan = createPinReleaseShipPlan({ local, remote });

  const stage = async (name, adjust) => {
    const incoming = join(served, "releases", name);
    await mkdir(incoming, { mode: 0o700 });
    for (const upload of plan.uploads) {
      await writeFile(join(incoming, upload.name), await readFile(upload.source), { mode: 0o600 });
    }
    await adjust(incoming);
    const authority = await stagedFilesystemAuthority(served, incoming);
    await assert.rejects(
      () =>
        transport.run({
          script: REMOTE_APPLY_SCRIPT,
          args: [served],
          document: createApplyPayload(plan, name, authority),
          label: "remote release publication",
        }),
      (error) =>
        error instanceof PinReleaseShipError &&
        error.code === "remote-failed" &&
        /does not hold exactly the planned files/u.test(error.message),
      `an incoming directory adjusted by ${name} must be refused`,
    );
    await rm(incoming, { recursive: true, force: true });
  };

  // A transfer that died after four of the six files.
  await stage(".incoming-short", async (incoming) =>
    unlink(join(incoming, plan.uploads.at(-1).name)));
  // And anything that was never planned, however harmless it looks.
  await stage(".incoming-extra", async (incoming) =>
    writeFile(join(incoming, "notes.txt"), "left behind\n", { mode: 0o600 }));

  assert.deepEqual(
    (await readdir(join(served, "releases"))).filter((name) => !name.startsWith(".")),
    [first.releaseId],
  );
  const after = await digestTree(served);
  for (const [name, value] of settled) assert.equal(after.get(name), value, `${name} moved`);
});

test("a served store that lost its pointers is repaired without re-uploading the APKs", async (t) => {
  const root = await workspace(t);
  const localRoot = join(root, "local-store");
  const served = await remoteStore(root);
  const transport = createLocalTransport();

  const published = await publishLocally(root, {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
  });
  await shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true });
  const expected = await digestTree(served);

  await unlink(join(served, "current.json"));
  await unlink(join(served, "history.json"));

  const repaired = await shipPinRelease({
    releaseRoot: localRoot,
    remoteRoot: served,
    transport,
    confirm: true,
  });
  assert.equal(repaired.applied, true);
  assert.equal(repaired.unchanged, false);
  // The 200 MiB-class artifacts are already there and provably identical, so
  // the repair moves two small documents and nothing else.
  assert.equal(repaired.uploads.length, 0);
  assert.equal(repaired.releaseId, published.releaseId);
  assert.deepEqual([...(await digestTree(served))], [...expected]);

  // The repair is the one path that adopts a release directory it did not just
  // upload, and with the pointers gone that directory is no longer the served
  // tail, so nothing else has proven it. Reusing it unverified would let a
  // pointer loss launder a substituted APK into `current.json`.
  await unlink(join(served, "current.json"));
  await unlink(join(served, "history.json"));
  const victim = join(served, "releases", published.releaseId, "hook.apk");
  const original = await readFile(victim);
  const tampered = Buffer.from(original);
  tampered[0] ^= 0xff;
  await writeFile(victim, tampered, { mode: 0o600 });

  await assert.rejects(
    () => shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true }),
    (error) => error instanceof PinReleaseShipError && error.code === "release-equivocation",
  );
  assert.equal(
    (await readdir(served)).includes("current.json"),
    false,
    "a refused repair publishes no pointer at all",
  );
});

test("pointer-loss repair rehashes the retained release after inspection before restoring pointers", async (t) => {
  const root = await workspace(t);
  const localRoot = join(root, "local-store");
  const served = await remoteStore(root, "served-retained-rehash");
  const transport = createLocalTransport();
  const published = await publishLocally(root, {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
    releaseRoot: localRoot,
  });
  await shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true });
  await unlink(join(served, "history.json"));
  await unlink(join(served, "current.json"));

  const local = await readLocalPinReleaseStore({ root: localRoot });
  const remote = await inspectRemotePinReleaseStore({
    transport,
    remoteRoot: served,
    releaseIds: [published.releaseId],
  });
  const plan = createPinReleaseShipPlan({ local, remote });
  assert.equal(plan.uploads.length, 0);

  const victim = join(served, "releases", published.releaseId, "hook.apk");
  await writeFile(victim, "post-inspection mutation\n", { mode: 0o600 });
  await assert.rejects(
    () => transport.run({
      script: REMOTE_APPLY_SCRIPT,
      args: [served],
      document: createApplyPayload(plan, ".incoming-unused"),
      label: "retained release rehash",
    }),
    (error) =>
      error instanceof PinReleaseShipError &&
      error.code === "remote-failed" &&
      /retained release entry does not match its pinned digest/u.test(error.message),
  );
  assert.equal((await readdir(served)).includes("history.json"), false);
  assert.equal((await readdir(served)).includes("current.json"), false);
});

test("final commit rehash rejects a same-inode retained-file mutation after its genuine digest", async (t) => {
  const root = await workspace(t);
  const localRoot = join(root, "local-retained-final-rehash");
  const served = await remoteStore(root, "served-retained-final-rehash");
  const transport = createLocalTransport();
  const published = await publishLocally(root, {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
    releaseRoot: localRoot,
  });
  await shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true });
  await unlink(join(served, "history.json"));
  await unlink(join(served, "current.json"));
  const local = await readLocalPinReleaseStore({ root: localRoot });
  const remote = await inspectRemotePinReleaseStore({
    transport,
    remoteRoot: served,
    releaseIds: [published.releaseId],
  });
  const plan = createPinReleaseShipPlan({ local, remote });
  const boundary = '            reprove_link(final_descriptor, name, descriptor, "retained release entry " + name)\n';
  const script = replaceApplyScriptOnce(
    REMOTE_APPLY_SCRIPT,
    boundary,
    [
      boundary.trimEnd(),
      '            if name == "hook.apk":',
      '                _test_victim = os.open(name, os.O_RDWR | os.O_NOFOLLOW, dir_fd=final_descriptor)',
      "                try:",
      "                    _test_byte = os.pread(_test_victim, 1, 0)",
      "                    os.pwrite(_test_victim, bytes([_test_byte[0] ^ 0xff]), 0)",
      "                    os.fsync(_test_victim)",
      "                finally:",
      "                    os.close(_test_victim)",
      "",
    ].join("\n"),
    "retained post-digest in-place mutation",
  );
  await assert.rejects(
    () => transport.run({
      script,
      args: [served],
      document: createApplyPayload(plan, ".incoming-unused"),
      label: "retained final commit rehash",
    }),
    (error) =>
      error instanceof PinReleaseShipError &&
      error.code === "remote-failed" &&
      /published release entry changed in place/u.test(error.message),
  );
  assert.equal((await readdir(served)).includes("history.json"), false);
  assert.equal((await readdir(served)).includes("current.json"), false);
});

test("final commit rehash rejects a same-inode newly-renamed file mutation", async (t) => {
  const fixture = await stagedReleaseUpdate(t, "new-release-final-rehash");
  const boundary = [
    "            retained_directory = incoming_descriptor",
    "            incoming_descriptor = None",
    "            retained_descriptors = entry_descriptors",
    "            entry_descriptors = {}",
    "",
  ].join("\n");
  const script = replaceApplyScriptOnce(
    REMOTE_APPLY_SCRIPT,
    boundary,
    [
      boundary.trimEnd(),
      '            _test_victim = os.open("hook.apk", os.O_RDWR | os.O_NOFOLLOW, dir_fd=retained_directory)',
      "            try:",
      "                _test_byte = os.pread(_test_victim, 1, 0)",
      "                os.pwrite(_test_victim, bytes([_test_byte[0] ^ 0xff]), 0)",
      "                os.fsync(_test_victim)",
      "            finally:",
      "                os.close(_test_victim)",
      "",
    ].join("\n"),
    "new release post-rename in-place mutation",
  );
  await assert.rejects(
    () => fixture.transport.run({
      script,
      args: [fixture.served],
      document: createApplyPayload(fixture.plan, fixture.incomingName, fixture.authority),
      label: "new release final commit rehash",
    }),
    (error) =>
      error instanceof PinReleaseShipError &&
      error.code === "remote-failed" &&
      /published release entry changed in place/u.test(error.message),
  );
  assert.equal(await readFile(join(fixture.served, "history.json"), "utf8"), fixture.before.history);
  assert.equal(await readFile(join(fixture.served, "current.json"), "utf8"), fixture.before.current);
});

test("pointer-loss repair rejects a prepared real-directory replacement of the retained release", async (t) => {
  const root = await workspace(t);
  const localRoot = join(root, "local-store-retained-directory-authority");
  const served = await remoteStore(root, "served-retained-directory-authority");
  const transport = createLocalTransport();
  const published = await publishLocally(root, {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
    marker: "retained-directory-authority",
    releaseRoot: localRoot,
    stagingRoot: join(root, "staging-retained-directory-authority"),
  });
  await shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true });
  await unlink(join(served, "history.json"));
  await unlink(join(served, "current.json"));

  const local = await readLocalPinReleaseStore({ root: localRoot });
  const remote = await inspectRemotePinReleaseStore({
    transport,
    remoteRoot: served,
    releaseIds: [published.releaseId],
  });
  const plan = createPinReleaseShipPlan({ local, remote });
  assert.equal(plan.uploads.length, 0);

  const releases = join(served, "releases");
  const release = join(releases, published.releaseId);
  const held = `${release}.held`;
  const prepared = join(releases, `${published.releaseId}.prepared`);
  await mkdir(prepared, { mode: 0o700 });
  await writeFile(join(prepared, "DO-NOT-TOUCH"), "retained-directory-sentinel\n", { mode: 0o640 });
  await rename(release, held);
  await rename(prepared, release);

  await assert.rejects(
    () => transport.run({
      script: REMOTE_APPLY_SCRIPT,
      args: [served],
      document: createApplyPayload(plan, ".incoming-unused"),
      label: "retained release directory authority",
    }),
    (error) =>
      error instanceof PinReleaseShipError &&
      error.code === "remote-failed" &&
      /retained immutable release differs from the publication filesystem authority/u.test(error.message),
  );
  assert.equal(await readFile(join(release, "DO-NOT-TOUCH"), "utf8"), "retained-directory-sentinel\n");
  assert.equal((await lstat(join(release, "DO-NOT-TOUCH"))).mode & 0o777, 0o640);
  assert.equal((await readdir(served)).includes("history.json"), false);
  assert.equal((await readdir(served)).includes("current.json"), false);
});

test("a ship cut off between its two document writes is completed, not wedged", async (t) => {
  const root = await workspace(t);
  const localRoot = join(root, "local-store");
  const served = await remoteStore(root);
  const transport = createLocalTransport();

  const first = await publishLocally(root, {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
  });
  await shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true });
  const second = await publishLocally(root, {
    version: "2026-08-09.2",
    versionCode: 202_608_092,
    marker: "two",
  });
  await shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true });
  const settled = await digestTree(served);

  // Publication writes history.json and then current.json. Reproduce the
  // interruption between them: the second release is accepted and present, the
  // served pointer is still the first.
  await writeFile(
    join(served, "current.json"),
    await readFile(join(root, "local-store", "releases", first.releaseId, "manifest.json"), "utf8"),
    { mode: 0o600 },
  );

  const repaired = await shipPinRelease({
    releaseRoot: localRoot,
    remoteRoot: served,
    transport,
    confirm: true,
  });
  assert.equal(repaired.applied, true);
  assert.equal(repaired.releaseId, second.releaseId);
  assert.equal(repaired.uploads.length, 0);
  assert.deepEqual([...(await digestTree(served))], [...settled]);

  // The same shape in the LOCAL store is refused rather than papered over: only
  // `pin release build` may repair the store it owns.
  await writeFile(
    join(localRoot, "current.json"),
    await readFile(join(localRoot, "releases", first.releaseId, "manifest.json"), "utf8"),
    { mode: 0o600 },
  );
  await assert.rejects(
    () => shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true }),
    (error) =>
      error instanceof PinReleaseShipError && error.code === "history-current-mismatch",
  );

  // Two steps behind is not an interrupted swap; it is a rollback attempt.
  await writeFile(
    join(served, "current.json"),
    await readFile(join(localRoot, "releases", second.releaseId, "manifest.json"), "utf8"),
    { mode: 0o600 },
  );
  const third = await publishLocally(root, {
    version: "2026-08-09.3",
    versionCode: 202_608_093,
    marker: "three",
  });
  await shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true });
  assert.equal(
    JSON.parse(await readFile(join(served, "current.json"), "utf8")).releaseId,
    third.releaseId,
  );
  await writeFile(
    join(served, "current.json"),
    await readFile(join(localRoot, "releases", first.releaseId, "manifest.json"), "utf8"),
    { mode: 0o600 },
  );
  await assert.rejects(
    () =>
      inspectRemotePinReleaseStore({
        transport,
        remoteRoot: served,
        releaseIds: [third.releaseId],
      }),
    (error) =>
      error instanceof PinReleaseShipError && error.code === "history-current-mismatch",
  );
});

test("artifact bytes never enter the ssh payload and never enter this process whole", async (t) => {
  const root = await workspace(t);
  const localRoot = join(root, "local-store");
  const served = await remoteStore(root);
  const transport = createLocalTransport();
  const serverBytes = 6 * 1024 * 1024;

  await publishLocally(root, {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
    serverBytes,
  });
  const local = await readLocalPinReleaseStore({ root: localRoot });
  const remote = await inspectRemotePinReleaseStore({
    transport,
    remoteRoot: served,
    releaseIds: [local.tail.releaseId],
  });
  const plan = createPinReleaseShipPlan({ local, remote });
  assert.ok(plan.uploadBytes > serverBytes);

  const payload = createApplyPayload(plan, ".incoming-test");
  assert.ok(
    payload.length < 16 * 1024,
    `the apply payload grew to ${payload.length} bytes; artifact bytes are leaking into it`,
  );
  assert.doesNotMatch(payload, /AAAAAAAAAA/u);
  // The manifest digest travels; the manifest's artifact bytes do not.
  assert.ok(payload.includes(plan.manifestSha256));

  const peak = process.memoryUsage().heapUsed;
  await shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true });
  assert.ok(
    process.memoryUsage().heapUsed - peak < serverBytes,
    "shipping retained something the size of an artifact in the heap",
  );
  assert.equal(
    sha256(await readFile(join(served, "releases", local.tail.releaseId, "server.apk"))),
    local.current.manifest.artifacts.find((artifact) => artifact.role === "server").sha256,
  );
});

test("the production rsync options repair every possible retained target shape", async (t) => {
  const version = spawnSync("rsync", ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, `rsync 3.x is a shipping prerequisite: ${version.stderr}`);
  assert.match(version.stdout, /^rsync\s+version 3\./u);

  const root = await workspace(t);
  const sourcePath = join(root, "source.apk");
  const source = Buffer.allocUnsafe(2 * 1024 * 1024);
  for (let index = 0; index < source.length; index += 1) {
    source[index] = (index * 131 + Math.floor(index / 251)) & 0xff;
  }
  await writeFile(sourcePath, source, { mode: 0o600 });

  const correctShort = Buffer.from(source.subarray(0, source.length / 3));
  const corruptShort = Buffer.from(correctShort);
  corruptShort[Math.floor(corruptShort.length / 2)] ^= 0xff;
  const sameSizeCorrupt = Buffer.from(source);
  sameSizeCorrupt[Math.floor(sameSizeCorrupt.length / 2)] ^= 0xff;
  const longer = Buffer.concat([source, Buffer.alloc(256 * 1024, 0x5a)]);
  const cases = new Map([
    ["correct-short", correctShort],
    ["corrupt-short", corruptShort],
    ["same-size-corrupt", sameSizeCorrupt],
    ["longer", longer],
  ]);

  for (const [name, initial] of cases) {
    const target = join(root, `${name}.apk`);
    await writeFile(target, initial, { mode: 0o600 });
    const repaired = spawnSync("rsync", [...RSYNC_UPLOAD_OPTIONS, "--", sourcePath, target], {
      encoding: "utf8",
    });
    assert.equal(repaired.status, 0, `${name}: ${repaired.stderr}`);
    const actual = await readFile(target);
    assert.equal(actual.length, source.length, `${name} retained the wrong length`);
    assert.equal(sha256(actual), sha256(source), `${name} retained the wrong bytes`);
    assert.equal((await lstat(target)).mode & 0o777, 0o600);
  }
});

test("the production rsync launcher anchors ciphertext before protected claim publication", async (t) => {
  const root = await workspace(t);
  const served = await remoteStore(root);
  const sshExecutable = await localSshExecutable(root);
  const transport = createSshTransport({ remote: "localtest", sshExecutable });
  const releasesRoot = join(served, "releases");
  const incoming = ".incoming-fd-launcher";
  const filename = "manifest.json";
  const source = join(root, "launcher-source.json");
  const bytes = Buffer.from(`${"fd-bound-rsync\n".repeat(8192)}`);
  await writeFile(source, bytes, { mode: 0o600 });
  const staged = await transport.makeIncomingDirectory({
    releasesRoot,
    name: incoming,
    authority: await emptyStoreAuthority(served),
    filenames: [filename],
  });
  const directory = staged.path;

  await transport.upload({
    source,
    destination: join(directory, filename),
    releasesRoot,
    incoming,
    filename,
    size: bytes.length,
    sha256: sha256(bytes),
    authority: staged.authority,
    label: "fd-bound launcher upload",
  });

  assert.deepEqual(await readFile(join(directory, filename)), bytes);
  assert.equal((await lstat(join(directory, filename))).mode & 0o777, 0o600);
});

test("real local SSH completes the protected claim and framed apply protocols", async (t) => {
  const root = await workspace(t);
  const localRoot = join(root, "local-real-ssh-framed");
  const served = await remoteStore(root, "served-real-ssh-framed");
  const published = await publishLocally(root, {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
    releaseRoot: localRoot,
  });
  const transport = createSshTransport({
    remote: "localtest",
    sshExecutable: await localSshExecutable(root),
  });
  const result = await shipPinRelease({
    releaseRoot: localRoot,
    remoteRoot: served,
    transport,
    confirm: true,
  });
  assert.equal(result.applied, true);
  assert.equal(result.releaseId, published.releaseId);
  assert.equal(
    JSON.parse(await readFile(join(served, "current.json"), "utf8")).releaseId,
    published.releaseId,
  );
});

test("fd-bound rsync cannot be redirected by root, releases, or incoming swaps after open", async (t) => {
  const root = await workspace(t);
  const sshExecutable = await localSshExecutable(root);
  const source = join(root, "swap-source.apk");
  const bytes = Buffer.from("anchored-rsync-byte-stream\n".repeat(4096));
  await writeFile(source, bytes, { mode: 0o600 });

  for (const target of ["root", "releases", "incoming"]) {
    await t.test(target, async () => {
      const served = await remoteStore(root, `served-launcher-swap-${target}`);
      const releasesRoot = join(served, "releases");
      const incomingName = `.incoming-launcher-swap-${target}`;
      const filename = "server.apk";
      const outside = join(root, `outside-launcher-swap-${target}`);
      const sentinel = join(outside, "DO-NOT-TOUCH");
      await mkdir(outside, { mode: 0o700 });
      await writeFile(sentinel, `sentinel-${target}\n`, { mode: 0o600 });

      let mutablePath;
      let heldPath;
      let anchoredDirectory;
      if (target === "root") {
        mutablePath = served;
        heldPath = `${served}.held`;
        anchoredDirectory = join(heldPath, "releases", incomingName);
      } else if (target === "releases") {
        mutablePath = releasesRoot;
        heldPath = join(served, "releases.held");
        anchoredDirectory = join(heldPath, incomingName);
      } else {
        mutablePath = join(releasesRoot, incomingName);
        heldPath = join(releasesRoot, `${incomingName}.held`);
        anchoredDirectory = heldPath;
      }

      const boundary = "    os.fchdir(incoming)\n";
      const launcher = replaceRsyncLauncherOnce(
        REMOTE_RSYNC_LAUNCHER_SOURCE,
        boundary,
        [
          `    os.rename(${JSON.stringify(mutablePath)}, ${JSON.stringify(heldPath)})`,
          `    os.symlink(${JSON.stringify(outside)}, ${JSON.stringify(mutablePath)})`,
          boundary.trimEnd(),
          "",
        ].join("\n"),
        `${target} post-open swap`,
      );
      const transport = createSshTransport({
        remote: "localtest",
        sshExecutable,
        rsyncLauncherSource: launcher,
      });
      const staged = await transport.makeIncomingDirectory({
        releasesRoot,
        name: incomingName,
        authority: await emptyStoreAuthority(served),
        filenames: [filename],
      });
      const directory = staged.path;

      await assert.rejects(
        () => transport.upload({
          source,
          destination: join(directory, filename),
          releasesRoot,
          incoming: incomingName,
          filename,
          size: bytes.length,
          sha256: sha256(bytes),
          authority: staged.authority,
          label: `${target} post-open swap upload`,
        }),
        (error) =>
          error instanceof PinReleaseShipError &&
          error.code === "remote-failed" &&
          /failed after 3 resumable rsync attempts/u.test(error.message),
      );

      const sealedName = `.sealed-${sha256(filename).slice(0, 16)}.resume`;
      const anchoredCiphertext = await readFile(join(anchoredDirectory, sealedName));
      assert.notDeepEqual(anchoredCiphertext, bytes);
      assert.equal(anchoredCiphertext.includes(bytes.subarray(0, 256)), false);
      assert.equal(await readFile(sentinel, "utf8"), `sentinel-${target}\n`);
      assert.deepEqual(await readdir(outside), ["DO-NOT-TOUCH"]);
    });
  }
});

test("SSH plaintext stays unnamed after open and across every decrypt write", async (t) => {
  const root = await workspace(t);
  const served = await remoteStore(root, "served-hardlink-swap");
  const releasesRoot = join(served, "releases");
  const incoming = ".incoming-hardlink-swap";
  const filename = "server.apk";
  const source = join(root, "hardlink-source.apk");
  const sourceBytes = Buffer.from("safe-rsync-result\n".repeat(4096));
  const outside = join(root, "outside-hardlink-swap");
  const sentinel = join(outside, "DO-NOT-TOUCH");
  const exported = join(outside, "EXPORTED-PLAINTEXT");
  const barrier = join(root, "hardlink-swap-barrier");
  const largeSourceBytes = Buffer.concat([sourceBytes, Buffer.alloc(3 * 1024 * 1024, 0x5a)]);
  await writeFile(source, largeSourceBytes, { mode: 0o600 });
  await mkdir(outside, { mode: 0o700 });
  await writeFile(sentinel, "sentinel-hardlink\n", { mode: 0o640 });

  const procAttackCode = [
    "import errno, os, sys",
    'path = f"/proc/{sys.argv[1]}/fd/{sys.argv[2]}"',
    "denied = (errno.EACCES, errno.EPERM, errno.ENOENT)",
    "try:",
    "    opened = os.open(path, os.O_RDONLY)",
    "except OSError as error:",
    "    if error.errno not in denied: raise",
    "else:",
    "    os.close(opened)",
    "    raise SystemExit(20)",
    "try:",
    "    os.link(path, sys.argv[3], follow_symlinks=True)",
    "except OSError as error:",
    "    if error.errno not in denied: raise",
    "else:",
    "    raise SystemExit(21)",
  ].join("\n");
  const importBoundary = "import base64, ctypes, hashlib, hmac, json, os, re, stat, sys\n";
  let stagingScript = replaceRsyncLauncherOnce(
    REMOTE_STAGING_SCRIPT,
    importBoundary,
    [
      importBoundary.trimEnd(),
      "import subprocess",
      `_test_proc_attack_code = ${JSON.stringify(procAttackCode)}`,
      "def _test_attack_proc_fd(descriptor, label):",
      "    require_nondumpable()",
      '    _test_metadata = open("/proc/self/cmdline", "rb").read() + repr(dict(os.environ)).encode("utf-8")',
      "    if resume_key.hex().encode(\"ascii\") in _test_metadata:",
      '        raise RuntimeError("resume key escaped into SSH claim process metadata")',
      "    result = subprocess.run(",
      `        ["python3", "-c", _test_proc_attack_code, str(os.getpid()), str(descriptor), ${JSON.stringify(exported)}],`,
      "        check=False, capture_output=True, text=True,",
      "    )",
      "    if result.returncode != 0:",
      '        raise RuntimeError("external proc-fd attack unexpectedly succeeded: " + result.stdout + result.stderr)',
      `    with open(${JSON.stringify(barrier)}, "ab", buffering=0) as _test_barrier:`,
      '        _test_barrier.write((label + "\\n").encode("ascii"))',
      "",
    ].join("\n"),
    "SSH external proc-fd attacker",
  );
  const openBoundary = '            work = os.open(".", work_flags, 0o600, dir_fd=incoming)\n';
  stagingScript = replaceRsyncLauncherOnce(
    stagingScript,
    openBoundary,
    [
      openBoundary.trimEnd(),
      "            if os.fstat(work).st_nlink != 0:",
      '                refuse("test observed a named plaintext work inode")',
      '            _test_attack_proc_fd(work, "open")',
      "",
    ].join("\n"),
    "post-open unnamed target",
  );
  const writeBoundary = "                        written += count\n";
  stagingScript = replaceRsyncLauncherOnce(
    stagingScript,
    writeBoundary,
    [
      writeBoundary.trimEnd(),
      "                        if os.fstat(work).st_nlink != 0:",
      '                            refuse("test observed a linked plaintext inode during write")',
      '                        _test_attack_proc_fd(work, "write")',
      "",
    ].join("\n"),
    "decrypt-write unnamed target",
  );
  const sshExecutable = await localSshExecutable(root);
  const transport = createSshTransport({
    remote: "localtest",
    sshExecutable,
    stagingScript,
  });
  const staged = await transport.makeIncomingDirectory({
    releasesRoot,
    name: incoming,
    authority: await emptyStoreAuthority(served),
    filenames: [filename],
  });
  const directory = staged.path;

  await transport.upload({
    source,
    destination: join(directory, filename),
    releasesRoot,
    incoming,
    filename,
    size: largeSourceBytes.length,
    sha256: sha256(largeSourceBytes),
    authority: staged.authority,
    label: "post-open hardlink upload",
  });

  assert.deepEqual(await readFile(join(directory, filename)), largeSourceBytes);
  assert.equal(await readFile(sentinel, "utf8"), "sentinel-hardlink\n");
  await assert.rejects(() => lstat(exported), (error) => error?.code === "ENOENT");
  const boundaries = (await readFile(barrier, "utf8")).trim().split("\n");
  assert.equal(boundaries[0], "open");
  assert.ok(boundaries.filter((entry) => entry === "write").length >= 4);
  const sentinelInfo = await lstat(sentinel);
  assert.equal(sentinelInfo.mode & 0o777, 0o640);
  assert.equal(sentinelInfo.nlink, 1);
});

test("an SSH retry hardlink can export only authenticated ciphertext, never plaintext", async (t) => {
  const root = await workspace(t);
  const served = await remoteStore(root, "served-ssh-ciphertext-export");
  const releasesRoot = join(served, "releases");
  const incoming = ".incoming-ssh-ciphertext-export";
  const filename = "server.apk";
  const source = join(root, "ssh-ciphertext-source.apk");
  const bytes = Buffer.allocUnsafe(2 * 1024 * 1024 + 137);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 193 + 17) & 0xff;
  const outside = join(root, "outside-ssh-ciphertext-export");
  const sentinel = join(outside, "DO-NOT-TOUCH");
  const exported = join(outside, "EXPORTED-RSYNC-INODE");
  await writeFile(source, bytes, { mode: 0o600 });
  await mkdir(outside, { mode: 0o700 });
  await writeFile(sentinel, "ciphertext-sentinel\n", { mode: 0o640 });

  const boundary = "    sealed = linked_info(incoming, sealed_name)\n";
  const launcher = replaceRsyncLauncherOnce(
    REMOTE_RSYNC_LAUNCHER_SOURCE,
    boundary,
    [
      `    os.link(sealed_name, ${JSON.stringify(exported)}, src_dir_fd=incoming, follow_symlinks=False)`,
      boundary.trimEnd(),
      "",
    ].join("\n"),
    "ciphertext hardlink export",
  );
  const sshExecutable = await localSshExecutable(root);
  const transport = createSshTransport({
    remote: "localtest",
    sshExecutable,
    rsyncLauncherSource: launcher,
  });
  const staged = await transport.makeIncomingDirectory({
    releasesRoot,
    name: incoming,
    authority: await emptyStoreAuthority(served),
    filenames: [filename],
  });
  await assert.rejects(
    () => transport.upload({
      source,
      destination: join(staged.path, filename),
      releasesRoot,
      incoming,
      filename,
      size: bytes.length,
      sha256: sha256(bytes),
      authority: staged.authority,
      label: "ciphertext hardlink export",
    }),
    (error) =>
      error instanceof PinReleaseShipError &&
      error.code === "remote-failed" &&
      /failed after 3 resumable rsync attempts/u.test(error.message),
  );

  await assert.rejects(() => lstat(join(staged.path, filename)), (error) => error?.code === "ENOENT");
  const exportedBytes = await readFile(exported);
  assert.notDeepEqual(exportedBytes, bytes);
  assert.equal(exportedBytes.includes(bytes.subarray(0, 256)), false);
  assert.equal(await readFile(sentinel, "utf8"), "ciphertext-sentinel\n");
  const sentinelInfo = await lstat(sentinel);
  assert.equal(sentinelInfo.mode & 0o777, 0o640);
  assert.equal(sentinelInfo.nlink, 1);
});

test("every rsync retry reopens no-follow authority before touching its retained partial", async (t) => {
  const root = await workspace(t);
  const served = await remoteStore(root, "served-retry-authority");
  const releasesRoot = join(served, "releases");
  const incoming = ".incoming-retry-authority";
  const filename = "server.apk";
  const source = join(root, "retry-source.apk");
  const outside = join(root, "outside-retry-authority");
  const sentinel = join(outside, "DO-NOT-TOUCH");
  const heldRoot = `${served}.held`;
  const attempts = join(root, "retry-authority-attempts");
  const sourceBytes = Buffer.alloc(1024 * 1024, 0x51);
  await writeFile(source, sourceBytes, { mode: 0o600 });
  await mkdir(outside, { mode: 0o700 });
  await writeFile(sentinel, "sentinel-retry\n", { mode: 0o600 });

  const countBoundary = "parent_path, releases_name = os.path.split(releases_path)\n";
  let launcher = replaceRsyncLauncherOnce(
    REMOTE_RSYNC_LAUNCHER_SOURCE,
    countBoundary,
    [
      `with open(${JSON.stringify(attempts)}, "ab", buffering=0) as _test_attempts:`,
      '    _test_attempts.write(b"attempt\\n")',
      `_test_attempt = sum(1 for _line in open(${JSON.stringify(attempts)}, "rb"))`,
      countBoundary.trimEnd(),
      "",
    ].join("\n"),
    "retry attempt counter",
  );
  const execBoundary = "    os.fchdir(incoming)\n";
  launcher = replaceRsyncLauncherOnce(
    launcher,
    execBoundary,
    [
      "    if _test_attempt == 1:",
      "        _test_partial = os.open(sealed_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=incoming)",
      "        try:",
      '            os.write(_test_partial, b"ciphertext-only-partial")',
      "            os.fsync(_test_partial)",
      "        finally:",
      "            os.close(_test_partial)",
      `        os.rename(${JSON.stringify(served)}, ${JSON.stringify(heldRoot)})`,
      `        os.symlink(${JSON.stringify(outside)}, ${JSON.stringify(served)})`,
      "        raise SystemExit(12)",
      execBoundary.trimEnd(),
      "",
    ].join("\n"),
    "retry-boundary root swap",
  );

  const sshExecutable = await localSshExecutable(root);
  const transport = createSshTransport({
    remote: "localtest",
    sshExecutable,
    rsyncLauncherSource: launcher,
  });
  const staged = await transport.makeIncomingDirectory({
    releasesRoot,
    name: incoming,
    authority: await emptyStoreAuthority(served),
    filenames: [filename],
  });
  const directory = staged.path;
  await assert.rejects(
    () => transport.upload({
      source,
      destination: join(directory, filename),
      releasesRoot,
      incoming,
      filename,
      size: sourceBytes.length,
      sha256: sha256(sourceBytes),
      authority: staged.authority,
      label: "retry authority upload",
    }),
    (error) =>
      error instanceof PinReleaseShipError &&
      error.code === "remote-failed" &&
      /failed after 3 resumable rsync attempts/u.test(error.message),
  );

  assert.equal((await readFile(attempts, "utf8")).trim().split("\n").length, RSYNC_UPLOAD_ATTEMPTS);
  const retainedEntries = await readdir(join(heldRoot, "releases", incoming));
  assert.equal(retainedEntries.includes(filename), false);
  assert.equal(retainedEntries.length, 1);
  assert.match(retainedEntries[0], /^\.sealed-[0-9a-f]{16}\.resume$/u);
  assert.equal(
    await readFile(join(heldRoot, "releases", incoming, retainedEntries[0]), "utf8"),
    "ciphertext-only-partial",
  );
  assert.equal(await readFile(sentinel, "utf8"), "sentinel-retry\n");
  assert.deepEqual(await readdir(outside), ["DO-NOT-TOUCH"]);
});

test("real-directory replacements after validation cannot redirect local or ssh uploads", async (t) => {
  const root = await workspace(t);
  const sshExecutable = await localSshExecutable(root);

  for (const transportKind of ["local", "ssh"]) {
    for (const target of ["root", "releases", "incoming"]) {
      await t.test(`${transportKind}-${target}`, async () => {
        const suffix = `${transportKind}-${target}`;
        const localRoot = join(root, `local-store-real-replacement-${suffix}`);
        const stagingRoot = join(root, `staging-real-replacement-${suffix}`);
        const served = await remoteStore(root, `served-real-replacement-${suffix}`);
        const replacement = join(root, `prepared-real-replacement-${suffix}`);
        const sentinel = join(replacement, "DO-NOT-TOUCH");
        await mkdir(replacement, { mode: 0o700 });
        await writeFile(sentinel, `sentinel-${suffix}\n`, { mode: 0o640 });
        await publishLocally(root, {
          version: "2026-08-09.1",
          versionCode: 202_608_091,
          marker: suffix,
          releaseRoot: localRoot,
          stagingRoot,
        });

        const base = transportKind === "local"
          ? createLocalTransport()
          : createSshTransport({ remote: "localtest", sshExecutable });
        let swapped = false;
        let anchoredIncoming;
        let replacementDestination;
        const transport = Object.freeze({
          ...base,
          async run(request) {
            const stdout = await base.run(request);
            if (!swapped && request.label === "validate upload manifest.json") {
              swapped = true;
              const incomingName = request.args[2];
              const releasesRoot = join(served, "releases");
              if (target === "root") {
                const held = `${served}.held`;
                await rename(served, held);
                await rename(replacement, served);
                anchoredIncoming = join(held, "releases", incomingName);
                replacementDestination = served;
              } else if (target === "releases") {
                const held = join(served, "releases.held");
                await rename(releasesRoot, held);
                await rename(replacement, releasesRoot);
                anchoredIncoming = join(held, incomingName);
                replacementDestination = releasesRoot;
              } else {
                const mutable = join(releasesRoot, incomingName);
                const held = `${mutable}.held`;
                await rename(mutable, held);
                await rename(replacement, mutable);
                anchoredIncoming = held;
                replacementDestination = mutable;
              }
            }
            return stdout;
          },
        });

        await assert.rejects(
          () => shipPinRelease({
            releaseRoot: localRoot,
            remoteRoot: served,
            transport,
            confirm: true,
          }),
          (error) =>
            error instanceof PinReleaseShipError &&
            error.code === "remote-failed" &&
            /failed after 3 resumable (?:local|rsync) attempts/u.test(error.message),
        );
        assert.equal(swapped, true, "the replacement barrier must run after validation");
        const movedSentinel = join(replacementDestination, "DO-NOT-TOUCH");
        assert.equal(await readFile(movedSentinel, "utf8"), `sentinel-${suffix}\n`);
        assert.equal((await lstat(movedSentinel)).mode & 0o777, 0o640);
        assert.deepEqual(await readdir(replacementDestination), ["DO-NOT-TOUCH"]);
        assert.deepEqual(await readdir(anchoredIncoming), []);
      });
    }
  }
});

test("apply rejects real root, releases, and incoming replacements after complete uploads", async (t) => {
  const root = await workspace(t);

  for (const target of ["root", "releases", "incoming"]) {
    await t.test(target, async () => {
      const localRoot = join(root, `local-store-apply-real-replacement-${target}`);
      const served = await remoteStore(root, `served-apply-real-replacement-${target}`);
      const replacement = join(root, `prepared-apply-real-replacement-${target}`);
      await mkdir(replacement, { mode: 0o700 });
      await writeFile(join(replacement, "DO-NOT-TOUCH"), `apply-sentinel-${target}\n`, { mode: 0o640 });
      await publishLocally(root, {
        version: "2026-08-09.1",
        versionCode: 202_608_091,
        marker: `apply-real-replacement-${target}`,
        releaseRoot: localRoot,
        stagingRoot: join(root, `staging-apply-real-replacement-${target}`),
      });

      const base = createLocalTransport();
      let incomingName;
      let anchoredIncoming;
      let replacementDestination;
      const transport = Object.freeze({
        ...base,
        async makeIncomingDirectory(request) {
          incomingName = request.name;
          return await base.makeIncomingDirectory(request);
        },
        async run(request) {
          if (request.label === "remote release publication") {
            const releasesRoot = join(served, "releases");
            if (target === "root") {
              const held = `${served}.held`;
              await rename(served, held);
              await rename(replacement, served);
              anchoredIncoming = join(held, "releases", incomingName);
              replacementDestination = served;
            } else if (target === "releases") {
              const held = join(served, "releases.held");
              await rename(releasesRoot, held);
              await rename(replacement, releasesRoot);
              anchoredIncoming = join(held, incomingName);
              replacementDestination = releasesRoot;
            } else {
              const mutable = join(releasesRoot, incomingName);
              const held = `${mutable}.held`;
              await rename(mutable, held);
              await rename(replacement, mutable);
              anchoredIncoming = held;
              replacementDestination = mutable;
            }
          }
          return await base.run(request);
        },
      });

      await assert.rejects(
        () => shipPinRelease({
          releaseRoot: localRoot,
          remoteRoot: served,
          transport,
          confirm: true,
        }),
        (error) =>
          error instanceof PinReleaseShipError &&
          error.code === "remote-failed" &&
          /differs from the publication filesystem authority/u.test(error.message),
      );
      assert.ok((await lstat(join(anchoredIncoming, "manifest.json"))).size > 0);
      const movedSentinel = join(replacementDestination, "DO-NOT-TOUCH");
      assert.equal(await readFile(movedSentinel, "utf8"), `apply-sentinel-${target}\n`);
      assert.equal((await lstat(movedSentinel)).mode & 0o777, 0o640);
      assert.deepEqual(await readdir(replacementDestination), ["DO-NOT-TOUCH"]);
    });
  }
});

test("the local uploader stays on held descriptors after root, releases, or incoming is replaced", async (t) => {
  const root = await workspace(t);
  const source = join(root, "local-held-source.apk");
  const bytes = Buffer.from("held-local-upload\n".repeat(8192));
  await writeFile(source, bytes, { mode: 0o600 });

  for (const target of ["root", "releases", "incoming"]) {
    await t.test(target, async () => {
      const served = await remoteStore(root, `served-local-held-${target}`);
      const releasesRoot = join(served, "releases");
      const incoming = `.incoming-local-held-${target}`;
      const filename = "server.apk";
      const replacement = join(root, `prepared-local-held-${target}`);
      const sentinel = join(replacement, "DO-NOT-TOUCH");
      await mkdir(replacement, { mode: 0o700 });
      await writeFile(sentinel, `sentinel-local-held-${target}\n`, { mode: 0o640 });

      let mutable;
      let held;
      let anchoredFile;
      if (target === "root") {
        mutable = served;
        held = `${served}.held`;
        anchoredFile = join(held, "releases", incoming, filename);
      } else if (target === "releases") {
        mutable = releasesRoot;
        held = join(served, "releases.held");
        anchoredFile = join(held, incoming, filename);
      } else {
        mutable = join(releasesRoot, incoming);
        held = `${mutable}.held`;
        anchoredFile = join(held, filename);
      }

      const boundary = '            work = open_tmpfile(incoming, "local upload")\n';
      const localUploadScript = replaceLocalUploadOnce(
        LOCAL_UPLOAD_SCRIPT,
        boundary,
        [
          boundary.trimEnd(),
          `            os.rename(${JSON.stringify(mutable)}, ${JSON.stringify(held)})`,
          `            os.rename(${JSON.stringify(replacement)}, ${JSON.stringify(mutable)})`,
          "",
        ].join("\n"),
        `${target} held-descriptor replacement`,
      );
      const transport = createLocalTransport({ localUploadScript });
      const staged = await transport.makeIncomingDirectory({
        releasesRoot,
        name: incoming,
        authority: await emptyStoreAuthority(served),
        filenames: [filename],
      });
      await transport.upload({
        source,
        destination: join(staged.path, filename),
        releasesRoot,
        incoming,
        filename,
        size: bytes.length,
        sha256: sha256(bytes),
        authority: staged.authority,
        label: `${target} held local upload`,
      });

      assert.deepEqual(await readFile(anchoredFile), bytes);
      assert.equal((await lstat(anchoredFile)).mode & 0o777, 0o600);
      const movedSentinel = join(mutable, "DO-NOT-TOUCH");
      assert.equal(await readFile(movedSentinel, "utf8"), `sentinel-local-held-${target}\n`);
      assert.equal((await lstat(movedSentinel)).mode & 0o777, 0o640);
      assert.deepEqual(await readdir(mutable), ["DO-NOT-TOUCH"]);
    });
  }
});

test("local plaintext stays unnamed after open and across every copy write", async (t) => {
  const root = await workspace(t);
  const served = await remoteStore(root, "served-local-unnamed");
  const releasesRoot = join(served, "releases");
  const incoming = ".incoming-local-unnamed";
  const filename = "server.apk";
  const source = join(root, "local-unnamed-source.apk");
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 71, 0x6d);
  const outside = join(root, "outside-local-unnamed");
  const sentinel = join(outside, "DO-NOT-TOUCH");
  const exported = join(outside, "EXPORTED-PLAINTEXT");
  const barrier = join(root, "local-unnamed-barriers");
  await writeFile(source, bytes, { mode: 0o600 });
  await mkdir(outside, { mode: 0o700 });
  await writeFile(sentinel, "local-sentinel\n", { mode: 0o640 });

  const procAttackCode = [
    "import errno, os, sys",
    'path = f"/proc/{sys.argv[1]}/fd/{sys.argv[2]}"',
    "denied = (errno.EACCES, errno.EPERM, errno.ENOENT)",
    "try:",
    "    opened = os.open(path, os.O_RDONLY)",
    "except OSError as error:",
    "    if error.errno not in denied: raise",
    "else:",
    "    os.close(opened)",
    "    raise SystemExit(20)",
    "try:",
    "    os.link(path, sys.argv[3], follow_symlinks=True)",
    "except OSError as error:",
    "    if error.errno not in denied: raise",
    "else:",
    "    raise SystemExit(21)",
  ].join("\n");
  const importBoundary = "import base64, ctypes, hashlib, hmac, json, os, re, secrets, stat, sys\n";
  let script = replaceLocalUploadOnce(
    LOCAL_UPLOAD_SCRIPT,
    importBoundary,
    [
      importBoundary.trimEnd(),
      "import subprocess",
      `_test_proc_attack_code = ${JSON.stringify(procAttackCode)}`,
      "def _test_attack_proc_fd(descriptor, label):",
      "    require_nondumpable()",
      '    _test_metadata = open("/proc/self/cmdline", "rb").read() + repr(dict(os.environ)).encode("utf-8")',
      "    if resume_key.hex().encode(\"ascii\") in _test_metadata:",
      '        raise RuntimeError("resume key escaped into local upload process metadata")',
      "    result = subprocess.run(",
      `        ["python3", "-c", _test_proc_attack_code, str(os.getpid()), str(descriptor), ${JSON.stringify(exported)}],`,
      "        check=False, capture_output=True, text=True,",
      "    )",
      "    if result.returncode != 0:",
      '        raise RuntimeError("external proc-fd attack unexpectedly succeeded: " + result.stdout + result.stderr)',
      `    with open(${JSON.stringify(barrier)}, "ab", buffering=0) as _test_barrier:`,
      '        _test_barrier.write((label + "\\n").encode("ascii"))',
      "",
    ].join("\n"),
    "local external proc-fd attacker",
  );
  const openBoundary = '            work = open_tmpfile(incoming, "local upload")\n';
  script = replaceLocalUploadOnce(
    script,
    openBoundary,
    [
      openBoundary.trimEnd(),
      "            if os.fstat(work).st_nlink != 0:",
      '                refuse("test observed a named local plaintext inode")',
      '            _test_attack_proc_fd(work, "open")',
      "",
    ].join("\n"),
    "local unnamed open",
  );
  const writeBoundary = "        written += count\n";
  script = replaceLocalUploadOnce(
    script,
    writeBoundary,
    [
      writeBoundary.trimEnd(),
      "        if os.fstat(descriptor).st_nlink != 0:",
      '            refuse("test observed a linked local plaintext inode during write")',
      '        _test_attack_proc_fd(descriptor, "write")',
      "",
    ].join("\n"),
    "local unnamed write",
  );
  const transport = createLocalTransport({ localUploadScript: script });
  const staged = await transport.makeIncomingDirectory({
    releasesRoot,
    name: incoming,
    authority: await emptyStoreAuthority(served),
    filenames: [filename],
  });
  await transport.upload({
    source,
    destination: join(staged.path, filename),
    releasesRoot,
    incoming,
    filename,
    size: bytes.length,
    sha256: sha256(bytes),
    authority: staged.authority,
    label: "local unnamed upload",
  });

  assert.deepEqual(await readFile(join(staged.path, filename)), bytes);
  assert.equal(await readFile(sentinel, "utf8"), "local-sentinel\n");
  await assert.rejects(() => lstat(exported), (error) => error?.code === "ENOENT");
  const boundaries = (await readFile(barrier, "utf8")).trim().split("\n");
  assert.equal(boundaries[0], "open");
  assert.ok(boundaries.filter((entry) => entry === "write").length >= 5);
  const sentinelInfo = await lstat(sentinel);
  assert.equal(sentinelInfo.mode & 0o777, 0o640);
  assert.equal(sentinelInfo.nlink, 1);
});

test("every local retry copies plaintext only through a fresh unnamed inode", async (t) => {
  const root = await workspace(t);
  const served = await remoteStore(root, "served-local-unnamed-retry");
  const releasesRoot = join(served, "releases");
  const incoming = ".incoming-local-unnamed-retry";
  const filename = "server.apk";
  const source = join(root, "local-unnamed-retry-source.apk");
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 91, 0x72);
  const outside = join(root, "outside-local-unnamed-retry");
  const sentinel = join(outside, "DO-NOT-TOUCH");
  const exported = join(outside, "EXPORTED-PLAINTEXT");
  const attempts = join(root, "local-unnamed-retry-attempts");
  const boundaries = join(root, "local-unnamed-retry-boundaries");
  await writeFile(source, bytes, { mode: 0o600 });
  await mkdir(outside, { mode: 0o700 });
  await writeFile(sentinel, "local-retry-sentinel\n", { mode: 0o640 });

  const argsBoundary = "source_path, releases_path = sys.argv[1:3]\n";
  let script = replaceLocalUploadOnce(
    LOCAL_UPLOAD_SCRIPT,
    argsBoundary,
    [
      `with open(${JSON.stringify(attempts)}, "ab", buffering=0) as _test_attempts:`,
      '    _test_attempts.write(b"attempt\\n")',
      `_test_attempt = sum(1 for _line in open(${JSON.stringify(attempts)}, "rb"))`,
      argsBoundary.trimEnd(),
      "",
    ].join("\n"),
    "unnamed retry counter",
  );
  const openBoundary = '            work = open_tmpfile(incoming, "local upload")\n';
  script = replaceLocalUploadOnce(
    script,
    openBoundary,
    [
      openBoundary.trimEnd(),
      "            if os.fstat(work).st_nlink != 0:",
      '                refuse("test observed a named retry work inode")',
      "            try:",
      `                os.link(filename, ${JSON.stringify(exported)}, src_dir_fd=incoming, follow_symlinks=False)`,
      "            except FileNotFoundError:",
      "                pass",
      "            else:",
      '                refuse("test exported retry plaintext after open")',
      `            with open(${JSON.stringify(boundaries)}, "ab", buffering=0) as _test_barrier:`,
      '                _test_barrier.write(("open-%d\\n" % _test_attempt).encode("ascii"))',
      "",
    ].join("\n"),
    "unnamed retry open",
  );
  const copyBoundary = "                        write_at(work, chunk, position)\n";
  script = replaceLocalUploadOnce(
    script,
    copyBoundary,
    [
      copyBoundary.trimEnd(),
      "                        if os.fstat(work).st_nlink != 0:",
      '                            refuse("test observed a linked retry inode during copy")',
      "                        try:",
      `                            os.link(filename, ${JSON.stringify(exported)}, src_dir_fd=incoming, follow_symlinks=False)`,
      "                        except FileNotFoundError:",
      "                            pass",
      "                        else:",
      '                            refuse("test exported retry plaintext during copy")',
      `                        with open(${JSON.stringify(boundaries)}, "ab", buffering=0) as _test_barrier:`,
      '                            _test_barrier.write(("copy-%d\\n" % _test_attempt).encode("ascii"))',
      "                        if _test_attempt < 3:",
      "                            raise SystemExit(12)",
      "",
    ].join("\n"),
    "unnamed retry copy",
  );
  const transport = createLocalTransport({ localUploadScript: script });
  const staged = await transport.makeIncomingDirectory({
    releasesRoot,
    name: incoming,
    authority: await emptyStoreAuthority(served),
    filenames: [filename],
  });
  await transport.upload({
    source,
    destination: join(staged.path, filename),
    releasesRoot,
    incoming,
    filename,
    size: bytes.length,
    sha256: sha256(bytes),
    authority: staged.authority,
    label: "local unnamed retry upload",
  });

  assert.deepEqual(await readFile(join(staged.path, filename)), bytes);
  assert.equal((await readFile(attempts, "utf8")).trim().split("\n").length, 3);
  const events = (await readFile(boundaries, "utf8")).trim().split("\n");
  assert.deepEqual(events.filter((entry) => entry.startsWith("open-")), ["open-1", "open-2", "open-3"]);
  assert.ok(events.filter((entry) => entry.startsWith("copy-")).length >= 4);
  await assert.rejects(() => lstat(exported), (error) => error?.code === "ENOENT");
  assert.equal(await readFile(sentinel, "utf8"), "local-retry-sentinel\n");
  const sentinelInfo = await lstat(sentinel);
  assert.equal(sentinelInfo.mode & 0o777, 0o640);
  assert.equal(sentinelInfo.nlink, 1);
});

test("each local retry reopens authority before touching its retained partial", async (t) => {
  const root = await workspace(t);
  const served = await remoteStore(root, "served-local-retry-authority");
  const heldRoot = `${served}.held`;
  const replacement = join(root, "prepared-local-retry-authority");
  const sentinel = join(replacement, "DO-NOT-TOUCH");
  const attempts = join(root, "local-retry-authority-attempts");
  const releasesRoot = join(served, "releases");
  const incoming = ".incoming-local-retry-authority";
  const filename = "server.apk";
  const source = join(root, "local-retry-source.apk");
  const sourceBytes = Buffer.alloc(1024 * 1024, 0x4c);
  await mkdir(replacement, { mode: 0o700 });
  await writeFile(sentinel, "sentinel-local-retry\n", { mode: 0o640 });
  await writeFile(source, sourceBytes, { mode: 0o600 });

  const countBoundary = "source_path, releases_path = sys.argv[1:3]\n";
  let localUploadScript = replaceLocalUploadOnce(
    LOCAL_UPLOAD_SCRIPT,
    countBoundary,
    [
      `with open(${JSON.stringify(attempts)}, "ab", buffering=0) as _test_attempts:`,
      '    _test_attempts.write(b"attempt\\n")',
      `_test_attempt = sum(1 for _line in open(${JSON.stringify(attempts)}, "rb"))`,
      countBoundary.trimEnd(),
      "",
    ].join("\n"),
    "local retry counter",
  );
  const copyBoundary = "                    position = offset\n                    while position < expected_size:\n";
  localUploadScript = replaceLocalUploadOnce(
    localUploadScript,
    copyBoundary,
    [
      "                    if _test_attempt == 1:",
      '                        _test_partial = b"retained-local-partial"',
      "                        write_at(work, _test_partial, 0)",
      "                        os.ftruncate(work, len(_test_partial))",
      "                        os.fsync(work)",
      `                        os.rename(${JSON.stringify(served)}, ${JSON.stringify(heldRoot)})`,
      `                        os.rename(${JSON.stringify(replacement)}, ${JSON.stringify(served)})`,
      "                        raise SystemExit(12)",
      copyBoundary.trimEnd(),
      "",
    ].join("\n"),
    "local retry partial replacement",
  );
  const transport = createLocalTransport({ localUploadScript });
  const staged = await transport.makeIncomingDirectory({
    releasesRoot,
    name: incoming,
    authority: await emptyStoreAuthority(served),
    filenames: [filename],
  });
  await assert.rejects(
    () => transport.upload({
      source,
      destination: join(staged.path, filename),
      releasesRoot,
      incoming,
      filename,
      size: sourceBytes.length,
      sha256: sha256(sourceBytes),
      authority: staged.authority,
      label: "local retry authority upload",
    }),
    (error) =>
      error instanceof PinReleaseShipError &&
      error.code === "remote-failed" &&
      /failed after 3 resumable local attempts/u.test(error.message),
  );

  assert.equal((await readFile(attempts, "utf8")).trim().split("\n").length, RSYNC_UPLOAD_ATTEMPTS);
  const retainedEntries = await readdir(join(heldRoot, "releases", incoming));
  assert.equal(retainedEntries.includes(filename), false);
  assert.equal(retainedEntries.length, 1);
  assert.match(retainedEntries[0], /^\.sealed-[0-9a-f]{16}\.resume$/u);
  const encryptedPartial = await readFile(join(heldRoot, "releases", incoming, retainedEntries[0]));
  assert.equal(encryptedPartial.includes(Buffer.from("retained-local-partial")), false);
  const movedSentinel = join(served, "DO-NOT-TOUCH");
  assert.equal(await readFile(movedSentinel, "utf8"), "sentinel-local-retry\n");
  assert.equal((await lstat(movedSentinel)).mode & 0o777, 0o640);
  assert.deepEqual(await readdir(served), ["DO-NOT-TOUCH"]);
});

test("statx birth generation rejects an ext inode reused under a stale incoming authority", async (t) => {
  // /tmp is tmpfs on the acceptance host, so place this one fixture on the
  // workspace's real ext filesystem. It is removed even when the assertion
  // fails and never participates in a release layout.
  const root = await mkdtemp(join(ROOT, ".revival-pin-inode-reuse-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const served = await remoteStore(root, "served-inode-reuse");
  const releasesRoot = join(served, "releases");
  const incoming = ".incoming-inode-reuse";
  const filename = "server.apk";
  const source = join(root, "source.apk");
  const bytes = Buffer.from("stale-inode-authority\n".repeat(2048));
  await writeFile(source, bytes, { mode: 0o600 });
  const transport = createLocalTransport();
  const staged = await transport.makeIncomingDirectory({
    releasesRoot,
    name: incoming,
    authority: await emptyStoreAuthority(served),
    filenames: [filename],
  });
  const stale = staged.authority.incoming;
  await rm(staged.path, { recursive: true });

  let replacement = null;
  for (let attempt = 0; attempt < 4096; attempt += 1) {
    await mkdir(staged.path, { mode: 0o700 });
    replacement = await filesystemAuthority(staged.path);
    if (
      replacement.dev === stale.dev &&
      replacement.ino === stale.ino &&
      (replacement.btime !== stale.btime || replacement.mntId !== stale.mntId)
    ) break;
    await rm(staged.path, { recursive: true });
    replacement = null;
  }
  assert.notEqual(replacement, null, "ext must demonstrate actual dev+ino reuse with a new generation");
  assert.equal(replacement.dev, stale.dev);
  assert.equal(replacement.ino, stale.ino);
  assert.notEqual(replacement.btime, stale.btime);

  await assert.rejects(
    () => transport.upload({
      source,
      destination: join(staged.path, filename),
      releasesRoot,
      incoming,
      filename,
      size: bytes.length,
      sha256: sha256(bytes),
      authority: staged.authority,
      label: "stale inode generation",
    }),
    (error) =>
      error instanceof PinReleaseShipError &&
      error.code === "remote-failed" &&
      /failed after 3 resumable local attempts/u.test(error.message),
  );
  await assert.rejects(() => lstat(join(staged.path, filename)), (error) => error?.code === "ENOENT");
});

test("a dropped large rsync upload resumes the same hidden partial and still publishes every exact file", async (t) => {
  const root = await workspace(t);
  const localRoot = join(root, "local-store");
  const served = await remoteStore(root);
  const operationLog = join(root, "resume-operations.jsonl");
  await writeFile(operationLog, "", { mode: 0o600 });
  const fixture = await fakeRsync(root, "resume");
  const transport = hybridRsyncTransport({ fixture, operationLog });
  const published = await publishLocally(root, {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
    serverBytes: 8 * 1024 * 1024,
  });

  const result = await shipPinRelease({
    releaseRoot: localRoot,
    remoteRoot: served,
    transport,
    confirm: true,
  });
  assert.equal(result.applied, true);

  const serverAttempts = (await jsonLines(fixture.log)).filter((entry) => entry.name === "server.apk");
  assert.equal(serverAttempts.length, 2, "one disconnect must consume one retry, not the whole budget");
  assert.equal(serverAttempts[0].destination, serverAttempts[1].destination);
  assert.match(
    serverAttempts[0].destination,
    /\/releases\/\.incoming-[^/]+\/\.sealed-[0-9a-f]{16}\.resume$/u,
  );
  assert.equal(serverAttempts[0].before, 0);
  assert.ok(serverAttempts[0].after > 0 && serverAttempts[0].after < serverAttempts[0].sourceSize);
  assert.equal(
    serverAttempts[1].before,
    serverAttempts[0].after,
    "attempt two must see and append to attempt one's retained prefix",
  );
  assert.equal(serverAttempts[1].after, serverAttempts[1].sourceSize);
  assert.deepEqual(serverAttempts[0].args, serverAttempts[1].args, "every retry must address the same endpoint");
  for (const option of ["--quiet", "--checksum", "--partial", "--no-whole-file", "-s"]) {
    assert.ok(serverAttempts[0].args.includes(option), `resumable transfer is missing ${option}`);
  }
  assert.equal(serverAttempts[0].args.includes("--secluded-args"), false);
  assert.equal(serverAttempts[0].args.includes("--append-verify"), false);
  assert.equal(serverAttempts[0].args.includes("--inplace"), false);
  assert.ok(serverAttempts[0].args.some(
    (argument) => argument.startsWith("--rsh=") && argument.includes("-o BatchMode=yes"),
  ));

  const operations = await jsonLines(operationLog);
  assert.deepEqual(operations.map((entry) => entry.kind), ["mkdir", "apply"]);
  const releaseDirectory = join(served, "releases", published.releaseId);
  assert.deepEqual(
    (await readdir(releaseDirectory)).sort(),
    (await readdir(join(localRoot, "releases", published.releaseId))).sort(),
    "the resumed large transfer must not change manifest or small-artifact publication",
  );
  for (const name of await readdir(releaseDirectory)) {
    assert.equal(
      sha256(await readFile(join(releaseDirectory, name))),
      sha256(await readFile(join(localRoot, "releases", published.releaseId, name))),
      name,
    );
  }
});

test("rsync exhausts exactly three attempts before the transaction cleans its partial", async (t) => {
  const root = await workspace(t);
  const localRoot = join(root, "local-store");
  const served = await remoteStore(root);
  const operationLog = join(root, "failed-operations.jsonl");
  await writeFile(operationLog, "", { mode: 0o600 });
  const fixture = await fakeRsync(root, "always-fail");
  const transport = hybridRsyncTransport({ fixture, operationLog });
  await publishLocally(root, {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
    serverBytes: 8 * 1024 * 1024,
  });

  await assert.rejects(
    () => shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true }),
    (error) =>
      error instanceof PinReleaseShipError &&
      error.code === "remote-failed" &&
      /failed after 3 resumable rsync attempts/u.test(error.message),
  );

  const serverAttempts = (await jsonLines(fixture.log)).filter((entry) => entry.name === "server.apk");
  assert.equal(serverAttempts.length, RSYNC_UPLOAD_ATTEMPTS);
  assert.equal(new Set(serverAttempts.map((entry) => entry.destination)).size, 1);
  for (let index = 1; index < serverAttempts.length; index += 1) {
    assert.equal(serverAttempts[index].before, serverAttempts[index - 1].after);
    assert.ok(serverAttempts[index].after > serverAttempts[index].before);
  }
  const operations = await jsonLines(operationLog);
  assert.deepEqual(
    operations.map((entry) => entry.kind),
    ["mkdir", "remove"],
    "cleanup may run only after the retry budget is exhausted; apply must never run",
  );
  assert.deepEqual(await readdir(join(served, "releases")), []);
  assert.deepEqual(await readdir(served), ["releases"]);
});

test("a successful rsync exit cannot bypass the far-side SHA-256 gate", async (t) => {
  const root = await workspace(t);
  const localRoot = join(root, "local-store");
  const served = await remoteStore(root);
  const operationLog = join(root, "corrupt-operations.jsonl");
  await writeFile(operationLog, "", { mode: 0o600 });
  const fixture = await fakeRsync(root, "corrupt");
  const transport = hybridRsyncTransport({ fixture, operationLog });
  await publishLocally(root, {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
    serverBytes: 2 * 1024 * 1024,
  });

  await assert.rejects(
    () => shipPinRelease({ releaseRoot: localRoot, remoteRoot: served, transport, confirm: true }),
    (error) =>
      error instanceof PinReleaseShipError &&
      error.code === "remote-failed" &&
      /pinned digest/u.test(error.message),
  );
  assert.deepEqual(
    (await jsonLines(operationLog)).map((entry) => entry.kind),
    ["mkdir", "remove"],
  );
  assert.deepEqual(await readdir(join(served, "releases")), []);
  assert.deepEqual(await readdir(served), ["releases"]);
});

test("the remote invocation and rsync endpoints are quoted, bounded, and contain no secrets", async () => {
  const shipSource = await readFile(SHIP_TOOL, "utf8");
  assert.equal(shipSource.includes('payload_file="$(mktemp)"'), false);
  assert.equal(shipSource.includes("REVIVAL_PIN_PAYLOAD"), false);
  assert.equal(REMOTE_RSYNC_LAUNCHER_SOURCE.includes("resumeKey"), false);
  assert.equal(REMOTE_RSYNC_LAUNCHER_SOURCE.includes("load_checkpoint"), false);
  assert.match(shipSource, /continuously malicious process with\n \* the same UID/u);
  assert.match(shipSource, /requires a dedicated deployment UID if it must be isolated/u);
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.throws(
    () => shellQuote("nul\0byte"),
    (error) => error instanceof PinReleaseShipError && error.code === "invalid-invocation",
  );

  for (const unsafe of [
    "relative/path",
    "/has/../traversal",
    "/double//slash",
    "/trailing/",
    "/semi;colon",
    "/dollar$sign",
  ]) {
    assert.throws(
      () => validateRemoteRoot(unsafe),
      (error) => error instanceof PinReleaseShipError && error.code === "invalid-remote-root",
      unsafe,
    );
  }
  assert.equal(
    validateRemoteRoot("/home/anders/ai-pin-revival/data/pin-releases"),
    "/home/anders/ai-pin-revival/data/pin-releases",
  );

  const composed = composeRemoteInvocation({ script: "true\n" });
  assert.match(composed, /^set -euo pipefail\n/u);
  assert.equal(composed.includes(PAYLOAD_DELIMITER), false);
  assert.equal(composed.includes("REVIVAL_PIN_PAYLOAD"), false);
  assert.equal(composed.includes("mktemp"), false);
  assert.throws(
    () => composeRemoteInvocation({ script: "true\n", document: '{"a":1}' }),
    (error) => error instanceof PinReleaseShipError && error.code === "invalid-invocation",
  );

  assert.throws(
    () => createSshTransport({ remote: "vps; rm -rf /" }),
    (error) => error instanceof PinReleaseShipError && error.code === "invalid-remote",
  );
  assert.throws(
    () => createSshTransport({ remote: "-v" }),
    (error) => error instanceof PinReleaseShipError && error.code === "invalid-remote",
  );
  for (const unsafeRemote of [
    ":",
    "vps::module",
    "vps:873",
    "2001:db8::1",
    "user@[2001:db8::1]",
    "@vps",
    "operator@",
    "operator@@vps",
  ]) {
    assert.throws(
      () => createSshTransport({ remote: unsafeRemote }),
      (error) => error instanceof PinReleaseShipError && error.code === "invalid-remote",
      unsafeRemote,
    );
  }
  assert.equal(createSshTransport({ remote: "vps" }).describe(), "ssh:vps");
  assert.equal(createSshTransport({ remote: "operator@vps" }).describe(), "ssh:operator@vps");
  assert.throws(
    () => createSshTransport({ remote: "vps", sshExecutable: "ssh -F attacker-config" }),
    (error) => error instanceof PinReleaseShipError && error.code === "invalid-transport",
  );
  const transport = createSshTransport({ remote: "vps", rsyncExecutable: "/must/not/run" });
  await assert.rejects(
    () => transport.upload({ source: "relative.apk", destination: "/safe/server.apk", label: "upload" }),
    (error) => error instanceof PinReleaseShipError && error.code === "invalid-upload",
  );
  await assert.rejects(
    () => transport.upload({ source: "/safe/server.apk", destination: "/safe/../escape.apk", label: "upload" }),
    (error) => error instanceof PinReleaseShipError && error.code === "invalid-remote-root",
  );
  await assert.rejects(
    () => transport.upload({ source: "/safe/server.apk", destination: "/safe/server.apk;touch", label: "upload" }),
    (error) => error instanceof PinReleaseShipError && error.code === "invalid-remote-root",
  );
});

test("ship is a separate operator step: it plans by default and never runs a deploy", () => {
  const help = spawnSync(process.execPath, [SHIP_TOOL, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /pin release ship/u);
  assert.match(help.stdout, /Without --confirm/u);
  assert.match(help.stdout, /never runs a deploy/u);

  const rejected = spawnSync(process.execPath, [SHIP_TOOL, "ship", "--local", "--remote", "vps"], {
    encoding: "utf8",
  });
  assert.equal(rejected.status, 64, rejected.stderr);
  assert.match(rejected.stderr, /mutually exclusive/u);

  // Nothing in the ship path may reach the deploy drivers, and it has no say in
  // how Center serves what it publishes: the origin gate on
  // /api/pin/releases/* is pinned by three deploy gates and is not this tool's
  // to relax. Shipping a release must never become a reason to widen it.
  const source = spawnSync("cat", [SHIP_TOOL], { encoding: "utf8" }).stdout;
  assert.doesNotMatch(source, /deploy\.sh|rollback\.sh|docker/u);
  assert.doesNotMatch(source, /REVIVAL_PIN_SETUP_ORIGIN|access-control-allow|cors/iu);
});
