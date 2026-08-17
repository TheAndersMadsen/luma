import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  PIN_COMPATIBILITY_CERT_SHA256,
  parseBuilderMetadata,
  publishPinRelease,
} from "../pin/build.mjs";
import { PIN_RELEASE_ARTIFACT_ROLES, PIN_RELEASE_PACKAGE_BY_ROLE } from "../pin/release.mjs";
import {
  PAYLOAD_DELIMITER,
  PinReleaseShipError,
  REMOTE_APPLY_SCRIPT,
  composeRemoteInvocation,
  createApplyPayload,
  createLocalTransport,
  createPinReleaseShipPlan,
  createSshTransport,
  inspectRemotePinReleaseStore,
  readLocalPinReleaseStore,
  shellQuote,
  shipPinRelease,
  validateRemoteRoot,
} from "../pin/ship.mjs";

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

test("a shipped store is byte-identical to the published one and re-shipping is a no-op", async (t) => {
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
  assert.equal(first.uploads.length, 6);

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
  // Nothing beyond the store layout Center understands is left behind — no
  // incoming directory, no lock, no partial upload.
  assert.deepEqual((await readdir(served)).sort(), ["current.json", "history.json", "releases"]);
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
  assert.equal(plan.uploads.length, 6);
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
    ],
  };
  await assert.rejects(
    () =>
      transport.run({
        script: REMOTE_APPLY_SCRIPT,
        args: [served],
        document: createApplyPayload(rewrite, ".incoming-rewrite"),
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

  await assert.rejects(
    () =>
      transport.run({
        script: REMOTE_APPLY_SCRIPT,
        args: [served],
        document: createApplyPayload(plan, ".incoming-corrupt"),
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
    await assert.rejects(
      () =>
        transport.run({
          script: REMOTE_APPLY_SCRIPT,
          args: [served],
          document: createApplyPayload(plan, name),
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

test("the remote invocation is quoted, bounded, and carries no secrets of its own", () => {
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

  const composed = composeRemoteInvocation({ script: "true\n", document: '{"a":1}' });
  assert.match(composed, /^set -euo pipefail\n/u);
  assert.ok(composed.includes(`cat <<'${PAYLOAD_DELIMITER}' > "$payload_file"`));
  assert.ok(composed.includes('trap cleanup_payload EXIT'));
  assert.throws(
    () => composeRemoteInvocation({ script: "true\n", document: `x${PAYLOAD_DELIMITER}y` }),
    (error) => error instanceof PinReleaseShipError && error.code === "invalid-invocation",
  );

  assert.throws(
    () => createSshTransport({ remote: "vps; rm -rf /" }),
    (error) => error instanceof PinReleaseShipError && error.code === "invalid-remote",
  );
  assert.equal(createSshTransport({ remote: "vps" }).describe(), "ssh:vps");
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
