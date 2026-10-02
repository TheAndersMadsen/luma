// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const source = vi.hoisted(() => ({ getFoodIntake: vi.fn() }));

vi.mock("@/server/domain/account", () => ({ getFoodIntake: source.getFoodIntake }));

import { GET } from "./route";

const intake = {
  logged: 1,
  nutrients: [{ type: "CALORIES", unit: "KCAL", consumed: 350, unreported: 0 }],
};

function read(query: string) {
  return GET(new Request(`http://center.test/api/account/food-intake${query}`));
}

afterEach(() => vi.clearAllMocks());

describe("GET /api/account/food-intake", () => {
  it("forwards one window to Cosmos and renders what it added up", async () => {
    source.getFoodIntake.mockResolvedValue({ data: intake, state: "live" });

    const response = await read(
      "?startTime=2026-09-23T00:00:00%2B02:00&endTime=2026-09-23T12:00:00Z",
    );

    expect(response.status).toBe(200);
    expect(source.getFoodIntake).toHaveBeenCalledWith(
      "2026-09-22T22:00:00.000Z",
      "2026-09-23T12:00:00.000Z",
    );
    expect(await response.json()).toEqual({ intake, state: "live" });
    expect(response.headers.get("x-data-state")).toBe("live");
  });

  it("says an unreadable log is degraded, never an empty day", async () => {
    source.getFoodIntake.mockResolvedValue({
      data: null,
      state: "degraded",
      fallback: "empty",
      degraded: "webapi /account-service/food-intake -> 503",
    });

    const response = await read("?startTime=2026-09-23T00:00:00Z&endTime=2026-09-23T12:00:00Z");

    expect(await response.json()).toMatchObject({ intake: null, state: "degraded" });
    expect(response.headers.get("x-data-state")).toBe("degraded");
  });

  it("refuses a window that is missing a bound or is not a date", async () => {
    for (const query of ["", "?startTime=2026-09-23T00:00:00Z", "?startTime=today&endTime=now"]) {
      const response = await read(query);
      expect(response.status, query).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(source.getFoodIntake).not.toHaveBeenCalled();
  });
});
