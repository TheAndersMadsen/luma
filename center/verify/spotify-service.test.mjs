import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = async (file) => (await import("node:fs/promises")).readFile(new URL(file, root), "utf8");

const {
  SpotifyBridgeError,
  normalizeSpotifyStatus,
  parseSpotifySearchQuery,
  parseSpotifySettingsDto,
  requireOwnedPairedPin,
  runSpotifyBridgeAction,
  runSpotifySearch,
  unavailableSpotifyStatus,
  deviceMusicProviderFetch,
  deviceMusicGatewayToken,
  isSpotifyUnavailableError,
} = await import("../src/server/spotifyBridge.ts?spotify-service-tests");

const session = {
  sub: "wearer-subject",
  email: "wearer@example.test",
  name: "Wearer",
  operator: false,
};
const DEVICE_ID = "2c2a00010000abcd";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function waitWithSignal(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function delayedAdapterFetch({ headersAfterMs = 0, bodyAfterMs = 0, onBodyRead }) {
  return async (_url, init) => {
    await waitWithSignal(headersAfterMs, init?.signal);
    const encoded = new TextEncoder().encode(JSON.stringify({
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body_base64: Buffer.from('{"playabilityStatus":{"status":"OK"}}').toString("base64"),
    }));
    let bodyReadStarted = false;
    const body = new ReadableStream({
      async pull(controller) {
        if (bodyReadStarted) return;
        bodyReadStarted = true;
        onBodyRead?.();
        try {
          await waitWithSignal(bodyAfterMs, init?.signal);
          controller.enqueue(encoded);
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    }, { highWaterMark: 0 });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function playerRequest() {
  return new Request("https://youtubei.googleapis.com/youtubei/v1/player", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

function configureBridge() {
  process.env.REVIVAL_PIN_BRIDGE_OWNER_SUB = session.sub;
  process.env.REVIVAL_PIN_BRIDGE_DEVICE_ID = DEVICE_ID;
  process.env.COSMOS_WEBAPI_BASE_URL = "http://cosmos.test:8081";
  process.env.COSMOS_ADMIN_TOKEN = "c".repeat(40);
  process.env.REVIVAL_SPOTIFY_ADAPTER_URL = "http://spotify-adapter:18081";
  process.env.REVIVAL_SPOTIFY_ADAPTER_TOKEN = "s".repeat(40);
  process.env.REVIVAL_MUSIC_GATEWAY_ORIGIN = "https://center.example.test";
  delete process.env.REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE;
}

test("YouTube player requests use the authenticated Pin egress route", async () => {
  configureBridge();
  const calls = [];
  const response = await deviceMusicProviderFetch(
    new Request("https://youtubei.googleapis.com/youtubei/v1/player", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-user-agent": "bgutils/4.0.3",
        "x-youtube-client-name": "67",
      },
      body: JSON.stringify({ videoId: "Zi_XLOBDo_Y" }),
    }),
    undefined,
    async (url, init) => {
      calls.push({ url, init });
      return json({
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body_base64: Buffer.from('{"playabilityStatus":{"status":"OK"}}').toString("base64"),
      });
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://spotify-adapter:18081/api/pin-remote/api/music/egress");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${"s".repeat(40)}`);
  const relayed = JSON.parse(calls[0].init.body);
  assert.equal(relayed.provider, "youtube_music");
  assert.equal(relayed.method, "POST");
  assert.equal(relayed.url, "https://youtubei.googleapis.com/youtubei/v1/player");
  assert.equal(relayed.headers["x-user-agent"], "bgutils/4.0.3");
  assert.equal(relayed.headers["x-youtube-client-name"], "67");
  assert.equal(
    Buffer.from(relayed.body_base64, "base64").toString("utf8"),
    '{"videoId":"Zi_XLOBDo_Y"}',
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { playabilityStatus: { status: "OK" } });
});

test("YouTube Pin egress stops a chunked request body at its byte limit", async () => {
  configureBridge();
  let adapterCalls = 0;
  let bodyCancelled = false;
  let pulls = 0;
  const chunkBytes = 64 * 1024;
  const request = new Request("https://youtubei.googleapis.com/youtubei/v1/player", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls > 10) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(chunkBytes));
      },
      cancel() {
        bodyCancelled = true;
      },
    }, { highWaterMark: 0 }),
    duplex: "half",
  });

  await assert.rejects(
    () => deviceMusicProviderFetch(request, undefined, async () => {
      adapterCalls += 1;
      throw new Error("oversized provider request reached the adapter");
    }),
    (error) =>
      error instanceof SpotifyBridgeError &&
      error.status === 413 &&
      error.message === "Music provider request was too large.",
  );

  assert.equal(adapterCalls, 0);
  assert.equal(bodyCancelled, true);
  assert.equal(pulls, 9);
});

test("YouTube Pin egress cancels a stalled request body at the caller deadline", async () => {
  configureBridge();
  const bodyStarted = Promise.withResolvers();
  const deadline = new AbortController();
  let adapterCalls = 0;
  let bodyCancelReason;
  let fallback;
  const request = new Request("https://youtubei.googleapis.com/youtubei/v1/player", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      pull(controller) {
        bodyStarted.resolve();
        fallback = setTimeout(() => controller.close(), 250);
      },
      cancel(reason) {
        clearTimeout(fallback);
        bodyCancelReason = reason;
      },
    }, { highWaterMark: 0 }),
    duplex: "half",
    signal: deadline.signal,
  });
  const pending = deviceMusicProviderFetch(request, undefined, async () => {
    adapterCalls += 1;
    throw new Error("cancelled provider request reached the adapter");
  });

  await bodyStarted.promise;
  const timeoutError = new DOMException("playback deadline", "TimeoutError");
  const startedAt = performance.now();
  deadline.abort(timeoutError);

  await assert.rejects(() => pending, (error) => error === timeoutError);
  assert.ok(performance.now() - startedAt < 150, "request body ignored the playback deadline");
  assert.equal(bodyCancelReason, timeoutError);
  assert.equal(adapterCalls, 0);
});

