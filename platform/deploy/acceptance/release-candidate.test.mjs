import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import {
  CANDIDATE_BASENAME,
  EXPECTED_CANDIDATE_FILES,
  FIRST_PARTY_IMAGES,
  FORBIDDEN_RENAMED_PRODUCTION_RESOURCES,
  HOSTED_CANDIDATE_AUTHORITY,
  LEGACY_PRODUCTION_STATE,
  LOCAL_CANDIDATE_AUTHORITY,
  THIRD_PARTY_IMAGES,
  assertImmutableCandidateProtocol,
  assertLegacyProductionCompatible,
  assertOfflineProductionAuthority,
  assertReleaseProtocolManifestMatchesTrusted,
  candidateGitEnvironment,
  candidateIdForBody,
  canonicalJsonBytes,
  canonicalStringify,
  createProductionComposeModel,
  createRawGitArchive,
  createCandidateDescriptor,
  productionCompatibilityDifferences,
  productionStateForSnapshot,
  sealCandidateFromBuffers,
  sealCandidateFromFiles,
  sha256Bytes,
  verifyCandidate,
  validateEffectiveComposeConfig,
  verifyThirdPartyRegistryEvidence,
} from "../release-candidate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const PRODUCTION_REGISTRY_PREIMAGES = JSON.parse(fs.readFileSync(path.join(HERE, "registry-preimages.json"), "utf8"));

function digest(seed) {
  return sha256Bytes(Buffer.from(seed));
}

function gitSha1(type, data) {
  return crypto.createHash("sha1").update(Buffer.from(`${type} ${data.length}\0`, "ascii")).update(data).digest("hex");
}

const FIXTURE_VERIFIER = Buffer.from("#!/usr/bin/env python3\nprint('fixture verifier')\n", "utf8");

function fixtureSourceFiles(data = Buffer.from("source", "utf8")) {
  return [
    { path: "README.md", data: Buffer.from(data), mode: 0o644 },
    { path: "compose.yaml", data: fs.readFileSync(path.join(ROOT, "compose.yaml")), mode: 0o644 },
    { path: "platform/compose/production.yaml", data: fs.readFileSync(path.join(ROOT, "platform/compose/production.yaml")), mode: 0o644 },
    { path: "platform/deploy/production-compose-authority.json", data: fs.readFileSync(path.join(ROOT, "platform/deploy/production-compose-authority.json")), mode: 0o644 },
    { path: "platform/deploy/release.json", data: fs.readFileSync(path.join(ROOT, "platform/deploy/release.json")), mode: 0o644 },
    { path: "platform/deploy/vps/verify-release.py", data: FIXTURE_VERIFIER, mode: 0o755 },
  ];
}

function gitTreeForFiles(files) {
  const root = { directories: new Map(), files: new Map() };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.directories.has(part)) node.directories.set(part, { directories: new Map(), files: new Map() });
      node = node.directories.get(part);
    }
    node.files.set(parts.at(-1), { mode: file.mode, objectId: gitSha1("blob", file.data) });
  }
  const hashNode = (node) => {
    const records = [
      ...[...node.files].map(([name, value]) => ({ name, directory: false, mode: value.mode === 0o755 ? "100755" : "100644", objectId: value.objectId })),
      ...[...node.directories].map(([name, child]) => ({ name, directory: true, mode: "40000", objectId: hashNode(child) })),
    ].sort((left, right) => Buffer.compare(Buffer.from(`${left.name}${left.directory ? "/" : ""}`), Buffer.from(`${right.name}${right.directory ? "/" : ""}`)));
    const body = Buffer.concat(records.map((record) => Buffer.concat([
      Buffer.from(`${record.mode} ${record.name}\0`, "utf8"), Buffer.from(record.objectId, "hex"),
    ])));
    return gitSha1("tree", body);
  };
  return hashNode(root);
}

function sourceGitFixture(data = Buffer.from("source", "utf8"), sourceFiles = fixtureSourceFiles(data)) {
  const files = sourceFiles;
  const tree = gitTreeForFiles(files);
  const commitObject = Buffer.from(`tree ${tree}\nauthor Fixture <fixture@example.invalid> 0 +0000\ncommitter Fixture <fixture@example.invalid> 0 +0000\n\nfixture\n`, "utf8");
  const commit = gitSha1("commit", commitObject);
  const directories = new Set();
  for (const file of files) {
    let parent = path.posix.dirname(file.path);
    while (parent !== ".") { directories.add(parent); parent = path.posix.dirname(parent); }
  }
  const records = [
    ...[...directories].map((entryPath) => ({ directory: true, path: entryPath, mode: 0o755 })),
    ...files,
  ].sort((left, right) => Buffer.compare(Buffer.from(`${left.path}${left.directory ? "/" : ""}`), Buffer.from(`${right.path}${right.directory ? "/" : ""}`)));
  return { archive: tarArchive(records), commit, commitObject, files, tree };
}

function writeTarString(header, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  assert.ok(bytes.length <= length);
  bytes.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  writeTarString(header, offset, length - 1, value.toString(8).padStart(length - 2, "0"));
}

function tarArchive(records) {
  const chunks = [];
  for (const record of records) {
    const data = Buffer.from(record.directory ? "" : record.data ?? "");
    const header = Buffer.alloc(512);
    writeTarString(header, 0, 100, record.path);
    writeTarOctal(header, 100, 8, record.mode ?? 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, data.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = record.directory ? 0x35 : 0x30;
    writeTarString(header, 257, 6, "ustar\0");
    writeTarString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function releaseFixture(sourceFiles = fixtureSourceFiles()) {
  const verifier = FIXTURE_VERIFIER;
  const files = sourceFiles.map((file) => ({ ...file, mode: file.mode === 0o755 ? "0755" : "0644" }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const entries = files.map((file) => ({ path: file.path, sha256: sha256Bytes(file.data), size: file.data.length, mode: file.mode }));
  const releaseId = digest(JSON.stringify({ schemaVersion: 1, profile: "vps", entries }));
  return {
    releaseId,
    manifest: { schemaVersion: 1, profile: "vps", releaseId, entries },
    archive: gzipSync(tarArchive(files.map((file) => ({ path: file.path, data: file.data, mode: Number.parseInt(file.mode, 8) }))), { level: 9, mtime: 0 }),
    verifier,
    descriptor: {
      archivePath: `/external/vps-${releaseId}.tar.gz`,
      manifestPath: `/external/vps-${releaseId}.manifest.json`,
      profile: "vps",
      releaseId,
    },
  };
}

function toolchainFixture() {
  return {
    schema: "revival.toolchain-receipt",
    schemaVersion: 1,
    platform: "linux/amd64",
    tools: ["cargo", "docker", "docker-buildx", "git", "node", "npm", "rustc"].map((name) => ({
      name,
      version: `${name} fixture-1`,
      sha256: digest(`tool:${name}`),
    })),
  };
}

function syntheticThirdPartyImages() {
  return Array.from({ length: THIRD_PARTY_IMAGES.length }, (_, offset) => {
    const index = offset + 1;
    const layerBytes = Buffer.from(`third-party layer ${index}`, "utf8");
    const configBytes = Buffer.from(JSON.stringify({ architecture: "arm64", os: "linux", config: { Labels: {} }, rootfs: { type: "layers", diff_ids: [`sha256:${sha256Bytes(layerBytes)}`] } }), "utf8");
    const imageId = `sha256:${sha256Bytes(configBytes)}`;
    const platformManifest = Buffer.from(JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: imageId, size: configBytes.length },
      layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: `sha256:${sha256Bytes(Buffer.from(`compressed ${index}`))}`, size: 128 + index }],
    }), "utf8");
    const manifestDigest = `sha256:${sha256Bytes(platformManifest)}`;
    const indexBytes = Buffer.from(JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [{
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: manifestDigest,
        size: platformManifest.length,
        platform: { architecture: "arm64", os: "linux", variant: "v8" },
      }],
    }), "utf8");
    const indexDigest = `sha256:${sha256Bytes(indexBytes)}`;
    const reference = `fixture.invalid/third-party-${index}:locked@${indexDigest}`;
    return {
      bundleReference: `fixture.invalid/third-party-${index}:locked`,
      configBytes,
      imageId,
      layerBytes,
      reference,
      registry: {
        index: { bytesBase64: indexBytes.toString("base64"), digest: indexDigest, mediaType: "application/vnd.oci.image.index.v1+json", size: indexBytes.length },
        manifest: { bytesBase64: platformManifest.toString("base64"), digest: manifestDigest, mediaType: "application/vnd.oci.image.manifest.v1+json", size: platformManifest.length },
      },
    };
  });
}

const TEST_THIRD_PARTY = syntheticThirdPartyImages();
const TEST_THIRD_PARTY_REFERENCES = Object.freeze(TEST_THIRD_PARTY.map((entry) => entry.reference));

function imageFixture(releaseId, sourceCommit, sourceTree) {
  const images = [];
  const manifest = [];
  const tarRecords = [];
  const repositories = {};
  let index = 0;
  const expected = [
    ...FIRST_PARTY_IMAGES.map(({ component }) => ({ component, firstParty: true, reference: `ai-pin-revival/${component}:${releaseId}`, bundleReference: `ai-pin-revival/${component}:${releaseId}` })),
    ...TEST_THIRD_PARTY.map(({ bundleReference, reference }) => ({ component: null, firstParty: false, reference, bundleReference })),
  ].sort((left, right) => left.reference.localeCompare(right.reference));
  for (const wanted of expected) {
    index += 1;
    const labels = wanted.firstParty ? {
        "dk.andersmadsen.ai-pin-revival.component": wanted.component,
        "dk.andersmadsen.ai-pin-revival.product": "Ai Pin Revival",
        "dk.andersmadsen.ai-pin-revival.release": releaseId,
        "dk.andersmadsen.ai-pin-revival.source-commit": sourceCommit,
        "dk.andersmadsen.ai-pin-revival.source-tree": sourceTree,
        "org.opencontainers.image.revision": sourceCommit,
      } : null;
    const thirdParty = wanted.firstParty ? null : TEST_THIRD_PARTY.find((entry) => entry.reference === wanted.reference);
    const layerBytes = thirdParty?.layerBytes ?? Buffer.from(`layer ${index}`, "utf8");
    const configBytes = thirdParty?.configBytes ?? Buffer.from(JSON.stringify({ architecture: "arm64", os: "linux", config: { Labels: labels ?? {} }, rootfs: { type: "layers", diff_ids: [`sha256:${sha256Bytes(layerBytes)}`] } }), "utf8");
    const imageId = thirdParty?.imageId ?? `sha256:${sha256Bytes(configBytes)}`;
    const configPath = `${imageId.slice(7)}.json`;
    const layerPath = `${digest(`layer-path:${index}`)}/layer.tar`;
    const layerDirectory = path.posix.dirname(layerPath);
    tarRecords.push(
      { path: configPath, data: configBytes },
      { path: layerPath, data: layerBytes },
      { path: `${layerDirectory}/VERSION`, data: Buffer.from("1.0\n", "ascii") },
      { path: `${layerDirectory}/json`, data: Buffer.from(JSON.stringify({ id: layerDirectory }), "utf8") },
    );
    manifest.push({ Config: configPath, RepoTags: [wanted.bundleReference], Layers: [layerPath] });
    const separator = wanted.bundleReference.lastIndexOf(":");
    const repository = wanted.bundleReference.slice(0, separator);
    const tag = wanted.bundleReference.slice(separator + 1);
    (repositories[repository] ??= {})[tag] = path.posix.dirname(layerPath);
    const sourceDigest = wanted.firstParty ? null : wanted.reference.slice(wanted.reference.lastIndexOf("@") + 1);
    images.push({
      bundleReference: wanted.bundleReference,
      component: wanted.component,
      firstParty: wanted.firstParty,
      imageId,
      labels,
      platform: "linux/arm64",
      reference: wanted.reference,
      registry: thirdParty?.registry ?? null,
      sourceDigest,
    });
  }
  tarRecords.push(
    { path: "repositories", data: Buffer.from(JSON.stringify(repositories), "utf8") },
    { path: "manifest.json", data: Buffer.from(JSON.stringify(manifest), "utf8") },
  );
  const bundle = tarArchive(tarRecords);
  return { bundle, manifest, tarRecords, receipt: {
    schema: "revival.docker-image-receipt",
    schemaVersion: 4,
    platform: "linux/amd64",
    targetPlatform: "linux/arm64",
    bundle: { sha256: sha256Bytes(bundle), size: bundle.length },
    images,
  } };
}

function fixture({ productionState = LEGACY_PRODUCTION_STATE, sourceFiles = fixtureSourceFiles() } = {}) {
  const release = releaseFixture(sourceFiles);
  const source = sourceGitFixture(Buffer.from("source", "utf8"), sourceFiles);
  const image = imageFixture(release.releaseId, source.commit, source.tree);
  const composeModel = createProductionComposeModel({
    releaseId: release.releaseId,
    trustedThirdPartyImages: TEST_THIRD_PARTY_REFERENCES,
    imageReceipt: image.receipt,
  });
  return {
    releaseArchive: release.archive,
    releaseManifest: release.manifest,
    releaseDescriptor: release.descriptor,
    releaseVerifier: release.verifier,
    sourceArchive: source.archive,
    sourceCommitObject: source.commitObject,
    sourceReceipt: {
      schema: "revival.source-snapshot-receipt",
      schemaVersion: 2,
      archiveRole: "source-snapshot",
      commitObjectRole: "source-commit-object",
      archiveSha256: sha256Bytes(source.archive),
      clean: true,
      commit: source.commit,
      detached: true,
      tree: source.tree,
    },
    composeModel,
    productionState: structuredClone(productionState),
    toolchainReceipt: toolchainFixture(),
    imageReceipt: image.receipt,
    imageBundle: image.bundle,
    imageManifest: image.manifest,
    imageTarRecords: image.tarRecords,
    trustedThirdPartyImages: TEST_THIRD_PARTY_REFERENCES,
  };
}

function verifyFixtureCandidate(candidate, options = {}) {
  return verifyCandidate(candidate, { trustedThirdPartyImages: TEST_THIRD_PARTY_REFERENCES, ...options });
}

function tempData() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revival-candidate-test-"));
  fs.chmodSync(root, 0o700);
  return root;
}

function copyCandidate(source, transform = () => {}) {
  const destination = tempData();
  for (const name of fs.readdirSync(source)) {
    fs.copyFileSync(path.join(source, name), path.join(destination, name));
    fs.chmodSync(path.join(destination, name), 0o600);
  }
  transform(destination);
  return destination;
}

test("canonical candidate identity is recursively unambiguous", () => {
  const left = { z: [{ b: 2, a: 1 }], a: { y: true, x: null } };
  const right = { a: { x: null, y: true }, z: [{ a: 1, b: 2 }] };
  assert.equal(canonicalStringify(left), canonicalStringify(right));
  assert.equal(candidateIdForBody(left), candidateIdForBody(right));
  assert.throws(() => canonicalStringify({ unsafe: 1.2 }), /safe integers/u);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => canonicalStringify(cycle), /cycle/u);
});

test("seal publishes one exact candidate atomically and verification is read-only", (t) => {
  const dataDir = tempData();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const sealed = sealCandidateFromBuffers({ dataDir, ...fixture() });
  assert.equal(sealed.ok, true);
  assert.match(sealed.candidateId, /^[0-9a-f]{64}$/u);
  assert.deepEqual(fs.readdirSync(sealed.root).sort(), EXPECTED_CANDIDATE_FILES);
  assert.equal(fs.statSync(sealed.root).mode & 0o777, 0o700);
  for (const name of EXPECTED_CANDIDATE_FILES) assert.equal(fs.statSync(path.join(sealed.root, name)).mode & 0o777, 0o600);
  const before = fs.readdirSync(sealed.root).map((name) => [name, fs.statSync(path.join(sealed.root, name)).mtimeNs]);
  const checked = verifyFixtureCandidate(path.join(sealed.root, CANDIDATE_BASENAME));
  const after = fs.readdirSync(sealed.root).map((name) => [name, fs.statSync(path.join(sealed.root, name)).mtimeNs]);
  assert.equal(checked.candidateId, sealed.candidateId);
  assert.deepEqual(checked.authority, LOCAL_CANDIDATE_AUTHORITY);
  assert.deepEqual(after, before);
});

