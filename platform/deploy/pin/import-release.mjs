import { spawnSync } from "node:child_process";
import {
  X509Certificate,
  constants as cryptoConstants,
  createHash,
  randomBytes,
  verify as verifySignature,
} from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import {
  PIN_COMPATIBILITY_CERT_SHA256,
  PIN_RELEASE_ARTIFACT_ROLES,
  canonicalPinReleaseManifestJson,
  compareInstallVersions,
  parseCanonicalPinReleaseManifestDocument,
  parsePinReleaseJson,
  parsePinReleaseReceiptBundle,
  verifyPinReleaseMetadata,
} from "./release.mjs";
import { canonicalPinReleaseRoot } from "./release-store-path.mjs";
import { validateReleaseStore } from "./validate-release-store.mjs";

const TAR = "/usr/bin/tar";
const MAX_ARCHIVE_BYTES = 3 * 1024 * 1024 * 1024;
const TOP_LEVEL_RE = /^ai-pin-revival-pin-(\d{4}-\d{2}-\d{2}\.\d+)$/u;
const IMPORT_LOCK_TIMEOUT_MS = 120_000;
const APK_EOCD_SIGNATURE = 0x0605_4b50;
const APK_SIGNING_BLOCK_MAGIC = Buffer.from("APK Sig Block 42", "ascii");
const APK_SIGNATURE_SCHEME_V2_ID = 0x7109_871a;
const APK_SIGNATURE_SCHEME_V3_ID = 0xf053_68c0;
const APK_SIGNATURE_SCHEME_V31_ID = 0x1b93_ad61;
const V2_STRIPPING_PROTECTION_ATTRIBUTE_ID = 0xbeef_f00d;
const APK_CONTENT_CHUNK_BYTES = 1024 * 1024;
const MAX_APK_SIGNING_BLOCK_BYTES = 64 * 1024 * 1024;
// This checkout-free verifier intentionally accepts only Android's v2 scheme
// and the non-verity RSA/ECDSA algorithm IDs defined by AOSP apksig. DSA,
// verity digests, certificate chains, unknown signed-data framing, ZIP64,
// split APKs, and multiple signers fail closed instead of relying on host
// Android SDK tooling.
const SIGNATURE_ALGORITHMS = new Map([
  [0x0101, Object.freeze({ digest: "sha256", padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: 32 })],
  [0x0102, Object.freeze({ digest: "sha512", padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: 64 })],
  [0x0103, Object.freeze({ digest: "sha256", padding: cryptoConstants.RSA_PKCS1_PADDING })],
  [0x0104, Object.freeze({ digest: "sha512", padding: cryptoConstants.RSA_PKCS1_PADDING })],
  [0x0201, Object.freeze({ digest: "sha256" })],
  [0x0202, Object.freeze({ digest: "sha512" })],
]);

function fail(message) {
  throw new Error(message);
}

function runTar(args, options = {}) {
  const result = spawnSync(TAR, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    fail(result.stderr?.trim() || result.error?.message || "tar failed");
  }
  return result.stdout;
}

function inspectArchive(archive) {
  const names = runTar(["--list", "--gzip", "--file", archive])
    .split(/\r?\n/u)
    .filter(Boolean);
  const verbose = runTar(["--list", "--verbose", "--gzip", "--file", archive])
    .split(/\r?\n/u)
    .filter(Boolean);
  if (names.length !== verbose.length || names.length < 7 || names.length > 8) {
    fail("Pin release archive must contain one directory and exactly seven release files");
  }
  if (new Set(names).size !== names.length) fail("Pin release archive contains duplicate paths");
  for (const line of verbose) {
    if (line[0] !== "-" && line[0] !== "d") {
      fail("Pin release archive may contain only regular files and its top-level directory");
    }
  }

  const first = names[0].replace(/\/$/u, "").split("/")[0];
  const match = TOP_LEVEL_RE.exec(first);
  if (!match) fail("Pin release archive has an invalid top-level directory");
  const expectedFiles = new Set([
    `${first}/manifest.json`,
    `${first}/receipts.json`,
    ...PIN_RELEASE_ARTIFACT_ROLES.map((role) => `${first}/${role}.apk`),
  ]);
  const actualFiles = names.filter((name) => name !== `${first}/`);
  if (actualFiles.length !== expectedFiles.size || actualFiles.some((name) => !expectedFiles.has(name))) {
    fail("Pin release archive contains missing or unexpected files");
  }
  return Object.freeze({ directory: first, version: match[1] });
}

