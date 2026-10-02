// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Minting a device credential is POST-only, operator-gated and same-origin,
 * and its body is a device id and a fixed product, anything bigger is
 * refused before it is read.
 */

const seams = vi.hoisted(() => ({
  fetch: vi.fn(),
  session: { sub: "owner", email: "", name: "", operator: true } as Record<string, unknown> | null,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "signed-session" }) }),
}));
vi.mock("@/server/auth", () => ({
  SESSION_COOKIE: "center-session",
  isSameOriginRequest: (request: Request) =>
    request.headers.get("origin") === "https://center.test",
  verifySession: async () => seams.session,
}));
vi.mock("@/server/cosmos", () => ({
  COSMOS_ADMIN_ENABLED: true,
  COSMOS_WEBAPI: "https://cosmos.test",
  adminAuthHeaders: () => ({ authorization: "Bearer test-admin" }),
  cosmosDeadlineSignal: () => undefined,
}));

import { POST } from "./route";

function provision(body: string, origin = "https://center.test") {
  return POST(new Request("https://center.test/api/admin/provision", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body,
  }));
}

beforeEach(() => {
  vi.stubGlobal("fetch", seams.fetch);
  seams.fetch.mockResolvedValue(Response.json({ device_id: "abc123" }));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("POST /api/admin/provision", () => {
  it("forwards the device id with the stock product identity", async () => {
    const response = await provision(JSON.stringify({ device_id: "ABC123" }));

    expect(response.status).toBe(200);
    const [url, init] = seams.fetch.mock.calls[0]!;
    expect(url).toBe("https://cosmos.test/demo-api/admin/provision");
    expect(JSON.parse(init.body)).toEqual({ device_id: "abc123", product: "00000001" });
  });

  it("refuses a body bigger than a device id before parsing it", async () => {
    const response = await provision(JSON.stringify({ device_id: "a".repeat(4096) }));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "That request is too large." });
    expect(seams.fetch).not.toHaveBeenCalled();
  });

  it("still refuses a device id that is not hexadecimal", async () => {
    const response = await provision(JSON.stringify({ device_id: "zzzz" }));

    expect(response.status).toBe(400);
    expect(seams.fetch).not.toHaveBeenCalled();
  });
});
