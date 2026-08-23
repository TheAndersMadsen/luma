import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PIN_COMPATIBILITY_CERT_SHA256,
  PinReleaseBuildError,
  createDockerPrefetchInvocation,
  createDockerRunInvocation,
  parseBuilderMetadata,
  parseLiteralSigningEnvironment,
  publishPinReleaseFixture as publishPinRelease,
  validatePinReleaseVersion,
} from "../pin/build.mjs";
import {
  PIN_RELEASE_ARTIFACT_ROLES,
  PIN_RELEASE_PACKAGE_BY_ROLE,
} from "../pin/release.mjs";

// The schema-1 publisher is a compatibility fixture only. Authoritative
// entrypoints explicitly reject this mode, and ship/Center never accept its
// evidence-free output.
process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES = "1";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "revival-pin-build-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const stagingRoot = join(root, "staging");
  const releaseRoot = join(root, "releases");
  await mkdir(stagingRoot, { mode: 0o700 });
  await mkdir(releaseRoot, { mode: 0o700 });
  return { root, stagingRoot, releaseRoot };
}

async function stageSyntheticRelease(stagingRoot, version, versionCode, marker = "one") {
  const rows = [];
  for (const role of PIN_RELEASE_ARTIFACT_ROLES) {
    const bytes = Buffer.from(`synthetic-apk:${marker}:${role}:${version}:${versionCode}\n`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(stagingRoot, `${role}.apk`), bytes, { mode: 0o600 });
    rows.push([
      role,
      PIN_RELEASE_PACKAGE_BY_ROLE[role],
      version,
      String(versionCode),
      PIN_COMPATIBILITY_CERT_SHA256,
      digest,
      String(bytes.length),
    ].join("\t"));
  }
  await writeFile(join(stagingRoot, "release-metadata.tsv"), `${rows.join("\n")}\n`, { mode: 0o600 });
}

test("literal signing parser accepts only the complete fixed-name contract", () => {
  const parsed = parseLiteralSigningEnvironment([
    "export PIN_SIGNING_STORE_FILE='/outside/compat.keystore'",
    "export PIN_SIGNING_STORE_PASSWORD='store-secret'",
    "export PIN_SIGNING_KEY_ALIAS=compat",
    "export PIN_SIGNING_KEY_PASSWORD=key-secret",
    "",
  ].join("\n"));
  assert.equal(parsed.PIN_SIGNING_STORE_FILE, "/outside/compat.keystore");
  const quoted = parseLiteralSigningEnvironment([
    "export PIN_SIGNING_STORE_FILE='/outside/compat.keystore'",
    "export PIN_SIGNING_STORE_PASSWORD='store'\\''secret'",
    "export PIN_SIGNING_KEY_ALIAS=compat",
    "export PIN_SIGNING_KEY_PASSWORD='key'\\''secret'",
  ].join("\n"));
  assert.equal(quoted.PIN_SIGNING_STORE_PASSWORD, "store'secret");
  assert.equal(quoted.PIN_SIGNING_KEY_PASSWORD, "key'secret");
  assert.throws(
    () => parseLiteralSigningEnvironment("export PIN_SIGNING_STORE_FILE=/outside/key\n"),
    (error) => error instanceof PinReleaseBuildError && error.code === "signing-env-invalid",
  );
  assert.throws(
    () => parseLiteralSigningEnvironment([
      "export PIN_SIGNING_STORE_FILE=/outside/key",
      "export PIN_SIGNING_STORE_PASSWORD=secret",
      "export PIN_SIGNING_KEY_ALIAS=alias",
      "export PIN_SIGNING_KEY_PASSWORD=secret",
      "export UNREVIEWED_SECRET=bad",
    ].join("\n")),
    (error) => error instanceof PinReleaseBuildError && error.code === "signing-env-invalid",
  );
});

test("release version parser rejects impossible dates and Android overflow", () => {
  assert.deepEqual(validatePinReleaseVersion("2026-08-09.1", 202_608_091), {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
  });
  assert.throws(() => validatePinReleaseVersion("2026-02-30.1", 202_602_301));
  assert.throws(() => validatePinReleaseVersion("2026-08-09.1", 2_147_483_648));
});

