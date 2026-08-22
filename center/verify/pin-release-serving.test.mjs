// Registers the resolve hook that lets src/server/pin-releases.ts reach its own
// extensionless sibling import (`./log`) under Node's type stripping. Static, so
// it is evaluated before the dynamic import below.
import "./tsResolve.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const {
  PIN_RELEASE_PACKAGE_BY_ROLE,
  PIN_RELEASE_ROLES,
  PIN_RELEASE_SNAPSHOT_IDLE_TIMEOUT_MS,
  PIN_RELEASE_SNAPSHOT_MAX_LEASES,
  PIN_RELEASE_SNAPSHOT_MAX_LIFETIME_MS,
  computePinReleaseId,
  parsePinReleaseManifest,
  pinReleaseSnapshotStats,
  pinReleaseVerificationStats,
  serializePinReleaseManifest,
  serveCurrentPinRelease,
  servePinReleaseArtifact,
  servePinReleaseOptions,
} = await import("../src/server/pin-releases.ts?pin-release-serving-test");

// No query string: this has to be the SAME module instance pin-releases.ts
// logs through, and a query would make a second one whose sink nobody uses.
const { setLogSinkForTests } = await import("../src/server/log.ts");

const PIN_RELEASE_MODULE_URL = new URL("../src/server/pin-releases.ts", import.meta.url).href;
const LOG_MODULE_URL = new URL("../src/server/log.ts", import.meta.url).href;
const TS_RESOLVE_PATH = fileURLToPath(new URL("./tsResolve.mjs", import.meta.url));
const COLD_ARTIFACT_CHILD = `
const [root, releaseId, assetName, method, range, requestCountText] = process.argv.slice(1);
const pinReleases = await import(${JSON.stringify(PIN_RELEASE_MODULE_URL)} + "?cold-direct=" + process.pid);
const { setLogSinkForTests } = await import(${JSON.stringify(LOG_MODULE_URL)});
setLogSinkForTests(() => undefined);
const requestCount = Number.parseInt(requestCountText, 10);
const invoke = async () => {
  const headers = range === "-" ? undefined : { range };
  const response = await pinReleases.servePinReleaseArtifact(
    new Request("https://cosmos.example.test/api/pin/releases/" + releaseId + "/" + assetName, {
      method,
      headers,
    }),
    releaseId,
    assetName,
    { environment: { REVIVAL_PIN_RELEASE_DIR: root }, head: method === "HEAD" },
  );
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    contentLength: response.headers.get("content-length"),
    body: response.body === null
      ? null
      : Buffer.from(await response.arrayBuffer()).toString("base64"),
  };
};
const responses = await Promise.all(Array.from({ length: requestCount }, invoke));
process.stdout.write(JSON.stringify({ responses, stats: pinReleases.pinReleaseVerificationStats() }));
`;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalValue = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
};
const canonicalJson = (value) => `${canonicalValue(value)}\n`;

function authorityEvidence(version, versionCode, identities, mutate = () => undefined) {
  const artifacts = identities.map(({ role, name, sha256: digest, size }) => ({ role, name, sha256: digest, size }));
  const payload = (value = {}) => Buffer.from(canonicalJson(value));
  const policy = payload();
  const trustedRoot = payload();
  const preBundle = payload();
  const releaseBundle = payload();
  const verification = payload();
  const request = payload({
    schema: "revival.pin-hosted-release-request", version: 1, policySha256: sha256(policy),
    repository: "TheAndersMadsen/ai-pin-revival", sourceRef: "refs/heads/main",
    sourceDigest: "0".repeat(40), sourceGenerationSha256: "1".repeat(64),
    sourceTarSha256: "2".repeat(64), builderImageId: `sha256:${"3".repeat(64)}`,
    toolchainSha256: "4".repeat(64), versionName: version, versionCode,
    roles: PIN_RELEASE_ROLES,
  });
  const run = "https://github.com/TheAndersMadsen/ai-pin-revival/actions/runs/1/attempts/1";
  const predicate = payload({
    schema: "revival.pin-hosted-five-apk", version: 1, requestSha256: sha256(request),
    preSignBundleSha256: sha256(preBundle), runnerInvocationUri: run, artifacts,
  });
  const evidence = {
    schema: "revival.pin-hosted-release-evidence", version: 1, provider: "github-actions-sigstore",
    policySha256: sha256(policy), requestSha256: sha256(request), predicateSha256: sha256(predicate),
    trustedRootSha256: sha256(trustedRoot), preSignBundleSha256: sha256(preBundle),
    releaseBundleSha256: sha256(releaseBundle), preSignVerificationSha256: sha256(verification),
    releaseVerificationSha256: sha256(verification), runnerEnvironment: "github-hosted",
    runnerLabel: "ubuntu-24.04", runnerArchitecture: "x64", runnerInvocationUri: run,
    repository: "TheAndersMadsen/ai-pin-revival", sourceRef: "refs/heads/main",
    sourceDigest: "0".repeat(40), sourceGenerationSha256: "1".repeat(64),
    sourceTarSha256: "2".repeat(64), toolchainSha256: "4".repeat(64),
    builderImageId: `sha256:${"3".repeat(64)}`, artifacts,
    payloads: {
      policyBase64: policy.toString("base64"), requestBase64: request.toString("base64"),
      predicateBase64: predicate.toString("base64"), trustedRootBase64: trustedRoot.toString("base64"),
      preSignBundleBase64: preBundle.toString("base64"), releaseBundleBase64: releaseBundle.toString("base64"),
      preSignVerificationBase64: verification.toString("base64"),
      releaseVerificationBase64: verification.toString("base64"),
    },
  };
  mutate(evidence);
  return Buffer.from(canonicalJson(evidence));
}

