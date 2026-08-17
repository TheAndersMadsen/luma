import assert from "node:assert/strict";
import test from "node:test";

process.env.KEYCLOAK_BASE_URL = "https://keycloak.test";
process.env.KEYCLOAK_CLIENT_ID = "center-test";
process.env.AUTH_SESSION_SECRET = "0123456789abcdef0123456789abcdef";

const { refreshTokens } = await import("../src/server/auth.ts?refresh-flight-test");

test("concurrent requests share one rotating refresh-token exchange", async (t) => {
  const originalFetch = globalThis.fetch;
  let exchanges = 0;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_url, init) => {
    exchanges += 1;
    assert.match(String(init?.body), /refresh_token=shared-refresh-token/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return Response.json({
      access_token: "fresh-access-token",
      refresh_token: "rotated-refresh-token",
      expires_in: 300,
    });
  };

  const results = await Promise.all([
    refreshTokens("shared-refresh-token"),
    refreshTokens("shared-refresh-token"),
    refreshTokens("shared-refresh-token"),
  ]);

  assert.equal(exchanges, 1);
  assert.deepEqual(results.map((result) => result?.accessToken), [
    "fresh-access-token",
    "fresh-access-token",
    "fresh-access-token",
  ]);
  assert.deepEqual(results.map((result) => result?.refreshToken), [
    "rotated-refresh-token",
    "rotated-refresh-token",
    "rotated-refresh-token",
  ]);
});