async function sha256File(filename) {
  const digest = createHash("sha256");
  await pipeline(createReadStream(filename), digest);
  return digest.digest("hex");
}

function readUint64(buffer, offset, context) {
  if (offset < 0 || offset + 8 > buffer.length) fail(`${context} is truncated`);
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${context} exceeds the supported size bound`);
  return Number(value);
}

function lengthPrefixed(buffer, cursor, context) {
  if (cursor.offset + 4 > buffer.length) fail(`${context} is truncated`);
  const length = buffer.readUInt32LE(cursor.offset);
  cursor.offset += 4;
  if (length > buffer.length - cursor.offset) fail(`${context} has an invalid length`);
  const value = buffer.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return value;
}

function lengthPrefixedSequence(buffer, context) {
  const cursor = { offset: 0 };
  const values = [];
  while (cursor.offset < buffer.length) values.push(lengthPrefixed(buffer, cursor, context));
  return values;
}

async function readExactly(descriptor, length, position, context) {
  const result = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await descriptor.read(result, offset, length - offset, position + offset);
    if (bytesRead === 0) fail(`${context} is truncated`);
    offset += bytesRead;
  }
  return result;
}

async function findApkSections(descriptor, size, role) {
  const tailLength = Math.min(size, 22 + 0xffff);
  if (tailLength < 22) fail(`${role}.apk has no ZIP end record`);
  const tailOffset = size - tailLength;
  const tail = await readExactly(descriptor, tailLength, tailOffset, `${role}.apk ZIP tail`);
  let eocdInTail = -1;
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === APK_EOCD_SIGNATURE &&
        offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) {
      eocdInTail = offset;
      break;
    }
  }
  if (eocdInTail < 0) fail(`${role}.apk has no canonical ZIP end record`);
  const eocd = Buffer.from(tail.subarray(eocdInTail));
  if (eocd.readUInt16LE(4) !== 0 || eocd.readUInt16LE(6) !== 0 ||
      eocd.readUInt16LE(8) !== eocd.readUInt16LE(10) ||
      eocd.readUInt16LE(10) === 0xffff || eocd.readUInt32LE(12) === 0xffff_ffff ||
      eocd.readUInt32LE(16) === 0xffff_ffff) {
    fail(`${role}.apk uses an unsupported split or ZIP64 layout`);
  }
  const eocdOffset = tailOffset + eocdInTail;
  const centralDirectorySize = eocd.readUInt32LE(12);
  const centralDirectoryOffset = eocd.readUInt32LE(16);
  if (centralDirectoryOffset + centralDirectorySize !== eocdOffset || centralDirectoryOffset < 24) {
    fail(`${role}.apk has an invalid ZIP central directory`);
  }
  const footer = await readExactly(
    descriptor,
    24,
    centralDirectoryOffset - 24,
    `${role}.apk signing block footer`,
  );
  if (!footer.subarray(8).equals(APK_SIGNING_BLOCK_MAGIC)) {
    fail(`${role}.apk is not signed with APK Signature Scheme v2`);
  }
  const signingBlockSize = readUint64(footer, 0, `${role}.apk signing block`);
  const totalSigningBlockSize = signingBlockSize + 8;
  if (signingBlockSize < 24 || totalSigningBlockSize > MAX_APK_SIGNING_BLOCK_BYTES ||
      totalSigningBlockSize > centralDirectoryOffset) {
    fail(`${role}.apk signing block has an invalid size`);
  }
  const signingBlockOffset = centralDirectoryOffset - totalSigningBlockSize;
  const signingBlock = await readExactly(
    descriptor,
    totalSigningBlockSize,
    signingBlockOffset,
    `${role}.apk signing block`,
  );
  if (readUint64(signingBlock, 0, `${role}.apk signing block header`) !== signingBlockSize ||
      readUint64(signingBlock, signingBlock.length - 24, `${role}.apk signing block footer`) !== signingBlockSize ||
      !signingBlock.subarray(signingBlock.length - 16).equals(APK_SIGNING_BLOCK_MAGIC)) {
    fail(`${role}.apk signing block framing is invalid`);
  }
  return Object.freeze({
    centralDirectoryOffset,
    eocd,
    eocdOffset,
    signingBlock,
    signingBlockOffset,
  });
}

function findV2Signer(signingBlock, role) {
  const end = signingBlock.length - 24;
  let offset = 8;
  let scheme = null;
  while (offset < end) {
    const pairSize = readUint64(signingBlock, offset, `${role}.apk signing block pair`);
    offset += 8;
    if (pairSize < 4 || pairSize > end - offset) fail(`${role}.apk signing block pair has an invalid size`);
    const id = signingBlock.readUInt32LE(offset);
    const value = signingBlock.subarray(offset + 4, offset + pairSize);
    if (id === APK_SIGNATURE_SCHEME_V3_ID || id === APK_SIGNATURE_SCHEME_V31_ID) {
      fail(`${role}.apk contains an unsupported higher APK signature scheme`);
    }
    if (id === APK_SIGNATURE_SCHEME_V2_ID) {
      if (scheme !== null) fail(`${role}.apk has duplicate APK Signature Scheme v2 blocks`);
      scheme = value;
    }
    offset += pairSize;
  }
  if (offset !== end || scheme === null) fail(`${role}.apk has no APK Signature Scheme v2 signer`);
  const outer = { offset: 0 };
  const signers = lengthPrefixedSequence(lengthPrefixed(scheme, outer, `${role}.apk v2 signers`), `${role}.apk v2 signer`);
  if (outer.offset !== scheme.length || signers.length !== 1) {
    fail(`${role}.apk must have exactly one APK Signature Scheme v2 signer`);
  }
  return signers[0];
}

function parseSigner(signer, role, expectedSigner) {
  const cursor = { offset: 0 };
  const signedData = lengthPrefixed(signer, cursor, `${role}.apk signed data`);
  const signaturesSource = lengthPrefixed(signer, cursor, `${role}.apk signatures`);
  const publicKey = lengthPrefixed(signer, cursor, `${role}.apk public key`);
  if (cursor.offset !== signer.length) fail(`${role}.apk signer has trailing data`);

  const signedCursor = { offset: 0 };
  const digestsSource = lengthPrefixed(signedData, signedCursor, `${role}.apk content digests`);
  const certificatesSource = lengthPrefixed(signedData, signedCursor, `${role}.apk certificates`);
  const attributesSource = lengthPrefixed(signedData, signedCursor, `${role}.apk signer attributes`);
  if (signedCursor.offset < signedData.length) {
    const extension = lengthPrefixed(signedData, signedCursor, `${role}.apk signed-data extension`);
    if (extension.length !== 0) fail(`${role}.apk has an unsupported signed-data extension`);
  }
  if (signedCursor.offset !== signedData.length) fail(`${role}.apk signed data has trailing bytes`);
  for (const attribute of lengthPrefixedSequence(attributesSource, `${role}.apk signer attribute`)) {
    if (attribute.length < 4) fail(`${role}.apk signer attribute is truncated`);
    const id = attribute.readUInt32LE(0);
    if (id === V2_STRIPPING_PROTECTION_ATTRIBUTE_ID) {
      if (attribute.length !== 8) fail(`${role}.apk stripping-protection attribute is malformed`);
      const protectedScheme = attribute.readUInt32LE(4);
      fail(`${role}.apk requires unsupported APK signature scheme ${protectedScheme}`);
    }
  }
  const certificates = lengthPrefixedSequence(certificatesSource, `${role}.apk certificate`);
  if (certificates.length !== 1) fail(`${role}.apk signer must contain exactly one certificate`);
  const signerSha256 = createHash("sha256").update(certificates[0]).digest("hex");
  if (signerSha256 !== expectedSigner) fail(`${role}.apk signer certificate is not approved`);
  let certificate;
  try {
    certificate = new X509Certificate(certificates[0]);
  } catch {
    fail(`${role}.apk signer certificate is invalid`);
  }
  const certificateKey = certificate.publicKey.export({ format: "der", type: "spki" });
  if (!certificateKey.equals(publicKey)) fail(`${role}.apk signer public key does not match its certificate`);

  const parseRecords = (source, name) => {
    const records = new Map();
    const algorithms = [];
    for (const record of lengthPrefixedSequence(source, `${role}.apk ${name}`)) {
      if (record.length < 8) fail(`${role}.apk ${name} record is truncated`);
      const algorithm = record.readUInt32LE(0);
      if (!SIGNATURE_ALGORITHMS.has(algorithm)) fail(`${role}.apk uses an unsupported signature algorithm`);
      const valueCursor = { offset: 4 };
      const value = lengthPrefixed(record, valueCursor, `${role}.apk ${name} value`);
      if (valueCursor.offset !== record.length || records.has(algorithm)) {
        fail(`${role}.apk ${name} records are ambiguous`);
      }
      records.set(algorithm, value);
      algorithms.push(algorithm);
    }
    if (records.size === 0) fail(`${role}.apk has no supported ${name}`);
    return Object.freeze({ algorithms: Object.freeze(algorithms), records });
  };
  const signatures = parseRecords(signaturesSource, "signatures");
  const digests = parseRecords(digestsSource, "content digests");
  if (signatures.algorithms.length !== digests.algorithms.length ||
      signatures.algorithms.some((algorithm, index) => algorithm !== digests.algorithms[index])) {
    fail(`${role}.apk signature and content-digest algorithms disagree`);
  }
  for (const [algorithm, signature] of signatures.records) {
    const parameters = SIGNATURE_ALGORITHMS.get(algorithm);
    const key = parameters.padding === undefined
      ? certificate.publicKey
      : { key: certificate.publicKey, padding: parameters.padding, saltLength: parameters.saltLength };
    if (!verifySignature(parameters.digest, signedData, key, signature)) {
      fail(`${role}.apk cryptographic signature is invalid`);
    }
  }
  return Object.freeze({ digests: digests.records, signerSha256 });
}

async function chunkDigest(descriptor, section, algorithm, chunks) {
  for (let position = section.start; position < section.end; position += APK_CONTENT_CHUNK_BYTES) {
    const length = Math.min(APK_CONTENT_CHUNK_BYTES, section.end - position);
    const bytes = section.buffer === undefined
      ? await readExactly(descriptor, length, position, "APK content chunk")
      : section.buffer.subarray(position, position + length);
    const header = Buffer.alloc(5);
    header[0] = 0xa5;
    header.writeUInt32LE(length, 1);
    chunks.push(createHash(algorithm).update(header).update(bytes).digest());
  }
}

async function apkContentDigest(descriptor, sections, algorithm) {
  const chunks = [];
  for (const section of sections) await chunkDigest(descriptor, section, algorithm, chunks);
  const header = Buffer.alloc(5);
  header[0] = 0x5a;
  header.writeUInt32LE(chunks.length, 1);
  return createHash(algorithm).update(header).update(Buffer.concat(chunks)).digest();
}

export async function verifyAndroidApkSignature({ filename, role = "artifact", expectedSigner }) {
  if (!/^[0-9a-f]{64}$/u.test(expectedSigner)) fail("expected APK signer fingerprint is invalid");
  const descriptor = await open(filename, "r");
  try {
    const metadata = await descriptor.stat();
    if (!metadata.isFile()) fail(`${role}.apk is not a regular file`);
    const sections = await findApkSections(descriptor, metadata.size, role);
    const signer = parseSigner(findV2Signer(sections.signingBlock, role), role, expectedSigner);
    const patchedEocd = Buffer.from(sections.eocd);
    if (sections.signingBlockOffset > 0xffff_ffff) fail(`${role}.apk signing block offset exceeds ZIP32`);
    patchedEocd.writeUInt32LE(sections.signingBlockOffset, 16);
    const contentSections = [
      { start: 0, end: sections.signingBlockOffset },
      { start: sections.centralDirectoryOffset, end: sections.eocdOffset },
      { start: 0, end: patchedEocd.length, buffer: patchedEocd },
    ];
    const computed = new Map();
    for (const [algorithm, expected] of signer.digests) {
      const digestAlgorithm = SIGNATURE_ALGORITHMS.get(algorithm).digest;
      let actual = computed.get(digestAlgorithm);
      if (actual === undefined) {
        actual = await apkContentDigest(descriptor, contentSections, digestAlgorithm);
        computed.set(digestAlgorithm, actual);
      }
      if (!actual.equals(expected)) fail(`${role}.apk signed content digest does not match`);
    }
    return Object.freeze({ scheme: "v2", signerSha256: signer.signerSha256 });
  } finally {
    await descriptor.close();
  }
}

async function verifyApk(filename, artifact, expectedSigner) {
  const metadata = await lstat(filename);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== artifact.size) {
    fail(`${artifact.role}.apk does not match its manifest size`);
  }
  if ((await sha256File(filename)) !== artifact.sha256) {
    fail(`${artifact.role}.apk does not match its manifest digest`);
  }
  await verifyAndroidApkSignature({
    filename,
    role: artifact.role,
    expectedSigner,
  });
}

async function atomicWrite(filename, contents, mode = 0o600) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, contents, { mode, flag: "wx" });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function verifyExtracted(directory, archiveVersion, expectedSigner) {
  const entries = (await readdir(directory)).sort();
  const expected = [
    "manifest.json",
    "receipts.json",
    ...PIN_RELEASE_ARTIFACT_ROLES.map((role) => `${role}.apk`),
  ].sort();
  if (entries.join("\0") !== expected.join("\0")) fail("extracted Pin release has an unexpected layout");
  for (const name of entries) {
    const metadata = await lstat(join(directory, name));
    if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`Pin release member is not a regular file: ${name}`);
  }

  const manifestSource = await readFile(join(directory, "manifest.json"), "utf8");
  const manifest = parseCanonicalPinReleaseManifestDocument(manifestSource);
  if (manifest.version !== archiveVersion) fail("archive name and Pin release version disagree");
  const receiptsSource = await readFile(join(directory, "receipts.json"), "utf8");
  const receipts = parsePinReleaseReceiptBundle(
    parsePinReleaseJson(receiptsSource, "Pin release receipts"),
  );
  for (const receipt of receipts.artifacts) {
    if (receipt.path !== receipt.name) fail(`${receipt.role} receipt path must be exactly ${receipt.name}`);
  }
  const evidence = verifyPinReleaseMetadata({
    manifest,
    receipts,
    expectedSigner,
  });
  for (const artifact of manifest.artifacts) {
    await verifyApk(join(directory, artifact.name), artifact, expectedSigner);
  }
  return Object.freeze({
    manifest,
    manifestSource,
    receiptsSource,
    signerSha256: evidence.signerSha256,
    manifestSha256: evidence.manifestSha256,
  });
}

async function validateArchiveFile(archive) {
  const selectedArchive = resolve(archive);
  const archiveMetadata = await lstat(selectedArchive).catch((error) => {
    if (error?.code === "ENOENT") fail(`Pin release archive does not exist: ${selectedArchive}`);
    throw error;
  });
  if (archiveMetadata.isSymbolicLink() || !archiveMetadata.isFile() ||
      archiveMetadata.size < 1 || archiveMetadata.size > MAX_ARCHIVE_BYTES) {
    fail("Pin release archive must be a nonempty regular file no larger than 3 GiB");
  }
  return Object.freeze({ selectedArchive, archiveMetadata });
}

export async function describePinReleaseArchive({
  archive,
  expectedSigner = PIN_COMPATIBILITY_CERT_SHA256,
}) {
  const { selectedArchive, archiveMetadata } = await validateArchiveFile(archive);
  const layout = inspectArchive(selectedArchive);
  const staging = await mkdtemp(join(tmpdir(), "ai-pin-revival-pin-inspect-"));
  try {
    runTar([
      "--extract", "--gzip", "--file", selectedArchive,
      "--directory", staging,
      "--no-same-owner", "--no-same-permissions",
    ]);
    const verified = await verifyExtracted(
      join(staging, layout.directory),
      layout.version,
      expectedSigner,
    );
    return Object.freeze({
      schemaVersion: 1,
      archive: basename(selectedArchive),
      sha256: await sha256File(selectedArchive),
      size: archiveMetadata.size,
      releaseId: verified.manifest.releaseId,
      version: verified.manifest.version,
      versionCode: verified.manifest.artifacts[0].versionCode,
      signerSha256: verified.signerSha256,
      manifestSha256: verified.manifestSha256,
      receiptsSha256: createHash("sha256").update(verified.receiptsSource).digest("hex"),
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function verifyPublished(directory, manifestSource, manifest, expectedSigner) {
  const entries = (await readdir(directory)).sort();
  const expected = ["manifest.json", ...manifest.artifacts.map(({ name }) => name)].sort();
  const manifestPath = join(directory, "manifest.json");
  const manifestMetadata = await lstat(manifestPath);
  if (entries.join("\0") !== expected.join("\0") ||
      manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile() ||
      (await readFile(manifestPath, "utf8")) !== manifestSource) {
    fail("an existing release conflicts with the imported release identity");
  }
  for (const artifact of manifest.artifacts) {
    await verifyApk(join(directory, artifact.name), artifact, expectedSigner);
  }
}

async function lockOwner(lock) {
  try { return JSON.parse(await readFile(join(lock, "owner.json"), "utf8")); } catch { return null; }
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function acquireImportLock(root) {
  const lock = join(root, ".import-lock");
  const token = randomBytes(16).toString("hex");
  const deadline = Date.now() + IMPORT_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, token })}\n`, {
        mode: 0o400,
        flag: "wx",
      });
      return Object.freeze({ lock, token });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        await rm(lock, { recursive: true, force: true });
        throw error;
      }
    }
    const metadata = await lstat(lock).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!metadata) continue;
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail("Pin release import lock is unsafe");
    const owner = await lockOwner(lock);
    if ((!owner && Date.now() - metadata.mtimeMs >= 5_000) || (owner && !processExists(owner.pid))) {
      const abandoned = join(root, `.abandoned-import-${randomBytes(8).toString("hex")}`);
      try {
        await rename(lock, abandoned);
        await rm(abandoned, { recursive: true, force: true });
        continue;
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
    }
    if (Date.now() >= deadline) fail("timed out waiting for Pin release import lock");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

async function releaseImportLock({ lock, token }) {
  const owner = await lockOwner(lock);
  if (owner?.pid === process.pid && owner?.token === token) {
    await rm(lock, { recursive: true, force: true });
  }
}

async function assertImportMayPublish(root, manifest) {
  const currentPath = join(root, "current.json");
  const currentMetadata = await lstat(currentPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!currentMetadata) return "new";
  if (currentMetadata.isSymbolicLink() || !currentMetadata.isFile()) {
    fail("current Pin release pointer is unsafe");
  }
  const current = await validateReleaseStore(root);
  if (current.releaseId === manifest.releaseId) return "same";
  const order = compareInstallVersions(current.version, manifest.version);
  if (order >= 0) {
    fail(
      `refusing to replace current Pin release ${current.version} (${current.releaseId}) with ` +
      `${manifest.version} (${manifest.releaseId})`,
    );
  }
  return "upgrade";
}

export async function importPinRelease({
  archive,
  releaseRoot = canonicalPinReleaseRoot(),
  expectedSigner = PIN_COMPATIBILITY_CERT_SHA256,
}) {
  const { selectedArchive } = await validateArchiveFile(archive);
  const layout = inspectArchive(selectedArchive);
  const root = resolve(releaseRoot);
  await mkdir(root, { recursive: true, mode: 0o755 });
  await chmod(root, 0o755);
  const staging = await mkdtemp(join(root, ".import-"));
  try {
    runTar([
      "--extract", "--gzip", "--file", selectedArchive,
      "--directory", staging,
      "--no-same-owner", "--no-same-permissions",
    ]);
    const extracted = join(staging, layout.directory);
    const { manifest, manifestSource } = await verifyExtracted(
      extracted,
      layout.version,
      expectedSigner,
    );
    const importLock = await acquireImportLock(root);
    try {
      const publication = await assertImportMayPublish(root, manifest);
      if (publication === "same") {
        return Object.freeze({
          schemaVersion: 1,
          version: manifest.version,
          releaseId: manifest.releaseId,
          releaseRoot: root,
        });
      }
    const releases = join(root, "releases");
    await mkdir(releases, { recursive: true, mode: 0o755 });
    await chmod(releases, 0o755);
    const destination = join(releases, manifest.releaseId);
    const existing = await lstat(destination).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) fail("release destination is not a real directory");
      await verifyPublished(destination, manifestSource, manifest, expectedSigner);
      for (const artifact of manifest.artifacts) await chmod(join(destination, artifact.name), 0o444);
      await chmod(join(destination, "manifest.json"), 0o444);
      await chmod(destination, 0o755);
    } else {
      const incoming = await mkdtemp(join(releases, `.${manifest.releaseId}.`));
      try {
        await chmod(incoming, 0o700);
        for (const artifact of manifest.artifacts) {
          const target = join(incoming, artifact.name);
          await copyFile(join(extracted, artifact.name), target);
          await chmod(target, 0o444);
        }
        const manifestPath = join(incoming, "manifest.json");
        await writeFile(manifestPath, manifestSource, { mode: 0o444, flag: "wx" });
        await chmod(manifestPath, 0o444);
        await chmod(incoming, 0o755);
        await rename(incoming, destination);
      } catch (error) {
        await rm(incoming, { recursive: true, force: true });
        throw error;
      }
    }
    await atomicWrite(join(root, "current.json"), canonicalPinReleaseManifestJson(manifest));
    await chmod(join(root, "current.json"), 0o444);
    for (const entry of await readdir(releases)) {
      if (entry !== manifest.releaseId) await rm(join(releases, entry), { recursive: true, force: true });
    }
    return Object.freeze({
      schemaVersion: 1,
      version: manifest.version,
      releaseId: manifest.releaseId,
      releaseRoot: root,
    });
    } finally {
      await releaseImportLock(importLock);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