async function createStore(context) {
  const root = await mkdtemp(path.join(tmpdir(), "revival-pin-releases-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function publishRelease(
  root,
  {
    seed = "one",
    version = "2026-08-09.1",
    versionCode = 101,
    current = true,
    mutateEvidence = () => undefined,
    bytesByRole: suppliedBytesByRole,
  } = {},
) {
  const bytesByRole = new Map(
    PIN_RELEASE_ROLES.map((role) => [
      role,
      suppliedBytesByRole?.get(role) ?? Buffer.from(`synthetic-${seed}-${role}-apk`),
    ]),
  );
  const identities = PIN_RELEASE_ROLES.map((role) => {
    const bytes = bytesByRole.get(role);
    return {
      role,
      name: `Penumbra-${seed}-${role}.apk`,
      package: PIN_RELEASE_PACKAGE_BY_ROLE[role],
      versionCode,
      size: bytes.length,
      sha256: sha256(bytes),
    };
  });
  const evidence = authorityEvidence(version, versionCode, identities, mutateEvidence);
  const evidenceValue = JSON.parse(evidence.toString("utf8"));
  const authority = {
    kind: "github-hosted-native-x64",
    name: "hosted-attestation.json",
    size: evidence.length,
    sha256: sha256(evidence),
    provider: evidenceValue.provider,
    policySha256: evidenceValue.policySha256,
    requestSha256: evidenceValue.requestSha256,
    predicateSha256: evidenceValue.predicateSha256,
    trustedRootSha256: evidenceValue.trustedRootSha256,
    preSignBundleSha256: evidenceValue.preSignBundleSha256,
    releaseBundleSha256: evidenceValue.releaseBundleSha256,
    preSignVerificationSha256: evidenceValue.preSignVerificationSha256,
    releaseVerificationSha256: evidenceValue.releaseVerificationSha256,
    runnerEnvironment: evidenceValue.runnerEnvironment,
    runnerLabel: evidenceValue.runnerLabel,
    runnerArchitecture: evidenceValue.runnerArchitecture,
    runnerInvocationUri: evidenceValue.runnerInvocationUri,
    repository: evidenceValue.repository,
    sourceRef: evidenceValue.sourceRef,
    sourceDigest: evidenceValue.sourceDigest,
    sourceGenerationSha256: evidenceValue.sourceGenerationSha256,
    sourceTarSha256: evidenceValue.sourceTarSha256,
    toolchainSha256: evidenceValue.toolchainSha256,
    builderImageId: evidenceValue.builderImageId,
  };
  const releaseId = computePinReleaseId({
    schemaVersion: 2,
    version,
    artifacts: identities,
    authority,
  });
  const manifest = {
    schemaVersion: 2,
    releaseId,
    version,
    artifacts: identities.map((artifact) => ({
      role: artifact.role,
      url: `./${releaseId}/${artifact.role}.apk`,
      name: artifact.name,
      package: artifact.package,
      versionCode: artifact.versionCode,
      size: artifact.size,
      sha256: artifact.sha256,
    })),
    authority,
  };
  const document = serializePinReleaseManifest(manifest);
  const releaseDirectory = path.join(root, "releases", releaseId);
  await mkdir(releaseDirectory, { recursive: true });
  await Promise.all(
    manifest.artifacts.map((artifact) =>
      writeFile(path.join(releaseDirectory, artifact.name), bytesByRole.get(artifact.role)),
    ),
  );
  await writeFile(path.join(releaseDirectory, "manifest.json"), document);
  await writeFile(path.join(releaseDirectory, authority.name), evidence);
  if (current) await writeFile(path.join(root, "current.json"), document);
  return { releaseId, manifest, document, bytesByRole, releaseDirectory };
}

async function rebindAuthoritySidecar(release, bytes) {
  const manifest = structuredClone(release.manifest);
  manifest.authority.size = bytes.length;
  manifest.authority.sha256 = sha256(bytes);
  const identities = manifest.artifacts.map(({ url: _url, ...identity }) => identity);
  const releaseId = computePinReleaseId({
    schemaVersion: 2,
    version: manifest.version,
    artifacts: identities,
    authority: manifest.authority,
  });
  manifest.releaseId = releaseId;
  for (const artifact of manifest.artifacts) {
    artifact.url = `./${releaseId}/${artifact.role}.apk`;
  }
  const releaseDirectory = path.join(path.dirname(release.releaseDirectory), releaseId);
  await rename(release.releaseDirectory, releaseDirectory);
  const document = serializePinReleaseManifest(manifest);
  await writeFile(path.join(releaseDirectory, "manifest.json"), document);
  await writeFile(path.join(releaseDirectory, manifest.authority.name), bytes);
  return { ...release, releaseId, manifest, document, releaseDirectory };
}

function coldArtifactRequest(
  root,
  releaseId,
  { assetName = "installer.apk", method = "GET", range = "-", requestCount = 1 } = {},
) {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      TS_RESOLVE_PATH,
      "--input-type=module",
      "--eval",
      COLD_ARTIFACT_CHILD,
      root,
      releaseId,
      assetName,
      method,
      range,
      String(requestCount),
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  assert.equal(
    child.status,
    0,
    `cold artifact child failed\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
  );
  return JSON.parse(child.stdout);
}

function assertColdArtifactFailures(result, expectedCount = 1) {
  assert.equal(result.responses.length, expectedCount);
  for (const response of result.responses) {
    assert.equal(response.status, 503);
    assert.equal(response.contentType, "application/json; charset=utf-8");
    if (response.body !== null) {
      assert.equal(
        Buffer.from(response.body, "base64").toString("utf8"),
        '{"error":"Pin release unavailable."}',
      );
    }
  }
  assert.equal(result.stats.verifications, 0, "a partial cold verdict was cached as verified");
}

function environment(root, origin) {
  return {
    REVIVAL_PIN_RELEASE_DIR: root,
    ...(origin ? { REVIVAL_PIN_SETUP_ORIGIN: origin } : {}),
  };
}

async function waitForSnapshot(predicate, message) {
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    const stats = pinReleaseSnapshotStats();
    if (predicate(stats)) return stats;
    await delay(1);
  }
  assert.fail(`${message}: ${JSON.stringify(pinReleaseSnapshotStats())}`);
}

async function waitForSnapshotIdle(message = "snapshot state did not become idle") {
  return waitForSnapshot(
    (stats) =>
      stats.activeFiles === 0 && stats.activeLeases === 0 &&
      stats.reservedBytes === 0 && stats.building === 0,
    message,
  );
}

async function waitForSnapshotIdleWithMockedTimeouts(message) {
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    const stats = pinReleaseSnapshotStats();
    if (
      stats.activeFiles === 0 && stats.activeLeases === 0 &&
      stats.reservedBytes === 0 && stats.building === 0
    ) return stats;
    await immediate();
  }
  assert.fail(`${message}: ${JSON.stringify(pinReleaseSnapshotStats())}`);
}

async function snapshotDirectoryNames() {
  return (await readdir(tmpdir()))
    .filter((name) => name.startsWith("revival-pin-release-snapshot-"))
    .sort();
}

function artifactPath(release, role) {
  const artifact = release.manifest.artifacts.find((candidate) => candidate.role === role);
  assert.ok(artifact, `missing ${role} fixture artifact`);
  return path.join(release.releaseDirectory, artifact.name);
}

function artifactUrl(release, role) {
  return `https://cosmos.example.test/api/pin/releases/${release.releaseId}/${role}.apk`;
}

async function overwriteSameInode(filename, size, fill) {
  const handle = await open(filename, "r+");
  const chunk = Buffer.alloc(Math.min(1024 * 1024, size), fill);
  try {
    for (let position = 0; position < size; position += chunk.length) {
      const length = Math.min(chunk.length, size - position);
      const { bytesWritten } = await handle.write(chunk, 0, length, position);
      assert.equal(bytesWritten, length);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

test("current Pin release is canonical, complete, hardened, and same-origin compatible", async (t) => {
  const root = await createStore(t);
  const release = await publishRelease(root);
  const response = await serveCurrentPinRelease(
    new Request("https://cosmos.example.test/api/pin/releases/current"),
    { environment: environment(root) },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(release.document)));
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const document = await response.text();
  assert.equal(document, release.document);
  assert.equal(document.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(document), release.manifest);
  for (const artifact of release.manifest.artifacts) {
    assert.equal(
      new URL(artifact.url, "https://cosmos.example.test/api/pin/releases/current").pathname,
      `/api/pin/releases/${release.releaseId}/${artifact.role}.apk`,
    );
  }
});

test("APK downloads use immutable role URLs, exact lengths, and streaming bodies", async (t) => {
  const root = await createStore(t);
  const first = await publishRelease(root, { seed: "first", versionCode: 101 });
  await publishRelease(root, {
    seed: "second",
    version: "2026-08-09.2",
    versionCode: 102,
  });

  const url = `https://cosmos.example.test/api/pin/releases/${first.releaseId}/installer.apk`;
  const response = await servePinReleaseArtifact(
    new Request(url),
    first.releaseId,
    "installer.apk",
    { environment: environment(root) },
  );
  const expected = first.bytesByRole.get("installer");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/vnd.android.package-archive");
  assert.equal(response.headers.get("content-length"), String(expected.length));
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.ok(response.body instanceof ReadableStream);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);

  const head = await servePinReleaseArtifact(
    new Request(url, { method: "HEAD" }),
    first.releaseId,
    "installer.apk",
    { environment: environment(root), head: true },
  );
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(head.headers.get("content-length"), String(expected.length));
});

test("a 64 MiB download serves only its approved snapshot after same-inode source overwrite", async (t) => {
  const root = await createStore(t);
  const approved = Buffer.alloc(64 * 1024 * 1024, 0x31);
  const bytesByRole = new Map([["installer", approved]]);
  const release = await publishRelease(root, {
    seed: "snapshot-post-status",
    current: false,
    bytesByRole,
  });
  const source = artifactPath(release, "installer");
  const beforeDirectories = await snapshotDirectoryNames();

  const response = await servePinReleaseArtifact(
    new Request(artifactUrl(release, "installer")),
    release.releaseId,
    "installer.apk",
    { environment: environment(root) },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), String(approved.length));
  assert.equal(response.headers.get("accept-ranges"), "bytes");

  const sourceBefore = await lstat(source);
  await overwriteSameInode(source, approved.length, 0x32);
  const sourceAfter = await lstat(source);
  assert.equal(sourceAfter.ino, sourceBefore.ino, "fixture did not exercise a same-inode overwrite");

  const received = Buffer.from(await response.arrayBuffer());
  assert.equal(received.length, approved.length);
  assert.equal(sha256(received), sha256(approved), "response mixed in mutable source bytes");
  await waitForSnapshotIdle();
  assert.deepEqual(await snapshotDirectoryNames(), beforeDirectories);
});

test("same-inode corruption during a shared snapshot copy fails every waiter before bytes", async (t) => {
  const root = await createStore(t);
  const approved = Buffer.alloc(64 * 1024 * 1024, 0x41);
  const release = await publishRelease(root, {
    seed: "snapshot-copy-corrupt",
    current: false,
    bytesByRole: new Map([["installer", approved]]),
  });
  const beforeDirectories = await snapshotDirectoryNames();
  const before = pinReleaseSnapshotStats();
  const invoke = () => servePinReleaseArtifact(
    new Request(artifactUrl(release, "installer")),
    release.releaseId,
    "installer.apk",
    { environment: environment(root) },
  );

  const first = invoke();
  await waitForSnapshot(
    (stats) => stats.building === 1 && stats.copiedBytes > before.copiedBytes,
    "snapshot copy never wrote its first held chunk",
  );
  const waiters = Array.from({ length: 5 }, invoke);
  const writer = await open(artifactPath(release, "installer"), "r+");
  try {
    assert.equal((await writer.write(Buffer.from([0x42]), 0, 1, 0)).bytesWritten, 1);
    await writer.sync();
  } finally {
    await writer.close();
  }

  const responses = await Promise.all([first, ...waiters]);
  for (const response of responses) {
    assert.equal(response.status, 503);
    assert.equal(await response.text(), '{"error":"Pin release unavailable."}');
  }
  const idle = await waitForSnapshotIdle();
  assert.equal(idle.activeFiles, 0);
  assert.equal(idle.activeLeases, 0);
  assert.ok(idle.created <= before.created + 1, "corrupt copy published multiple snapshots");
  assert.deepEqual(await snapshotDirectoryNames(), beforeDirectories);
});

test("rename replacement during snapshot copy fails closed and leaves no held state", async (t) => {
  const root = await createStore(t);
  const approved = Buffer.alloc(32 * 1024 * 1024, 0x51);
  const release = await publishRelease(root, {
    seed: "snapshot-rename-race",
    current: false,
    bytesByRole: new Map([["installer", approved]]),
  });
  const source = artifactPath(release, "installer");
  const moved = path.join(release.releaseDirectory, "installer.renamed-during-copy");
  const replacement = path.join(release.releaseDirectory, "installer.replacement-during-copy");
  await writeFile(replacement, Buffer.alloc(approved.length, 0x52));
  const beforeDirectories = await snapshotDirectoryNames();
  const before = pinReleaseSnapshotStats();

  const pending = servePinReleaseArtifact(
    new Request(artifactUrl(release, "installer")),
    release.releaseId,
    "installer.apk",
    { environment: environment(root) },
  );
  await waitForSnapshot(
    (stats) => stats.building === 1 && stats.copiedBytes > before.copiedBytes,
    "rename fixture missed the active snapshot copy",
  );
  await rename(source, moved);
  await rename(replacement, source);

  const response = await pending;
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '{"error":"Pin release unavailable."}');
  await waitForSnapshotIdle();
  assert.deepEqual(await snapshotDirectoryNames(), beforeDirectories);
});

test("range and HEAD responses come from exact snapshots and reject malformed ranges before copy", async (t) => {
  const root = await createStore(t);
  const bytes = Buffer.from("0123456789abcdef");
  const release = await publishRelease(root, {
    seed: "snapshot-range-head",
    current: false,
    bytesByRole: new Map([["installer", bytes]]),
  });
  const beforeDirectories = await snapshotDirectoryNames();

  const ranged = await servePinReleaseArtifact(
    new Request(artifactUrl(release, "installer"), { headers: { range: "bytes=2-5" } }),
    release.releaseId,
    "installer.apk",
    { environment: environment(root) },
  );
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), `bytes 2-5/${bytes.length}`);
  assert.equal(ranged.headers.get("content-length"), "4");
  assert.equal(ranged.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(2, 6));
  await waitForSnapshotIdle();

  const head = await servePinReleaseArtifact(
    new Request(artifactUrl(release, "installer"), {
      method: "HEAD",
      headers: { range: "bytes=-4" },
    }),
    release.releaseId,
    "installer.apk",
    { environment: environment(root), head: true },
  );
  assert.equal(head.status, 206);
  assert.equal(head.body, null);
  assert.equal(head.headers.get("content-range"), `bytes 12-15/${bytes.length}`);
  assert.equal(head.headers.get("content-length"), "4");
  await waitForSnapshotIdle();

  const beforeInvalid = pinReleaseSnapshotStats();
  const invalid = await servePinReleaseArtifact(
    new Request(artifactUrl(release, "installer"), {
      headers: { range: "bytes=0-1,4-5" },
    }),
    release.releaseId,
    "installer.apk",
    { environment: environment(root) },
  );
  assert.equal(invalid.status, 503);
  assert.equal(await invalid.text(), '{"error":"Pin release unavailable."}');
  assert.equal(pinReleaseSnapshotStats().created, beforeInvalid.created);
  assert.deepEqual(await snapshotDirectoryNames(), beforeDirectories);
});

