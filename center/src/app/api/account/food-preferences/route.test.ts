// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Food preferences: restrictions and goals, a list a real wearer can write but
 * not a payload, so the route bounds the read at room for that list and
 * refuses anything bigger before it is parsed.
 */

const seams = vi.hoisted(() => ({
  sameOrigin: vi.fn(),
  saveFoodPreferences: vi.fn(),
  parseFoodPreferencesWrite: vi.fn(),
}));

vi.mock("@/server/auth", () => ({ isSameOriginRequest: seams.sameOrigin }));
vi.mock("@/server/domain/account", () => ({
  getFoodPreferences: vi.fn(),
  parseFoodPreferencesWrite: seams.parseFoodPreferencesWrite,
  saveFoodPreferences: seams.saveFoodPreferences,
}));

import { POST } from "./route";

function post(body: string, origin = "https://center.test") {
  return POST(new Request("https://center.test/api/account/food-preferences", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body,
  }));
}

beforeEach(() => {
  seams.sameOrigin.mockReturnValue(true);
  seams.parseFoodPreferencesWrite.mockImplementation((raw) => raw ?? null);
  seams.saveFoodPreferences.mockResolvedValue({
    data: { restrictions: [], dailyIntakeGoals: [] },
    state: "live",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/account/food-preferences", () => {
  it("saves preferences and answers with what Cosmos kept", async () => {
    const response = await post(JSON.stringify({ restrictions: [], dailyIntakeGoals: [] }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      preferences: { restrictions: [], dailyIntakeGoals: [] },
    });
  });

  it("refuses another site's request", async () => {
    seams.sameOrigin.mockReturnValue(false);

    const response = await post("restrictions=none", "https://evil.test");

    expect(response.status).toBe(403);
    expect(seams.saveFoodPreferences).not.toHaveBeenCalled();
  });

  it("refuses a body bigger than a preferences list before parsing it", async () => {
    const response = await post(JSON.stringify({
      restrictions: Array.from({ length: 400 }, (_, i) => ({ uuid: `r-${i}`, name: "x".repeat(64) })),
    }));

    expect(response.status).toBe(413);
    expect(await response.json())
      .toEqual({ ok: false, error: "That food preferences update is too large." });
    expect(seams.saveFoodPreferences).not.toHaveBeenCalled();
  });
});
