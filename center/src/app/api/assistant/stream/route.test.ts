// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const cosmos = vi.hoisted(() => ({
  webapiHeaders: vi.fn(),
  requestMetadata: vi.fn(),
}));
const auth = vi.hoisted(() => ({ enabled: false }));

// The real same-origin check. Only whether Keycloak is configured is switched.
vi.mock("@/server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth")>();
  return {
    isSameOriginRequest: actual.isSameOriginRequest,
    get AUTH_ENABLED() {
      return auth.enabled;
    },
  };
});

vi.mock("@/server/cosmos", () => {
  class SessionExpiredError extends Error {}
  return {
    COSMOS_WEBAPI: "http://cosmos.test",
    COSMOS_WEBAPI_ENABLED: true,
    SessionExpiredError,
    webapiHeaders: cosmos.webapiHeaders,
    requestMetadata: cosmos.requestMetadata,
  };
});
vi.mock("@/server/log", () => ({ logWarn: vi.fn(), logError: vi.fn() }));

import { SessionExpiredError } from "@/server/cosmos";
import { POST } from "./route";

const QUESTION = JSON.stringify({ text: "how tall is the eiffel tower" });
const FRAMES =
  'event: start\ndata: {"budget_ms":1}\n\n' +
  'event: step\ndata: {"kind":"answer","text":"About 330 metres."}\n\n' +
  'event: done\ndata: {"total_ms":2}\n\n';

function ask(origin = "http://center.test") {
  return POST(
    new Request("http://center.test/api/assistant/stream", {
      method: "POST",
      headers: { origin },
      body: QUESTION,
    }),
  );
}

function upstreamAnswering() {
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(FRAMES, { status: 200, headers: { "content-type": "text/event-stream" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  auth.enabled = false;
});

describe("POST /api/assistant/stream", () => {
  it("relays the turn unchanged and leaves recording it to Cosmos", async () => {
    cosmos.webapiHeaders.mockResolvedValue({ authorization: "Bearer wearer-token" });
    const fetchMock = upstreamAnswering();

    const response = await ask();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(await response.text()).toBe(FRAMES);
    // The only call is the turn itself: no Ingest, no second write of any kind.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://cosmos.test/demo-api/trace/stream");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(QUESTION);
    expect(init.headers).toEqual({
      authorization: "Bearer wearer-token",
      "content-type": "application/json",
    });
    expect(cosmos.requestMetadata).not.toHaveBeenCalled();
  });

  it("runs the turn as the configured principal the other web reads use", async () => {
    cosmos.webapiHeaders.mockResolvedValue({
      "x-forwarded-client-cert": "U:wearer-1",
      "x-cosmos-edge-token": "edge-proof-value",
    });
    const fetchMock = upstreamAnswering();

    await (await ask()).text();

    expect(fetchMock.mock.calls[0]![1].headers).toEqual({
      "x-forwarded-client-cert": "U:wearer-1",
      "x-cosmos-edge-token": "edge-proof-value",
      "content-type": "application/json",
    });
  });

  it("asks an expired session to sign in again instead of running the turn anonymously", async () => {
    cosmos.webapiHeaders.mockRejectedValue(new SessionExpiredError());
    const fetchMock = upstreamAnswering();

    const response = await ask();

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reauthenticate: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a turn with no identity when sign-in is on, rather than run it as the demo principal", async () => {
    auth.enabled = true;
    cosmos.webapiHeaders.mockResolvedValue({});
    const fetchMock = upstreamAnswering();

    const response = await ask();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not authenticated.", reauthenticate: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still runs an anonymous turn on a deployment with no sign-in at all", async () => {
    cosmos.webapiHeaders.mockResolvedValue({});
    const fetchMock = upstreamAnswering();

    expect((await ask()).status).toBe(200);
    expect(fetchMock.mock.calls[0]![1].headers).toEqual({ "content-type": "application/json" });
  });

  it("starts no turn for another site's page", async () => {
    cosmos.webapiHeaders.mockResolvedValue({ authorization: "Bearer wearer-token" });
    const fetchMock = upstreamAnswering();

    expect((await ask("https://evil.test")).status).toBe(403);
    expect(cosmos.webapiHeaders).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
