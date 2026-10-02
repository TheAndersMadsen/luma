import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createReleaseDescriptor,
  IMAGE_NAMES,
  IMAGE_PLATFORMS,
} from "../../distribution/release-descriptor.mjs";
import {
  assertListedBytes,
  fetchPublishedReleaseAsset,
  parseReleaseChecksums,
  publishedReleaseProofUrls,
  readReleaseSigningPublicKey,
  RELEASE_CHECKSUMS_NAME,
  RELEASE_PROOF_POLICY,
  RELEASE_SIGNATURE_NAME,
  RELEASE_SIGNING_PUBLIC_KEY_PATH,
  releaseSigningArguments,
  releaseVerificationArguments,
  resolvePublishedReleaseAssets,
  verifyReleaseChecksums,
  verifyReleaseDescriptor,
  verifyPublishedReleaseBinding,
} from "../../distribution/release-proof.mjs";
import { cosignOrExplain, signChecksums, throwawayKeyPair } from "./release-signing-fixture.mjs";

const TAG = "v1.2.3";
const cosign = cosignOrExplain("signature verification with a throwaway key");

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function descriptorFixture() {
  const images = {};
  IMAGE_NAMES.forEach((name, index) => {
    const imageDigest = digest(String(index + 1));
    images[name] = {
      schemaVersion: 2,
      name,
      reference: `ghcr.io/theandersmadsen/luma/${name}@${imageDigest}`,
      digest: imageDigest,
      platforms: IMAGE_PLATFORMS,
    };
  });
  const applicationDigest = digest("a");
  return createReleaseDescriptor({
    version: TAG.slice(1),
    revision: "b".repeat(40),
    repository: RELEASE_PROOF_POLICY.repository,
    tag: TAG,
    application: {
      schemaVersion: 1,
      reference: `oci://ghcr.io/theandersmadsen/luma/application@${applicationDigest}`,
      digest: applicationDigest,
    },
    images,
    operator: {
      archive: `luma-operator-${TAG.slice(1)}-linux.tar.gz`,
      sha256: "c".repeat(64),
      size: 123_456,
    },
    pin: {
      schemaVersion: 1,
      archive: "luma-pin-2026-08-31.2.tar.gz",
      sha256: "d".repeat(64),
      size: 123_456,
      releaseId: "e".repeat(64),
      version: "2026-08-31.2",
      versionCode: 202_608_312,
      signerSha256: "f".repeat(64),
      manifestSha256: "1".repeat(64),
      receiptsSha256: "2".repeat(64),
    },
  });
}

// A signed release directory: the descriptor, SHA256SUMS listing it, and the
// throwaway key's signature over SHA256SUMS.
async function signedFixture(t, { descriptor = descriptorFixture(), keys = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "release-proof-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = keys ?? throwawayKeyPair(cosign, join(directory, "keys"));
  const descriptorName = `luma-${descriptor.version}.release.json`;
  const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor)}\n`);
  const checksumsBytes = Buffer.from([
    `${"c".repeat(64)}  luma-operator-${descriptor.version}-linux.tar.gz`,
    `${"d".repeat(64)}  ${descriptor.pin.archive}`,
    `${sha256(descriptorBytes)}  ${descriptorName}`,
  ].sort().join("\n") + "\n");
  const paths = {
    descriptorPath: join(directory, descriptorName),
    checksumsPath: join(directory, RELEASE_CHECKSUMS_NAME),
    signaturePath: join(directory, RELEASE_SIGNATURE_NAME),
    publicKeyPath: key.publicKey,
  };
  await writeFile(paths.descriptorPath, descriptorBytes);
  await writeFile(paths.checksumsPath, checksumsBytes);
  signChecksums(cosign, { privateKey: key.privateKey, checksums: paths.checksumsPath, signature: paths.signaturePath });
  return { directory, key, descriptorName, descriptorBytes, checksumsBytes, ...paths };
}

const localVerifier = { provisionVerifier: async () => cosign };

function embeddedBinding(descriptor = descriptorFixture()) {
  return {
    schemaVersion: 2,
    version: descriptor.version,
    source: descriptor.source,
    pin: descriptor.pin,
  };
}

async function publishedFetch(fixture, requested = []) {
  const files = {
    [fixture.descriptorName]: fixture.descriptorBytes,
    [RELEASE_CHECKSUMS_NAME]: fixture.checksumsBytes,
    [RELEASE_SIGNATURE_NAME]: await readFile(fixture.signaturePath),
  };
  const assets = Object.entries(files).map(([name, bytes], index) => ({
    id: 101 + index,
    name,
    size: bytes.length,
    url: `https://api.github.com/repos/${RELEASE_PROOF_POLICY.repository}/releases/assets/${101 + index}`,
    browser_download_url: `https://github.com/${RELEASE_PROOF_POLICY.repository}/releases/download/${TAG}/${name}`,
  }));
  const responses = new Map([
    [`https://api.github.com/repos/${RELEASE_PROOF_POLICY.repository}/releases/tags/${TAG}`,
      Buffer.from(`${JSON.stringify({ tag_name: TAG, draft: false, assets })}\n`)],
    ...assets.map((asset) => [asset.url, files[asset.name]]),
  ]);
  return async (url) => {
    const selected = String(url);
    requested.push(selected);
    const bytes = responses.get(selected);
    return bytes ? new Response(bytes, { status: 200 }) : new Response("missing", { status: 404 });
  };
}