test("completed snapshot remains one-flight under parallel pressure and every lease order", async (t) => {
  const root = await createStore(t);
  const approved = Buffer.alloc(8 * 1024 * 1024, 0x61);
  const release = await publishRelease(root, {
    seed: "snapshot-shared-valid",
    current: false,
    bytesByRole: new Map([["installer", approved]]),
  });
  const before = pinReleaseSnapshotStats();
  const invoke = () => servePinReleaseArtifact(
    new Request(artifactUrl(release, "installer")),
    release.releaseId,
    "installer.apk",
    { environment: environment(root) },
  );

  // Await the first response without consuming it. Snapshot construction and
  // the construction flight are both complete here, so every later request can
  // share only through the completed-backing registry.
  const first = await invoke();
  assert.equal(first.status, 200);
  assert.equal(pinReleaseSnapshotStats().building, 0);
  assert.equal(pinReleaseSnapshotStats().created, before.created + 1);

  const responses = await Promise.all(Array.from(
    { length: PIN_RELEASE_SNAPSHOT_MAX_LEASES * 2 - 1 },
    invoke,
  ));
  const accepted = [first, ...responses.filter((response) => response.status === 200)];
  const refused = responses.filter((response) => response.status === 503);
  assert.equal(accepted.length, PIN_RELEASE_SNAPSHOT_MAX_LEASES);
  assert.equal(refused.length, PIN_RELEASE_SNAPSHOT_MAX_LEASES);
  assert.equal(pinReleaseSnapshotStats().created, before.created + 1);
  assert.equal(pinReleaseSnapshotStats().activeFiles, 1);
  assert.equal(pinReleaseSnapshotStats().activeLeases, PIN_RELEASE_SNAPSHOT_MAX_LEASES);
  for (const response of refused) {
    assert.equal(await response.text(), '{"error":"Pin release unavailable."}');
  }

  // Release every lease except the oldest in reverse order. The registry must
  // remain discoverable until that oldest lease ends, without owning a hidden
  // reference of its own.
  for (const response of accepted.slice(1).reverse()) {
    assert.equal(sha256(Buffer.from(await response.arrayBuffer())), sha256(approved));
  }
  await waitForSnapshot(
    (stats) => stats.activeFiles === 1 && stats.activeLeases === 1,
    "reverse lease release lost the completed snapshot",
  );
  const late = await invoke();
  assert.equal(late.status, 200);
  assert.equal(pinReleaseSnapshotStats().created, before.created + 1);
  assert.equal(pinReleaseSnapshotStats().activeFiles, 1);
  assert.equal(sha256(Buffer.from(await late.arrayBuffer())), sha256(approved));
  assert.equal(sha256(Buffer.from(await first.arrayBuffer())), sha256(approved));
  await waitForSnapshotIdle();

  // With no lease left, the completed registry must own nothing and a later
  // request must construct exactly one fresh anonymous backing.
  const reopened = await invoke();
  assert.equal(reopened.status, 200);
  assert.equal(pinReleaseSnapshotStats().created, before.created + 2);
  assert.equal(pinReleaseSnapshotStats().activeFiles, 1);
  assert.equal(sha256(Buffer.from(await reopened.arrayBuffer())), sha256(approved));
  await waitForSnapshotIdle("fresh request found a stale completed registry entry");
});

