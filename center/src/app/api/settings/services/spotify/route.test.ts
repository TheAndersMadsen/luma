// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  runSpotifyBridgeAction: vi.fn(),
}));

vi.mock("./routeSupport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./routeSupport")>()),
  requireSpotifySession: async () => ({ sub: "wearer-subject", email: "", name: "", operator: false }),
}));
vi.mock("@/server/musicGateway", () => ({
  musicAccountStatus: async () => ({
    active_provider: "youtube_music",
    providers: {
      youtube_music: { configured: true, state: "connected", ad_filtering: "pear_newpipe" },
      tidal: { configured: true, state: "not_connected" },
      apple_music: { configured: false, state: "not_configured" },
    },
  }),
  musicProviderStatus: vi.fn(),
}));
vi.mock("@/server/spotifyBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/spotifyBridge")>()),
  runSpotifyBridgeAction: seams.runSpotifyBridgeAction,
}));

import { SpotifyBridgeError } from "@/server/spotifyBridge";
import { GET } from "./route";

afterEach(() => vi.clearAllMocks());

describe("GET /api/settings/services/spotify", () => {
  it("answers the Pin's own provider beside the account's choice when they differ", async () => {
    // A reinstalled, reset or replaced Pin is back on Spotify while Cosmos
    // keeps YouTube Music: the card needs both to offer Save.
    seams.runSpotifyBridgeAction.mockResolvedValueOnce({
      active_provider: "spotify",
      enabled: false,
      experimental_acknowledged: false,
      state: "disabled",
      device_name: "Ai Pin",
      engine_ready: false,
    });
    const request = new Request("https://center.test/api/settings/services/spotify");
    const response = await GET(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.active_provider).toBe("youtube_music");
    expect(body.pin_active_provider).toBe("spotify");
    expect(seams.runSpotifyBridgeAction).toHaveBeenCalledTimes(1);
    expect(seams.runSpotifyBridgeAction.mock.calls[0]?.[1]).toBe("status");
    expect(seams.runSpotifyBridgeAction.mock.calls[0]?.[4]).toBe(request.signal);
  });

  it("keeps the music accounts on screen when the remote link names a released Pin", async () => {
    for (const [code, status, reason] of [
      ["pin_binding_invalid", 409, "pin_not_paired"],
      ["wrong_owner", 403, "pairing_unconfirmed"],
      ["bridge_misconfigured", 503, "not_configured"],
    ] as const) {
      seams.runSpotifyBridgeAction.mockRejectedValueOnce(
        new SpotifyBridgeError(code, status, "The remote Pin assignment is no longer valid."),
      );
      const response = await GET(new Request("https://center.test/api/settings/services/spotify"));
      expect(response.status, code).toBe(200);
      const body = await response.json();
      expect(body.state, code).toBe("unavailable");
      expect(body.unavailable_reason, code).toBe(reason);
      expect(body.active_provider, code).toBe("youtube_music");
      expect(body.providers.youtube_music.state, code).toBe("connected");
    }
  });
});
