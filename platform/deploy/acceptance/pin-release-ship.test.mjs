import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PIN_RELEASE_ARTIFACT_ROLES,
  PIN_RELEASE_PACKAGE_BY_ROLE,
  canonicalPinReleaseManifestJson,
  createPinReleaseManifest,
  parsePinReleaseHistory,
  parsePinReleaseReceiptBundle,
  verifyPinReleaseMetadata,
} from "../pin/release.mjs";
import { PIN_COMPATIBILITY_CERT_SHA256 } from "../pin/build.mjs";
import {
  createLocalTransport,
  createPinReleaseShipPlan,
  readLocalPinReleaseStore,
  shipPinRelease,
  validateRemoteRoot,
} from "../pin/ship.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function releaseStore(parent, version = "2026-08-23.1", versionCode = 202_608_231) {
  const root = join(parent, `store-${versionCode}`);
  const artifacts = [];
  const bytesByName = new Map();
  for (const [index, role] of PIN_RELEASE_ARTIFACT_ROLES.entries()) {
    const bytes = Buffer.from(`${role}-${version}-${versionCode}-${index}`);
    const name = `${role}.apk`;
    bytesByName.set(name, bytes);
    artifacts.push({
      role,
      path: name,
      name,
      package: PIN_RELEASE_PACKAGE_BY_ROLE[role],
      versionName: version,
      versionCode,
      size: bytes.length,
      sha256: sha256(bytes),
      signerSha256: PIN_COMPATIBILITY_CERT_SHA256,
    });
  }
  const receipts = parsePinReleaseReceiptBundle({ schemaVersion: 1, artifacts });
  const manifest = createPinReleaseManifest({ version, receipts });
  const canonical = canonicalPinReleaseManifestJson(manifest);
  const verified = verifyPinReleaseMetadata({
    manifest,
    receipts,
    expectedSigner: PIN_COMPATIBILITY_CERT_SHA256,
    history: parsePinReleaseHistory({ schemaVersion: 1, releases: [] }),
  });
  const releaseDirectory = join(root, "releases", manifest.releaseId);
  await mkdir(releaseDirectory, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of bytesByName) await writeFile(join(releaseDirectory, name), bytes);
  await writeFile(join(releaseDirectory, "manifest.json"), canonical);
  await writeFile(join(root, "current.json"), canonical);
  await writeFile(join(root, "history.json"), `${JSON.stringify({
    schemaVersion: 1,
    releases: [verified.historyEntry],
  })}\n`);
  return { root, manifest, releaseDirectory };
}

test("local release reader verifies the complete five-APK store", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "revival-ship-read-"));
  const fixture = await releaseStore(temporary);
  const store = await readLocalPinReleaseStore({ root: fixture.root });
  assert.equal(store.manifest.releaseId, fixture.manifest.releaseId);
  assert.deepEqual(store.manifest.artifacts.map((artifact) => artifact.role), PIN_RELEASE_ARTIFACT_ROLES);
  assert.equal(store.entries.size, 6);
});

test("ship plans without writing, applies locally, and is idempotent", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "revival-ship-local-"));
  const source = await releaseStore(temporary);
  const target = join(temporary, "served");
  const transport = createLocalTransport();
  const plan = await shipPinRelease({
    releaseRoot: source.root,
    remoteRoot: target,
    transport,
  });
  assert.equal(plan.applied, false);
  assert.equal(plan.unchanged, false);
  assert.equal(plan.uploads.length, 8);
  await assert.rejects(readFile(join(target, "current.json")), /ENOENT/u);

  const applied = await shipPinRelease({
    releaseRoot: source.root,
    remoteRoot: target,
    transport,
    confirm: true,
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.unchanged, false);
  const copied = await readLocalPinReleaseStore({ root: target });
  assert.equal(copied.manifest.releaseId, source.manifest.releaseId);

  const again = await shipPinRelease({
    releaseRoot: source.root,
    remoteRoot: target,
    transport,
    confirm: true,
  });
  assert.equal(again.unchanged, true);
  assert.equal(again.uploads.length, 0);
});

test("ship plan is a small content comparison", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "revival-ship-plan-"));
  const first = await releaseStore(temporary, "2026-08-23.1", 202_608_231);
  const second = await releaseStore(temporary, "2026-08-23.2", 202_608_232);
  const local = await readLocalPinReleaseStore({ root: second.root });
  const remote = await readLocalPinReleaseStore({ root: first.root });
  const plan = createPinReleaseShipPlan({ local, remote });
  assert.equal(plan.unchanged, false);
  assert.equal(plan.releaseId, second.manifest.releaseId);
  assert.ok(plan.uploadBytes > 0);
});

test("tampered APKs and unsafe remote paths are rejected", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "revival-ship-tamper-"));
  const fixture = await releaseStore(temporary);
  await writeFile(join(fixture.releaseDirectory, "server.apk"), "tampered");
  await assert.rejects(
    readLocalPinReleaseStore({ root: fixture.root }),
    /server APK differs/u,
  );
  assert.throws(() => validateRemoteRoot("relative/path"), /unsafe remote/u);
  assert.throws(() => validateRemoteRoot("/safe/../escape"), /unsafe remote/u);
  assert.equal(validateRemoteRoot("/home/anders/ai-pin-revival/data/pin-releases"),
    "/home/anders/ai-pin-revival/data/pin-releases");
});
