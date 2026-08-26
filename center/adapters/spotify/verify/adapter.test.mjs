import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { adapterContract, createAdapterServer } from "../src/adapter.mjs";
import { digestToken } from "../src/config.mjs";

const TOKEN = "adapter-test-token".padEnd(40, "x");
const UPSTREAM_ORIGIN = "http://center-iroh-bridge:18080";

function spotifyStatus(overrides = {}) {
  return {
    enabled: true,
    experimental_acknowledged: true,
    state: "ready",
    device_name: "Anders's Ai Pin",
    username: "listener",
    engine_ready: true,
    ...overrides,
  };
}

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

async function runningAdapter(t, fetchImpl) {
  const server = createAdapterServer(
    {
      bindAddress: "127.0.0.1",
      upstreamOrigin: UPSTREAM_ORIGIN,
      port: 0,
      timeoutMs: 300,
      expectedTokenDigest: digestToken(TOKEN),
    },
    { fetchImpl },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function authorized(init = {}) {
  return {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...init.headers,
    },
  };
}

test("exposes only the six exact route and method pairs", () => {
  assert.deepEqual(adapterContract.routes, [
    "GET /api/spotify/status",
    "PUT /api/spotify/settings",
    "POST /api/spotify/pairing/start",
    "POST /api/spotify/pairing/cancel",
    "DELETE /api/spotify/session",
    "GET /api/spotify/search",
  ]);
  // Search is the only read that carries caller input, so its bounds are part
  // of the contract rather than an implementation detail of the handler.
  assert.deepEqual(adapterContract.searchKinds, ["track"]);
  assert.equal(adapterContract.maxSearchQueryCharacters, 80);
  assert.equal(adapterContract.maxSearchItems, 10);
  assert.deepEqual(adapterContract.probes, {
    liveness: "/healthz",
    readiness: "/readyz",
  });
});

test("requires the private bearer token and rejects non-allowlisted shapes", async (t) => {
  let upstreamCalls = 0;
  const base = await runningAdapter(t, async () => {
    upstreamCalls += 1;
    return jsonResponse(spotifyStatus());
  });

  const missing = await fetch(`${base}/api/spotify/status`);
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get("www-authenticate"), 'Bearer realm="spotify-adapter"');
  assert.deepEqual(await missing.json(), { error: "unauthorized" });

  const wrong = await fetch(
    `${base}/api/spotify/status`,
    authorized({ headers: { Authorization: "Bearer wrong-token-that-has-a-different-length" } }),
  );
  assert.equal(wrong.status, 401);

  for (const [path, init] of [
    ["/api/spotify/status?debug=true", authorized()],
    ["/api/spotify/status/", authorized()],
    ["/api/spotify/status", authorized({ method: "POST" })],
    ["/api/spotify/search/", authorized()],
    ["/api/spotify/search", authorized({ method: "POST" })],
  ]) {
    const response = await fetch(`${base}${path}`, init);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
  }
  assert.equal(upstreamCalls, 0);
});