test("completed snapshots never cross verified source generations", async (t) => {
  const root = await createStore(t);
  const approved = Buffer.alloc(8 * 1024 * 1024, 0x69);
  const release = await publishRelease(root, {
    seed: "snapshot-generation-binding",
    current: false,
    bytesByRole: new Map([["installer", approved]]),
  });
  const source = artifactPath(release, "installer");
  const invoke = () => servePinReleaseArtifact(
    new Request(artifactUrl(release, "installer")),
    release.releaseId,
    "installer.apk",
    { environment: environment(root) },
  );
  const before = pinReleaseSnapshotStats();

  const oldGeneration = await invoke();
  assert.equal(oldGeneration.status, 200);
  assert.equal(pinReleaseSnapshotStats().created, before.created + 1);
  await overwriteSameInode(source, approved.length, 0x6a);

  const corrupt = await invoke();
  assert.equal(corrupt.status, 503);
  assert.equal(await corrupt.text(), '{"error":"Pin release unavailable."}');
  assert.equal(pinReleaseSnapshotStats().created, before.created + 1);
  assert.equal(pinReleaseSnapshotStats().activeFiles, 1);

  const replacement = path.join(release.releaseDirectory, "installer.approved-replacement");
  await writeFile(replacement, approved);
  await rename(replacement, source);
  const newGeneration = await invoke();
  assert.equal(newGeneration.status, 200);
  assert.equal(pinReleaseSnapshotStats().created, before.created + 2);
  assert.equal(pinReleaseSnapshotStats().activeFiles, 2);
  assert.equal(pinReleaseSnapshotStats().activeLeases, 2);

  // Releasing the older generation must remove only its own registry entry.
  assert.equal(sha256(Buffer.from(await oldGeneration.arrayBuffer())), sha256(approved));
  await waitForSnapshot(
    (stats) => stats.activeFiles === 1 && stats.activeLeases === 1,
    "old generation release removed or retained the wrong backing",
  );
  const newGenerationPeer = await invoke();
  assert.equal(newGenerationPeer.status, 200);
  assert.equal(pinReleaseSnapshotStats().created, before.created + 2);
  assert.equal(pinReleaseSnapshotStats().activeFiles, 1);
  assert.equal(sha256(Buffer.from(await newGenerationPeer.arrayBuffer())), sha256(approved));
  assert.equal(sha256(Buffer.from(await newGeneration.arrayBuffer())), sha256(approved));
  await waitForSnapshotIdle("source generation registry poisoned later capacity");
});

