// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const session = { sub: "wearer-subject", email: "", name: "", operator: false };
const seams = vi.hoisted(() => ({
  requireOwnedPairedPin: vi.fn(),
  pinBridgeRequest: vi.fn(),
}));

vi.mock("@/server/auth", () => ({ isSameOriginRequest: () => true }));
vi.mock("@/server/operator", () => ({ requireWearerRequest: async () => session }));
vi.mock("@/server/pinBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/pinBridge")>()),
  requireOwnedPairedPin: seams.requireOwnedPairedPin,
  pinBridgeRequest: seams.pinBridgeRequest,
}));

import { PinBridgeError, type PinBridgeErrorCode } from "@/server/pinBridge";
import { GET, PUT } from "./route";

function get(path: string) {
  return GET(new Request(`http://center.test/api/pin/remote/${path}`), {
    params: Promise.resolve({ path: path.split("?")[0]!.split("/") }),
  });
}

afterEach(() => vi.clearAllMocks());

describe("/api/pin/remote", () => {
  it("carries the bridge's reviewed status and music reads", async () => {
    seams.pinBridgeRequest.mockImplementation(async () => Response.json({ ok: true }));
    for (const path of ["api/health", "api/device", "api/feature-flags", "api/spotify/status"]) {
      expect((await get(path)).status, path).toBe(200);
    }
    expect(seams.pinBridgeRequest.mock.calls.map(([target]) => target)).toEqual([
      "/api/health",
      "/api/device",
      "/api/feature-flags",
      "/api/spotify/status",
    ]);
  });

  it("answers the Pin's USB-only routes itself, without asking the bridge or Cosmos", async () => {
    for (const path of [
      "api/settings",
      "api/setup/acceptance",
      "api/fitness/sessions",
      "api/events",
      "api/iroh/ticket",
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(409);
      const body = await response.json();
      expect(body.reason, path).toBe("usb_only");
      expect(body.error, path).toMatch(/USB/);
    }
    const write = await PUT(
      new Request("http://center.test/api/pin/remote/api/settings", { method: "PUT", body: "{}" }),
      { params: Promise.resolve({ path: ["api", "settings"] }) },
    );
    expect(write.status).toBe(409);
    expect(seams.requireOwnedPairedPin).not.toHaveBeenCalled();
    expect(seams.pinBridgeRequest).not.toHaveBeenCalled();
  });

  it("stops Center's own work when the browser gives up", async () => {
    seams.requireOwnedPairedPin.mockResolvedValueOnce({});
    seams.pinBridgeRequest.mockImplementationOnce(async () => Response.json({ ok: true }));
    const controller = new AbortController();
    await GET(new Request("http://center.test/api/pin/remote/api/health", { signal: controller.signal }), {
      params: Promise.resolve({ path: ["api", "health"] }),
    });
    const ownership = seams.requireOwnedPairedPin.mock.calls[0]![2] as AbortSignal;
    const upstream = (seams.pinBridgeRequest.mock.calls[0]![1] as RequestInit).signal as AbortSignal;
    expect(ownership.aborted).toBe(false);
    expect(upstream.aborted).toBe(false);
    controller.abort();
    expect(ownership.aborted).toBe(true);
    expect(upstream.aborted).toBe(true);
  });

  it("refuses the Pin's copies of cloud data without reaching the Pin", async () => {
    for (const path of [
      "api/memories",
      "api/memories/0f5c8a3e-6a8b-4f55-9b1d-2c4e5a6b7c8d/thumbnail/0",
      "api/contacts",
      "api/contacts/client-reset",
      "api/activity/music?limit=20",
      "api/conversations",
      "api/healthz",
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({
        error: "That Pin function is not available remotely.",
      });
    }
    expect(seams.requireOwnedPairedPin).not.toHaveBeenCalled();
    expect(seams.pinBridgeRequest).not.toHaveBeenCalled();
  });

  it("still sends maintenance namespaces to USB", async () => {
    const response = await get("api/esim/state");
    expect(response.status).toBe(409);
    expect((await response.json()).reason).toBe("usb_only");
    expect(seams.pinBridgeRequest).not.toHaveBeenCalled();
  });

  it("says plainly when no Pin is paired with Center's remote link", async () => {
    seams.requireOwnedPairedPin.mockRejectedValueOnce(
      new PinBridgeError("pin_not_paired", 409, "Connect an Ai Pin to Cosmos first."),
    );
    const response = await get("api/health");

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({
      error:
        "Remote access isn’t on for your Pin yet. Connect it over USB and choose Turn on remote access in Guided setup.",
      reason: "pin_not_paired",
    });
    expect(seams.pinBridgeRequest).not.toHaveBeenCalled();
  });

  it("keeps every other remote-link state distinct", async () => {
    const cases: Array<[PinBridgeErrorCode, number, number]> = [
      ["pin_binding_invalid", 409, 409],
      ["wrong_owner", 403, 403],
      ["bridge_not_configured", 503, 503],
      ["bridge_misconfigured", 503, 503],
      ["bridge_unavailable", 503, 503],
      ["invalid_response", 502, 502],
    ];
    const sentences = new Set<string>();
    for (const [code, thrown, expected] of cases) {
      seams.requireOwnedPairedPin.mockRejectedValueOnce(
        new PinBridgeError(code, thrown, "internal detail"),
      );
      const response = await get("api/health");
      const body = await response.json();
      expect(response.status, code).toBe(expected);
      expect(body.reason, code).toBe(code);
      expect(body.error, code).not.toMatch(/internal detail|Cosmos|isn’t on for your Pin/);
      sentences.add(body.error);
    }
    expect(sentences.size).toBe(cases.length);

    seams.requireOwnedPairedPin.mockRejectedValueOnce(new TypeError("fetch failed"));
    const unexpected = await get("api/health");
    expect(unexpected.status).toBe(503);
    expect((await unexpected.json()).reason).toBe("bridge_unavailable");
  });

  it("answers the bridge's own failure for a paired Pin as unreachable, without its text", async () => {
    // pin/bridge answers 502 itself when its Iroh round trip to the assigned
    // Pin fails. The console keeps polling an unreachable Pin, so it must not
    // become a 409, and the bridge's diagnostic sentence stays off the page.
    seams.requireOwnedPairedPin.mockResolvedValueOnce({});
    seams.pinBridgeRequest.mockResolvedValueOnce(
      new Response("Pin request failed: response request_id does not match the request\n", {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
    const response = await get("api/health");

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      error: "Your paired Pin is not answering right now.",
      reason: "pin_unreachable",
    });
  });

  it("passes the Pin's own refusal through with its status", async () => {
    seams.requireOwnedPairedPin.mockResolvedValueOnce({});
    seams.pinBridgeRequest.mockResolvedValueOnce(
      new Response("duplicate request", {
        status: 409,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
    const response = await get("api/spotify/status");

    expect(response.status).toBe(409);
    expect(await response.text()).toBe("duplicate request");
  });

  it("reports a paired Pin that does not answer as unreachable, not unpaired", async () => {
    seams.requireOwnedPairedPin.mockResolvedValueOnce({});
    seams.pinBridgeRequest.mockRejectedValueOnce(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    const response = await get("api/health");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Your paired Pin is not answering right now.",
      reason: "pin_unreachable",
    });
  });
});
