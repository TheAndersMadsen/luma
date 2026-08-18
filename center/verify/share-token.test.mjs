import assert from "node:assert/strict";
import test from "node:test";

import { mintShareToken, verifyShareToken } from "../src/server/shareToken.ts";

const SECRET_A = "0123456789abcdef0123456789abcdef";
const SECRET_B = "fedcba9876543210fedcba9876543210";

test("share capabilities are confidential and round-trip their binding", async () => {
  process.env.COSMOS_SHARE_TOKEN_SECRET = SECRET_A;
  const token = await mintShareToken("memory-private", "wearer-private");

  assert.equal(token.includes("memory-private"), false);
  assert.equal(token.includes("wearer-private"), false);
  assert.deepEqual(await verifyShareToken(token), {
    memoryUuid: "memory-private",
    userId: "wearer-private",
  });
});

test("tampered and wrong-key capabilities fail closed", async () => {
  process.env.COSMOS_SHARE_TOKEN_SECRET = SECRET_A;
  const token = await mintShareToken("memory-1", "wearer-1");
  const last = token.at(-1);
  const tampered = `${token.slice(0, -1)}${last === "A" ? "B" : "A"}`;

  assert.equal(await verifyShareToken(tampered), null);
  process.env.COSMOS_SHARE_TOKEN_SECRET = SECRET_B;
  assert.equal(await verifyShareToken(token), null);
});

test("weak or absent share secrets cannot mint capabilities", async () => {
  delete process.env.COSMOS_SHARE_TOKEN_SECRET;
  await assert.rejects(() => mintShareToken("memory-1", "wearer-1"), /is required/);

  process.env.COSMOS_SHARE_TOKEN_SECRET = "too-short";
  await assert.rejects(() => mintShareToken("memory-1", "wearer-1"), /at least 32 bytes/);
});
