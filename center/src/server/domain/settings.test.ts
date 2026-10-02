// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";

// Failure cases at the Cosmos boundary: malformed coordinates or diagnostic
// content, expired identity, unavailable backend, and an honest empty result.
const cosmos = vi.hoisted(() => {
  class SessionExpiredError extends Error {}
  return { SessionExpiredError, webapiGet: vi.fn() };
});
vi.mock("../cosmos", () => ({
  COSMOS_ENABLED: true,
  COSMOS_WEBAPI: "http://cosmos.test",
  Services: {},
  SessionExpiredError: cosmos.SessionExpiredError,
  webapiGet: cosmos.webapiGet,
  adminAuthHeaders: vi.fn(),
  call: vi.fn(),
  cosmosDeadlineSignal: vi.fn(),
}));
import { getPrivacyDetails } from "./settings";
afterEach(() => vi.clearAllMocks());

const empty = {
  lastLocationEnabled: false,
  diagnosticsEnabled: false,
  lastLocation: null,
  diagnostics: null,
};
it("loads an honest empty privacy view through the wearer REST client", async () => {
  cosmos.webapiGet.mockResolvedValue(empty);
  expect(await getPrivacyDetails()).toEqual({ kind: "live", value: empty });
  expect(cosmos.webapiGet).toHaveBeenCalledWith("/account-service/privacy-details");
});
it("refuses malformed location or diagnostic content instead of displaying it", async () => {
  cosmos.webapiGet.mockResolvedValue({ ...empty, lastLocation: {
    latitude: 999, longitude: 0, humanReadable: "", fullAddress: "", staleStatus: "fresh", timestamp: null,
  } });
  expect(await getPrivacyDetails()).toEqual({ kind: "degraded" });
  cosmos.webapiGet.mockResolvedValue({ ...empty, diagnostics: {
    route: "weather", transport: "legacy", outcome: "complete", elapsedMs: 1, recordedAt: 1,
    utterance: "private words must not become diagnostics",
  } });
  expect(await getPrivacyDetails()).toEqual({ kind: "degraded" });
});
it("distinguishes session expiry from a failed privacy-details read", async () => {
  cosmos.webapiGet.mockRejectedValue(new cosmos.SessionExpiredError());
  expect(await getPrivacyDetails()).toEqual({ kind: "expired" });
  cosmos.webapiGet.mockRejectedValue(new Error("unavailable"));
  expect(await getPrivacyDetails()).toEqual({ kind: "degraded" });
});
