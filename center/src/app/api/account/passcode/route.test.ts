// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The Pin passcode write. The body is four digits, so anything larger than
 * that is refused before it is parsed, and the passcode is never echoed back.
 */

const seams = vi.hoisted(() => ({
  sameOrigin: vi.fn(),
  setPasscode: vi.fn(),
}));

vi.mock("@/server/auth", () => ({ isSameOriginRequest: seams.sameOrigin }));
vi.mock("@/server/domain/account", () => ({
  getPasscodeState: vi.fn(),
  isPasscode: (value: unknown) => typeof value === "string" && /^\d{4}$/.test(value),
  setPasscode: seams.setPasscode,
}));

import { PUT } from "./route";

function put(body: string, origin = "https://center.test") {
  return PUT(new Request("https://center.test/api/account/passcode", {
    method: "PUT",
    headers: { origin, "content-type": "application/json" },
    body,
  }));
}

beforeEach(() => {
  seams.sameOrigin.mockReturnValue(true);
  seams.setPasscode.mockResolvedValue({
    data: { set: true },
    state: "live",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PUT /api/account/passcode", () => {
  it("sets a four-digit passcode and never echoes it", async () => {
    const response = await put(JSON.stringify({ passcode: "1234" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, passcode: { set: true } });
    expect(seams.setPasscode).toHaveBeenCalledWith("1234");
  });

  it("refuses another site's request", async () => {
    seams.sameOrigin.mockReturnValue(false);

    const response = await put(JSON.stringify({ passcode: "1234" }), "https://evil.test");

    expect(response.status).toBe(403);
    expect(seams.setPasscode).not.toHaveBeenCalled();
  });

  it("refuses a body bigger than four digits before parsing it", async () => {
    const response = await put(JSON.stringify({ passcode: "1234", pad: "x".repeat(4096) }));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, error: "That request is too large." });
    expect(seams.setPasscode).not.toHaveBeenCalled();
  });

  it("refuses a passcode that is not four digits", async () => {
    const response = await put(JSON.stringify({ passcode: "12" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "A passcode is exactly four digits." });
  });
});
