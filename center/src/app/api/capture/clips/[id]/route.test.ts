import { expect, it, vi } from "vitest";
const seams = vi.hoisted(() => ({ copy: vi.fn(), sameOrigin: vi.fn(() => true) }));
vi.mock("@/server/domain/clips", () => ({ copyClip: seams.copy }));
vi.mock("@/server/auth", () => ({ isSameOriginRequest: seams.sameOrigin }));
import { PUT } from "./route";

const id = "567c5b20-13ef-44d6-a481-11acb5568d05";
const article = { title: "Article", publisher: "Publisher", url: "https://example.org/article", selection: "Selected text" };
it("forwards a bounded article under its stable copy ID and reports the real persistence outcome", async () => {
  seams.copy.mockResolvedValueOnce({ state: "live", data: { uuid: id, text: "saved" } });
  const result = await PUT(new Request(`https://center.test/api/capture/clips/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(article) }), { params: Promise.resolve({ id }) });
  expect(result.status).toBe(200);
  expect(seams.copy).toHaveBeenCalledWith(id, article);
  seams.copy.mockResolvedValueOnce({ state: "degraded", data: null, refusal: "conflict" });
  expect((await PUT(new Request(`https://center.test/api/capture/clips/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(article) }), { params: Promise.resolve({ id }) })).status).toBe(409);
});
it("refuses cross-site, executable URLs and unbounded bodies without asking Cosmos", async () => {
  seams.copy.mockClear(); seams.sameOrigin.mockReturnValueOnce(false);
  expect((await PUT(new Request("https://center.test/api/capture/clips/x", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" }), { params: Promise.resolve({ id }) })).status).toBe(403);
  for (const body of [JSON.stringify({ ...article, url: "javascript:alert(1)" }), "x".repeat(65537)]) {
    const result = await PUT(new Request(`https://center.test/api/capture/clips/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body }), { params: Promise.resolve({ id }) });
    expect([400, 413]).toContain(result.status);
  }
  expect(seams.copy).not.toHaveBeenCalled();
});
