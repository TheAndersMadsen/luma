import { createHash, randomUUID } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";

const SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;
// These claims are embedded in durable public links. Stable legacy issuance is
// required so both the upgraded service and a rolled-back service accept them.
const SHARE_ISSUER = "humane-cosmos-clone:center";
const SHARE_AUDIENCE = "humane-cosmos-clone:public-share";

function isCanonicalCompactJwe(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 5) return false;

  // Compact JWE uses an empty encrypted-key segment for `alg: dir`. Require
  // every other segment to be unpadded canonical Base64URL so alternate text
  // encodings cannot identify the same authenticated bytes.
  return parts.every((part, index) => {
    if (index === 1) return part.length === 0;
    if (!/^[A-Za-z0-9_-]+$/.test(part)) return false;
    return Buffer.from(part, "base64url").toString("base64url") === part;
  });
}

function key(): Uint8Array {
  const secret = process.env.COSMOS_SHARE_TOKEN_SECRET?.trim();
  if (!secret) throw new Error("COSMOS_SHARE_TOKEN_SECRET is required to mint share links");
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("COSMOS_SHARE_TOKEN_SECRET must contain at least 32 bytes");
  }
  // A256GCM requires exactly 256 bits. Hashing also keeps arbitrary operator
  // secret lengths out of jose's key-shape decisions.
  return new Uint8Array(createHash("sha256").update(secret, "utf8").digest());
}

/**
 * Clone-authored public capability: confidential, authenticated, expiring and
 * scoped to one wearer-memory pair. JWE keeps the wearer id and memory UUID out
 * of browser history, referrer logs and copied-link inspection.
 */
export async function mintShareToken(memoryUuid: string, userId: string): Promise<string> {
  return new EncryptJWT({ memoryUuid, userId })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "cosmos-share+jwe" })
    .setIssuer(SHARE_ISSUER)
    .setAudience(SHARE_AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${SHARE_TTL_SECONDS}s`)
    .encrypt(key());
}

export async function verifyShareToken(
  token: string,
): Promise<{ memoryUuid: string; userId: string } | null> {
  try {
    if (!isCanonicalCompactJwe(token)) return null;
    const { payload } = await jwtDecrypt(token, key(), {
      issuer: SHARE_ISSUER,
      audience: SHARE_AUDIENCE,
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    const memoryUuid = payload.memoryUuid;
    const userId = payload.userId;
    return typeof memoryUuid === "string" && memoryUuid.length > 0 &&
      typeof userId === "string" && userId.length > 0
      ? { memoryUuid, userId }
      : null;
  } catch {
    // Public input: invalid and expired tokens are routine 404s, not log events.
    return null;
  }
}
