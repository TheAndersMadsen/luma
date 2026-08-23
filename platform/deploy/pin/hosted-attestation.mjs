#!/usr/bin/env node

/**
 * Cryptographic policy gate for the authoritative hosted Pin release lane.
 *
 * GitHub documents `gh attestation verify` as the verifier for the Sigstore
 * bundles emitted by `actions/attest`, including offline verification with a
 * caller-supplied trusted root.  The certificate fields are provider-signed;
 * custom predicate fields are workflow-controlled.  We therefore accept a
 * predicate only when the certificate also pins this repository, ref, source
 * digest, exact checked-in workflow, workflow digest, GitHub-hosted runner and
 * run invocation.  See:
 * https://cli.github.com/manual/gh_attestation_verify
 * https://docs.github.com/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OWN_CHILD_PROCESS_GROUP,
  terminateTrackedProcess,
  trackChildProcess,
  withTrackedDeadline,
} from "./bounded-process.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const MODULE_ROOT = dirname(SELF_PATH);
export const POLICY_PATH = resolve(
  `${MODULE_ROOT}/hosted-attestation-policy.json`,
);
export const TRUSTED_ROOT_PATH = resolve(
  `${MODULE_ROOT}/github-private-trusted-root.jsonl`,
);
export const MAX_ATTESTATION_BYTES = 16 * 1024 * 1024;
export const MAX_VERIFIER_OUTPUT_BYTES = 32 * 1024 * 1024;
export const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const VERIFIER_TIMEOUT_MILLISECONDS = 5 * 60_000;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const GIT_SHA_RE = /^[0-9a-f]{40}$/u;
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/u;
const RUN_URI_RE = /^https:\/\/github\.com\/TheAndersMadsen\/ai-pin-revival\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/u;
const REQUEST_FIELDS = Object.freeze([
  "schema",
  "version",
  "policySha256",
  "repository",
  "sourceRef",
  "sourceDigest",
  "sourceGenerationSha256",
  "sourceTarSha256",
  "builderImageId",
  "toolchainSha256",
  "versionName",
  "versionCode",
  "roles",
]);
const POST_FIELDS = Object.freeze([
  "schema",
  "version",
  "requestSha256",
  "preSignBundleSha256",
  "runnerInvocationUri",
  "artifacts",
]);
const ARTIFACT_FIELDS = Object.freeze(["role", "name", "sha256", "size"]);
const EVIDENCE_FIELDS = Object.freeze([
  "schema",
  "version",
  "provider",
  "policySha256",
  "requestSha256",
  "predicateSha256",
  "trustedRootSha256",
  "preSignBundleSha256",
  "releaseBundleSha256",
  "preSignVerificationSha256",
  "releaseVerificationSha256",
  "runnerEnvironment",
  "runnerLabel",
  "runnerArchitecture",
  "runnerInvocationUri",
  "repository",
  "sourceRef",
  "sourceDigest",
  "sourceGenerationSha256",
  "sourceTarSha256",
  "toolchainSha256",
  "builderImageId",
  "artifacts",
  "payloads",
]);
const EVIDENCE_PAYLOAD_FIELDS = Object.freeze([
  "policyBase64",
  "requestBase64",
  "predicateBase64",
  "trustedRootBase64",
  "preSignBundleBase64",
  "releaseBundleBase64",
  "preSignVerificationBase64",
  "releaseVerificationBase64",
]);
export class HostedAttestationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HostedAttestationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new HostedAttestationError(code, message);
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-shape", `${label} must be an object`);
  }
  return value;
}

function exactFields(value, fields, label) {
  record(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail("invalid-shape", `${label} contains missing or unexpected fields`);
  }
}

function exactString(value, expected, label) {
  if (value !== expected) fail("policy-mismatch", `${label} differs from the hosted release policy`);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

export function canonicalJson(value) {
  return `${canonical(value)}\n`;
}

function strictJson(source, label) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail("invalid-json", `${label} is not JSON`);
  }
  if (source !== canonicalJson(parsed)) {
    fail("noncanonical", `${label} must be canonical sorted compact JSON plus one LF`);
  }
  return parsed;
}

async function protectedFile(pathValue, label, maximum = MAX_ATTESTATION_BYTES, privateMode = true) {
  const selected = resolve(pathValue);
  let metadata;
  try {
    metadata = await lstat(selected, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") fail("missing-input", `${label} is missing`);
    throw error;
  }
  if (
    metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0n ||
    metadata.size > BigInt(maximum)
  ) {
    fail("invalid-input", `${label} must be a bounded nonempty regular file`);
  }
  if (privateMode && (metadata.mode & 0o077n) !== 0n) {
    fail("invalid-input", `${label} must not be group/world accessible`);
  }
  const canonicalPath = await realpath(selected);
  if (canonicalPath !== selected) fail("invalid-input", `${label} path is not canonical`);
  const bytes = await readFile(selected);
  const after = await lstat(selected, { bigint: true });
  if (
    after.dev !== metadata.dev || after.ino !== metadata.ino || after.size !== metadata.size ||
    after.mtimeNs !== metadata.mtimeNs || after.ctimeNs !== metadata.ctimeNs
  ) {
    fail("input-changed", `${label} changed while read`);
  }
  return Object.freeze({ path: selected, bytes, sha256: sha256(bytes) });
}

export async function loadPolicy(pathValue = POLICY_PATH) {
  if (resolve(pathValue) !== POLICY_PATH) fail("policy-mismatch", "hosted release policy path is fixed");
  const loaded = await protectedFile(pathValue, "hosted release policy", 64 * 1024, false);
  let policy;
  try {
    policy = JSON.parse(loaded.bytes.toString("utf8"));
  } catch {
    fail("invalid-json", "hosted release policy is not JSON");
  }
  exactFields(policy, [
    "schema", "version", "provider", "repository", "repositoryUri", "repositoryOwnerUri", "sourceRef",
    "sourceVisibility", "signerWorkflow", "signerWorkflowUri", "signerDigestPolicy",
    "workflowName", "workflowTrigger",
    "runnerEnvironment", "runnerLabel", "runnerArchitecture", "issuer", "githubCli", "trustedRoot",
    "attestAction", "preSignPredicateType", "releasePredicateType", "roles",
  ], "hosted release policy");
  exactString(policy.schema, "revival.pin-hosted-release-policy", "policy schema");
  if (policy.version !== 1) fail("policy-mismatch", "hosted release policy version changed");
  exactString(policy.provider, "github-actions-sigstore", "policy provider");
  exactString(policy.repository, "TheAndersMadsen/ai-pin-revival", "policy repository");
  exactString(policy.repositoryUri, "https://github.com/TheAndersMadsen/ai-pin-revival", "policy repository URI");
  exactString(policy.repositoryOwnerUri, "https://github.com/TheAndersMadsen", "policy repository owner URI");
  exactString(policy.sourceRef, "refs/heads/main", "policy source ref");
  exactString(policy.sourceVisibility, "private", "policy source visibility");
  exactString(policy.signerWorkflow, ".github/workflows/pin-release.yml", "policy signer workflow");
  exactString(
    policy.signerWorkflowUri,
    "https://github.com/TheAndersMadsen/ai-pin-revival/.github/workflows/pin-release.yml@refs/heads/main",
    "policy signer workflow URI",
  );
  exactString(policy.signerDigestPolicy, "equals-source-digest", "policy signer digest rule");
  exactString(policy.workflowName, "Attested Pin release", "policy workflow name");
  exactString(policy.workflowTrigger, "workflow_dispatch", "policy workflow trigger");
  exactString(policy.runnerEnvironment, "github-hosted", "policy runner environment");
  exactString(policy.runnerLabel, "ubuntu-24.04", "policy runner label");
  exactString(policy.runnerArchitecture, "x64", "policy runner architecture");
  exactString(policy.issuer, "https://token.actions.githubusercontent.com", "policy issuer");
  exactFields(
    policy.githubCli,
    ["path", "version", "linuxAmd64ArchiveSha256", "linuxAmd64BinarySha256", "linuxAmd64BinarySize"],
    "policy githubCli",
  );
  exactString(policy.githubCli.path, "/usr/bin/gh", "GitHub CLI path");
  exactString(policy.githubCli.version, "2.98.0", "GitHub CLI version");
  exactString(
    policy.githubCli.linuxAmd64ArchiveSha256,
    "3b8ac6b30336802fc1a858d7c084e11cdf24ac1a761ca90b68022d7d729208de",
    "GitHub CLI archive digest",
  );
  exactString(
    policy.githubCli.linuxAmd64BinarySha256,
    "62885b97de6a0cd85e616cdd94bcda908bf5cf1018094385892b05cea3537163",
    "GitHub CLI binary digest",
  );
  if (policy.githubCli.linuxAmd64BinarySize !== 41377954) fail("policy-mismatch", "GitHub CLI binary size changed");
  exactFields(
    policy.trustedRoot,
    ["path", "sha256", "tufTargetSha256", "tufSnapshotVersion", "tufTargetsVersion", "source"],
    "policy trustedRoot",
  );
  exactString(policy.trustedRoot.path, "/usr/local/libexec/ai-pin-hosted-attestation/github-private-trusted-root.jsonl", "trusted root path");
  exactString(policy.trustedRoot.sha256, "26b3382d5700afbcd84f980d1d5b6c52bff743dc2a8ee86b8b44c8e1245ce485", "trusted root compact digest");
  exactString(policy.trustedRoot.tufTargetSha256, "484cdfe1a7c65479c5ba2a22193d1be90f0020db1997de696ab207434c62fbb7", "trusted root TUF target digest");
  if (policy.trustedRoot.tufSnapshotVersion !== 77 || policy.trustedRoot.tufTargetsVersion !== 10) {
    fail("policy-mismatch", "trusted root TUF metadata version changed");
  }
  exactString(
    policy.trustedRoot.source,
    "https://tuf-repo.github.com/targets/484cdfe1a7c65479c5ba2a22193d1be90f0020db1997de696ab207434c62fbb7.trusted_root.json",
    "trusted root official source",
  );
  exactFields(policy.attestAction, ["repository", "commit"], "policy attestAction");
  exactString(policy.attestAction.repository, "actions/attest", "attest action repository");
  exactString(
    policy.attestAction.commit,
    "1e69f48acb82d1966a394da916b4c1698aa569d6",
    "attest action commit",
  );
  exactString(
    policy.preSignPredicateType,
    "https://github.com/TheAndersMadsen/ai-pin-revival/attestations/pin-release-input/v1",
    "pre-sign predicate type",
  );
  exactString(
    policy.releasePredicateType,
    "https://github.com/TheAndersMadsen/ai-pin-revival/attestations/pin-release-five-apk/v1",
    "release predicate type",
  );
  if (!Array.isArray(policy.roles) || policy.roles.join(",") !== "installer,bootstrap,hook,server,hook-injector") {
    fail("policy-mismatch", "hosted release policy does not name the exact five roles");
  }
  return Object.freeze({ policy: Object.freeze(policy), bytes: loaded.bytes, sha256: loaded.sha256 });
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail("invalid-value", `${label} must be a positive integer`);
  return value;
}

export function parseRequest(value, policyRecord) {
  const { policy, sha256: policySha256 } = policyRecord;
  exactFields(value, REQUEST_FIELDS, "hosted release request");
  exactString(value.schema, "revival.pin-hosted-release-request", "request schema");
  if (value.version !== 1) fail("invalid-value", "hosted release request version must be 1");
  exactString(value.policySha256, policySha256, "request policy digest");
  exactString(value.repository, policy.repository, "request repository");
  exactString(value.sourceRef, policy.sourceRef, "request source ref");
  if (!GIT_SHA_RE.test(value.sourceDigest)) fail("invalid-value", "request source digest is invalid");
  for (const field of ["sourceGenerationSha256", "sourceTarSha256", "toolchainSha256"]) {
    if (!SHA256_RE.test(value[field])) fail("invalid-value", `request ${field} is invalid`);
  }
  if (!IMAGE_ID_RE.test(value.builderImageId)) fail("invalid-value", "request builder image ID is invalid");
  if (typeof value.versionName !== "string" || !/^\d{4}-\d{2}-\d{2}\.\d+$/u.test(value.versionName)) {
    fail("invalid-value", "request versionName is invalid");
  }
  positiveInteger(value.versionCode, "request versionCode");
  if (!Array.isArray(value.roles) || value.roles.join(",") !== policy.roles.join(",")) {
    fail("invalid-value", "request does not bind the exact five roles");
  }
  return Object.freeze(value);
}

export async function readRequest(pathValue, policyRecord) {
  const loaded = await protectedFile(pathValue, "hosted release request", 64 * 1024);
  const value = parseRequest(strictJson(loaded.bytes.toString("utf8"), "hosted release request"), policyRecord);
  return Object.freeze({ ...loaded, value });
}

function parseArtifact(value, role) {
  exactFields(value, ARTIFACT_FIELDS, `${role} attested artifact`);
  exactString(value.role, role, `${role} artifact role`);
  exactString(value.name, `${role}.apk`, `${role} artifact name`);
  if (!SHA256_RE.test(value.sha256)) fail("invalid-value", `${role} artifact digest is invalid`);
  positiveInteger(value.size, `${role} artifact size`);
  return Object.freeze(value);
}

export function parsePostPredicate(value, { policy, requestSha256, preSignBundleSha256, runnerInvocationUri }) {
  exactFields(value, POST_FIELDS, "hosted release five-APK predicate");
  exactString(value.schema, "revival.pin-hosted-five-apk", "release predicate schema");
  if (value.version !== 1) fail("invalid-value", "release predicate version must be 1");
  exactString(value.requestSha256, requestSha256, "release predicate request digest");
  exactString(value.preSignBundleSha256, preSignBundleSha256, "release predicate pre-sign bundle digest");
  exactString(value.runnerInvocationUri, runnerInvocationUri, "release predicate run identity");
  if (!Array.isArray(value.artifacts) || value.artifacts.length !== policy.roles.length) {
    fail("invalid-value", "release predicate does not contain exactly five artifacts");
  }
  const artifacts = policy.roles.map((role, index) => parseArtifact(value.artifacts[index], role));
  return Object.freeze({ ...value, artifacts: Object.freeze(artifacts) });
}

function certificateField(certificate, name) {
  const value = certificate[name];
  if (typeof value !== "string" || value.length === 0) {
    fail("verifier-output", `verified certificate has no ${name}`);
  }
  return value;
}

const CERTIFICATE_FIELDS = Object.freeze([
  "certificateIssuer",
  "subjectAlternativeName",
  "issuer",
  "githubWorkflowTrigger",
  "githubWorkflowSHA",
  "githubWorkflowName",
  "githubWorkflowRepository",
  "githubWorkflowRef",
  "buildSignerURI",
  "buildSignerDigest",
  "runnerEnvironment",
  "sourceRepositoryURI",
  "sourceRepositoryDigest",
  "sourceRepositoryRef",
  "sourceRepositoryIdentifier",
  "sourceRepositoryOwnerURI",
  "sourceRepositoryOwnerIdentifier",
  "buildConfigURI",
  "buildConfigDigest",
  "buildTrigger",
  "runInvocationURI",
  "sourceRepositoryVisibilityAtSigning",
]);

function parseSubjects(statement, expectedSubjects) {
  if (!Array.isArray(statement.subject) || statement.subject.length !== expectedSubjects.length) {
    fail("subject-mismatch", "verified statement has the wrong subject count");
  }
  const actual = new Map();
  for (const subject of statement.subject) {
    record(subject, "verified subject");
    const keys = Object.keys(subject).sort().join(",");
    if (keys !== "digest,name" || typeof subject.name !== "string") {
      fail("subject-mismatch", "verified statement subject is malformed");
    }
    record(subject.digest, "verified subject digest");
    if (Object.keys(subject.digest).join(",") !== "sha256" || !SHA256_RE.test(subject.digest.sha256)) {
      fail("subject-mismatch", "verified statement subject digest is malformed");
    }
    if (actual.has(subject.name)) fail("subject-mismatch", "verified statement repeats a subject");
    actual.set(subject.name, subject.digest.sha256);
  }
  for (const expected of expectedSubjects) {
    if (actual.get(expected.name) !== expected.sha256) {
      fail("subject-mismatch", `verified statement does not bind ${expected.name}`);
    }
  }
}

export function parseVerifierOutput(source, {
  policy,
  request,
  predicateType,
  predicate,
  expectedSubjects,
  expectedRunUri = null,
}) {
  let values;
  try {
    values = JSON.parse(source);
  } catch {
    fail("verifier-output", "GitHub attestation verifier did not emit JSON");
  }
  if (!Array.isArray(values) || values.length !== 1) {
    fail("verifier-output", "GitHub attestation verifier must return exactly one verified statement");
  }
  exactFields(values[0], ["attestation", "verificationResult"], "GitHub verifier result entry");
  record(values[0].attestation, "verified Sigstore bundle");
  const result = record(values[0]?.verificationResult, "verification result");
  exactFields(
    result,
    ["mediaType", "statement", "signature", "verifiedTimestamps", "verifiedIdentity"],
    "verification result",
  );
  exactString(
    result.mediaType,
    "application/vnd.dev.sigstore.verificationresult+json;version=0.1",
    "verification result media type",
  );
  const signature = record(result.signature, "verification signature");
  exactFields(signature, ["certificate"], "verification signature");
  const certificate = record(signature.certificate, "verification certificate");
  const statement = record(result.statement, "verified statement");
  exactFields(statement, ["_type", "subject", "predicateType", "predicate"], "verified statement");
  record(result.verifiedIdentity, "verified certificate identity");
  if (!Array.isArray(result.verifiedTimestamps) || result.verifiedTimestamps.length === 0) {
    fail("verifier-output", "verified attestation has no trusted timestamp");
  }
  for (const timestamp of result.verifiedTimestamps) {
    exactFields(timestamp, ["type", "uri", "timestamp"], "verified timestamp");
    for (const field of ["type", "uri", "timestamp"]) {
      if (typeof timestamp[field] !== "string" || timestamp[field].length === 0) {
        fail("verifier-output", `verified timestamp has no ${field}`);
      }
    }
    if (Number.isNaN(Date.parse(timestamp.timestamp))) {
      fail("verifier-output", "verified timestamp is not an RFC3339-like instant");
    }
  }
  exactFields(certificate, CERTIFICATE_FIELDS, "verification certificate");
  certificateField(certificate, "certificateIssuer");
  exactString(certificateField(certificate, "subjectAlternativeName"), policy.signerWorkflowUri, "certificate subject alternative name");
  exactString(certificateField(certificate, "issuer"), policy.issuer, "certificate issuer");
  exactString(certificateField(certificate, "githubWorkflowTrigger"), policy.workflowTrigger, "certificate workflow trigger");
  exactString(certificateField(certificate, "githubWorkflowSHA"), request.sourceDigest, "certificate workflow SHA");
  exactString(certificateField(certificate, "githubWorkflowName"), policy.workflowName, "certificate workflow name");
  exactString(certificateField(certificate, "githubWorkflowRepository"), policy.repository, "certificate workflow repository");
  exactString(certificateField(certificate, "githubWorkflowRef"), policy.sourceRef, "certificate workflow ref");
  exactString(certificateField(certificate, "runnerEnvironment"), policy.runnerEnvironment, "certificate runner environment");
  exactString(certificateField(certificate, "sourceRepositoryURI"), policy.repositoryUri, "certificate repository");
  exactString(certificateField(certificate, "sourceRepositoryRef"), policy.sourceRef, "certificate source ref");
  exactString(certificateField(certificate, "sourceRepositoryDigest"), request.sourceDigest, "certificate source digest");
  exactString(certificateField(certificate, "sourceRepositoryVisibilityAtSigning"), policy.sourceVisibility, "certificate source visibility");
  exactString(certificateField(certificate, "buildSignerURI"), policy.signerWorkflowUri, "certificate signer workflow");
  exactString(certificateField(certificate, "buildSignerDigest"), request.sourceDigest, "certificate signer workflow digest");
  exactString(certificateField(certificate, "sourceRepositoryOwnerURI"), policy.repositoryOwnerUri, "certificate source owner");
  if (
    !/^[1-9][0-9]*$/u.test(certificateField(certificate, "sourceRepositoryIdentifier")) ||
    !/^[1-9][0-9]*$/u.test(certificateField(certificate, "sourceRepositoryOwnerIdentifier"))
  ) fail("policy-mismatch", "certificate repository identifiers are invalid");
  exactString(certificateField(certificate, "buildConfigURI"), policy.signerWorkflowUri, "certificate build config");
  exactString(certificateField(certificate, "buildConfigDigest"), request.sourceDigest, "certificate build config digest");
  exactString(certificateField(certificate, "buildTrigger"), policy.workflowTrigger, "certificate build trigger");
  const runUri = certificateField(certificate, "runInvocationURI");
  if (!RUN_URI_RE.test(runUri)) fail("policy-mismatch", "certificate run invocation is not this repository");
  if (expectedRunUri !== null) exactString(runUri, expectedRunUri, "certificate run invocation");
  exactString(statement._type, "https://in-toto.io/Statement/v1", "statement type");
  exactString(statement.predicateType, predicateType, "statement predicate type");
  if (canonical(statement.predicate) !== canonical(predicate)) {
    fail("predicate-mismatch", "verified statement predicate differs from the exact build binding");
  }
  parseSubjects(statement, expectedSubjects);
  return Object.freeze({
    runUri,
    certificate: Object.freeze({
      issuer: certificate.issuer,
      certificateIssuer: certificate.certificateIssuer,
      subjectAlternativeName: certificate.subjectAlternativeName,
      githubWorkflowTrigger: certificate.githubWorkflowTrigger,
      githubWorkflowSHA: certificate.githubWorkflowSHA,
      githubWorkflowName: certificate.githubWorkflowName,
      githubWorkflowRepository: certificate.githubWorkflowRepository,
      githubWorkflowRef: certificate.githubWorkflowRef,
      runnerEnvironment: certificate.runnerEnvironment,
      sourceRepositoryURI: certificate.sourceRepositoryURI,
      sourceRepositoryRef: certificate.sourceRepositoryRef,
      sourceRepositoryDigest: certificate.sourceRepositoryDigest,
      sourceRepositoryVisibilityAtSigning: certificate.sourceRepositoryVisibilityAtSigning,
      buildSignerURI: certificate.buildSignerURI,
      buildSignerDigest: certificate.buildSignerDigest,
      sourceRepositoryIdentifier: certificate.sourceRepositoryIdentifier,
      sourceRepositoryOwnerURI: certificate.sourceRepositoryOwnerURI,
      sourceRepositoryOwnerIdentifier: certificate.sourceRepositoryOwnerIdentifier,
      buildConfigURI: certificate.buildConfigURI,
      buildConfigDigest: certificate.buildConfigDigest,
      buildTrigger: certificate.buildTrigger,
      runInvocationURI: certificate.runInvocationURI,
    }),
    statement: Object.freeze({
      _type: statement._type,
      predicateType: statement.predicateType,
      subject: Object.freeze(statement.subject),
      predicate: Object.freeze(statement.predicate),
    }),
  });
}

async function runFixedGh(args) {
  const policyRecord = await loadPolicy();
  const gh = policyRecord.policy.githubCli;
  // Re-hash the complete executable before every provider-verification call.
  // Production mounts this exact raw ELF from a fully write-sealed memfd; the
  // repeated digest also keeps legacy diagnostic containers fail-closed.
  const loaded = await protectedFile(gh.path, "policy-pinned GitHub CLI verifier", 48 * 1024 * 1024, false);
  const metadata = await lstat(gh.path);
  if (
    (metadata.mode & 0o111) === 0 || loaded.bytes.length !== gh.linuxAmd64BinarySize ||
    loaded.sha256 !== gh.linuxAmd64BinarySha256
  ) fail("verifier-unavailable", "the policy-pinned /usr/bin/gh verifier identity differs");
  const version = await runProcess(gh.path, ["--version"], 4096);
  if (!version.stdout.startsWith(`gh version ${gh.version} `)) {
    fail("verifier-version", `the policy requires GitHub CLI ${gh.version}`);
  }
  return await runProcess(gh.path, args, MAX_VERIFIER_OUTPUT_BYTES);
}

async function runProcess(command, args, maximum) {
  const child = spawn(command, args, {
    cwd: "/",
    detached: OWN_CHILD_PROCESS_GROUP,
    env: {
      HOME: "/tmp",
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      GH_CONFIG_DIR: "/tmp/revival-empty-gh-config",
      GH_NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tracked = trackChildProcess(child, { ownsProcessGroup: OWN_CHILD_PROCESS_GROUP });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let outputExceeded = false;
  let forcedTermination = null;
  const terminateForFailure = () => {
    if (forcedTermination === null) {
      forcedTermination = terminateTrackedProcess(tracked, { graceMilliseconds: 1 });
      void forcedTermination.catch(() => undefined);
    }
  };
  const append = (current, chunk) => {
    if (outputExceeded) return current;
    if (current.length + chunk.length > maximum) {
      outputExceeded = true;
      terminateForFailure();
      return current;
    }
    return Buffer.concat([current, chunk]);
  };
  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
  const outcome = await withTrackedDeadline(tracked, tracked.close, {
    milliseconds: VERIFIER_TIMEOUT_MILLISECONDS,
    timeoutError: () => new HostedAttestationError(
      "verifier-timeout",
      "GitHub attestation verification exceeded its fixed wall-clock deadline",
    ),
  });
  if (forcedTermination !== null) await forcedTermination;
  if (outputExceeded) {
    fail("verifier-output", "GitHub verifier output exceeded its bound");
  }
  if (outcome.error !== null) {
    fail("verifier-unavailable", `policy-pinned verifier could not start: ${outcome.error.message}`);
  }
  if (outcome.code !== 0 || outcome.signal !== null) {
    fail(
      "verification-failed",
      `GitHub attestation verification failed${stderr.length ? `: ${stderr.toString("utf8").trim()}` : ""}`,
    );
  }
  return Object.freeze({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
}

function verificationArguments({ policy, artifact, bundle, trustedRoot, predicateType, request }) {
  return [
    "attestation", "verify", artifact,
    "--bundle", bundle,
    "--custom-trusted-root", trustedRoot,
    "--repo", policy.repository,
    "--signer-repo", policy.repository,
    "--signer-workflow", policy.signerWorkflow,
    "--source-ref", policy.sourceRef,
    "--source-digest", request.sourceDigest,
    "--signer-digest", request.sourceDigest,
    "--predicate-type", predicateType,
    "--deny-self-hosted-runners",
    "--no-public-good",
    "--format", "json",
  ];
}

async function loadPinnedTrustedRoot(policyRecord) {
  const loaded = await protectedFile(TRUSTED_ROOT_PATH, "pinned GitHub private Sigstore trusted root", 128 * 1024, false);
  if (loaded.sha256 !== policyRecord.policy.trustedRoot.sha256) {
    fail("trusted-root-mismatch", "pinned GitHub private Sigstore trusted root digest changed");
  }
  return loaded;
}

export async function verifyPreSign({ requestPath, bundlePath }) {
  const policyRecord = await loadPolicy();
  const [request, bundle, trustedRoot] = await Promise.all([
    readRequest(requestPath, policyRecord),
    protectedFile(bundlePath, "pre-sign Sigstore bundle"),
    loadPinnedTrustedRoot(policyRecord),
  ]);
  const result = await runFixedGh(verificationArguments({
    policy: policyRecord.policy,
    artifact: request.path,
    bundle: bundle.path,
    trustedRoot: trustedRoot.path,
    predicateType: policyRecord.policy.preSignPredicateType,
    request: request.value,
  }));
  const parsed = parseVerifierOutput(result.stdout, {
    policy: policyRecord.policy,
    request: request.value,
    predicateType: policyRecord.policy.preSignPredicateType,
    predicate: request.value,
    expectedSubjects: [{ name: basename(request.path), sha256: request.sha256 }],
  });
  return Object.freeze({ policyRecord, request, bundle, trustedRoot, result, parsed });
}

async function readArtifact(root, item) {
  const loaded = await protectedFile(resolve(root, item.name), `${item.role} signed APK`, 512 * 1024 * 1024);
  if (loaded.sha256 !== item.sha256 || loaded.bytes.length !== item.size) {
    fail("artifact-mismatch", `${item.role} signed APK differs from the attested predicate`);
  }
  return loaded;
}

export async function verifyRelease({
  requestPath,
  preSignBundlePath,
  releaseBundlePath,
  predicatePath,
  artifactRoot,
}) {
  const pre = await verifyPreSign({ requestPath, bundlePath: preSignBundlePath });
  const [releaseBundle, predicateFile] = await Promise.all([
    protectedFile(releaseBundlePath, "five-APK Sigstore bundle"),
    protectedFile(predicatePath, "five-APK attestation predicate", 64 * 1024),
  ]);
  const predicate = parsePostPredicate(
    strictJson(predicateFile.bytes.toString("utf8"), "five-APK attestation predicate"),
    {
      policy: pre.policyRecord.policy,
      requestSha256: pre.request.sha256,
      preSignBundleSha256: pre.bundle.sha256,
      runnerInvocationUri: pre.parsed.runUri,
    },
  );
  const artifacts = await Promise.all(predicate.artifacts.map((item) => readArtifact(artifactRoot, item)));
  let canonicalVerification = null;
  const rawResults = [];
  for (let index = 0; index < predicate.artifacts.length; index += 1) {
    const item = predicate.artifacts[index];
    const artifact = artifacts[index];
    const result = await runFixedGh(verificationArguments({
      policy: pre.policyRecord.policy,
      artifact: artifact.path,
      bundle: releaseBundle.path,
      trustedRoot: pre.trustedRoot.path,
      predicateType: pre.policyRecord.policy.releasePredicateType,
      request: pre.request.value,
    }));
    const parsed = parseVerifierOutput(result.stdout, {
      policy: pre.policyRecord.policy,
      request: pre.request.value,
      predicateType: pre.policyRecord.policy.releasePredicateType,
      predicate,
      expectedSubjects: predicate.artifacts.map(({ name, sha256: digest }) => ({ name, sha256: digest })),
      expectedRunUri: pre.parsed.runUri,
    });
    const compact = canonicalJson(parsed);
    if (canonicalVerification !== null && compact !== canonicalVerification) {
      fail("verifier-output", "per-artifact verification results disagree");
    }
    canonicalVerification = compact;
    rawResults.push(result.stdout);
    // Point-of-use revalidation after the verifier has consumed the file.
    const after = await protectedFile(artifact.path, `${item.role} signed APK`, 512 * 1024 * 1024);
    if (after.sha256 !== item.sha256 || after.bytes.length !== item.size) {
      fail("artifact-changed", `${item.role} signed APK changed during attestation verification`);
    }
  }
  return Object.freeze({ pre, releaseBundle, predicateFile, predicate, artifacts, canonicalVerification, rawResults });
}

export function createAuthorityEvidence(verified) {
  const { pre, releaseBundle, predicateFile, predicate, canonicalVerification } = verified;
  const preVerification = canonicalJson(pre.parsed);
  const evidence = {
    schema: "revival.pin-hosted-release-evidence",
    version: 1,
    provider: pre.policyRecord.policy.provider,
    policySha256: pre.policyRecord.sha256,
    requestSha256: pre.request.sha256,
    predicateSha256: predicateFile.sha256,
    trustedRootSha256: pre.trustedRoot.sha256,
    preSignBundleSha256: pre.bundle.sha256,
    releaseBundleSha256: releaseBundle.sha256,
    preSignVerificationSha256: sha256(preVerification),
    releaseVerificationSha256: sha256(canonicalVerification),
    runnerEnvironment: pre.parsed.certificate.runnerEnvironment,
    runnerLabel: pre.policyRecord.policy.runnerLabel,
    runnerArchitecture: pre.policyRecord.policy.runnerArchitecture,
    runnerInvocationUri: pre.parsed.runUri,
    repository: pre.policyRecord.policy.repository,
    sourceRef: pre.request.value.sourceRef,
    sourceDigest: pre.request.value.sourceDigest,
    sourceGenerationSha256: pre.request.value.sourceGenerationSha256,
    sourceTarSha256: pre.request.value.sourceTarSha256,
    toolchainSha256: pre.request.value.toolchainSha256,
    builderImageId: pre.request.value.builderImageId,
    artifacts: predicate.artifacts,
    payloads: {
      policyBase64: pre.policyRecord.bytes.toString("base64"),
      requestBase64: pre.request.bytes.toString("base64"),
      predicateBase64: predicateFile.bytes.toString("base64"),
      trustedRootBase64: pre.trustedRoot.bytes.toString("base64"),
      preSignBundleBase64: pre.bundle.bytes.toString("base64"),
      releaseBundleBase64: releaseBundle.bytes.toString("base64"),
      preSignVerificationBase64: Buffer.from(preVerification).toString("base64"),
      releaseVerificationBase64: Buffer.from(canonicalVerification).toString("base64"),
    },
  };
  return Buffer.from(canonicalJson(evidence));
}

function decodeCanonicalBase64(value, label, maximum = MAX_ATTESTATION_BYTES) {
  if (
    typeof value !== "string" || value.length === 0 || value.length > Math.ceil(maximum / 3) * 4 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    fail("evidence-invalid", `${label} is not bounded canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.length > maximum || decoded.toString("base64") !== value) {
    fail("evidence-invalid", `${label} is not bounded canonical base64`);
  }
  return decoded;
}

function evidenceString(value, expected, label) {
  if (value !== expected) fail("evidence-invalid", `${label} differs from its embedded verified payload`);
}

/**
 * Parse the persisted release authority without granting it cryptographic
 * authority.  The publication call graph invokes `verifyRelease` again first;
 * this parser then proves that the exact bytes about to be stored are the
 * canonical output of that verification and still bind the requested five
 * receipt identities.  It is exported for the host publisher and tests only.
 */
