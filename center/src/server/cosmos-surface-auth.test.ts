// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ tokens: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "sealed" }) }) }));
vi.mock("@/server/auth", () => ({ SESSION_TTL_SECONDS: 100, openTokens: mocks.tokens, readTokenCookie: () => "sealed", refreshTokens: vi.fn(), sealTokens: vi.fn(), setTokenCookies: vi.fn() }));
import { SessionExpiredError, surfaceOwnerHeaders } from "./cosmos";
beforeEach(() => mocks.tokens.mockReset());
it("surface owner headers fail closed without a bearer, with no static identity fallback", async () => {
  mocks.tokens.mockResolvedValue(null);
  await expect(surfaceOwnerHeaders()).rejects.toBeInstanceOf(SessionExpiredError);
  mocks.tokens.mockResolvedValue({ accessToken: "", expiresAt: Date.now() / 1000 + 300 });
  await expect(surfaceOwnerHeaders()).rejects.toBeInstanceOf(SessionExpiredError);
});
it("surface owner headers contain only the server bearer", async () => {
  mocks.tokens.mockResolvedValue({ accessToken: "server-bearer", expiresAt: Date.now() / 1000 + 300 });
  await expect(surfaceOwnerHeaders()).resolves.toEqual({ authorization: "Bearer server-bearer" });
});