test("local and hosted candidate origins are identity-bound and local stores are never deployable", (t) => {
  const dataDir = tempData();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const input = fixture();
  const local = sealCandidateFromBuffers({ dataDir, ...input });
  const hosted = sealCandidateFromBuffers({ dataDir, ...input, authority: HOSTED_CANDIDATE_AUTHORITY });
  assert.notEqual(local.candidateId, hosted.candidateId);
  assert.deepEqual(verifyFixtureCandidate(local.root).authority, LOCAL_CANDIDATE_AUTHORITY);
  assert.deepEqual(verifyFixtureCandidate(hosted.root).authority, HOSTED_CANDIDATE_AUTHORITY);

  const fakeBin = path.join(dataDir, "fake-tools");
  const marker = path.join(dataDir, "external-tool-ran");
  fs.mkdirSync(fakeBin, { mode: 0o700 });
  for (const name of ["docker", "ssh", "rsync"]) {
    fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\nprintf ran >${JSON.stringify(marker)}\nexit 97\n`, { mode: 0o700 });
  }
  const refused = childProcess.spawnSync("/bin/bash", [
    "-p", path.join(ROOT, "platform/deploy/vps/deploy.sh"),
    "--dry-run", "--candidate", local.root,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      REVIVAL_DATA_DIR: dataDir,
    },
  });
  assert.notEqual(refused.status, 0, "a locally prepared candidate became deployable");
  assert.match(refused.stderr, /hosted|provider|evidence|current candidate|authorize-deploy/u);
  assert.equal(fs.existsSync(marker), false, "local candidate refusal reached Docker, SSH, or rsync");

  const attacked = copyCandidate(hosted.root, (root) => {
    const descriptorPath = path.join(root, CANDIDATE_BASENAME);
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    descriptor.body.authority = { origin: "github-hosted-actions", productionUse: "unverified" };
    descriptor.candidateId = candidateIdForBody(descriptor.body);
    fs.writeFileSync(descriptorPath, canonicalJsonBytes(descriptor));
  });
  t.after(() => fs.rmSync(attacked, { recursive: true, force: true }));
  assert.throws(() => verifyFixtureCandidate(attacked, { expectedId: JSON.parse(fs.readFileSync(path.join(attacked, CANDIDATE_BASENAME))).candidateId }),
    /authority origin is unsupported/u);
});

test("identical publication is idempotent and a conflicting preexisting type is preserved", (t) => {
  const dataDir = tempData();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const input = fixture();
  const first = sealCandidateFromBuffers({ dataDir, ...input });
  const firstInode = fs.statSync(first.root).ino;
  const second = sealCandidateFromBuffers({ dataDir, ...input });
  assert.equal(second.candidateId, first.candidateId);
  assert.equal(fs.statSync(second.root).ino, firstInode);

  const otherData = tempData();
  t.after(() => fs.rmSync(otherData, { recursive: true, force: true }));
  const payloads = {
    "release-archive": input.releaseArchive,
    "release-manifest": Buffer.from(`${JSON.stringify(input.releaseManifest, null, 2)}\n`),
    "release-descriptor": canonicalJsonBytes(input.releaseDescriptor),
    "release-verifier": input.releaseVerifier,
    "source-snapshot": input.sourceArchive,
    "source-commit-object": input.sourceCommitObject,
    "source-snapshot-receipt": canonicalJsonBytes(input.sourceReceipt),
    "production-compose-model": canonicalJsonBytes(input.composeModel),
    "production-state-contract": canonicalJsonBytes(input.productionState),
    "toolchain-receipt": canonicalJsonBytes(input.toolchainReceipt),
    "docker-image-receipt": canonicalJsonBytes(input.imageReceipt),
    "docker-image-bundle": input.imageBundle,
  };
  const descriptor = createCandidateDescriptor({ payloads, release: input.releaseDescriptor, git: input.sourceReceipt, sourceReceipt: input.sourceReceipt, composeModel: input.composeModel, productionState: input.productionState, toolchainReceipt: input.toolchainReceipt, imageReceipt: input.imageReceipt, trustedThirdPartyImages: TEST_THIRD_PARTY_REFERENCES });
  const store = path.join(otherData, "release-candidates");
  fs.mkdirSync(store, { mode: 0o700 });
  const collision = path.join(store, descriptor.candidateId);
  fs.writeFileSync(collision, "sentinel", { mode: 0o600 });
  assert.throws(() => sealCandidateFromBuffers({ dataDir: otherData, ...input }), /candidate path must be|conflicts|path ancestry/u);
  assert.equal(fs.readFileSync(collision, "utf8"), "sentinel");
});

test("file-backed publication streams archives and image bundles into the same sealed contract", (t) => {
  const dataDir = tempData();
  const input = fixture();
  const source = tempData();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  const releaseArchivePath = path.join(source, "release.tar.gz");
  const releaseVerifierPath = path.join(source, "verify-release.py");
  const sourceArchivePath = path.join(source, "source-snapshot.tar");
  const sourceCommitObjectPath = path.join(source, "source-commit.txt");
  const imageBundlePath = path.join(source, "images.tar");
  fs.writeFileSync(releaseArchivePath, input.releaseArchive, { mode: 0o600 });
  fs.writeFileSync(releaseVerifierPath, input.releaseVerifier, { mode: 0o600 });
  fs.writeFileSync(sourceArchivePath, input.sourceArchive, { mode: 0o600 });
  fs.writeFileSync(sourceCommitObjectPath, input.sourceCommitObject, { mode: 0o600 });
  fs.writeFileSync(imageBundlePath, input.imageBundle, { mode: 0o600 });
  const sealed = sealCandidateFromFiles({
    dataDir,
    releaseArchivePath,
    releaseManifest: input.releaseManifest,
    releaseDescriptor: input.releaseDescriptor,
    releaseVerifierPath,
    sourceArchivePath,
    sourceCommitObjectPath,
    sourceReceipt: input.sourceReceipt,
    composeModel: input.composeModel,
    productionState: input.productionState,
    toolchainReceipt: input.toolchainReceipt,
    imageReceipt: input.imageReceipt,
    imageBundlePath,
    trustedThirdPartyImages: input.trustedThirdPartyImages,
  });
  assert.equal(verifyFixtureCandidate(sealed.root).candidateId, sealed.candidateId);
  assert.deepEqual(fs.readFileSync(path.join(sealed.root, "images.tar")), input.imageBundle);
  fs.appendFileSync(imageBundlePath, "source changed after publication");
  assert.equal(verifyFixtureCandidate(sealed.root).candidateId, sealed.candidateId);
});

test("candidate verifier rejects extras, missing files, links, hardlinks, FIFOs, modes, and substitutions", (t) => {
  const dataDir = tempData();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const sealed = sealCandidateFromBuffers({ dataDir, ...fixture() });
  const cases = [
    ["extra", (root) => fs.writeFileSync(path.join(root, "extra"), "x", { mode: 0o600 }), /missing or extra/u],
    ["missing", (root) => fs.unlinkSync(path.join(root, "images.tar")), /missing or extra/u],
    ["symlink", (root) => { fs.unlinkSync(path.join(root, "images.tar")); fs.symlinkSync("release.tar.gz", path.join(root, "images.tar")); }, /regular file|payload/u],
    ["hardlink", (root) => { fs.unlinkSync(path.join(root, "images.tar")); fs.linkSync(path.join(root, "release.tar.gz"), path.join(root, "images.tar")); }, /regular file/u],
    ["mode", (root) => fs.chmodSync(path.join(root, "images.tar"), 0o644), /mode 0600/u],
    ["substitution", (root) => fs.appendFileSync(path.join(root, "images.tar"), "forged"), /inventory/u],
    ["noncanonical descriptor", (root) => { const file = path.join(root, CANDIDATE_BASENAME); const body = JSON.parse(fs.readFileSync(file)); fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 }); }, /canonical/u],
  ];
  for (const [name, mutate, pattern] of cases) {
    const copy = copyCandidate(sealed.root, mutate);
    t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
    assert.throws(() => verifyFixtureCandidate(copy), pattern, name);
  }
});

test("candidate verifier rejects descriptor and receipt identity attacks", (t) => {
  const dataDir = tempData();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const sealed = sealCandidateFromBuffers({ dataDir, ...fixture() });
  const attacks = [
    ["candidate id", (body) => { body.candidateId = "0".repeat(64); }, /candidate ID/u],
    ["traversal basename", (body) => { body.body.files[0].basename = "../escape"; body.candidateId = candidateIdForBody(body.body); }, /basename|fixed role/u],
    ["duplicate role", (body) => { body.body.files[1].role = body.body.files[0].role; body.candidateId = candidateIdForBody(body.body); }, /roles must be unique/u],
    ["digest substitution", (body) => { body.body.sourceSnapshot.archiveDigest = "0".repeat(64); body.candidateId = candidateIdForBody(body.body); }, /source binding/u],
  ];
  for (const [name, mutate, pattern] of attacks) {
    const copy = copyCandidate(sealed.root, (root) => {
      const file = path.join(root, CANDIDATE_BASENAME);
      const body = JSON.parse(fs.readFileSync(file)); mutate(body);
      fs.writeFileSync(file, canonicalJsonBytes(body), { mode: 0o600 });
    });
    t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
    assert.throws(() => verifyFixtureCandidate(copy), pattern, name);
  }
});

test("image receipt rejects platform, label, ID, digest, extra/missing and source substitutions", () => {
  const base = fixture();
  const mutations = [
    (receipt) => { receipt.platform = "linux/arm64"; },
    (receipt) => { receipt.targetPlatform = "linux/amd64"; },
    (receipt) => { receipt.schemaVersion = 3; },
    (receipt) => { receipt.images[0].platform = "linux/amd64"; },
    (receipt) => { receipt.images.find((image) => image.firstParty).labels["dk.andersmadsen.ai-pin-revival.product"] = "forged"; },
    (receipt) => { receipt.images[1].imageId = receipt.images[0].imageId; },
    (receipt) => { receipt.images.find((image) => !image.firstParty).reference = `evil.invalid/image@sha256:${"e".repeat(64)}`; },
    (receipt) => { receipt.images.pop(); },
    (receipt) => { const third = receipt.images.find((image) => !image.firstParty); third.sourceDigest = `sha256:${"f".repeat(64)}`; },
  ];
  for (const mutate of mutations) {
    const input = structuredClone(base);
    // structuredClone turns buffers into Uint8Arrays.
    input.releaseArchive = Buffer.from(base.releaseArchive);
    input.imageBundle = Buffer.from(base.imageBundle);
    mutate(input.imageReceipt);
    const dataDir = tempData();
    try { assert.throws(() => sealCandidateFromBuffers({ dataDir, ...input }), /image|Docker|third-party|bundle|first-party/u); }
    finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  }
});

test("Compose model binds every service role/reference to the exact receipt image ID before Docker", (t) => {
  const input = fixture();
  const probe = tempData();
  t.after(() => fs.rmSync(probe, { recursive: true, force: true }));
  const dockerMarker = path.join(probe, "docker-called");
  fs.writeFileSync(path.join(probe, "docker"), `#!/bin/sh\n: >${JSON.stringify(dockerMarker)}\nexit 99\n`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${probe}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  const byReference = new Map(input.imageReceipt.images.map((image) => [image.reference, image.imageId]));
  assert.equal(Object.keys(input.composeModel.services).length, 15);
  for (const mapping of Object.values(input.composeModel.services)) {
    assert.deepEqual(Object.keys(mapping).sort(), ["imageId", "reference", "role"]);
    assert.equal(mapping.imageId, byReference.get(mapping.reference));
  }

  for (const attack of ["permutation", "reference-exchange", "restored-path-record-swap"]) {
    const attacked = structuredClone(input);
    if (attack === "permutation") {
      [attacked.composeModel.services.center.imageId, attacked.composeModel.services.edge.imageId] =
        [attacked.composeModel.services.edge.imageId, attacked.composeModel.services.center.imageId];
    } else if (attack === "reference-exchange") {
      attacked.composeModel.services.center.imageId = attacked.composeModel.services.edge.imageId;
    } else {
      // Reproduces a record/model swap where a mutable path has been restored:
      // the visible role/reference is original, but its record-bound content ID
      // came from a different service. Candidate validation must reject before
      // any runtime helper (and therefore before any Docker call) is reachable.
      attacked.composeModel.services.edge.imageId = attacked.composeModel.services.center.imageId;
    }
    const dataDir = tempData();
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    assert.throws(() => sealCandidateFromBuffers({ dataDir, ...attacked }),
      /exact image role\/reference/u, attack);
    const published = path.join(dataDir, "release-candidates");
    assert.ok(!fs.existsSync(published) || fs.readdirSync(published).length === 0, attack);
  }
  assert.equal(fs.existsSync(dockerMarker), false, "mapping attacks reached Docker");
});

test("both remote consumers exhaustively reject receipt aliases and inventory substitutions before Docker", (t) => {
  const directory = tempData();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "docker-called");
  fs.writeFileSync(path.join(directory, "docker"), `#!/bin/sh\n: >${JSON.stringify(marker)}\nexit 99\n`, { mode: 0o755 });
  const parityReleaseId = "a".repeat(64);
  const parityModel = createProductionComposeModel({ releaseId: parityReleaseId });
  const firstPartyComponents = new Set(FIRST_PARTY_IMAGES.map(({ component }) => component));
  const modelAuthority = new Map();
  for (const { reference, role } of Object.values(parityModel.services)) {
    assert.ok(!modelAuthority.has(role) || modelAuthority.get(role) === reference);
    modelAuthority.set(role, reference);
  }
  const modelReferences = new Set(modelAuthority.values());
  const helperReferences = THIRD_PARTY_IMAGES.filter((reference) => !modelReferences.has(reference));
  assert.deepEqual(helperReferences, [THIRD_PARTY_IMAGES.at(-1)]);
  const expectedAuthority = Object.fromEntries([
    ...[...modelAuthority].map(([role, reference]) => [role, {
      bundleReference: firstPartyComponents.has(role)
        ? reference
        : (() => {
            const base = reference.slice(0, reference.lastIndexOf("@"));
            return base.lastIndexOf(":") > base.lastIndexOf("/") ? base : `${base}:latest`;
          })(),
      component: firstPartyComponents.has(role) ? role : null,
      firstParty: firstPartyComponents.has(role),
      reference,
    }]),
    ["backup-helper", {
      bundleReference: "node:22.18.0-alpine3.22",
      component: null,
      firstParty: false,
      reference: helperReferences[0],
    }],
  ]);
  assert.equal(Object.keys(expectedAuthority).length, 10);
  const script = String.raw`
import base64,copy,importlib.util,json,os,sys
runtime_path,compose_path,marker,fake_bin,expected_json,model_json,preimages_path=sys.argv[1:]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
modules=[load("mapping_runtime",runtime_path),load("mapping_compose",compose_path)]
release_id="a"*64
expected_authority=json.loads(expected_json)
producer_model=json.loads(model_json)
with open(preimages_path,"r",encoding="utf-8") as source:
    registry_preimages=json.load(source)
source_git={"commit":"b"*40,"tree":"c"*40}
bundle_digest="d"*64
bundle_size=123456
def authority_object(module):
    return {role:{"reference":entry[0],"bundleReference":entry[1],
                  "firstParty":entry[2],"component":entry[3]}
            for role,entry in module.reviewed_image_authority(release_id).items()}
def fixtures(module):
    rows=[]
    for role,entry in expected_authority.items():
        reference=entry["reference"]
        if entry["firstParty"]:
            image_id=f"sha256:{len(rows)+1:064x}"
            labels={
                "dk.andersmadsen.ai-pin-revival.component":entry["component"],
                "dk.andersmadsen.ai-pin-revival.product":"Ai Pin Revival",
                "dk.andersmadsen.ai-pin-revival.release":release_id,
                "dk.andersmadsen.ai-pin-revival.source-commit":source_git["commit"],
                "dk.andersmadsen.ai-pin-revival.source-tree":source_git["tree"],
                "org.opencontainers.image.revision":source_git["commit"],
            }
            registry=None;source_digest=None
        else:
            registry=copy.deepcopy(registry_preimages[reference])
            manifest=json.loads(base64.b64decode(registry["manifest"]["bytesBase64"]))
            image_id=manifest["config"]["digest"]
            labels=None;source_digest=reference.rsplit("@",1)[1]
        rows.append({"reference":reference,"bundleReference":entry["bundleReference"],
                     "firstParty":entry["firstParty"],"component":entry["component"],
                     "imageId":image_id,"labels":labels,"platform":"linux/arm64",
                     "registry":registry,"sourceDigest":source_digest})
    rows.sort(key=lambda row:row["reference"])
    role_rows={role:next(row for row in rows if row["reference"]==entry["reference"])
               for role,entry in expected_authority.items()}
    services={name:{"role":role,"reference":role_rows[role]["reference"],
                    "imageId":role_rows[role]["imageId"]}
              for name,role in module.SERVICE_ROLES.items()}
    model=copy.deepcopy(producer_model);model["services"]=services
    receipt={"schema":"revival.docker-image-receipt","schemaVersion":4,
             "platform":"linux/amd64","targetPlatform":"linux/arm64","bundle":{"sha256":bundle_digest,"size":bundle_size},
             "images":rows}
    return receipt,model
def invoke(module,receipt,model,helper=None):
    selected=module.BACKUP_HELPER_REFERENCE if helper is None else helper
    return module.validate_image_receipt(receipt,model,release_id,source_git,
                                         bundle_digest,bundle_size,selected)
def refused(module,rows,model,label):
    receipt={"schema":"revival.docker-image-receipt","schemaVersion":4,
             "platform":"linux/amd64","targetPlatform":"linux/arm64","bundle":{"sha256":bundle_digest,"size":bundle_size},
             "images":rows}
    try: invoke(module,receipt,model)
    except SystemExit: return
    raise AssertionError(f"{module.__name__} accepted {label}")
def refused_documents(module,receipt,model,label):
    try: invoke(module,receipt,model)
    except SystemExit: return
    raise AssertionError(f"{module.__name__} accepted {label}")
def object_paths(value,path=()):
    if type(value) is dict:
        yield path,value
        for key,child in value.items():
            yield from object_paths(child,path+(key,))
    elif type(value) is list:
        for index,child in enumerate(value):
            yield from object_paths(child,path+(index,))
def resolve(value,path):
    for part in path: value=value[part]
    return value
def wrong_type(value):
    if type(value) is bool: return 0
    if type(value) is int: return True
    if type(value) is str: return None
    if value is None: return {}
    if type(value) is list: return {}
    if type(value) is dict: return []
    raise AssertionError(f"unsupported fixture type: {type(value)}")
def forbidden_call(*arguments,**keywords):
    with open(marker,"wb") as output: output.write(b"called\n")
    raise AssertionError("mapping validation reached subprocess/Docker")
os.environ["PATH"]=fake_bin
for module in modules:
    assert authority_object(module)==expected_authority,(module.__name__,authority_object(module),expected_authority)
    module.subprocess.run=forbidden_call
    receipt,model=fixtures(module);rows=receipt["images"]
    accepted=invoke(module,receipt,model)
    if module.__name__=="mapping_runtime":
        returned=accepted[0]
        for role,entry in expected_authority.items():
            assert returned[entry["reference"]][0]==entry["bundleReference"]
    try: invoke(module,receipt,model,"ai-pin-revival/unused:tag")
    except SystemExit: pass
    else: raise AssertionError(f"{module.__name__} accepted caller-selected backup helper")
    pairs=0;center_spotify=False
    for left in range(10):
        for right in range(left+1,10):
            attacked=copy.deepcopy(rows);attacked[right]["imageId"]=attacked[left]["imageId"]
            roles=[]
            for index in (left,right):
                row=rows[index]
                roles.append(next(role for role,entry in expected_authority.items()
                                  if entry["reference"]==row["reference"]))
            center_spotify |= set(roles)=={"center","spotify-adapter"}
            refused(module,attacked,model,f"duplicate image IDs {left}/{right}");pairs+=1
    assert pairs==45 and center_spotify
    refused(module,rows[:-1],model,"missing image")
    extra=copy.deepcopy(rows)+[{"reference":f"ai-pin-revival/unused:{release_id}",
        "bundleReference":f"ai-pin-revival/unused:{release_id}","firstParty":True,
        "component":"unused","imageId":"sha256:"+"f"*64}]
    extra.sort(key=lambda row:row["reference"]);refused(module,extra,model,"extra image")
    helper_index=next(i for i,row in enumerate(rows) if row["reference"]==module.BACKUP_HELPER_REFERENCE)
    arbitrary=copy.deepcopy(rows);arbitrary[helper_index]={
        "reference":f"ai-pin-revival/unused:{release_id}",
        "bundleReference":f"ai-pin-revival/unused:{release_id}","firstParty":True,
        "component":"unused","imageId":rows[helper_index]["imageId"]}
    arbitrary.sort(key=lambda row:row["reference"])
    refused(module,arbitrary,model,"helper replaced by arbitrary unused first-party image")
    cosmos_alias=copy.deepcopy(rows);cosmos_alias[helper_index]={
        "reference":f"ai-pin-revival/cosmos-alias:{release_id}",
        "bundleReference":f"ai-pin-revival/cosmos-alias:{release_id}","firstParty":True,
        "component":"cosmos","imageId":rows[helper_index]["imageId"]}
    cosmos_alias.sort(key=lambda row:row["reference"])
    refused(module,cosmos_alias,model,"second cosmos-role alias reference")
    mismatch=copy.deepcopy(model);mismatch["services"]["center"]["role"]="cosmos"
    refused(module,rows,mismatch,"service role mismatch")
    mismatch=copy.deepcopy(model);mismatch["services"]["center"]["reference"]=model["services"]["edge"]["reference"]
    refused(module,rows,mismatch,"service reference mismatch")
    mismatch=copy.deepcopy(model);mismatch["services"]["center"]["imageId"]=model["services"]["spotify-adapter"]["imageId"]
    refused(module,rows,mismatch,"service image ID mismatch")
    wrong_helper=copy.deepcopy(rows);wrong_helper[helper_index]["firstParty"]=True;wrong_helper[helper_index]["component"]="backup-helper"
    refused(module,wrong_helper,model,"backup helper role mismatch")
    substitutions=0
    for role,entry in expected_authority.items():
        if entry["firstParty"]: continue
        attacked=copy.deepcopy(rows);attacked_model=copy.deepcopy(model)
        target=next(row for row in attacked if row["reference"]==entry["reference"])
        replacement=f"ai-pin-revival/{role}:{release_id}"
        target.update({"reference":replacement,"bundleReference":replacement,
                       "firstParty":True,"component":role})
        attacked.sort(key=lambda row:row["reference"])
        for mapping in attacked_model["services"].values():
            if mapping["role"]==role: mapping["reference"]=replacement
        refused(module,attacked,attacked_model,f"same-role first-party substitution for {role}")
        substitutions+=1
    assert substitutions==7
    non_boolean_attacks=0
    for row_index in range(10):
        for invalid in (0,1,"false","true",None,[],{}):
            attacked=copy.deepcopy(rows);attacked[row_index]["firstParty"]=invalid
            refused(module,attacked,model,f"non-Boolean firstParty row {row_index}: {invalid!r}")
            non_boolean_attacks+=1
    assert non_boolean_attacks==70
    component_attacks=0
    component_values=[None,*expected_authority]
    for row_index,row in enumerate(rows):
        expected_component=expected_authority[next(
            role for role,entry in expected_authority.items()
            if entry["reference"]==row["reference"])]["component"]
        for component in component_values:
            if component==expected_component: continue
            attacked=copy.deepcopy(rows);attacked[row_index]["component"]=component
            refused(module,attacked,model,f"component substitution row {row_index}: {component!r}")
            component_attacks+=1
    assert component_attacks==100
    reference_swaps=0
    for left in range(10):
        for right in range(left+1,10):
            attacked=copy.deepcopy(rows)
            attacked[left]["reference"],attacked[right]["reference"]=(
                attacked[right]["reference"],attacked[left]["reference"])
            attacked[left]["component"],attacked[right]["component"]=(
                attacked[right]["component"],attacked[left]["component"])
            attacked.sort(key=lambda row:row["reference"])
            refused(module,attacked,model,f"component/reference swap {left}/{right}")
            reference_swaps+=1
    assert reference_swaps==45

    # Every closed receipt/model object and every declared field is attacked
    # independently: missing, unknown, and type-confused. This includes all 10
    # image rows, all first-party label maps, all registry provenance records,
    # model authority/compose-file maps, and all 15 service mappings.
    object_count=field_count=schema_mutations=0
    for document_name,base in (("receipt",receipt),("model",model)):
        for path,current in object_paths(base):
            object_count+=1;field_count+=len(current)
            attacked_receipt=copy.deepcopy(receipt);attacked_model=copy.deepcopy(model)
            target=resolve(attacked_receipt if document_name=="receipt" else attacked_model,path)
            target["_unexpected"]=None
            refused_documents(module,attacked_receipt,attacked_model,
                              f"unknown field at {document_name}{path}")
            schema_mutations+=1
            for key,value in current.items():
                attacked_receipt=copy.deepcopy(receipt);attacked_model=copy.deepcopy(model)
                target=resolve(attacked_receipt if document_name=="receipt" else attacked_model,path)
                del target[key]
                refused_documents(module,attacked_receipt,attacked_model,
                                  f"missing field {document_name}{path+(key,)}")
                schema_mutations+=1
                attacked_receipt=copy.deepcopy(receipt);attacked_model=copy.deepcopy(model)
                target=resolve(attacked_receipt if document_name=="receipt" else attacked_model,path)
                target[key]=wrong_type(value)
                refused_documents(module,attacked_receipt,attacked_model,
                                  f"type confusion {document_name}{path+(key,)}")
                schema_mutations+=1
    assert (object_count,field_count,schema_mutations)==(55,256,567),(
        object_count,field_count,schema_mutations)

    # Arbitrary-but-unique local tags are never authority. Exercise every role,
    # including the tagless SearXNG digest whose only valid bundle tag is latest.
    assert expected_authority["searxng"]["bundleReference"]=="searxng/searxng:latest"
    assert expected_authority["backup-helper"]["bundleReference"]=="node:22.18.0-alpine3.22"
    for row_index,row in enumerate(rows):
        attacked=copy.deepcopy(receipt)
        attacked["images"][row_index]["bundleReference"]=f"evil.invalid/unique-{row_index}:locked"
        refused_documents(module,attacked,model,f"arbitrary unique bundle tag row {row_index}")
        attacked=copy.deepcopy(receipt);attacked["images"][row_index]["platform"]="linux/amd64"
        refused_documents(module,attacked,model,f"wrong platform row {row_index}")
    attacked=copy.deepcopy(receipt)
    attacked["images"][0],attacked["images"][1]=attacked["images"][1],attacked["images"][0]
    refused_documents(module,attacked,model,"noncanonical image inventory order")

    label_mutations=0;provenance_mutations=0
    for row_index,row in enumerate(rows):
        if row["firstParty"]:
            for key in row["labels"]:
                attacked=copy.deepcopy(receipt)
                attacked["images"][row_index]["labels"][key]="forged"
                refused_documents(module,attacked,model,f"label value {row_index}/{key}")
                label_mutations+=1
        else:
            attacked=copy.deepcopy(receipt)
            attacked["images"][row_index]["sourceDigest"]="sha256:"+"0"*64
            refused_documents(module,attacked,model,f"source digest row {row_index}")
            provenance_mutations+=1
            for record_name in ("index","manifest"):
                for key in ("bytesBase64","digest","mediaType","size"):
                    attacked=copy.deepcopy(receipt)
                    record=attacked["images"][row_index]["registry"][record_name]
                    if key=="bytesBase64":
                        record[key]=("B" if record[key][:1]=="A" else "A")+record[key][1:]
                    elif key=="digest": record[key]="sha256:"+"0"*64
                    elif key=="mediaType": record[key]="application/x-forged"
                    else: record[key]+=1
                    refused_documents(module,attacked,model,
                                      f"registry descriptor {row_index}/{record_name}/{key}")
                    provenance_mutations+=1
    assert label_mutations==18 and provenance_mutations==63

    for field,value in (("schema","revival.invalid"),("schemaVersion",3),
                        ("platform","linux/arm64"),("targetPlatform","linux/amd64")):
        attacked=copy.deepcopy(receipt);attacked[field]=value
        refused_documents(module,attacked,model,f"receipt exact value {field}")
    for field,value in (("sha256","0"*64),("size",bundle_size+1)):
        attacked=copy.deepcopy(receipt);attacked["bundle"][field]=value
        refused_documents(module,attacked,model,f"bundle exact value {field}")
    for field,value in (("schema","revival.invalid"),("schemaVersion",2),
                        ("releaseId","0"*64)):
        attacked=copy.deepcopy(model);attacked[field]=value
        refused_documents(module,receipt,attacked,f"model exact value {field}")
    for field,value in (("path","unreviewed.json"),("sha256","not-a-sha256")):
        attacked=copy.deepcopy(model);attacked["authority"][field]=value
        refused_documents(module,receipt,attacked,f"model authority exact value {field}")
    for compose_path in model["composeFiles"]:
        attacked=copy.deepcopy(model);attacked["composeFiles"][compose_path]="not-a-sha256"
        refused_documents(module,receipt,attacked,f"compose digest {compose_path}")
    for service,mapping in model["services"].items():
        alternatives=[row for row in rows if row["reference"]!=mapping["reference"]]
        for field,value in (("role","center" if mapping["role"]!="center" else "cosmos"),
                            ("reference",alternatives[0]["reference"]),
                            ("imageId",alternatives[0]["imageId"])):
            attacked=copy.deepcopy(model);attacked["services"][service][field]=value
            refused_documents(module,receipt,attacked,f"service exact value {service}/{field}")

    # Duplicate keys are rejected by the decoder itself; canonical byte tests
    # cover order, whitespace, LF framing, non-integer numbers, and UTF-8.
    canonical_cases=0
    for label,document in (("receipt",receipt),("model",model)):
        good=module.canonical(document)+b"\n"
        assert module.parse_canonical_json(good,label)==document
        reversed_document=dict(reversed(list(document.items())))
        noncanonical=[
            json.dumps(document,indent=2,ensure_ascii=False).encode()+b"\n",
            json.dumps(reversed_document,separators=(",",":"),ensure_ascii=False).encode()+b"\n",
            good[:-1],good+b"\n",
        ]
        first_key=sorted(document)[0]
        duplicate=("{"+json.dumps(first_key)+":"+
                   json.dumps(document[first_key],sort_keys=True,separators=(",",":"),ensure_ascii=False)+","+
                   good.decode("utf-8")[1:]).encode("utf-8")
        noncanonical.append(duplicate)
        for payload in noncanonical:
            try: module.parse_canonical_json(payload,label)
            except SystemExit: pass
            else: raise AssertionError(f"{module.__name__} accepted noncanonical {label} bytes")
            canonical_cases+=1
    for payload in (b'{"outer":{"x":1,"x":1}}\n',
                    b'{"a":1,"\\u0061":1}\n',b'{"a":1.0}\n',
                    b'{"a":9007199254740992}\n',b'{"a":NaN}\n',
                    b'{"":1}\n',b'{"\\u0001":1}\n',b'\xff'):
        try: module.parse_canonical_json(payload,"ambiguous")
        except SystemExit: pass
        else: raise AssertionError(f"{module.__name__} accepted ambiguous JSON {payload!r}")
        canonical_cases+=1
    assert canonical_cases==18
assert not os.path.exists(marker)
`;
  const result = childProcess.spawnSync("python3", ["-I", "-B", "-c", script,
    path.join(ROOT, "platform/deploy/vps/remote/candidate-runtime.py"),
    path.join(ROOT, "platform/deploy/vps/remote/held-compose.py"), marker, directory,
    JSON.stringify(expectedAuthority), JSON.stringify(parityModel),
    path.join(ROOT, "platform/deploy/acceptance/registry-preimages.json")], {
    encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(marker), false);
});

test("fixed third-party registry preimages reproduce the requested digest and unique linux/arm64 closure", () => {
  assert.deepEqual(Object.keys(PRODUCTION_REGISTRY_PREIMAGES).sort(), [...THIRD_PARTY_IMAGES].sort());
  for (const reference of THIRD_PARTY_IMAGES) {
    const evidence = PRODUCTION_REGISTRY_PREIMAGES[reference];
    assert.equal(verifyThirdPartyRegistryEvidence(reference, evidence), true);
    const rawIndex = JSON.parse(Buffer.from(evidence.index.bytesBase64, "base64"));
    assert.equal(rawIndex.mediaType, evidence.index.mediaType,
      `fixed registry index media type is not self-bound: ${reference}`);
    const substitutedType = evidence.index.mediaType === "application/vnd.oci.image.index.v1+json"
      ? "application/vnd.docker.distribution.manifest.list.v2+json"
      : "application/vnd.oci.image.index.v1+json";
    const substituted = structuredClone(evidence);
    substituted.index.mediaType = substitutedType;
    assert.equal(substituted.index.digest, evidence.index.digest);
    assert.equal(substituted.index.size, evidence.index.size);
    assert.equal(substituted.index.bytesBase64, evidence.index.bytesBase64);
    assert.throws(() => verifyThirdPartyRegistryEvidence(reference, substituted), /media type|provenance/u,
      `declared OCI/Docker index type substitution was accepted: ${reference}`);
  }
  const reference = THIRD_PARTY_IMAGES[0];
  const arbitrary = structuredClone(PRODUCTION_REGISTRY_PREIMAGES[reference]);
  const bytes = Buffer.from(arbitrary.index.bytesBase64, "base64");
  const document = JSON.parse(bytes);
  document.annotations = { arbitrary: "substitution" };
  const substituted = Buffer.from(JSON.stringify(document));
  arbitrary.index = {
    ...arbitrary.index,
    bytesBase64: substituted.toString("base64"),
    digest: `sha256:${sha256Bytes(substituted)}`,
    size: substituted.length,
  };
  assert.throws(() => verifyThirdPartyRegistryEvidence(reference, arbitrary), /digest|provenance/u);
  assert.throws(() => verifyThirdPartyRegistryEvidence(`evil.invalid/image@${arbitrary.index.digest}`, arbitrary), /fixed production inventory/u);
});

test("candidate verification binds Docker tar contents, tags, configs, and exact image closure", () => {
  const attacks = [
    (input) => {
      const records = input.imageTarRecords.map((record) => ({ ...record, data: Buffer.from(record.data) }));
      records.splice(-1, 0, { path: "unreferenced.txt", data: Buffer.from("not in manifest") });
      input.imageBundle = tarArchive(records);
    },
    (input) => {
      const manifest = structuredClone(input.imageManifest);
      manifest[0].RepoTags = ["evil.invalid/substitution:latest"];
      const records = input.imageTarRecords.slice(0, -1).map((record) => ({ ...record, data: Buffer.from(record.data) }));
      records.push({ path: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) });
      input.imageBundle = tarArchive(records);
    },
    (input) => {
      const records = input.imageTarRecords.map((record, index) => index === 0
        ? { ...record, data: Buffer.from(`${Buffer.from(record.data).toString("utf8")} `) }
        : { ...record, data: Buffer.from(record.data) });
      input.imageBundle = tarArchive(records);
    },
    (input) => {
      const layerIndex = input.imageTarRecords.findIndex((record) => record.path.endsWith("/layer.tar"));
      const records = input.imageTarRecords.map((record, index) => index === layerIndex
        ? { ...record, data: Buffer.from("valid tar slot, different layer bytes", "utf8") }
        : { ...record, data: Buffer.from(record.data) });
      input.imageBundle = tarArchive(records);
    },
    (input) => {
      const records = input.imageTarRecords.map((record) => record.path === "repositories"
        ? { ...record, data: Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(record.data)), "evil.invalid/extra": { latest: "forged" } })) }
        : { ...record, data: Buffer.from(record.data) });
      input.imageBundle = tarArchive(records);
    },
    (input) => {
      input.imageBundle = tarArchive(input.imageTarRecords.filter((record) => record.path !== "repositories"));
    },
    (input) => {
      input.imageBundle = tarArchive(input.imageTarRecords.map((record) => record.path.endsWith("/VERSION")
        ? { ...record, data: Buffer.from("1.1\n") }
        : record));
    },
    (input) => {
      let changed = false;
      input.imageBundle = tarArchive(input.imageTarRecords.map((record) => {
        if (!changed && record.path.endsWith("/json")) {
          changed = true;
          return { ...record, data: Buffer.from(JSON.stringify({ id: "wrong", parent: "comment-cannot-fix-this" })) };
        }
        return record;
      }));
    },
  ];
  for (const attack of attacks) {
    const input = fixture();
    attack(input);
    input.imageReceipt.bundle = { sha256: sha256Bytes(input.imageBundle), size: input.imageBundle.length };
    const dataDir = tempData();
    try { assert.throws(() => sealCandidateFromBuffers({ dataDir, ...input }), /Docker|image|archive|config|unreferenced|tag/u); }
    finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  }
});

