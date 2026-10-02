// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  session: null as unknown,
  finishTidalConnection: vi.fn(async () => undefined),
  abandonTidalConnection: vi.fn(async () => undefined),
}));

vi.mock("../../../spotify/routeSupport", () => ({
  requireSpotifySession: async () => seams.session,
}));
vi.mock("@/server/tidalMusic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/tidalMusic")>()),
  finishTidalConnection: seams.finishTidalConnection,
  abandonTidalConnection: seams.abandonTidalConnection,
}));

import { TidalMusicError } from "@/server/tidalMusic";
import { GET } from "./route";

const wearer = { sub: "wearer-subject", email: "", name: "", operator: false };

function callback(query: string) {
  return GET(new Request(`https://center.test/api/settings/services/music/tidal/callback?${query}`));
}

afterEach(() => {
  vi.clearAllMocks();
  seams.session = null;
});

describe("TIDAL sign-in callback", () => {
  it("returns to Services saying the sign-in finished", async () => {
    seams.session = wearer;
    const response = await callback("code=abc&state=s1");

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://center.test/settings/account/music?music=tidal-connected",
    );
    expect(seams.finishTidalConnection).toHaveBeenCalledWith("wearer-subject", "abc", "s1");
    expect(seams.abandonTidalConnection).not.toHaveBeenCalled();
  });

  it("drops the pending sign-in when TIDAL's code exchange fails", async () => {
    seams.session = wearer;
    seams.finishTidalConnection.mockRejectedValueOnce(
      new TidalMusicError("TIDAL sign-in could not be completed.", 502),
    );
    const response = await callback("code=abc&state=s1");

    expect(response.headers.get("location")).toBe(
      "https://center.test/settings/account/music?music=tidal-error",
    );
    expect(seams.abandonTidalConnection).toHaveBeenCalledWith("wearer-subject", "s1");
  });

  it("drops the pending sign-in when the owner cancels at TIDAL", async () => {
    seams.session = wearer;
    const response = await callback("error=access_denied&state=s1");

    expect(response.headers.get("location")).toBe(
      "https://center.test/settings/account/music?music=tidal-error",
    );
    expect(seams.finishTidalConnection).not.toHaveBeenCalled();
    expect(seams.abandonTidalConnection).toHaveBeenCalledWith("wearer-subject", "s1");
  });

  it("sends a lapsed Center sign-in to the login page, not raw JSON", async () => {
    seams.session = Response.json({ error: "Not authenticated." }, { status: 401 });
    const response = await callback("code=abc&state=s1");

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    // The unfinished sign-in's state comes back to Services, which drops it.
    expect(location.searchParams.get("next")).toBe(
      "/settings/account/music?music=tidal-error&tidal_state=s1",
    );
    expect(seams.finishTidalConnection).not.toHaveBeenCalled();
    expect(seams.abandonTidalConnection).not.toHaveBeenCalled();

    const odd = new URL((await callback("code=abc&state=%3Cscript%3E")).headers.get("location")!);
    expect(odd.searchParams.get("next")).toBe("/settings/account/music?music=tidal-error");
  });
});
