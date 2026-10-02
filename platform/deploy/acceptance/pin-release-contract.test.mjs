import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PIN_RELEASE_ARTIFACT_ROLES,
  PIN_RELEASE_PACKAGE_BY_ROLE,
  PinReleaseContractError,
  canonicalPinReleaseManifestJson,
  createPinReleaseManifest,
  parseCanonicalPinReleaseManifestDocument,
  parsePinReleaseJson,
  parsePinReleaseReceiptBundle,
  verifyPinReleaseMetadata,
} from "../pin/release.mjs";

const SIGNER = "a".repeat(64);
const OTHER_SIGNER = "b".repeat(64);

function releaseFixture({
  version = "2026-08-09.1",
  versionCode = 202_608_091,
  signer = SIGNER,
} = {}) {
  const artifacts = PIN_RELEASE_ARTIFACT_ROLES.map((role) => {
    const bytes = Buffer.from(`signed-apk:${role}:${version}:${versionCode}`);
    return {
      role,
      path: `${role}.apk`,
      name: `${role}.apk`,
      package: PIN_RELEASE_PACKAGE_BY_ROLE[role],
      versionName: version,
      versionCode,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      signerSha256: signer,
    };
  });
  const receipts = parsePinReleaseReceiptBundle({ schemaVersion: 1, artifacts });
  return {
    receipts,
    manifest: createPinReleaseManifest({ version, receipts }),
  };
}

function throwsCode(callback, code) {
  assert.throws(
    callback,
    (error) => error instanceof PinReleaseContractError && error.code === code,
  );
}

test("one canonical manifest binds the exact five-APK set", () => {
  const release = releaseFixture();
  assert.deepEqual(
    release.manifest.artifacts.map((artifact) => artifact.role),
    PIN_RELEASE_ARTIFACT_ROLES,
  );
  for (const artifact of release.manifest.artifacts) {
    assert.equal(artifact.url, `./${release.manifest.releaseId}/${artifact.role}.apk`);
  }

  const canonical = canonicalPinReleaseManifestJson(release.manifest);
  assert.equal(parseCanonicalPinReleaseManifestDocument(canonical).releaseId, release.manifest.releaseId);
  throwsCode(
    () => parseCanonicalPinReleaseManifestDocument(JSON.stringify(release.manifest, null, 2)),
    "manifest-noncanonical",
  );
});

test("release metadata rejects partial, duplicate, escaped, and mismatched APK sets", () => {
  const release = releaseFixture();

  const partial = structuredClone(release.receipts);
  partial.artifacts.pop();
  throwsCode(() => parsePinReleaseReceiptBundle(partial), "partial-bundle");

  const duplicate = structuredClone(release.receipts);
  duplicate.artifacts[4] = { ...duplicate.artifacts[0] };
  throwsCode(() => parsePinReleaseReceiptBundle(duplicate), "duplicate-role");

  const escaped = structuredClone(release.receipts);
  escaped.artifacts[0].path = "../installer.apk";
  throwsCode(() => parsePinReleaseReceiptBundle(escaped), "unsafe-path");

  throwsCode(
    () => verifyPinReleaseMetadata({ ...release, expectedSigner: OTHER_SIGNER }),
    "signer-mismatch",
  );
  const wrongPackage = structuredClone(release.receipts);
  wrongPackage.artifacts[0].package = "invalid.package";
  throwsCode(() => parsePinReleaseReceiptBundle(wrongPackage), "package-mismatch");
});

test("manifest and receipt artifacts require canonical role APK names", () => {
  const release = releaseFixture();
  const receipts = structuredClone(release.receipts);
  receipts.artifacts[1].path = `nested/${receipts.artifacts[0].name}`;
  receipts.artifacts[1].name = receipts.artifacts[0].name;
  throwsCode(() => parsePinReleaseReceiptBundle(receipts), "name-mismatch");

  const manifest = structuredClone(release.manifest);
  manifest.artifacts[1].name = manifest.artifacts[0].name;
  throwsCode(() => canonicalPinReleaseManifestJson(manifest), "name-mismatch");
});

test("JSON errors and Setup manifest fields stay explicit", async () => {
  throwsCode(() => parsePinReleaseJson('{"schemaVersion":'), "invalid-json");
  const schema = JSON.parse(
    await readFile(new URL("../../../contracts/pin-releases.schema.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(
    schema.$defs.setupManifest.required,
    ["schemaVersion", "releaseId", "version", "artifacts"],
  );
  assert.deepEqual(
    schema.$defs.setupArtifact.required,
    ["role", "url", "name", "package", "versionCode", "size", "sha256"],
  );
  assert.equal(schema.$defs.setupManifest.additionalProperties, false);
  assert.equal(schema.$defs.setupArtifact.additionalProperties, false);
});