export async function parseAuthorityEvidenceBytes(bytes, {
  expectedRequestSha256 = null,
  expectedArtifacts = null,
} = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_EVIDENCE_BYTES) {
    fail("evidence-invalid", "hosted release evidence must be bounded nonempty bytes");
  }
  const evidence = strictJson(bytes.toString("utf8"), "hosted release evidence");
  exactFields(evidence, EVIDENCE_FIELDS, "hosted release evidence");
  exactString(evidence.schema, "revival.pin-hosted-release-evidence", "evidence schema");
  if (evidence.version !== 1) fail("evidence-invalid", "hosted release evidence version changed");
  exactFields(evidence.payloads, EVIDENCE_PAYLOAD_FIELDS, "hosted release evidence payloads");

  const payloads = Object.fromEntries(EVIDENCE_PAYLOAD_FIELDS.map((field) => [
    field,
    decodeCanonicalBase64(evidence.payloads[field], `evidence ${field}`),
  ]));
  const [policyRecord, trustedRoot] = await Promise.all([
    loadPolicy(),
    protectedFile(TRUSTED_ROOT_PATH, "pinned GitHub private Sigstore trusted root", 128 * 1024, false),
  ]);
  if (!payloads.policyBase64.equals(policyRecord.bytes)) {
    fail("evidence-invalid", "evidence embeds a different hosted policy");
  }
  if (trustedRoot.sha256 !== policyRecord.policy.trustedRoot.sha256 || !payloads.trustedRootBase64.equals(trustedRoot.bytes)) {
    fail("evidence-invalid", "evidence embeds a different trusted root");
  }
  const request = parseRequest(
    strictJson(payloads.requestBase64.toString("utf8"), "embedded hosted release request"),
    policyRecord,
  );
  const requestSha256 = sha256(payloads.requestBase64);
  const preBundleSha256 = sha256(payloads.preSignBundleBase64);
  const predicate = parsePostPredicate(
    strictJson(payloads.predicateBase64.toString("utf8"), "embedded five-APK predicate"),
    {
      policy: policyRecord.policy,
      requestSha256,
      preSignBundleSha256: preBundleSha256,
      runnerInvocationUri: evidence.runnerInvocationUri,
    },
  );
  // Verification summaries are deliberately canonical selected fields rather
  // than unbounded/unstable CLI diagnostics. Their cryptographic authority is
  // freshly established from the embedded bundles immediately before this
  // parser is called.
  strictJson(payloads.preSignVerificationBase64.toString("utf8"), "embedded pre-sign verification");
  strictJson(payloads.releaseVerificationBase64.toString("utf8"), "embedded release verification");

  evidenceString(evidence.provider, policyRecord.policy.provider, "evidence provider");
  evidenceString(evidence.policySha256, policyRecord.sha256, "evidence policy digest");
  evidenceString(evidence.requestSha256, requestSha256, "evidence request digest");
  evidenceString(evidence.predicateSha256, sha256(payloads.predicateBase64), "evidence predicate digest");
  evidenceString(evidence.trustedRootSha256, trustedRoot.sha256, "evidence trusted-root digest");
  evidenceString(evidence.preSignBundleSha256, preBundleSha256, "evidence pre-sign bundle digest");
  evidenceString(evidence.releaseBundleSha256, sha256(payloads.releaseBundleBase64), "evidence release bundle digest");
  evidenceString(
    evidence.preSignVerificationSha256,
    sha256(payloads.preSignVerificationBase64),
    "evidence pre-sign verification digest",
  );
  evidenceString(
    evidence.releaseVerificationSha256,
    sha256(payloads.releaseVerificationBase64),
    "evidence release verification digest",
  );
  for (const [field, expected] of [
    ["runnerEnvironment", policyRecord.policy.runnerEnvironment],
    ["runnerLabel", policyRecord.policy.runnerLabel],
    ["runnerArchitecture", policyRecord.policy.runnerArchitecture],
    ["repository", policyRecord.policy.repository],
    ["sourceRef", request.sourceRef],
    ["sourceDigest", request.sourceDigest],
    ["sourceGenerationSha256", request.sourceGenerationSha256],
    ["sourceTarSha256", request.sourceTarSha256],
    ["toolchainSha256", request.toolchainSha256],
    ["builderImageId", request.builderImageId],
  ]) evidenceString(evidence[field], expected, `evidence ${field}`);
  evidenceString(evidence.runnerInvocationUri, predicate.runnerInvocationUri, "evidence run identity");
  if (canonical(evidence.artifacts) !== canonical(predicate.artifacts)) {
    fail("evidence-invalid", "evidence artifact set differs from the verified predicate");
  }
  if (expectedRequestSha256 !== null) {
    evidenceString(requestSha256, expectedRequestSha256, "publication request digest");
  }
  if (expectedArtifacts !== null) {
    if (!Array.isArray(expectedArtifacts) || canonical(expectedArtifacts) !== canonical(predicate.artifacts)) {
      fail("evidence-invalid", "published receipts differ from the verified exact-five artifact set");
    }
  }
  return Object.freeze({ evidence: Object.freeze(evidence), policyRecord, request, predicate });
}

