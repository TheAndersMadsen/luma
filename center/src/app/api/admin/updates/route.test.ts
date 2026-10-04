// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The update overview is operator-only; "Check now" is also same-origin, and
 * a plain form post (no JavaScript) is sent back to the Software updates page.
 */

const seams = vi.hoisted(() => ({
  gate: "allow" as "allow" | "unauthenticated" | "forbidden",
  overview: vi.fn(),
  requestNow: vi.fn(),
}));

vi.mock("@/server/operator", () => ({
  requireOperatorRequest: async () =>
    seams.gate === "allow"
      ? { sub: "owner", email: "", name: "", operator: true }
      : seams.gate === "unauthenticated"
        ? Response.json({ error: "Not authenticated." }, { status: 401 })
        : Response.json({ error: "Operator access required." }, { status: 403 }),
}));
vi.mock("@/server/domain/updates", () => ({
  updateOverview: seams.overview,
  requestUpdateNow: seams.requestNow,
}));

import { GET } from "./route";
import { POST } from "./check/route";
import { POST as UPDATE_NOW } from "./update-now/route";

const OVERVIEW = {
  current: { release: "abc", version: "0.3.16", tag: "v0.3.16", pinVersion: null, notes: null, publishedAt: null },
  source: "https://updates.example.test",
  autoUpdates: "off",
  check: { outcome: "source-unknown" },
  lastUpdate: null,
  request: { supported: true, pending: false },
};

function check(headers: Record<string, string>) {
  return POST(new Request("https://center.test/api/admin/updates/check", { method: "POST", headers }));
}

function updateNow(headers: Record<string, string> = {}) {
  return UPDATE_NOW(new Request("https://center.test/api/admin/updates/update-now", { method: "POST", headers }));
}

afterEach(() => {
  seams.gate = "allow";
  vi.clearAllMocks();
});

describe("GET /api/admin/updates", () => {
  it("answers the operator with the private, uncached overview", async () => {
    seams.overview.mockResolvedValue(OVERVIEW);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(OVERVIEW);
    expect(seams.overview).toHaveBeenCalledWith();
  });

  it.each([["unauthenticated", 401], ["forbidden", 403]] as const)("refuses a %s caller with %i", async (gate, status) => {
    seams.gate = gate;
    const response = await GET();
    expect(response.status).toBe(status);
    expect(seams.overview).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/updates/check", () => {
  it("forces a fresh check and returns JSON to a script", async () => {
    seams.overview.mockResolvedValue(OVERVIEW);
    const response = await check({ origin: "https://center.test", accept: "application/json" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(OVERVIEW);
    expect(seams.overview).toHaveBeenCalledWith({ force: true });
  });

  it("sends a form post back to the Software updates page", async () => {
    seams.overview.mockResolvedValue(OVERVIEW);
    const response = await check({ origin: "https://center.test", accept: "text/html,application/xhtml+xml" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings/updates");
  });

  it("refuses another site's page before checking", async () => {
    const response = await check({ origin: "https://elsewhere.test", accept: "text/html" });
    expect(response.status).toBe(403);
    expect(seams.overview).not.toHaveBeenCalled();
  });

  it("refuses a caller that is not the operator", async () => {
    seams.gate = "forbidden";
    const response = await check({ origin: "https://center.test" });
    expect(response.status).toBe(403);
    expect(seams.overview).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/updates/update-now", () => {
  it("drops the request and answers a script with the outcome and the refreshed overview", async () => {
    seams.requestNow.mockResolvedValue("requested");
    seams.overview.mockResolvedValue(OVERVIEW);
    const response = await updateNow({ origin: "https://center.test", accept: "application/json" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ outcome: "requested", overview: OVERVIEW });
    expect(seams.requestNow).toHaveBeenCalledWith();
    expect(seams.overview).toHaveBeenCalledWith();
  });

  it.each([
    ["an unsupported server", "unsupported", 503],
    ["an update already on its way", "already-requested", 409],
    ["a failed request", "failed", 500],
  ])("answers %s with %i", async (_label, outcome, status) => {
    seams.requestNow.mockResolvedValue(outcome);
    seams.overview.mockResolvedValue(OVERVIEW);
    const response = await updateNow({ origin: "https://center.test", accept: "application/json" });
    expect(response.status).toBe(status);
    expect((await response.json()).outcome).toBe(outcome);
  });

  it("sends a form post back to the Software updates page whatever the outcome", async () => {
    seams.requestNow.mockResolvedValue("requested");
    const response = await updateNow({ origin: "https://center.test", accept: "text/html,application/xhtml+xml" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings/updates");
  });

  it("refuses another site's page before touching anything", async () => {
    const response = await updateNow({ origin: "https://elsewhere.test", accept: "text/html" });
    expect(response.status).toBe(403);
    expect(seams.requestNow).not.toHaveBeenCalled();
  });

  it("refuses a caller that is not the operator", async () => {
    seams.gate = "unauthenticated";
    const response = await updateNow({ origin: "https://center.test" });
    expect(response.status).toBe(401);
    expect(seams.requestNow).not.toHaveBeenCalled();
  });
});