test("candidate verification walks release.tar.gz entry-by-entry and binds the verifier", () => {
  const extra = fixture();
  extra.releaseArchive = gzipSync(tarArchive([
    { path: "README.md", data: Buffer.from("source") },
    { path: "platform/deploy/vps/verify-release.py", data: extra.releaseVerifier, mode: 0o755 },
    { path: "unexpected", data: Buffer.from("surprise") },
  ]), { level: 9, mtime: 0 });
  const wrongVerifier = fixture();
  wrongVerifier.releaseVerifier = Buffer.from("#!/usr/bin/env python3\nprint('different')\n");
  const wrongDigest = fixture();
  wrongDigest.releaseArchive = gzipSync(tarArchive([
    { path: "README.md", data: Buffer.from("forged") },
    { path: "platform/deploy/vps/verify-release.py", data: wrongDigest.releaseVerifier, mode: 0o755 },
  ]), { level: 9, mtime: 0 });
  for (const input of [extra, wrongVerifier, wrongDigest]) {
    const dataDir = tempData();
    try { assert.throws(() => sealCandidateFromBuffers({ dataDir, ...input }), /release archive|release verifier|file set|metadata|digest|bound/u); }
    finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  }
});

test("source provenance digest is independently recomputed from source-snapshot.tar", () => {
  const mismatchedDigest = fixture();
  mismatchedDigest.sourceReceipt.archiveSha256 = "0".repeat(64);
  const differentTree = fixture();
  differentTree.sourceArchive = sourceGitFixture(Buffer.from("other!", "utf8")).archive;
  differentTree.sourceReceipt.archiveSha256 = sha256Bytes(differentTree.sourceArchive);
  for (const input of [mismatchedDigest, differentTree]) {
    const dataDir = tempData();
    try { assert.throws(() => sealCandidateFromBuffers({ dataDir, ...input }), /source snapshot|source-snapshot|Git tree/u); }
    finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  }
});

