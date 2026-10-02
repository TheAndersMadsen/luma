import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { createV2SignedApkFixture } from "./fixtures/signed-apk.mjs";
import {
  describePinReleaseArchive,
  verifyAndroidApkSignature,
} from "../pin/import-release.mjs";

const SIGNING_MAGIC = Buffer.from("APK Sig Block 42", "ascii");

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "luma-apk-signature-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, ...createV2SignedApkFixture({ directory, ...options }) };
}

function signingOffsets(bytes) {
  const magic = bytes.lastIndexOf(SIGNING_MAGIC);
  assert.ok(magic >= 8);
  const footer = magic - 8;
  const blockSize = Number(bytes.readBigUInt64LE(footer));
  const block = footer + 24 - blockSize - 8;
  const pair = block + 8;
  const id = pair + 8;
  const value = id + 4;
  const signerSequence = value + 4;
  const signer = signerSequence + 4;
  const signedDataLength = bytes.readUInt32LE(signer);
  const signatures = signer + 4 + signedDataLength;
  const signatureSequence = signatures + 4;
  const signatureRecord = signatureSequence + 4;
  const algorithm = signatureRecord;
  const signature = signatureRecord + 8;
  return { algorithm, block, id, signature };
}

function withSigningBlockPair(bytes, id) {
  const offsets = signingOffsets(bytes);
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > offsets.block);
  const oldCentralDirectory = bytes.readUInt32LE(eocd + 16);
  const oldPairs = bytes.subarray(offsets.block + 8, oldCentralDirectory - 24);
  const pair = Buffer.alloc(12);
  pair.writeBigUInt64LE(4n);
  pair.writeUInt32LE(id, 8);
  const pairs = Buffer.concat([oldPairs, pair]);
  const size = pairs.length + 24;
  const header = Buffer.alloc(8);
  header.writeBigUInt64LE(BigInt(size));
  const footer = Buffer.alloc(8);
  footer.writeBigUInt64LE(BigInt(size));
  const block = Buffer.concat([header, pairs, footer, SIGNING_MAGIC]);
  const result = Buffer.concat([
    bytes.subarray(0, offsets.block),
    block,
    bytes.subarray(oldCentralDirectory),
  ]);
  const delta = block.length - (oldCentralDirectory - offsets.block);
  result.writeUInt32LE(oldCentralDirectory + delta, eocd + delta + 16);
  return result;
}

test("APK v2 verifier proves the signer and signed content", async (t) => {
  const signed = await fixture(t);
  assert.deepEqual(
    await verifyAndroidApkSignature({
      filename: signed.filename,
      expectedSigner: signed.signerSha256,
    }),
    { scheme: "v2", signerSha256: signed.signerSha256 },
  );
});

test("APK v2 verifier rejects receipt-shaped ZIP bytes and the wrong certificate", async (t) => {
  const signed = await fixture(t);
  const fake = join(signed.directory, "fake.apk");
  await writeFile(fake, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("signed")]));
  await assert.rejects(
    verifyAndroidApkSignature({ filename: fake, expectedSigner: signed.signerSha256 }),
    /ZIP end record/u,
  );
  await assert.rejects(
    verifyAndroidApkSignature({ filename: signed.filename, expectedSigner: "0".repeat(64) }),
    /signer certificate is not approved/u,
  );
});

test("APK v2 verifier rejects signed-content and signature tampering", async (t) => {
  const signed = await fixture(t);
  const contentTampered = Buffer.from(signed.bytes);
  contentTampered[30] ^= 0x01;
  const contentPath = join(signed.directory, "content-tampered.apk");
  await writeFile(contentPath, contentTampered);
  await assert.rejects(
    verifyAndroidApkSignature({ filename: contentPath, expectedSigner: signed.signerSha256 }),
    /signed content digest does not match/u,
  );

  const signatureTampered = Buffer.from(signed.bytes);
  signatureTampered[signingOffsets(signatureTampered).signature] ^= 0x01;
  const signaturePath = join(signed.directory, "signature-tampered.apk");
  await writeFile(signaturePath, signatureTampered);
  await assert.rejects(
    verifyAndroidApkSignature({ filename: signaturePath, expectedSigner: signed.signerSha256 }),
    /cryptographic signature is invalid/u,
  );
});

test("APK v2 verifier fails closed on unsupported schemes and algorithms", async (t) => {
  const signed = await fixture(t);
  const unsupportedScheme = Buffer.from(signed.bytes);
  unsupportedScheme.writeUInt32LE(0x1234_5678, signingOffsets(unsupportedScheme).id);
  const schemePath = join(signed.directory, "unsupported-scheme.apk");
  await writeFile(schemePath, unsupportedScheme);
  await assert.rejects(
    verifyAndroidApkSignature({ filename: schemePath, expectedSigner: signed.signerSha256 }),
    /no APK Signature Scheme v2 signer/u,
  );

  const unsupportedAlgorithm = Buffer.from(signed.bytes);
  unsupportedAlgorithm.writeUInt32LE(0x7777_7777, signingOffsets(unsupportedAlgorithm).algorithm);
  const algorithmPath = join(signed.directory, "unsupported-algorithm.apk");
  await writeFile(algorithmPath, unsupportedAlgorithm);
  await assert.rejects(
    verifyAndroidApkSignature({ filename: algorithmPath, expectedSigner: signed.signerSha256 }),
    /unsupported signature algorithm/u,
  );

  const higherScheme = withSigningBlockPair(signed.bytes, 0xf053_68c0);
  const higherSchemePath = join(signed.directory, "v2-plus-v3.apk");
  await writeFile(higherSchemePath, higherScheme);
  await assert.rejects(
    verifyAndroidApkSignature({ filename: higherSchemePath, expectedSigner: signed.signerSha256 }),
    /unsupported higher APK signature scheme/u,
  );
});

test("APK v2 verifier rejects downgrade markers and reordered algorithm records", async (t) => {
  const downgrade = await fixture(t, { strippingProtectionScheme: 3 });
  await assert.rejects(
    verifyAndroidApkSignature({
      filename: downgrade.filename,
      expectedSigner: downgrade.signerSha256,
    }),
    /requires unsupported APK signature scheme/u,
  );

  const reordered = await fixture(t, {
    filename: "reordered.apk",
    signatureAlgorithms: [0x0103, 0x0104],
    signatureOrder: [0x0104, 0x0103],
  });
  await assert.rejects(
    verifyAndroidApkSignature({
      filename: reordered.filename,
      expectedSigner: reordered.signerSha256,
    }),
    /signature and content-digest algorithms disagree/u,
  );
});

test("a real signed release archive passes all five APK checks", async (t) => {
  const source = process.env.LUMA_TEST_PIN_RELEASE_ARCHIVE;
  if (!source) {
    t.skip("set LUMA_TEST_PIN_RELEASE_ARCHIVE to an existing signed Pin release archive");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "luma-real-pin-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, basename(source));
  await copyFile(source, archive);
  const described = await describePinReleaseArchive({ archive });
  assert.equal(described.archive, basename(source));
  assert.match(described.releaseId, /^[0-9a-f]{64}$/u);
});