test("networked prefetch has no signing input and offline release binds only d8a64 inputs", () => {
  const prefetch = createDockerPrefetchInvocation({
    sourceRoot: "/source",
    stateRoot: "/state",
    cacheRoot: "/cache-host",
    image: "builder:test",
    version: "2026-08-09.1",
    versionCode: 202_608_091,
    uid: 501,
    gid: 20,
  });
  const prefetchCommand = prefetch.args.join("\n");
  assert.match(prefetchCommand, /prefetch-release/u);
  assert.doesNotMatch(
    prefetchCommand,
    /signing\.env|\.keystore|STORE_PASSWORD|KEY_PASSWORD|private-assets/u,
  );

  const invocation = createDockerRunInvocation({
    sourceRoot: "/source",
    stateRoot: "/state",
    cacheRoot: "/cache-host",
    signingEnvironment: "/secrets/signing.env",
    compatibilitySigningStore: "/secrets/compat.keystore",
    embeddedPatchSigningStore: "/secrets/compat.keystore",
    privateAssets: "/private-assets",
    hostedRequest: "/attestation/request.json",
    preSignBundle: "/attestation/pre-sign.sigstore.json",
    image: "builder:test",
    version: "2026-08-09.1",
    versionCode: 202_608_091,
    uid: 501,
    gid: 20,
  });
  const command = invocation.args.join("\n");
  assert.match(command, /embedded-patch\.keystore,readonly/u);
  assert.match(command, /signing\.env,readonly/u);
  assert.match(command, /hosted-release\/request\.json,readonly/u);
  assert.match(command, /hosted-release\/pre-sign\.sigstore\.json,readonly/u);
  assert.doesNotMatch(command, /bootstrap-package|legacy.*debug/u);
  assert.doesNotMatch(command, /STORE_PASSWORD|KEY_PASSWORD|store-secret|key-secret/u);
  assert.ok(invocation.args.includes("--read-only"));
  assert.deepEqual(
    invocation.args.slice(invocation.args.indexOf("--network"), invocation.args.indexOf("--network") + 2),
    ["--network", "none"],
  );
  assert.ok(invocation.args.includes("no-new-privileges:true"));
});

test("five builder roles publish atomically with monotonic history and idempotent replay", async (t) => {
  const f = await fixture(t);
  const version = "2026-08-09.1";
  const versionCode = 202_608_091;
  await stageSyntheticRelease(f.stagingRoot, version, versionCode);
  const receipts = await parseBuilderMetadata({ stagingRoot: f.stagingRoot, version, versionCode });
  const first = await publishPinRelease({
    releaseRoot: f.releaseRoot,
    stagingRoot: f.stagingRoot,
    version,
    receipts,
  });
  assert.equal(first.artifacts.length, 5);
  const current = JSON.parse(await readFile(join(f.releaseRoot, "current.json"), "utf8"));
  assert.equal(current.releaseId, first.releaseId);
  assert.deepEqual(current.artifacts.map((artifact) => artifact.role), PIN_RELEASE_ARTIFACT_ROLES);
  for (const role of PIN_RELEASE_ARTIFACT_ROLES) {
    assert.equal(
      await readFile(join(f.releaseRoot, "releases", first.releaseId, `${role}.apk`), "utf8"),
      await readFile(join(f.stagingRoot, `${role}.apk`), "utf8"),
    );
  }

  const replay = await publishPinRelease({
    releaseRoot: f.releaseRoot,
    stagingRoot: f.stagingRoot,
    version,
    receipts,
  });
  assert.equal(replay.releaseId, first.releaseId);
  assert.equal((await readFile(join(f.releaseRoot, ".publish.lock"))).length, 0);
  const history = JSON.parse(await readFile(join(f.releaseRoot, "history.json"), "utf8"));
  assert.equal(history.releases.length, 1);

  const nextStaging = join(f.root, "next-staging");
  await mkdir(nextStaging, { mode: 0o700 });
  await stageSyntheticRelease(nextStaging, "2026-08-09.2", 202_608_092, "two");
  const nextReceipts = await parseBuilderMetadata({
    stagingRoot: nextStaging,
    version: "2026-08-09.2",
    versionCode: 202_608_092,
  });
  await publishPinRelease({
    releaseRoot: f.releaseRoot,
    stagingRoot: nextStaging,
    version: "2026-08-09.2",
    receipts: nextReceipts,
  });
  const nextHistory = JSON.parse(await readFile(join(f.releaseRoot, "history.json"), "utf8"));
  assert.equal(nextHistory.releases.length, 2);
  await assert.rejects(
    () => publishPinRelease({
      releaseRoot: f.releaseRoot,
      stagingRoot: f.stagingRoot,
      version,
      receipts,
    }),
    /older accepted release cannot become current again/u,
  );
});