test("a valid but unrelated raw Git source cannot reuse another VPS release", (t) => {
  const commit = childProcess.spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  const tree = childProcess.spawnSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  const commitResult = childProcess.spawnSync("git", ["cat-file", "commit", commit], { cwd: ROOT, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(commitResult.status, 0, commitResult.stderr?.toString());
  const scratch = tempData();
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const archivePath = path.join(scratch, "source.tar");
  const gitHome = path.join(scratch, "git-home");
  fs.mkdirSync(gitHome, { mode: 0o700 });
  createRawGitArchive(commit, archivePath, candidateGitEnvironment(gitHome));
  const input = fixture();
  input.sourceArchive = fs.readFileSync(archivePath);
  input.sourceCommitObject = commitResult.stdout;
  input.sourceReceipt = { ...input.sourceReceipt, archiveSha256: sha256Bytes(input.sourceArchive), commit, tree };
  const image = imageFixture(input.releaseDescriptor.releaseId, commit, tree);
  input.imageBundle = image.bundle;
  input.imageReceipt = image.receipt;
  input.composeModel = createProductionComposeModel({
    releaseId: input.releaseDescriptor.releaseId,
    trustedThirdPartyImages: TEST_THIRD_PARTY_REFERENCES,
    imageReceipt: image.receipt,
  });
  const dataDir = tempData();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  assert.throws(() => sealCandidateFromBuffers({ dataDir, ...input }), /release profile|deterministic projection|trusted release config/u);
});

test("raw candidate source excludes ignored/context debris and worktree substitutions", (t) => {
  const repository = tempData();
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const git = (...args) => childProcess.spawnSync("git", args, { cwd: repository, encoding: "utf8" });
  assert.equal(git("init", "--quiet").status, 0);
  fs.writeFileSync(path.join(repository, ".gitignore"), "ignored-output/\n");
  fs.writeFileSync(path.join(repository, ".dockerignore"), "ignored-output/\n");
  fs.writeFileSync(path.join(repository, "tracked.txt"), "committed bytes\n");
  assert.equal(git("add", ".").status, 0);
  assert.equal(git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture").status, 0);
  const commit = git("rev-parse", "HEAD").stdout.trim();
  fs.writeFileSync(path.join(repository, "tracked.txt"), "dirty worktree substitution\n");
  fs.mkdirSync(path.join(repository, "ignored-output"), { mode: 0o700 });
  fs.writeFileSync(path.join(repository, "ignored-output", "poison.bin"), "ignored poison\n");
  const home = path.join(repository, "isolated-home");
  fs.mkdirSync(home, { mode: 0o700 });
  const archive = path.join(repository, "raw-source.tar");
  createRawGitArchive(commit, archive, candidateGitEnvironment(home), repository);
  const listing = childProcess.spawnSync("tar", ["-tf", archive], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.doesNotMatch(listing.stdout, /ignored-output|isolated-home|raw-source\.tar/u);
  const tracked = childProcess.spawnSync("tar", ["-xOf", archive, "tracked.txt"], { encoding: "utf8" });
  assert.equal(tracked.status, 0, tracked.stderr);
  assert.equal(tracked.stdout, "committed bytes\n");
});

test("candidate Git execution uses a positive environment and ignores ambient Git/config channels", (t) => {
  const root = tempData();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const environment = candidateGitEnvironment(home);
  assert.equal(environment.HOME, home);
  assert.equal(environment.XDG_CONFIG_HOME, path.join(home, "xdg"));
  assert.equal(environment.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(environment.GIT_CONFIG_SYSTEM, "/dev/null");
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(environment.GIT_NO_REPLACE_OBJECTS, "1");
  assert.equal(environment.GIT_CONFIG_COUNT, "4");
  for (const poisoned of ["GIT_DIR", "GIT_WORK_TREE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_INDEX_FILE", "GIT_CEILING_DIRECTORIES"]) {
    assert.equal(environment[poisoned], undefined);
  }
  assert.equal(new Set(Object.keys(environment).filter((key) => /^GIT_CONFIG_KEY_/u.test(key))).size, 4);
  assert.ok(Object.values(environment).includes("/dev/null"));
});

test("prepare strips poisoned Git directories, configs, filters, and hooks before resolving HEAD", (t) => {
  const root = tempData();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const poisonHome = path.join(root, "poison-home");
  const hooks = path.join(root, "hooks");
  const marker = path.join(root, "HOOK-RAN");
  fs.mkdirSync(poisonHome, { mode: 0o700 });
  fs.mkdirSync(hooks, { mode: 0o700 });
  fs.writeFileSync(path.join(hooks, "post-checkout"), `#!/bin/sh\nprintf unsafe >${JSON.stringify(marker)}\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(poisonHome, ".gitconfig"), [
    "[core]", `\thooksPath = ${hooks}`,
    "[filter \"ambient\"]", "\tclean = /bin/false", "\tsmudge = /bin/false", "",
  ].join("\n"));
  const tool = path.join(ROOT, "platform/deploy/release-candidate.mjs");
  const result = childProcess.spawnSync(process.execPath, [tool, "prepare", "--commit", "HEAD", "--data-dir", root, "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: poisonHome,
      XDG_CONFIG_HOME: poisonHome,
      GIT_DIR: path.join(root, "not-the-repository"),
      GIT_WORK_TREE: root,
      GIT_OBJECT_DIRECTORY: path.join(root, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(root, "alternates"),
      GIT_CONFIG_GLOBAL: path.join(poisonHome, ".gitconfig"),
      GIT_CONFIG_SYSTEM: path.join(poisonHome, ".gitconfig"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: hooks,
    },
    timeout: 30_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /incompatible with the live legacy production contract|production authority|candidate source|selected commit does not contain the byte-identical reviewed candidate\/deployment protocol|release candidate preparation requires a native linux\/amd64 builder and refused before Docker/u,
  );
  assert.equal(fs.existsSync(marker), false);
});

test("protocol gate requires reviewed bytes and cannot be satisfied by comment markers", (t) => {
  assert.equal(assertImmutableCandidateProtocol(ROOT), true);
  const snapshot = tempData();
  t.after(() => fs.rmSync(snapshot, { recursive: true, force: true }));
  const fixed = [
    "compose.yaml",
    "platform/compose/production.yaml",
    "platform/deploy/candidate-store.py",
    "platform/deploy/production-compose-authority.json",
    "platform/deploy/release-candidate.mjs",
    "platform/deploy/release.json",
    "platform/deploy/release.mjs",
    "platform/cli/production.js",
  ];
  for (const relative of fixed) {
    const destination = path.join(snapshot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), destination);
    fs.chmodSync(destination, fs.statSync(path.join(ROOT, relative)).mode & 0o777);
  }
  fs.cpSync(path.join(ROOT, "platform/deploy/vps"), path.join(snapshot, "platform/deploy/vps"), { recursive: true, preserveTimestamps: true });
  assert.equal(assertImmutableCandidateProtocol(snapshot), true);
  const protocolPaths = [...fixed];
  const walk = (directory, relative) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const child = `${relative}/${name}`;
      if (fs.statSync(absolute).isDirectory()) walk(absolute, child);
      else protocolPaths.push(child);
    }
  };
  walk(path.join(snapshot, "platform/deploy/vps"), "platform/deploy/vps");
  const protocolManifest = {
    entries: protocolPaths.sort().map((relative) => {
      const bytes = fs.readFileSync(path.join(snapshot, relative));
      return {
        mode: (fs.statSync(path.join(snapshot, relative)).mode & 0o111) === 0 ? "0644" : "0755",
        path: relative,
        sha256: sha256Bytes(bytes),
        size: bytes.length,
      };
    }),
  };
  assert.equal(assertReleaseProtocolManifestMatchesTrusted(protocolManifest, snapshot), true);
  const remote = path.join(snapshot, "platform/deploy/vps/remote/deploy.sh");
  fs.writeFileSync(remote, [
    "#!/usr/bin/env bash",
    "# --candidate-id --candidate-root",
    '# docker image load --input "$candidate_store/images.tar"',
    "# --pull never --no-build",
    "exit 0",
    "",
  ].join("\n"));
  assert.throws(() => assertImmutableCandidateProtocol(snapshot), /byte-identical reviewed/u);
  const spoofedManifest = structuredClone(protocolManifest);
  spoofedManifest.entries.find((entry) => entry.path === "platform/deploy/vps/remote/deploy.sh").sha256 = sha256Bytes(fs.readFileSync(remote));
  assert.throws(() => assertReleaseProtocolManifestMatchesTrusted(spoofedManifest, ROOT), /protocol bytes differ/u);
});

test("complete toolchain and source receipts are mandatory", () => {
  const missingTool = fixture();
  missingTool.toolchainReceipt.tools.pop();
  const dirty = fixture(); dirty.sourceReceipt.clean = false;
  const moving = fixture(); moving.sourceReceipt.detached = false;
  for (const input of [missingTool, dirty, moving]) {
    const dataDir = tempData();
    try { assert.throws(() => sealCandidateFromBuffers({ dataDir, ...input }), /toolchain|source snapshot/u); }
    finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  }
});

test("live legacy compatibility accepts only the exact legacy production contract", () => {
  assert.equal(assertLegacyProductionCompatible(structuredClone(LEGACY_PRODUCTION_STATE)), true);
  const incompatible = structuredClone(LEGACY_PRODUCTION_STATE);
  incompatible.projectFamily = "renamed-project";
  incompatible.storageFamily = "renamed-storage";
  incompatible.volumes = incompatible.volumes.map((entry) => entry.replaceAll("carry", "renamed")).sort();
  incompatible.externalNetworks = ["renamed-local"];
  const differences = productionCompatibilityDifferences(incompatible);
  assert.deepEqual(differences.map((entry) => entry.field), ["projectFamily", "storageFamily", "volumes", "externalNetworks"]);
  assert.throws(() => assertLegacyProductionCompatible(incompatible), (error) => {
    assert.equal(error.code, "PRODUCTION_STATE_INCOMPATIBLE");
    assert.match(error.message, /before upload or Docker\/runtime mutation/u);
    return true;
  });
  for (const poison of [
    (value) => { value.projectFamily = "humane-cosmos-clone"; },
    (value) => { value.storageFamily = "humane-cosmos-clone"; },
    (value) => { value.volumes[0] = "humane-cosmos-clone_cosmos-pgdata"; value.volumes.sort(); },
    (value) => { value.externalNetworks = ["humane-cosmos-clone_cosmos-local"]; },
    (value) => { value.centerDataPath = FORBIDDEN_RENAMED_PRODUCTION_RESOURCES.centerDataPaths[0]; },
  ]) {
    const poisoned = structuredClone(LEGACY_PRODUCTION_STATE);
    poison(poisoned);
    assert.throws(() => assertLegacyProductionCompatible(poisoned), /before upload or Docker\/runtime mutation/u);
  }
});

test("production-state gate binds exact reviewed Compose/common bytes and validates the effective long-form model", (t) => {
  const current = productionStateForSnapshot(ROOT);
  const trustedComposeModel = createProductionComposeModel({ releaseId: "a".repeat(64) });
  assert.deepEqual(current, LEGACY_PRODUCTION_STATE);
  assert.equal(current.projectFamily, "humane-carry-clone");
  assert.equal(assertLegacyProductionCompatible(current), true);
  const renamedState = {
    ...LEGACY_PRODUCTION_STATE,
    centerDataPath: FORBIDDEN_RENAMED_PRODUCTION_RESOURCES.centerDataPaths[0],
  };
  assert.throws(() => assertOfflineProductionAuthority({ entries: [] }, renamedState, trustedComposeModel),
    /reviewed effective Compose authority/u);
  assert.throws(() => assertOfflineProductionAuthority({ entries: [] }, current, trustedComposeModel),
    /protocol file set differs/u);
  const snapshot = tempData();
  t.after(() => fs.rmSync(snapshot, { recursive: true, force: true }));
  for (const relative of [
    "compose.yaml", "platform/compose/production.yaml", "platform/deploy/production-compose-authority.json",
    "platform/deploy/release.json", "platform/deploy/vps/remote/common.sh",
  ]) {
    const destination = path.join(snapshot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), destination);
  }
  assert.deepEqual(productionStateForSnapshot(snapshot, snapshot), current);
  for (const injection of [
    "\nx-carry-decoy:\n  volumes: [humane-carry-clone_carry-state]\n",
    "\nservices:\n  inactive:\n    profiles: [never]\n",
    "\ninclude: [decoy.yaml]\n",
    "\nservices:\n  center:\n    extends: decoy\n",
    "\nvolumes:\n  cosmos-state:\n    external: true\n    name: humane-carry-clone_carry-state\n",
  ]) {
    const mutated = tempData();
    t.after(() => fs.rmSync(mutated, { recursive: true, force: true }));
    fs.cpSync(snapshot, mutated, { recursive: true });
    fs.appendFileSync(path.join(mutated, "platform/compose/production.yaml"), injection);
    assert.throws(() => productionStateForSnapshot(mutated), /exact reviewed bytes|differs/u);
  }

  const authority = JSON.parse(fs.readFileSync(path.join(ROOT, "platform/deploy/production-compose-authority.json"), "utf8"));
  assert.equal(authority.schemaVersion, 3);
  assert.deepEqual(authority.forbiddenRenamedResources, FORBIDDEN_RENAMED_PRODUCTION_RESOURCES);
  const model = {
    name: authority.effective.projectName,
    networks: Object.fromEntries(Object.entries(authority.effective.resources.networks).map(([name, external]) => [name, external === null ? {} : { external: true, name: external }])),
    services: Object.fromEntries(authority.effective.activeServices.map((name) => [name, {
      image: authority.effective.serviceImages[name].reference.replace("{releaseId}", "compose-authority-probe"),
      networks: {},
      volumes: [],
    }])),
    volumes: Object.fromEntries(Object.entries(authority.effective.resources.volumes).map(([name, external]) => [name, external === null ? {} : { external: true, name: external }])),
  };
  for (const [logical, volume] of Object.entries(authority.effective.protectedVolumes)) {
    for (const grant of volume.grants) model.services[grant.service].volumes.push({ type: "volume", source: logical, target: grant.target, read_only: grant.readOnly });
  }
  for (const [logical, network] of Object.entries(authority.effective.protectedNetworks)) {
    for (const service of network.services) model.services[service].networks[logical] = {};
  }
  model.services.center.volumes.push({
    type: "bind", source: authority.effective.centerData.source, target: "/data", read_only: false,
  });
  assert.equal(validateEffectiveComposeConfig(model, authority), true);
  for (const poison of [
    (value) => { value.name = "humane-cosmos-clone"; },
    (value) => {
      value.services.center.volumes.find((entry) => entry.target === "/data").source =
        FORBIDDEN_RENAMED_PRODUCTION_RESOURCES.centerDataPaths[0];
    },
    (value) => { value.volumes["cosmos-state"].name = "humane-cosmos-clone_cosmos-state"; },
    (value) => { value.networks["local-model"].name = "humane-cosmos-clone_cosmos-local"; },
    (value) => { value.services[authority.effective.protectedVolumes["cosmos-state"].grants[0].service].volumes[0].target = "/var/lib/cosmos"; },
  ]) {
    const poisoned = structuredClone(model);
    poison(poisoned);
    assert.throws(() => validateEffectiveComposeConfig(poisoned, authority),
      /hosted Compose|protected|Center|forbidden/u);
  }
  const mutations = [
    (value) => { value.services.center.volumes.find((entry) => entry.target === "/data").source = "/wrong"; },
    (value) => { value.services.center.volumes.find((entry) => entry.target === "/data").type = "volume"; },
    (value) => { delete value.services[authority.effective.protectedVolumes["cosmos-state"].grants[0].service].volumes[0]; },
    (value) => { value.volumes["cosmos-state"].name = "renamed"; },
    (value) => { value.services[authority.effective.protectedNetworks["local-model"].services[0]].networks = {}; },
    (value) => {
      const center = value.services.center.image;
      value.services.center.image = value.services["spotify-adapter"].image;
      value.services["spotify-adapter"].image = center;
    },
    (value) => { value.services.inactive = { profiles: ["never"], volumes: [], networks: {} }; },
  ];
  for (const mutate of mutations) {
    const poisoned = structuredClone(model); mutate(poisoned);
    assert.throws(() => validateEffectiveComposeConfig(poisoned, authority), /hosted Compose|protected|Center/u);
  }

  const synthetic = tempData();
  t.after(() => fs.rmSync(synthetic, { recursive: true, force: true }));
  const sealed = sealCandidateFromBuffers({ dataDir: synthetic, ...fixture() });
  assert.throws(() => verifyFixtureCandidate(sealed.root, { enforceTrustedProtocol: true }),
    /exact image role\/reference|reviewed effective Compose authority|protocol file set differs/u);
});

test("a structurally valid renamed-state candidate seals but remains intentionally non-promotable", (t) => {
  const dataDir = tempData();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const productionState = structuredClone(LEGACY_PRODUCTION_STATE);
  productionState.projectFamily = "renamed-project";
  const sealed = sealCandidateFromBuffers({ dataDir, ...fixture({ productionState }) });
  assert.equal(verifyFixtureCandidate(sealed.root).candidateId, sealed.candidateId);
  assert.throws(() => assertLegacyProductionCompatible(sealed.productionState), /incompatible/u);
});

test("candidate verify and inspect views cannot weaken the fixed production image policy", (t) => {
  const dataDir = tempData();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const sealed = sealCandidateFromBuffers({ dataDir, ...fixture() });
  const tool = path.join(ROOT, "platform/deploy/release-candidate.mjs");
  for (const command of ["verify", "inspect"]) {
    const result = childProcess.spawnSync(process.execPath, [tool, command, "--candidate", sealed.root, "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, PATH: "/nonexistent" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fixed reference inventory|third-party image policy|exact image role\/reference/u);
  }
  const output = verifyFixtureCandidate(sealed.root);
  assert.equal(output.candidateId, sealed.candidateId);
  assert.equal(output.release.releaseId, sealed.release.releaseId);
});

test("operator candidate and recovery docs name the protected legacy predecessor authority", () => {
  const cliReference = fs.readFileSync(path.join(ROOT, "docs/cli-reference.md"), "utf8");
  const recovery = fs.readFileSync(path.join(ROOT, "docs/recovery.md"), "utf8");
  for (const command of ["prepare", "verify", "inspect"]) {
    assert.match(cliReference, new RegExp(`revival release candidate ${command}`, "u"));
  }
  for (const document of [cliReference, recovery]) {
    assert.ok(document.includes(LEGACY_PRODUCTION_STATE.centerDataPath));
    assert.ok(document.includes(LEGACY_PRODUCTION_STATE.volumes.find((name) => name.endsWith("_carry-state"))));
    assert.ok(document.includes(LEGACY_PRODUCTION_STATE.volumes.find((name) => name.endsWith("_carry-pgdata"))));
    assert.ok(!document.includes(LEGACY_PRODUCTION_STATE.centerDataPath.replace("carry-center", "cosmos-center")));
    assert.doesNotMatch(document, /humane-cosmos-clone_cosmos-(?:state|pgdata)/u);
  }
});

test("remote publication helpers reject symlink ancestry, replacements, and no-replace collisions", (t) => {
  const directory = tempData();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = path.join(ROOT, "platform/deploy/vps/remote/candidate-runtime.py");
  const store = path.join(ROOT, "platform/deploy/vps/remote/release-store.py");
  const script = String.raw`
import errno,hashlib,importlib.util,os,stat,sys
root,runtime_path,store_path=sys.argv[1:]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path); module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module); return module
runtime=load("candidate_runtime",runtime_path); store=load("release_store",store_path)
real=os.path.join(root,"real"); os.mkdir(real,0o700)
os.symlink(real,os.path.join(root,"linked"))
for opener in (runtime.open_directory,store.open_absolute):
    try: opener(os.path.join(root,"linked"))
    except OSError: pass
    else: raise AssertionError("symlink ancestry was accepted")
parent_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
    runtime.write_once(parent_fd,"evidence",b"held evidence\n")
    runtime.write_once(parent_fd,"evidence",b"held evidence\n")
    store.write_once(parent_fd,"package-verification",b"verified\n")
    store.write_once(parent_fd,"package-verification",b"verified\n")
    source,source_meta=store.open_regular(parent_fd,"evidence",1024)
    try:
        store.publish_file(source,source_meta,parent_fd,"published")
        store.publish_file(source,source_meta,parent_fd,"published")
    finally: os.close(source)
    assert open(os.path.join(root,"published"),"rb").read()==b"held evidence\n"
    os.mkdir("source",0o700,dir_fd=parent_fd)
    source_fd=os.open("source",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent_fd)
    original=os.fstat(source_fd)
    os.rename("source","original",src_dir_fd=parent_fd,dst_dir_fd=parent_fd)
    os.mkdir("source",0o700,dir_fd=parent_fd)
    try: store.require_same_child(parent_fd,"source",original,"fixture")
    except SystemExit: pass
    else: raise AssertionError("incoming replacement was accepted")
    os.mkdir("destination",0o700,dir_fd=parent_fd)
    try: store.rename_no_replace(parent_fd,"source",parent_fd,"destination")
    except OSError as error: assert error.errno==errno.EEXIST
    else: raise AssertionError("no-replace publication replaced a destination")
    assert stat.S_ISDIR(os.stat("source",dir_fd=parent_fd,follow_symlinks=False).st_mode)
    assert stat.S_ISDIR(os.stat("destination",dir_fd=parent_fd,follow_symlinks=False).st_mode)
    os.mkdir("tree",0o700,dir_fd=parent_fd)
    tree_fd=os.open("tree",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent_fd)
    payload=b"release bytes\n"
    file_fd=os.open("entry",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644,dir_fd=tree_fd)
    os.write(file_fd,payload); os.close(file_fd)
    manifest={"entries":[{"path":"entry","sha256":hashlib.sha256(payload).hexdigest(),"size":len(payload),"mode":"0644"}]}
    store.verify_tree_metadata(tree_fd,manifest)
    os.link("entry","linked-entry",src_dir_fd=tree_fd,dst_dir_fd=parent_fd,follow_symlinks=False)
    try: store.verify_tree_metadata(tree_fd,manifest)
    except SystemExit: pass
    else: raise AssertionError("hardlinked release authority was accepted")
    os.unlink("linked-entry",dir_fd=parent_fd)
    os.close(tree_fd)
    os.close(source_fd)
finally: os.close(parent_fd)
`;
  const result = childProcess.spawnSync("python3", ["-I", "-B", "-c", script, directory, runtime, store], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("bootstrap and release staging retirement preserve exchanged outside directories", (t) => {
  const directory = tempData();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bootstrap = path.join(ROOT, "platform/deploy/vps/remote/bootstrap-release.py");
  const releaseStore = path.join(ROOT, "platform/deploy/vps/remote/release-store.py");
  const script = String.raw`
import ctypes,importlib.util,os,stat,sys
root,*helpers=sys.argv[1:]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path); module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module); return module
def exchange(source_parent,source,destination_parent,destination):
    function=getattr(ctypes.CDLL(None,use_errno=True),"renameat2",None)
    assert function is not None
    assert function(source_parent,os.fsencode(source),destination_parent,os.fsencode(destination),2)==0
for index,helper in enumerate(helpers):
    module=load(f"retirement_{index}",helper)
    case=os.path.join(root,str(index)); os.mkdir(case,0o700)
    parent=os.open(case,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        os.mkdir("managed",0o700,dir_fd=parent)
        held=os.open("managed",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
        managed=os.open("managed-bytes",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=held)
        os.write(managed,b"managed survives\n"); os.fchmod(managed,0o600); os.close(managed)
        expected=os.fstat(held)
        os.mkdir("outside",0o700,dir_fd=parent)
        outside=os.open("outside",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
        victim=os.open("victim",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=outside)
        os.write(victim,b"outside survives\n"); os.fchmod(victim,0o600); os.close(victim); os.close(outside)
        original=module.rename_no_replace; fired=False
        def race(source_parent,source,destination_parent,destination):
            global fired
            if source=="managed" and not fired:
                fired=True; exchange(source_parent,source,parent,"outside")
            original(source_parent,source,destination_parent,destination)
        module.rename_no_replace=race
        try:
            try: module.retire_named_tree(parent,"managed",held,expected)
            except SystemExit: pass
            else: raise AssertionError("bootstrap retirement accepted an exchanged root")
        finally: module.rename_no_replace=original; os.close(held)
        assert fired
        outside=os.open("outside",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
        managed=os.open("managed-bytes",os.O_RDONLY|os.O_NOFOLLOW,dir_fd=outside)
        assert os.read(managed,64)==b"managed survives\n"; os.close(managed); os.close(outside)
        preserved=False
        for name in os.listdir(parent):
            if not (name.startswith(".bootstrap-retired-") or name.startswith(".release-retired-")): continue
            retired=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
            try:
                victim=os.open("victim",os.O_RDONLY|os.O_NOFOLLOW,dir_fd=retired)
                preserved=os.read(victim,64)==b"outside survives\n"; os.close(victim)
            finally: os.close(retired)
        assert preserved
    finally: os.close(parent)
`;
  const result = childProcess.spawnSync("python3", ["-I", "-B", "-c", script, directory, bootstrap, releaseStore], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("every retirement store refuses pre-commit exchanges and rejects post-commit receipt substitution on read", (t) => {
  const directory = tempData();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const helpers = [
    ["candidate", path.join(ROOT, "platform/deploy/candidate-store.py"), ".candidate-retired-"],
    ["retention", path.join(ROOT, "platform/deploy/vps/remote/retention-store.py"), ".prune-retired-"],
    ["release", path.join(ROOT, "platform/deploy/vps/remote/release-store.py"), ".release-retired-"],
    ["bootstrap", path.join(ROOT, "platform/deploy/vps/remote/bootstrap-release.py"), ".bootstrap-retired-"],
  ];
  const script = String.raw`
import ctypes,importlib.util,os,stat,sys
base=sys.argv[1]; specifications=[]
arguments=sys.argv[2:]
for offset in range(0,len(arguments),3): specifications.append(tuple(arguments[offset:offset+3]))

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

def exchange(source_parent,source,destination_parent,destination):
    function=getattr(ctypes.CDLL(None,use_errno=True),"renameat2",None)
    assert function is not None
    result=function(source_parent,os.fsencode(source),destination_parent,os.fsencode(destination),2)
    if result:
        error=ctypes.get_errno(); raise OSError(error,os.strerror(error))

def make_file(parent,name,payload):
    descriptor=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
    os.write(descriptor,payload); os.fchmod(descriptor,0o600)
    metadata=os.fstat(descriptor); os.close(descriptor); return metadata

def stable(value):
    return (value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_nlink,
            value.st_uid,value.st_gid,stat.S_IMODE(value.st_mode),stat.S_IFMT(value.st_mode))

def inode(value): return value.st_dev,value.st_ino

def find_inode(root,expected):
    found=[]; pending=[root]
    while pending:
        current=pending.pop()
        with os.scandir(current) as entries:
            for entry in entries:
                value=entry.stat(follow_symlinks=False)
                if inode(value)==expected: found.append(entry.path)
                if stat.S_ISDIR(value.st_mode): pending.append(entry.path)
    return found

def read_regular(path):
    descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        result=b""
        while True:
            block=os.read(descriptor,65536)
            if not block: return result
            result+=block
    finally: os.close(descriptor)

def make_managed(parent,name):
    os.mkdir(name,0o700,dir_fd=parent)
    root=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    files={}
    try:
        for filename,payload in (("anchor",b"managed anchor\n"),("slot",b"managed slot\n"),("empty",b"")):
            metadata=make_file(root,filename,payload); files[inode(metadata)]=(stable(metadata),payload)
        os.mkdir("branch",0o700,dir_fd=root)
        branch=os.open("branch",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root)
        try:
            os.mkdir("deep",0o700,dir_fd=branch)
            deep=os.open("deep",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=branch)
            try:
                metadata=make_file(deep,"payload",b"managed nested payload\n")
                files[inode(metadata)]=(stable(metadata),b"managed nested payload\n")
            finally: os.close(deep)
        finally: os.close(branch)
        root_metadata=os.fstat(root)
    finally: os.close(root)
    return root_metadata,files

def make_substitute(case,parent,kind):
    sentinel=os.path.join(case,"sentinel")
    os.mkdir("sentinel",0o700,dir_fd=parent)
    sentinel_fd=os.open("sentinel",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    sentinel_metadata=make_file(sentinel_fd,"sentinel-bytes",b"symlink target survives\n")
    os.close(sentinel_fd)
    details={"kind":kind,"sentinel":sentinel,"sentinel_inode":inode(sentinel_metadata)}
    if kind=="directory":
        os.mkdir("outside",0o700,dir_fd=parent)
        outside=os.open("outside",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
        marker=make_file(outside,"substitute-marker",b"directory substitute survives\n")
        os.close(outside); details["marker_inode"]=inode(marker)
    elif kind=="symlink":
        os.symlink(sentinel,"outside",dir_fd=parent)
    elif kind=="hardlink":
        make_file(parent,"outside-backing",b"hardlink substitute survives\n")
        os.link("outside-backing","outside",src_dir_fd=parent,dst_dir_fd=parent,follow_symlinks=False)
    else:
        make_file(parent,"outside",b"regular substitute survives\n")
    substitute=os.stat("outside",dir_fd=parent,follow_symlinks=False)
    details["inode"]=inode(substitute); details["stable"]=stable(substitute)
    return details

def current_top(parent,source,prefix):
    try:
        os.stat(source,dir_fd=parent,follow_symlinks=False); return source
    except FileNotFoundError: pass
    matches=[name for name in os.listdir(parent) if name.startswith(prefix)]
    assert len(matches)==1,matches
    return matches[0]

def attack(parent,source,prefix,scope,kind):
    top=current_top(parent,source,prefix)
    if scope=="top":
        exchange(parent,top,parent,"outside"); return
    root=os.open(top,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    try:
        if kind=="directory":
            exchange(root,"branch",parent,"outside")
        elif kind=="nested-directory":
            branch=os.open("branch",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root)
            try: exchange(branch,"deep",parent,"outside")
            finally: os.close(branch)
        else:
            exchange(root,"slot",parent,"outside")
    finally: os.close(root)

def invoke(module,role,parent,name,metadata):
    if role=="candidate":
        return module.cleanup(parent,name,inode(metadata))
    if role=="retention":
        plan=module.capture(parent,name,"release")
        return module.remove(parent,name,"release",plan["authorityToken"])
    held=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    try: return module.retire_named_tree(parent,name,held,metadata)
    finally: os.close(held)

def expected_receipt(module,prefix,parent,name):
    held=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    authority=None
    try:
        authority=module.RetirementAuthority(held)
        return prefix+authority.digest[:32]
    finally:
        if authority is not None: authority.close()
        os.close(held)

def prove_preserved(case,managed_files,substitute):
    for expected,(expected_stable,payload) in managed_files.items():
        locations=find_inode(case,expected)
        assert locations,("managed inode disappeared",expected)
        assert stable(os.stat(locations[0],follow_symlinks=False))==expected_stable
        assert read_regular(locations[0])==payload
    locations=find_inode(case,substitute["inode"])
    assert locations,("substitute inode disappeared",substitute)
    for location in locations:
        assert stable(os.stat(location,follow_symlinks=False))==substitute["stable"]
    kind=substitute["kind"]
    if kind=="regular": assert read_regular(locations[0])==b"regular substitute survives\n"
    elif kind=="hardlink":
        assert len(locations)==2
        assert all(read_regular(location)==b"hardlink substitute survives\n" for location in locations)
    elif kind=="directory":
        marker=find_inode(case,substitute["marker_inode"])
        assert len(marker)==1 and read_regular(marker[0])==b"directory substitute survives\n"
    else:
        assert all(os.readlink(location)==substitute["sentinel"] for location in locations)
        sentinel=find_inode(case,substitute["sentinel_inode"])
        assert len(sentinel)==1 and read_regular(sentinel[0])==b"symlink target survives\n"

checkpoints=("before-quarantine","after-quarantine","before-final-proof",
             "after-final-proof","before-return","transaction-close")
top_kinds=("regular","directory","symlink","hardlink")
nested_kinds=("regular","directory","nested-directory","symlink","hardlink")
for module_index,(role,helper,prefix) in enumerate(specifications):
    module=load(f"retirement_store_{module_index}",helper)
    for checkpoint in checkpoints:
        for scope,kinds in (("top",top_kinds),("nested",nested_kinds)):
            for kind in kinds:
                case=os.path.join(base,f"{role}-{checkpoint}-{scope}-{kind}")
                os.mkdir(case,0o700); parent=os.open(case,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
                source=("a"*64 if role=="retention" else "managed")
                metadata,managed_files=make_managed(parent,source)
                substitute=make_substitute(case,parent,"directory" if kind=="nested-directory" else kind)
                original_checkpoint=module.retirement_checkpoint; fired=False
                def inject(label,source_parent,root_fd):
                    global fired
                    if label==checkpoint and not fired:
                        fired=True; attack(parent,source,prefix,scope,kind)
                    original_checkpoint(label,source_parent,root_fd)
                module.retirement_checkpoint=inject
                failed=False
                try:
                    try: invoke(module,role,parent,source,metadata)
                    except (SystemExit,OSError): failed=True
                finally: module.retirement_checkpoint=original_checkpoint
                assert fired,(role,checkpoint,scope,kind)
                assert failed,("exchange incorrectly reported success",role,checkpoint,scope,kind)
                prove_preserved(case,managed_files,substitute)
                if checkpoint!="before-quarantine":
                    assert any(name.startswith(prefix) for name in os.listdir(parent))
                os.close(parent)

    # Watch setup/loss and queue overflow fail before commit, and a no-replace
    # receipt collision cannot mutate either tree.  Exercise these primitives
    # for each implementation rather than trusting four near-identical copies.
    for failure in ("watch-loss","overflow"):
        case=os.path.join(base,f"{role}-{failure}"); os.mkdir(case,0o700)
        parent=os.open(case,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        source=(("e" if failure=="watch-loss" else "f")*64 if role=="retention" else "managed")
        metadata,managed_files=make_managed(parent,source)
        original_events=module.RetirementMonitor.events
        fired=False
        def fail_events(self):
            global fired
            if not fired:
                fired=True
                if failure=="watch-loss": raise OSError(9,"inotify descriptor lost")
                return [(self.parent_watch,module.IN_Q_OVERFLOW,0,"")]
            return original_events(self)
        module.RetirementMonitor.events=fail_events
        try:
            try: invoke(module,role,parent,source,metadata)
            except (SystemExit,OSError): pass
            else: raise AssertionError(("watch failure committed",role,failure))
        finally: module.RetirementMonitor.events=original_events
        assert fired and os.path.lexists(os.path.join(case,source))
        for expected,(expected_stable,payload) in managed_files.items():
            locations=find_inode(case,expected); assert len(locations)==1
            assert stable(os.stat(locations[0],follow_symlinks=False))==expected_stable
            assert read_regular(locations[0])==payload
        os.close(parent)

    case=os.path.join(base,f"{role}-receipt-collision"); os.mkdir(case,0o700)
    parent=os.open(case,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    source=("9"*64 if role=="retention" else "managed")
    metadata,managed_files=make_managed(parent,source)
    collision=expected_receipt(module,prefix,parent,source)
    os.mkdir(collision,0o700,dir_fd=parent)
    collision_fd=os.open(collision,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    marker=make_file(collision_fd,"collision-marker",b"receipt collision survives\n")
    os.close(collision_fd)
    try: invoke(module,role,parent,source,metadata)
    except OSError: pass
    else: raise AssertionError(("receipt collision was replaced",role))
    assert inode(os.stat(source,dir_fd=parent,follow_symlinks=False))==inode(metadata)
    marker_locations=find_inode(case,inode(marker))
    assert len(marker_locations)==1 and read_regular(marker_locations[0])==b"receipt collision survives\n"
    for expected,(expected_stable,payload) in managed_files.items():
        locations=find_inode(case,expected); assert len(locations)==1
        assert stable(os.stat(locations[0],follow_symlinks=False))==expected_stable
        assert read_regular(locations[0])==payload
    os.close(parent)

    # The final verified watcher drain is the linearization point.  A same-UID
    # exchange after it cannot rewrite the returned inventory fact: the
    # transaction returns its original receipt, but every later reader must
    # reopen/recompute and refuse the now-substituted current path.  Both the
    # managed and substitute inodes remain recoverable because retirement never
    # destroys bytes or metadata.
    for scope,kind,commit_hook in (("top","directory","transaction-commit"),
                                   ("nested","regular","post-commit")):
        case=os.path.join(base,f"{role}-post-commit-{scope}")
        os.mkdir(case,0o700); parent=os.open(case,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        source=(("c" if scope=="top" else "d")*64 if role=="retention" else "managed")
        metadata,managed_files=make_managed(parent,source)
        substitute=make_substitute(case,parent,kind)
        immutable_receipt=expected_receipt(module,prefix,parent,source)
        original_checkpoint=module.retirement_checkpoint; fired=False
        def inject_after_commit(label,source_parent,root_fd):
            global fired
            if label==commit_hook and not fired:
                fired=True; attack(parent,source,prefix,scope,kind)
            original_checkpoint(label,source_parent,root_fd)
        module.retirement_checkpoint=inject_after_commit
        try: returned_receipt=invoke(module,role,parent,source,metadata)
        finally: module.retirement_checkpoint=original_checkpoint
        assert fired,(role,scope)
        assert returned_receipt==immutable_receipt
        try: module.verify_retirement_receipt(parent,returned_receipt)
        except (SystemExit,OSError): pass
        else: raise AssertionError(("post-commit current path was trusted",role,scope))
        prove_preserved(case,managed_files,substitute)
        managed_roots=find_inode(case,inode(metadata))
        assert len(managed_roots)==1,("managed root is not recoverable",role,scope,managed_roots)
        recovered_root=os.stat(managed_roots[0],follow_symlinks=False)
        assert stat.S_ISDIR(recovered_root.st_mode)
        assert (recovered_root.st_uid,recovered_root.st_gid,stat.S_IMODE(recovered_root.st_mode))==(
            metadata.st_uid,metadata.st_gid,stat.S_IMODE(metadata.st_mode))
        os.close(parent)

    # The ordinary path also remains non-destructive, including nested and
    # zero-byte members, and the visible receipt reproduces the held inventory.
    case=os.path.join(base,f"{role}-success"); os.mkdir(case,0o700)
    parent=os.open(case,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    source=("b"*64 if role=="retention" else "managed")
    metadata,managed_files=make_managed(parent,source)
    receipt=invoke(module,role,parent,source,metadata)
    assert not os.path.lexists(os.path.join(case,source))
    matches=[name for name in os.listdir(parent) if name.startswith(prefix)]
    assert len(matches)==1
    assert receipt==matches[0]
    retired=os.open(matches[0],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    authority=module.RetirementAuthority(retired)
    try:
        assert matches[0]==prefix+authority.digest[:32]
        authority.revalidate(parent,matches[0],renamed_root=False)
        assert module.verify_retirement_receipt(parent,matches[0])==authority.digest
    finally: authority.close(); os.close(retired)
    for expected,(expected_stable,payload) in managed_files.items():
        locations=find_inode(case,expected)
        assert len(locations)==1
        assert stable(os.stat(locations[0],follow_symlinks=False))==expected_stable
        assert read_regular(locations[0])==payload
    os.close(parent)
`;
  const flattened = helpers.flat();
  const result = childProcess.spawnSync("python3", ["-I", "-B", "-c", script, directory, ...flattened], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("canonical incoming retirement handles empty trees, collision, and retention receipt enumeration", (t) => {
  const directory = tempData();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const candidateStore = path.join(ROOT, "platform/deploy/candidate-store.py");
  const retentionStore = path.join(ROOT, "platform/deploy/vps/remote/retention-store.py");
  const script = String.raw`
import contextlib,importlib.util,io,os,sys
root,candidate_path,retention_path=sys.argv[1:]
def load(name,path):
    specification=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(specification); specification.loader.exec_module(module); return module
candidate=load("candidate_receipt_store",candidate_path)
retention=load("retention_receipt_store",retention_path)
os.chmod(root,0o700); incoming_path=os.path.join(root,"incoming"); os.mkdir(incoming_path,0o700)
parent=os.open(incoming_path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
    # Empty workspaces are valid retirement inventories and still receive an
    # exact digest receipt.
    empty="a"*64; os.mkdir(empty,0o700,dir_fd=parent)
    candidate.REMOTE_INCOMING_ROOT=incoming_path
    previous_argv=sys.argv
    try:
        sys.argv=["candidate-store.py","retire-path","--parent",incoming_path,"--name",empty]
        retired=io.StringIO()
        with contextlib.redirect_stdout(retired): candidate.main()
        receipt=retired.getvalue().strip()
    finally: sys.argv=previous_argv
    assert receipt.startswith(".candidate-retired-") and len(receipt)==len(".candidate-retired-")+32
    try:
        sys.argv=["candidate-store.py","verify-receipt","--parent",incoming_path,"--receipt",receipt]
        verified=io.StringIO()
        with contextlib.redirect_stdout(verified): candidate.main()
    finally: sys.argv=previous_argv
    assert len(verified.getvalue().strip())==64
    assert verified.getvalue().strip()==candidate.verify_retirement_receipt(parent,receipt)
    for invalid in (
        ["candidate-store.py","retire-path","--parent",root,"--name","b"*64],
        ["candidate-store.py","retire-path","--parent",incoming_path,"--name","not-a-release"],
    ):
        try:
            sys.argv=invalid; candidate.main()
        except SystemExit: pass
        else: raise AssertionError("retire-path accepted an unprotected parent or invalid release ID")
        finally: sys.argv=previous_argv
    assert len(retention.verify_retirement_receipt(parent,receipt))==64

    # The real retention enumerator accepts the same receipt protocol and emits
    # no active incoming fact for the logically retired tree.
    retention.REMOTE_ROOT=root
    previous_argv=sys.argv
    try:
        sys.argv=["retention-store.py","facts","--store",incoming_path,"--kind","incoming"]
        output=io.StringIO()
        with contextlib.redirect_stdout(output): retention.main()
        assert output.getvalue()==""
    finally: sys.argv=previous_argv

    # A pre-existing receipt is a no-replace collision.  Neither it nor the
    # still-public managed tree is mutated, and no alternate random name is
    # invented.
    managed="b"*64; os.mkdir(managed,0o700,dir_fd=parent)
    managed_fd=os.open(managed,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    payload=os.open("payload",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=managed_fd)
    os.write(payload,b"managed collision bytes\n"); os.fchmod(payload,0o600); os.close(payload)
    managed_meta=os.fstat(managed_fd)
    authority=candidate.RetirementAuthority(managed_fd)
    collision=".candidate-retired-"+authority.digest[:32]
    authority.close(); os.close(managed_fd)
    os.mkdir(collision,0o700,dir_fd=parent)
    marker_fd=os.open(collision,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    marker=os.open("marker",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=marker_fd)
    os.write(marker,b"collision survives\n"); os.fchmod(marker,0o600); os.close(marker); os.close(marker_fd)
    try: candidate.cleanup(parent,managed,(managed_meta.st_dev,managed_meta.st_ino))
    except OSError: pass
    else: raise AssertionError("receipt collision was replaced")
    managed_fd=os.open(managed,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    payload=os.open("payload",os.O_RDONLY|os.O_NOFOLLOW,dir_fd=managed_fd)
    assert os.read(payload,64)==b"managed collision bytes\n"; os.close(payload); os.close(managed_fd)
    marker_fd=os.open(collision,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    marker=os.open("marker",os.O_RDONLY|os.O_NOFOLLOW,dir_fd=marker_fd)
    assert os.read(marker,64)==b"collision survives\n"; os.close(marker); os.close(marker_fd)
finally: os.close(parent)
`;
  const result = childProcess.spawnSync("python3", ["-I", "-B", "-c", script, directory, candidateStore, retentionStore], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("candidate workspace cleanup is descriptor-bound and preserves hostile substitutes", (t) => {
  const directory = tempData();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const helper = path.join(ROOT, "platform/deploy/candidate-store.py");
  const script = String.raw`
import ctypes,importlib.util,os,stat,sys
root,helper_path=sys.argv[1:]
spec=importlib.util.spec_from_file_location("candidate_store",helper_path)
store=importlib.util.module_from_spec(spec); spec.loader.exec_module(store)
def exchange(source_parent,source,destination_parent,destination):
    function=getattr(ctypes.CDLL(None,use_errno=True),"renameat2",None)
    assert function is not None
    assert function(source_parent,os.fsencode(source),destination_parent,os.fsencode(destination),2)==0
os.chmod(root,0o700)
victim=os.path.join(root,"victim"); os.mkdir(victim,0o700)
sentinel=os.path.join(victim,"sentinel")
fd=os.open(sentinel,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
os.write(fd,b"preserve me\n"); os.fchmod(fd,0o600); os.close(fd)
os.symlink(victim,os.path.join(root,"linked-root"))
try: store.open_absolute(os.path.join(root,"linked-root"),True)
except (OSError,SystemExit): pass
else: raise AssertionError("symlink ancestry was accepted")
assert open(sentinel,"rb").read()==b"preserve me\n"
parent=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
    original_open=store.os.open
    # A same-name replacement after the creator recorded its inode is refused;
    # neither the original nor the substitute is traversed or deleted.
    os.mkdir("race",0o700,dir_fd=parent)
    race=os.stat("race",dir_fd=parent,follow_symlinks=False)
    os.rename("race","race-original",src_dir_fd=parent,dst_dir_fd=parent)
    os.mkdir("race",0o700,dir_fd=parent)
    try: store.cleanup(parent,"race",(race.st_dev,race.st_ino))
    except SystemExit: pass
    else: raise AssertionError("same-name cleanup replacement was accepted")
    assert stat.S_ISDIR(os.stat("race",dir_fd=parent,follow_symlinks=False).st_mode)
    assert stat.S_ISDIR(os.stat("race-original",dir_fd=parent,follow_symlinks=False).st_mode)

    # An exact RENAME_EXCHANGE after the helper's final root stat moves the
    # substitute into quarantine but never traverses or reclaims its bytes.
    os.mkdir("exchange-root",0o700,dir_fd=parent)
    exchange_root=original_open("exchange-root",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    managed=original_open("managed",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=exchange_root)
    os.write(managed,b"managed root bytes\n"); os.fchmod(managed,0o600); os.close(managed); os.close(exchange_root)
    os.mkdir("outside-root",0o700,dir_fd=parent)
    outside_root=original_open("outside-root",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    outside=original_open("victim",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=outside_root)
    os.write(outside,b"outside root survives\n"); os.fchmod(outside,0o600); os.close(outside); os.close(outside_root)
    exchange_meta=os.stat("exchange-root",dir_fd=parent,follow_symlinks=False)
    original_rename=store.rename_no_replace; exchanged=False
    def exchange_root_race(source_parent,source,destination_parent,destination):
        global exchanged
        if source=="exchange-root" and not exchanged:
            exchanged=True; exchange(source_parent,source,parent,"outside-root")
        original_rename(source_parent,source,destination_parent,destination)
    store.rename_no_replace=exchange_root_race
    try:
        try: store.cleanup(parent,"exchange-root",(exchange_meta.st_dev,exchange_meta.st_ino))
        except SystemExit: pass
        else: raise AssertionError("root RENAME_EXCHANGE substitute was retired")
    finally: store.rename_no_replace=original_rename
    assert exchanged
    outside_root=original_open("outside-root",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    managed=original_open("managed",os.O_RDONLY|os.O_NOFOLLOW,dir_fd=outside_root)
    assert os.read(managed,64)==b"managed root bytes\n"; os.close(managed); os.close(outside_root)
    root_victim_preserved=False
    for retired_name in os.listdir(parent):
        if not retired_name.startswith(".candidate-retired-"): continue
        retired=original_open(retired_name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
        try:
            if "victim" in os.listdir(retired):
                victim_fd=original_open("victim",os.O_RDONLY|os.O_NOFOLLOW,dir_fd=retired)
                root_victim_preserved=os.read(victim_fd,64)==b"outside root survives\n"; os.close(victim_fd)
        finally: os.close(retired)
    assert root_victim_preserved

    # Publication consumes the inode recorded by the creator, not merely a
    # same-name directory that happens to contain acceptable bytes.
    os.mkdir("publish-stage",0o700,dir_fd=parent)
    publish_meta=os.stat("publish-stage",dir_fd=parent,follow_symlinks=False)
    original_hold=store.hold_candidate
    def fake_hold(directory,name,candidate_id):
        descriptor=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
        return descriptor,os.fstat(descriptor),{}
    store.hold_candidate=fake_hold
    try:
        try: store.publish(parent,"publish-stage","a"*64,(publish_meta.st_dev,publish_meta.st_ino+1))
        except SystemExit: pass
        else: raise AssertionError("publication accepted a different staging inode")
    finally: store.hold_candidate=original_hold
    assert stat.S_ISDIR(os.stat("publish-stage",dir_fd=parent,follow_symlinks=False).st_mode)
    try: os.stat("a"*64,dir_fd=parent,follow_symlinks=False)
    except FileNotFoundError: pass
    else: raise AssertionError("wrong-inode publication poisoned the final candidate ID")

    # A link in a managed tree can at most quarantine that tree. It can never
    # redirect recursive cleanup into the link target.
    os.mkdir("link-tree",0o700,dir_fd=parent)
    link_tree=os.open("link-tree",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    link_meta=os.fstat(link_tree); os.symlink(victim,"escape",dir_fd=link_tree); os.close(link_tree)
    try: store.cleanup(parent,"link-tree",(link_meta.st_dev,link_meta.st_ino))
    except SystemExit: pass
    else: raise AssertionError("cleanup followed a symlink")
    assert open(sentinel,"rb").read()==b"preserve me\n"

    # A multiply-linked file and a writable root both stop deletion. The
    # external hardlink and every byte it names survive.
    os.mkdir("hard-tree",0o700,dir_fd=parent)
    hard_tree=os.open("hard-tree",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    file_fd=os.open("payload",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=hard_tree)
    os.write(file_fd,b"hardlinked\n"); os.fchmod(file_fd,0o600); os.close(file_fd)
    os.link("payload","external-hardlink",src_dir_fd=hard_tree,dst_dir_fd=parent,follow_symlinks=False)
    hard_meta=os.fstat(hard_tree); os.close(hard_tree)
    try: store.cleanup(parent,"hard-tree",(hard_meta.st_dev,hard_meta.st_ino))
    except SystemExit: pass
    else: raise AssertionError("cleanup deleted a hardlinked file")
    external=os.open("external-hardlink",os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent)
    assert os.read(external,64)==b"hardlinked\n"; os.close(external)

    # Force a replacement after the member descriptor is held but before its
    # atomic nested quarantine. The substitute is moved into the recoverable
    # retirement tree, never unlinked or truncated.
    os.mkdir("file-race",0o700,dir_fd=parent)
    file_race=os.open("file-race",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    payload=os.open("payload",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=file_race)
    os.write(payload,b"original\n"); os.fchmod(payload,0o600); os.close(payload)
    file_race_meta=os.fstat(file_race); os.close(file_race)
    original_open=store.os.open; fired=False
    def racing_open(name,flags,mode=0o777,*,dir_fd=None):
        global fired
        descriptor=original_open(name,flags,mode,dir_fd=dir_fd)
        if name=="payload" and dir_fd is not None and not fired and flags & os.O_ACCMODE == os.O_RDONLY:
            fired=True
            os.rename("payload","payload-original",src_dir_fd=dir_fd,dst_dir_fd=dir_fd)
            substitute=original_open("payload",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=dir_fd)
            os.write(substitute,b"substitute survives\n"); os.fchmod(substitute,0o600); os.close(substitute)
        return descriptor
    store.os.open=racing_open
    try:
        try: store.cleanup(parent,"file-race",(file_race_meta.st_dev,file_race_meta.st_ino))
        except SystemExit: pass
        else: raise AssertionError("cleanup unlinked a same-name file substitute")
    finally: store.os.open=original_open
    assert fired
    file_race=original_open("file-race",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    substitute=original_open("payload",os.O_RDONLY|os.O_NOFOLLOW,dir_fd=file_race)
    original=original_open("payload-original",os.O_RDONLY|os.O_NOFOLLOW,dir_fd=file_race)
    assert os.read(substitute,64)==b"substitute survives\n"
    assert os.read(original,64)==b"original\n"
    os.close(substitute); os.close(original); os.close(file_race)

    # A nested exchange after the top-level logical quarantine is detected by
    # both the inode watches and the final held-name proof. Neither tree is
    # truncated.
    os.mkdir("member-exchange-tree",0o700,dir_fd=parent)
    member_tree=original_open("member-exchange-tree",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    planned=original_open("payload",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=member_tree)
    os.write(planned,b"planned member bytes\n"); os.fchmod(planned,0o600); os.close(planned)
    outside=original_open("outside-regular",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
    os.write(outside,b"outside regular survives\n"); os.fchmod(outside,0o600); os.close(outside)
    member_meta=os.fstat(member_tree); os.close(member_tree)
    original_checkpoint=store.retirement_checkpoint; member_exchanged=False
    def exchange_member_race(label,source_parent,root_fd):
        global member_exchanged
        if label=="after-quarantine" and not member_exchanged:
            retired_name=next(name for name in os.listdir(parent) if name.startswith(".candidate-retired-") and "payload" in os.listdir(os.path.join(root,name)))
            retired=original_open(retired_name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
            member_exchanged=True; exchange(retired,"payload",parent,"outside-regular"); os.close(retired)
        original_checkpoint(label,source_parent,root_fd)
    store.retirement_checkpoint=exchange_member_race
    try:
        try: store.cleanup(parent,"member-exchange-tree",(member_meta.st_dev,member_meta.st_ino))
        except SystemExit: pass
        else: raise AssertionError("nested RENAME_EXCHANGE substitute was retired")
    finally: store.retirement_checkpoint=original_checkpoint
    assert member_exchanged
    planned=original_open("outside-regular",os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent)
    assert os.read(planned,64)==b"planned member bytes\n"; os.close(planned)
    victim_preserved=False
    for retired_name in os.listdir(parent):
        if not retired_name.startswith(".candidate-retired-"): continue
        retired=original_open(retired_name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
        try:
            for member in os.listdir(retired):
                metadata=os.stat(member,dir_fd=retired,follow_symlinks=False)
                if not stat.S_ISREG(metadata.st_mode): continue
                candidate=original_open(member,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=retired)
                try:
                    if os.read(candidate,64)==b"outside regular survives\n": victim_preserved=True
                finally: os.close(candidate)
        finally: os.close(retired)
    assert victim_preserved

    # Successful cleanup is an explicitly non-destructive logical retirement:
    # the public name disappears and the content-addressed retirement tree
    # retains every byte for recovery.
    os.mkdir("success-tree",0o700,dir_fd=parent)
    success_tree=original_open("success-tree",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    os.mkdir("branch",0o700,dir_fd=success_tree)
    branch=original_open("branch",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=success_tree)
    payload=original_open("payload",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=branch)
    os.write(payload,b"reclaim these bytes\n"); os.fchmod(payload,0o600); os.close(payload); os.close(branch)
    success_meta=os.fstat(success_tree); os.close(success_tree)
    store.cleanup(parent,"success-tree",(success_meta.st_dev,success_meta.st_ino))
    try: os.stat("success-tree",dir_fd=parent,follow_symlinks=False)
    except FileNotFoundError: pass
    else: raise AssertionError("successful cleanup left the managed name visible")
    recovered=False
    for retired_name in os.listdir(parent):
        if not retired_name.startswith(".candidate-retired-"): continue
        retired=original_open(retired_name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
        stack=[retired]
        try:
            while stack:
                directory=stack.pop()
                for member in os.listdir(directory):
                    metadata=os.stat(member,dir_fd=directory,follow_symlinks=False)
                    if stat.S_ISDIR(metadata.st_mode):
                        stack.append(original_open(member,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory))
                    elif stat.S_ISREG(metadata.st_mode):
                        candidate=original_open(member,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=directory)
                        try:
                            if os.read(candidate,64)==b"reclaim these bytes\n": recovered=True
                        finally: os.close(candidate)
                if directory!=retired: os.close(directory)
        finally: os.close(retired)
    assert recovered

    os.mkdir("mode-tree",0o700,dir_fd=parent)
    mode_tree=os.open("mode-tree",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    mode_meta=os.fstat(mode_tree); os.fchmod(mode_tree,0o777); os.close(mode_tree)
    try: store.cleanup(parent,"mode-tree",(mode_meta.st_dev,mode_meta.st_ino))
    except SystemExit: pass
    else: raise AssertionError("cleanup accepted a writable root")
finally: os.close(parent)
`;
  const result = childProcess.spawnSync("python3", ["-I", "-B", "-c", script, directory, helper], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("held release and Compose authority rejects replacement, mode, manifest, and service-set races", (t) => {
  const directory = tempData();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const heldExec = path.join(ROOT, "platform/deploy/vps/remote/held-release-exec.py");
  const heldCompose = path.join(ROOT, "platform/deploy/vps/remote/held-compose.py");
  const script = String.raw`
import hashlib,importlib.util,json,os,sys
root,exec_path,compose_path=sys.argv[1:]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path); module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module); return module
held=load("held_release_exec",exec_path); compose=load("held_compose",compose_path)
for key in list(os.environ):
    if key.upper().startswith("DOCKER_"): del os.environ[key]
held.REMOTE_ROOT=root
os.makedirs(os.path.join(root,"releases"),mode=0o700)
os.makedirs(os.path.join(root,"manifests"),mode=0o700)

def fixture(action,extra=None):
    files={"action.py":action.encode(),"payload":b"sealed payload\n"}
    files.update(extra or {})
    entries=[]
    for name,data in sorted(files.items()):
        entries.append({"path":name,"sha256":hashlib.sha256(data).hexdigest(),
                        "size":len(data),"mode":"0644"})
    body={"schemaVersion":1,"profile":"vps","entries":entries}
    release_id=hashlib.sha256(json.dumps(body,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
    tree=os.path.join(root,"releases",release_id); os.mkdir(tree,0o700)
    for name,data in files.items():
        parent=os.path.dirname(os.path.join(tree,name))
        os.makedirs(parent,mode=0o755,exist_ok=True)
        descriptor=os.open(os.path.join(tree,name),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
        os.write(descriptor,data); os.fchmod(descriptor,0o644); os.close(descriptor)
    manifest=os.path.join(root,"manifests",release_id+".json")
    document={**body,"releaseId":release_id}
    descriptor=os.open(manifest,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    os.write(descriptor,json.dumps(document,separators=(",",":"),ensure_ascii=False).encode())
    os.fchmod(descriptor,0o600); os.close(descriptor)
    return release_id,tree,manifest

def invoke(action,extra=()):
    release_id,tree,manifest=fixture(action)
    saved=sys.argv
    sys.argv=[exec_path,"--tree",tree,"--manifest",manifest,
              "--expect-release-id",release_id,"--entry","action.py",
              "--interpreter","python","--",*extra]
    try:
        try: held.main()
        except SystemExit as error: code=error.code
        else: raise AssertionError("held executor did not terminate")
    finally:
        sys.argv=saved
        try: os.chmod(tree,0o700)
        except FileNotFoundError: pass
    return code,tree,manifest,release_id

code,_,_,_=invoke("raise SystemExit(0)\n")
assert code==0

# Execution uses kernel-sealed snapshots, not merely read-held mutable inodes.
# A write to the exact descriptor passed to the interpreter must be impossible.
release_id,tree,manifest=fixture("raise SystemExit(0)\n# sealed snapshot probe\n")
root_fd=held.open_directory(tree); manifest_fd,manifest_meta=held.open_file(manifest,held.MAX_MANIFEST)
files={}; directories=[]; snapshots={}
try:
    entries=held.parse_manifest(held.read_fd(manifest_fd,manifest_meta),release_id)
    files,directories=held.hold_tree(root_fd,entries)
    snapshots=held.create_sealed_snapshots(files,"action.py")
    sealed=snapshots["action.py"][0]
    required=held.REQUIRED_MEMFD_SEALS
    assert held.fcntl.fcntl(sealed,held.fcntl.F_GET_SEALS)&required==required
    try: os.pwrite(sealed,b"X",0)
    except OSError: pass
    else: raise AssertionError("sealed execution snapshot remained writable")
finally:
    for descriptor,_,_ in snapshots.values(): os.close(descriptor)
    for descriptor,_,_ in files.values(): os.close(descriptor)
    for descriptor,_,_ in reversed(directories):
        if descriptor!=root_fd: os.close(descriptor)
    os.close(root_fd); os.close(manifest_fd)

# A nested dispatcher must authenticate the sibling before execution. Exercise
# both a same-size/mode replacement inode and mutation of the original inode;
# neither substituted program may create its marker.
helper_bytes=open(exec_path,"rb").read()
inner_good=b'import sys\nopen(sys.argv[1],"w").write("GOOD")\n'
inner_bad =b'import sys\nopen(sys.argv[1],"w").write("EVIL")\n'
assert len(inner_good)==len(inner_bad)
for attack in ("replace","mutate"):
    marker=os.path.join(root,f"nested-{attack}.marker")
    outer='''import os,subprocess,sys\nroot=os.environ["REVIVAL_HELD_RELEASE_LOGICAL_ROOT"]\ninner=root+"/inner.py"\nbad=b'import sys\\nopen(sys.argv[1],"w").write("EVIL")\\n'\nif sys.argv[3]=="replace":\n os.rename(inner,inner+".trusted")\n fd=os.open(inner,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)\n os.write(fd,bad);os.fchmod(fd,0o644);os.close(fd)\nelse:\n fd=os.open(inner,os.O_WRONLY|os.O_NOFOLLOW);os.pwrite(fd,bad,0);os.fsync(fd);os.close(fd)\nresult=subprocess.run([sys.executable,"-I",os.environ["REVIVAL_HELD_EXEC"],\n "--tree",root,"--manifest",sys.argv[1],"--expect-release-id",sys.argv[2],\n "--entry","inner.py","--interpreter","python","--",sys.argv[4]])\nassert result.returncode!=0\n'''
    release_id,tree,manifest=fixture(outer,{
        "attack.txt":attack.encode(),
        "inner.py":inner_good,
        "platform/deploy/vps/remote/held-release-exec.py":helper_bytes,
    })
    saved=sys.argv
    sys.argv=[exec_path,"--tree",tree,"--manifest",manifest,
              "--expect-release-id",release_id,"--entry","action.py",
              "--interpreter","python","--",manifest,release_id,attack,marker]
    try:
        try: held.main()
        except SystemExit as error: assert error.code!=0
        else: raise AssertionError("nested release substitution was accepted")
    finally: sys.argv=saved
    assert not os.path.exists(marker)
replace='''import os\nroot=os.environ["REVIVAL_HELD_RELEASE_LOGICAL_ROOT"]\nos.rename(root+"/payload",root+"/payload.old")\nfd=os.open(root+"/payload",os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)\nos.write(fd,b"sealed payload\\n");os.fchmod(fd,0o644);os.close(fd)\n'''
code,_,_,_=invoke(replace)
assert code!=0
code,_,_,_=invoke('import os\nos.chmod(os.environ["REVIVAL_HELD_RELEASE_LOGICAL_ROOT"],0o777)\n')
assert code!=0
manifest_swap='''import os,sys\np=sys.argv[1]; data=open(p,"rb").read(); os.rename(p,p+".old")\nfd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)\nos.write(fd,data);os.fchmod(fd,0o600);os.close(fd)\n'''
release_id,tree,manifest=fixture(manifest_swap)
saved=sys.argv; sys.argv=[exec_path,"--tree",tree,"--manifest",manifest,
    "--expect-release-id",release_id,"--entry","action.py","--interpreter","python","--",manifest]
try:
    try: held.main()
    except SystemExit as error: assert error.code!=0
    else: raise AssertionError("manifest replacement was accepted")
finally: sys.argv=saved

held.validate_authority_paths(os.path.join(root,"releases",release_id),
                              os.path.join(root,"manifests",release_id+".json"),release_id)
try: held.validate_authority_paths(tree+"-foreign",manifest,release_id)
except SystemExit: pass
else: raise AssertionError("foreign release authority paths were accepted")

image="sha256:"+"a"*64
services={name:{"image":image} for name in compose.EXPECTED_SERVICES}
payload=json.dumps({"services":services},sort_keys=True,separators=(",",":")).encode()+b"\n"
assert set(compose.parse_override(payload))==compose.EXPECTED_SERVICES
missing=dict(services); missing.pop(next(iter(missing)))
try: compose.parse_override(json.dumps({"services":missing}).encode())
except SystemExit: pass
else: raise AssertionError("partial image override was accepted")
tagged=dict(services); tagged[next(iter(tagged))]={"image":"registry.example.invalid/repo:mutable"}
try: compose.parse_override(json.dumps({"services":tagged}).encode())
except SystemExit: pass
else: raise AssertionError("mutable tag override was accepted")
release=os.path.join(root,"releases",release_id)
base=["docker","compose","-f",release+"/compose.yaml","-f",release+"/platform/compose/production.yaml",
      "up","-d","--pull","never","--no-build"]
bound=compose.bind_release_compose_files(base,release,{"compose.yaml":31,"platform/compose/production.yaml":32})
wrapped=compose.insert_override(bound,"/proc/self/fd/33")
assert "/proc/" in " ".join(wrapped) and "--no-build" in wrapped
`;
  const result = childProcess.spawnSync("python3", ["-I", "-B", "-c", script, directory, heldExec, heldCompose], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("installed Node executes the exact sealed candidate verifier from proc-self and rejects authority attacks", (t) => {
  const directory = tempData();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const heldExec = path.join(ROOT, "platform/deploy/vps/remote/held-release-exec.py");
  const verifier = path.join(ROOT, "platform/deploy/release-candidate.mjs");
  const script = String.raw`
import fcntl,hashlib,importlib.util,json,os,shutil,stat,subprocess,sys
root,helper_path,verifier_path=sys.argv[1:]
spec=importlib.util.spec_from_file_location("held_release_exec",helper_path)
held=importlib.util.module_from_spec(spec); spec.loader.exec_module(held)
held.REMOTE_ROOT=root
os.mkdir(os.path.join(root,"releases"),0o700)
os.mkdir(os.path.join(root,"manifests"),0o700)
os.mkdir(os.path.join(root,"poison-cwd"),0o700)
marker=os.path.join(root,"DOCKER-WAS-CALLED")
fake_bin=os.path.join(root,"bin"); os.mkdir(fake_bin,0o700)
docker=os.path.join(fake_bin,"docker")
descriptor=os.open(docker,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o755)
os.write(descriptor,("#!/bin/sh\nprintf called >"+marker+"\n").encode()); os.fchmod(descriptor,0o755); os.close(descriptor)
for key in list(os.environ):
    if key.upper().startswith("DOCKER_"): del os.environ[key]
os.environ["PATH"]=fake_bin+os.pathsep+os.environ.get("PATH","")
verifier_bytes=open(verifier_path,"rb").read()

def build(label):
    relative="platform/deploy/release-candidate.mjs"
    entry={"path":relative,"sha256":hashlib.sha256(verifier_bytes).hexdigest(),
           "size":len(verifier_bytes),"mode":"0644"}
    body={"schemaVersion":1,"profile":"vps","entries":[entry]}
    release_id=hashlib.sha256(json.dumps(body,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
    # Each case needs a separate manifest/root name even though the content ID
    # is necessarily the same. Remove the prior case only after all its held FDs
    # have closed.
    tree=os.path.join(root,"releases",release_id)
    if os.path.lexists(tree): shutil.rmtree(tree)
    os.makedirs(os.path.join(tree,"platform/deploy"))
    for current,_,_ in os.walk(tree): os.chmod(current,0o700 if current==tree else 0o755)
    output=os.open(os.path.join(tree,relative),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
    os.write(output,verifier_bytes); os.fchmod(output,0o644); os.close(output)
    manifest=os.path.join(root,"manifests",release_id+".json")
    try: os.unlink(manifest)
    except FileNotFoundError: pass
    output=os.open(manifest,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    os.write(output,json.dumps({**body,"releaseId":release_id},separators=(",",":"),ensure_ascii=False).encode())
    os.fchmod(output,0o600); os.close(output)
    return release_id,tree,manifest,relative

def invoke(label,hook=None,cwd=None):
    release_id,tree,manifest,relative=build(label)
    original=held.create_sealed_snapshots
    if hook is not None:
        def wrapped(files,entry):
            snapshots=original(files,entry); hook(tree,manifest,relative); return snapshots
        held.create_sealed_snapshots=wrapped
    saved_argv=sys.argv[:]; saved_cwd=os.getcwd()
    sys.argv=[helper_path,"--tree",tree,"--manifest",manifest,
              "--expect-release-id",release_id,"--entry",relative,"--interpreter","node","--",
              "verify","--candidate",os.path.join(root,"missing-candidate"),
              "--expect-id","a"*64,"--json"]
    try:
        if cwd: os.chdir(cwd)
        try: held.main()
        except SystemExit as error: return str(error.code)
        raise AssertionError("held executor unexpectedly returned")
    finally:
        os.chdir(saved_cwd); sys.argv=saved_argv; held.create_sealed_snapshots=original

# This is a real installed-Node end to end. Reaching the candidate-path refusal
# proves Node loaded the sealed production verifier and that its held ROOT read
# succeeded even from a poisoned cwd. Ordinary Node v22 used to die first with
# ENOENT on the deleted memfd pseudo-name.
status=invoke("valid-authority",cwd=os.path.join(root,"poison-cwd"))
assert status=="1"
assert not os.path.exists(marker)

def mutate_root(tree,manifest,relative):
    target=os.path.join(tree,relative)
    descriptor=os.open(target,os.O_WRONLY|os.O_NOFOLLOW)
    try: os.pwrite(descriptor,b"X",0); os.fsync(descriptor)
    finally: os.close(descriptor)
status=invoke("same-inode-root",mutate_root)
assert status!="0" and not os.path.exists(marker)

def exchange_root(tree,manifest,relative):
    old=tree+".held"; os.rename(tree,old); os.mkdir(tree,0o700)
    payload=os.open(os.path.join(tree,"foreign"),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    os.write(payload,b"foreign\n"); os.fchmod(payload,0o600); os.close(payload)
status=invoke("root-exchange",exchange_root)
assert status!="0" and not os.path.exists(marker)

def mutate_manifest(tree,manifest,relative):
    descriptor=os.open(manifest,os.O_WRONLY|os.O_NOFOLLOW)
    try: os.pwrite(descriptor,b"X",0); os.fsync(descriptor)
    finally: os.close(descriptor)
status=invoke("manifest-tamper",mutate_manifest)
assert status!="0" and not os.path.exists(marker)

# Direct held-mode attacks exercise the JavaScript-side boundary as well as the
# outer executor: proc-self spelling, descriptor types, inherited-FD survival,
# full seals, and manifest identity are mandatory.
release_id,tree,manifest,relative=build("direct-attacks")
root_fd=os.open(tree,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
manifest_fd=os.open(manifest,os.O_RDONLY|os.O_NOFOLLOW)
ordinary_fd=os.open(os.path.join(tree,relative),os.O_RDONLY|os.O_NOFOLLOW)
sealed=os.memfd_create("candidate-verifier",os.MFD_CLOEXEC|os.MFD_ALLOW_SEALING)
os.write(sealed,verifier_bytes); os.fchmod(sealed,0o644)
required=fcntl.F_SEAL_SEAL|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_GROW|fcntl.F_SEAL_WRITE
fcntl.fcntl(sealed,fcntl.F_ADD_SEALS,required)
base=["/usr/bin/node","--preserve-symlinks-main",f"/proc/self/fd/{sealed}",
      "--held-release-root-fd",str(root_fd),"--held-release-manifest-fd",str(manifest_fd),
      "--held-release-id",release_id,"verify","--candidate",os.path.join(root,"missing-candidate"),
      "--expect-id","a"*64,"--json"]
environment={**os.environ,"REVIVAL_HELD_RELEASE_ROOT":"/tmp/ambient-poison",
             "REVIVAL_HELD_RELEASE_ID":"f"*64,"REVIVAL_HELD_RELEASE_ROOT_FD":"99999"}
good=subprocess.run(base,pass_fds=(sealed,root_fd,manifest_fd),cwd=os.path.join(root,"poison-cwd"),
                    text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=environment)
assert good.returncode!=0 and "candidate path" in good.stderr
assert "memfd:" not in good.stderr and "ENOENT" not in good.stderr
attacks=[
    (base[:3]+["--held-release-root-fd",str(ordinary_fd),"--held-release-manifest-fd",str(manifest_fd),
               "--held-release-id",release_id,*base[9:]],(sealed,ordinary_fd,manifest_fd)),
    (base[:3]+["--held-release-root-fd",str(root_fd),"--held-release-manifest-fd",str(root_fd),
               "--held-release-id",release_id,*base[9:]],(sealed,root_fd)),
    (["/usr/bin/node","--preserve-symlinks-main",f"/proc/{os.getpid()}/fd/{sealed}",*base[3:]],
     (sealed,root_fd,manifest_fd)),
    (base,(sealed,manifest_fd)),
    (["/usr/bin/node","--preserve-symlinks-main",f"/proc/self/fd/{ordinary_fd}",*base[3:]],
     (ordinary_fd,root_fd,manifest_fd)),
]
for command,inherited in attacks:
    result=subprocess.run(command,pass_fds=inherited,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                          cwd=os.path.join(root,"poison-cwd"),env=environment)
    assert result.returncode!=0
    assert not os.path.exists(marker)

# Ambient held-looking variables never switch an ordinary local invocation into
# descriptor mode.
local=subprocess.run(["/usr/bin/node",verifier_path,"verify","--candidate",os.path.join(root,"missing-candidate"),
                      "--expect-id","a"*64,"--json"],cwd=os.path.join(root,"poison-cwd"),env=environment,
                     text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
assert local.returncode!=0 and "candidate path" in local.stderr
assert "held candidate verifier refusal" not in local.stderr and not os.path.exists(marker)
for descriptor in (sealed,ordinary_fd,manifest_fd,root_fd): os.close(descriptor)
`;
  const result = childProcess.spawnSync("python3", ["-I", "-B", "-c", script, directory, heldExec, verifier], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("deploy rollback and prune verifier dispatch keep sealed Node root and manifest descriptors through nested Bash", (t) => {
  const directory = tempData();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const heldExec = path.join(ROOT, "platform/deploy/vps/remote/held-release-exec.py");
  const common = path.join(ROOT, "platform/deploy/vps/remote/common.sh");
  const commonLib = path.join(ROOT, "platform/deploy/vps/remote/lib");
  const script = String.raw`
import hashlib,importlib.util,json,os,stat,sys
root,helper_path,common_path,common_lib=sys.argv[1:]
spec=importlib.util.spec_from_file_location("held_release_exec",helper_path)
held=importlib.util.module_from_spec(spec); spec.loader.exec_module(held)
held.REMOTE_ROOT=root
for name in ("releases","manifests","release-candidates","bin","poison-cwd"):
    os.mkdir(os.path.join(root,name),0o700)
trace=os.path.join(root,"authority.trace")
ambient_marker=os.path.join(root,"ambient-executable.marker")
for name in ("bash","node","python3","docker","sudo","env","stat","sha256sum","readlink","flock","dirname","pwd","id","tr","basename"):
    target=os.path.join(root,"bin",name)
    descriptor=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o755)
    payload=(f'#!/usr/bin/bash\nprintf "%s\\n" {name} >>"{ambient_marker}"\nexit 97\n').encode()
    os.write(descriptor,payload); os.fchmod(descriptor,0o755); os.close(descriptor)
startup=os.path.join(root,"ambient-startup.sh")
descriptor=os.open(startup,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
os.write(descriptor,f'printf "%s\\n" startup >>"{ambient_marker}"\n'.encode())
os.fchmod(descriptor,0o600); os.close(descriptor)
os.environ["PATH"]=os.path.join(root,"bin")+os.pathsep+os.environ.get("PATH","")
for key in list(os.environ):
    if key.upper().startswith("DOCKER_"): del os.environ[key]
os.environ.update({
    "BASH_ENV":startup,"ENV":startup,"LD_PRELOAD":os.path.join(root,"missing-preload.so"),
    "LD_LIBRARY_PATH":os.path.join(root,"hostile-library-path"),"SHELLOPTS":"xtrace",
    "NODE_OPTIONS":"--require="+os.path.join(root,"missing-node-preload.cjs"),
    "NODE_PATH":os.path.join(root,"hostile-node-path"),
    "PYTHONPATH":os.path.join(root,"hostile-python-path"),
    "PYTHONHOME":os.path.join(root,"hostile-python-home"),
    "REVIVAL_HOST_BASH":os.path.join(root,"bin","bash"),
    "REVIVAL_HOST_DOCKER":os.path.join(root,"bin","docker"),
    "REVIVAL_HOST_NODE":os.path.join(root,"bin","node"),
    "REVIVAL_HOST_PYTHON":os.path.join(root,"bin","python3"),
    "REVIVAL_HOST_SUDO":os.path.join(root,"bin","sudo"),
})
for name in ("builtin","bash","node","python3","docker","sudo","env","stat","sha256sum","readlink","flock"):
    os.environ["BASH_FUNC_"+name+"%%"]=(
        f'() {{ printf "%s\\n" function-{name} >>"{ambient_marker}"; return 97; }}')
# These ambient values must be discarded and replaced by held-release-exec.
os.environ["REVIVAL_HELD_RELEASE_ROOT"]="/tmp/ambient-root-poison"
os.environ["REVIVAL_HELD_RELEASE_ROOT_FD"]="99991"
os.environ["REVIVAL_HELD_RELEASE_MANIFEST_FD"]="99992"
os.environ["REVIVAL_HELD_RELEASE_ID"]="f"*64

verifier=b'''#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const values=process.argv.slice(2);
if(process.argv[1].match(/^\\/proc\\/self\\/fd\\/[1-9][0-9]*$/u)===null)throw new Error("main is not proc-self");
if(!process.execArgv.includes("--preserve-symlinks-main"))throw new Error("preserve flag missing");
if(values[0]!=="--held-release-root-fd"||values[2]!=="--held-release-manifest-fd"||values[4]!=="--held-release-id")throw new Error("held prefix missing");
const rootFd=Number(values[1]), manifestFd=Number(values[3]), releaseId=values[5];
if(!fs.fstatSync(rootFd).isDirectory()||!fs.fstatSync(manifestFd).isFile())throw new Error("held fd types differ");
const manifest=JSON.parse(fs.readFileSync(manifestFd,"utf8"));
const body={schemaVersion:manifest.schemaVersion,profile:manifest.profile,entries:manifest.entries};
if(crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex")!==releaseId||manifest.releaseId!==releaseId)throw new Error("manifest identity differs");
const own=manifest.entries.find((entry)=>entry.path==="platform/deploy/release-candidate.mjs");
const rootBytes=fs.readFileSync(path.join("/proc/self/fd/"+rootFd,own.path));
if(rootBytes.length!==own.size||crypto.createHash("sha256").update(rootBytes).digest("hex")!==own.sha256)throw new Error("root verifier differs");
const args=values.slice(6); if(args[0]!=="verify"||args[1]!=="--candidate"||args[3]!=="--expect-id"||args[5]!=="--json")throw new Error("public args differ");
const candidate=JSON.parse(fs.readFileSync(path.join(args[2],"candidate.json"),"utf8"));
if(candidate.candidateId!==args[4]||candidate.releaseId!==releaseId)throw new Error("candidate identity differs");
process.stdout.write(JSON.stringify({ok:true,candidateId:candidate.candidateId,releaseId,productionCompatible:true})+"\\n");
'''
action=b'''#!/usr/bin/env bash
set -euo pipefail
source "$REVIVAL_HELD_COMMON"
role="$1"; candidate="$2"; candidate_id="$3"; release_id="$4"; marker="$5"; trace="$6"
[[ "$PATH" == /usr/bin:/usr/sbin && "$HOME" == /nonexistent ]]
[[ ! -v BASH_ENV && ! -v ENV && ! -v LD_PRELOAD && ! -v LD_LIBRARY_PATH && ! -v NODE_OPTIONS && ! -v NODE_PATH && ! -v PYTHONPATH && ! -v PYTHONHOME ]]
[[ "$(type -P node)" == /usr/bin/node && "$(type -P python3)" == /usr/bin/python3 ]]
[[ "$REVIVAL_HOST_BASH" == /usr/bin/bash && "$REVIVAL_HOST_DOCKER" == /usr/bin/docker ]]
result="$(run_held_candidate_verifier verify --candidate "$candidate" --expect-id "$candidate_id" --json)"
node -e 'const v=JSON.parse(process.argv[1]);if(v.ok!==true||v.candidateId!==process.argv[2]||v.releaseId!==process.argv[3]||v.productionCompatible!==true)process.exit(1)' "$result" "$candidate_id" "$release_id"
python3 -c 'import os,sys; assert sys.flags.isolated and sys.dont_write_bytecode and os.environ["PATH"]=="/usr/bin:/usr/sbin"'
bash -c '[[ "$PATH" == /usr/bin:/usr/sbin && ! -v BASH_ENV && ! -v ENV ]]'
sudo -n true
sudo -n python3 -c 'import os,sys; assert sys.flags.isolated and sys.dont_write_bytecode and os.environ["PATH"]=="/usr/bin:/usr/sbin"'
stat -c '%F' "$candidate" >/dev/null
sha256sum "$REVIVAL_HELD_CANDIDATE_VERIFIER" >/dev/null
readlink "/proc/self/fd/$REVIVAL_HELD_RELEASE_ROOT_FD" >/dev/null
flock --version >/dev/null
env -i /usr/bin/true
[[ "$(id -u)" =~ ^[0-9]+$ && "$(basename -- /fixed/name)" == name ]]
[[ "$(printf fixed | tr q z)" == fixed && -n "$(dirname -- /fixed/name)" ]]
[[ "$(type -P stat)" == /usr/bin/stat && "$(type -P sha256sum)" == /usr/bin/sha256sum ]]
printf '%s\\n' "$role" >>"$trace"
printf '%s\\n' "$role" >"$marker"
'''
files={
    "platform/deploy/release-candidate.mjs":(verifier,0o644),
    "platform/deploy/vps/remote/common.sh":(open(common_path,"rb").read(),0o644),
}
for name in ("deploy.sh","rollback.sh","prune-state.sh"):
    files["platform/deploy/vps/remote/"+name]=(action,0o755)
for name in ("paths","ingress","release_transactions","configuration","compose","backup","database","canary","legacy-predecessor","drift"):
    relative="platform/deploy/vps/remote/lib/"+name+".sh"
    files[relative]=(open(os.path.join(common_lib,name+".sh"),"rb").read(),0o644)
entries=[]
for name,(payload,mode) in sorted(files.items()):
    entries.append({"path":name,"sha256":hashlib.sha256(payload).hexdigest(),"size":len(payload),
                    "mode":"0755" if mode==0o755 else "0644"})
body={"schemaVersion":1,"profile":"vps","entries":entries}
release_id=hashlib.sha256(json.dumps(body,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
tree=os.path.join(root,"releases",release_id); os.mkdir(tree,0o700)
for name,(payload,mode) in files.items():
    target=os.path.join(tree,name); os.makedirs(os.path.dirname(target),exist_ok=True)
    descriptor=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    os.write(descriptor,payload); os.fchmod(descriptor,mode); os.close(descriptor)
for current,directories,_ in os.walk(tree):
    os.chmod(current,0o700 if current==tree else 0o755)
manifest=os.path.join(root,"manifests",release_id+".json")
descriptor=os.open(manifest,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
os.write(descriptor,json.dumps({**body,"releaseId":release_id},separators=(",",":"),ensure_ascii=False).encode())
os.fchmod(descriptor,0o600); os.close(descriptor)
candidate_id="a"*64; candidate=os.path.join(root,"release-candidates",candidate_id); os.mkdir(candidate,0o700)
candidate_file=os.path.join(candidate,"candidate.json")
descriptor=os.open(candidate_file,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
os.write(descriptor,json.dumps({"candidateId":candidate_id,"releaseId":release_id},separators=(",",":")).encode())
os.fchmod(descriptor,0o600); os.close(descriptor)

def invoke(role):
    entry="platform/deploy/vps/remote/"+role+".sh"; marker=os.path.join(root,role+".passed")
    saved=sys.argv[:]; old=os.getcwd(); os.chdir(os.path.join(root,"poison-cwd"))
    sys.argv=[helper_path,"--tree",tree,"--manifest",manifest,"--expect-release-id",release_id,
              "--entry",entry,"--interpreter","bash","--",role,candidate,candidate_id,release_id,marker,trace]
    try:
        try: held.main()
        except SystemExit as error: code=error.code
        else: raise AssertionError("held verifier dispatch did not terminate")
    finally: sys.argv=saved; os.chdir(old)
    assert code==0 and open(marker,encoding="utf-8").read()==role+"\n"

for role in ("deploy","rollback","prune-state"): invoke(role)
assert open(trace,encoding="utf-8").read().splitlines()==["deploy","rollback","prune-state"]
assert not os.path.exists(ambient_marker)

# Candidate rejection occurs inside the held verifier, before the simulated
# Docker boundary. The existing successful trace must not gain another row.
descriptor=os.open(candidate_file,os.O_WRONLY|os.O_TRUNC|os.O_NOFOLLOW)
os.write(descriptor,json.dumps({"candidateId":"b"*64,"releaseId":release_id},separators=(",",":")).encode())
os.fchmod(descriptor,0o600); os.close(descriptor)
saved=sys.argv[:]
sys.argv=[helper_path,"--tree",tree,"--manifest",manifest,"--expect-release-id",release_id,
          "--entry","platform/deploy/vps/remote/deploy.sh","--interpreter","bash","--",
          "rejected",candidate,candidate_id,release_id,os.path.join(root,"rejected.passed"),trace]
try:
    try: held.main()
    except SystemExit as error: assert error.code!=0
    else: raise AssertionError("mutated candidate reached Docker")
finally: sys.argv=saved
assert open(trace,encoding="utf-8").read().splitlines()==["deploy","rollback","prune-state"]
assert not os.path.exists(os.path.join(root,"rejected.passed"))
assert not os.path.exists(ambient_marker)

# Docker daemon/context/config selection is rejected before the held action can
# produce either its success marker or any hostile executable marker.
for name,value in (("DOCKER_HOST","tcp://hostile.invalid:2375"),("DOCKER_CONTEXT","hostile"),
                   ("DOCKER_CONFIG",os.path.join(root,"hostile-docker-config"))):
    os.environ[name]=value
    denied=os.path.join(root,"docker-env-"+name+".passed")
    saved=sys.argv[:]
    sys.argv=[helper_path,"--tree",tree,"--manifest",manifest,"--expect-release-id",release_id,
              "--entry","platform/deploy/vps/remote/deploy.sh","--interpreter","bash","--",
              "denied",candidate,"b"*64,release_id,denied,trace]
    try:
        try: held.main()
        except SystemExit as error: assert error.code!=0
        else: raise AssertionError("hostile Docker environment reached held action")
    finally: sys.argv=saved; del os.environ[name]
    assert not os.path.exists(denied) and not os.path.exists(ambient_marker)
`;
  const result = childProcess.spawnSync("python3", ["-I", "-B", "-c", script, directory, heldExec, common, commonLib], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);

  const deploy = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote/deploy.sh"), "utf8");
  const rollback = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote/rollback.sh"), "utf8");
  const compose = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote/lib/compose.sh"), "utf8");
  const prune = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote/prune-state.sh"), "utf8");
  for (const source of [deploy, rollback, compose]) {
    assert.match(source, /run_held_candidate_verifier verify/u);
    assert.doesNotMatch(source, /node\s+"?\$(?:candidate_verifier|target_candidate_verifier|REVIVAL_HELD_CANDIDATE_VERIFIER)/u);
  }
  assert.match(prune, /run_manifest_held_candidate_verifier/u);
  assert.doesNotMatch(prune, /node\s+"?\$current_candidate_verifier/u);
});

test("actual sealed production candidate validates a full fixture through nested deployment roles", (t) => {
  const directory = tempData();
  const candidateData = tempData();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  t.after(() => fs.rmSync(candidateData, { recursive: true, force: true }));
  const heldExec = path.join(ROOT, "platform/deploy/vps/remote/held-release-exec.py");
  const driverRelative = "platform/deploy/vps/remote/actual-verifier-driver.sh";
  const moduleDriverRelative = "platform/deploy/vps/remote/actual-verifier-module-driver.mjs";
  const moduleDriver = Buffer.from([
    "#!/usr/bin/env node",
    'const candidateModule=await import(process.env.REVIVAL_HELD_CANDIDATE_VERIFIER);',
    "const args=process.argv.slice(8);",
    "if(args.length!==2)throw new Error('fixture verifier arguments differ');",
    `const trusted=${JSON.stringify(TEST_THIRD_PARTY_REFERENCES)};`,
    "const result=candidateModule.verifyCandidate(args[0],{expectedId:args[1],trustedThirdPartyImages:trusted});",
    "if(!result.ok||result.candidateId!==args[1])throw new Error('actual production verifier result differs');",
    "process.stdout.write(JSON.stringify({ok:true,candidateId:result.candidateId,releaseId:result.release.releaseId,productionCompatible:true})+'\\n');",
    "",
  ].join("\n"), "utf8");
  const driver = Buffer.from([
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'source "$REVIVAL_HELD_COMMON"',
    'role="$1"; candidate="$2"; candidate_id="$3"; release_id="$4"; trace="$5"',
    'verification="$(node --preserve-symlinks --preserve-symlinks-main "$REVIVAL_HELD_FIXTURE_VERIFIER_DRIVER" --held-release-root-fd "$REVIVAL_HELD_RELEASE_ROOT_FD" --held-release-manifest-fd "$REVIVAL_HELD_RELEASE_MANIFEST_FD" --held-release-id "$REVIVAL_HELD_RELEASE_ID" "$candidate" "$candidate_id")"',
    "node -e 'const value=JSON.parse(process.argv[1]);if(value.ok!==true||value.candidateId!==process.argv[2]||value.releaseId!==process.argv[3]||value.productionCompatible!==true)process.exit(1)' \"$verification\" \"$candidate_id\" \"$release_id\"",
    'printf "%s\\n" "$role" >>"$trace"',
    "",
  ].join("\n"), "utf8");
  const sourceFiles = [
    ...fixtureSourceFiles(),
    { path: "platform/deploy/release-candidate.mjs", data: fs.readFileSync(path.join(ROOT, "platform/deploy/release-candidate.mjs")), mode: 0o644 },
    { path: "platform/deploy/vps/remote/common.sh", data: fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote/common.sh")), mode: 0o644 },
    ...["paths", "ingress", "release_transactions", "configuration", "compose", "backup", "database", "canary", "legacy-predecessor", "drift"].map((name) => ({
      path: `platform/deploy/vps/remote/lib/${name}.sh`,
      data: fs.readFileSync(path.join(ROOT, `platform/deploy/vps/remote/lib/${name}.sh`)),
      mode: 0o644,
    })),
    { path: moduleDriverRelative, data: moduleDriver, mode: 0o755 },
    { path: driverRelative, data: driver, mode: 0o755 },
  ];
  assert.equal(new Set(sourceFiles.map((entry) => entry.path)).size, sourceFiles.length);
  const candidateInput = fixture({ sourceFiles });
  const sealedCandidate = sealCandidateFromBuffers({ dataDir: candidateData, ...candidateInput });
  const releaseId = sealedCandidate.release.releaseId;
  assert.equal(releaseId, candidateInput.releaseManifest.releaseId);
  const releases = path.join(directory, "releases");
  const manifests = path.join(directory, "manifests");
  const poison = path.join(directory, "poison-cwd");
  for (const value of [releases, manifests, poison]) fs.mkdirSync(value, { mode: 0o700 });
  const tree = path.join(releases, releaseId);
  fs.mkdirSync(tree, { mode: 0o700 });
  for (const entry of sourceFiles) {
    const target = path.join(tree, ...entry.path.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.writeFileSync(target, entry.data, { mode: entry.mode });
    fs.chmodSync(target, entry.mode);
  }
  const manifest = path.join(manifests, `${releaseId}.json`);
  fs.writeFileSync(manifest, JSON.stringify(candidateInput.releaseManifest), { mode: 0o600 });
  fs.chmodSync(manifest, 0o600);
  const script = String.raw`
import importlib.util,os,sys
root,helper_path,tree,manifest,release_id,driver,candidate,candidate_id,poison=sys.argv[1:]
spec=importlib.util.spec_from_file_location("held_release_exec",helper_path)
held=importlib.util.module_from_spec(spec); spec.loader.exec_module(held); held.REMOTE_ROOT=root
held.HELD_ENV_BINDINGS[${JSON.stringify(moduleDriverRelative)}]="REVIVAL_HELD_FIXTURE_VERIFIER_DRIVER"
os.mkdir(os.path.join(root,"bin"),0o700)
trace=os.path.join(root,"authority.trace")
ambient_marker=os.path.join(root,"ambient-executable.marker")
for name in ("bash","node","python3","docker","stat","sha256sum","readlink","flock"):
    target=os.path.join(root,"bin",name)
    descriptor=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o755)
    os.write(descriptor,(f'#!/usr/bin/bash\nprintf "%s\\n" {name} >>"{ambient_marker}"\nexit 97\n').encode())
    os.fchmod(descriptor,0o755); os.close(descriptor)
os.environ["PATH"]=os.path.join(root,"bin")+os.pathsep+os.environ.get("PATH","")
for key in list(os.environ):
    if key.upper().startswith("DOCKER_"): del os.environ[key]
for role in ("deploy","rollback","prune-state"):
    saved=sys.argv[:]; old=os.getcwd(); os.chdir(poison)
    sys.argv=[helper_path,"--tree",tree,"--manifest",manifest,"--expect-release-id",release_id,
              "--entry",driver,"--interpreter","bash","--",role,candidate,candidate_id,release_id,trace]
    try:
        try: held.main()
        except SystemExit as error: code=error.code
        else: raise AssertionError("actual verifier driver did not terminate")
    finally: sys.argv=saved; os.chdir(old)
    assert code==0
assert open(trace,encoding="utf-8").read().splitlines()==["deploy","rollback","prune-state"]
assert not os.path.exists(ambient_marker)
`;
  const result = childProcess.spawnSync("python3", ["-I", "-B", "-c", script, directory, heldExec,
    tree, manifest, releaseId, driverRelative, sealedCandidate.root, sealedCandidate.candidateId, poison], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("authoritative release execution has one positive host-command and environment policy", () => {
  const held = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote/held-release-exec.py"), "utf8");
  const common = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote/common.sh"), "utf8");
  const local = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/lib/local.sh"), "utf8");
  const candidate = fs.readFileSync(path.join(ROOT, "platform/deploy/release-candidate.mjs"), "utf8");
  const remotePythonRoot = path.join(ROOT, "platform/deploy/vps/remote");
  const authoritativePython = fs.readdirSync(remotePythonRoot, { recursive: true })
    .filter((name) => name.endsWith(".py"))
    .map((name) => fs.readFileSync(path.join(remotePythonRoot, name), "utf8"));
  const nestedShell = ["deploy.sh", "rollback.sh", "canary.sh", "prune-state.sh"]
    .map((name) => fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote", name), "utf8"));
  const remoteShellRoot = path.join(ROOT, "platform/deploy/vps/remote");
  const remoteShell = fs.readdirSync(remoteShellRoot, { recursive: true })
    .filter((name) => name.endsWith(".sh"))
    .map((name) => fs.readFileSync(path.join(remoteShellRoot, name), "utf8"));

  assert.match(held, /TRUSTED_PATH = "\/usr\/bin:\/usr\/sbin"/u);
  for (const [name, value] of Object.entries({
    bash: "/usr/bin/bash", docker: "/usr/bin/docker", node: "/usr/bin/node",
    python: "/usr/bin/python3", sudo: "/usr/bin/sudo",
  })) assert.match(held, new RegExp(`"${name}": "${value.replaceAll("/", "\\/")}"`, "u"));
  assert.match(held, /def child_environment\([\s\S]*environment = \{[\s\S]*"PATH": TRUSTED_PATH/u);
  assert.match(held, /subprocess\.run\(command,[\s\S]*env=child_environment\(/u);
  assert.match(held, /command = \[executable, "--noprofile", "--norc", held_path\(entry_fd\)/u);
  assert.match(held, /command = \[executable, "-I", "-B", held_path\(entry_fd\)/u);
  assert.match(held, /command = \[sudo, "-n", executable, "-I", "-B", "-"/u);
  assert.doesNotMatch(held, /os\.environ\.copy|dict\(os\.environ\)|\{\*\*os\.environ\}|shutil\.which|sys\.executable/u);

  assert.match(common, /PATH=\/usr\/bin:\/usr\/sbin[\s\S]*readonly PATH HOME/u);
  assert.match(common, /python3\(\) \{ "\$REVIVAL_HOST_PYTHON" -I -B "\$@"; \}/u);
  assert.match(common, /node\(\) \{ "\$REVIVAL_HOST_NODE" "\$@"; \}/u);
  assert.match(common, /bash\(\) \{ "\$REVIVAL_HOST_BASH" --noprofile --norc "\$@"; \}/u);
  assert.match(common, /sudo\(\) \{[\s\S]*sudo command is not allowlisted[\s\S]*"\$REVIVAL_HOST_SUDO"/u);
  assert.match(common, /python3\) _revival_sudo_path="\$REVIVAL_HOST_PYTHON"; _revival_sudo_prefix=\(-I -B\)/u);
  assert.match(common, /nginx\) _revival_sudo_path=\/usr\/sbin\/nginx/u);
  assert.match(common, /docker\(\) \{[\s\S]*\/usr\/bin\/env -i[\s\S]*"\$REVIVAL_HOST_DOCKER"/u);
  assert.match(common, /LD_PRELOAD LD_LIBRARY_PATH[\s\S]*NODE_OPTIONS[\s\S]*PYTHONHOME[\s\S]*DOCKER_CONTEXT/u);

  assert.match(local, /REMOTE_POSITIVE_ENV="\/usr\/bin\/env -i HOME=\/nonexistent[^"]*PATH=\/usr\/bin:\/usr\/sbin/u);
  assert.doesNotMatch(local, /run_ssh "cd /u);
  assert.match(local, /run_ssh "\$REMOTE_CLEAN_BASH -s -- \$remote_args" <<'REMOTE_ACK'[\s\S]*\/usr\/bin\/sha256sum -c/u);
  assert.match(local, /\/usr\/bin\/bash --noprofile --norc "\$tmp_dir\/%s"/u);
  assert.match(candidate, /const python = "\/usr\/bin\/python3"[\s\S]*\["-I", "-B", "-c", script\]/u);
  assert.match(candidate, /spawnSync\("\/usr\/bin\/python3", \["-I", "-B", CANDIDATE_STORE_HELPER/u);
  assert.doesNotMatch(candidate, /spawnSync\("python3", \["-I", "-B", CANDIDATE_STORE_HELPER/u);

  for (const source of [...authoritativePython, ...nestedShell]) {
    assert.doesNotMatch(source, /sys\.executable/u);
    assert.doesNotMatch(source, /shutil\.which|os\.environ\.copy|dict\(os\.environ\)|\{\*\*os\.environ\}/u);
    assert.doesNotMatch(source,
      /subprocess\.(?:run|check_output|check_call|Popen)\(\s*\[\s*["'](?:docker|python3|node|bash)["']/u);
  }
  for (const source of authoritativePython) {
    assert.doesNotMatch(source,
      /subprocess\.(?:run|check_output|check_call|Popen)\(\s*\[\s*["'](?:xattr|env|sudo|sha256sum|readlink|flock)["']/u);
  }
  for (const source of nestedShell) {
    assert.doesNotMatch(source, /subprocess\.(?:check_output|check_call)\(\s*\[\s*["']docker["']/u);
  }
  for (const source of remoteShell) assert.match(source, /^#!\/usr\/bin\/bash\n/u);
});

test("standalone canary and drift activate exact retained candidate authority before dispatch", (t) => {
  const directory = tempData();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const releaseId = "a".repeat(64);
  const release = path.join(directory, "releases", releaseId);
  const record = path.join(directory, "deployments", "standalone-test");
  fs.mkdirSync(release, { recursive: true, mode: 0o700 });
  fs.mkdirSync(record, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(record, "release-id"), `${releaseId}\n`, { mode: 0o600 });
  const trace = path.join(directory, "trace");
  const common = path.join(directory, "held-common.sh");
  fs.writeFileSync(common, [
    'REMOTE_ROOT="$REVIVAL_TEST_ROOT"',
    'RELEASES_DIR="$REMOTE_ROOT/releases"',
    'DEPLOYMENTS_DIR="$REMOTE_ROOT/deployments"',
    'fail() { printf "fail:%s\\n" "$*" >>"$REVIVAL_TEST_TRACE"; return 1; }',
    'validate_release_id() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }',
    'activate_retained_candidate_authority() {',
    '  printf "activate:%s:%s\\n" "$1" "$4" >>"$REVIVAL_TEST_TRACE"',
    '  case "${REVIVAL_TEST_ACTIVATION_MODE:-ok}" in',
    '    missing) return 1 ;;',
    '    partial)',
    '      revival_candidate_authority_required=1',
    '      revival_candidate_authority_release="$1"',
    '      revival_candidate_override_path="$3/$4-images.override.json"',
    '      revival_candidate_override_sha256=""',
    '      return 0 ;;',
    '  esac',
    '  revival_candidate_authority_required=1',
    '  revival_candidate_authority_release="$1"',
    '  revival_candidate_override_path="$3/$4-images.override.json"',
    '  revival_candidate_override_sha256="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"',
    '  revival_candidate_id="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    '  revival_candidate_path="$REVIVAL_TEST_ROOT/release-candidates/$revival_candidate_id"',
    '  revival_candidate_authority_record="$3"',
    '  revival_candidate_authority_receipt_name="$4-compose-authority.json"',
    '  revival_candidate_authority_receipt_sha256="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"',
    '  revival_candidate_compose_model_sha256="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"',
    '}',
    'run_held_release_program() {',
    '  [[ "$1" == "$REVIVAL_HELD_RELEASE_LOGICAL_ROOT" && "$2" == platform/deploy/vps/remote/*.sh ]] || return 1',
    '  printf "dispatch:%s\\n" "${2##*/}" >>"$REVIVAL_TEST_TRACE"',
    '}',
    '',
  ].join("\n"), { mode: 0o600 });
  const entry = path.join(ROOT, "platform/deploy/vps/remote/current-operation.sh");
  const baseEnv = {
    ...process.env,
    REVIVAL_HELD_COMMON: common,
    REVIVAL_HELD_RELEASE_LOGICAL_ROOT: release,
    REVIVAL_HELD_RELEASE_ID: releaseId,
    REVIVAL_TEST_ROOT: directory,
    REVIVAL_TEST_TRACE: trace,
  };
  for (const operation of ["canary.sh", "drift.sh"]) {
    fs.writeFileSync(trace, "");
    const result = childProcess.spawnSync("bash", [entry, "--operation", operation, "--record", record, "--", "--json"], {
      encoding: "utf8", env: { ...baseEnv, REVIVAL_TEST_ACTIVATION_MODE: "ok" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(trace, "utf8").trim().split("\n"), [
      `activate:${release}:standalone-${operation.slice(0, -3)}`,
      `dispatch:${operation}`,
    ]);
  }
  for (const mode of ["missing", "partial"]) {
    fs.writeFileSync(trace, "");
    const result = childProcess.spawnSync("bash", [entry, "--operation", "canary.sh", "--record", record], {
      encoding: "utf8", env: { ...baseEnv, REVIVAL_TEST_ACTIVATION_MODE: mode },
    });
    assert.notEqual(result.status, 0, `${mode} retained candidate authority unexpectedly fell back`);
    assert.doesNotMatch(fs.readFileSync(trace, "utf8"), /dispatch:/u);
  }
});

test("production consumes one candidate with resumable ACKed transport and has no remote recipe path", () => {
  const local = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/deploy.sh"), "utf8");
  const bootstrap = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/lib/local.sh"), "utf8");
  const remote = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote/deploy.sh"), "utf8");
  const rollback = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote/rollback.sh"), "utf8");
  const runtime = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote/candidate-runtime.py"), "utf8");
  const candidateAuthority = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote/candidate-authority-exec.py"), "utf8");
  const candidateStore = fs.readFileSync(path.join(ROOT, "platform/deploy/candidate-store.py"), "utf8");
  const retentionStore = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote/retention-store.py"), "utf8");
  const bootstrapRelease = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote/bootstrap-release.py"), "utf8");
  const releaseStore = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote/release-store.py"), "utf8");
  const heldCompose = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote/held-compose.py"), "utf8");
  const composeLibrary = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote/lib/compose.sh"), "utf8");
  const currentOperation = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote/current-operation.sh"), "utf8");
  const drift = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote/drift.sh"), "utf8");
  const releaseTransactions = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote/lib/release_transactions.sh"), "utf8");
  const cli = fs.readFileSync(path.join(ROOT, "platform/cli/production.js"), "utf8");
  const candidateTool = fs.readFileSync(path.join(ROOT, "platform/deploy/release-candidate.mjs"), "utf8");

  assert.match(cli, /requires exactly one of --candidate PATH or --candidate-id SHA256/u);
  assert.match(cli, /no longer accepts --release-json or builds implicitly/u);
  assert.doesNotMatch(cli, /packageForDeployment|releaseCheck\(/u);
  assert.match(local, /productionStateForSnapshot\(process\.cwd\(\)\)[\s\S]*assertLegacyProductionCompatible\(reviewedProductionState\)[\s\S]*candidate production-state differs from the freshly rederived reviewed source authority[\s\S]*assertLegacyProductionCompatible\(verified\.productionState\)[\s\S]*local_preflight/u);
  assert.match(local, /assertReleaseProtocolManifestMatchesTrusted\(verified\.manifest\)/u);
  assert.match(local, /authorize-deploy[\s\S]*--candidate-id[\s\S]*--candidate[\s\S]*--json/u);
  assert.match(local, /HOSTED_CANDIDATE_AUTHORITY[\s\S]*local candidate is candidate\/debug-only and cannot be deployed/u);
  assert.match(local, /deployment-authority\.json[\s\S]*deployment_authority_sha256[\s\S]*transport\.sha256/u);
  assert.match(bootstrap, /deployment-authority\.json[\s\S]*point-of-use-reverified[\s\S]*--deployment-authority-sha256/u);
  assert.match(remote, /deployment-authority-sha256[\s\S]*hosted-vps-authority\.json[\s\S]*hosted-vps-authority\.sha256/u);
  assert.match(remote, /verify_hosted_rollback_baseline "\$old_current" "\$old_current_deployment"/u);
  const rollbackBaselineGate = remote.indexOf('verify_hosted_rollback_baseline "$old_current" "$old_current_deployment"');
  const firstCutoverGuard = remote.indexOf('[[ -z "$old_current_deployment" && -z "$old_previous" ]]', rollbackBaselineGate);
  const firstCutoverSelection = remote.indexOf('legacy_predecessor_id="$(active_legacy_predecessor_id)"', firstCutoverGuard);
  const firstCutoverProof = remote.indexOf('verify_legacy_predecessor "$legacy_predecessor_id" active', firstCutoverSelection);
  const firstTopologyDocker = remote.indexOf('docker ps -q --filter "label=com.docker.compose.project=$LEGACY_PROJECT"', rollbackBaselineGate);
  const predecessorActivation = remote.indexOf('activate_record_candidate_if_present "$old_current" "$old_current_deployment"', rollbackBaselineGate);
  assert.ok(rollbackBaselineGate >= 0 && firstTopologyDocker > rollbackBaselineGate);
  assert.ok(firstCutoverGuard > rollbackBaselineGate && firstCutoverSelection > firstCutoverGuard && firstCutoverProof > firstCutoverSelection);
  assert.ok(predecessorActivation > rollbackBaselineGate);
  assert.doesNotMatch(local, /immutable-candidate protocol marker|\.includes\(marker\)/u);
  assert.match(bootstrap, /for attempt in 1 2 3; do/u);
  assert.match(bootstrap, /--partial --append-verify --protect-args/u);
  assert.match(bootstrap, /sha256sum -c transport\.sha256/u);
  assert.match(bootstrap, /--candidate-id[\s\S]*--candidate-root/u);
  assert.match(remote, /python3 -I "\$candidate_authority_exec"[\s\S]*--candidate "\$candidate_store"[\s\S]*--program "\$candidate_runtime"/u);
  assert.match(candidateAuthority, /seal_bytes\(model_bytes, model_digest\)[\s\S]*--compose-model-fd/u);
  assert.match(candidateAuthority, /record_meta\.st_dev[\s\S]*record_meta\.st_ino/u);
  assert.match(runtime, /descriptor_fd, descriptor_meta = open_regular\(candidate, "candidate\.json"/u);
  assert.match(runtime, /receipt_fd, receipt_meta = open_regular\(candidate, "image-receipt\.json"/u);
  assert.match(runtime, /bundle_fd, bundle_meta = open_regular\(candidate, "images\.tar"/u);
  assert.match(runtime, /subprocess\.run\(\[docker, "image", "load"\], stdin=stream/u);
  assert.match(runtime, /model_source_bytes != model_bytes[\s\S]*REQUIRED_SEALS/u);
  assert.match(runtime, /EXPECTED_DOCKER_HOST = "unix:\/\/\/var\/run\/docker\.sock"/u);
  assert.match(remote, /assert_candidate_override_held/u);
  assert.match(remote, /revival_candidate_override_path="\$candidate_override_disk"/u);
  assert.match(runtime, /model_image_id != references\[reference\]\[1\][\s\S]*services\[name\] = \{"image": model_image_id\}/u);
  assert.match(runtime, /"helperReference": references\[arguments\.helper_reference\]\[1\]/u);
  assert.match(composeLibrary, /COMPOSE=\("\$REVIVAL_HOST_PYTHON" -I -B "\$REVIVAL_HELD_CANDIDATE_AUTHORITY_EXEC"[\s\S]*--program "\$REVIVAL_HELD_COMPOSE"/u);
  assert.match(currentOperation, /activate_retained_candidate_authority "\$release" "\$record" "\$record" "\$prefix"[\s\S]*run_held_release_program/u);
  assert.match(currentOperation, /revival_candidate_authority_required:-0[\s\S]*revival_candidate_override_sha256/u);
  assert.match(bootstrap, /canary\.sh\|drift\.sh[\s\S]*current-operation\.sh/u);
  assert.match(drift, /run_held_release_program "\$current"[\s\S]*canary\.sh/u);
  assert.doesNotMatch(drift, /(?:bash|sh|source|exec)\s+"\$current\/[^"\n]*\.sh"/u);
  assert.match(releaseTransactions, /run_cross_release_script\(\)[\s\S]*run_held_release_program/u);
  assert.match(heldCompose, /IMAGE_ID = re\.compile\(r"\^sha256:\[0-9a-f\]\{64\}\$"\)/u);
  assert.match(heldCompose, /model_image_id != reference_ids\[reference\]\[0\][\s\S]*expected_override\[service\] = \{"image": model_image_id\}/u);
  assert.match(heldCompose, /return \[\*command\[:index\], "--file", override, \*command\[index:\]\]/u);
  assert.match(heldCompose, /if identity\(current\) != identity\(opened\) or identity\(os\.fstat\(descriptor\)\) != identity\(opened\)/u);
  assert.match(remote, /release-store\.py/u);
  assert.match(releaseStore, /rename_no_replace\(staging_fd, "tree", releases, arguments\.release_id\)/u);
  for (const [name, source] of Object.entries({ candidateStore, retentionStore, bootstrapRelease, releaseStore })) {
    assert.doesNotMatch(source, /os\.(?:unlink|rmdir)\s*\(/u, `${name} reopened a stat-to-delete race`);
    assert.doesNotMatch(source, /os\.ftruncate\s*\(/u, `${name} destructively truncated recoverable bytes`);
    assert.match(source, /class RetirementAuthority/u, `${name} does not hold the complete retirement tree`);
    assert.match(source, /class RetirementMonitor/u, `${name} does not watch the held retirement authority`);
    assert.match(source, /retirement_checkpoint\("after-final-proof"/u,
      `${name} does not retain its authority through the final proof`);
    assert.match(source, /retirement_checkpoint\("before-return"/u,
      `${name} has no pre-commit proof near the return boundary`);
    assert.match(source, /retirement_checkpoint\("transaction-close"/u,
      `${name} has no final pre-commit mutation seam`);
    assert.match(source, /LINEARIZATION POINT:[\s\S]*retirement_checkpoint\("transaction-commit"/u,
      `${name} does not define the explicit final-drain commit point`);
    assert.match(source, /retirement_checkpoint\("post-commit"/u,
      `${name} has no deterministic post-linearization mutation seam`);
    assert.match(source, /def verify_retirement_receipt\([\s\S]*O_NOFOLLOW[\s\S]*digest\[:32\]/u,
      `${name} lets a later consumer trust the mutable receipt path without recomputation`);
  }
  assert.doesNotMatch(bootstrap, /os\.(?:unlink|rmdir)\s*\(/u);
  assert.doesNotMatch(remote, /mv "\$incoming_release"|rm -rf -- "\$incoming_release/u);
  assert.doesNotMatch(remote, /docker\s+(?:image\s+)?pull\b|"\$\{COMPOSE\[@\]\}"\s+build\b/u);
  for (const invocation of remote.matchAll(/"\$\{COMPOSE\[@\]\}" up[^\n]*/gu)) {
    assert.match(invocation[0], /--pull never/u);
    assert.match(invocation[0], /--no-build/u);
  }
  assert.doesNotMatch(rollback, /transport\.sha256/u);
  assert.match(rollback, /activate_retained_candidate_authority "\$target_release" "\$target_record" "\$record"[\s\S]*rollback-candidate/u);
  assert.doesNotMatch(rollback, /rollback-candidate-compose-model\.json/u);
  assert.match(rollback, /apply_retained_candidate_image_override/u);
  assert.doesNotMatch(candidateTool, /readFileSync\(imageBundlePath|readFileSync\(archivePath|gitArchive\.stdout/u);
  assert.match(candidateTool, /\["cat-file", "--batch"\]/u);
  assert.match(candidateTool, /createRawGitArchive/u);
  assert.match(candidateTool, /sealCandidateFromFiles/u);
});

test("routine canonical rollback predecessors still require hosted candidate authority before Docker", (t) => {
  const directory = tempData();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const remote = fs.readFileSync(path.join(ROOT, "platform/deploy/vps/remote/deploy.sh"), "utf8");
  const helperStart = remote.indexOf("verify_hosted_deployment_authority() {");
  const helperEnd = remote.indexOf("\n}\n\nactivate_record_candidate_if_present()", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helpers = remote.slice(helperStart, helperEnd + 3);

  const releaseId = "a".repeat(64);
  const candidateId = "b".repeat(64);
  const releases = path.join(directory, "releases");
  const deployments = path.join(directory, "deployments");
  const candidates = path.join(directory, "release-candidates");
  const selectedRelease = path.join(releases, releaseId);
  const selectedRecord = path.join(deployments, "canonical-predecessor");
  const selectedCandidate = path.join(candidates, candidateId);
  for (const current of [releases, deployments, candidates, selectedRelease, selectedRecord, selectedCandidate]) {
    fs.mkdirSync(current, { mode: 0o700 });
  }
  for (const [name, value] of [
    ["release-id", releaseId],
    ["candidate-id", candidateId],
    ["candidate-path", selectedCandidate],
  ]) fs.writeFileSync(path.join(selectedRecord, name), `${value}\n`, { mode: 0o600 });

  const fakeBin = path.join(directory, "bin");
  fs.mkdirSync(fakeBin, { mode: 0o700 });
  const dockerMarker = path.join(directory, "docker-called");
  fs.writeFileSync(path.join(fakeBin, "docker"), `#!/bin/sh\n: >${JSON.stringify(dockerMarker)}\nexit 97\n`, { mode: 0o700 });
  const verifierMarker = path.join(directory, "candidate-verifier-called");
  const script = `set -euo pipefail
REMOTE_ROOT=$1
RELEASES_DIR=$2
DEPLOYMENTS_DIR=$3
REVIVAL_HOST_NODE=/usr/bin/node
validate_release_id() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }
run_held_candidate_verifier() { : >"$4"; return 97; }
${helpers}
if verify_hosted_rollback_baseline "$5" "$6"; then exit 91; fi
[[ ! -e "$7" && ! -e "$4" ]]
`;
  const result = childProcess.spawnSync("/usr/bin/bash", ["-c", script, "baseline-test",
    directory, releases, deployments, verifierMarker, selectedRelease, selectedRecord, dockerMarker], {
    encoding: "utf8",
    env: { PATH: `${fakeBin}:/usr/bin:/usr/sbin`, HOME: "/nonexistent", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(dockerMarker), false);
  assert.equal(fs.existsSync(verifierMarker), false);
});

test("resumable candidate transport uses exactly three attempts and requires the hash ACK", (t) => {
  const source = tempData();
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  const library = path.join(ROOT, "platform/deploy/vps/lib/local.sh");
  const remote = path.join(LEGACY_PRODUCTION_STATE.protectedRoot, "incoming", "a".repeat(64), ".candidate-test.partial");
  const ack = "b".repeat(64);
  const failed = childProcess.spawnSync("bash", ["-c", `
    source "$1"
    count=0
    trap 'printf "attempts=%s\\n" "$count" >&2' EXIT
    rsync() { count=$((count+1)); return 1; }
    run_ssh() { return 99; }
    transfer_candidate_resumably "$2" "$3" "$4"
  `, "candidate-transfer-test", library, source, remote, ack], { encoding: "utf8" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /exactly 3 resumable attempts/u);
  assert.match(failed.stderr, /attempts=3/u);

  const ackFailed = childProcess.spawnSync("bash", ["-c", `
    source "$1"
    transfers=0
    trap 'printf "transfers=%s\\n" "$transfers" >&2' EXIT
    rsync() { transfers=$((transfers+1)); return 0; }
    run_ssh() { printf 'ack-call\\n' >&2; return 99; }
    transfer_candidate_resumably "$2" "$3" "$4"
  `, "candidate-transfer-test", library, source, remote, ack], { encoding: "utf8" });
  assert.notEqual(ackFailed.status, 0);
  assert.match(ackFailed.stderr, /exactly 3 resumable attempts/u);
  assert.match(ackFailed.stderr, /transfers=3/u);
  assert.equal(ackFailed.stderr.match(/ack-call/gu)?.length, 3);

  const recovered = childProcess.spawnSync("bash", ["-c", `
    source "$1"
    count=0
    expected="$4"
    rsync() { count=$((count+1)); return 0; }
    run_ssh() { if ((count == 1)); then printf '%064d\n' 0; else printf '%s\n' "$expected"; fi; }
    transfer_candidate_resumably "$2" "$3" "$4"
    printf 'attempts=%s\n' "$count"
  `, "candidate-transfer-test", library, source, remote, ack], { encoding: "utf8" });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stdout, /attempts=2/u);
});
