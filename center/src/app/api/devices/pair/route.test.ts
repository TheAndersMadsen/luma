// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  pairDevice: vi.fn(),
  unpairDevice: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "signed-session" }) }),
}));
vi.mock("@/server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth")>();
  return {
    AUTH_ENABLED: true,
    SESSION_COOKIE: actual.SESSION_COOKIE,
    isSameOriginRequest: actual.isSameOriginRequest,
    verifySession: async () => ({ sub: "wearer", email: "ada@example.test", name: "Ada", operator: false }),
  };
});
vi.mock("@/server/domain/account", () => ({
  PIN_PAIRED_ELSEWHERE: "elsewhere",
  getDevices: vi.fn(),
  pairDevice: seams.pairDevice,
  unpairDevice: seams.unpairDevice,
  defaultPreferredName: vi.fn(),
}));
vi.mock("@/server/log", () => ({ logWarn: vi.fn() }));

import { DELETE, POST } from "./route";

function pairing(method: "POST" | "DELETE", deviceId: string) {
  const request = new Request("http://center.test/api/devices/pair", {
    method,
    headers: { origin: "http://center.test", "content-type": "application/json" },
    body: JSON.stringify({ device_id: deviceId }),
  });
  return method === "POST" ? POST(request) : DELETE(request);
}

afterEach(() => vi.clearAllMocks());

describe("/api/devices/pair", () => {
  it.each(["POST", "DELETE"] as const)("%s refuses an ID that is not a Pin's before Cosmos is asked", async (method) => {
    for (const deviceId of ["zz-12", "../admin", "a".repeat(65)]) {
      const response = await pairing(method, deviceId);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "That is not a Pin's device ID." });
    }
    expect(seams.pairDevice).not.toHaveBeenCalled();
    expect(seams.unpairDevice).not.toHaveBeenCalled();
  });
});