test("abort and slow-reader lifecycle close snapshots without truncation or leakage", async (t) => {
  const root = await createStore(t);
  const approved = Buffer.alloc(8 * 1024 * 1024, 0x71);
  const release = await publishRelease(root, {
    seed: "snapshot-stream-lifecycle",
    current: false,
    bytesByRole: new Map([["installer", approved]]),
  });
  const beforeDirectories = await snapshotDirectoryNames();

  const controller = new AbortController();
  const aborted = await servePinReleaseArtifact(
    new Request(artifactUrl(release, "installer"), { signal: controller.signal }),
    release.releaseId,
    "installer.apk",
    { environment: environment(root) },
  );
  assert.equal(aborted.status, 200);
  await waitForSnapshot((stats) => stats.activeLeases === 1, "abort fixture lost its lease");
  controller.abort();
  await assert.rejects(aborted.arrayBuffer(), /aborted/u);
  await waitForSnapshotIdle("aborted response retained its snapshot");

  const slow = await servePinReleaseArtifact(
    new Request(artifactUrl(release, "installer")),
    release.releaseId,
    "installer.apk",
    { environment: environment(root) },
  );
  const reader = slow.body.getReader();
  const chunks = [];
  const first = await reader.read();
  assert.equal(first.done, false);
  chunks.push(Buffer.from(first.value));
  await delay(10);
  assert.equal(pinReleaseSnapshotStats().activeFiles, 1, "slow reader released before completion");
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(Buffer.from(result.value));
  }
  const body = Buffer.concat(chunks);
  assert.equal(body.length, approved.length);
  assert.equal(sha256(body), sha256(approved));
  await waitForSnapshotIdle("slow response retained its completed snapshot");
  assert.deepEqual(await snapshotDirectoryNames(), beforeDirectories);
});

test("orphaned responses expire, recover the two-slot quota, and surface stream errors", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = await createStore(t);
  const twoMiB = 2 * 1024 * 1024;
  const release = await publishRelease(root, {
    seed: "snapshot-orphan-quota",
    current: false,
    bytesByRole: new Map([
      ["installer", Buffer.alloc(twoMiB, 0x81)],
      ["bootstrap", Buffer.alloc(twoMiB, 0x82)],
      ["hook", Buffer.alloc(twoMiB, 0x83)],
    ]),
  });
  const beforeDirectories = await snapshotDirectoryNames();
  const before = pinReleaseSnapshotStats();
  const requestRole = (role) => servePinReleaseArtifact(
    new Request(artifactUrl(release, role)),
    release.releaseId,
    `${role}.apk`,
    { environment: environment(root) },
  );

  const first = await requestRole("installer");
  const second = await requestRole("bootstrap");
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(pinReleaseSnapshotStats().activeFiles, 2);
  assert.equal(pinReleaseSnapshotStats().activeLeases, 2);

  const exhausted = await requestRole("hook");
  assert.equal(exhausted.status, 503);
  assert.equal(await exhausted.text(), '{"error":"Pin release unavailable."}');
  assert.equal(pinReleaseSnapshotStats().rejected, before.rejected + 1);

  t.mock.timers.tick(PIN_RELEASE_SNAPSHOT_IDLE_TIMEOUT_MS + 1);
  const recovered = await waitForSnapshotIdleWithMockedTimeouts(
    "orphan expiration did not release snapshot quota",
  );
  assert.equal(recovered.activeFiles, 0);
  assert.equal(recovered.activeLeases, 0);
  assert.equal(recovered.reservedBytes, 0);
  assert.equal(recovered.expiredLeases, before.expiredLeases + 2);
  await assert.rejects(first.arrayBuffer(), /lease expired/u);
  await assert.rejects(second.arrayBuffer(), /lease expired/u);

  const retried = await requestRole("hook");
  assert.equal(retried.status, 200);
  assert.equal(
    sha256(Buffer.from(await retried.arrayBuffer())),
    sha256(release.bytesByRole.get("hook")),
  );
  await waitForSnapshotIdleWithMockedTimeouts("retried response did not release snapshot quota");
  assert.deepEqual(await snapshotDirectoryNames(), beforeDirectories);
});

test("continuous progress cannot extend a snapshot beyond its hard lifetime", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = await createStore(t);
  const approved = Buffer.alloc(64 * 1024 * 1024, 0x91);
  const release = await publishRelease(root, {
    seed: "snapshot-hard-lifetime",
    current: false,
    bytesByRole: new Map([["installer", approved]]),
  });
  const before = pinReleaseSnapshotStats();
  const response = await servePinReleaseArtifact(
    new Request(artifactUrl(release, "installer")),
    release.releaseId,
    "installer.apk",
    { environment: environment(root) },
  );
  assert.equal(response.status, 200);
  const reader = response.body.getReader();

  const progressTicks = Math.floor(
    PIN_RELEASE_SNAPSHOT_MAX_LIFETIME_MS / PIN_RELEASE_SNAPSHOT_IDLE_TIMEOUT_MS,
  );
  for (let index = 0; index < progressTicks; index += 1) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, "fixture completed before the hard deadline");
    t.mock.timers.tick(PIN_RELEASE_SNAPSHOT_IDLE_TIMEOUT_MS - 1);
  }
  assert.equal(pinReleaseSnapshotStats().activeLeases, 1);
  assert.equal((await reader.read()).done, false);
  t.mock.timers.tick(progressTicks + 1);
  await assert.rejects(reader.read(), /lease expired/u);
  await waitForSnapshotIdleWithMockedTimeouts("hard deadline did not release snapshot quota");
  assert.equal(pinReleaseSnapshotStats().expiredLeases, before.expiredLeases + 1);
});

test("a fresh process cold direct download establishes one complete release verdict", async (t) => {
  const root = await createStore(t);
  const release = await publishRelease(root, { seed: "cold-complete", current: false });
  const result = coldArtifactRequest(root, release.releaseId, { requestCount: 8 });
  const expected = release.bytesByRole.get("installer");

  assert.equal(result.responses.length, 8);
  for (const response of result.responses) {
    assert.equal(response.status, 200);
    assert.equal(response.contentType, "application/vnd.android.package-archive");
    assert.equal(response.contentLength, String(expected.length));
    assert.deepEqual(Buffer.from(response.body, "base64"), expected);
  }
  assert.equal(result.stats.verifications, 1, "concurrent cold requests did not share one verdict");
  assert.equal(
    result.stats.hashedBytes,
    [...release.bytesByRole.values()].reduce((total, bytes) => total + bytes.length, 0),
    "a cold direct request did not hash the exact five-APK inventory",
  );
});

