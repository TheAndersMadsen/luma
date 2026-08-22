import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  canonicalJson,
  loadPolicy,
  parseAuthorityEvidenceBytes,
  parseVerifierOutput,
} from "../pin/hosted-attestation.mjs";
import {
  PIN_COMPATIBILITY_CERT_SHA256,
  PinReleaseBuildError,
  buildAndPublishPinRelease,
  createDockerPreVerificationInvocation,
  createDockerReleaseVerificationInvocation,
  parseBuilderMetadata,
  parsePersistedHostedAuthorityBindingFixture,
  publishPinReleaseFixture,
  validateHostedVerifierArchiveFixture,
} from "../pin/build.mjs";
import { PIN_RELEASE_ARTIFACT_ROLES, PIN_RELEASE_PACKAGE_BY_ROLE } from "../pin/release.mjs";
import { createLocalTransport, shipPinRelease } from "../pin/ship.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function tarOctal(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function tarArchive(entries, trailing = Buffer.alloc(0)) {
  const records = [];
  for (const { name, bytes, mode = 0o755 } of entries) {
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, "utf8");
    header.write(tarOctal(mode, 8), 100, 8, "ascii");
    header.write(tarOctal(0, 8), 108, 8, "ascii");
    header.write(tarOctal(0, 8), 116, 8, "ascii");
    header.write(tarOctal(bytes.length, 12), 124, 12, "ascii");
    header.write(tarOctal(1, 12), 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512, 0);
    records.push(header, bytes, padding);
  }
  return Buffer.concat([gzipSync(Buffer.concat([...records, Buffer.alloc(1024, 0)])), trailing]);
}

function syntheticElf(machine = 62) {
  const bytes = Buffer.alloc(64, 0);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  bytes.writeUInt16LE(machine, 18);
  return bytes;
}

async function policyFixture() {
  const policyRecord = await loadPolicy();
  const request = {
    schema: "revival.pin-hosted-release-request",
    version: 1,
    policySha256: policyRecord.sha256,
    repository: policyRecord.policy.repository,
    sourceRef: policyRecord.policy.sourceRef,
    sourceDigest: "a".repeat(40),
    sourceGenerationSha256: "b".repeat(64),
    sourceTarSha256: "c".repeat(64),
    builderImageId: `sha256:${"d".repeat(64)}`,
    toolchainSha256: "e".repeat(64),
    versionName: "2026-08-22.1",
    versionCode: 202_608_221,
    roles: policyRecord.policy.roles,
  };
  const artifacts = policyRecord.policy.roles.map((role, index) => ({
    role,
    name: `${role}.apk`,
    sha256: String(index + 1).repeat(64),
    size: index + 1,
  }));
  return { policyRecord, request, artifacts };
}

function certificate(policy, request, overrides = {}) {
  return {
    certificateIssuer: "CN=GitHub Artifact Attestation CA,O=GitHub\, Inc.",
    subjectAlternativeName: policy.signerWorkflowUri,
    issuer: policy.issuer,
    githubWorkflowTrigger: policy.workflowTrigger,
    githubWorkflowSHA: request.sourceDigest,
    githubWorkflowName: policy.workflowName,
    githubWorkflowRepository: policy.repository,
    githubWorkflowRef: policy.sourceRef,
    buildSignerURI: policy.signerWorkflowUri,
    buildSignerDigest: request.sourceDigest,
    runnerEnvironment: policy.runnerEnvironment,
    sourceRepositoryURI: policy.repositoryUri,
    sourceRepositoryDigest: request.sourceDigest,
    sourceRepositoryRef: policy.sourceRef,
    sourceRepositoryIdentifier: "1234",
    sourceRepositoryOwnerURI: policy.repositoryOwnerUri,
    sourceRepositoryOwnerIdentifier: "5678",
    buildConfigURI: policy.signerWorkflowUri,
    buildConfigDigest: request.sourceDigest,
    buildTrigger: policy.workflowTrigger,
    runInvocationURI: "https://github.com/TheAndersMadsen/ai-pin-revival/actions/runs/42/attempts/1",
    sourceRepositoryVisibilityAtSigning: policy.sourceVisibility,
    ...overrides,
  };
}