test("release signing uses cosign's key-based offline signature over SHA256SUMS", () => {
  assert.deepEqual([...releaseSigningArguments({ privateKey: "K", checksums: "S", signature: "B" })], [
    "sign-blob", "--yes", "--key", "K", "--use-signing-config=false", "--tlog-upload=false", "--bundle", "B", "S",
  ]);
  assert.deepEqual([...releaseVerificationArguments({ publicKey: "P", checksums: "S", signature: "B" })], [
    "verify-blob", "--key", "P", "--bundle", "B", "--insecure-ignore-tlog", "S",
  ]);
  assert.equal(RELEASE_SIGNATURE_NAME, "SHA256SUMS.sigstore.json");
  assert.deepEqual(publishedReleaseProofUrls("1.2.3"), {
    descriptor: `https://github.com/${RELEASE_PROOF_POLICY.repository}/releases/download/v1.2.3/luma-1.2.3.release.json`,
    checksums: `https://github.com/${RELEASE_PROOF_POLICY.repository}/releases/download/v1.2.3/SHA256SUMS`,
    signature: `https://github.com/${RELEASE_PROOF_POLICY.repository}/releases/download/v1.2.3/SHA256SUMS.sigstore.json`,
  });
  // No CI-only signing path remains beside the maintainer's key.
  assert.equal(existsSync(new URL("../../../.github/workflows/release-cli.yml", import.meta.url)), false);
  assert.equal(RELEASE_PROOF_POLICY.workflowPath, undefined);
});

