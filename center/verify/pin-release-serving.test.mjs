import "./tsResolve.mjs";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { cp, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

const {
  PIN_RELEASE_PACKAGE_BY_ROLE,
  PIN_RELEASE_ROLES,
  computePinReleaseId,
  parsePinReleaseManifest,
  serializePinReleaseManifest,
  serveCurrentPinRelease,
  servePinReleaseArtifact,
  servePinReleaseOptions,
} = await import("../src/server/pin-releases.ts?pin-release-serving-test");

const { setLogSinkForTests } = await import("../src/server/log.ts");
setLogSinkForTests(() => undefined);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
let storeSequence = 0;

async function createStore(context, {
  seed = `current-${storeSequence += 1}`,
  version = "2026-08-23.1",
  versionCode = 202_608_231,
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "revival-pin-releases-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const bytesByRole = new Map(PIN_RELEASE_ROLES.map((role) => [
    role,
    Buffer.from(`${seed}-${role}-apk`),
  ]));
  const identities = PIN_RELEASE_ROLES.map((role) => {
    const bytes = bytesByRole.get(role);
    return {
      role,
      name: `${role}.apk`,
      package: PIN_RELEASE_PACKAGE_BY_ROLE[role],
      versionCode,
      size: bytes.length,
      sha256: sha256(bytes),
    };
  });
  const releaseId = computePinReleaseId({
    schemaVersion: 1,
    version,
    artifacts: identities,
  });
  const manifest = {
    schemaVersion: 1,
    releaseId,
    version,
    artifacts: identities.map((artifact) => ({
      ...artifact,
      url: `./${releaseId}/${artifact.role}.apk`,
    })),
  };
  const document = serializePinReleaseManifest(manifest);
  const releaseDirectory = path.join(root, "releases", releaseId);
  await mkdir(releaseDirectory, { recursive: true });
  await Promise.all(manifest.artifacts.map((artifact) =>
    writeFile(path.join(releaseDirectory, artifact.name), bytesByRole.get(artifact.role)),
  ));
  await writeFile(path.join(releaseDirectory, "manifest.json"), document);
  await writeFile(path.join(root, "current.json"), document);
  return { root, releaseDirectory, releaseId, manifest, document, bytesByRole };
}

const environment = (root, setupOrigin) => ({
  REVIVAL_PIN_RELEASE_DIR: root,
  ...(setupOrigin ? { REVIVAL_PIN_SETUP_ORIGIN: setupOrigin } : {}),
});

test("schema v1 binds the exact five APK identities", async (t) => {
  const release = await createStore(t);
  assert.deepEqual(parsePinReleaseManifest(JSON.parse(release.document)), release.manifest);
  assert.equal(serializePinReleaseManifest(release.manifest), release.document);

  for (const mutate of [
    (value) => { value.schemaVersion = 2; },
    (value) => { value.extra = true; },
    (value) => { value.artifacts.pop(); },
    (value) => { value.artifacts[0].package = "com.example.wrong"; },
    (value) => { value.artifacts[0].url = "https://example.test/installer.apk"; },
    (value) => { value.artifacts[0].sha256 = "0".repeat(64); },
  ]) {
    const changed = JSON.parse(release.document);
    mutate(changed);
    assert.throws(() => parsePinReleaseManifest(changed), /Pin release unavailable/);
  }
});

test("artifact names must match their roles", async (t) => {
  const release = await createStore(t);
  const changed = structuredClone(release.manifest);
  changed.artifacts[1].name = "branded-bootstrap.apk";
  changed.releaseId = computePinReleaseId(changed);
  changed.artifacts = changed.artifacts.map((artifact) => ({
    ...artifact,
    url: `./${changed.releaseId}/${artifact.role}.apk`,
  }));
  const document = `${JSON.stringify(changed)}\n`;
  assert.throws(() => parsePinReleaseManifest(changed), /Pin release unavailable/);
  await writeFile(path.join(release.root, "current.json"), document);

  const response = await serveCurrentPinRelease(
    new Request("https://center.example.test/api/pin/releases/current"),
    { environment: environment(release.root) },
  );
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '{"error":"Pin release unavailable."}');
});