test("fresh-process cold direct GET, HEAD, and range fail closed on incomplete authority", async (t) => {
  const missingRoot = await createStore(t);
  const missing = await publishRelease(missingRoot, { seed: "cold-missing", current: false });
  await unlink(path.join(missing.releaseDirectory, missing.manifest.authority.name));
  assertColdArtifactFailures(coldArtifactRequest(missingRoot, missing.releaseId));

  const tamperedRoot = await createStore(t);
  const tampered = await publishRelease(tamperedRoot, { seed: "cold-tampered", current: false });
  await writeFile(
    path.join(tampered.releaseDirectory, tampered.manifest.authority.name),
    Buffer.alloc(tampered.manifest.authority.size, 0x41),
  );
  const head = coldArtifactRequest(tamperedRoot, tampered.releaseId, { method: "HEAD" });
  assertColdArtifactFailures(head);
  assert.equal(head.responses[0].body, null, "a failed cold HEAD exposed a response body");

  const malformedRoot = await createStore(t);
  const malformedOriginal = await publishRelease(malformedRoot, {
    seed: "cold-malformed",
    current: false,
  });
  const malformed = await rebindAuthoritySidecar(malformedOriginal, Buffer.from("{not-json\n"));
  assertColdArtifactFailures(coldArtifactRequest(malformedRoot, malformed.releaseId));

  const fakeRoot = await createStore(t);
  const fakeOriginal = await publishRelease(fakeRoot, { seed: "cold-fake", current: false });
  const authorityPath = path.join(
    fakeOriginal.releaseDirectory,
    fakeOriginal.manifest.authority.name,
  );
  const fakeEvidence = JSON.parse((await readFile(authorityPath)).toString("utf8"));
  fakeEvidence.payloads.policyBase64 = Buffer.from("[]\n").toString("base64");
  const fakeBytes = Buffer.from(canonicalJson(fakeEvidence));
  assert.equal(fakeBytes.length, fakeOriginal.manifest.authority.size);
  const fake = await rebindAuthoritySidecar(fakeOriginal, fakeBytes);
  const ranged = coldArtifactRequest(fakeRoot, fake.releaseId, { range: "bytes=0-3" });
  assertColdArtifactFailures(ranged);
  assert.notDeepEqual(
    Buffer.from(ranged.responses[0].body, "base64"),
    fake.bytesByRole.get("installer").subarray(0, 4),
    "a failed cold range exposed artifact bytes",
  );

  const inventoryRoot = await createStore(t);
  const wrongInventory = await publishRelease(inventoryRoot, {
    seed: "cold-four-apk",
    current: false,
  });
  const fourArtifactManifest = structuredClone(wrongInventory.manifest);
  fourArtifactManifest.artifacts.pop();
  await writeFile(
    path.join(wrongInventory.releaseDirectory, "manifest.json"),
    canonicalJson(fourArtifactManifest),
  );
  assertColdArtifactFailures(coldArtifactRequest(inventoryRoot, wrongInventory.releaseId));
});

test("concurrent corrupt cold requests share failure and never cache a partial verdict", async (t) => {
  const root = await createStore(t);
  const release = await publishRelease(root, { seed: "cold-race", current: false });
  await writeFile(
    path.join(release.releaseDirectory, release.manifest.authority.name),
    Buffer.alloc(release.manifest.authority.size, 0x42),
  );
  const result = coldArtifactRequest(root, release.releaseId, { requestCount: 12 });
  assertColdArtifactFailures(result, 12);
  assert.equal(
    result.stats.hashedBytes,
    [...release.bytesByRole.values()].reduce((total, bytes) => total + bytes.length, 0),
    "concurrent failed requests ran more than one cold five-APK sweep",
  );
});

test("same-size sidecar or non-requested APK tamper invalidates a direct-download cache", async (t) => {
  const sidecarRoot = await createStore(t);
  const sidecar = await publishRelease(sidecarRoot, { seed: "direct-sidecar", current: false });
  const sidecarUrl = `https://cosmos.example.test/api/pin/releases/${sidecar.releaseId}/installer.apk`;
  const firstSidecarResponse = await servePinReleaseArtifact(
    new Request(sidecarUrl),
    sidecar.releaseId,
    "installer.apk",
    { environment: environment(sidecarRoot) },
  );
  assert.equal(firstSidecarResponse.status, 200);
  assert.deepEqual(
    Buffer.from(await firstSidecarResponse.arrayBuffer()),
    sidecar.bytesByRole.get("installer"),
  );
  await writeFile(
    path.join(sidecar.releaseDirectory, sidecar.manifest.authority.name),
    Buffer.alloc(sidecar.manifest.authority.size, 0x43),
  );
  const invalidSidecar = await servePinReleaseArtifact(
    new Request(sidecarUrl),
    sidecar.releaseId,
    "installer.apk",
    { environment: environment(sidecarRoot) },
  );
  assert.equal(invalidSidecar.status, 503);
  assert.equal(await invalidSidecar.text(), '{"error":"Pin release unavailable."}');

  const artifactRoot = await createStore(t);
  const release = await publishRelease(artifactRoot, { seed: "direct-other-apk", current: false });
  const url = `https://cosmos.example.test/api/pin/releases/${release.releaseId}/installer.apk`;
  const first = await servePinReleaseArtifact(
    new Request(url),
    release.releaseId,
    "installer.apk",
    { environment: environment(artifactRoot) },
  );
  assert.equal(first.status, 200);
  await first.arrayBuffer();
  const server = release.manifest.artifacts.find((artifact) => artifact.role === "server");
  await writeFile(
    path.join(release.releaseDirectory, server.name),
    Buffer.alloc(server.size, 0x44),
  );
  const invalidArtifact = await servePinReleaseArtifact(
    new Request(url),
    release.releaseId,
    "installer.apk",
    { environment: environment(artifactRoot) },
  );
  assert.equal(invalidArtifact.status, 503);
  assert.equal(await invalidArtifact.text(), '{"error":"Pin release unavailable."}');
});

test("schema v2 rejects downgrade, unknown fields, unsafe names, identity drift, and role drift", async (t) => {
  const root = await createStore(t);
  const release = await publishRelease(root);
  const baseline = JSON.parse(release.document);
  const rejected = (mutate) => {
    const candidate = structuredClone(baseline);
    mutate(candidate);
    assert.throws(() => parsePinReleaseManifest(candidate), /Pin release unavailable/);
  };

  rejected((candidate) => {
    candidate.sample = true;
  });
  rejected((candidate) => {
    candidate.schemaVersion = 1;
  });
  rejected((candidate) => {
    delete candidate.authority.requestSha256;
  });
  rejected((candidate) => {
    candidate.authority.runnerEnvironment = "self-hosted";
  });
  rejected((candidate) => {
    candidate.version = "2026-02-30.1";
  });
  rejected((candidate) => {
    candidate.releaseId = candidate.releaseId.toUpperCase();
  });
  rejected((candidate) => {
    candidate.artifacts[0].debug = true;
  });
  rejected((candidate) => {
    candidate.artifacts[0].name = "../outside.apk";
  });
  rejected((candidate) => {
    candidate.artifacts[0].package = "com.example.substitute";
  });
  rejected((candidate) => {
    candidate.artifacts[0].url = `./${candidate.releaseId}/${candidate.artifacts[0].name}`;
  });
  rejected((candidate) => {
    candidate.artifacts[1].role = candidate.artifacts[0].role;
  });
  rejected((candidate) => {
    candidate.artifacts[1].versionCode += 1;
  });
  rejected((candidate) => {
    candidate.artifacts[0].size = 0;
  });
  rejected((candidate) => {
    candidate.artifacts[0].sha256 = candidate.artifacts[0].sha256.toUpperCase();
  });
  rejected((candidate) => {
    candidate.artifacts[0].sha256 = "0".repeat(64);
  });
});

