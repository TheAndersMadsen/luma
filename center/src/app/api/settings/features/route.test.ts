// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  session: { sub: "wearer", email: "ada@example.test", name: "Ada", operator: false } as Record<string, unknown> | null,
  readFeatures: vi.fn(),
  writeFeature: vi.fn(),
  queueFeatureSync: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "signed-session" }) }),
}));
vi.mock("@/server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth")>();
  return {
    SESSION_COOKIE: actual.SESSION_COOKIE,
    isSameOriginRequest: actual.isSameOriginRequest,
    verifySession: async () => seams.session,
  };
});
vi.mock("@/server/domain/features", () => ({
  readFeatures: seams.readFeatures,
  writeFeature: seams.writeFeature,
}));
vi.mock("@/server/domain/settings", () => ({
  queueFeatureSync: seams.queueFeatureSync,
}));

import { GET, PUT } from "./route";

const tickle = {
  name: "tickle",
  editable: true,
  type: "bool",
  default: true,
  effective: false,
  overridden: true,
  label: "The Tickle",
  description: "",
  category: "Everyday Pin",
  evidence: "observed",
  delivery: "next_sync",
};

function change(body: unknown, origin = "http://center.test") {
  const request = new Request("http://center.test/api/settings/features", {
    method: "PUT",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return PUT(request);
}

afterEach(() => {
  vi.clearAllMocks();
  seams.session = { sub: "wearer", email: "ada@example.test", name: "Ada", operator: false };
});

describe("/api/settings/features", () => {
  it("answers an expired sign-in with reauthenticate, and an unanswered Cosmos as 502", async () => {
    seams.readFeatures.mockResolvedValueOnce({ kind: "expired" });
    const expired = await GET();
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ reauthenticate: true });

    seams.readFeatures.mockResolvedValueOnce({ kind: "degraded" });
    expect((await GET()).status).toBe(502);
  });

  // humane.center put Features in each account's own settings: any signed-in
  // wearer changes their own Pins, operator or not.
  it("saves a wearer's choice for their own Pins and nudges them", async () => {
    seams.writeFeature.mockResolvedValue({ kind: "saved", feature: tickle });
    seams.queueFeatureSync.mockResolvedValue("push_queued");

    const response = await change({ name: "tickle", value: false });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...tickle, delivery: "push_queued" });
    expect(seams.writeFeature).toHaveBeenCalledWith("tickle", "PUT", false);
    expect(seams.queueFeatureSync).toHaveBeenCalledWith("wearer");
  });

  it("refuses a signed-out, cross-site, or valueless change before Cosmos is asked", async () => {
    seams.session = null;
    expect((await change({ name: "tickle", value: false })).status).toBe(401);
    seams.session = { sub: "wearer" };
    expect((await change({ name: "tickle", value: false }, "https://evil.test")).status).toBe(403);
    expect((await change({ name: "tickle", value: { on: true } })).status).toBe(400);
    expect((await change({ name: "tickle" })).status).toBe(400);
    expect(seams.writeFeature).not.toHaveBeenCalled();
    expect(seams.queueFeatureSync).not.toHaveBeenCalled();
  });
});
