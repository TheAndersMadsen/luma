// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const seams = vi.hoisted(() => ({
  webapiStream: vi.fn(),
  requireWearerRequest: vi.fn(),
}));

vi.mock("@/server/cosmos", () => ({
  SessionExpiredError: class extends Error {},
  webapiStream: seams.webapiStream,
}));
vi.mock("@/server/operator", () => ({ requireWearerRequest: seams.requireWearerRequest }));

import { GET } from "./route";

function download(uuid: string, index = "0") {
  return GET(new Request(`http://center.test/api/capture/memory/x/file/${index}/download`), {
    params: Promise.resolve({ uuid, index }),
  });
}

afterEach(() => vi.clearAllMocks());

describe("GET /api/capture/memory/{uuid}/file/{index}/download", () => {
  it("refuses a caller with no session before Cosmos is asked", async () => {
    seams.requireWearerRequest.mockResolvedValue(
      Response.json({ error: "Not authenticated." }, { status: 401 }),
    );

    const response = await download("11111111-2222-4333-8444-555555555555");

    expect(response.status).toBe(401);
    expect(seams.webapiStream).not.toHaveBeenCalled();
  });

  it("names the file only with characters a filename may carry", async () => {
    seams.requireWearerRequest.mockResolvedValue({ sub: "wearer" });
    seams.webapiStream.mockResolvedValue(
      new Response("jpeg bytes", { status: 200, headers: { "content-type": "image/jpeg" } }),
    );

    const response = await download('abc"; filename="evil.html\r\nx-injected: 1');

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="capture-abcfilenameevilhtmlx-injected1.jpg"',
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(await response.text()).toBe("jpeg bytes");
  });

  it("falls back to a plain name when nothing of the segment survives", async () => {
    seams.requireWearerRequest.mockResolvedValue({ sub: "wearer" });
    seams.webapiStream.mockResolvedValue(
      new Response("mp4 bytes", { status: 200, headers: { "content-type": "video/mp4" } }),
    );

    const response = await download("\"';/\\");

    expect(response.headers.get("content-disposition")).toBe('attachment; filename="capture.mp4"');
  });
});