test("current manifest supports GET and HEAD", async (t) => {
  const release = await createStore(t);
  const options = { environment: environment(release.root) };
  const request = new Request("https://center.example.test/api/pin/releases/current");

  const get = await serveCurrentPinRelease(request, options);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(await get.text(), release.document);

  const head = await serveCurrentPinRelease(request, { ...options, head: true });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(Number(head.headers.get("content-length")), Buffer.byteLength(release.document));
});

test("artifact endpoint serves complete, head, and byte-range responses", async (t) => {
  const release = await createStore(t);
  const base = `https://center.example.test/api/pin/releases/${release.releaseId}/installer.apk`;
  const options = { environment: environment(release.root) };
  const expected = release.bytesByRole.get("installer");

  const get = await servePinReleaseArtifact(new Request(base), release.releaseId, "installer.apk", options);
  assert.equal(get.status, 200);
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), expected);

  const head = await servePinReleaseArtifact(
    new Request(base, { method: "HEAD" }),
    release.releaseId,
    "installer.apk",
    { ...options, head: true },
  );
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get("content-length")), expected.length);

  const range = await servePinReleaseArtifact(
    new Request(base, { headers: { range: "bytes=1-4" } }),
    release.releaseId,
    "installer.apk",
    options,
  );
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), `bytes 1-4/${expected.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), expected.subarray(1, 5));
});

test("a same-size artifact rewrite with restored mtime invalidates the verified cache", async (t) => {
  const release = await createStore(t);
  const server = release.manifest.artifacts.find((artifact) => artifact.role === "server");
  const filename = path.join(release.releaseDirectory, server.name);
  const fixedTime = new Date("2030-01-01T00:00:00.000Z");
  await utimes(filename, fixedTime, fixedTime);
  const fixedMtime = (await stat(filename)).mtimeMs;
  const request = new Request("https://center.example.test/api/pin/releases/current");
  const options = { environment: environment(release.root) };
  assert.equal((await serveCurrentPinRelease(request, options)).status, 200);
  await writeFile(filename, Buffer.alloc(server.size, 0x41));
  await utimes(filename, fixedTime, fixedTime);
  assert.equal((await stat(filename)).mtimeMs, fixedMtime);
  assert.equal((await serveCurrentPinRelease(request, options)).status, 503);
  await writeFile(filename, release.bytesByRole.get("server"));
  await utimes(filename, fixedTime, fixedTime);
  assert.equal((await stat(filename)).mtimeMs, fixedMtime);
  assert.equal((await serveCurrentPinRelease(request, options)).status, 200);
});

test("a failed verification is not cached", async (t) => {
  const release = await createStore(t);
  const server = release.manifest.artifacts.find((artifact) => artifact.role === "server");
  const filename = path.join(release.releaseDirectory, server.name);
  await writeFile(filename, Buffer.alloc(server.size, 0x41));
  const fixedTime = new Date("2031-01-01T00:00:00.000Z");
  await utimes(filename, fixedTime, fixedTime);
  const failedMtime = (await stat(filename)).mtimeMs;
  const request = new Request("https://center.example.test/api/pin/releases/current");
  const options = { environment: environment(release.root) };
  assert.equal((await serveCurrentPinRelease(request, options)).status, 503);
  await writeFile(filename, release.bytesByRole.get("server"));
  await utimes(filename, fixedTime, fixedTime);
  assert.equal((await stat(filename)).mtimeMs, failedMtime);
  assert.equal((await serveCurrentPinRelease(request, options)).status, 200);
});

test("three active roots do not evict a duplicate in-flight verification", async (t) => {
  const releases = await Promise.all([
    createStore(t, { seed: "active-root-one" }),
    createStore(t, { seed: "active-root-two" }),
    createStore(t, { seed: "active-root-three" }),
  ]);
  const originalCreateReadStream = fs.createReadStream;
  let openStreams;
  const streamsMayOpen = new Promise((resolve) => { openStreams = resolve; });
  const opened = new Map();
  fs.createReadStream = (...args) => {
    const filename = String(args[0]);
    opened.set(filename, (opened.get(filename) ?? 0) + 1);
    const blocked = new PassThrough();
    streamsMayOpen.then(
      () => originalCreateReadStream(...args).pipe(blocked),
      (error) => blocked.destroy(error),
    );
    return blocked;
  };
  syncBuiltinESMExports();

  try {
    const request = () => new Request("https://center.example.test/api/pin/releases/current");
    const pending = releases.map((release) => serveCurrentPinRelease(request(), {
      environment: environment(release.root),
    }));
    for (let attempt = 0; opened.size < PIN_RELEASE_ROLES.length * 3 && attempt < 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(opened.size, PIN_RELEASE_ROLES.length * 3);

    const duplicate = serveCurrentPinRelease(request(), {
      environment: environment(releases[0].root),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      [...opened.values()].reduce((total, count) => total + count, 0),
      PIN_RELEASE_ROLES.length * 3,
    );
    openStreams();
    const responses = await Promise.all([...pending, duplicate]);
    assert.deepEqual(responses.map(({ status }) => status), [200, 200, 200, 200]);
  } finally {
    openStreams();
    fs.createReadStream = originalCreateReadStream;
    syncBuiltinESMExports();
  }
});

test("identical releases in different roots keep their own verified paths", async (t) => {
  const first = await createStore(t, { seed: "shared-root-release" });
  const second = await createStore(t, { seed: "shared-root-release" });
  assert.equal(first.releaseId, second.releaseId);
  assert.equal((await serveCurrentPinRelease(
    new Request("https://center.example.test/api/pin/releases/current"),
    { environment: environment(first.root) },
  )).status, 200);
  await rm(first.root, { recursive: true, force: true });

  const response = await servePinReleaseArtifact(
    new Request(`https://center.example.test/api/pin/releases/${second.releaseId}/installer.apk`),
    second.releaseId,
    "installer.apk",
    { environment: environment(second.root) },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    second.bytesByRole.get("installer"),
  );
});

