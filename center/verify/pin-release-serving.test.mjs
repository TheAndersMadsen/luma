import "./tsResolve.mjs";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

async function createStore(context, {
  seed = "current",
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
      name: `AiPinRevival-${role}-${version}.apk`,
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
