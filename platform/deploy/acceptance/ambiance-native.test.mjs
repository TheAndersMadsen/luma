import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const contract = JSON.parse(readFileSync(new URL("contracts/ambiance-native.json", root), "utf8"));
const vectors = JSON.parse(readFileSync(new URL(contract.signing.vectors, root), "utf8"));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const uuid = value => Buffer.from(value.replaceAll("-", ""), "hex");
const publicBytes = Buffer.from(vectors.publicKey, "base64url");
const publicKey = createPublicKey({
  format: "jwk",
  key: { kty: "EC", crv: "P-256", x: publicBytes.subarray(1, 33).toString("base64url"), y: publicBytes.subarray(33).toString("base64url") },
});

// Independent Node encoding of the machine contract. Rust tests consume the
// same fixed vectors through the production signing_message/verify functions.
function encodeField(field, vector) {
  const value = field.source ? field.source.split(".").reduce((object, key) => object[key], vector) : field.literal;
  switch (field.encoding) {
    case "utf8": return Buffer.from(value, "utf8");
    case "utf8-u16be": {
      const text = Buffer.from(value, "utf8");
      const length = Buffer.alloc(2);
      length.writeUInt16BE(text.length);
      return Buffer.concat([length, text]);
    }
    case "uuid": return uuid(value);
    case "optional-uuid": return value === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), uuid(value)]);
    case "sha256-hex": return Buffer.from(value, "hex");
    case "base64url-32": return Buffer.from(value, "base64url");
    case "u64be": {
      const bytes = Buffer.alloc(8);
      bytes.writeBigUInt64BE(BigInt(value));
      return bytes;
    }
    case "i64be": {
      const bytes = Buffer.alloc(8);
      bytes.writeBigInt64BE(BigInt(value));
      return bytes;
    }
    default: throw new Error(`Unknown native signing encoding: ${field.encoding}`);
  }
}

for (const vector of vectors.cases) {
  test(`native signing wire vector: ${vector.name}`, () => {
    const fields = contract.signing.fields.map(field => encodeField(field, vector));
    const message = Buffer.concat(fields);
    const signature = Buffer.from(vector.request.signature, "base64url");
    assert.equal(message.toString("hex"), vector.messageHex);
    assert.equal(digest(message), vector.messageSha256);
    assert.equal(digest(publicBytes), vector.challenge.publicKeyFingerprint);
    assert.equal(vector.request.enrollmentId, vector.challenge.enrollmentId);
    assert.equal(vector.request.challengeId, vector.challenge.challengeId);
    assert.equal(vector.request.expectedIncarnation, vector.challenge.currentIncarnation);
    assert.ok(signature.length <= 72);
    assert.equal(signature.toString("base64url"), vector.request.signature);
    assert.equal(verify("sha256", message, publicKey, signature), true);
    // Sign the complete message once, not the digest a second time.
    assert.equal(verify("sha256", Buffer.from(vector.messageSha256, "hex"), publicKey, signature), false);
    assert.ok(Buffer.byteLength(JSON.stringify(vector.request)) <= contract.limits.bodyBytes);
    assert.ok(Buffer.byteLength(JSON.stringify({ challenge: vector.challenge })) <= contract.limits.bodyBytes);

    // Every domain/authority/session field is covered by the actual signature.
    let offset = 0;
    for (const [index, field] of fields.entries()) {
      const changed = Buffer.from(message);
      changed[offset + field.length - 1] ^= 1;
      assert.equal(verify("sha256", changed, publicKey, signature), false, contract.signing.fields[index].source ?? "domain");
      offset += field.length;
    }
  });
}
