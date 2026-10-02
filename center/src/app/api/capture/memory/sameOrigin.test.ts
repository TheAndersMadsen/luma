// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Every capture write refuses a request that did not come from Center's own
 * pages. The session cookie is SameSite=lax, so a page on a sibling host of the
 * owner's domain (one routed through the same Traefik, say) could otherwise
 * favourite, tag, share or delete the wearer's captures with a plain form post.
 * The seam must not be reached at all: a refused write asks Cosmos nothing.
 */

const seam = vi.hoisted(() => ({
  addCaptureTag: vi.fn(),
  removeCaptureTag: vi.fn(),
  deleteMemory: vi.fn(),
  getCapture: vi.fn(),
  setCaptureFavorite: vi.fn(),
  setCapturesFavorite: vi.fn(),
  deleteMemories: vi.fn(),
  createCaptureShareLink: vi.fn(),
  clearPendingCaptures: vi.fn(),
  getPendingCaptures: vi.fn(),
  setCaptureBestFrame: vi.fn(),
  rankCapture: vi.fn(),
}));

vi.mock("@/server/cosmos", () => ({ SessionExpiredError: class extends Error {} }));
vi.mock("@/server/log", () => ({ logWarn: vi.fn(), logError: vi.fn() }));
vi.mock("@/server/domain/captures", () => seam);

import { POST as tag } from "./[uuid]/tag/route";
import { DELETE as untag } from "./[uuid]/tag/[tag]/route";
import { DELETE as forget } from "./[uuid]/route";
import { POST as favorite } from "./[uuid]/favorite/route";
import { POST as unfavorite } from "./[uuid]/unfavorite/route";
import { POST as bestFrame } from "./[uuid]/best-frame/route";
import { POST as bestPhoto } from "./[uuid]/best-photo/route";
import { POST as share } from "./[uuid]/share/route";
import { POST as bulkDelete } from "./bulk-delete/route";
import { POST as bulkFavorite } from "./bulk-favorite/route";
import { POST as bulkUnfavorite } from "./bulk-unfavorite/route";
import { DELETE as clearPending } from "../pending-memory-creates/route";

const UUID = "11111111-2222-4333-8444-555555555555";
const params = { params: Promise.resolve({ uuid: UUID, tag: "beach" }) };

type Write = {
  name: string;
  method: "POST" | "DELETE";
  path: string;
  body?: unknown;
  send: (request: Request) => Promise<Response>;
  /** The seam call a same-origin request makes. */
  reaches: keyof typeof seam;
};

const WRITES: Write[] = [
  { name: "tag", method: "POST", path: `${UUID}/tag`, body: { text: "beach" }, send: (r) => tag(r, params), reaches: "addCaptureTag" },
  { name: "untag", method: "DELETE", path: `${UUID}/tag/beach`, send: (r) => untag(r, params), reaches: "removeCaptureTag" },
  { name: "forget", method: "DELETE", path: UUID, send: (r) => forget(r, params), reaches: "deleteMemory" },
  { name: "favorite", method: "POST", path: `${UUID}/favorite`, send: (r) => favorite(r, params), reaches: "setCaptureFavorite" },
  { name: "unfavorite", method: "POST", path: `${UUID}/unfavorite`, send: (r) => unfavorite(r, params), reaches: "setCaptureFavorite" },
  { name: "best frame", method: "POST", path: `${UUID}/best-frame`, body: { frame: 0 }, send: (r) => bestFrame(r, params), reaches: "setCaptureBestFrame" },
  { name: "best photo", method: "POST", path: `${UUID}/best-photo`, send: (r) => bestPhoto(r, params), reaches: "rankCapture" },
  { name: "share", method: "POST", path: `${UUID}/share`, send: (r) => share(r, params), reaches: "createCaptureShareLink" },
  { name: "bulk delete", method: "POST", path: "bulk-delete", body: { memoryUUIDs: [UUID] }, send: bulkDelete, reaches: "deleteMemories" },
  { name: "bulk favorite", method: "POST", path: "bulk-favorite", body: { memoryUUIDs: [UUID] }, send: bulkFavorite, reaches: "setCapturesFavorite" },
  { name: "bulk unfavorite", method: "POST", path: "bulk-unfavorite", body: { memoryUUIDs: [UUID] }, send: bulkUnfavorite, reaches: "setCapturesFavorite" },
  { name: "clear pending", method: "DELETE", path: "../pending-memory-creates", send: (r) => clearPending(r), reaches: "clearPendingCaptures" },
];

function request(write: Write, origin: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  return new Request(new URL(`http://center.test/api/capture/memory/${write.path}`), {
    method: write.method,
    headers,
    body: write.body === undefined ? undefined : JSON.stringify(write.body),
  });
}

beforeEach(() => {
  for (const fn of Object.values(seam)) fn.mockResolvedValue({});
  seam.deleteMemory.mockResolvedValue({ state: "live", data: null });
  seam.deleteMemories.mockResolvedValue({
    state: "live",
    data: { deleted: [UUID], notFound: [], failed: [] },
  });
  seam.clearPendingCaptures.mockResolvedValue({ state: "live", data: 0 });
  seam.removeCaptureTag.mockResolvedValue(true);
  seam.setCapturesFavorite.mockResolvedValue(1);
  seam.createCaptureShareLink.mockResolvedValue({ url: "https://center.test/s", expiry: 1 });
});

afterEach(() => vi.clearAllMocks());

describe("capture writes are same-origin only", () => {
  it.each(WRITES)("$name refuses a cross-site or origin-less request before Cosmos is asked", async (write) => {
    expect((await write.send(request(write, "https://evil.test"))).status).toBe(403);
    expect((await write.send(request(write, null))).status).toBe(403);
    for (const fn of Object.values(seam)) expect(fn).not.toHaveBeenCalled();
  });

  it.each(WRITES)("$name goes through from Center's own page", async (write) => {
    const response = await write.send(request(write, "http://center.test"));
    expect(response.status).toBe(200);
    expect(seam[write.reaches]).toHaveBeenCalledOnce();
  });
});