test("corrupt or symlinked release state fails closed without leaking disk paths", async (t) => {
  const corruptRoot = await createStore(t);
  const corrupt = await publishRelease(corruptRoot);
  const installer = corrupt.manifest.artifacts.find((artifact) => artifact.role === "installer");
  await writeFile(path.join(corrupt.releaseDirectory, installer.name), "changed-after-publish");

  const corruptResponse = await servePinReleaseArtifact(
    new Request(
      `https://cosmos.example.test/api/pin/releases/${corrupt.releaseId}/installer.apk`,
    ),
    corrupt.releaseId,
    "installer.apk",
    { environment: environment(corruptRoot) },
  );
  assert.equal(corruptResponse.status, 503);
  assert.equal(await corruptResponse.text(), '{"error":"Pin release unavailable."}');
  assert.equal((await serveCurrentPinRelease(
    new Request("https://cosmos.example.test/api/pin/releases/current"),
    { environment: environment(corruptRoot) },
  )).status, 503);

  const symlinkRoot = await createStore(t);
  const symlinked = await publishRelease(symlinkRoot, { seed: "symlink" });
  const linkedArtifact = symlinked.manifest.artifacts[0];
  const outside = path.join(path.dirname(symlinkRoot), `outside-${symlinked.releaseId}.apk`);
  t.after(() => rm(outside, { force: true }));
  await writeFile(outside, symlinked.bytesByRole.get(linkedArtifact.role));
  await unlink(path.join(symlinked.releaseDirectory, linkedArtifact.name));
  await symlink(outside, path.join(symlinked.releaseDirectory, linkedArtifact.name));
  const symlinkResponse = await servePinReleaseArtifact(
    new Request(
      `https://cosmos.example.test/api/pin/releases/${symlinked.releaseId}/installer.apk`,
    ),
    symlinked.releaseId,
    "installer.apk",
    { environment: environment(symlinkRoot) },
  );
  assert.equal(symlinkResponse.status, 503);
  assert.doesNotMatch(await symlinkResponse.text(), new RegExp(symlinkRoot.replaceAll("/", "\\/")));

  await unlink(path.join(symlinkRoot, "current.json"));
  await symlink(
    path.join(symlinked.releaseDirectory, "manifest.json"),
    path.join(symlinkRoot, "current.json"),
  );
  assert.equal((await serveCurrentPinRelease(
    new Request("https://cosmos.example.test/api/pin/releases/current"),
    { environment: environment(symlinkRoot) },
  )).status, 503);
});

test("missing or same-size-tampered hosted authority fails closed and invalidates the cache", async (t) => {
  const tamperRoot = await createStore(t);
  const release = await publishRelease(tamperRoot, { seed: "authority-tamper" });
  const request = () => serveCurrentPinRelease(
    new Request("https://cosmos.example.test/api/pin/releases/current"),
    { environment: environment(tamperRoot) },
  );
  assert.equal((await request()).status, 200);
  const authorityPath = path.join(release.releaseDirectory, release.manifest.authority.name);
  await writeFile(authorityPath, Buffer.alloc(release.manifest.authority.size, 0x41));
  const tampered = await request();
  assert.equal(tampered.status, 503);
  assert.equal(await tampered.text(), '{"error":"Pin release unavailable."}');
  // A stale cached verdict would have returned 200 here. The counter records
  // only completed sweeps, so the failed authority hash is intentionally not
  // included in `hashedBytes`.

  const missingRoot = await createStore(t);
  const missing = await publishRelease(missingRoot, { seed: "authority-missing" });
  await unlink(path.join(missing.releaseDirectory, missing.manifest.authority.name));
  const absent = await serveCurrentPinRelease(
    new Request("https://cosmos.example.test/api/pin/releases/current"),
    { environment: environment(missingRoot) },
  );
  assert.equal(absent.status, 503);
  assert.equal(await absent.text(), '{"error":"Pin release unavailable."}');
});

test("hosted authority payloads reject non-record, inexact, non-string, and digest-unbound input", async (t) => {
  const mutations = [
    ["null payload map", (evidence) => { evidence.payloads = null; }],
    ["array payload map", (evidence) => { evidence.payloads = []; }],
    ["missing payload", (evidence) => { delete evidence.payloads.policyBase64; }],
    ["unknown payload", (evidence) => { evidence.payloads.unknownBase64 = "e30K"; }],
    ["non-string payload", (evidence) => { evidence.payloads.policyBase64 = false; }],
    ["digest-unbound payload", (evidence) => {
      evidence.payloads.policyBase64 = Buffer.from(canonicalJson({ tampered: true })).toString("base64");
    }],
  ];

  for (const [index, [name, mutateEvidence]] of mutations.entries()) {
    const root = await createStore(t);
    await publishRelease(root, { seed: `payload-tamper-${index}`, mutateEvidence });
    const response = await serveCurrentPinRelease(
      new Request("https://cosmos.example.test/api/pin/releases/current"),
      { environment: environment(root) },
    );
    assert.equal(response.status, 503, name);
    assert.equal(await response.text(), '{"error":"Pin release unavailable."}', name);
  }
});

test("unconfigured stores and malformed immutable paths return bounded 404 responses", async (t) => {
  const absent = await serveCurrentPinRelease(
    new Request("https://cosmos.example.test/api/pin/releases/current"),
    { environment: {} },
  );
  assert.equal(absent.status, 404);
  assert.equal(await absent.text(), '{"error":"Pin release not found."}');

  const emptyRoot = await createStore(t);
  assert.equal((await serveCurrentPinRelease(
    new Request("https://cosmos.example.test/api/pin/releases/current"),
    { environment: environment(emptyRoot) },
  )).status, 404);

  for (const [releaseId, asset] of [
    ["../current.json", "installer.apk"],
    ["a".repeat(64), "../installer.apk"],
    ["a".repeat(64), "unknown.apk"],
  ]) {
    const response = await servePinReleaseArtifact(
      new Request("https://cosmos.example.test/api/pin/releases/bad/unknown.apk"),
      releaseId,
      asset,
      { environment: environment(emptyRoot) },
    );
    assert.equal(response.status, 404);
    assert.ok(Number(response.headers.get("content-length")) < 128);
  }
});

