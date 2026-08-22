import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  assertPersistedHostedVpsBindings,
  parsePersistedHostedVpsEvidenceManifest,
} from "../hosted-vps-candidate.mjs";
import {
  createDockerVpsCandidateVerificationInvocation,
  hostedVerifierBrokerPlatformSupported,
} from "../pin/build.mjs";
import {
  canonicalJson,
  loadPolicy,
  parseHostedVpsCandidateReceipt,
} from "../pin/hosted-attestation.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureEvidenceManifest(receipt) {
  const files = [
    "hosted-vps-receipt.json",
    "provider.sigstore.json",
    "verification.json",
    "evidence.json",
  ].map((name, index) => ({ name, size: index + 10, sha256: digest(`evidence-${index}`) }));
  const candidateRoot = `/tmp/revival-data/release-candidates/${receipt.candidateId}`;
  return {
    candidateRoot,
    files,
    pointer: {
      candidateId: receipt.candidateId,
      releaseId: receipt.releaseId,
    },
    manifest: {
      schema: "revival.hosted-vps-candidate-import",
      version: 2,
      policySha256: receipt.policySha256,
      repository: receipt.repository,
      sourceRef: receipt.sourceRef,
      runnerEnvironment: receipt.runnerEnvironment,
      runnerLabel: receipt.runnerLabel,
      runnerArchitecture: receipt.runnerArchitecture,
      runnerInvocationUri: receipt.runnerInvocationUri,
      candidateId: receipt.candidateId,
      releaseId: receipt.releaseId,
      sourceDigest: receipt.sourceDigest,
      sourceTree: receipt.sourceTree,
      sourceArchiveSha256: receipt.sourceArchiveSha256,
      importedCandidateRoot: candidateRoot,
      inventorySha256: digest(canonicalJson(receipt.files)),
      files,
    },
  };
}

async function fixtureReceipt() {
  const policyRecord = await loadPolicy();
  const files = policyRecord.policy.vpsCandidate.files.map((file, index) => ({
    ...file,
    sha256: digest(`${file.role}-${index}`),
    size: index + 1,
  }));
  const byRole = new Map(files.map((file) => [file.role, file]));
  return {
    policyRecord,
    receipt: {
      schema: policyRecord.policy.vpsCandidate.receiptSchema,
      version: 1,
      policySha256: policyRecord.sha256,
      repository: policyRecord.policy.repository,
      sourceRef: policyRecord.policy.sourceRef,
      sourceDigest: "1".repeat(40),
      sourceTree: "2".repeat(40),
      runnerEnvironment: "github-hosted",
      runnerLabel: "ubuntu-24.04",
      runnerArchitecture: "x64",
      runnerInvocationUri: "https://github.com/TheAndersMadsen/ai-pin-revival/actions/runs/123/attempts/1",
      candidateId: "3".repeat(64),
      releaseId: "4".repeat(64),
      sourceArchiveSha256: byRole.get("source-snapshot").sha256,
      sourceReceiptSha256: byRole.get("source-snapshot-receipt").sha256,
      toolchainReceiptSha256: byRole.get("toolchain-receipt").sha256,
      imageReceiptSha256: byRole.get("docker-image-receipt").sha256,
      imageBundleSha256: byRole.get("docker-image-bundle").sha256,
      files,
    },
  };
}

test("the hosted VPS receipt binds the fixed workflow and exact candidate inventory", async () => {
  const { policyRecord, receipt } = await fixtureReceipt();
  const parsed = parseHostedVpsCandidateReceipt(receipt, policyRecord);
  assert.equal(parsed.files.length, 13);
  assert.equal(parsed.files[0].role, "candidate-descriptor");
  assert.equal(canonicalJson(parsed), canonicalJson(receipt));

  assert.throws(
    () => parseHostedVpsCandidateReceipt({
      ...receipt,
      toolchainReceiptSha256: "f".repeat(64),
    }, policyRecord),
    /toolchainReceiptSha256/u,
  );
  assert.throws(
    () => parseHostedVpsCandidateReceipt({
      ...receipt,
      files: [...receipt.files.slice(0, -1), { ...receipt.files.at(-1), role: "extra" }],
    }, policyRecord),
    /role differs/u,
  );
});

