// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The Test button on every Cosmos service card, OS3's included, goes through
 * this proxy. The card shows Cosmos's own sentence for the step that failed
 * ("The OS3 sign-in has expired…"), so the proxy must hand it through with its
 * status untouched, and must refuse everyone but the operator's own page.
 */

const seams = vi.hoisted(() => ({
  fetch: vi.fn(),
  operator: vi.fn(),
  adminEnabled: true,
}));

vi.mock("@/server/operator", () => ({ requireOperatorRequest: seams.operator }));
vi.mock("@/server/cosmos", () => ({
  get COSMOS_ADMIN_ENABLED() {
    return seams.adminEnabled;
  },
  COSMOS_WEBAPI: "https://cosmos.test",
  adminAuthHeaders: () => ({ authorization: "Bearer test-admin" }),
  cosmosDeadlineSignal: () => undefined,
}));

import { POST } from "./route";

const OS3_EXPIRED =
  "The OS3 sign-in has expired. Sign in at os3.rabbit.tech again and paste a fresh session cookie.";

function testService(body: string = JSON.stringify({ target: "os3" }), origin = "https://center.test") {
  return POST(
    new Request("https://center.test/api/admin/integrations/test", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body,
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", seams.fetch);
  seams.operator.mockResolvedValue({ sub: "owner", email: "", name: "", operator: true });
  seams.adminEnabled = true;
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("POST /api/admin/integrations/test", () => {
  it("hands back the operator gate's own refusal", async () => {
    seams.operator.mockResolvedValue(Response.json({ error: "Operator access required." }, { status: 403 }));

    const response = await testService();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Operator access required." });
    expect(seams.fetch).not.toHaveBeenCalled();
  });

  it("refuses another site's page", async () => {
    const response = await testService(undefined, "https://evil.test");
    expect(response.status).toBe(403);
    expect(seams.fetch).not.toHaveBeenCalled();
  });

  it("says tests are unavailable when Cosmos's admin surface is off", async () => {
    seams.adminEnabled = false;
    const response = await testService();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Cosmos integration tests are unavailable." });
    expect(seams.fetch).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    const response = await testService("target=os3");
    expect(response.status).toBe(400);
    expect(seams.fetch).not.toHaveBeenCalled();
  });

  it("refuses a test request bigger than the reader allows before parsing it", async () => {
    const response = await testService(JSON.stringify({ target: "os3", pad: "x".repeat(80 * 1024) }));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "That test request is too large." });
    expect(seams.fetch).not.toHaveBeenCalled();
  });

  it("says Cosmos is unreachable when the call itself fails", async () => {
    seams.fetch.mockRejectedValue(new TypeError("fetch failed"));
    const response = await testService();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Cosmos is unreachable." });
  });

  it("passes Cosmos's OS3 step failure through with its status, words and type", async () => {
    seams.fetch.mockResolvedValue(
      Response.json({ error: OS3_EXPIRED }, { status: 502 }),
    );

    const response = await testService();

    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")?.split(";")[0]).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: OS3_EXPIRED });

    const [url, init] = seams.fetch.mock.calls[0]!;
    expect(url).toBe("https://cosmos.test/demo-api/admin/integrations/test");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      authorization: "Bearer test-admin",
      "content-type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({ target: "os3" });
  });

  it.each([
    [409, "OS3 is not configured. Turn on Use OS3, paste a session cookie, and save."],
    [503, "OS3 is answering another question. Try again in a moment."],
    [504, "OS3 did not respond in time. Try again in a moment."],
  ])("keeps a Cosmos %i and its sentence", async (status, error) => {
    seams.fetch.mockResolvedValue(Response.json({ error }, { status }));
    const response = await testService();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });
});
