// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const cosmos = vi.hoisted(() => {
  class SessionExpiredError extends Error {}
  return {
    SessionExpiredError,
    webapiGet: vi.fn(),
    webapiHeaders: vi.fn(async () => ({ authorization: "Bearer wearer-token" })),
  };
});

vi.mock("../cosmos", () => ({
  COSMOS_WEBAPI: "http://cosmos.test",
  COSMOS_WEBAPI_ENABLED: true,
  SessionExpiredError: cosmos.SessionExpiredError,
  cosmosDeadlineSignal: () => undefined,
  webapiError: (path: string, status: number, headers: Record<string, string>) =>
    status === 401 && headers.authorization
      ? new cosmos.SessionExpiredError()
      : new Error(`webapi ${path} -> ${status}`),
  webapiGet: cosmos.webapiGet,
  webapiHeaders: cosmos.webapiHeaders,
}));

import { writeFeature } from "./features";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Settings → Features on Cosmos", () => {
  it("never sends a name that is not a stock flag name", async () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    expect(await writeFeature("../demo-api/flags", "PUT", true)).toEqual({ kind: "unknown" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