test("the hosted VPS verifier invocation has fixed offline authority", () => {
  const invocation = createDockerVpsCandidateVerificationInvocation({
    receiptPath: "/handoff/receipt.json",
    bundlePath: "/handoff/provider.sigstore.json",
    candidateRoot: "/handoff/release-candidates/id",
    outputRoot: "/verification-output",
    verifierAuthority: {
      imageId: "sha256:854cb78ac3ed2e215515e3ed78bf40a955bde16fc74114051a1850e509f602e6",
      nodePath: "/usr/local/bin/node",
      uid: 1000,
      gid: 1000,
      paths: {
        verifier: "/proc/321/fd/10",
        policy: "/proc/321/fd/11",
        trustedRoot: "/proc/321/fd/12",
        boundedProcess: "/proc/321/fd/13",
        githubCli: "/proc/321/fd/14",
      },
    },
  });
  assert.equal(invocation.command, "/usr/bin/docker");
  assert.ok(invocation.args.includes("linux/amd64"));
  assert.ok(invocation.args.includes("none"));
  assert.ok(invocation.args.includes("verify-vps-candidate"));
  assert.match(invocation.args.join(" "), /src=\/proc\/321\/fd\/13,dst=\/usr\/local\/libexec\/ai-pin-hosted-attestation\/bounded-process\.mjs,readonly/u);
  assert.match(invocation.args.join(" "), /src=\/proc\/321\/fd\/14,dst=\/usr\/bin\/gh,readonly/u);
  assert.ok(!invocation.args.join(" ").includes(process.env.PATH ?? "fixture-path"));
});

test("persisted VPS evidence is a closed v2 binding and rejects stale or cross-run records", async () => {
  const { receipt } = await fixtureReceipt();
  const fixture = fixtureEvidenceManifest(receipt);
  const parsed = parsePersistedHostedVpsEvidenceManifest(canonicalJson(fixture.manifest), fixture.pointer);
  assert.doesNotThrow(() => assertPersistedHostedVpsBindings(
    parsed,
    receipt,
    fixture.candidateRoot,
    fixture.files,
  ));

  for (const [label, change] of [
    ["stale schema", (manifest) => { manifest.version = 1; }],
    ["cross-candidate", (manifest) => { manifest.candidateId = "b".repeat(64); }],
    ["wrong evidence role", (manifest) => { manifest.files[0].name = "substitute.json"; }],
    ["unknown field", (manifest) => { manifest.untrusted = true; }],
  ]) {
    const changed = structuredClone(fixture.manifest);
    change(changed);
    assert.throws(
      () => parsePersistedHostedVpsEvidenceManifest(canonicalJson(changed), fixture.pointer),
      /status|unsupported|inventory/u,
      label,
    );
  }

  for (const [label, change] of [
    ["cross-run", (manifest) => { manifest.runnerInvocationUri = manifest.runnerInvocationUri.replace("/123/", "/124/"); }],
    ["cross-source", (manifest) => { manifest.sourceDigest = "a".repeat(40); }],
  ]) {
    const changed = structuredClone(fixture.manifest);
    change(changed);
    const validShape = parsePersistedHostedVpsEvidenceManifest(canonicalJson(changed), fixture.pointer);
    assert.throws(
      () => assertPersistedHostedVpsBindings(validShape, receipt, fixture.candidateRoot, fixture.files),
      /differs from its receipt/u,
      label,
    );
  }

  const replayedReceipt = structuredClone(receipt);
  replayedReceipt.runnerInvocationUri = replayedReceipt.runnerInvocationUri.replace("/123/", "/125/");
  assert.throws(
    () => assertPersistedHostedVpsBindings(parsed, replayedReceipt, fixture.candidateRoot, fixture.files),
    /runnerInvocationUri/u,
  );
  const changedFiles = structuredClone(fixture.files);
  changedFiles[2].sha256 = "c".repeat(64);
  assert.throws(
    () => assertPersistedHostedVpsBindings(parsed, receipt, fixture.candidateRoot, changedFiles),
    /evidence differs/u,
  );
});