/*
 * The public release surface must not be a hashing service.
 *
 * `/api/pin/releases/current` is reachable with no session (middleware lets
 * `isPublicPinReleaseRequest` through), is `force-dynamic`, and used to
 * stream-SHA256 every artifact in the store on every GET — with a 202 MB
 * server.apk published that is hundreds of megabytes of disk read per anonymous
 * request, on the box that also serves the dashboard.
 *
 * The fix may not become "stop verifying". These two tests are a pair and only
 * mean anything together: the sweep runs once for a given set of files, AND any
 * change to those files re-runs it before the manifest is served again.
 */
test("a verified release is not re-hashed on every public request", async (t) => {
  const root = await createStore(t);
  const release = await publishRelease(root, { seed: "cached" });
  const request = () =>
    serveCurrentPinRelease(
      new Request("https://cosmos.example.test/api/pin/releases/current"),
      { environment: environment(root) },
    );

  const before = pinReleaseVerificationStats();
  assert.equal((await request()).status, 200);
  const verified = pinReleaseVerificationStats();
  assert.equal(verified.verifications, before.verifications + 1);
  assert.ok(
    verified.hashedBytes > before.hashedBytes,
    "the first load must hash the artifacts it vouches for",
  );

  const second = await request();
  assert.equal(second.status, 200);
  assert.equal(await second.text(), release.document);
  assert.deepEqual(
    pinReleaseVerificationStats(),
    verified,
    "a second GET re-hashed the whole store; an anonymous client can force that at will",
  );

  // The artifact download reuses the same verdict — it is the same file, proven
  // by the same identity — so a 202 MB APK costs one stream, not a stream plus a
  // full re-hash.
  const installer = release.manifest.artifacts.find((artifact) => artifact.role === "installer");
  const download = await servePinReleaseArtifact(
    new Request(`https://cosmos.example.test/api/pin/releases/${release.releaseId}/installer.apk`),
    release.releaseId,
    "installer.apk",
    { environment: environment(root) },
  );
  assert.equal(download.status, 200);
  assert.deepEqual(
    Buffer.from(await download.arrayBuffer()),
    release.bytesByRole.get("installer"),
  );
  assert.deepEqual(pinReleaseVerificationStats(), verified);

  // Same length, different bytes: nothing about the manifest changes, so only
  // the stat identity can catch this. If the cache ever keys on the path alone,
  // this is the assertion that fails.
  await writeFile(
    path.join(release.releaseDirectory, installer.name),
    Buffer.alloc(installer.size, 0x41),
  );
  const tampered = await request();
  assert.equal(tampered.status, 503);
  assert.equal(await tampered.text(), '{"error":"Pin release unavailable."}');
  assert.ok(
    pinReleaseVerificationStats().hashedBytes > verified.hashedBytes,
    "a changed artifact must be re-hashed, not served from a stale verdict",
  );
});

test("one opaque sentence on the wire, one distinct reason in the log", async (t) => {
  const root = await createStore(t);
  const release = await publishRelease(root, { seed: "reasons" });
  const installer = release.manifest.artifacts.find((artifact) => artifact.role === "installer");
  await writeFile(path.join(release.releaseDirectory, installer.name), "changed-after-publish");

  // Read through the log module's own sink rather than by stubbing `console`:
  // `console` is not how this code reports any more, precisely because nothing
  // could prove it arrived. verify/server-logging.test.mjs proves the default
  // sink puts these same lines on the process's stderr.
  const warnings = [];
  setLogSinkForTests((level, line) => warnings.push(`${level} ${line.trimEnd()}`));
  let unconfigured;
  let corrupt;
  try {
    unconfigured = await serveCurrentPinRelease(
      new Request("https://cosmos.example.test/api/pin/releases/current"),
      { environment: {} },
    );
    corrupt = await serveCurrentPinRelease(
      new Request("https://cosmos.example.test/api/pin/releases/current"),
      { environment: environment(root) },
    );
  } finally {
    setLogSinkForTests(null);
  }

  // The wire answer stays exactly what it was: this route is unauthenticated and
  // must not narrate the store's internals to the internet.
  assert.equal(unconfigured.status, 404);
  assert.equal(await unconfigured.text(), '{"error":"Pin release not found."}');
  assert.equal(corrupt.status, 503);
  assert.equal(await corrupt.text(), '{"error":"Pin release unavailable."}');

  // …and the operator gets the two causes apart. Both used to be one sentence
  // with no log line at all: ~57 causes, one answer, empty container logs.
  assert.equal(warnings.length, 2, warnings.join("\n"));
  assert.match(warnings[0], /release_dir_unset/);
  assert.match(warnings[1], /artifact_(size_mismatch|sha256_mismatch)/);
  assert.notEqual(warnings[0], warnings[1]);
  for (const warning of warnings) {
    assert.doesNotMatch(warning, new RegExp(root.replaceAll("/", "\\/")));
  }
});

test("CORS is absent by default and exact for one configured Setup origin", async (t) => {
  const root = await createStore(t);
  await publishRelease(root);
  const setupOrigin = "https://setup.example.test";
  const allowedEnvironment = environment(root, setupOrigin);
  const allowed = await serveCurrentPinRelease(
    new Request("https://cosmos.example.test/api/pin/releases/current", {
      headers: { origin: setupOrigin },
    }),
    { environment: allowedEnvironment },
  );
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), setupOrigin);
  assert.equal(
    allowed.headers.get("access-control-expose-headers"),
    "Content-Length, Content-Type",
  );
  assert.notEqual(allowed.headers.get("access-control-allow-origin"), "*");

  const sameOrigin = await serveCurrentPinRelease(
    new Request("https://cosmos.example.test/api/pin/releases/current", {
      headers: { origin: "https://cosmos.example.test" },
    }),
    { environment: allowedEnvironment },
  );
  assert.equal(sameOrigin.status, 200);

  const rejected = await serveCurrentPinRelease(
    new Request("https://cosmos.example.test/api/pin/releases/current", {
      headers: { origin: "https://attacker.example" },
    }),
    { environment: allowedEnvironment },
  );
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.has("access-control-allow-origin"), false);

  const preflight = servePinReleaseOptions(
    new Request("https://cosmos.example.test/api/pin/releases/current", {
      method: "OPTIONS",
      headers: {
        origin: setupOrigin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "Accept",
      },
    }),
    allowedEnvironment,
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), setupOrigin);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
  assert.equal(preflight.headers.get("access-control-allow-headers"), "Accept");

  const mutationPreflight = servePinReleaseOptions(
    new Request("https://cosmos.example.test/api/pin/releases/current", {
      method: "OPTIONS",
      headers: {
        origin: setupOrigin,
        "access-control-request-method": "POST",
      },
    }),
    allowedEnvironment,
  );
  assert.equal(mutationPreflight.status, 403);

  const wildcard = await serveCurrentPinRelease(
    new Request("https://cosmos.example.test/api/pin/releases/current"),
    { environment: environment(root, "*") },
  );
  assert.equal(wildcard.status, 503);
  assert.equal(wildcard.headers.has("access-control-allow-origin"), false);
});