function verifierDocument({ policy, request, predicateType, predicate, subjects, certificateOverrides = {} }) {
  return JSON.stringify([{
    attestation: {},
    verificationResult: {
      mediaType: "application/vnd.dev.sigstore.verificationresult+json;version=0.1",
      statement: {
        _type: "https://in-toto.io/Statement/v1",
        subject: subjects.map(({ name, sha256: digest }) => ({ name, digest: { sha256: digest } })),
        predicateType,
        predicate,
      },
      signature: { certificate: certificate(policy, request, certificateOverrides) },
      verifiedTimestamps: [{ type: "TSA", uri: "https://timestamp.github.com", timestamp: "2026-08-22T00:00:00Z" }],
      verifiedIdentity: {},
    },
  }]);
}

test("provider certificate parser accepts only the pinned workflow/run and exact subjects", async () => {
  const { policyRecord, request, artifacts } = await policyFixture();
  const predicate = {
    schema: "revival.pin-hosted-five-apk",
    version: 1,
    requestSha256: "f".repeat(64),
    preSignBundleSha256: "0".repeat(64),
    runnerInvocationUri: "https://github.com/TheAndersMadsen/ai-pin-revival/actions/runs/42/attempts/1",
    artifacts,
  };
  const options = {
    policy: policyRecord.policy,
    request,
    predicateType: policyRecord.policy.releasePredicateType,
    predicate,
    expectedSubjects: artifacts.map(({ name, sha256: digest }) => ({ name, sha256: digest })),
    expectedRunUri: predicate.runnerInvocationUri,
  };
  const valid = verifierDocument({ ...options, subjects: options.expectedSubjects });
  assert.equal(parseVerifierOutput(valid, options).runUri, predicate.runnerInvocationUri);

  for (const [field, value] of [
    ["runnerEnvironment", "self-hosted"],
    ["sourceRepositoryURI", "https://github.com/attacker/fork"],
    ["sourceRepositoryRef", "refs/heads/attacker"],
    ["sourceRepositoryDigest", "1".repeat(40)],
    ["buildSignerURI", "https://github.com/attacker/fork/.github/workflows/release.yml@refs/heads/main"],
    ["buildSignerDigest", "2".repeat(40)],
    ["runInvocationURI", "https://github.com/attacker/fork/actions/runs/42/attempts/1"],
  ]) {
    assert.throws(
      () => parseVerifierOutput(
        verifierDocument({ ...options, subjects: options.expectedSubjects, certificateOverrides: { [field]: value } }),
        options,
      ),
      /differs|not this repository/u,
      field,
    );
  }

  const wrongSubjects = structuredClone(options.expectedSubjects);
  wrongSubjects[4].sha256 = "9".repeat(64);
  assert.throws(
    () => parseVerifierOutput(verifierDocument({ ...options, subjects: wrongSubjects }), options),
    /does not bind/u,
  );
  const ambiguous = JSON.parse(valid);
  ambiguous[0].verificationResult.signature.certificate.unexpected = "true";
  assert.throws(() => parseVerifierOutput(JSON.stringify(ambiguous), options), /missing or unexpected fields/u);
  assert.throws(() => parseVerifierOutput(JSON.stringify([...JSON.parse(valid), ...JSON.parse(valid)]), options), /exactly one/u);
  const timestampFree = JSON.parse(valid);
  timestampFree[0].verificationResult.verifiedTimestamps = [];
  assert.throws(() => parseVerifierOutput(JSON.stringify(timestampFree), options), /trusted timestamp/u);
});

