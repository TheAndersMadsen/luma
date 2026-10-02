// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/cosmos", () => ({
  COSMOS_WEBAPI: "http://cosmos.test",
  COSMOS_WEBAPI_ENABLED: true,
}));

import { POST } from "./route";

const CAP = 32 * 1024;

function speak(body: BodyInit, headers: Record<string, string> = {}) {
  return POST(
    new Request("http://center.test/api/assistant/speech", {
      method: "POST",
      headers: { origin: "http://center.test", "content-type": "application/json", ...headers },
      body,
      // @ts-expect-error - Node's Request needs this for a streamed body.
      duplex: "half",
    }),
  );
}

/** A request body that arrives in chunks, with no length declared up front. */
function streamed(total: number, chunk = 4096): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= total) return controller.close();
      const size = Math.min(chunk, total - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
}

/**
 * Cosmos answering with headers at once and the audio in two parts, the second
 * after `gapMs`. Like a real fetch, an abort on the request's signal also
 * errors the body mid-stream.
 */
function cosmosSpeaking(gapMs: number) {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const signal = init.signal!;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        signal.addEventListener("abort", () => controller.error(signal.reason));
        controller.enqueue(new TextEncoder().encode("first half,"));
        await new Promise((resolve) => setTimeout(resolve, gapMs));
        if (signal.aborted) return;
        controller.enqueue(new TextEncoder().encode(" second half"));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "audio/mpeg" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("POST /api/assistant/speech", () => {
  it("refuses a body declared over the cap without reading it or asking Cosmos", async () => {
    const fetchMock = cosmosSpeaking(0);
    const response = await speak(streamed(CAP + 1), { "content-length": String(CAP + 1) });
    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a streamed body the moment it passes the cap, whatever it declared", async () => {
    const fetchMock = cosmosSpeaking(0);
    const response = await speak(streamed(CAP + 1));
    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards a body at the cap byte for byte", async () => {
    const fetchMock = cosmosSpeaking(0);
    const response = await speak(streamed(CAP));
    expect(response.status).toBe(200);
    expect((fetchMock.mock.calls[0]![1].body as Uint8Array).byteLength).toBe(CAP);
    await response.text();
  });

  it("bounds only the wait for headers, so audio still streaming past the deadline arrives whole", async () => {
    vi.stubEnv("COSMOS_DEADLINE_MS", "20");
    cosmosSpeaking(80);

    const response = await speak(JSON.stringify({ text: "About 330 metres." }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(await response.text()).toBe("first half, second half");
  });

  it("a wearer cancel stops upstream speech even after its headers arrived", async () => {
    const fetchMock = cosmosSpeaking(80);
    const wearer = new AbortController();
    const response = await POST(new Request("http://center.test/api/assistant/speech", {
      method: "POST",
      headers: { origin: "http://center.test", "content-type": "application/json" },
      body: JSON.stringify({ text: "Synthetic pending OS3 answer." }),
      signal: wearer.signal,
    }));
    expect(response.status).toBe(200);
    const reading = response.text();
    wearer.abort(new DOMException("Wearer stopped speech", "AbortError"));
    expect(fetchMock.mock.calls[0]![1].signal?.aborted).toBe(true);
    await expect(reading).rejects.toThrow();
  });

  it("answers 502 when Cosmos sends no headers before the deadline", async () => {
    vi.stubEnv("COSMOS_DEADLINE_MS", "20");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) =>
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
          ),
      ),
    );

    const response = await speak(JSON.stringify({ text: "hello" }));
    expect(response.status).toBe(502);
  });

  it("speaks for no other site's page", async () => {
    const fetchMock = cosmosSpeaking(0);
    const response = await speak(JSON.stringify({ text: "hello" }), { origin: "https://evil.test" });
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