test("YouTube Pin egress uses the caller's deadline for delayed headers and bodies", async () => {
  configureBridge();
  const timedOut = (error) =>
    error?.name === "TimeoutError" ||
    (error instanceof SpotifyBridgeError && error.code === "adapter_unavailable");

  await assert.rejects(
    () => deviceMusicProviderFetch(
      playerRequest(),
      { signal: AbortSignal.timeout(10) },
      delayedAdapterFetch({ headersAfterMs: 30 }),
    ),
    timedOut,
  );
  const bodyRead = Promise.withResolvers();
  const bodyDeadline = new AbortController();
  const delayedBodyRequest = deviceMusicProviderFetch(
    playerRequest(),
    { signal: bodyDeadline.signal },
    delayedAdapterFetch({ bodyAfterMs: 30, onBodyRead: bodyRead.resolve }),
  );
  await bodyRead.promise;
  bodyDeadline.abort(new DOMException("deadline", "TimeoutError"));
  await assert.rejects(() => delayedBodyRequest, timedOut);
  let stalledBodyCancelled = false;
  const stalledController = new AbortController();
  const stalledTimer = setTimeout(
    () => stalledController.abort(new DOMException("deadline", "TimeoutError")),
    10,
  );
  try {
    await assert.rejects(
      () => deviceMusicProviderFetch(
        playerRequest(),
        { signal: stalledController.signal },
        async () => new Response(new ReadableStream({
          cancel() {
            stalledBodyCancelled = true;
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
      timedOut,
    );
  } finally {
    clearTimeout(stalledTimer);
  }
  assert.equal(stalledBodyCancelled, true);

  const response = await deviceMusicProviderFetch(
    playerRequest(),
    { signal: AbortSignal.timeout(500) },
    delayedAdapterFetch({ headersAfterMs: 10, bodyAfterMs: 20 }),
  );
  assert.deepEqual(await response.json(), { playabilityStatus: { status: "OK" } });
});

test("sequential YouTube Pin egress calls share one absolute playback budget", async () => {
  configureBridge();
  const sharedSignal = AbortSignal.timeout(200);
  const fetchImpl = delayedAdapterFetch({ headersAfterMs: 120 });

  await deviceMusicProviderFetch(playerRequest(), { signal: sharedSignal }, fetchImpl);
  await assert.rejects(
    () => deviceMusicProviderFetch(playerRequest(), { signal: sharedSignal }, fetchImpl),
    (error) =>
      error?.name === "TimeoutError" ||
      (error instanceof SpotifyBridgeError && error.code === "adapter_unavailable"),
  );
});

test("YouTube Pin egress deadline includes the mounted adapter-token read", async (t) => {
  configureBridge();
  const directory = await mkdtemp(path.join(tmpdir(), "revival-spotify-token-deadline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, "adapter-token");
  execFileSync("mkfifo", [tokenFile]);
  process.env.REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE = tokenFile;
  t.after(() => delete process.env.REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE);

  const deadline = new AbortController();
  let adapterCalls = 0;
  const providerRequest = deviceMusicProviderFetch(
    playerRequest(),
    { signal: deadline.signal },
    async () => {
      adapterCalls += 1;
      return json({
        status: 200,
        headers: { "content-type": "application/json" },
        body_base64: Buffer.from("{}").toString("base64"),
      });
    },
  );
  const writer = await open(tokenFile, "w");
  const timeoutError = new DOMException("playback deadline", "TimeoutError");
  deadline.abort(timeoutError);
  const settledBeforeToken = await Promise.race([
    providerRequest.then(() => true, () => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 75)),
  ]);

  await writer.writeFile("f".repeat(48));
  await writer.close();

  assert.equal(settledBeforeToken, true);
  await assert.rejects(() => providerRequest, (error) => error === timeoutError);
  assert.equal(adapterCalls, 0);
});

test("the Pin egress route cannot relay provider audio or account headers", async () => {
  configureBridge();
  let networkCalls = 0;
  const fetchImpl = async () => {
    networkCalls += 1;
    return json({ status: 200, headers: {}, body_base64: "" });
  };
  for (const request of [
    new Request("https://r1---sn.example.googlevideo.com/videoplayback?id=fixture"),
    new Request("https://example.test/player"),
    new Request("https://youtubei.googleapis.com/youtubei/v1/player", {
      method: "POST",
      headers: { authorization: "Bearer must-not-leave-center" },
      body: "{}",
    }),
  ]) {
    await assert.rejects(
      deviceMusicProviderFetch(request, undefined, fetchImpl),
      /Music provider request was rejected/,
    );
  }
  assert.equal(networkCalls, 0);
});

test("settings DTO accepts only safe Pin-native settings", () => {
  assert.deepEqual(
    parseSpotifySettingsDto({
      active_provider: "spotify",
      enabled: true,
      experimental_acknowledged: true,
      device_name: "  Anders’ Ai Pin  ",
    }),
    {
      active_provider: "spotify",
      enabled: true,
      experimental_acknowledged: true,
      device_name: "Anders’ Ai Pin",
    },
  );

  assert.deepEqual(
    parseSpotifySettingsDto({
      active_provider: "tidal",
      enabled: false,
      experimental_acknowledged: false,
      device_name: "Ai Pin",
    }),
    {
      active_provider: "tidal",
      enabled: false,
      experimental_acknowledged: false,
      device_name: "Ai Pin",
    },
  );

  for (const invalid of [
    { enabled: false, experimental_acknowledged: false, device_name: "Ai Pin" },
    { enabled: true, experimental_acknowledged: false, device_name: "Ai Pin" },
    { active_provider: "tidal", enabled: true, experimental_acknowledged: false, device_name: "Ai Pin" },
    { enabled: true, experimental_acknowledged: true, device_name: "" },
    {
      enabled: true,
      experimental_acknowledged: true,
      device_name: "Ai Pin",
      access_token: "never",
    },
  ]) {
    assert.throws(() => parseSpotifySettingsDto(invalid), SpotifyBridgeError);
  }
});

test("status normalization drops secrets and unexpected fields", () => {
  const normalized = normalizeSpotifyStatus({
    active_provider: "youtube_music",
    enabled: true,
    experimental_acknowledged: true,
    state: "ready",
    device_name: "Ai Pin",
    username: "listener",
    engine_ready: false,
    last_error: "Reconnecting",
    reusable_credential: "must-not-leave-the-pin",
    access_token: "must-not-leave-the-pin",
  });
  assert.deepEqual(normalized, {
    active_provider: "youtube_music",
    enabled: true,
    experimental_acknowledged: true,
    state: "ready",
    device_name: "Ai Pin",
    username: "listener",
    engine_ready: false,
    last_error: "Reconnecting",
  });
  assert.doesNotMatch(JSON.stringify(normalized), /credential|access_token|must-not/);
  assert.throws(
    () => normalizeSpotifyStatus({
      enabled: true,
      experimental_acknowledged: true,
      state: "ready",
      device_name: "Ai Pin",
      engine_ready: true,
    }),
    SpotifyBridgeError,
  );
});

test("unavailable status exposes only bounded recovery guidance", () => {
  assert.deepEqual(unavailableSpotifyStatus("pairing_unconfirmed"), {
    active_provider: "spotify",
    enabled: false,
    experimental_acknowledged: false,
    state: "unavailable",
    device_name: "Ai Pin",
    engine_ready: false,
    unavailable_reason: "pairing_unconfirmed",
  });
  assert.equal(
    isSpotifyUnavailableError(
      new SpotifyBridgeError(
        "pin_not_paired",
        409,
        "Pair your Ai Pin before choosing a default music provider.",
      ),
    ),
    true,
  );
});

test("bridge binds a signed wearer to the deployment owner and durable Pin roster", async () => {
  configureBridge();
  const calls = [];
  const fetchMock = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/demo-api/admin/devices")) {
      return json({ pairings: [{ account_sub: session.sub, device_id: DEVICE_ID }] });
    }
    return json({
      active_provider: "spotify",
      enabled: false,
      experimental_acknowledged: false,
      state: "disabled",
      device_name: "Ai Pin",
      engine_ready: false,
      secret: "never serialize this",
    });
  };

  const result = await runSpotifyBridgeAction(session, "status", undefined, fetchMock);
  assert.equal(result.state, "disabled");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://cosmos.test:8081/demo-api/admin/devices");
  assert.equal(calls[1].url, "http://spotify-adapter:18081/api/spotify/status");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), `Bearer ${"c".repeat(40)}`);
  assert.equal(new Headers(calls[1].init.headers).get("authorization"), `Bearer ${"s".repeat(40)}`);
  assert.doesNotMatch(JSON.stringify(result), /secret|never serialize/);

  let fetched = false;
  await assert.rejects(
    () => requireOwnedPairedPin({ ...session, sub: "another-wearer" }, async () => {
      fetched = true;
      return json({ pairings: [] });
    }),
    (error) => error instanceof SpotifyBridgeError && error.code === "wrong_owner" && error.status === 403,
  );
  assert.equal(fetched, false);
});

test("bridge rejects an owner without a paired Pin", async () => {
  configureBridge();
  await assert.rejects(
    () => requireOwnedPairedPin(session, async () => json({
      pairings: [{ account_sub: "someone-else", device_id: "0011223344556677" }],
    })),
    (error) => error instanceof SpotifyBridgeError && error.code === "pin_not_paired" && error.status === 409,
  );
});

test("single-target bridge requires the exact one rostered device", async () => {
  configureBridge();
  process.env.REVIVAL_PIN_BRIDGE_DEVICE_ID = "aabbccdd";
  for (const pairings of [
    [{ account_sub: session.sub, device_id: "00112233" }],
    [
      { account_sub: session.sub, device_id: "aabbccdd" },
      { account_sub: session.sub, device_id: "eeff0011" },
    ],
  ]) {
    await assert.rejects(
      () => requireOwnedPairedPin(session, async () => json({ pairings })),
      (error) =>
        error instanceof SpotifyBridgeError &&
        error.code === "pin_binding_invalid" &&
        error.status === 409,
    );
  }
});

test("bridge device ids follow Cosmos hexadecimal grammar and lowercase normalization", async () => {
  configureBridge();
  const canonicalToken = await deviceMusicGatewayToken();
  process.env.REVIVAL_PIN_BRIDGE_DEVICE_ID = DEVICE_ID.toUpperCase();
  assert.equal(await deviceMusicGatewayToken(), canonicalToken);
  await requireOwnedPairedPin(session, async () => json({
    pairings: [{ account_sub: session.sub, device_id: DEVICE_ID }],
  }));

  for (const invalid of ["owned-pin", "🔒", " "]) {
    process.env.REVIVAL_PIN_BRIDGE_DEVICE_ID = invalid;
    await assert.rejects(
      () => deviceMusicGatewayToken(),
      (error) => error instanceof SpotifyBridgeError && error.code === "bridge_not_configured",
    );
  }
});

test("Pin request rejection remains distinct from adapter unavailability", async () => {
  configureBridge();
  let calls = 0;
  await assert.rejects(
    () => runSpotifyBridgeAction(session, "pair", undefined, async (url) => {
      calls += 1;
      if (String(url).endsWith("/demo-api/admin/devices")) {
        return json({ pairings: [{ account_sub: session.sub, device_id: DEVICE_ID }] });
      }
      return json({ error: "pin_rejected_spotify_request" }, 409);
    }),
    (error) =>
      error instanceof SpotifyBridgeError &&
      error.code === "pin_rejected" &&
      error.status === 409,
  );
  assert.equal(calls, 2);
});

test("mounted adapter token derives a distinct server-only music gateway bearer", async (t) => {
  configureBridge();
  const directory = await mkdtemp(path.join(tmpdir(), "revival-spotify-center-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = "f".repeat(48);
  const tokenFile = path.join(directory, "adapter-token");
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  process.env.REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE = tokenFile;
  process.env.REVIVAL_SPOTIFY_ADAPTER_TOKEN = "wrong-environment-token".repeat(2);

  const calls = [];
  const fetchMock = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/demo-api/admin/devices")) {
      return json({ pairings: [{ account_sub: session.sub, device_id: DEVICE_ID }] });
    }
    return json({
      active_provider: "youtube_music",
      enabled: true,
      experimental_acknowledged: true,
      state: "not_configured",
      device_name: "Living Room Pin",
      engine_ready: false,
    });
  };
  const settings = parseSpotifySettingsDto({
    active_provider: "youtube_music",
    enabled: true,
    experimental_acknowledged: true,
    device_name: "Living Room Pin",
  });
  await runSpotifyBridgeAction(session, "settings", settings, fetchMock);

  const adapter = calls[1];
  assert.equal(adapter.url, "http://spotify-adapter:18081/api/spotify/settings");
  assert.equal(adapter.init.method, "PUT");
  assert.equal(new Headers(adapter.init.headers).get("authorization"), `Bearer ${token}`);
  const forwarded = JSON.parse(String(adapter.init.body));
  assert.deepEqual(forwarded, {
    ...settings,
    music_gateway_url: "https://center.example.test",
    music_gateway_token: await deviceMusicGatewayToken(),
  });
  assert.notEqual(forwarded.music_gateway_token, token);
  assert.doesNotMatch(String(adapter.init.body), /secret|account|device_id/i);
});

test("Center routes require session, owner roster and same-origin mutations", async () => {
  const [route, pair, cancel, support, bridge] = await Promise.all([
    source("src/app/api/settings/services/spotify/route.ts"),
    source("src/app/api/settings/services/spotify/pair/route.ts"),
    source("src/app/api/settings/services/spotify/cancel/route.ts"),
    source("src/app/api/settings/services/spotify/routeSupport.ts"),
    source("src/server/spotifyBridge.ts"),
  ]);

  assert.match(route, /export async function GET/);
  assert.match(route, /export async function PATCH/);
  assert.match(route, /export async function DELETE/);
  assert.match(pair, /export async function POST/);
  assert.match(cancel, /export async function POST/);
  for (const mutation of [route, pair, cancel]) assert.match(mutation, /requireSameOrigin/);
  assert.match(support, /verifySession/);
  assert.match(support, /AUTH_ENABLED/);
  assert.match(support, /SETTINGS_BODY_TIMEOUT_MS = 3_000/);
  assert.match(bridge, /REVIVAL_PIN_BRIDGE_OWNER_SUB/);
  assert.match(bridge, /REVIVAL_PIN_BRIDGE_DEVICE_ID/);
  assert.match(bridge, /account_sub === session\.sub/);
  assert.match(bridge, /const DEFAULT_TIMEOUT_MS = 10_000/);
  assert.match(bridge, /const MAX_TIMEOUT_MS = 10_000/);
  assert.match(bridge, /callAdapter[\s\S]+signal: AbortSignal\.timeout\(timeoutMs\(\)\)/);
  assert.match(route, /musicProviderStatus\(session\.sub\)\.catch\(\(\) => undefined\)/);
  assert.match(route, /spotifyError\(error, true, providers\)/);
  assert.match(route, /settings\.active_provider === "apple_music"/);
  assert.match(route, /native Pin playback is not available yet/);
  assert.match(support, /code === "pin_not_paired"/);
  assert.doesNotMatch(bridge, /Pair your Ai Pin before setting up Spotify/);
  assert.doesNotMatch(bridge, /client_secret|refresh_token|access_token|Spotify Accounts/);
});

test("Services renders every Pin-native state, polling and settings fallback", async () => {
  const [page, view, registry, styles] = await Promise.all([
    source("src/app/settings/account/services/page.tsx"),
    source("src/app/settings/account/services/SpotifyServiceCard.tsx"),
    source("src/app/settings/settingsRegistry.ts"),
    source("src/app/settings/account/services/services.module.css"),
  ]);
  assert.match(page, /SpotifyServiceCard/);
  assert.match(registry, /menu-services-link/);
  for (const state of [
    "disabled",
    "not_configured",
    "pairing",
    "ready",
    "unavailable",
    "error",
  ]) {
    assert.match(view, new RegExp(`\\"${state}\\"`));
  }
  assert.match(view, /POLL_INTERVAL_MS = 2_500/);
  assert.match(view, /PAIRING_WINDOW_MS = 2 \* 60 \* 1_000/);
  assert.match(view, /BROWSER_REQUEST_TIMEOUT_MS = 12_000/);
  assert.match(view, /draftInitializedRef/);
  assert.match(view, /activeRequestRef/);
  assert.match(view, /pollOnly && activeRequestRef\.current/);
  assert.match(view, /unavailable_reason/);
  assert.match(view, /I understand this is for personal testing and requires Spotify Premium/);
  // The unavailable fallback points into Center's own Pin console, never out to
  // the retired Setup SPA (a react-router hash target that no server ever sees)
  // and never back at this card, which is the surface that just failed.
  assert.doesNotMatch(view, /Open Pin Setup/);
  assert.doesNotMatch(view, /\/setup\//);
  assert.match(view, /href="\/settings\/pin"/);
  assert.match(view, /Open connection & maintenance/);
  assert.doesNotMatch(view, /aipin\.andersmadsen\.dk/);
  assert.match(view, /fallback_setup/);
  assert.match(view, /<strong>Music providers<\/strong>/);
  assert.match(view, /Connect Spotify, YouTube Music, or TIDAL, then choose the default/);
  assert.match(view, /Apple Music playback is unavailable until its official Android runtime exists/);
  assert.match(view, /disabled=\{!provider\.playbackAvailable\}/);
  assert.match(view, /Pair My Ai Pin/);
  assert.match(view, /status\.state === "unavailable"/);
  assert.match(view, /providerAccountState\(status, activeProvider\)/);
  assert.match(view, /\$\{providerLabel\} is connected to Center/);
  assert.match(view, /Waiting for sign-in…/);
  assert.match(view, /Provider account/);
  assert.match(view, /connectedProvider/);
  assert.match(view, /— Connected/);
  assert.match(styles, /\.deviceCode \.pairingTimer\s*\{[^}]*display: grid;[^}]*place-items: center;/s);
  assert.doesNotMatch(styles, /\.providerNote span\s*\{/);
  assert.doesNotMatch(view, /Pair your Ai Pin before setting up Spotify/);
  assert.doesNotMatch(view, /<strong>\{providerOption\(activeProvider\)\.label\}<\/strong>/);
  assert.match(view, /window\.confirm\("Disconnect Spotify from this Ai Pin\?"\)/);
  for (const provider of ["Spotify", "YouTube Music", "Apple Music", "TIDAL"]) {
    assert.match(view, new RegExp(provider));
  }
  assert.match(view, /active_provider/);
  assert.doesNotMatch(view, /next\.active_provider \|\| "spotify"/);
  assert.doesNotMatch(view, /Metrolist|install the app on the Pin|provider app owns its login/i);
  assert.match(view, /Player resolution and audio bytes use your Pin/);
  assert.match(view, /stock Music player handles playback/);
  assert.doesNotMatch(`${page}\n${view}`, /client secret|developer OAuth/i);
});

/*
 * The search path, which is the only place a wearer's own text reaches the Pin.
 *
 * Its risk is not the query — the device handler reads `q` and `kind` and
 * touches nothing else — it is that adding a query-bearing route to
 * PIN_SPOTIFY_PATHS makes the bridge look like somewhere a general passthrough
 * could grow. The cases below hold the three things that stop it becoming one:
 * the allowlist is still an exhaustive table of literal paths, the query is
 * validated before anything is sent anywhere, and the answer is projected field
 * by field rather than forwarded.
 */

test("search query validation runs before anything reaches the network", async () => {
  configureBridge();
  assert.equal(parseSpotifySearchQuery("  blue monday  "), "blue monday");

  for (const invalid of ["", "   ", 42, null, "x".repeat(81), "bad\u0000control"]) {
    assert.throws(
      () => parseSpotifySearchQuery(invalid),
      (error) => error instanceof SpotifyBridgeError && error.status === 400,
    );
  }

  // A rejected query must not even reach the pairing roster: an unbounded
  // string is refused on this side of every outbound call.
  let calls = 0;
  await assert.rejects(
    () =>
      runSpotifySearch(session, "x".repeat(81), async () => {
        calls += 1;
        return json({ items: [] });
      }),
    (error) => error instanceof SpotifyBridgeError && error.status === 400,
  );
  assert.equal(calls, 0);
});

test("search rides the ownership gate and forwards only q and kind", async () => {
  configureBridge();
  const calls = [];
  const result = await runSpotifySearch(session, "  blue monday  ", async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/demo-api/admin/devices")) {
      return json({ pairings: [{ account_sub: session.sub, device_id: DEVICE_ID }] });
    }
    return json({
      items: [
        {
          id: "track-1",
          title: "Blue Monday",
          artists: ["New Order", 7],
          album: "Power, Corruption & Lies",
          duration_ms: 448_000,
          explicit: false,
          preview_url: "https://p.scdn.co/leak.mp3",
          access_token: "must-not-leave-the-pin",
        },
      ],
      reusable_credential: "must-not-leave-the-pin",
    });
  });

  assert.deepEqual(result, {
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
  assert.doesNotMatch(JSON.stringify(result), /credential|access_token|preview_url|scdn/);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://cosmos.test:8081/demo-api/admin/devices");
  assert.equal(calls[1].url, "http://spotify-adapter:18081/api/spotify/search?q=blue+monday&kind=track");
  assert.equal(calls[1].init.method, "GET");
  assert.equal(new Headers(calls[1].init.headers).get("authorization"), `Bearer ${"s".repeat(40)}`);

  // A wearer who is not the deployment's Pin owner cannot search either.
  await assert.rejects(
    () =>
      runSpotifySearch({ ...session, sub: "another-wearer" }, "anything", async () =>
        json({ pairings: [] }),
      ),
    (error) => error instanceof SpotifyBridgeError && error.code === "wrong_owner",
  );
});

test("search refuses a body that is not a bounded track list", async () => {
  configureBridge();
  const roster = { pairings: [{ account_sub: session.sub, device_id: DEVICE_ID }] };
  const withBody = (body, status = 200) => async (url) =>
    String(url).endsWith("/demo-api/admin/devices") ? json(roster) : json(body, status);

  for (const body of [{ tracks: [] }, [], null, { items: "nope" }]) {
    await assert.rejects(
      () => runSpotifySearch(session, "ok", withBody(body)),
      (error) => error instanceof SpotifyBridgeError,
    );
  }

  // Nameless rows are dropped rather than rendered as blanks, and the list is
  // capped at the ten results the device's own search returns. The cap is
  // applied to the INPUT, before any row is inspected — so an oversized body
  // costs a bounded amount of work, and a dropped row leaves nine rather than
  // pulling an eleventh up to backfill it.
  const oversized = await runSpotifySearch(
    session,
    "ok",
    withBody({
      items: [
        { id: "", title: "no id" },
        { id: "keep", title: "  Kept  " },
        ...Array.from({ length: 20 }, (_, index) => ({
          id: `filler-${index}`,
          title: `Filler ${index}`,
        })),
      ],
    }),
  );
  assert.equal(oversized.items.length, 9);
  assert.deepEqual(oversized.items[0], { id: "keep", title: "Kept", artists: [] });

  await assert.rejects(
    () => runSpotifySearch(session, "ok", withBody({ error: "nope" }, 429)),
    (error) => error instanceof SpotifyBridgeError && error.status === 429,
  );
});

test("the search route and card stay gated, bounded and read-only", async () => {
  const [bridge, route, view] = await Promise.all([
    source("src/server/spotifyBridge.ts"),
    source("src/app/api/settings/services/spotify/search/route.ts"),
    source("src/app/settings/account/services/SpotifyServiceCard.tsx"),
  ]);

  // The allowlist stays an exhaustive table of literal method/path pairs. A
  // template, a spread or an index expression appearing inside it is how a
  // passthrough would arrive, so none of them may.
  const allowlistStart = bridge.indexOf("const PIN_SPOTIFY_PATHS");
  const allowlist = bridge.slice(allowlistStart, bridge.indexOf("} as const;", allowlistStart));
  assert.match(allowlist, /search: \{ method: "GET", path: "\/api\/spotify\/search" \}/);
  assert.doesNotMatch(allowlist, /\$\{|\.\.\.|\[/);
  assert.equal((allowlist.match(/path: "/g) ?? []).length, 6);
  // Playback, saving and the per-track audio diagnostics stay unreachable.
  assert.doesNotMatch(bridge, /"\/api\/spotify\/(play|save|diagnostics)/);

  // Search is excluded from the status-shaped action union, so it cannot be
  // driven through runSpotifyBridgeAction and normalized as a status.
  assert.match(bridge, /Exclude<keyof typeof PIN_SPOTIFY_PATHS, "search">/);
  assert.match(bridge, /const SPOTIFY_SEARCH_KIND = "track"/);
  assert.match(bridge, /MAX_SPOTIFY_SEARCH_QUERY_CHARACTERS = 80/);

  /*
   * The route is a read, but a read that makes the Pin call Spotify on the
   * wearer's account — so it still needs a signed, same-origin request.
   *
   * Asserted as CALLS, and as calls that precede the search. Matching the bare
   * names matches the import list too, so a route that imports both helpers and
   * invokes neither satisfied the earlier form of this check while answering
   * any caller on the internet.
   */
  assert.match(route, /const session = await requireSpotifySession\(\);/);
  assert.match(route, /if \(session instanceof Response\) return session;/);
  assert.match(route, /const originError = requireSameOrigin\(request\);/);
  assert.match(route, /if \(originError\) return originError;/);
  assert.ok(
    route.indexOf("requireSpotifySession()") <
      route.indexOf("requireSameOrigin(request)") &&
      route.indexOf("requireSameOrigin(request)") < route.indexOf("runSpotifySearch("),
    "both gates must run before the Pin is asked to search",
  );
  assert.match(route, /export async function GET/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);

  assert.match(view, /SpotifySearchCheck/);
  assert.match(view, /MAX_SEARCH_QUERY_CHARACTERS = 80/);
  assert.match(view, /Nothing plays and nothing changes/);
});
