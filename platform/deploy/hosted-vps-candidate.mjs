#!/usr/bin/env node

/**
 * File-only handoff for immutable VPS candidates built by the pinned
 * GitHub-hosted linux/x64 workflow.  The workflow writes a canonical receipt
 * and a provider Sigstore bundle; import verifies both through the separately
 * sealed verifier before copying candidate bytes into the external store.
 * Nothing in this module deploys, loads an image, or reads a secret.
 */

import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANDIDATE_BASENAME,
  EXPECTED_CANDIDATE_FILES,
  HOSTED_CANDIDATE_AUTHORITY,
  PAYLOAD_SPECS,
  publishCandidate,
  verifyCandidate,
} from "./release-candidate.mjs";
import {
  canonicalJson,
  loadPolicy,
  parseHostedVpsCandidateReceipt,
} from "./pin/hosted-attestation.mjs";
import {
  defaultHostedVerifierCacheRoot,
  verifyHostedVpsCandidateHandoff,
} from "./pin/build.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const SOURCE_ROOT = resolve(dirname(SELF_PATH), "../..");
const RECEIPT_NAME = "hosted-vps-receipt.json";
const BUNDLE_NAME = "provider.sigstore.json";
const CHECKSUMS_NAME = "candidate-checksums.txt";
const EVIDENCE_ROOT_NAME = "hosted-vps-candidate-evidence";
const EVIDENCE_FILES = Object.freeze([
  RECEIPT_NAME,
  BUNDLE_NAME,
  "verification.json",
  "evidence.json",
]);
const EVIDENCE_MANIFEST_FIELDS = Object.freeze([
  "schema", "version", "policySha256", "repository", "sourceRef",
  "runnerEnvironment", "runnerLabel", "runnerArchitecture", "runnerInvocationUri",
  "candidateId", "releaseId", "sourceDigest", "sourceTree", "sourceArchiveSha256",
  "importedCandidateRoot", "inventorySha256", "files",
]);
const EVIDENCE_FILE_FIELDS = Object.freeze(["name", "size", "sha256"]);
const CURRENT_POINTER_FIELDS = Object.freeze([
  "schema", "version", "candidateId", "releaseId", "manifestSha256",
]);
const AUTHORITY_FIELDS = Object.freeze([
  "schema", "version", "ok", "candidateId", "releaseId", "sourceDigest", "sourceTree",
  "sourceArchiveSha256", "repository", "sourceRef", "runnerInvocationUri", "candidateRoot",
  "evidenceRoot", "inventorySha256", "receiptSha256", "providerBundleSha256",
  "verificationSha256", "evidenceSha256", "manifestSha256", "providerEvidence",
]);
const PROVIDER_EVIDENCE_FIELDS = Object.freeze([
  "schema", "version", "policySha256", "receiptSha256", "bundleSha256",
  "verificationSha256", "runnerEnvironment", "runnerLabel", "runnerArchitecture",
  "runnerInvocationUri", "repository", "sourceRef", "sourceDigest", "sourceTree",
  "candidateId", "releaseId", "files",
]);
const SHA256_RE = /^[0-9a-f]{64}$/u;
const RUN_URI_RE = /^https:\/\/github\.com\/TheAndersMadsen\/ai-pin-revival\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/u;

class HostedVpsCandidateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HostedVpsCandidateError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new HostedVpsCandidateError(code, message);
}

function exactFields(value, fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...fields].sort().join("\0");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pathWithin(parent, child) {
  const offset = relative(resolve(parent), resolve(child));
  return offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

function requireOutsideSource(pathValue, label) {
  const selected = resolve(pathValue);
  if (pathWithin(SOURCE_ROOT, selected)) fail("unsafe-path", `${label} must be outside the source tree`);
  return selected;
}

async function requireDirectory(pathValue, label, { create = false, privateMode = false } = {}) {
  const selected = requireOutsideSource(pathValue, label);
  if (create) await mkdir(selected, { recursive: true, mode: 0o700 });
  const metadata = await lstat(selected).catch((error) => {
    if (error?.code === "ENOENT") fail("missing-input", `${label} is missing`);
    throw error;
  });
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(selected) !== selected) {
    fail("unsafe-path", `${label} must be one canonical real directory`);
  }
  if (privateMode && (metadata.mode & 0o077) !== 0) fail("unsafe-mode", `${label} must be owner-only`);
  return selected;
}

async function stableDigest(pathValue, maximum = 64 * 1024 * 1024 * 1024) {
  const before = await lstat(pathValue, { bigint: true });
  if (
    before.isSymbolicLink() || !before.isFile() || before.size <= 0n ||
    before.size > BigInt(maximum) || await realpath(pathValue) !== resolve(pathValue)
  ) fail("invalid-file", `${basename(pathValue)} is not one bounded canonical regular file`);
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(pathValue, { highWaterMark: 1024 * 1024 })) {
    size += chunk.length;
    digest.update(chunk);
  }
  const after = await lstat(pathValue, { bigint: true });
  if (
    before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(size) !== before.size
  ) fail("input-changed", `${basename(pathValue)} changed while read`);
  return Object.freeze({ size, sha256: digest.digest("hex") });
}

