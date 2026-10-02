// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({ connectAppleMusic: vi.fn(async () => undefined) }));
vi.mock("../../spotify/routeSupport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../spotify/routeSupport")>()),
  requireSpotifySession: async () => ({ sub: "wearer-subject", email: "", name: "", operator: false }),
  requireSameOrigin: () => null,
}));
vi.mock("@/server/appleMusic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/appleMusic")>()),
  connectAppleMusic: seams.connectAppleMusic,
}));
import { POST } from "./route";
afterEach(() => vi.clearAllMocks());

it("rejects a null Apple Music handoff as invalid input before any account write", async () => {
  const response = await POST(new Request("https://center.test/api/settings/services/music/apple", {
    method: "POST", headers: { "content-type": "application/json" }, body: "null",
  }));
  expect(response.status).toBe(400);
  expect(seams.connectAppleMusic).not.toHaveBeenCalled();
});