test("current and previous releases remain available while requests alternate", async (t) => {
  const previous = await createStore(t, {
    seed: "alternating-previous",
    version: "2026-08-23.1",
    versionCode: 202_608_231,
  });
  const current = await createStore(t, {
    seed: "alternating-current",
    version: "2026-08-23.2",
    versionCode: 202_608_232,
  });
  await cp(
    previous.releaseDirectory,
    path.join(current.root, "releases", previous.releaseId),
    { recursive: true },
  );
  const options = { environment: environment(current.root) };
  const previousUrl = `https://center.example.test/api/pin/releases/${previous.releaseId}/server.apk`;
  const first = await servePinReleaseArtifact(
    new Request(previousUrl), previous.releaseId, "server.apk", options,
  );
  assert.equal(first.status, 200);
  await first.arrayBuffer();
  assert.equal((await serveCurrentPinRelease(
    new Request("https://center.example.test/api/pin/releases/current"), options,
  )).status, 200);

  const cached = await servePinReleaseArtifact(
    new Request(previousUrl), previous.releaseId, "server.apk", options,
  );
  assert.equal(cached.status, 200);
  assert.deepEqual(
    Buffer.from(await cached.arrayBuffer()),
    previous.bytesByRole.get("server"),
  );
});

test("missing or changed APKs are rejected", async (t) => {
  const release = await createStore(t, { seed: "tampered" });
  const installer = release.manifest.artifacts.find((artifact) => artifact.role === "installer");
  await writeFile(path.join(release.releaseDirectory, installer.name), Buffer.alloc(installer.size, 0x41));

  const response = await servePinReleaseArtifact(
    new Request(`https://center.example.test/api/pin/releases/${release.releaseId}/installer.apk`),
    release.releaseId,
    "installer.apk",
    { environment: environment(release.root) },
  );
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '{"error":"Pin release unavailable."}');
});

test("CORS preflight allows only the configured Setup origin", async () => {
  const configured = "https://setup.example.test";
  const allowed = servePinReleaseOptions(
    new Request("https://center.example.test/api/pin/releases/current", {
      method: "OPTIONS",
      headers: {
        origin: configured,
        "access-control-request-method": "GET",
        "access-control-request-headers": "Accept",
      },
    }),
    environment("/unused", configured),
  );
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), configured);

  const rejected = servePinReleaseOptions(
    new Request("https://center.example.test/api/pin/releases/current", {
      method: "OPTIONS",
      headers: { origin: "https://wrong.example.test" },
    }),
    environment("/unused", configured),
  );
  assert.equal(rejected.status, 403);
});
