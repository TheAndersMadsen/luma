// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  gatewayQuery: vi.fn(),
}));

vi.mock("@/server/musicGateway", () => ({
  gatewayQuery: seam.gatewayQuery,
  musicGatewayError: (error: unknown) => {
    throw error;
  },
}));

vi.mock("../../spotify/routeSupport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../spotify/routeSupport")>()),
  requireSpotifySession: async () => ({ sub: "wearer-subject", email: "", name: "", operator: false }),
}));

import { GET } from "./route";

afterEach(() => vi.clearAllMocks());

const BASE = "http://center.test/api/settings/services/music/search";

function request(query: string, origin: string | null): Request {
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
  return new Request(`${BASE}?${query}`, { headers });
}

describe("GET /api/settings/services/music/search", () => {
  it("refuses a cross-site or origin-less request before the linked account is asked", async () => {
    for (const origin of ["https://evil.test", null]) {
      const response = await GET(request("q=daft+punk&provider=youtube_music", origin));
      expect(response.status, origin ?? "no origin").toBe(403);
    }
    expect(seam.gatewayQuery).not.toHaveBeenCalled();
  });

  it("answers a same-origin search over the wearer's linked provider", async () => {
    seam.gatewayQuery.mockResolvedValueOnce({ tracks: [] });
    const response = await GET(request("q=daft+punk&provider=youtube_music", "http://center.test"));
    expect(response.status).toBe(200);
    expect(seam.gatewayQuery).toHaveBeenCalledWith("wearer-subject", {
      provider: "youtube_music",
      kind: "track",
      primary: "daft punk",
      limit: 10,
    }, expect.any(AbortSignal));
  });

  it("cancels provider work when the browser leaves", async () => {
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    seam.gatewayQuery.mockImplementationOnce(async (_subject, _query, signal) => {
      providerSignal = signal;
      return { items: [] };
    });
    await GET(new Request(`${BASE}?q=track&provider=tidal`, {
      headers: { origin: "http://center.test" }, signal: controller.signal,
    }));
    controller.abort();
    expect(providerSignal?.aborted).toBe(true);
  });
});