test("missing history fails closed and missing current recovers only the verified tail", async (t) => {
  const f = await fixture(t);
  const version = "2026-08-09.1";
  const versionCode = 202_608_091;
  await stageSyntheticRelease(f.stagingRoot, version, versionCode);
  const receipts = await parseBuilderMetadata({ stagingRoot: f.stagingRoot, version, versionCode });
  const published = await publishPinRelease({ releaseRoot: f.releaseRoot, stagingRoot: f.stagingRoot, version, receipts });
  const priorCurrent = await readFile(join(f.releaseRoot, "current.json"), "utf8");

  await unlink(join(f.releaseRoot, "current.json"));
  await publishPinRelease({ releaseRoot: f.releaseRoot, stagingRoot: f.stagingRoot, version, receipts });
  const recovered = JSON.parse(await readFile(join(f.releaseRoot, "current.json"), "utf8"));
  assert.equal(recovered.releaseId, published.releaseId);

  const nextStaging = join(f.root, "next-staging");
  await mkdir(nextStaging, { mode: 0o700 });
  await stageSyntheticRelease(nextStaging, "2026-08-09.2", 202_608_092, "next");
  const nextReceipts = await parseBuilderMetadata({
    stagingRoot: nextStaging,
    version: "2026-08-09.2",
    versionCode: 202_608_092,
  });
  const next = await publishPinRelease({
    releaseRoot: f.releaseRoot,
    stagingRoot: nextStaging,
    version: "2026-08-09.2",
    receipts: nextReceipts,
  });
  // Simulate a crash after history.json advanced but before current.json did.
  await writeFile(join(f.releaseRoot, "current.json"), priorCurrent, { mode: 0o600 });
  await publishPinRelease({
    releaseRoot: f.releaseRoot,
    stagingRoot: nextStaging,
    version: "2026-08-09.2",
    receipts: nextReceipts,
  });
  assert.equal(
    JSON.parse(await readFile(join(f.releaseRoot, "current.json"), "utf8")).releaseId,
    next.releaseId,
  );

  await unlink(join(f.releaseRoot, "history.json"));
  await assert.rejects(
    () => publishPinRelease({ releaseRoot: f.releaseRoot, stagingRoot: f.stagingRoot, version, receipts }),
    (error) => error instanceof PinReleaseBuildError && error.code === "history-missing",
  );
});

test("immutable releases cannot reset anti-rollback when both ledger files disappear", async (t) => {
  const f = await fixture(t);
  const version = "2026-08-09.1";
  const versionCode = 202_608_091;
  await stageSyntheticRelease(f.stagingRoot, version, versionCode);
  const receipts = await parseBuilderMetadata({ stagingRoot: f.stagingRoot, version, versionCode });
  await publishPinRelease({ releaseRoot: f.releaseRoot, stagingRoot: f.stagingRoot, version, receipts });
  await Promise.all([
    unlink(join(f.releaseRoot, "current.json")),
    unlink(join(f.releaseRoot, "history.json")),
  ]);
  await assert.rejects(
    () => publishPinRelease({ releaseRoot: f.releaseRoot, stagingRoot: f.stagingRoot, version, receipts }),
    (error) => error instanceof PinReleaseBuildError && error.code === "history-missing",
  );
});

