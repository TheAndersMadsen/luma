// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The Details edit. The body is a preferred name and a pronunciation, so any
 * write bigger than that is refused before it is parsed, whatever length the
 * caller declared.
 */

const seams = vi.hoisted(() => ({
  sameOrigin: vi.fn(),
  session: { sub: "wearer", email: "ada@example.test", name: "Ada", operator: false },
  getAccountDetails: vi.fn(),
  saveAccountDetails: vi.fn(),
  parseAccountDetailsWrite: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "signed-session" }) }),
}));
vi.mock("@/server/auth", () => ({
  SESSION_COOKIE: "center-session",
  isSameOriginRequest: seams.sameOrigin,
  verifySession: async () => seams.session,
}));
vi.mock("@/server/domain/account", () => ({
  getAccountDetails: seams.getAccountDetails,
  parseAccountDetailsWrite: seams.parseAccountDetailsWrite,
  saveAccountDetails: seams.saveAccountDetails,
}));

import { POST } from "./route";

function post(body: string, origin = "https://center.test") {
  return new Request("https://center.test/api/account/details", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body,
  });
}

beforeEach(() => {
  seams.sameOrigin.mockReturnValue(true);
  seams.parseAccountDetailsWrite.mockImplementation((raw) => raw ?? null);
  seams.saveAccountDetails.mockResolvedValue({
    data: { preferredName: "Ada", pronunciation: "AY-da", hasSecureBioData: false },
    state: "live",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/account/details", () => {
  it("saves an edit and answers with what Cosmos kept", async () => {
    const response = await POST(post(JSON.stringify({ preferredName: "Ada", pronunciation: "" })));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      details: { preferredName: "Ada", pronunciation: "AY-da", hasSecureBioData: false },
    });
  });

  it("refuses another site's request", async () => {
    seams.sameOrigin.mockReturnValue(false);

    const response = await POST(post("preferredName=Ada", "https://evil.test"));

    expect(response.status).toBe(403);
    expect(seams.saveAccountDetails).not.toHaveBeenCalled();
  });

  it("refuses a body bigger than an edit before parsing it", async () => {
    const response = await POST(post(JSON.stringify({ preferredName: "x".repeat(4096) })));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, error: "That details update is too large." });
    expect(seams.saveAccountDetails).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON with its real status", async () => {
    const response = await POST(new Request("https://center.test/api/account/details", {
      method: "POST",
      headers: { origin: "https://center.test", "content-type": "text/plain" },
      body: "preferredName=Ada",
    }));

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ ok: false, error: "Expected a JSON body." });
  });
});