test("the authenticated Pin route forwards only the exact music egress write", async (t) => {
  const calls = [];
  const base = await runningAdapter(t, async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      status: 200,
      headers: { "content-type": "application/json" },
      body_base64: Buffer.from("{}").toString("base64"),
    });
  });
  const body = JSON.stringify({
    provider: "youtube_music",
    method: "POST",
    url: "https://youtubei.googleapis.com/youtubei/v1/player",
    headers: { "content-type": "application/json" },
    body_base64: Buffer.from('{"videoId":"Zi_XLOBDo_Y"}').toString("base64"),
  });
  const response = await fetch(
    `${base}/api/pin-remote/api/music/egress`,
    authorized({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${UPSTREAM_ORIGIN}/api/music/egress`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(Buffer.from(calls[0].init.body).toString("utf8"), body);

  for (const target of [
    "/api/pin-remote/api/music/egress/",
    "/api/pin-remote/api/music/egress?url=https://example.test",
    "/api/pin-remote/api/music/proxy",
  ]) {
    const rejected = await fetch(
      `${base}${target}`,
      authorized({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    assert.equal(rejected.status, 404, target);
  }
  assert.equal(calls.length, 1);
});

test("search forwards only a query it rebuilt itself", async (t) => {
  const requested = [];
  const base = await runningAdapter(t, async (url) => {
    requested.push(url);
    return jsonResponse({
      items: [
        {
          id: "track-1",
          title: "  Blue Monday  ",
          artists: ["New Order", { name: "not a string" }],
          album: "Power, Corruption & Lies",
          duration_ms: 448_000,
          explicit: false,
          // Never part of Center's wire shape, so it must not survive.
          preview_url: "https://p.scdn.co/leak.mp3",
        },
        { id: "", title: "no id" },
      ],
      // Same: a field the projector does not know is dropped, not passed on.
      debug_token: "secret",
    });
  });

  const response = await fetch(
    `${base}/api/spotify/search?q=${encodeURIComponent("  blue monday  ")}`,
    authorized(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    items: [
      {
        id: "track-1",
        title: "Blue Monday",
        artists: ["New Order"],
        album: "Power, Corruption & Lies",
        duration_ms: 448_000,
        explicit: false,
      },
    ],
  });
  // The query the Pin receives is re-encoded from validated values, and the
  // default kind is stated rather than left for the device to infer.
  assert.deepEqual(requested, [
    `${UPSTREAM_ORIGIN}/api/spotify/search?q=blue+monday&kind=track`,
  ]);
});

test("search rejects every query shape it did not sanction, without calling the Pin", async (t) => {
  let upstreamCalls = 0;
  const base = await runningAdapter(t, async () => {
    upstreamCalls += 1;
    return jsonResponse({ items: [] });
  });

  for (const query of [
    "",
    "q=",
    "q=%20%20",
    "q=one&q=two",
    "q=ok&kind=album",
    "q=ok&kind=track&kind=track",
    "q=ok&limit=50",
    `q=${"x".repeat(81)}`,
    "q=bad%00control",
  ]) {
    const response = await fetch(`${base}/api/spotify/search?${query}`, authorized());
    assert.equal(response.status === 400 || response.status === 414, true, query);
    assert.deepEqual(await response.json(), { error: "invalid_search" }, query);
  }

  // An unauthenticated caller gets 401 rather than a validation verdict, so the
  // rejections above cannot be used to map the search boundary anonymously.
  const anonymous = await fetch(`${base}/api/spotify/search?q=ok&limit=50`);
  assert.equal(anonymous.status, 401);

  assert.equal(upstreamCalls, 0);
});

test("search refuses an upstream body that is not a track list", async (t) => {
  const base = await runningAdapter(t, async () => jsonResponse({ tracks: [] }));
  const response = await fetch(`${base}/api/spotify/search?q=ok`, authorized());
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "invalid_upstream_response" });
});

test("forwards canonical settings only and never forwards inbound credentials", async (t) => {
  const calls = [];
  const base = await runningAdapter(t, async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(spotifyStatus({ state: "not_configured", engine_ready: false }));
  });

  const response = await fetch(
    `${base}/api/spotify/settings`,
    authorized({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_name: "  Kitchen Pin  ",
        experimental_acknowledged: true,
        enabled: true,
      }),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${UPSTREAM_ORIGIN}/api/spotify/settings`);
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].init.headers.Cookie, undefined);
  assert.deepEqual(JSON.parse(Buffer.from(calls[0].init.body).toString("utf8")), {
    enabled: true,
    experimental_acknowledged: true,
    device_name: "Kitchen Pin",
  });
});

test("rejects extra settings fields, invalid JSON, and bodies on bodyless routes", async (t) => {
  let upstreamCalls = 0;
  const base = await runningAdapter(t, async () => {
    upstreamCalls += 1;
    return jsonResponse(spotifyStatus());
  });

  const extra = await fetch(
    `${base}/api/spotify/settings`,
    authorized({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        experimental_acknowledged: true,
        device_name: "Ai Pin",
        token: "must-not-pass",
      }),
    }),
  );
  assert.equal(extra.status, 400);
  assert.deepEqual(await extra.json(), { error: "invalid_settings" });

  const invalid = await fetch(
    `${base}/api/spotify/settings`,
    authorized({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{",
    }),
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_json" });

  const unexpectedBody = await fetch(
    `${base}/api/spotify/pairing/start`,
    authorized({ method: "POST", body: "x" }),
  );
  assert.equal(unexpectedBody.status, 413);
  assert.equal(upstreamCalls, 0);
});

