// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  searchCaptures: vi.fn(),
}));

vi.mock("@/server/domain/captures", () => seam);

import { GET } from "./route";

afterEach(() => vi.clearAllMocks());

describe("GET /api/capture/search", () => {
  it("forwards the favourites filter so Cosmos narrows the matches", async () => {
    seam.searchCaptures.mockResolvedValue({ state: "live", data: [], total: 0 });
    const response = await GET(
      new Request("http://center.test/api/capture/search?query=beach&favorites=1"),
    );
    expect(response.status).toBe(200);
    expect(seam.searchCaptures).toHaveBeenCalledWith("beach", 0, 200, { favorites: true });
  });

  it("asks for every match when no filter is on", async () => {
    seam.searchCaptures.mockResolvedValue({ state: "live", data: [], total: 0 });
    await GET(new Request("http://center.test/api/capture/search?query=beach"));
    expect(seam.searchCaptures).toHaveBeenCalledWith("beach", 0, 200, { favorites: false });
  });

  it("answers an empty query without asking Cosmos", async () => {
    const response = await GET(new Request("http://center.test/api/capture/search?query=%20%20"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(seam.searchCaptures).not.toHaveBeenCalled();
  });
});
