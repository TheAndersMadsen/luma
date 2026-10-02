import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  ACCOUNT_FAILURE_LIMIT,
  ADDRESS_FAILURE_LIMIT,
  LOGIN_WINDOW_SECONDS,
  beginLoginAttempt,
  loginThrottle,
  loginThrottleResponse,
  settleLoginAttempt,
} = await import("../src/server/loginThrottle.ts?login-throttle-test");

function wrongPassword(address, account, now) {
  settleLoginAttempt(beginLoginAttempt(address, account, now), "wrong-password");
}

test("an account is held back after five wrong passwords and told how long to wait", () => {
  const start = 1_000_000;
  for (let attempt = 0; attempt < ACCOUNT_FAILURE_LIMIT; attempt += 1) {
    assert.deepEqual(loginThrottle(`198.51.100.${attempt}`, "Owner@Example.test", start + attempt), { allowed: true });
    wrongPassword(`198.51.100.${attempt}`, "owner@example.test", start + attempt);
  }
  // Another address does not reset the account's count, and case does not either.
  const held = loginThrottle("203.0.113.9", "OWNER@example.test ", start + 60_000);
  assert.equal(held.allowed, false);
  assert.equal(held.scope, "account");
  assert.equal(held.retryAfterSeconds, LOGIN_WINDOW_SECONDS - 60);
  const answer = loginThrottleResponse(held);
  assert.equal(answer.status, 429);
  assert.equal(answer.error, "Too many wrong passwords for this account. Wait 14 minutes, then try again.");

  // The first failure ages out of the window, and one more attempt is allowed.
  assert.deepEqual(loginThrottle("203.0.113.9", "owner@example.test", start + LOGIN_WINDOW_SECONDS * 1_000 + 1), {
    allowed: true,
  });
  // A sign-in clears the account's count.
  const later = start + LOGIN_WINDOW_SECONDS * 1_000 + 2;
  settleLoginAttempt(beginLoginAttempt("203.0.113.9", "owner@example.test", later), "signed-in");
  assert.deepEqual(loginThrottle("203.0.113.9", "owner@example.test", later + 1), { allowed: true });
});

test("one address guessing many accounts is held back too", () => {
  const start = 5_000_000;
  for (let attempt = 0; attempt < ADDRESS_FAILURE_LIMIT; attempt += 1) {
    wrongPassword("192.0.2.77", `guess-${attempt}@example.test`, start);
  }
  const held = loginThrottle("192.0.2.77", "someone-new@example.test", start + 30_000);
  assert.equal(held.allowed, false);
  assert.equal(held.scope, "address");
  assert.match(loginThrottleResponse(held).error, /^Too many failed sign-ins from your network\. Wait 15 minutes/u);
  assert.deepEqual(loginThrottle("192.0.2.78", "someone-new@example.test", start + 30_000), { allowed: true });
});

test("parallel sign-ins count before Keycloak answers, so a burst cannot outrun the limit", () => {
  const start = 9_000_000;
  const pending = [];
  for (let attempt = 0; attempt < ACCOUNT_FAILURE_LIMIT; attempt += 1) {
    assert.equal(loginThrottle(`198.51.100.${attempt}`, "burst@example.test", start).allowed, true);
    pending.push(beginLoginAttempt(`198.51.100.${attempt}`, "burst@example.test", start));
  }
  // None of the five has an answer yet, and the sixth is already held back.
  assert.equal(loginThrottle("198.51.100.200", "burst@example.test", start).allowed, false);

  // An answer that was not about the password takes its attempt back.
  settleLoginAttempt(pending[0], "not-counted");
  assert.equal(loginThrottle("198.51.100.200", "burst@example.test", start).allowed, true);
  for (const attempt of pending.slice(1)) settleLoginAttempt(attempt, "wrong-password");
  assert.equal(loginThrottle("198.51.100.200", "burst@example.test", start).allowed, true, "four wrong passwords");
});

test("the login route counts before Keycloak, then keeps only wrong passwords", async () => {
  const route = await readFile(new URL("../src/app/api/auth/login/route.ts", import.meta.url), "utf8");
  const throttled = route.indexOf("loginThrottle(address, username)");
  const counted = route.indexOf("beginLoginAttempt(address, username)");
  const asked = route.indexOf("await keycloakLogin(");
  assert.ok(throttled > 0 && counted > throttled && asked > counted, "throttle, count, then ask Keycloak");
  assert.match(route, /"retry-after": String\(retryAfterSeconds\)/u);
  assert.match(
    route,
    /settleLoginAttempt\(attempt, result\.refused === "credentials" \? "wrong-password" : "not-counted"\)/u,
  );
  assert.match(route, /settleLoginAttempt\(attempt, "signed-in"\)/u);
});