test("the committed placeholder public key is reported as such and verifies nothing", async (t) => {
  const committed = await readFile(RELEASE_SIGNING_PUBLIC_KEY_PATH);
  if (committed.length === 0) {
    await assert.rejects(readReleaseSigningPublicKey(), /no release signing key yet: platform\/distribution\/release-signing\.pub is the empty placeholder[\s\S]*\.\/luma release keygen/u);
    const directory = await mkdtemp(join(tmpdir(), "release-proof-placeholder-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, RELEASE_CHECKSUMS_NAME), `${"a".repeat(64)}  file\n`);
    await writeFile(join(directory, RELEASE_SIGNATURE_NAME), "{}\n");
    let verifierRan = false;
    await assert.rejects(verifyReleaseChecksums({
      checksumsPath: join(directory, RELEASE_CHECKSUMS_NAME),
      signaturePath: join(directory, RELEASE_SIGNATURE_NAME),
      provisionVerifier: async () => { verifierRan = true; return "/pinned/cosign"; },
      executeVerifier: async () => { verifierRan = true; },
    }), /empty placeholder/u);
    assert.equal(verifierRan, false, "no verifier runs without a key");
  } else {
    assert.match(committed.toString("utf8"), /^-----BEGIN PUBLIC KEY-----\n/u);
    assert.equal((await readReleaseSigningPublicKey()).equals(committed), true);
  }
});

test("SHA256SUMS parsing accepts sha256sum's format only", () => {
  assert.deepEqual(parseReleaseChecksums(`${"a".repeat(64)}  one.tar.gz\n${"b".repeat(64)}  SHA256SUMS.json\n`), {
    "one.tar.gz": "a".repeat(64),
    "SHA256SUMS.json": "b".repeat(64),
  });
  for (const text of [
    "",
    `${"a".repeat(64)}  one.tar.gz`,
    `${"a".repeat(64)} one.tar.gz\n`,
    `${"A".repeat(64)}  one.tar.gz\n`,
    `${"a".repeat(64)}  ../one.tar.gz\n`,
    `${"a".repeat(64)}  one.tar.gz\n${"b".repeat(64)}  one.tar.gz\n`,
  ]) {
    assert.throws(() => parseReleaseChecksums(text), Error, JSON.stringify(text));
  }
  const checksums = parseReleaseChecksums(`${sha256("bytes")}  file\n`);
  assertListedBytes(checksums, "file", Buffer.from("bytes"));
  assert.throws(() => assertListedBytes(checksums, "file", Buffer.from("other")), /file does not match the signed SHA256SUMS/u);
  assert.throws(() => assertListedBytes(checksums, "missing", Buffer.from("bytes")), /does not list missing/u);
});

test("release proof pins one supported Cosign build for each production architecture", async () => {
  assert.equal(RELEASE_PROOF_POLICY.verifier.version, "v3.1.3");
  assert.deepEqual(Object.keys(RELEASE_PROOF_POLICY.verifier.platforms).sort(), [
    "linux/arm64",
    "linux/x64",
  ]);
  for (const artifact of Object.values(RELEASE_PROOF_POLICY.verifier.platforms)) {
    assert.match(artifact.name, /^cosign-linux-(?:amd64|arm64)$/u);
    assert.ok(Number.isSafeInteger(artifact.size) && artifact.size > 100_000_000);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/u);
  }
});

test("a signed SHA256SUMS verifies under its public key and yields the listed checksums", { skip: !cosign }, async (t) => {
  const fixture = await signedFixture(t);
  const checksums = await verifyReleaseChecksums({ ...fixture, ...localVerifier });
  assert.equal(checksums[fixture.descriptorName], sha256(fixture.descriptorBytes));
  const descriptor = await verifyReleaseDescriptor({ ...fixture, ...localVerifier, expectedTag: TAG });
  assert.equal(descriptor.version, TAG.slice(1));
  assert.deepEqual(descriptor.source, { repository: RELEASE_PROOF_POLICY.repository, tag: TAG });
});

test("changed checksums, a foreign key, and a changed descriptor are rejected", { skip: !cosign }, async (t) => {
  const changed = await signedFixture(t);
  await writeFile(changed.checksumsPath, Buffer.concat([changed.checksumsBytes, Buffer.from(`${"9".repeat(64)}  extra\n`)]));
  await assert.rejects(verifyReleaseChecksums({ ...changed, ...localVerifier }), /Cosign rejected the release signature/u);

  const foreign = await signedFixture(t);
  const other = throwawayKeyPair(cosign, join(foreign.directory, "other"));
  await assert.rejects(
    verifyReleaseChecksums({ ...foreign, ...localVerifier, publicKeyPath: other.publicKey }),
    /Cosign rejected the release signature/u,
  );

  const descriptor = await signedFixture(t);
  await writeFile(descriptor.descriptorPath, Buffer.concat([descriptor.descriptorBytes, Buffer.from(" ")]));
  await assert.rejects(
    verifyReleaseDescriptor({ ...descriptor, ...localVerifier, expectedTag: TAG }),
    /luma-1\.2\.3\.release\.json does not match the signed SHA256SUMS/u,
  );
});

test("release coordinates are validated only after the signature and checksum hold", { skip: !cosign }, async (t) => {
  const untrusted = JSON.parse(JSON.stringify(descriptorFixture()));
  untrusted.source.repository = "attacker/luma";
  const fixture = await signedFixture(t, { descriptor: untrusted });
  await assert.rejects(
    verifyReleaseDescriptor({ ...fixture, ...localVerifier, expectedTag: TAG }),
    /does not match the expected repository and tag/u,
  );
  let verifierRan = false;
  await assert.rejects(
    verifyReleaseDescriptor({
      ...fixture,
      expectedTag: TAG,
      provisionVerifier: async () => "/pinned/cosign",
      executeVerifier: async () => { verifierRan = true; throw new Error("Cosign rejected the release signature"); },
    }),
    /Cosign rejected/u,
  );
  assert.equal(verifierRan, true);
});

test("published binding fetches the signed checksums only from the hardcoded repository", { skip: !cosign }, async (t) => {
  const fixture = await signedFixture(t);
  const requested = [];
  const verified = await verifyPublishedReleaseBinding({
    embedded: embeddedBinding(),
    fetchImpl: await publishedFetch(fixture, requested),
    publicKeyPath: fixture.publicKeyPath,
    ...localVerifier,
  });
  assert.deepEqual(requested.sort(), [
    `https://api.github.com/repos/${RELEASE_PROOF_POLICY.repository}/releases/tags/${TAG}`,
    `https://api.github.com/repos/${RELEASE_PROOF_POLICY.repository}/releases/assets/101`,
    `https://api.github.com/repos/${RELEASE_PROOF_POLICY.repository}/releases/assets/102`,
    `https://api.github.com/repos/${RELEASE_PROOF_POLICY.repository}/releases/assets/103`,
  ].sort());
  assert.deepEqual(verified.source, descriptorFixture().source);
  assert.deepEqual(verified.pin, descriptorFixture().pin);
});

test("published binding authenticates private release downloads without exposing the token", { skip: !cosign }, async (t) => {
  const fixture = await signedFixture(t);
  const fetchFixture = await publishedFetch(fixture);
  const verified = await verifyPublishedReleaseBinding({
    embedded: embeddedBinding(),
    githubToken: "fixture-private-token",
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.authorization, "Bearer fixture-private-token");
      assert.equal(options.headers["x-github-api-version"], "2022-11-28");
      assert.ok(["application/vnd.github+json", "application/octet-stream"].includes(options.headers.accept));
      return fetchFixture(url, options);
    },
    publicKeyPath: fixture.publicKeyPath,
    ...localVerifier,
  });
  assert.equal(verified.version, "1.2.3");
});