async function atomicWrite(pathValue, bytes) {
  const destination = resolve(pathValue);
  const temporary = `${destination}.${process.pid}.tmp`;
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function cliOptions(argumentsList) {
  const result = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined || result.has(name.slice(2))) {
      fail("usage", "hosted attestation options must be unique --name value pairs");
    }
    result.set(name.slice(2), value);
  }
  return result;
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (!value) fail("usage", `--${name} is required`);
  return value;
}

async function main(argumentsList) {
  const command = argumentsList.shift();
  const options = cliOptions(argumentsList);
  if (command === "verify-pre") {
    const verified = await verifyPreSign({
      requestPath: requiredOption(options, "request"),
      bundlePath: requiredOption(options, "bundle"),
    });
    if (options.size !== 3 || !options.has("output")) fail("usage", "verify-pre received unsupported options");
    await atomicWrite(requiredOption(options, "output"), Buffer.from(canonicalJson(verified.parsed)));
    return;
  }
  if (command === "verify-release") {
    const allowed = ["request", "pre-bundle", "release-bundle", "predicate", "artifact-root", "output"];
    if (options.size !== allowed.length || allowed.some((name) => !options.has(name))) {
      fail("usage", "verify-release requires the exact documented option set");
    }
    const verified = await verifyRelease({
      requestPath: requiredOption(options, "request"),
      preSignBundlePath: requiredOption(options, "pre-bundle"),
      releaseBundlePath: requiredOption(options, "release-bundle"),
      predicatePath: requiredOption(options, "predicate"),
      artifactRoot: requiredOption(options, "artifact-root"),
    });
    await atomicWrite(requiredOption(options, "output"), createAuthorityEvidence(verified));
    return;
  }
  fail("usage", "expected verify-pre or verify-release");
}

if (resolve(process.argv[1] ?? "") === SELF_PATH) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`hosted-attestation: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error?.code === "usage" ? 64 : 1;
  });
}