async function authorityEvidenceFixture() {
  const { policyRecord, request, artifacts } = await policyFixture();
  const requestBytes = Buffer.from(canonicalJson(request));
  const preBundle = Buffer.from('{}\n');
  const releaseBundle = Buffer.from('{"bundle":1}\n');
  const trustedRoot = await readFile(join(ROOT, "platform/deploy/pin/github-private-trusted-root.jsonl"));
  const runUri = "https://github.com/TheAndersMadsen/ai-pin-revival/actions/runs/42/attempts/1";
  const predicate = {
    schema: "revival.pin-hosted-five-apk",
    version: 1,
    requestSha256: sha256(requestBytes),
    preSignBundleSha256: sha256(preBundle),
    runnerInvocationUri: runUri,
    artifacts,
  };
  const predicateBytes = Buffer.from(canonicalJson(predicate));
  const preParsed = parseVerifierOutput(verifierDocument({
    policy: policyRecord.policy,
    request,
    predicateType: policyRecord.policy.preSignPredicateType,
    predicate: request,
    subjects: [{ name: "request.json", sha256: sha256(requestBytes) }],
  }), {
    policy: policyRecord.policy,
    request,
    predicateType: policyRecord.policy.preSignPredicateType,
    predicate: request,
    expectedSubjects: [{ name: "request.json", sha256: sha256(requestBytes) }],
  });
  const releaseParsed = parseVerifierOutput(verifierDocument({
    policy: policyRecord.policy,
    request,
    predicateType: policyRecord.policy.releasePredicateType,
    predicate,
    subjects: artifacts,
  }), {
    policy: policyRecord.policy,
    request,
    predicateType: policyRecord.policy.releasePredicateType,
    predicate,
    expectedSubjects: artifacts.map(({ name, sha256: digest }) => ({ name, sha256: digest })),
    expectedRunUri: runUri,
  });
  const preVerification = Buffer.from(canonicalJson(preParsed));
  const releaseVerification = Buffer.from(canonicalJson(releaseParsed));
  const evidence = {
    schema: "revival.pin-hosted-release-evidence", version: 1, provider: policyRecord.policy.provider,
    policySha256: policyRecord.sha256, requestSha256: sha256(requestBytes), predicateSha256: sha256(predicateBytes),
    trustedRootSha256: sha256(trustedRoot), preSignBundleSha256: sha256(preBundle),
    releaseBundleSha256: sha256(releaseBundle), preSignVerificationSha256: sha256(preVerification),
    releaseVerificationSha256: sha256(releaseVerification), runnerEnvironment: policyRecord.policy.runnerEnvironment,
    runnerLabel: policyRecord.policy.runnerLabel, runnerArchitecture: policyRecord.policy.runnerArchitecture,
    runnerInvocationUri: runUri, repository: policyRecord.policy.repository, sourceRef: request.sourceRef,
    sourceDigest: request.sourceDigest, sourceGenerationSha256: request.sourceGenerationSha256,
    sourceTarSha256: request.sourceTarSha256, toolchainSha256: request.toolchainSha256,
    builderImageId: request.builderImageId, artifacts,
    payloads: {
      policyBase64: policyRecord.bytes.toString("base64"), requestBase64: requestBytes.toString("base64"),
      predicateBase64: predicateBytes.toString("base64"), trustedRootBase64: trustedRoot.toString("base64"),
      preSignBundleBase64: preBundle.toString("base64"), releaseBundleBase64: releaseBundle.toString("base64"),
      preSignVerificationBase64: preVerification.toString("base64"),
      releaseVerificationBase64: releaseVerification.toString("base64"),
    },
  };
  return { bytes: Buffer.from(canonicalJson(evidence)), evidence, artifacts, requestBytes };
}

function authorityDescriptor(fixture) {
  const evidence = fixture.evidence;
  return {
    kind: "github-hosted-native-x64",
    name: "hosted-attestation.json",
    size: fixture.bytes.length,
    sha256: sha256(fixture.bytes),
    provider: evidence.provider,
    policySha256: evidence.policySha256,
    requestSha256: evidence.requestSha256,
    predicateSha256: evidence.predicateSha256,
    trustedRootSha256: evidence.trustedRootSha256,
    preSignBundleSha256: evidence.preSignBundleSha256,
    releaseBundleSha256: evidence.releaseBundleSha256,
    preSignVerificationSha256: evidence.preSignVerificationSha256,
    releaseVerificationSha256: evidence.releaseVerificationSha256,
    runnerEnvironment: evidence.runnerEnvironment,
    runnerLabel: evidence.runnerLabel,
    runnerArchitecture: evidence.runnerArchitecture,
    runnerInvocationUri: evidence.runnerInvocationUri,
    repository: evidence.repository,
    sourceRef: evidence.sourceRef,
    sourceDigest: evidence.sourceDigest,
    sourceGenerationSha256: evidence.sourceGenerationSha256,
    sourceTarSha256: evidence.sourceTarSha256,
    toolchainSha256: evidence.toolchainSha256,
    builderImageId: evidence.builderImageId,
  };
}

