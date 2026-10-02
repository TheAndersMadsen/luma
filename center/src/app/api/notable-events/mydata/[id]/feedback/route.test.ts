// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The Ai Mic vote write. Another site's page must be refused before anything
 * it sent is read, and a body bigger than a `{vote}` is refused before it is
 * parsed, the vote is one word, never a payload.
 */

const seams = vi.hoisted(() => ({
  sameOrigin: vi.fn(),
  setEventVote: vi.fn(),
}));

vi.mock("@/server/auth", () => ({ isSameOriginRequest: seams.sameOrigin }));
vi.mock("@/server/domain/events", () => ({
  EVENT_GONE: "This entry no longer exists.",
  setEventVote: seams.setEventVote,
}));

import { POST } from "./route";

function vote(body: string, origin = "https://center.test") {
  return POST(new Request("https://center.test/api/notable-events/mydata/q-1/feedback", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body,
  }), { params: Promise.resolve({ id: "q-1" }) });
}

beforeEach(() => {
  seams.sameOrigin.mockReturnValue(true);
  seams.setEventVote.mockResolvedValue({
    data: { vote: "up" },
    state: "live",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/notable-events/mydata/[id]/feedback", () => {
  it("records the vote and answers with what Cosmos holds", async () => {
    const response = await vote(JSON.stringify({ vote: "up" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, vote: "up" });
    expect(seams.setEventVote).toHaveBeenCalledWith("q-1", "up");
  });

  it("refuses another site's page before reading anything it sent", async () => {
    seams.sameOrigin.mockReturnValue(false);

    // A body that is not JSON: reading it first would answer 400 (the old
    // order did), refusing it first answers 403.
    const response = await vote("vote=up", "https://evil.test");

    expect(response.status).toBe(403);
    expect(seams.setEventVote).not.toHaveBeenCalled();
  });

  it("refuses a body bigger than a vote before parsing it", async () => {
    const response = await vote(JSON.stringify({ vote: "up", pad: "x".repeat(4096) }));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, error: "That request is too large." });
    expect(seams.setEventVote).not.toHaveBeenCalled();
  });

  it("refuses a body that is not the vote shape", async () => {
    const response = await vote(JSON.stringify({ vote: "sideways" }));
    expect(response.status).toBe(400);
    expect(seams.setEventVote).not.toHaveBeenCalled();
  });
});