test("projects credential-free status fields and bounds upstream responses", async (t) => {
  const base = await runningAdapter(t, async () =>
    jsonResponse({
      ...spotifyStatus(),
      pairing_expires_at: 1_786_000_000,
      last_error: "safe retry message",
      access_token: "must-not-cross-adapter",
      credentials: { reusable: true },
    }),
  );

  const response = await fetch(`${base}/api/spotify/status`, authorized());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const body = await response.json();
  assert.deepEqual(body, {
    ...spotifyStatus(),
    pairing_expires_at: 1_786_000_000,
    last_error: "safe retry message",
  });
  assert.equal("access_token" in body, false);
  assert.equal("credentials" in body, false);

  const oversizedBase = await runningAdapter(t, async () =>
    new Response("x".repeat(adapterContract.maxUpstreamResponseBytes + 1), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const oversized = await fetch(`${oversizedBase}/api/spotify/status`, authorized());
  assert.equal(oversized.status, 502);
  assert.deepEqual(await oversized.json(), { error: "invalid_upstream_response" });
});

test("returns safe upstream failures and a strict disconnect response", async (t) => {
  const rejectedBase = await runningAdapter(t, async () =>
    new Response("raw bridge details must not cross", { status: 409 }),
  );
  const rejected = await fetch(
    `${rejectedBase}/api/spotify/pairing/start`,
    authorized({ method: "POST" }),
  );
  assert.equal(rejected.status, 409);
  const rejectedBody = await rejected.text();
  assert.deepEqual(JSON.parse(rejectedBody), { error: "pin_rejected_spotify_request" });
  assert.doesNotMatch(rejectedBody, /raw bridge details/);

  const disconnectBase = await runningAdapter(t, async () => new Response(null, { status: 204 }));
  const disconnected = await fetch(
    `${disconnectBase}/api/spotify/session`,
    authorized({ method: "DELETE" }),
  );
  assert.equal(disconnected.status, 204);
  assert.equal(await disconnected.text(), "");
});

test("bounds upstream latency and keeps timeout errors generic", async (t) => {
  const base = await runningAdapter(
    t,
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("secret upstream timeout")));
      }),
  );
  const response = await fetch(`${base}/api/spotify/status`, authorized());
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "upstream_timeout" });
});

test("the timeout covers a response body that stalls after its headers", async (t) => {
  const base = await runningAdapter(t, async (_url, init) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"enabled":'));
        init.signal.addEventListener("abort", () => controller.error(new Error("stalled body")));
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const response = await fetch(`${base}/api/spotify/status`, authorized());
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "upstream_timeout" });
});

test("liveness stays healthy while readiness tracks the Pin bridge", async (t) => {
  let unavailableCalls = 0;
  const unavailableBase = await runningAdapter(t, async () => {
    unavailableCalls += 1;
    throw new Error("sensitive bridge failure");
  });

  const healthy = await fetch(`${unavailableBase}/healthz`);
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), { adapter: "ready" });
  assert.equal(unavailableCalls, 0, "liveness must not contact the physical Pin bridge");

  const unavailable = await fetch(`${unavailableBase}/readyz`);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    adapter: "ready",
    upstream: "unavailable",
  });
  assert.equal(unavailableCalls, 1);

  let readyCalls = 0;
  const readyBase = await runningAdapter(t, async () => {
    readyCalls += 1;
    return jsonResponse(spotifyStatus());
  });
  const ready = await fetch(`${readyBase}/readyz`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { adapter: "ready", upstream: "ready" });
  assert.equal(readyCalls, 1);
});