test("persisted authority is canonical and bound to request, bundles, and exact five receipts", async () => {
  const fixture = await authorityEvidenceFixture();
  const parsed = await parseAuthorityEvidenceBytes(fixture.bytes, {
    expectedRequestSha256: sha256(fixture.requestBytes),
    expectedArtifacts: fixture.artifacts,
  });
  assert.equal(parsed.predicate.artifacts.length, 5);

  const tampered = structuredClone(fixture.evidence);
  tampered.artifacts[0].sha256 = "9".repeat(64);
  await assert.rejects(
    parseAuthorityEvidenceBytes(Buffer.from(canonicalJson(tampered)), { expectedArtifacts: fixture.artifacts }),
    /differs|artifact/u,
  );
  const missing = structuredClone(fixture.evidence);
  delete missing.payloads.releaseBundleBase64;
  await assert.rejects(parseAuthorityEvidenceBytes(Buffer.from(canonicalJson(missing))), /missing or unexpected/u);
  const crossBuild = structuredClone(fixture.artifacts);
  crossBuild[2].size += 1;
  await assert.rejects(
    parseAuthorityEvidenceBytes(fixture.bytes, { expectedArtifacts: crossBuild }),
    /published receipts differ/u,
  );
});

test("persisted ship rejects version and same-artifact cross-build authority replay", async () => {
  const fixture = await authorityEvidenceFixture();
  const base = {
    schemaVersion: 2,
    version: "2026-08-22.1",
    artifacts: fixture.artifacts.map((artifact) => ({ ...artifact, versionCode: 202_608_221 })),
    authority: authorityDescriptor(fixture),
  };
  const prior = process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES;
  process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES = "1";
  try {
    await assert.rejects(
      parsePersistedHostedAuthorityBindingFixture({
        authorityBytes: fixture.bytes,
        expectedArtifacts: fixture.artifacts,
        manifest: { ...base, version: "2026-08-22.2" },
      }),
      /version identity/u,
    );
    for (const [field, value] of [
      ["requestSha256", "9".repeat(64)],
      ["sourceDigest", "8".repeat(40)],
      ["sourceGenerationSha256", "7".repeat(64)],
      ["sourceTarSha256", "6".repeat(64)],
      ["toolchainSha256", "5".repeat(64)],
      ["builderImageId", `sha256:${"4".repeat(64)}`],
      ["runnerInvocationUri", "https://github.com/TheAndersMadsen/ai-pin-revival/actions/runs/43/attempts/1"],
    ]) {
      await assert.rejects(
        parsePersistedHostedAuthorityBindingFixture({
          authorityBytes: fixture.bytes,
          expectedArtifacts: fixture.artifacts,
          manifest: { ...base, authority: { ...base.authority, [field]: value } },
        }),
        new RegExp(field, "u"),
        field,
      );
    }
  } finally {
    if (prior === undefined) delete process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES;
    else process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES = prior;
  }
});