test("published binding exposes no Pin coordinates when the signature or coordinates differ", { skip: !cosign }, async (t) => {
  const foreign = await signedFixture(t);
  const other = throwawayKeyPair(cosign, join(foreign.directory, "other"));
  const requested = [];
  await assert.rejects(
    verifyPublishedReleaseBinding({
      embedded: embeddedBinding(),
      fetchImpl: await publishedFetch(foreign, requested),
      publicKeyPath: other.publicKey,
      ...localVerifier,
    }),
    /Cosign rejected the release signature/u,
  );
  assert.ok(requested.every((url) => !url.endsWith(descriptorFixture().pin.archive)));

  const remote = JSON.parse(JSON.stringify(descriptorFixture()));
  remote.pin.releaseId = "9".repeat(64);
  const differing = await signedFixture(t, { descriptor: remote });
  await assert.rejects(
    verifyPublishedReleaseBinding({
      embedded: embeddedBinding(),
      fetchImpl: await publishedFetch(differing),
      publicKeyPath: differing.publicKeyPath,
      ...localVerifier,
    }),
    /does not match the embedded operator release binding/u,
  );
});

test("GitHub asset redirects drop the private token before reaching signed object storage", async () => {
  const calls = [];
  const body = Buffer.from("verified asset");
  const response = await fetchPublishedReleaseAsset({
    asset: {
      name: "asset.bin",
      size: body.length,
      url: `https://api.github.com/repos/${RELEASE_PROOF_POLICY.repository}/releases/assets/77`,
    },
    githubToken: "fixture-private-token",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), headers: options.headers });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://release-assets.githubusercontent.com/objects/asset.bin" },
        });
      }
      return new Response(body, { status: 200 });
    },
  });
  assert.equal(Buffer.from(await response.arrayBuffer()).toString("utf8"), "verified asset");
  assert.equal(calls[0].headers.authorization, "Bearer fixture-private-token");
  assert.equal(calls[1].headers, undefined);
});

test("GitHub release metadata cannot redirect an expected name to a foreign browser asset", async () => {
  await assert.rejects(
    resolvePublishedReleaseAssets({
      tag: TAG,
      names: ["asset.bin"],
      fetchImpl: async () => new Response(JSON.stringify({
        tag_name: TAG,
        draft: false,
        assets: [{
          id: 77,
          name: "asset.bin",
          size: 10,
          url: `https://api.github.com/repos/${RELEASE_PROOF_POLICY.repository}/releases/assets/77`,
          browser_download_url: "https://attacker.invalid/asset.bin",
        }],
      }), { status: 200 }),
    }),
    /asset\.bin metadata is invalid/u,
  );
});
