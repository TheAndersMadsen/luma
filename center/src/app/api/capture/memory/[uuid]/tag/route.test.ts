// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const domain = vi.hoisted(() => ({ addCaptureTag: vi.fn() }));

vi.mock("@/server/cosmos", () => ({ SessionExpiredError: class extends Error {} }));
vi.mock("@/server/domain/captures", () => ({ addCaptureTag: domain.addCaptureTag }));

import { POST } from "./route";

const UUID = "11111111-2222-4333-8444-555555555555";

function tag(text: string, origin: string | null = "http://center.test") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  return POST(
    new Request(`http://center.test/api/capture/memory/${UUID}/tag`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text }),
    }),
    { params: Promise.resolve({ uuid: UUID }) },
  );
}

afterEach(() => vi.clearAllMocks());

describe("POST /api/capture/memory/{uuid}/tag", () => {
  it("bounds a tag by characters, as Cosmos does, not by UTF-16 units", async () => {
    domain.addCaptureTag.mockImplementation(async (_uuid: string, text: string) => ({
      uuid: UUID,
      data: { tags: [text] },
    }));

    // 64 emoji are 128 UTF-16 units. Cosmos accepts them, so Center must too.
    const emoji = "🌊".repeat(64);
    const accepted = await tag(emoji);
    expect(accepted.status).toBe(200);
    expect(domain.addCaptureTag).toHaveBeenCalledWith(UUID, emoji);

    expect((await tag("🌊".repeat(65))).status).toBe(400);
    expect((await tag("   ")).status).toBe(400);
    expect(domain.addCaptureTag).toHaveBeenCalledTimes(1);
  });

  it("refuses a cross-site or origin-less write before Cosmos is asked", async () => {
    expect((await tag("beach", "https://evil.test")).status).toBe(403);
    expect((await tag("beach", null)).status).toBe(403);
    expect(domain.addCaptureTag).not.toHaveBeenCalled();
  });
});