test("production workflow, fixed verifier, and every signing/publication alias are structurally gated", async () => {
  const [workflow, build, ship, entrypoint, dockerfile, verifier, policySource, runtimePolicySource, rootBytes, cliPin] = await Promise.all([
    readFile(join(ROOT, ".github/workflows/pin-release.yml"), "utf8"),
    readFile(join(ROOT, "platform/deploy/pin/build.mjs"), "utf8"),
    readFile(join(ROOT, "platform/deploy/pin/ship.mjs"), "utf8"),
    readFile(join(ROOT, "platform/containers/pin-builder/entrypoint.sh"), "utf8"),
    readFile(join(ROOT, "platform/containers/pin-builder/Dockerfile"), "utf8"),
    readFile(join(ROOT, "platform/deploy/pin/hosted-attestation.mjs"), "utf8"),
    readFile(join(ROOT, "platform/deploy/pin/hosted-attestation-policy.json"), "utf8"),
    readFile(join(ROOT, "platform/deploy/pin/hosted-verifier-runtime-policy.json"), "utf8"),
    readFile(join(ROOT, "platform/deploy/pin/github-private-trusted-root.jsonl")),
    readFile(join(ROOT, "platform/cli/pin.js"), "utf8"),
  ]);
  const policy = JSON.parse(policySource);
  const runtimePolicy = JSON.parse(runtimePolicySource);
  assert.equal(sha256(rootBytes), policy.trustedRoot.sha256);
  assert.equal(runtimePolicy.imageId, "sha256:854cb78ac3ed2e215515e3ed78bf40a955bde16fc74114051a1850e509f602e6");
  assert.equal(runtimePolicy.files.find(({ name }) => name === "verifier").sha256, sha256(verifier));
  assert.equal(runtimePolicy.files.find(({ name }) => name === "policy").sha256, sha256(policySource));
  assert.equal(runtimePolicy.files.find(({ name }) => name === "trustedRoot").sha256, sha256(rootBytes));
  assert.match(policy.trustedRoot.source, /^https:\/\/tuf-repo\.github\.com\/targets\/[0-9a-f]{64}\.trusted_root\.json$/u);
  assert.equal(policy.githubCli.path, "/usr/bin/gh");
  assert.equal(policy.githubCli.linuxAmd64BinarySha256, "62885b97de6a0cd85e616cdd94bcda908bf5cf1018094385892b05cea3537163");
  for (const line of workflow.split("\n").filter((line) => /^\s*uses:/u.test(line))) {
    assert.match(line, /@[0-9a-f]{40}\s*$/u, line);
  }
  assert.equal(
    workflow.match(new RegExp(`actions/attest@${policy.attestAction.commit}`, "gu"))?.length,
    2,
  );
  assert.match(workflow, /runs-on: ubuntu-24\.04/u);
  assert.equal(workflow.match(/shell: \/usr\/bin\/bash --noprofile --norc -euo pipefail \{0\}/gu)?.length, 7);
  assert.equal(workflow.match(/\/usr\/local\/bin\/node platform\/deploy\/pin\/build\.mjs build/gu)?.length, 3);
  assert.doesNotMatch(workflow, /^\s+(?:node|install|mkdir)\s/gu);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /artifact-metadata: write/u);
  assert.match(workflow, /--hosted-phase prepare[\s\S]*actions\/attest@[0-9a-f]{40}[\s\S]*--hosted-phase sign[\s\S]*actions\/attest@[0-9a-f]{40}[\s\S]*--hosted-phase publish/u);
  const signBody = build.slice(
    build.indexOf("export async function signHostedPinRelease"),
    build.indexOf("export async function publishHostedPinRelease"),
  );
  const publishBody = build.slice(
    build.indexOf("export async function publishHostedPinRelease"),
    build.indexOf("export async function reverifyPersistedHostedRelease"),
  );
  const reverifyBody = build.slice(
    build.indexOf("export async function reverifyPersistedHostedRelease"),
    build.indexOf("export async function buildAndPublishPinRelease"),
  );
  const buildReleaseBody = entrypoint.slice(
    entrypoint.indexOf("build_release()"),
    entrypoint.indexOf("build_cli()"),
  );
  assert.ok(signBody.indexOf("createDockerPreVerificationInvocation") < signBody.indexOf("validatePinReleaseBuildInputs({ ...options, sourceRoot })"));
  assert.ok(buildReleaseBody.indexOf('verify_hosted_pre_sign "${version}"') < buildReleaseBody.indexOf("\n  validate_release_inputs\n"));
  assert.ok(publishBody.indexOf("createDockerReleaseVerificationInvocation") < publishBody.indexOf("HOSTED_PUBLICATION_CAPABILITIES.add"));
  assert.match(signBody, /withFixedVerifierAuthority/u);
  assert.match(publishBody, /withFixedVerifierAuthority/u);
  assert.match(reverifyBody, /withFixedVerifierAuthority/u);
  assert.doesNotMatch(reverifyBody, /assertBuilderImagePresent|imageId:\s*parsed\.request\.builderImageId/u);
  assert.match(build, /F_SEAL_WRITE/u);
  assert.match(build, /GitHub CLI binary is not the fixed ELF64 little-endian x86-64 executable/u);
  assert.match(build, /DOCKER_HOST: "unix:\/\/\/var\/run\/docker\.sock"/u);
  assert.match(build, /DOCKER_CONFIG: "\/nonexistent"/u);
  assert.match(build, /if \(invocation\.command !== FIXED_DOCKER\)/u);
  assert.match(ship, /const FIXED_BASH = "\/usr\/bin\/bash"/u);
  assert.match(ship, /const FIXED_PYTHON = "\/usr\/bin\/python3"/u);
  assert.match(ship, /const FIXED_SSH = "\/usr\/bin\/ssh"/u);
  assert.match(ship, /const FIXED_RSYNC = "\/usr\/bin\/rsync"/u);
  assert.doesNotMatch(ship, /shellExecutable = "bash"|sshExecutable = "ssh"|rsyncExecutable = "rsync"|runReadyProcess\("python3"/u);
  assert.match(verifier, /--deny-self-hosted-runners/u);
  assert.match(verifier, /--custom-trusted-root/u);
  assert.match(verifier, /--signer-workflow/u);
  assert.match(dockerfile, /ln \/usr\/local\/bin\/node \/usr\/bin\/node/u);
  assert.match(dockerfile, /COPY --from=android_sdk_native \/opt\/github-cli\/gh \/usr\/bin\/gh/u);
  assert.match(dockerfile, /bounded-process\.mjs \/usr\/local\/libexec\/ai-pin-hosted-attestation\/bounded-process\.mjs/u);
  assert.match(entrypoint, /require-hosted-native-attestation/u);
  assert.match(cliPin, /PIN_RELEASE_BUILD_TOOL/u);
  assert.doesNotMatch(build, /options\.commandRunner|process\.env\.(?:HOSTED|ATTESTATION).*COMMAND|===\s*["']true["']/u);
  const module = await import(`../pin/build.mjs?no-raw-publisher=${Date.now()}`);
  assert.equal(module.publishPinRelease, undefined);
});

test("verifier containers have no signing mounts and bind every fixed evidence path", async () => {
  const runtimePolicy = JSON.parse(await readFile(
    join(ROOT, "platform/deploy/pin/hosted-verifier-runtime-policy.json"),
    "utf8",
  ));
  const maliciousBuilderImage = `sha256:${"a".repeat(64)}`;
  const common = {
    requestPath: "/tmp/run/request.json",
    preSignBundlePath: "/tmp/run/pre.json",
    outputRoot: "/tmp/run/out",
    imageId: maliciousBuilderImage,
    verifierAuthority: {
      imageId: runtimePolicy.imageId,
      nodePath: runtimePolicy.nodePath,
      uid: 1000,
      gid: 1000,
      paths: {
        verifier: "/proc/7001/fd/10",
        policy: "/proc/7001/fd/11",
        trustedRoot: "/proc/7001/fd/12",
        boundedProcess: "/proc/7001/fd/13",
        githubCli: "/proc/7001/fd/14",
      },
    },
  };
  const preInvocation = createDockerPreVerificationInvocation(common);
  assert.equal(preInvocation.command, "/usr/bin/docker");
  const pre = preInvocation.args.join(" ");
  assert.match(pre, /verify-pre/u);
  assert.match(pre, new RegExp(runtimePolicy.imageId, "u"));
  assert.doesNotMatch(pre, new RegExp(maliciousBuilderImage, "u"));
  assert.match(pre, /\/proc\/7001\/fd\/13[^ ]*dst=\/usr\/local\/libexec\/ai-pin-hosted-attestation\/bounded-process\.mjs,readonly/u);
  assert.match(pre, /\/proc\/7001\/fd\/14[^ ]*dst=\/usr\/bin\/gh,readonly/u);
  assert.doesNotMatch(pre, /signing\.env|keystore|private-assets/u);
  const postInvocation = createDockerReleaseVerificationInvocation({
    ...common,
    releaseBundlePath: "/tmp/run/release.json",
    predicatePath: "/tmp/run/predicate.json",
    artifactRoot: "/tmp/run/artifacts",
  });
  assert.equal(postInvocation.command, "/usr/bin/docker");
  const post = postInvocation.args.join(" ");
  for (const value of ["verify-release", "release.sigstore.json", "release-predicate.json", "/release-artifacts"]) {
    assert.match(post, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(post, new RegExp(runtimePolicy.imageId, "u"));
  assert.doesNotMatch(post, new RegExp(maliciousBuilderImage, "u"));
  assert.doesNotMatch(post, /signing\.env|keystore|private-assets/u);
});

test("sealed raw-gh broker rejects traversal duplicates substitution trailing data and wrong ELF", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "revival-gh-broker-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const member = "fixture/bin/gh";
  const goodElf = syntheticElf();
  const prior = process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES;
  process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES = "1";
  t.after(() => {
    if (prior === undefined) delete process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES;
    else process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES = prior;
  });
  let sequence = 0;
  const verify = async (entries, { trailing = Buffer.alloc(0), binary = goodElf, mode = 0o755 } = {}) => {
    sequence += 1;
    const bytes = tarArchive(entries, trailing);
    const archivePath = join(directory, `archive-${sequence}.tar.gz`);
    await writeFile(archivePath, bytes, { mode: 0o600, flag: "wx" });
    return await validateHostedVerifierArchiveFixture({
      archivePath,
      githubCli: {
        archiveSha256: sha256(bytes),
        archiveMember: member,
        archiveMemberMode: mode,
        archiveMemberCount: entries.length,
        binarySha256: sha256(binary),
        binarySize: binary.length,
      },
    });
  };

  assert.deepEqual(await verify([{ name: member, bytes: goodElf }]), { sealed: true });
  await assert.rejects(
    verify([{ name: member, bytes: goodElf }, { name: "../escape", bytes: Buffer.from("x") }]),
    /unsafe or duplicate member/u,
  );
  await assert.rejects(
    verify([{ name: member, bytes: goodElf }, { name: member, bytes: goodElf }]),
    /unsafe or duplicate member/u,
  );
  await assert.rejects(
    verify([{ name: "fixture/bin/not-gh", bytes: goodElf }]),
    /exactly one fixed binary member/u,
  );
  await assert.rejects(
    verify([{ name: member, bytes: goodElf }], { trailing: Buffer.from("trailing") }),
    /trailing|concatenated/u,
  );
  const armElf = syntheticElf(183);
  await assert.rejects(
    verify([{ name: member, bytes: armElf }], { binary: armElf }),
    /ELF64 little-endian x86-64/u,
  );
  await assert.rejects(
    verify([{ name: member, bytes: goodElf, mode: 0o700 }]),
    /member identity changed/u,
  );
});

test("legacy local build, raw publisher fixture, and authoritative ship cannot bypass test mode", async () => {
  await assert.rejects(
    buildAndPublishPinRelease({ version: "2026-08-22.1", versionCode: 202_608_221 }),
    (error) => error instanceof PinReleaseBuildError && error.code === "hosted-attestation-required",
  );
  const prior = process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES;
  delete process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES;
  await assert.rejects(
    publishPinReleaseFixture({}),
    (error) => error instanceof PinReleaseBuildError && error.code === "test-fixture-disabled",
  );
  process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES = "1";
  let touched = false;
  await assert.rejects(
    shipPinRelease({
      releaseRoot: "/tmp/not-opened",
      remoteRoot: "/tmp/not-opened-remote",
      transport: { describe: () => "ssh:attacker", run: async () => { touched = true; } },
      confirm: true,
    }),
    /rejects explicit synthetic fixture mode/u,
  );
  assert.equal(touched, false);
  if (prior === undefined) delete process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES;
  else process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES = prior;
});

test("production ship rejects synthetic v2 authority before any remote mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "revival-synthetic-authority-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const stagingRoot = join(root, "staging");
  const releaseRoot = join(root, "release-store");
  const remoteRoot = join(root, "remote-store");
  const hostileBin = join(root, "hostile-bin");
  const hostileMarker = join(root, "hostile-tool-ran");
  await Promise.all([
    mkdir(stagingRoot, { mode: 0o700 }),
    mkdir(remoteRoot, { mode: 0o700 }),
    mkdir(hostileBin, { mode: 0o700 }),
  ]);
  for (const name of ["bash", "docker", "gh", "node", "python3", "tar"]) {
    const path = join(hostileBin, name);
    await writeFile(path, `#!/usr/bin/bash\nprintf '%s\\n' ${name} >> '${hostileMarker}'\nexit 99\n`, {
      mode: 0o700,
      flag: "wx",
    });
  }
  const version = "2026-08-22.2";
  const versionCode = 202_608_222;
  const rows = [];
  for (const role of PIN_RELEASE_ARTIFACT_ROLES) {
    const bytes = Buffer.from(`synthetic-apk:${role}\n`);
    await writeFile(join(stagingRoot, `${role}.apk`), bytes, { mode: 0o600 });
    rows.push([
      role,
      PIN_RELEASE_PACKAGE_BY_ROLE[role],
      version,
      String(versionCode),
      PIN_COMPATIBILITY_CERT_SHA256,
      sha256(bytes),
      String(bytes.length),
    ].join("\t"));
  }
  await writeFile(join(stagingRoot, "release-metadata.tsv"), `${rows.join("\n")}\n`, { mode: 0o600 });
  const receipts = await parseBuilderMetadata({ stagingRoot, version, versionCode });
  const prior = process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES;
  const ambientDocker = Object.fromEntries([
    "PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY",
  ].map((name) => [name, process.env[name]]));
  try {
    process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES = "1";
    await publishPinReleaseFixture({ releaseRoot, stagingRoot, version, receipts });
    delete process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES;
    process.env.PATH = `${hostileBin}:${ambientDocker.PATH ?? "/usr/bin:/bin"}`;
    process.env.HOME = "/tmp/attacker-controlled-home";
    process.env.DOCKER_HOST = "unix:///tmp/attacker-controlled-docker.sock";
    process.env.DOCKER_CONTEXT = "attacker-controlled-context";
    process.env.DOCKER_CONFIG = "/tmp/attacker-controlled-docker-config";
    process.env.DOCKER_TLS_VERIFY = "1";

    const base = createLocalTransport();
    let mutated = false;
    const transport = Object.freeze({
      describe: base.describe,
      run: base.run,
      async makeIncomingDirectory(...args) {
        mutated = true;
        return await base.makeIncomingDirectory(...args);
      },
      async removeIncomingDirectory(...args) {
        return await base.removeIncomingDirectory(...args);
      },
      async upload(...args) {
        mutated = true;
        return await base.upload(...args);
      },
    });
    await assert.rejects(
      shipPinRelease({ releaseRoot, remoteRoot, transport, confirm: true }),
      /hosted (?:authority|policy)|policy payload|attestation/u,
    );
    assert.equal(mutated, false);
    await assert.rejects(readFile(hostileMarker), (error) => error?.code === "ENOENT");
  } finally {
    if (prior === undefined) delete process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES;
    else process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES = prior;
    for (const [name, value] of Object.entries(ambientDocker)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("schema-1 candidate store is rejected before ship inventory grants authority", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "revival-candidate-v1-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseId = "a".repeat(64);
  const manifest = `${JSON.stringify({
    schemaVersion: 1,
    releaseId,
    version: "2026-08-22.1",
    artifacts: [],
  })}\n`;
  await mkdir(join(root, "releases"), { mode: 0o700 });
  await writeFile(join(root, "current.json"), manifest, { mode: 0o600 });
  await writeFile(join(root, "history.json"), `${JSON.stringify({
    schemaVersion: 1,
    releases: [{
      releaseId,
      version: "2026-08-22.1",
      versionCode: 1,
      manifestSha256: sha256(manifest),
    }],
  })}\n`, { mode: 0o600 });
  const { readLocalPinReleaseStore } = await import("../pin/ship.mjs");
  await assert.rejects(readLocalPinReleaseStore({ root }), /schemaVersion|five Pin artifact roles|candidate/u);
});