test("immutable releases reject extra entries and every role rejects a non-d8 receipt", async (t) => {
  const f = await fixture(t);
  const version = "2026-08-09.1";
  const versionCode = 202_608_091;
  await stageSyntheticRelease(f.stagingRoot, version, versionCode);
  const metadataPath = join(f.stagingRoot, "release-metadata.tsv");
  const originalMetadata = await readFile(metadataPath, "utf8");
  await writeFile(metadataPath, originalMetadata.replace(
    `bootstrap\t${PIN_RELEASE_PACKAGE_BY_ROLE.bootstrap}\t${version}\t${versionCode}\t${PIN_COMPATIBILITY_CERT_SHA256}`,
    `bootstrap\t${PIN_RELEASE_PACKAGE_BY_ROLE.bootstrap}\t${version}\t${versionCode}\t${"4".repeat(64)}`,
  ));
  await assert.rejects(
    () => parseBuilderMetadata({ stagingRoot: f.stagingRoot, version, versionCode }),
    (error) => error instanceof PinReleaseBuildError && error.code === "builder-output",
  );

  await writeFile(metadataPath, originalMetadata);
  const receipts = await parseBuilderMetadata({ stagingRoot: f.stagingRoot, version, versionCode });
  const published = await publishPinRelease({ releaseRoot: f.releaseRoot, stagingRoot: f.stagingRoot, version, receipts });
  await writeFile(join(published.releaseDirectory, "unexpected.txt"), "not immutable\n");
  await assert.rejects(
    () => publishPinRelease({ releaseRoot: f.releaseRoot, stagingRoot: f.stagingRoot, version, receipts }),
    /missing or unexpected entries/u,
  );
});

test("publication lock is kernel-released after an unclean owner exit", async (t) => {
  const f = await fixture(t);
  const version = "2026-08-09.1";
  const versionCode = 202_608_091;
  await stageSyntheticRelease(f.stagingRoot, version, versionCode);
  const receipts = await parseBuilderMetadata({ stagingRoot: f.stagingRoot, version, versionCode });
  const lockPath = join(f.releaseRoot, ".publish.lock");
  const holder = spawn("python3", ["-c", [
    "import fcntl, os, sys",
    "fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)",
    "fcntl.flock(fd, fcntl.LOCK_EX)",
    "print('READY', flush=True)",
    "sys.stdin.buffer.read()",
  ].join("\n"), lockPath], { stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => holder.kill("SIGKILL"));
  await new Promise((resolvePromise, rejectPromise) => {
    holder.once("error", rejectPromise);
    holder.stdout.once("data", (chunk) => {
      if (chunk.toString("utf8").trim() === "READY") resolvePromise();
      else rejectPromise(new Error("lock holder did not become ready"));
    });
  });
  await assert.rejects(
    () => publishPinRelease({ releaseRoot: f.releaseRoot, stagingRoot: f.stagingRoot, version, receipts }),
    (error) => error instanceof PinReleaseBuildError && error.code === "publish-locked",
  );
  holder.kill("SIGKILL");
  await new Promise((resolvePromise) => holder.once("close", resolvePromise));
  const published = await publishPinRelease({ releaseRoot: f.releaseRoot, stagingRoot: f.stagingRoot, version, receipts });
  assert.equal(published.version, version);
});

test("builder metadata rejects post-verification byte replacement", async (t) => {
  const f = await fixture(t);
  await stageSyntheticRelease(f.stagingRoot, "2026-08-09.1", 202_608_091);
  await writeFile(join(f.stagingRoot, "server.apk"), "changed\n");
  await assert.rejects(
    () => parseBuilderMetadata({
      stagingRoot: f.stagingRoot,
      version: "2026-08-09.1",
      versionCode: 202_608_091,
    }),
    (error) => error instanceof PinReleaseBuildError && error.code === "builder-output",
  );
});