test("remote Pin settings are bearer-authenticated and forwarded without browser credentials", async (t) => {
  const calls = [];
  const base = await runningAdapter(t, async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ server: { display_name: "Living room Pin" } });
  });

  for (const authorization of [undefined, "Bearer definitely-wrong"]) {
    const response = await fetch(`${base}/api/pin-remote/api/settings`, {
      headers: authorization ? { authorization } : undefined,
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  }

  const read = await fetch(`${base}/api/pin-remote/api/settings`, authorized());
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { server: { display_name: "Living room Pin" } });

  const updateBody = JSON.stringify({ server: { display_name: "Desk Pin" } });
  const update = await fetch(
    `${base}/api/pin-remote/api/settings`,
    authorized({
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: "wearer-session=must-not-cross-the-adapter",
      },
      body: updateBody,
    }),
  );
  assert.equal(update.status, 200);

  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map(({ url, init }) => ({ url, method: init.method })),
    [
      { url: `${UPSTREAM_ORIGIN}/api/settings`, method: "GET" },
      { url: `${UPSTREAM_ORIGIN}/api/settings`, method: "PUT" },
    ],
  );
  assert.equal(calls[1].init.headers.Authorization, undefined);
  assert.equal(calls[1].init.headers.Cookie, undefined);
  assert.equal(calls[1].init.headers["Content-Type"], "application/json");
  assert.equal(Buffer.from(calls[1].init.body).toString("utf8"), updateBody);
});

test("remote Pin proxy denies maintenance namespaces and unreviewed methods", async (t) => {
  let upstreamCalls = 0;
  const base = await runningAdapter(t, async () => {
    upstreamCalls += 1;
    return jsonResponse({ ok: true });
  });

  for (const [path, init] of [
    ["/api/pin-remote/api/esim/state", authorized()],
    ["/api/pin-remote/api/cellular/service-status", authorized()],
    ["/api/pin-remote/api/wifi/set-enabled", authorized({ method: "PUT" })],
    ["/api/pin-remote/api/logs/server", authorized()],
    ["/api/pin-remote/api/dev/install", authorized({ method: "POST" })],
    ["/api/pin-remote/api/events", authorized()],
    ["/api/pin-remote/api/settings", authorized({ method: "DELETE" })],
  ]) {
    const response = await fetch(`${base}${path}`, init);
    assert.equal(response.status, 404, `${init.method ?? "GET"} ${path}`);
    assert.deepEqual(await response.json(), { error: "not_found" });
  }
  assert.equal(upstreamCalls, 0);
});

test("remote Pin proxy bounds query, body, and encoded traversal before forwarding", async (t) => {
  let upstreamCalls = 0;
  const base = await runningAdapter(t, async () => {
    upstreamCalls += 1;
    return jsonResponse({ ok: true });
  });

  const longQuery = await fetch(
    `${base}/api/pin-remote/api/conversations?q=${"x".repeat(2_100)}`,
    authorized(),
  );
  assert.equal(longQuery.status, 404);

  const oversizedBody = await fetch(
    `${base}/api/pin-remote/api/settings`,
    authorized({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(adapterContract.maxPinRequestBodyBytes) }),
    }),
  );
  assert.equal(oversizedBody.status, 413);

  for (const path of [
    "/api/pin-remote/api/%2e%2e/settings",
    "/api/pin-remote/api/%252e%252e/settings",
    "/api/pin-remote/api%2fsettings",
  ]) {
    const response = await fetch(`${base}${path}`, authorized());
    assert.equal(response.status, 404, path);
  }
  assert.equal(upstreamCalls, 0);
});

test("remote Pin proxy never exposes bridge 5xx detail", async (t) => {
  const base = await runningAdapter(t, async () =>
    new Response("dial failed through private relay.example.internal", {
      status: 503,
      headers: { "content-type": "text/plain" },
    }),
  );

  const response = await fetch(`${base}/api/pin-remote/api/settings`, authorized());
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: "pin_unavailable" });
  assert.doesNotMatch(text, /dial failed|relay\.example|internal/);
});
