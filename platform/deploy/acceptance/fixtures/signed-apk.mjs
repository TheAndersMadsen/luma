import { spawnSync } from "node:child_process";
import {
  X509Certificate,
  constants as cryptoConstants,
  createHash,
  createPrivateKey,
  sign,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const V2_BLOCK_ID = 0x7109_871a;
const RSA_PKCS1_SHA256_ID = 0x0103;
const RSA_PKCS1_SHA512_ID = 0x0104;
const STRIPPING_PROTECTION_ATTRIBUTE_ID = 0xbeef_f00d;
const MAGIC = Buffer.from("APK Sig Block 42", "ascii");
const ALGORITHMS = new Map([
  [RSA_PKCS1_SHA256_ID, "sha256"],
  [RSA_PKCS1_SHA512_ID, "sha512"],
]);

function openssl(args) {
  const result = spawnSync("openssl", args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.error?.message || "openssl failed");
  }
}

function uint32(value) {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
}

function uint64(value) {
  const result = Buffer.alloc(8);
  result.writeBigUInt64LE(BigInt(value));
  return result;
}

function lengthPrefixed(value) {
  return Buffer.concat([uint32(value.length), value]);
}

function zipSections() {
  const name = Buffer.from("AndroidManifest.xml", "utf8");
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x0403_4b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(name.length, 26);
  const local = Buffer.concat([localHeader, name]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x0201_4b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(name.length, 28);
  const central = Buffer.concat([centralHeader, name]);
  return { local, central };
}

function eocd(centralDirectoryOffset, centralDirectorySize) {
  const result = Buffer.alloc(22);
  result.writeUInt32LE(0x0605_4b50, 0);
  result.writeUInt16LE(1, 8);
  result.writeUInt16LE(1, 10);
  result.writeUInt32LE(centralDirectorySize, 12);
  result.writeUInt32LE(centralDirectoryOffset, 16);
  return result;
}

function apkContentDigest(sections, algorithm) {
  const chunks = sections.map((section) => {
    const header = Buffer.alloc(5);
    header[0] = 0xa5;
    header.writeUInt32LE(section.length, 1);
    return createHash(algorithm).update(header).update(section).digest();
  });
  const header = Buffer.alloc(5);
  header[0] = 0x5a;
  header.writeUInt32LE(chunks.length, 1);
  return createHash(algorithm).update(header).update(Buffer.concat(chunks)).digest();
}

function signingBlock({
  certificate,
  digests,
  privateKey,
  publicKey,
  signatureAlgorithms,
  signatureOrder,
  strippingProtectionScheme,
}) {
  const digestRecords = signatureAlgorithms.map((algorithm) => Buffer.concat([
    uint32(algorithm),
    lengthPrefixed(digests.get(ALGORITHMS.get(algorithm))),
  ]));
  const attributes = strippingProtectionScheme === null
    ? Buffer.alloc(0)
    : lengthPrefixed(Buffer.concat([
      uint32(STRIPPING_PROTECTION_ATTRIBUTE_ID),
      uint32(strippingProtectionScheme),
    ]));
  const signedData = Buffer.concat([
    lengthPrefixed(Buffer.concat(digestRecords.map(lengthPrefixed))),
    lengthPrefixed(lengthPrefixed(certificate)),
    lengthPrefixed(attributes),
  ]);
  const signatureRecords = signatureOrder.map((algorithm) => {
    const signature = sign(ALGORITHMS.get(algorithm), signedData, {
      key: privateKey,
      padding: cryptoConstants.RSA_PKCS1_PADDING,
    });
    return Buffer.concat([uint32(algorithm), lengthPrefixed(signature)]);
  });
  const signer = Buffer.concat([
    lengthPrefixed(signedData),
    lengthPrefixed(Buffer.concat(signatureRecords.map(lengthPrefixed))),
    lengthPrefixed(publicKey),
  ]);
  const value = lengthPrefixed(lengthPrefixed(signer));
  const pair = Buffer.concat([uint64(4 + value.length), uint32(V2_BLOCK_ID), value]);
  const size = pair.length + 24;
  return Buffer.concat([uint64(size), pair, uint64(size), MAGIC]);
}

/**
 * Builds a small, structurally valid ZIP signed with APK Signature Scheme v2.
 * The ephemeral certificate is deliberately not the production compatibility
 * identity. Callers pass signerSha256 explicitly to test-only APIs.
 */
export function createV2SignedApkFixture({
  directory,
  filename = "fixture.apk",
  signatureAlgorithms = [RSA_PKCS1_SHA256_ID],
  signatureOrder = signatureAlgorithms,
  strippingProtectionScheme = null,
}) {
  if (signatureAlgorithms.length < 1 || signatureAlgorithms.some((id) => !ALGORITHMS.has(id)) ||
      signatureOrder.length !== signatureAlgorithms.length ||
      signatureOrder.some((id) => !signatureAlgorithms.includes(id))) {
    throw new Error("fixture signature algorithms are invalid");
  }
  mkdirSync(directory, { recursive: true });
  const keyPath = join(directory, ".fixture-signing-key.pem");
  const certificatePath = join(directory, ".fixture-signing-certificate.pem");
  const certificateDerPath = join(directory, ".fixture-signing-certificate.der");
  openssl([
    "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", keyPath,
  ]);
  openssl([
    "req", "-new", "-x509", "-key", keyPath, "-out", certificatePath,
    "-days", "1", "-sha256", "-subj", "/CN=Luma APK verifier fixture",
  ]);
  openssl(["x509", "-in", certificatePath, "-outform", "DER", "-out", certificateDerPath]);

  const certificate = readFileSync(certificateDerPath);
  const privateKey = createPrivateKey(readFileSync(keyPath));
  const publicKey = new X509Certificate(certificate).publicKey.export({ format: "der", type: "spki" });
  const { local, central } = zipSections();
  const unsignedEocd = eocd(local.length, central.length);
  const digests = new Map([...new Set(signatureAlgorithms.map((id) => ALGORITHMS.get(id)))].map(
    (algorithm) => [algorithm, apkContentDigest([local, central, unsignedEocd], algorithm)],
  ));
  const block = signingBlock({
    certificate,
    digests,
    privateKey,
    publicKey,
    signatureAlgorithms,
    signatureOrder,
    strippingProtectionScheme,
  });
  const bytes = Buffer.concat([
    local,
    block,
    central,
    eocd(local.length + block.length, central.length),
  ]);
  const selected = join(directory, filename);
  writeFileSync(selected, bytes, { mode: 0o600 });
  return Object.freeze({
    bytes,
    filename: selected,
    signerSha256: createHash("sha256").update(certificate).digest("hex"),
  });
}
