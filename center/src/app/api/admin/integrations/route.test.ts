// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth", () => ({ isSameOriginRequest: () => true }));
vi.mock("@/server/operator", () => ({
  requireOperatorRequest: async () => ({ sub: "wearer-subject", email: "", name: "", operator: true }),
}));
vi.mock("@/server/cosmos", () => ({
  COSMOS_ADMIN_ENABLED: true,
  COSMOS_WEBAPI: "https://cosmos.test",
  adminAuthHeaders: () => ({ authorization: "Bearer test-admin" }),
  cosmosDeadlineSignal: () => undefined,
}));
vi.mock("@/server/domain/settings", () => ({
  queueFeatureSync: vi.fn(),
}));

import { PUT } from "./route";

describe("PUT /api/admin/integrations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses a settings document bigger than the reader allows before parsing it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await PUT(new Request("https://center.test/api/admin/integrations", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ speech: { azure_key: "x".repeat(80 * 1024) } }),
    }));

    expect(response.status).toBe(413);
    expect(await response.json())
      .toEqual({ error: "That provider settings document is too large." });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
