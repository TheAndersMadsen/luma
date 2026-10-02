// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  deleteEvent: vi.fn(),
}));

vi.mock("@/server/domain/events", () => seam);

import { DELETE } from "./route";

const CONTEXT = { params: Promise.resolve({ id: "ev-1" }) };
const URL = "http://center.test/api/notable-events/mydata/ev-1";

function request(origin: string | null): Request {
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
  return new Request(URL, { method: "DELETE", headers });
}

afterEach(() => vi.clearAllMocks());

describe("DELETE /api/notable-events/mydata/[id]", () => {
  it("refuses a cross-site or origin-less request before Cosmos is asked", async () => {
    for (const origin of ["https://evil.test", null]) {
      const response = await DELETE(request(origin), CONTEXT);
      expect(response.status, origin ?? "no origin").toBe(403);
    }
    expect(seam.deleteEvent).not.toHaveBeenCalled();
  });

  it("deletes from Center's own page", async () => {
    seam.deleteEvent.mockResolvedValue({ state: "live", data: { deleted: true } });
    const response = await DELETE(request("http://center.test"), CONTEXT);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("answers a backend failure in degraded prose, with the internal path only in the log", async () => {
    seam.deleteEvent.mockRejectedValue(new Error("webapi /notable-events/event/ev-1 -> 500"));
    const response = await DELETE(request("http://center.test"), CONTEXT);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.degraded).toBe("delete failed");
    expect(body.note).toBe("delete failed");
    expect(JSON.stringify(body)).not.toContain("webapi");
    expect(JSON.stringify(body)).not.toContain("notable-events/event");
  });
});
