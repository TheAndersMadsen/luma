import assert from "node:assert/strict";
import test from "node:test";

process.env.KEYCLOAK_BASE_URL = "https://keycloak.test";
process.env.KEYCLOAK_CLIENT_ID = "center-test";
process.env.AUTH_SESSION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.COSMOS_OPERATOR_EMAILS = "bootstrap@example.com, second@example.com";

const {
  isOperatorPath,
  isSameOriginRequest,
  operatorClaimFromKeycloakClaims,
  signSession,
  verifySession,
} = await import("../src/server/auth.ts?operator-boundary-test");

function jwtPayload(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

test("realm role, client role, and exact bootstrap email resolve to one operator bit", () => {
  assert.equal(
    operatorClaimFromKeycloakClaims({ realm_access: { roles: ["carry-operator"] } }, "wearer@example.com"),
    true,
  );
  assert.equal(
    operatorClaimFromKeycloakClaims(
      { resource_access: { "center-test": { roles: ["carry-operator"] } } },
      "wearer@example.com",
    ),
    true,
  );
  assert.equal(operatorClaimFromKeycloakClaims({}, "BOOTSTRAP@example.com"), true);
  assert.equal(operatorClaimFromKeycloakClaims({}, "bootstrap@example.com.evil"), false);
  assert.equal(
    operatorClaimFromKeycloakClaims({ resource_access: { other: { roles: ["carry-operator"] } } }, "wearer@example.com"),
    false,
  );
  assert.equal(
    operatorClaimFromKeycloakClaims({ realm_access: { roles: ["cosmos-operator"] } }, "wearer@example.com"),
    false,
    "a new logical namespace must not replace the deployed Keycloak role",
  );
});

test("signed session stores only the boolean authorization decision", async () => {
  const token = await signSession({
    sub: "wearer-1",
    email: "operator@example.com",
    name: "Operator",
    operator: true,
  });
  const payload = jwtPayload(token);

  assert.equal(payload.operator, true);
  assert.equal("realm_access" in payload, false);
  assert.equal("resource_access" in payload, false);
  assert.deepEqual(await verifySession(token), {
    sub: "wearer-1",
    email: "operator@example.com",
    name: "Operator",
    operator: true,
  });
});

test("source-visible local signing key can never unlock the operator plane", async () => {
  const priorBase = process.env.KEYCLOAK_BASE_URL;
  const priorSecret = process.env.AUTH_SESSION_SECRET;
  delete process.env.KEYCLOAK_BASE_URL;
  delete process.env.AUTH_SESSION_SECRET;
  try {
    const localAuth = await import("../src/server/auth.ts?operator-local-default-deny");
    const token = await localAuth.signSession({
      sub: "local",
      email: "bootstrap@example.com",
      name: "Local",
      operator: true,
    });
    assert.equal((await localAuth.verifySession(token))?.operator, false);
  } finally {
    process.env.KEYCLOAK_BASE_URL = priorBase;
    process.env.AUTH_SESSION_SECRET = priorSecret;
  }
});

test("operator route classification is narrow and includes every admin surface", () => {
  for (const pathname of ["/admin", "/admin/", "/admin/setup", "/api/admin", "/api/admin/flags"]) {
    assert.equal(isOperatorPath(pathname), true, pathname);
  }
  for (const pathname of ["/", "/captures", "/api/adminish", "/api/capture/memories"]) {
    assert.equal(isOperatorPath(pathname), false, pathname);
  }
});

test("admin mutation origin validation honors the public forwarded origin and fails closed", () => {
  const sameOrigin = new Request("http://center:4000/api/admin/provision", {
    method: "POST",
    headers: {
      origin: "https://cosmos.example.test",
      "x-forwarded-host": "cosmos.example.test",
      "x-forwarded-proto": "https",
    },
  });
  assert.equal(isSameOriginRequest(sameOrigin), true);

  const crossOrigin = new Request("https://cosmos.example.test/api/admin/provision", {
    method: "POST",
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(isSameOriginRequest(crossOrigin), false);
  assert.equal(
    isSameOriginRequest(new Request("https://cosmos.example.test/api/admin/provision", { method: "POST" })),
    false,
  );
});
