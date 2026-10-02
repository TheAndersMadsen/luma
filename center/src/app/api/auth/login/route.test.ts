// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Sign-in is the one write an anonymous caller can reach, so its body is
 * bounded before it is parsed and before the login throttle is consulted, a
 * huge body is a refusal, not an attempt.
 */

const seams = vi.hoisted(() => ({
  keycloakLogin: vi.fn(),
  loginThrottle: vi.fn(),
  beginLoginAttempt: vi.fn(),
}));

vi.mock("@/server/auth", () => ({
  AUTH_ENABLED: true,
  SESSION_COOKIE: "center-session",
  SESSION_TTL_SECONDS: 43_200,
  keycloakLogin: seams.keycloakLogin,
  loginRefusalResponse: () => ({ status: 401, error: "That email and password didn't match." }),
  originFromHeaders: () => null,
  sealTokens: async () => "sealed",
  setTokenCookies: () => undefined,
  signSession: async () => "signed",
}));
vi.mock("@/server/loginThrottle", () => ({
  beginLoginAttempt: seams.beginLoginAttempt,
  loginThrottle: seams.loginThrottle,
  loginThrottleResponse: () => ({ status: 429, error: "Too many attempts.", retryAfterSeconds: 60 }),
  settleLoginAttempt: () => undefined,
}));

import { POST } from "./route";

function post(body: string, contentType = "application/json") {
  return POST(new Request("https://center.test/api/auth/login", {
    method: "POST",
    headers: contentType ? { "content-type": contentType } : {},
    body,
  }));
}

beforeEach(() => {
  seams.loginThrottle.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/auth/login", () => {
  it("refuses a body bigger than a sign-in before parsing it", async () => {
    const response = await post(JSON.stringify({ username: "a@b.test", password: "x".repeat(4096) }));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "That sign-in attempt is too large." });
    expect(seams.keycloakLogin).not.toHaveBeenCalled();
    expect(seams.loginThrottle).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON with its real status", async () => {
    const response = await post("username=a%40b.test", "text/plain");

    expect(response.status).toBe(415);
    expect(seams.keycloakLogin).not.toHaveBeenCalled();
  });

  it("asks for both fields before counting an attempt", async () => {
    const response = await post(JSON.stringify({ username: "a@b.test" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Enter your email and password." });
    expect(seams.beginLoginAttempt).not.toHaveBeenCalled();
  });
});