test("status and authorize-deploy rerun the fixed provider verifier and compare canonical evidence", async () => {
  const source = await readFile(resolve(ROOT, "platform/deploy/hosted-vps-candidate.mjs"), "utf8");
  const statusStart = source.indexOf("export async function hostedVpsCandidateStatus");
  const statusEnd = source.indexOf("function defaultDataDir", statusStart);
  assert.ok(statusStart >= 0 && statusEnd > statusStart);
  const status = source.slice(statusStart, statusEnd);
  assert.match(status, /verifyHostedVpsCandidateHandoff\(\{/u);
  assert.match(status, /verifierCacheRoot/u);
  assert.match(status, /provider\.verificationBytes\.equals\(persistedVerification\)/u);
  assert.match(status, /provider\.evidenceBytes\.equals\(persistedEvidence\)/u);
  assert.match(status, /point-of-use-reverified/u);
  assert.match(status, /pointerAfter\.bytes\.equals\(pointerRead\.bytes\)/u);
  assert.match(status, /manifestAfter\.bytes\.equals\(manifestRead\.bytes\)/u);
  assert.doesNotMatch(status, /persisted-and-rehashed/u);
  assert.match(source, /authorize-deploy --candidate PATH --candidate-id SHA256/u);
  assert.match(source, /expectedCandidateId: candidateId/u);
  assert.match(source, /expectedCandidateRoot: candidate/u);
  assert.match(source, /command === "authorize-deploy" && \(!options\.candidate \|\| !options\.candidateId \|\| !options\.json\)/u);
});

test("the sealed provider verifier broker is explicitly Linux x64 only", () => {
  assert.equal(hostedVerifierBrokerPlatformSupported("linux", "x64"), true);
  for (const [platform, architecture] of [
    ["linux", "arm64"],
    ["darwin", "x64"],
    ["darwin", "arm64"],
    ["win32", "x64"],
  ]) assert.equal(hostedVerifierBrokerPlatformSupported(platform, architecture), false);
});

test("the hosted workflow is x64-only, bounded, SHA-pinned, and has no release authority", async () => {
  const source = await readFile(resolve(ROOT, ".github/workflows/vps-candidate.yml"), "utf8");
  assert.match(source, /runs-on: ubuntu-24\.04/u);
  assert.match(source, /timeout-minutes: 180/u);
  assert.match(source, /test "\$\{RUNNER_ARCH\}" = "X64"/u);
  assert.match(source, /toolchain: 1\.91\.1/u);
  assert.match(source, /node \/usr\/bin\/node/u);
  assert.match(source, /npm-cli\.js \/usr\/bin\/npm/u);
  assert.match(source, /--source-digest "\$\{GITHUB_SHA\}"/u);
  assert.match(source, /release-candidate\.mjs prepare[\s\S]*--hosted-workflow[\s\S]*--json/u);
  assert.match(source, /subject-checksums:/u);
  assert.match(source, /predicate-path:/u);
  assert.match(source, /actions\/attest@[0-9a-f]{40}/u);
  assert.match(source, /actions\/upload-artifact@[0-9a-f]{40}/u);
  assert.doesNotMatch(source, /\blatest\b/u);
  assert.doesNotMatch(source, /secrets\.|deploy production|pin release ship|ssh\b|environment:/u);

  const handoff = await readFile(resolve(ROOT, "platform/deploy/hosted-vps-candidate.mjs"), "utf8");
  assert.match(handoff, /HOSTED_CANDIDATE_AUTHORITY/u);
  assert.match(handoff, /candidate\.authority[\s\S]*GitHub-hosted provider-evidence use/u);
});

test("hosted-only cutover requires an attested rollback baseline and rejects legacy authority", async () => {
  const [candidate, handoff, operations, reference, installation] = await Promise.all([
    readFile(resolve(ROOT, "platform/deploy/release-candidate.mjs"), "utf8"),
    readFile(resolve(ROOT, "platform/deploy/hosted-vps-candidate.mjs"), "utf8"),
    readFile(resolve(ROOT, "docs/operations.md"), "utf8"),
    readFile(resolve(ROOT, "docs/cli-reference.md"), "utf8"),
    readFile(resolve(ROOT, "docs/installation.md"), "utf8"),
  ]);
  assert.match(candidate, /export const CANDIDATE_SCHEMA_VERSION = 4;/u);
  assert.match(candidate, /descriptor\.schemaVersion !== CANDIDATE_SCHEMA_VERSION/u);
  assert.match(handoff, /canonicalJson\(candidate\.authority\) !== canonicalJson\(HOSTED_CANDIDATE_AUTHORITY\)/u);
  for (const document of [operations, reference, installation]) {
    assert.match(document, /currently running production release|currently running production/u);
    assert.match(document, /rollback baseline/u);
    assert.match(document, /schemas 2 and 3|schemas 2\/3/u);
    assert.match(document, /no legacy (?:adoption|auto-adoption)/u);
  }
  assert.match(operations, /Carry→Cosmos migration[\s\S]*current immutable Carry production baseline/u);
});

test("sealed runtime policy hashes the candidate-aware verifier and policy", async () => {
  const runtime = JSON.parse(await readFile(resolve(ROOT, "platform/deploy/pin/hosted-verifier-runtime-policy.json"), "utf8"));
  for (const entry of runtime.files) {
    const bytes = await readFile(resolve(ROOT, entry.source));
    assert.equal(digest(bytes), entry.sha256, entry.source);
  }
});

test("the fixed gh archive cache is external, digest-addressed, locked, and rehashed", async () => {
  const source = await readFile(resolve(ROOT, "platform/deploy/pin/build.mjs"), "utf8");
  const cacheStart = source.indexOf("async function requireCachedGithubCliArchive");
  const cacheEnd = source.indexOf("function parseSealedVerifierPaths", cacheStart);
  assert.ok(cacheStart >= 0 && cacheEnd > cacheStart);
  const cache = source.slice(cacheStart, cacheEnd);
  assert.match(cache, /requireOutsideSource\(root, "hosted verifier cache"\)/u);
  assert.match(cache, /`\$\{digest\}\.gh-linux-amd64\.tar\.gz`/u);
  assert.match(cache, /acquireHeldFileLock/u);
  assert.match(cache, /requireFixedGithubCliArchive\(archivePath, runtimePolicy\)/u);
  assert.ok(
    cache.indexOf("acquireHeldFileLock") < cache.indexOf("requireFixedGithubCliArchive"),
    "the held cache lock must precede download or rehash",
  );
  assert.match(source, /archive differs from its policy SHA-256/u);
  assert.match(source, /readStableFixedFile\(selected, "fixed GitHub CLI verifier archive"/u);
});
