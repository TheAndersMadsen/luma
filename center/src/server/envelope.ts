/*
 * The Krypton ciphertext envelope, in TypeScript.
 *
 * This is the format the Pin actually speaks, so producing and reading it is what
 * lets the dashboard show real note text and real capture frames instead of
 * "sealed". Specified by `contracts/wire/cosmos_ciphertext.fbs` and confirmed
 * against the decompiled client:
 *
 *   payload AEAD  AES-128-GCM, 12-byte random IV, 16-byte tag kept SEPARATE
 *                 from the ciphertext (never concatenated)
 *   key transport RSA-OAEP with SHA-1/MGF1 — the client's
 *                 RSA/ECB/OAEPWithSHA1AndMGF1Padding
 *   wire format   FlatBuffer table CiphertextEnvelope{kid, algo, aad, iv,
 *                 authTag, ciphertext}, finished WITH the "HMCT" file
 *                 identifier at bytes [4..8)
 *
 * Field order is vtable slot order and is load-bearing; so is the file
 * identifier. A buffer finished without it is not what the client produces.
 */

import * as crypto from "node:crypto";
import * as flatbuffers from "flatbuffers";

export const NONCE_LEN = 12;
export const TAG_LEN = 16;
export const AES_KEY_LEN = 16; // AES-128, not 256 — the client creates a 16-byte key

/** The envelope-specific algorithm subset, not the general key ALGO enum. */
export const ALGO_AES_GCM = 0;
export const ALGO_RSA_OAEP = 2;

const FILE_IDENTIFIER = "HMCT";

/* ------------------------------------------------------------ FlatBuffer -- */

/**
 * Minimal table reader. Hand-rolled rather than pulled from generated code so
 * the layout stays visible next to the schema it implements.
 */
class Table {
  private readonly buf: Buffer;
  private readonly pos: number;

  constructor(buf: Buffer, pos: number) {
    this.buf = buf;
    this.pos = pos;
  }

  static root(buf: Buffer): Table {
    return new Table(buf, buf.readUInt32LE(0));
  }

  /** Byte offset of field `slot`, or 0 when the writer omitted it. */
  private fieldOffset(slot: number): number {
    const vtable = this.pos - this.buf.readInt32LE(this.pos);
    const vtableSize = this.buf.readUInt16LE(vtable);
    const index = 4 + slot * 2;
    if (index >= vtableSize) return 0;
    return this.buf.readUInt16LE(vtable + index);
  }

  vector(slot: number): Buffer {
    const off = this.fieldOffset(slot);
    if (off === 0) return Buffer.alloc(0);
    const at = this.pos + off;
    const start = at + this.buf.readUInt32LE(at);
    const length = this.buf.readUInt32LE(start);
    return this.buf.subarray(start + 4, start + 4 + length);
  }

  int8(slot: number, fallback = 0): number {
    const off = this.fieldOffset(slot);
    return off === 0 ? fallback : this.buf.readInt8(this.pos + off);
  }
}

export interface Envelope {
  kid: string;
  algo: number;
  aad: Buffer;
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

export function decodeEnvelope(data: Buffer): Envelope {
  if (data.length < 8) throw new Error("envelope too short");
  const identifier = data.subarray(4, 8).toString("latin1");
  if (identifier !== FILE_IDENTIFIER) {
    throw new Error(`envelope file identifier is ${JSON.stringify(identifier)}, want HMCT`);
  }
  const t = Table.root(data);
  return {
    kid: t.vector(0).toString("utf8"),
    algo: t.int8(1, ALGO_AES_GCM),
    aad: t.vector(2),
    iv: t.vector(3),
    authTag: t.vector(4),
    ciphertext: t.vector(5),
  };
}

export function encodeEnvelope(env: {
  kid: string;
  aad: Buffer;
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}): Buffer {
  const b = new flatbuffers.Builder(env.ciphertext.length + 256);
  const kid = b.createByteVector(Buffer.from(env.kid, "utf8"));
  const aad = b.createByteVector(env.aad);
  const iv = b.createByteVector(env.iv);
  const tag = b.createByteVector(env.authTag);
  const ct = b.createByteVector(env.ciphertext);

  b.startObject(6);
  b.addFieldOffset(0, kid, 0);
  // AES_GCM is 0, i.e. the default, so FlatBuffers omits it — exactly as the
  // Rust builder does. Readers fall back to AES_GCM.
  b.addFieldInt8(1, ALGO_AES_GCM, 0);
  b.addFieldOffset(2, aad, 0);
  b.addFieldOffset(3, iv, 0);
  b.addFieldOffset(4, tag, 0);
  b.addFieldOffset(5, ct, 0);
  b.finish(b.endObject(), FILE_IDENTIFIER);

  return Buffer.from(b.asUint8Array());
}

/* ------------------------------------------------------------------ AEAD -- */

/** Seal a plaintext under a channel key. Returns the serialized envelope. */
export function seal(kid: string, key: Buffer, plaintext: Buffer, aad: Buffer = Buffer.alloc(0)): Buffer {
  if (key.length !== AES_KEY_LEN) throw new Error(`key must be ${AES_KEY_LEN} bytes, got ${key.length}`);
  const iv = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv("aes-128-gcm", key, iv, { authTagLength: TAG_LEN });
  if (aad.length > 0) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return encodeEnvelope({ kid, aad, iv, authTag: cipher.getAuthTag(), ciphertext });
}

/** Open an envelope with the channel key named by its kid. */
export function open(key: Buffer, data: Buffer): Buffer {
  const env = decodeEnvelope(data);
  if (env.algo !== ALGO_AES_GCM) throw new Error(`unsupported envelope algo ${env.algo}`);
  const decipher = crypto.createDecipheriv("aes-128-gcm", key, env.iv, { authTagLength: TAG_LEN });
  if (env.aad.length > 0) decipher.setAAD(env.aad);
  decipher.setAuthTag(env.authTag);
  return Buffer.concat([decipher.update(env.ciphertext), decipher.final()]);
}

/* ------------------------------------------------------------ key wrap ---- */

/**
 * RSA-OAEP-wrap a channel key to the server's public key.
 * SHA-1 is not a choice — it is what the client's
 * `RSA/ECB/OAEPWithSHA1AndMGF1Padding` uses, and the server unwraps with the same.
 */
export function wrapChannelKey(serverPublicDer: Buffer, channelKey: Buffer): Buffer {
  const publicKey = crypto.createPublicKey({ key: serverPublicDer, format: "der", type: "spki" });
  return crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    channelKey,
  );
}

export function generateChannelKey(): Buffer {
  return crypto.randomBytes(AES_KEY_LEN);
}