async function stableRead(pathValue, maximum = 32 * 1024 * 1024) {
  const before = await lstat(pathValue, { bigint: true }).catch((error) => {
    if (error?.code === "ENOENT") fail("missing-input", `${basename(pathValue)} is missing`);
    throw error;
  });
  if (
    before.isSymbolicLink() || !before.isFile() || before.size <= 0n ||
    before.size > BigInt(maximum) || await realpath(pathValue) !== resolve(pathValue)
  ) fail("invalid-file", `${basename(pathValue)} is not one bounded canonical regular file`);
  const bytes = await readFile(pathValue);
  const after = await lstat(pathValue, { bigint: true });
  if (
    before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
    BigInt(bytes.length) !== before.size
  ) fail("input-changed", `${basename(pathValue)} changed while read`);
  return Object.freeze({ bytes, size: bytes.length, sha256: sha256(bytes) });
}

async function writeExclusive(pathValue, bytes, mode = 0o600) {
  const handle = await open(pathValue, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(pathValue, bytes) {
  const temporary = `${pathValue}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeExclusive(temporary, bytes);
    await rename(temporary, pathValue);
    await chmod(pathValue, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

function roleInventory(verified, descriptorDigest) {
  const payloads = new Map(verified.descriptor.body.files.map((file) => [file.role, file]));
  return Object.freeze([
    Object.freeze({
      role: "candidate-descriptor",
      name: CANDIDATE_BASENAME,
      sha256: descriptorDigest.sha256,
      size: descriptorDigest.size,
    }),
    ...PAYLOAD_SPECS.map((spec) => {
      const file = payloads.get(spec.role);
      if (!file || file.name !== spec.basename) fail("candidate-invalid", `candidate is missing ${spec.role}`);
      return Object.freeze({ role: spec.role, name: spec.basename, sha256: file.sha256, size: file.size });
    }),
  ]);
}

function itemByRole(files, role) {
  const selected = files.find((file) => file.role === role);
  if (!selected) fail("candidate-invalid", `candidate has no ${role}`);
  return selected;
}

function assertReceiptMatchesCandidate(receipt, candidate) {
  if (canonicalJson(candidate.authority) !== canonicalJson(HOSTED_CANDIDATE_AUTHORITY)) {
    fail("candidate-authority", "hosted handoff candidate is not marked for GitHub-hosted provider-evidence use");
  }
  if (
    receipt.candidateId !== candidate.candidateId ||
    receipt.releaseId !== candidate.release.releaseId ||
    receipt.sourceDigest !== candidate.sourceReceipt.commit ||
    receipt.sourceTree !== candidate.sourceReceipt.tree ||
    receipt.sourceArchiveSha256 !== candidate.sourceReceipt.archiveSha256
  ) fail("receipt-mismatch", "hosted receipt differs from the verified candidate identity");
  const bodyFiles = new Map(candidate.descriptor.body.files.map((file) => [file.role, file]));
  for (const file of receipt.files.slice(1)) {
    const bodyFile = bodyFiles.get(file.role);
    if (
      !bodyFile || bodyFile.name !== file.name || bodyFile.sha256 !== file.sha256 ||
      bodyFile.size !== file.size
    ) fail("receipt-mismatch", `hosted receipt differs from candidate ${file.role}`);
  }
  const bindings = [
    ["sourceReceiptSha256", "source-snapshot-receipt"],
    ["toolchainReceiptSha256", "toolchain-receipt"],
    ["imageReceiptSha256", "docker-image-receipt"],
    ["imageBundleSha256", "docker-image-bundle"],
  ];
  for (const [field, role] of bindings) {
    if (receipt[field] !== bodyFiles.get(role)?.sha256) {
      fail("receipt-mismatch", `hosted receipt ${field} differs from the candidate`);
    }
  }
}

export async function prepareHostedVpsCandidateHandoff({
  candidateRoot,
  outputRoot,
  sourceDigest,
  runnerInvocationUri,
}) {
  if (!/^[0-9a-f]{40}$/u.test(sourceDigest ?? "") || !RUN_URI_RE.test(runnerInvocationUri ?? "")) {
    fail("usage", "source digest and GitHub Actions run-attempt URI are required");
  }
  const output = await requireDirectory(outputRoot, "hosted handoff output", { create: true, privateMode: true });
  const preexisting = (await readdir(output)).sort();
  if (preexisting.some((name) => !["candidate-build", "release-candidates"].includes(name))) {
    fail("output-not-empty", "hosted handoff output contains an unrelated entry");
  }
  const candidate = verifyCandidate(resolve(candidateRoot), { enforceTrustedProtocol: true });
  if (candidate.sourceReceipt.commit !== sourceDigest) {
    fail("source-mismatch", "candidate source commit differs from GITHUB_SHA");
  }
  const policyRecord = await loadPolicy();
  const descriptorDigest = await stableDigest(join(candidate.root, CANDIDATE_BASENAME), 2 * 1024 * 1024);
  const files = roleInventory(candidate, descriptorDigest);
  const receipt = {
    schema: policyRecord.policy.vpsCandidate.receiptSchema,
    version: policyRecord.policy.vpsCandidate.receiptVersion,
    policySha256: policyRecord.sha256,
    repository: policyRecord.policy.repository,
    sourceRef: policyRecord.policy.sourceRef,
    sourceDigest,
    sourceTree: candidate.sourceReceipt.tree,
    runnerEnvironment: policyRecord.policy.runnerEnvironment,
    runnerLabel: policyRecord.policy.runnerLabel,
    runnerArchitecture: policyRecord.policy.runnerArchitecture,
    runnerInvocationUri,
    candidateId: candidate.candidateId,
    releaseId: candidate.release.releaseId,
    sourceArchiveSha256: candidate.sourceReceipt.archiveSha256,
    sourceReceiptSha256: itemByRole(files, "source-snapshot-receipt").sha256,
    toolchainReceiptSha256: itemByRole(files, "toolchain-receipt").sha256,
    imageReceiptSha256: itemByRole(files, "docker-image-receipt").sha256,
    imageBundleSha256: itemByRole(files, "docker-image-bundle").sha256,
    files,
  };
  parseHostedVpsCandidateReceipt(receipt, policyRecord);
  const receiptPath = join(output, RECEIPT_NAME);
  const checksumsPath = join(output, CHECKSUMS_NAME);
  await writeExclusive(receiptPath, canonicalJson(receipt));
  await writeExclusive(
    checksumsPath,
    `${files.map((file) => `${file.sha256} *${file.name}`).join("\n")}\n`,
  );
  const after = verifyCandidate(candidate.root, { enforceTrustedProtocol: true });
  assertReceiptMatchesCandidate(receipt, after);
  return Object.freeze({
    candidateId: candidate.candidateId,
    releaseId: candidate.release.releaseId,
    candidateRoot: candidate.root,
    receiptPath,
    checksumsPath,
    subjectCount: files.length,
  });
}

async function normalizeDownloadedHandoff(handoffRoot) {
  const root = await requireDirectory(handoffRoot, "hosted candidate handoff");
  await chmod(root, 0o700);
  const topLevel = (await readdir(root)).sort();
  const expectedTopLevel = [BUNDLE_NAME, RECEIPT_NAME, "release-candidates"].sort();
  if (
    topLevel.length !== expectedTopLevel.length ||
    topLevel.some((name, index) => name !== expectedTopLevel[index])
  ) fail("invalid-handoff", "hosted candidate handoff has missing or unexpected top-level entries");
  for (const name of [RECEIPT_NAME, BUNDLE_NAME]) {
    const selected = join(root, name);
    const metadata = await lstat(selected).catch((error) => {
      if (error?.code === "ENOENT") fail("missing-input", `hosted handoff has no ${name}`);
      throw error;
    });
    if (metadata.isSymbolicLink() || !metadata.isFile() || await realpath(selected) !== selected) {
      fail("invalid-file", `hosted handoff ${name} is unsafe`);
    }
    await chmod(selected, 0o600);
  }
  const policyRecord = await loadPolicy();
  const receiptSource = await readFile(join(root, RECEIPT_NAME), "utf8");
  let receiptValue;
  try { receiptValue = JSON.parse(receiptSource); } catch { fail("invalid-receipt", "hosted handoff receipt is not JSON"); }
  if (receiptSource !== canonicalJson(receiptValue)) fail("invalid-receipt", "hosted handoff receipt is not canonical");
  const receipt = parseHostedVpsCandidateReceipt(receiptValue, policyRecord);
  const candidatesRoot = join(root, "release-candidates");
  const candidatesMetadata = await lstat(candidatesRoot);
  if (
    candidatesMetadata.isSymbolicLink() || !candidatesMetadata.isDirectory() ||
    await realpath(candidatesRoot) !== candidatesRoot
  ) fail("invalid-candidate", "hosted release-candidates root is unsafe");
  await chmod(candidatesRoot, 0o700);
  const candidateNames = (await readdir(candidatesRoot)).sort();
  if (candidateNames.length !== 1 || candidateNames[0] !== receipt.candidateId) {
    fail("invalid-candidate", "hosted handoff must contain exactly its attested candidate directory");
  }
  const candidateRoot = join(candidatesRoot, receipt.candidateId);
  if (!pathWithin(root, candidateRoot)) fail("unsafe-path", "hosted candidate path escaped its handoff");
  const candidateDirectory = await lstat(candidateRoot);
  if (candidateDirectory.isSymbolicLink() || !candidateDirectory.isDirectory() || await realpath(candidateRoot) !== candidateRoot) {
    fail("invalid-candidate", "hosted candidate directory is unsafe");
  }
  await chmod(candidateRoot, 0o700);
  const names = (await readdir(candidateRoot)).sort();
  if (
    names.length !== EXPECTED_CANDIDATE_FILES.length ||
    names.some((name, index) => name !== EXPECTED_CANDIDATE_FILES[index])
  ) fail("invalid-candidate", "hosted candidate directory has missing or unexpected entries");
  for (const name of names) {
    const selected = join(candidateRoot, name);
    const metadata = await lstat(selected);
    if (metadata.isSymbolicLink() || !metadata.isFile() || await realpath(selected) !== selected) {
      fail("invalid-candidate", `hosted candidate entry ${name} is unsafe`);
    }
    await chmod(selected, 0o600);
  }
  return Object.freeze({
    root,
    receipt,
    receiptPath: join(root, RECEIPT_NAME),
    bundlePath: join(root, BUNDLE_NAME),
    candidateRoot,
  });
}

export async function verifyHostedVpsCandidateArtifact({
  handoffRoot,
  verifierCacheRoot = defaultHostedVerifierCacheRoot(),
}) {
  const layout = await normalizeDownloadedHandoff(handoffRoot);
  const semantic = verifyCandidate(layout.candidateRoot, {
    expectedId: layout.receipt.candidateId,
    enforceTrustedProtocol: true,
  });
  assertReceiptMatchesCandidate(layout.receipt, semantic);
  const outputRoot = await mkdtemp(join(tmpdir(), "revival-vps-candidate-verification-"));
  await chmod(outputRoot, 0o700);
  try {
    const provider = await verifyHostedVpsCandidateHandoff({
      receiptPath: layout.receiptPath,
      bundlePath: layout.bundlePath,
      candidateRoot: layout.candidateRoot,
      outputRoot,
      verifierCacheRoot,
    });
    let evidence;
    try { evidence = JSON.parse(provider.evidenceBytes.toString("utf8")); } catch {
      fail("verification-invalid", "hosted provider verifier evidence is not JSON");
    }
    if (
      provider.evidenceBytes.toString("utf8") !== canonicalJson(evidence) ||
      evidence.candidateId !== semantic.candidateId || evidence.releaseId !== semantic.release.releaseId ||
      evidence.sourceDigest !== semantic.sourceReceipt.commit ||
      evidence.runnerInvocationUri !== layout.receipt.runnerInvocationUri
    ) fail("verification-invalid", "hosted provider evidence differs from the candidate handoff");
    const after = verifyCandidate(layout.candidateRoot, {
      expectedId: layout.receipt.candidateId,
      enforceTrustedProtocol: true,
    });
    assertReceiptMatchesCandidate(layout.receipt, after);
    return Object.freeze({
      layout,
      semantic: after,
      evidence,
      evidenceBytes: provider.evidenceBytes,
      verificationBytes: provider.verificationBytes,
    });
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

function payloadSources(candidate) {
  const byRole = new Map(candidate.descriptor.body.files.map((file) => [file.role, file]));
  return Object.fromEntries(PAYLOAD_SPECS.map((spec) => [
    spec.role,
    Object.freeze({ file: join(candidate.root, spec.basename), fileMetadata: byRole.get(spec.role) }),
  ]));
}

function createEvidenceManifest({ verified, published, files }) {
  const receipt = verified.layout.receipt;
  return Object.freeze({
    schema: "revival.hosted-vps-candidate-import",
    version: 2,
    policySha256: receipt.policySha256,
    repository: receipt.repository,
    sourceRef: receipt.sourceRef,
    runnerEnvironment: receipt.runnerEnvironment,
    runnerLabel: receipt.runnerLabel,
    runnerArchitecture: receipt.runnerArchitecture,
    runnerInvocationUri: receipt.runnerInvocationUri,
    candidateId: verified.semantic.candidateId,
    releaseId: verified.semantic.release.releaseId,
    sourceDigest: verified.semantic.sourceReceipt.commit,
    sourceTree: verified.semantic.sourceReceipt.tree,
    sourceArchiveSha256: verified.semantic.sourceReceipt.archiveSha256,
    importedCandidateRoot: published.root,
    inventorySha256: sha256(canonicalJson(receipt.files)),
    files,
  });
}

function parseCurrentPointer(source) {
  let pointer;
  try { pointer = JSON.parse(source); } catch { fail("status-invalid", "hosted candidate current pointer is not JSON"); }
  if (
    source !== canonicalJson(pointer) || !exactFields(pointer, CURRENT_POINTER_FIELDS) ||
    pointer.schema !== "revival.hosted-vps-candidate-current" || pointer.version !== 2 ||
    !SHA256_RE.test(pointer.candidateId) || !SHA256_RE.test(pointer.releaseId) ||
    !SHA256_RE.test(pointer.manifestSha256)
  ) fail("status-invalid", "hosted candidate current pointer is invalid");
  return Object.freeze(pointer);
}

export function parsePersistedHostedVpsEvidenceManifest(source, pointer) {
  let manifest;
  try { manifest = JSON.parse(source); } catch { fail("status-invalid", "hosted candidate evidence manifest is not JSON"); }
  if (
    source !== canonicalJson(manifest) || !exactFields(manifest, EVIDENCE_MANIFEST_FIELDS) ||
    manifest.schema !== "revival.hosted-vps-candidate-import" || manifest.version !== 2 ||
    manifest.candidateId !== pointer.candidateId || manifest.releaseId !== pointer.releaseId ||
    !SHA256_RE.test(manifest.policySha256) || !SHA256_RE.test(manifest.candidateId) ||
    !SHA256_RE.test(manifest.releaseId) || !/^[0-9a-f]{40}$/u.test(manifest.sourceDigest) ||
    !/^[0-9a-f]{40}$/u.test(manifest.sourceTree) || !SHA256_RE.test(manifest.sourceArchiveSha256) ||
    !SHA256_RE.test(manifest.inventorySha256) || manifest.repository !== "TheAndersMadsen/ai-pin-revival" ||
    manifest.sourceRef !== "refs/heads/main" || manifest.runnerEnvironment !== "github-hosted" ||
    manifest.runnerLabel !== "ubuntu-24.04" || manifest.runnerArchitecture !== "x64" ||
    !RUN_URI_RE.test(manifest.runnerInvocationUri) || !isAbsolute(manifest.importedCandidateRoot || "") ||
    !Array.isArray(manifest.files) || manifest.files.length !== EVIDENCE_FILES.length
  ) fail("status-invalid", "hosted candidate evidence manifest has an unsupported shape");
  for (let index = 0; index < EVIDENCE_FILES.length; index += 1) {
    const file = manifest.files[index];
    if (
      !exactFields(file, EVIDENCE_FILE_FIELDS) || file.name !== EVIDENCE_FILES[index] ||
      !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 32 * 1024 * 1024 ||
      !SHA256_RE.test(file.sha256)
    ) fail("status-invalid", "hosted candidate evidence file inventory is invalid");
  }
  return Object.freeze({ ...manifest, files: Object.freeze(manifest.files.map((file) => Object.freeze(file))) });
}

export function assertPersistedHostedVpsBindings(manifest, receipt, candidateRoot, fileRecords) {
  const expected = {
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
    inventorySha256: sha256(canonicalJson(receipt.files)),
  };
  for (const [field, value] of Object.entries(expected)) {
    if (manifest[field] !== value) fail("status-invalid", `persisted hosted candidate ${field} differs from its receipt`);
  }
  if (
    !Array.isArray(fileRecords) || fileRecords.length !== EVIDENCE_FILES.length ||
    fileRecords.some((file, index) =>
      file.name !== manifest.files[index].name || file.size !== manifest.files[index].size ||
      file.sha256 !== manifest.files[index].sha256)
  ) fail("status-invalid", "persisted hosted candidate evidence differs from its manifest");
}

async function persistEvidence({ dataDir, verified, published }) {
  const dataRoot = await requireDirectory(dataDir, "operator data root", { create: true, privateMode: true });
  const evidenceRoot = join(dataRoot, EVIDENCE_ROOT_NAME);
  await mkdir(evidenceRoot, { mode: 0o700 }).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  await requireDirectory(evidenceRoot, "hosted candidate evidence root", { privateMode: true });
  const finalRoot = join(evidenceRoot, verified.semantic.candidateId);
  const incoming = new Map([
    [RECEIPT_NAME, await stableDigest(verified.layout.receiptPath, 32 * 1024 * 1024)],
    [BUNDLE_NAME, await stableDigest(verified.layout.bundlePath, 32 * 1024 * 1024)],
    ["verification.json", {
      size: verified.verificationBytes.length,
      sha256: sha256(verified.verificationBytes),
    }],
    ["evidence.json", {
      size: verified.evidenceBytes.length,
      sha256: sha256(verified.evidenceBytes),
    }],
  ]);
  const files = Object.freeze(EVIDENCE_FILES.map((name) => Object.freeze({ name, ...incoming.get(name) })));
  const expectedManifest = createEvidenceManifest({ verified, published, files });
  const existing = await lstat(finalRoot).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existing !== null) {
    if (
      existing.isSymbolicLink() || !existing.isDirectory() || (existing.mode & 0o077) !== 0 ||
      await realpath(finalRoot) !== finalRoot
    ) {
      fail("evidence-collision", "candidate evidence path is unsafe");
    }
    const manifestRead = await stableRead(join(finalRoot, "manifest.json"), 1024 * 1024);
    const manifestIdentity = Object.freeze({
      candidateId: expectedManifest.candidateId,
      releaseId: expectedManifest.releaseId,
    });
    const manifest = parsePersistedHostedVpsEvidenceManifest(manifestRead.bytes.toString("utf8"), manifestIdentity);
    if (canonicalJson(manifest) !== canonicalJson(expectedManifest)) {
      fail("evidence-collision", "candidate evidence conflicts with the newly verified handoff");
    }
    const observedFiles = [];
    for (let index = 0; index < EVIDENCE_FILES.length; index += 1) {
      const name = EVIDENCE_FILES[index];
      const observed = await stableDigest(join(finalRoot, name), 32 * 1024 * 1024);
      const expected = incoming.get(name);
      if (
        observed.size !== expected.size || observed.sha256 !== expected.sha256
      ) fail("evidence-collision", `existing ${name} evidence differs from the verified handoff`);
      observedFiles.push(Object.freeze({ name, ...observed }));
    }
    assertPersistedHostedVpsBindings(manifest, verified.layout.receipt, published.root, observedFiles);
    const pointer = {
      schema: "revival.hosted-vps-candidate-current",
      version: 2,
      candidateId: manifest.candidateId,
      releaseId: manifest.releaseId,
      manifestSha256: manifestRead.sha256,
    };
    await atomicWrite(join(evidenceRoot, "current.json"), canonicalJson(pointer));
    return Object.freeze({ evidenceRoot: finalRoot, manifest });
  }
  const stage = await mkdtemp(join(evidenceRoot, ".incoming-"));
  await chmod(stage, 0o700);
  try {
    const sources = new Map([
      [RECEIPT_NAME, verified.layout.receiptPath],
      [BUNDLE_NAME, verified.layout.bundlePath],
    ]);
    for (const [name, source] of sources) {
      await copyFile(source, join(stage, name), fsConstants.COPYFILE_EXCL);
      await chmod(join(stage, name), 0o600);
    }
    await writeExclusive(join(stage, "verification.json"), verified.verificationBytes);
    await writeExclusive(join(stage, "evidence.json"), verified.evidenceBytes);
    const stagedFiles = [];
    for (const name of EVIDENCE_FILES) stagedFiles.push(Object.freeze({
      name,
      ...await stableDigest(join(stage, name), 32 * 1024 * 1024),
    }));
    const manifest = createEvidenceManifest({ verified, published, files: Object.freeze(stagedFiles) });
    await writeExclusive(join(stage, "manifest.json"), canonicalJson(manifest));
    await rename(stage, finalRoot);
    const pointer = {
      schema: "revival.hosted-vps-candidate-current",
      version: 2,
      candidateId: manifest.candidateId,
      releaseId: manifest.releaseId,
      manifestSha256: (await stableDigest(join(finalRoot, "manifest.json"), 1024 * 1024)).sha256,
    };
    await atomicWrite(join(evidenceRoot, "current.json"), canonicalJson(pointer));
    return Object.freeze({ evidenceRoot: finalRoot, manifest });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function importHostedVpsCandidate(options) {
  const verified = await verifyHostedVpsCandidateArtifact(options);
  const dataDir = requireOutsideSource(options.dataDir, "operator data root");
  const published = publishCandidate({
    dataDir,
    descriptor: verified.semantic.descriptor,
    payloads: payloadSources(verified.semantic),
  });
  const evidence = await persistEvidence({ dataDir, verified, published });
  return Object.freeze({
    ok: true,
    candidateId: published.candidateId,
    releaseId: published.release.releaseId,
    candidateRoot: published.root,
    evidenceRoot: evidence.evidenceRoot,
    runnerInvocationUri: verified.layout.receipt.runnerInvocationUri,
    sourceDigest: verified.layout.receipt.sourceDigest,
  });
}

function parseReverifiedProviderEvidence(bytes, { receipt, policyRecord, receiptSha256, bundleSha256, verificationSha256 }) {
  let evidence;
  const source = bytes.toString("utf8");
  try { evidence = JSON.parse(source); } catch { fail("status-invalid", "fresh provider evidence is not JSON"); }
  if (
    source !== canonicalJson(evidence) || !exactFields(evidence, PROVIDER_EVIDENCE_FIELDS) ||
    evidence.schema !== "revival.hosted-vps-candidate-verification" || evidence.version !== 1 ||
    evidence.policySha256 !== policyRecord.sha256 || evidence.receiptSha256 !== receiptSha256 ||
    evidence.bundleSha256 !== bundleSha256 || evidence.verificationSha256 !== verificationSha256 ||
    evidence.runnerEnvironment !== receipt.runnerEnvironment || evidence.runnerLabel !== receipt.runnerLabel ||
    evidence.runnerArchitecture !== receipt.runnerArchitecture ||
    evidence.runnerInvocationUri !== receipt.runnerInvocationUri || evidence.repository !== receipt.repository ||
    evidence.sourceRef !== receipt.sourceRef || evidence.sourceDigest !== receipt.sourceDigest ||
    evidence.sourceTree !== receipt.sourceTree || evidence.candidateId !== receipt.candidateId ||
    evidence.releaseId !== receipt.releaseId || canonicalJson(evidence.files) !== canonicalJson(receipt.files)
  ) fail("status-invalid", "fresh provider evidence differs from the exact persisted request");
  return Object.freeze(evidence);
}

export async function hostedVpsCandidateStatus({
  dataDir,
  verifierCacheRoot = defaultHostedVerifierCacheRoot(),
  expectedCandidateId,
  expectedCandidateRoot,
}) {
  if (expectedCandidateId !== undefined && !SHA256_RE.test(expectedCandidateId)) {
    fail("usage", "expected hosted candidate ID must be one lowercase SHA-256 digest");
  }
  if (expectedCandidateRoot !== undefined && !isAbsolute(expectedCandidateRoot)) {
    fail("usage", "expected hosted candidate path must be absolute");
  }
  const dataRoot = await requireDirectory(requireOutsideSource(dataDir, "operator data root"), "operator data root", { privateMode: true });
  const root = await requireDirectory(join(dataRoot, EVIDENCE_ROOT_NAME), "hosted candidate evidence root", { privateMode: true });
  const pointerRead = await stableRead(join(root, "current.json"), 1024 * 1024);
  const pointer = parseCurrentPointer(pointerRead.bytes.toString("utf8"));
  if (expectedCandidateId !== undefined && pointer.candidateId !== expectedCandidateId) {
    fail("status-invalid", "selected candidate ID is not the current provider-verified hosted candidate");
  }

  const evidenceRoot = await requireDirectory(join(root, pointer.candidateId), "hosted candidate evidence record", { privateMode: true });
  const manifestRead = await stableRead(join(evidenceRoot, "manifest.json"), 1024 * 1024);
  if (manifestRead.sha256 !== pointer.manifestSha256) fail("status-invalid", "hosted candidate evidence manifest changed");
  const manifest = parsePersistedHostedVpsEvidenceManifest(manifestRead.bytes.toString("utf8"), pointer);
  const expectedPublishedRoot = join(dataRoot, "release-candidates", pointer.candidateId);
  if (manifest.importedCandidateRoot !== expectedPublishedRoot) {
    fail("status-invalid", "hosted candidate evidence points outside its exact imported candidate slot");
  }

  const fileReads = new Map();
  const fileRecords = [];
  for (const file of manifest.files) {
    const observed = await stableRead(join(evidenceRoot, file.name), 32 * 1024 * 1024);
    if (observed.size !== file.size || observed.sha256 !== file.sha256) {
      fail("status-invalid", `${file.name} changed after import`);
    }
    fileReads.set(file.name, observed);
    fileRecords.push(Object.freeze({ name: file.name, size: observed.size, sha256: observed.sha256 }));
  }

  const policyRecord = await loadPolicy();
  const receiptRead = fileReads.get(RECEIPT_NAME);
  let receiptValue;
  const receiptSource = receiptRead.bytes.toString("utf8");
  try { receiptValue = JSON.parse(receiptSource); } catch { fail("status-invalid", "persisted hosted receipt is not JSON"); }
  if (receiptSource !== canonicalJson(receiptValue)) fail("status-invalid", "persisted hosted receipt is not canonical");
  const receipt = parseHostedVpsCandidateReceipt(receiptValue, policyRecord);
  assertPersistedHostedVpsBindings(manifest, receipt, expectedPublishedRoot, fileRecords);

  let candidate = verifyCandidate(expectedPublishedRoot, {
    expectedId: pointer.candidateId,
    enforceTrustedProtocol: true,
  });
  if (
    expectedCandidateRoot !== undefined &&
    (resolve(expectedCandidateRoot) !== candidate.root || await realpath(expectedCandidateRoot) !== candidate.root)
  ) fail("status-invalid", "selected candidate path is not the current provider-verified hosted candidate");
  assertReceiptMatchesCandidate(receipt, candidate);

  const outputRoot = await mkdtemp(join(tmpdir(), "revival-vps-candidate-status-"));
  await chmod(outputRoot, 0o700);
  let provider;
  try {
    provider = await verifyHostedVpsCandidateHandoff({
      receiptPath: join(evidenceRoot, RECEIPT_NAME),
      bundlePath: join(evidenceRoot, BUNDLE_NAME),
      candidateRoot: candidate.root,
      outputRoot,
      verifierCacheRoot,
    });
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
  const persistedVerification = fileReads.get("verification.json").bytes;
  const persistedEvidence = fileReads.get("evidence.json").bytes;
  if (
    !provider.verificationBytes.equals(persistedVerification) ||
    !provider.evidenceBytes.equals(persistedEvidence)
  ) fail("status-invalid", "fresh provider verification differs from the persisted canonical evidence");
  const verificationSha256 = sha256(provider.verificationBytes);
  parseReverifiedProviderEvidence(provider.evidenceBytes, {
    receipt,
    policyRecord,
    receiptSha256: receiptRead.sha256,
    bundleSha256: fileReads.get(BUNDLE_NAME).sha256,
    verificationSha256,
  });

  // The fixed verifier and semantic verifier both consumed the candidate.
  // Reopen every persisted input and the complete candidate once more before
  // returning an in-process authority record to the deployment wrapper.
  const afterRecords = [];
  for (const file of manifest.files) {
    const after = await stableRead(join(evidenceRoot, file.name), 32 * 1024 * 1024);
    const before = fileReads.get(file.name);
    if (after.size !== before.size || after.sha256 !== before.sha256) {
      fail("status-invalid", `${file.name} changed during point-of-use verification`);
    }
    afterRecords.push(Object.freeze({ name: file.name, size: after.size, sha256: after.sha256 }));
  }
  assertPersistedHostedVpsBindings(manifest, receipt, expectedPublishedRoot, afterRecords);
  candidate = verifyCandidate(expectedPublishedRoot, {
    expectedId: pointer.candidateId,
    enforceTrustedProtocol: true,
  });
  assertReceiptMatchesCandidate(receipt, candidate);
  const [pointerAfter, manifestAfter] = await Promise.all([
    stableRead(join(root, "current.json"), 1024 * 1024),
    stableRead(join(evidenceRoot, "manifest.json"), 1024 * 1024),
  ]);
  if (
    pointerAfter.sha256 !== pointerRead.sha256 || !pointerAfter.bytes.equals(pointerRead.bytes) ||
    manifestAfter.sha256 !== manifestRead.sha256 || !manifestAfter.bytes.equals(manifestRead.bytes)
  ) fail("status-invalid", "hosted candidate selection changed during point-of-use verification");

  const authority = {
    schema: "revival.hosted-vps-candidate-authority",
    version: 1,
    ok: true,
    candidateId: pointer.candidateId,
    releaseId: pointer.releaseId,
    sourceDigest: receipt.sourceDigest,
    sourceTree: receipt.sourceTree,
    sourceArchiveSha256: receipt.sourceArchiveSha256,
    repository: receipt.repository,
    sourceRef: receipt.sourceRef,
    runnerInvocationUri: receipt.runnerInvocationUri,
    candidateRoot: candidate.root,
    evidenceRoot,
    inventorySha256: manifest.inventorySha256,
    receiptSha256: receiptRead.sha256,
    providerBundleSha256: fileReads.get(BUNDLE_NAME).sha256,
    verificationSha256,
    evidenceSha256: sha256(provider.evidenceBytes),
    manifestSha256: manifestRead.sha256,
    providerEvidence: "point-of-use-reverified",
  };
  if (!exactFields(authority, AUTHORITY_FIELDS)) fail("status-invalid", "hosted candidate authority record is not closed");
  return Object.freeze(authority);
}

function defaultDataDir(environment = process.env) {
  return resolve(environment.REVIVAL_DATA_DIR ?? join(environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "ai-pin-revival"));
}

export async function authorizeHostedVpsCandidateDeployment({ candidate, candidateId, ...options }) {
  if (!candidate || !candidateId) fail("usage", "authorize-deploy requires both --candidate and --candidate-id");
  return await hostedVpsCandidateStatus({
    ...options,
    expectedCandidateId: candidateId,
    expectedCandidateRoot: candidate,
  });
}

function usage() {
  return [
    "usage:",
    "  hosted-vps-candidate.mjs prepare-handoff --candidate PATH --output-root DIR --source-digest SHA --run-uri URI [--json]",
    "  hosted-vps-candidate.mjs verify --handoff-root DIR [--verifier-cache-root DIR] [--json]",
    "  hosted-vps-candidate.mjs import --handoff-root DIR [--data-dir DIR] [--verifier-cache-root DIR] [--json]",
    "  hosted-vps-candidate.mjs status [--data-dir DIR] [--verifier-cache-root DIR] [--json]",
    "  hosted-vps-candidate.mjs authorize-deploy --candidate PATH --candidate-id SHA256 [--data-dir DIR] [--verifier-cache-root DIR] --json",
  ].join("\n");
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!["prepare-handoff", "verify", "import", "status", "authorize-deploy"].includes(command)) fail("usage", usage());
  const options = { command, json: false, dataDir: defaultDataDir(), verifierCacheRoot: defaultHostedVerifierCacheRoot() };
  const commandOptions = {
    "prepare-handoff": new Set(["--candidate", "--output-root", "--source-digest", "--run-uri"]),
    verify: new Set(["--handoff-root", "--verifier-cache-root"]),
    import: new Set(["--handoff-root", "--data-dir", "--verifier-cache-root"]),
    status: new Set(["--data-dir", "--verifier-cache-root"]),
    "authorize-deploy": new Set(["--candidate", "--candidate-id", "--data-dir", "--verifier-cache-root"]),
  }[command];
  const seen = new Set();
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (name === "--json" && !options.json) { options.json = true; continue; }
    if (!commandOptions.has(name)) {
      fail("usage", `unsupported option ${name}\n${usage()}`);
    }
    const value = rest[++index];
    if (!value || value.startsWith("-") || seen.has(name)) {
      fail("usage", `${name} requires one unique value\n${usage()}`);
    }
    seen.add(name);
    options[name.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
  }
  if (command === "prepare-handoff" && (!options.candidate || !options.outputRoot || !options.sourceDigest || !options.runUri)) fail("usage", usage());
  if (["verify", "import"].includes(command) && !options.handoffRoot) fail("usage", usage());
  if (command === "authorize-deploy" && (!options.candidate || !options.candidateId || !options.json)) fail("usage", usage());
  return options;
}

async function main(argv) {
  const options = parseCli(argv);
  let result;
  if (options.command === "prepare-handoff") result = await prepareHostedVpsCandidateHandoff({
    candidateRoot: options.candidate,
    outputRoot: options.outputRoot,
    sourceDigest: options.sourceDigest,
    runnerInvocationUri: options.runUri,
  });
  else if (options.command === "verify") {
    const verified = await verifyHostedVpsCandidateArtifact(options);
    result = {
      ok: true,
      candidateId: verified.semantic.candidateId,
      releaseId: verified.semantic.release.releaseId,
      sourceDigest: verified.layout.receipt.sourceDigest,
      runnerInvocationUri: verified.layout.receipt.runnerInvocationUri,
    };
  } else if (options.command === "import") result = await importHostedVpsCandidate(options);
  else if (options.command === "authorize-deploy") result = await authorizeHostedVpsCandidateDeployment(options);
  else result = await hostedVpsCandidateStatus(options);
  process.stdout.write(options.json ? canonicalJson(result) : `${options.command} passed: candidate=${result.candidateId} release=${result.releaseId}\n`);
}

if (resolve(process.argv[1] ?? "") === SELF_PATH) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`hosted-vps-candidate: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error?.code === "usage" ? 64 : 1;
  });
}
