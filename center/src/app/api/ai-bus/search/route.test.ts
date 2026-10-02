// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({ searchMyData: vi.fn() }));

vi.mock("@/server/domain/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/domain/events")>();
  return {
    MY_DATA_SEARCH_MAX_CHARS: actual.MY_DATA_SEARCH_MAX_CHARS,
    isMyDataSearchDomain: actual.isMyDataSearchDomain,
    searchMyData: seams.searchMyData,
  };
});

import { GET } from "./route";

function search(params: Record<string, string>) {
  return GET(new Request(`http://center.test/api/ai-bus/search?${new URLSearchParams(params)}`));
}

const EMPTY = { content: [], number: 0, size: 50, totalElements: 0, totalPages: 0, last: true };

afterEach(() => vi.clearAllMocks());

describe("GET /api/ai-bus/search", () => {
  it("searches Ai Mic or Music with the trimmed words and the page asked for", async () => {
    seams.searchMyData.mockResolvedValue({ data: EMPTY, state: "live" });

    const response = await search({ domain: "music", query: "  billie jean ", page: "2", size: "20" });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-data-state")).toBe("live");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(EMPTY);
    expect(seams.searchMyData).toHaveBeenCalledWith("MUSIC", "billie jean", { page: 2, size: 20 });
  });

  it.each(["CALL", "TRANSLATION", "CAPTURE", "NOTE", ""])("refuses the %s domain before Cosmos is asked", async (domain) => {
    const response = await search({ domain, query: "x" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Only Ai Mic and Music can be searched here." });
    expect(seams.searchMyData).not.toHaveBeenCalled();
  });

  it("bounds a search by characters, as Cosmos does", async () => {
    seams.searchMyData.mockResolvedValue({ data: EMPTY, state: "live" });

    expect((await search({ domain: "AI_MIC", query: "🌊".repeat(256) })).status).toBe(200);
    expect((await search({ domain: "AI_MIC", query: "a".repeat(257) })).status).toBe(400);
    expect(seams.searchMyData).toHaveBeenCalledTimes(1);
  });

  it("reports a search Cosmos did not answer as degraded, not as no matches", async () => {
    seams.searchMyData.mockResolvedValue({
      data: EMPTY,
      state: "degraded",
      fallback: "empty",
      degraded: "cosmos webapi did not answer",
    });

    const response = await search({ domain: "AI_MIC", query: "tower" });

    expect(response.headers.get("x-data-state")).toBe("degraded");
    expect(response.headers.get("x-data-fallback")).toBe("empty");
  });
});
