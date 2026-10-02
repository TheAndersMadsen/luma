import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

process.env.KEYCLOAK_BASE_URL = "https://keycloak.test";
process.env.KEYCLOAK_CLIENT_ID = "center-test";
process.env.AUTH_SESSION_SECRET = "0123456789abcdef0123456789abcdef";

const { keycloakLogin, loginRefusalResponse } = await import("../src/server/auth.ts?login-refusal-test");

// Keycloak 26.0.8's token endpoint answers, as the pinned image returns them.
const WRONG_PASSWORD = [401, { error: "invalid_grant", error_description: "Invalid user credentials" }];
const PENDING_STEP = [400, { error: "invalid_grant", error_description: "Account is not fully set up" }];

async function refusalFor(t, [status, body]) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => Response.json(body, { status });
  const result = await keycloakLogin({ username: "owner@example.test", password: "p".repeat(32) });
  assert.ok("refused" in result, "a refused grant never becomes a session");
  return loginRefusalResponse(result.refused, "https://center.example.test");
}

test("a wrong password keeps the unchanged credentials answer", async (t) => {
  assert.deepEqual(await refusalFor(t, WRONG_PASSWORD), {
    status: 401,
    error: "Those credentials were not accepted.",
  });
});

test("an account with a pending Keycloak step says how to finish it", async (t) => {
  const { status, error } = await refusalFor(t, PENDING_STEP);
  assert.equal(status, 403);
  assert.doesNotMatch(error, /not accepted/u);
  assert.match(error, /step to finish in Keycloak/u);
  assert.match(error, /https:\/\/center\.example\.test\/realms\/humane\/account/u);
});

test("the login route answers every refusal through the shared mapping", async () => {
  const route = await readFile(new URL("../src/app/api/auth/login/route.ts", import.meta.url), "utf8");
  assert.match(route, /loginRefusalResponse\(result\.refused, origin\)/u);
  assert.doesNotMatch(route, /not accepted/u);
});

test("a Keycloak that does not answer is an outage, never a wrong password", async (t) => {
  for (const [status, body] of [[502, { error: "bad gateway" }], [503, {}]]) {
    assert.deepEqual(await refusalFor(t, [status, body]), {
      status: 503,
      error: "Sign-in is unavailable right now: this server's Keycloak did not answer. Try again in a minute.",
    });
  }
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  const unreachable = await keycloakLogin({ username: "owner@example.test", password: "p".repeat(32) });
  assert.deepEqual(unreachable, { refused: "unavailable" });
});

test("Keycloak refusing Center's own client is never a wrong password", async (t) => {
  // Keycloak 26.0.8: a wrong client secret, an unknown client, direct grants
  // turned off, and an error page that is not OAuth at all.
  for (const answer of [
    [401, { error: "unauthorized_client", error_description: "Invalid client or Invalid client credentials" }],
    [401, { error: "invalid_client", error_description: "Invalid client or Invalid client credentials" }],
    [400, { error: "unauthorized_client", error_description: "Client not allowed for direct access grants" }],
    [404, "Not Found"],
  ]) {
    const { status, error } = await refusalFor(t, answer);
    assert.equal(status, 503, JSON.stringify(answer));
    assert.doesNotMatch(error, /not accepted/u);
    assert.match(error, /refused Center's own sign-in client, not your password/u);
  }
});

test("a token without the account ID is refused at sign-in with the owner's repair", async (t) => {
  const claims = (payload) => `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
  const { status, error } = await refusalFor(t, [200, {
    access_token: claims({ email: "owner@example.test" }),
    id_token: claims({ sub: "id-token-only", email: "owner@example.test" }),
    refresh_token: "refresh",
    expires_in: 300,
  }]);
  assert.equal(status, 503);
  assert.match(error, /leaves the account ID out of its sign-in tokens/u);
  assert.match(error, /\.\/luma deploy production --confirm/u);
});
