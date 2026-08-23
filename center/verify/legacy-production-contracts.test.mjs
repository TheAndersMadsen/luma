import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EncryptJWT, jwtDecrypt, SignJWT } from "jose";

const AUTH_SECRET = "auth-fixture-".repeat(4);
const SHARE_SECRET = "share-fixture-".repeat(4);

// Configuration names are logically Cosmos. The values below are deliberately
// set before importing auth.ts because its authority snapshot is module-scoped.
process.env.KEYCLOAK_BASE_URL = "https://keycloak.test";
process.env.KEYCLOAK_CLIENT_ID = "center-test";
process.env.AUTH_SESSION_SECRET = AUTH_SECRET;
process.env.COSMOS_OPERATOR_EMAILS = "";
process.env.COSMOS_SHARE_TOKEN_SECRET = SHARE_SECRET;

const {
  SESSION_COOKIE,
  TOKENS_COOKIE,
  openTokens,
  readTokenCookie,
  sealTokens,
  setTokenCookies,
  verifySession,
} = await import("../src/server/auth.ts?legacy-production-contracts");
const {
  mintShareToken,
  verifyShareToken,
} = await import("../src/server/shareToken.ts?legacy-production-contracts");

const shareKey = new Uint8Array(createHash("sha256").update(SHARE_SECRET, "utf8").digest());
const authTokenKey = new Uint8Array(createHash("sha256").update(AUTH_SECRET, "utf8").digest());

test("pre-rename session and token cookies remain readable without a new namespace", async () => {
  assert.equal(SESSION_COOKIE, "carry_session");
  assert.equal(TOKENS_COOKIE, "carry_tokens");

  const session = {
    sub: "wearer-before-rename",
    email: "wearer@example.test",
    name: "Existing Wearer",
    operator: false,
  };
  // Construct the frozen pre-rename wire shape independently of auth.ts. If
  // current issuance and verification drift together, this fixture still fails.
  const signed = await new SignJWT({
    email: session.email,
    name: session.name,
    operator: session.operator,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.sub)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(AUTH_SECRET));
  const browserCookies = new Map([["carry_session", { value: signed }]]);
  assert.deepEqual(
    await verifySession(browserCookies.get(SESSION_COOKIE)?.value),
    session,
  );
  assert.equal(browserCookies.has("cosmos_session"), false);

  const bearerSet = {
    accessToken: "existing-access-token",
    refreshToken: "existing-refresh-token",
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    idToken: "existing-id-token",
  };
  const sealed = await new EncryptJWT({
    at: bearerSet.accessToken,
    rt: bearerSet.refreshToken,
    ea: bearerSet.expiresAt,
    it: bearerSet.idToken,
  })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .encrypt(authTokenKey);
  const tokenCookies = new Map([["carry_tokens", { value: sealed }]]);
  assert.equal(readTokenCookie({ get: (name) => tokenCookies.get(name) }), sealed);
  assert.deepEqual(await openTokens(sealed), bearerSet);
  assert.equal(tokenCookies.has("cosmos_tokens"), false);
});

test("new bearer-cookie issuance uses only the rollback-compatible legacy names", async () => {
  const writes = [];
  const sealed = await sealTokens({
    accessToken: "new-access-token",
    refreshToken: "new-refresh-token",
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  });
  setTokenCookies({
    set(name, value, options) {
      writes.push({ name, value, options });
    },
  }, sealed, { httpOnly: true, path: "/" });

  assert.ok(writes.length >= 2);
  assert.ok(writes.every(({ name }) => /^carry_tokens(?:\.\d+)?$/u.test(name)));
  assert.equal(writes.some(({ name }) => name.startsWith("cosmos_tokens")), false);
});

test("a legacy predecessor share capability remains accepted", async () => {
  const token = await new EncryptJWT({
    memoryUuid: "memory-before-rename",
    userId: "wearer-before-rename",
  })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "carry-share+jwe" })
    .setIssuer("humane-carry-clone:center")
    .setAudience("humane-carry-clone:public-share")
    .setJti("pre-rename-share")
    .setIssuedAt()
    .setExpirationTime("1h")
    .encrypt(shareKey);

  assert.deepEqual(await verifyShareToken(token), {
    memoryUuid: "memory-before-rename",
    userId: "wearer-before-rename",
  });
});

test("new share capabilities keep the legacy issuer, audience, and type", async () => {
  const token = await mintShareToken("memory-after-upgrade", "wearer-after-upgrade");
  const { payload, protectedHeader } = await jwtDecrypt(token, shareKey);

  assert.equal(protectedHeader.typ, "carry-share+jwe");
  assert.equal(payload.iss, "humane-carry-clone:center");
  assert.equal(payload.aud, "humane-carry-clone:public-share");
  assert.equal(payload.memoryUuid, "memory-after-upgrade");
  assert.equal(payload.userId, "wearer-after-upgrade");
});

test("admin flag delivery observes the Cosmos metric series", async () => {
  const source = await readFile(
    new URL("../src/app/api/admin/flags/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /\/manage\/metrics\/cosmos_rpc_requests_total/u);
  assert.doesNotMatch(source, /\/manage\/metrics\/carry_rpc_requests_total/u);
});
