// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const domain = vi.hoisted(() => ({ getFoodLog: vi.fn() }));

vi.mock("@/server/domain/captures", () => ({ getFoodLog: domain.getFoodLog }));

import { GET } from "./route";

function read(query: string) {
  return GET(new Request(`http://center.test/api/capture/food-log${query}`));
}

const day = "?startTime=2026-09-23T00:00:00Z&endTime=2026-09-23T12:00:00Z";

afterEach(() => vi.clearAllMocks());

describe("GET /api/capture/food-log", () => {
  it("answers the entries Cosmos opened and says how many it keeps sealed", async () => {
    const entry = { loggedAt: "2026-09-23T08:00:00.000Z", itemName: "Ramen", servingsConsumed: 1, nutritionInfo: [] };
    domain.getFoodLog.mockResolvedValue({
      data: [entry],
      state: "live",
      degraded: "1 entry is encrypted with a key this server doesn't have yet, so it isn't listed.",
    });

    const response = await read(day);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([entry]);
    expect(response.headers.get("x-data-state")).toBe("live");
    expect(response.headers.get("x-data-degraded")).toMatch(/^1 entry is encrypted/);
  });

  it("answers an expired session with 401 and reauthenticate, never an empty day", async () => {
    domain.getFoodLog.mockResolvedValue({
      data: [],
      state: "degraded",
      fallback: "empty",
      degraded: "Your session expired — sign in again to reload this.",
      reauthenticate: true,
    });

    const response = await read(day);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Your session expired — sign in again.", reauthenticate: true });
    expect(response.headers.get("x-data-reauthenticate")).toBe("1");
  });

  it("refuses a bound that is not a date before Cosmos is asked", async () => {
    const response = await read("?startTime=today&endTime=now");
    expect(response.status).toBe(400);
    expect(domain.getFoodLog).not.toHaveBeenCalled();
  });
});
