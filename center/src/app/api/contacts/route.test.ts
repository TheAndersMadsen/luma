// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Every contacts mutation reads its body through one bounded reader: the 1 MB
 * limit holds against the actual stream, not only against a declared
 * content-length, so a chunked body of any size is refused mid-read instead of
 * buffered in full.
 */

const seams = vi.hoisted(() => ({
  sameOrigin: vi.fn(),
  createContacts: vi.fn(),
  updateContact: vi.fn(),
  deleteContact: vi.fn(),
}));

vi.mock("@/server/auth", () => ({ isSameOriginRequest: seams.sameOrigin }));
vi.mock("@/server/domain/contacts", () => ({
  cleanContactString: (value: unknown, max: number) =>
    typeof value === "string" && value.length <= max ? value.trim() : "",
  createContacts: seams.createContacts,
  deleteContact: seams.deleteContact,
  parseContactDraft: (raw: unknown) => (raw && typeof raw === "object" ? raw : null),
  updateContact: seams.updateContact,
}));

import { DELETE, POST } from "./route";

function post(body: BodyInit, headers: Record<string, string> = {}) {
  return POST(new Request("https://center.test/api/contacts", {
    method: "POST",
    headers: { origin: "https://center.test", "content-type": "application/json", ...headers },
    body,
    // A stream body is how a caller sends without declaring a length.
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit));
}

function chunkedBody(text: string, pieces = 8): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil(bytes.length / pieces);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

const contact = {
  firstName: "Ada",
  lastName: "Lovelace",
  nickname: "",
  displayName: "",
  phoneNumbers: [],
  emails: [],
  organization: null,
  trusted: false,
  emergency: false,
  favorite: false,
  source: "import:csv",
};

beforeEach(() => {
  seams.sameOrigin.mockReturnValue(true);
  seams.createContacts.mockResolvedValue({
    data: [contact],
    state: "live",
  });
  seams.deleteContact.mockResolvedValue({
    data: true,
    state: "live",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("/api/contacts body bound", () => {
  it("imports a batch and answers with what Cosmos kept", async () => {
    const response = await post(JSON.stringify({ contacts: [contact] }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ imported: [contact] });
    expect(seams.createContacts).toHaveBeenCalledTimes(1);
  });

  it("refuses a chunked body over the limit while it is still streaming", async () => {
    // No content-length: the bound must come from the read itself.
    const oversized = JSON.stringify({ contacts: [contact], pad: "x".repeat(1_100_000) });
    const response = await post(chunkedBody(oversized));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "The contact import is too large." });
    expect(seams.createContacts).not.toHaveBeenCalled();
  });

  it("still refuses a declared oversize import", async () => {
    const response = await post(JSON.stringify({ contacts: [], pad: "x".repeat(1_100_000) }));

    expect(response.status).toBe(413);
    expect(seams.createContacts).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON with its real status", async () => {
    const response = await post("contacts=ada", { "content-type": "text/plain" });

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: "Expected a JSON body." });
  });

  it("refuses another site's request before reading its body", async () => {
    seams.sameOrigin.mockReturnValue(false);

    const response = await post(JSON.stringify({ contacts: [contact] }), { origin: "https://evil.test" });

    expect(response.status).toBe(403);
    expect(seams.createContacts).not.toHaveBeenCalled();
  });

  it("deletes through the same bounded reader", async () => {
    const response = await DELETE(new Request("https://center.test/api/contacts", {
      method: "DELETE",
      headers: { origin: "https://center.test", "content-type": "application/json" },
      body: JSON.stringify({ id: "abc" }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(seams.deleteContact).toHaveBeenCalledWith("abc");
  });
});
