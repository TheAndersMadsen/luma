// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  disconnectTidal: vi.fn(async () => undefined),
  abandonTidalConnection: vi.fn(async () => undefined),
}));

vi.mock("../../spotify/routeSupport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../spotify/routeSupport")>()),
  requireSpotifySession: async () => ({ sub: "wearer-subject", email: "", name: "", operator: false }),
  requireSameOrigin: () => null,
}));
vi.mock("@/server/musicGateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/musicGateway")>()),
  disconnectTidal: seams.disconnectTidal,
}));
vi.mock("@/server/tidalMusic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/tidalMusic")>()),
  abandonTidalConnection: seams.abandonTidalConnection,
}));

import { DELETE } from "./route";

afterEach(() => vi.clearAllMocks());

describe("DELETE /api/settings/services/music/tidal", () => {
  it("drops only the named unfinished sign-in, keeping a linked account", async () => {
    const response = await DELETE(
      new Request("https://center.test/api/settings/services/music/tidal?pending=s1", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(200);
    expect(seams.abandonTidalConnection).toHaveBeenCalledWith("wearer-subject", "s1");
    expect(seams.disconnectTidal).not.toHaveBeenCalled();
  });

  it("disconnects TIDAL without a pending sign-in named", async () => {
    const response = await DELETE(
      new Request("https://center.test/api/settings/services/music/tidal", { method: "DELETE" }),
    );

    expect(response.status).toBe(200);
    expect(seams.disconnectTidal).toHaveBeenCalledWith("wearer-subject");
    expect(seams.abandonTidalConnection).not.toHaveBeenCalled();
  });
});
