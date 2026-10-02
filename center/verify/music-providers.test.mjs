import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FormatUtils, Innertube, Misc, Platform, Player, YTMusic, YTNodes } from "youtubei.js";

const root = new URL("../", import.meta.url);
const source = async (file) => readFile(new URL(file, root), "utf8");

/*
 * The wearer's music accounts live in Cosmos (`music_api.rs`). These tests run
 * the provider gateway against an in-memory stand-in for that surface, and
 * every other network request goes to the handler a test installs with
 * `useProviderFetch`.
 */
const COSMOS = "http://cosmos.test:8081";
const COSMOS_DEADLINE_MS = 5_000;
/** Who a web-plane call speaks for here: no browser session exists in a test. */
const WEB_WEARER = "center-wearer";
process.env.COSMOS_WEBAPI_BASE_URL = COSMOS;
process.env.COSMOS_EDGE_TOKEN = "edge-proof";
process.env.COSMOS_PRINCIPAL = `U:${WEB_WEARER}`;
process.env.COSMOS_DEADLINE_MS = String(COSMOS_DEADLINE_MS);

const accounts = await import("../src/server/musicAccounts.ts");
const youtube = await import("../src/server/youtubeMusic.ts");
const youtubeProof = await import("../src/server/youtubePoToken.ts");
const youtubePlayer = await import("../src/server/youtubePlayerEvaluator.ts");
const tidal = await import("../src/server/tidalMusic.ts");
const apple = await import("../src/server/appleMusic.ts");
const gateway = await import("../src/server/musicGateway.ts");
const spotifyBridge = await import("../src/server/spotifyBridge.ts");
const playbackRoute = await import("../src/app/api/music-gateway/playback/route.ts");
const routeSupport = await import("../src/app/api/music-gateway/routeSupport.ts");
const internalQuery = await import("../src/app/api/internal/music/query/routeSupport.ts");
const { setLogSinkForTests } = await import("../src/server/log.ts");
setLogSinkForTests(() => {});

const cosmos = {
  /** principal -> { active_provider, revision, accounts } */
  wearers: new Map(),
  requests: [],
  /** Runs after a credentials read took its snapshot, before it answers. */
  afterRead: null,
  down: false,
};

function cosmosWearer(principal) {
  let wearer = cosmos.wearers.get(principal);
  if (!wearer) {
    wearer = { active_provider: "spotify", revision: 0, accounts: {} };
    cosmos.wearers.set(principal, wearer);
  }
  return wearer;
}

/** The summary rule `music_api.rs` pins (`tidal_is_linked_while_its_token_is_fresh_or_renewable`). */
function summaryOf(wearer) {
  const now = Date.now();
  const { youtube_music: youtubeLink, tidal: tidalLink, apple_music: appleLink } = wearer.accounts;
  const tidalLinked = Boolean(
    tidalLink?.credentials &&
      (tidalLink.credentials.refresh_token || tidalLink.credentials.expires_at > now + 60_000),
  );
  return {
    active_provider: wearer.active_provider,
    youtube_music: {
      linked: Boolean(youtubeLink),
      ...(youtubeLink ? { connected_at: youtubeLink.connected_at } : {}),
    },
    tidal: {
      linked: tidalLinked,
      connecting: Boolean(tidalLink?.pending && tidalLink.pending.expires_at > now),
      ...(tidalLinked && tidalLink.connected_at ? { connected_at: tidalLink.connected_at } : {}),
    },
    apple_music: {
      linked: Boolean(appleLink),
      ...(appleLink ? { connected_at: appleLink.connected_at } : {}),
    },
  };
}

async function fakeCosmos(input, init) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const body = request.method === "GET" ? undefined : await request.json();
  const headers = Object.fromEntries(request.headers);
  cosmos.requests.push({ method: request.method, path: url.pathname, headers, body });
  if (cosmos.down) return new Response("the store is unavailable", { status: 503 });
  const principal = headers["x-forwarded-client-cert"];
  if (url.pathname === "/account-service/music-providers/credentials") {
    if (headers["x-cosmos-edge-token"] !== "edge-proof" || headers.authorization) {
      return new Response(null, { status: 403 });
    }
    const wearer = cosmosWearer(principal);
    if (request.method === "GET") {
      const snapshot = { revision: wearer.revision, accounts: structuredClone(wearer.accounts) };
      const pause = cosmos.afterRead;
      cosmos.afterRead = null;
      await pause?.();
      return Response.json(snapshot);
    }
    if (body.revision !== wearer.revision) return new Response("stale", { status: 409 });
    wearer.accounts = structuredClone(body.accounts);
    wearer.revision += 1;
    return Response.json({ revision: wearer.revision });
  }
  if (url.pathname === "/account-service/music-providers") {
    return Response.json(summaryOf(cosmosWearer(principal)));
  }
  if (url.pathname === "/account-service/music-providers/active") {
    const wearer = cosmosWearer(principal);
    wearer.active_provider = body.provider;
    return Response.json(summaryOf(wearer));
  }
  const artwork = /^\/music\/artwork\/([^/]+)\/([^/]+)$/u.exec(url.pathname);
  if (artwork?.[1] === "youtube_music") {
    return Response.json({ url: `https://i.ytimg.com/vi/${artwork[2]}/hqdefault.jpg` });
  }
  if (artwork?.[1] === "spotify") return Response.json({ url: "http://i.scdn.co/image/insecure" });
  return new Response(null, { status: 404 });
}

let providerFetch = async (input) => {
  throw new Error(`unexpected network request: ${input instanceof Request ? input.url : input}`);
};
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return url.origin === COSMOS ? fakeCosmos(input, init) : providerFetch(input, init);
};

/** Answer this test's non-Cosmos requests with `handler`. */
function useProviderFetch(t, handler) {
  const previous = providerFetch;
  providerFetch = handler;
  t.after(() => {
    providerFetch = previous;
  });
}

/** A fresh, empty Cosmos for this test. */
function cosmosAccounts(t) {
  cosmos.wearers.clear();
  cosmos.requests = [];
  cosmos.afterRead = null;
  cosmos.down = false;
  t.after(() => {
    cosmos.down = false;
    cosmos.afterRead = null;
  });
}

function environment(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

async function configuredPinBridge(t, owner = "owner-subject") {
  const directory = await mkdtemp(path.join(tmpdir(), "luma-music-bridge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, "bridge-token");
  fs.writeFileSync(tokenFile, `${"p".repeat(40)}\n`, { mode: 0o600 });
  environment(t, "LUMA_PIN_BRIDGE_URL", "http://pin-bridge.test:18080");
  environment(t, "LUMA_PIN_BRIDGE_TOKEN_FILE", tokenFile);
  environment(t, "COSMOS_WEBAPI_BASE_URL", COSMOS);
  environment(t, "COSMOS_ADMIN_TOKEN", "c".repeat(40));
  return async (url) => {
    if (String(url).endsWith("/__control/status")) {
      return Response.json({
        schema_version: 1,
        local_endpoint_id: "a".repeat(64),
        configured: true,
        device_id: "2c2a00010000abcd",
        remote_endpoint_id: "b".repeat(64),
        connected: true,
        generation: 1,
        protocol: "penumbra-remote-center-v1",
      });
    }
    return Response.json({
      pairings: [{ account_sub: owner, device_id: "2c2a00010000abcd" }],
    });
  };
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

function delayedJsonBody(value, milliseconds, onCancel, onPull) {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  let timer;
  let started = false;
  return new Response(new ReadableStream({
    pull(controller) {
      if (started) return;
      started = true;
      onPull?.();
      timer = setTimeout(() => {
        timer = undefined;
        controller.enqueue(encoded);
        controller.close();
      }, milliseconds);
    },
    cancel(reason) {
      if (timer !== undefined) clearTimeout(timer);
      onCancel?.(reason);
    },
  }, { highWaterMark: 0 }), {
    headers: { "content-type": "application/json" },
  });
}

const youtubeLink = (refreshToken = "youtube-refresh-token") => ({
  connected_at: "2026-08-25T00:00:00.000Z",
  credentials: {
    access_token: "youtube-access-token",
    refresh_token: refreshToken,
    expiry_date: "2026-08-26T00:00:00.000Z",
  },
});

test("the gateway keeps no music account: it reads and writes Cosmos as the wearer, with the edge proof", async (t) => {
  cosmosAccounts(t);
  const subject = "cosmos-wearer";
  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    youtube_music: youtubeLink("youtube-refresh-token-kept-in-cosmos"),
  }));

  const [read, write] = cosmos.requests;
  for (const request of [read, write]) {
    assert.equal(request.path, "/account-service/music-providers/credentials");
    assert.equal(request.headers["x-forwarded-client-cert"], "U:cosmos-wearer");
    assert.equal(request.headers["x-cosmos-edge-token"], "edge-proof");
    assert.equal(request.headers.authorization, undefined, "never the admin token or a browser bearer");
  }
  assert.equal(read.method, "GET");
  assert.equal(write.method, "PUT");
  assert.deepEqual(write.body, {
    revision: 0,
    accounts: { youtube_music: youtubeLink("youtube-refresh-token-kept-in-cosmos") },
  });
  assert.equal(
    (await accounts.readMusicAccountRecord(subject)).youtube_music.credentials.refresh_token,
    "youtube-refresh-token-kept-in-cosmos",
  );

  const requestsBefore = cosmos.requests.length;
  for (const unusable of ["", "a:b", "has space", "x".repeat(127)]) {
    await assert.rejects(
      () => accounts.readMusicAccountRecord(unusable),
      (error) => error instanceof accounts.MusicAccountError,
    );
  }
  assert.equal(cosmos.requests.length, requestsBefore, "an unusable subject is never sent");

  const module = await source("src/server/musicAccounts.ts");
  assert.doesNotMatch(module, /node:fs|writeFile|music-sessions|LUMA_MUSIC_SESSION/);
  assert.equal(fs.existsSync(new URL("src/server/musicProviderStore.ts", root)), false);
});

for (const [name, record] of [
  ["token object", { youtube_music: { ...youtubeLink(), credentials: { access_token: { private: "secret-sentinel" } } } }],
  ["invalid expiry", { youtube_music: { ...youtubeLink(), credentials: { ...youtubeLink().credentials, expiry_date: "not-a-date" } } }],
  ["TIDAL expiry string", { tidal: { credentials: { access_token: "secret-sentinel", expires_at: "tomorrow" } } }],
  ["invalid pending grant", { tidal: { pending: { state: "secret-sentinel" } } }],
  ["Apple token object", { apple_music: { connected_at: "2026-09-01T00:00:00.000Z", music_user_token: { private: "secret-sentinel" } } }],
]) {
  test(`credential boundary rejects ${name} without exposing stored content`, async (t) => {
    cosmosAccounts(t);
    cosmosWearer("U:malformed-credentials").accounts = record;
    await assert.rejects(() => accounts.readMusicAccountRecord("malformed-credentials"), (error) => {
      assert.ok(error instanceof accounts.MusicAccountError);
      assert.equal(error.message, "Music accounts are unavailable.");
      return true;
    });
    assert.equal(cosmos.requests.length, 1);
  });
}

test("a write that loses to another writer reads again and reapplies its change", async (t) => {
  cosmosAccounts(t);
  const subject = "racing-wearer";
  let raced = false;
  await accounts.updateMusicAccountRecord(subject, async (record) => {
    if (!raced) {
      raced = true;
      await accounts.updateMusicAccountRecord(subject, (inner) => ({
        ...inner,
        apple_music: { music_user_token: "apple-token", connected_at: "2026-08-25T00:00:00.000Z" },
      }));
    }
    return { ...record, youtube_music: youtubeLink() };
  });

  const record = await accounts.readMusicAccountRecord(subject);
  assert.equal(record.apple_music.music_user_token, "apple-token", "the other writer's change survives");
  assert.equal(record.youtube_music.credentials.access_token, "youtube-access-token");
  assert.deepEqual(
    cosmos.requests.filter((request) => request.method === "PUT").map((request) => request.body.revision),
    [0, 0, 1],
    "the stale write was refused and retried at the new revision",
  );

  await assert.rejects(
    () => accounts.updateMusicAccountRecord(subject, async (current) => {
      await accounts.updateMusicAccountRecord(subject, (inner) => ({ ...inner }));
      return current;
    }),
    (error) => error instanceof accounts.MusicAccountError && /kept changing/u.test(error.message),
  );
});

test("the settings page reads links and the provider from Cosmos, and an outage reads as error", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  environment(t, "APPLE_MUSIC_DEVELOPER_TOKEN", "header.payload.signature");
  await accounts.updateMusicAccountRecord(WEB_WEARER, (record) => ({
    ...record,
    youtube_music: youtubeLink(),
  }));

  const linked = await gateway.musicAccountStatus(WEB_WEARER);
  assert.equal(linked.active_provider, "spotify");
  assert.deepEqual(linked.providers, {
    youtube_music: { configured: true, state: "connected", ad_filtering: "pear_newpipe" },
    tidal: { configured: true, state: "not_connected" },
    apple_music: { configured: true, state: "not_connected" },
  });
  // The signed-in wearer's own identity: their session bearer in a request,
  // the configured principal here, where no browser session exists.
  const summaryRead = cosmos.requests.at(-1);
  assert.equal(summaryRead.path, "/account-service/music-providers");
  assert.equal(summaryRead.headers["x-forwarded-client-cert"], `U:${WEB_WEARER}`);

  const chosen = await accounts.saveActiveMusicProvider("youtube_music");
  assert.equal(chosen.active_provider, "youtube_music");
  assert.deepEqual(cosmos.requests.at(-1).body, { provider: "youtube_music" });
  assert.equal((await gateway.musicAccountStatus(WEB_WEARER)).active_provider, "youtube_music");

  cosmos.down = true;
  const down = await gateway.musicAccountStatus(WEB_WEARER);
  assert.equal(down.active_provider, null, "an outage is never 'Spotify'");
  assert.deepEqual(down.providers, {
    youtube_music: { configured: true, state: "error", ad_filtering: "pear_newpipe" },
    tidal: { configured: true, state: "error" },
    apple_music: { configured: true, state: "error" },
  });
  await assert.rejects(
    () => accounts.saveActiveMusicProvider("tidal"),
    (error) => error instanceof accounts.MusicAccountError && /Pin switched/u.test(error.message),
  );
});

test("a YouTube sign-in keeps only the grant fields Cosmos stores", async (t) => {
  cosmosAccounts(t);
  const subject = "youtube-sign-in-wearer";
  const originalCreate = Innertube.create;
  t.after(() => {
    Innertube.create = originalCreate;
  });
  const saved = Promise.withResolvers();
  Innertube.create = async () => {
    const session = new EventEmitter();
    session.oauth = {};
    session.signOut = async () => undefined;
    session.signIn = async () => {
      queueMicrotask(() => {
        session.emit("auth-pending", {
          user_code: "ABCD-EFGH",
          verification_url: "https://www.youtube.com/activate",
          expires_in: 600,
        });
        queueMicrotask(() => {
          session.emit("auth", {
            credentials: {
              access_token: "signed-in-access-token",
              refresh_token: "signed-in-refresh-token",
              expiry_date: "2026-08-26T00:00:00.000Z",
              scope: "http://gdata.youtube.com",
              token_type: "Bearer",
              id_token: "not-kept",
              refresh_token_expires_in: 604_800,
            },
          });
          setImmediate(saved.resolve);
        });
      });
    };
    return { session };
  };

  await youtube.startYoutubeConnection(subject);
  await saved.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((await accounts.readMusicAccountRecord(subject)).youtube_music.credentials, {
    access_token: "signed-in-access-token",
    refresh_token: "signed-in-refresh-token",
    expiry_date: "2026-08-26T00:00:00.000Z",
    scope: "http://gdata.youtube.com",
    token_type: "Bearer",
  });
});

test("disconnecting YouTube before its activation code arrives immediately releases Connect", async (t) => {
  cosmosAccounts(t);
  const subject = "youtube-disconnect-before-code";
  const originalCreate = Innertube.create;
  t.after(() => { Innertube.create = originalCreate; });
  const started = Promise.withResolvers();
  const blocked = Promise.withResolvers();
  const session = new EventEmitter();
  session.oauth = {};
  session.signOut = async () => undefined;
  session.signIn = async () => { started.resolve(); await blocked.promise; throw new Error("unrecorded provider shutdown"); };
  Innertube.create = async () => ({ session });
  const connect = youtube.startYoutubeConnection(subject);
  await started.promise;
  const outcome = connect.then(() => "unexpected success", (error) => error);
  await youtube.disconnectYoutube(subject);
  let deadline;
  try {
    const error = await Promise.race([outcome, new Promise((resolve) => { deadline = setTimeout(() => resolve("Connect remained pending after Disconnect"), 50); })]);
    assert.ok(error instanceof youtube.YoutubeMusicError, String(error));
    assert.equal(error.status, 401);
  } finally {
    clearTimeout(deadline);
    blocked.resolve();
    await outcome;
  }
});

test("YouTube sign-in reports an initial failure immediately and can retry", async (t) => {
  cosmosAccounts(t);
  const subject = "youtube-initial-failure";
  const originalCreate = Innertube.create;
  t.after(() => { Innertube.create = originalCreate; });
  let attempts = 0;
  Innertube.create = async () => {
    attempts += 1;
    const session = new EventEmitter();
    session.oauth = {};
    session.signOut = async () => undefined;
    session.signIn = async () => {
      if (attempts === 1) throw new Error("provider secret must not escape");
      session.emit("auth-pending", {
        user_code: "RETRY-CODE", verification_url: "https://www.youtube.com/activate", expires_in: 600,
      });
    };
    return { session };
  };
  await assert.rejects(() => Promise.race([
    youtube.startYoutubeConnection(subject),
    new Promise((_, reject) => setTimeout(() => reject(new Error("sign-in failure was not surfaced")), 100)),
  ]), (error) => error instanceof youtube.YoutubeMusicError && !error.message.includes("provider secret"));
  assert.equal((await youtube.startYoutubeConnection(subject)).user_code, "RETRY-CODE");
});

test("simultaneous YouTube Connect requests share one provider sign-in", async (t) => {
  cosmosAccounts(t);
  const subject = "youtube-simultaneous-connect";
  const originalCreate = Innertube.create;
  t.after(() => { Innertube.create = originalCreate; });
  let attempts = 0;
  Innertube.create = async () => {
    attempts += 1;
    await new Promise((resolve) => setImmediate(resolve));
    const session = new EventEmitter();
    session.oauth = {};
    session.signOut = async () => undefined;
    session.signIn = async () => session.emit("auth-pending", {
      user_code: "SHARED-CODE", verification_url: "https://www.youtube.com/activate", expires_in: 600,
    });
    return { session };
  };
  const [first, second] = await Promise.all([
    youtube.startYoutubeConnection(subject), youtube.startYoutubeConnection(subject),
  ]);
  assert.deepEqual(first, second);
  assert.equal(attempts, 1);
});

test("disconnecting a pending YouTube SDK login stops authorization polling", async (t) => {
  cosmosAccounts(t);
  const subject = "youtube-cancel-polling";
  const originalCreate = Innertube.create;
  t.after(() => { Innertube.create = originalCreate; });
  Innertube.create = async (options) => {
    const client = await originalCreate({ ...options, retrieve_player: false, fetch: youtube.adBlockingYoutubeFetchUsing(globalThis.fetch) });
    client.session.oauth.client_id = { client_id: "test-client", client_secret: "test-secret" };
    return client;
  };
  let polls = 0;
  useProviderFetch(t, async (input) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === "/o/oauth2/device/code") return Response.json({
      device_code: "generated-device-code", user_code: "CANCEL-CODE",
      verification_url: "https://www.youtube.com/activate", expires_in: 60, interval: 1,
    });
    if (path === "/o/oauth2/token") {
      polls += 1;
      // The real SDK clears its otherwise uncancellable interval on refusal.
      return Response.json({ error: "access_denied" });
    }
    throw new Error(`unexpected provider path ${path}`);
  });
  await youtube.startYoutubeConnection(subject);
  await youtube.disconnectYoutube(subject);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(polls, 0, "Disconnect must stop the pending account authorization");
  assert.equal(youtube.youtubeConnectionStatus(subject, false).state, "not_connected");
});

test("YouTube SDK token polling failures end the login safely and allow retry", async (t) => {
  cosmosAccounts(t);
  const subject = "youtube-failed-polling";
  const originalCreate = Innertube.create;
  t.after(async () => { await youtube.disconnectYoutube(subject); Innertube.create = originalCreate; });
  Innertube.create = async (options) => {
    const client = await originalCreate({ ...options, retrieve_player: false,
      fetch: youtube.adBlockingYoutubeFetchUsing(globalThis.fetch) });
    client.session.oauth.client_id = { client_id: "test-client", client_secret: "test-secret" };
    return client;
  };
  let codes = 0;
  useProviderFetch(t, async (input) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === "/o/oauth2/device/code") return Response.json({
      device_code: "generated-device-code", user_code: `RETRY-${++codes}`,
      verification_url: "https://www.youtube.com/activate", expires_in: 60, interval: 1,
    });
    if (path === "/o/oauth2/token") throw new Error("unrecorded provider network outage");
    throw new Error(`unexpected provider path ${path}`);
  });
  assert.equal((await youtube.startYoutubeConnection(subject)).user_code, "RETRY-1");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(youtube.youtubeConnectionStatus(subject, false).state, "error");
  assert.equal((await youtube.startYoutubeConnection(subject)).user_code, "RETRY-2");
});

test("YouTube SDK sign-in accepts HTTP 400 authorization_pending before the grant", async (t) => {
  cosmosAccounts(t);
  const subject = "youtube-pending-http400";
  const originalCreate = Innertube.create;
  t.after(async () => { await youtube.disconnectYoutube(subject); Innertube.create = originalCreate; });
  Innertube.create = async (options) => {
    const client = await originalCreate({ ...options, retrieve_player: false,
      fetch: youtube.adBlockingYoutubeFetchUsing(globalThis.fetch) });
    client.session.oauth.client_id = { client_id: "test-client", client_secret: "test-secret" };
    return client;
  };
  let polls = 0;
  useProviderFetch(t, async (input) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === "/o/oauth2/device/code") return Response.json({
      device_code: "generated-device-code", user_code: "WAIT-CODE",
      verification_url: "https://www.youtube.com/activate", expires_in: 60, interval: 1,
    });
    if (path === "/o/oauth2/token") {
      if (++polls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
      return Response.json({ access_token: "generated-access", refresh_token: "generated-refresh", expires_in: 600 });
    }
    if (path === "/o/oauth2/revoke") return Response.json({});
    throw new Error(`unexpected provider path ${path}`);
  });
  await youtube.startYoutubeConnection(subject);
  await new Promise((resolve) => setTimeout(resolve, 2_150));
  assert.equal(polls, 2);
  assert.equal((await accounts.readMusicAccountRecord(subject)).youtube_music?.credentials.access_token, "generated-access");
});

test("YouTube favorites reports OAuth capability limits instead of a false empty library", async (t) => {
  cosmosAccounts(t);
  const subject = "youtube-favorites-limit";
  cosmosWearer(`U:${subject}`).accounts = { youtube_music: youtubeLink() };
  const originalCreate = Innertube.create;
  t.after(() => { Innertube.create = originalCreate; });
  Innertube.create = async () => { throw new Error("favorites must not send OAuth to WEB_REMIX"); };
  await assert.rejects(() => youtube.queryYoutubeMusic(subject, { kind: "favorites", limit: 10 }),
    (error) => error instanceof youtube.YoutubeMusicError && error.status === 501 &&
      error.message.includes("favorites"));
});

test("an abandoned YouTube login cannot mark its replacement as failed", async (t) => {
  cosmosAccounts(t);
  const subject = "youtube-stale-login-event";
  const originalCreate = Innertube.create;
  t.after(async () => { await youtube.disconnectYoutube(subject); Innertube.create = originalCreate; });
  const sessions = [];
  Innertube.create = async () => {
    const session = new EventEmitter();
    session.oauth = {};
    session.signOut = async () => undefined;
    session.signIn = async () => session.emit("auth-pending", {
      user_code: `CODE-${sessions.length}`, verification_url: "https://www.youtube.com/activate", expires_in: 600,
    });
    sessions.push(session);
    return { session };
  };
  await youtube.startYoutubeConnection(subject);
  sessions[0].emit("auth-error", new Error("first attempt failed"));
  assert.equal((await youtube.startYoutubeConnection(subject)).user_code, "CODE-2");
  sessions[0].emit("auth-error", new Error("late error from abandoned attempt"));
  assert.equal(youtube.youtubeConnectionStatus(subject, false).state, "pairing");
});

test("a durable YouTube connection wins over a failed in-memory retry", async (t) => {
  cosmosAccounts(t);
  const subject = WEB_WEARER;
  const originalCreate = Innertube.create;
  t.after(() => {
    Innertube.create = originalCreate;
  });

  Innertube.create = async () => {
    const session = new EventEmitter();
    session.oauth = {};
    session.signOut = async () => undefined;
    session.signIn = () => new Promise((resolve, reject) => {
      queueMicrotask(() => {
        session.emit("auth-pending", {
          user_code: "ABCD-EFGH",
          verification_url: "https://www.youtube.com/activate",
          expires_in: 600,
        });
        queueMicrotask(() => {
          const error = new Error("simulated retry failure");
          session.emit("auth-error", error);
          reject(error);
        });
      });
    });
    return { session };
  };

  await youtube.startYoutubeConnection(subject);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await gateway.musicAccountStatus(subject)).providers.youtube_music.state, "error");
  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    youtube_music: youtubeLink(),
  }));

  assert.equal((await gateway.musicAccountStatus(subject)).providers.youtube_music.state, "connected");
});

test("YouTube Music keeps connected OAuth credentials out of public catalog searches", async (t) => {
  cosmosAccounts(t);
  const subject = "youtube-catalog-wearer";
  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    youtube_music: {
      connected_at: "2026-08-25T00:00:00.000Z",
      credentials: {
        access_token: "youtube-access-token",
        refresh_token: "youtube-refresh-token",
        expiry_date: "2026-08-26T00:00:00.000Z",
      },
    },
  }));

  const originalCreate = Innertube.create;
  t.after(() => {
    Innertube.create = originalCreate;
  });
  let createCount = 0;
  let createOptions;
  let searchCall;
  Innertube.create = async (options) => {
    createCount += 1;
    createOptions = options;
    return {
      session: {
        signIn: async () => assert.fail("public catalog search must not attach OAuth credentials"),
      },
      music: {
        search: async (query, filters) => {
          searchCall = { query, filters };
          return {
            songs: {
              contents: [{
                id: "6f8gDL-wPN8",
                title: "Life Is Good (feat. Drake)",
                artists: [{ name: "Future" }, { name: "Drake" }],
                album: { name: "High Off Life" },
                duration: { seconds: 238 },
              }],
            },
          };
        },
      },
    };
  };

  assert.deepEqual(
    await youtube.queryYoutubeMusic(subject, { kind: "track", primary: "Drake", limit: 10 }),
    [{
      id: "youtube_music:6f8gDL-wPN8",
      title: "Life Is Good (feat. Drake)",
      artists: ["Future", "Drake"],
      album: "High Off Life",
      duration_ms: 238_000,
      track_number: 0,
      disc_number: 0,
      explicit: false,
    }],
  );
  await youtube.queryYoutubeMusic(subject, { kind: "track", primary: "Drake", limit: 10 });
  assert.equal(createCount, 1, "repeat catalog queries must reuse the initialized client");
  assert.equal(createOptions.retrieve_player, false);
  assert.deepEqual(searchCall, { query: "Drake", filters: { type: "song" } });
});

test("YouTube catalog skips malformed rows and keeps valid SDK records", async (t) => {
  cosmosAccounts(t);
  const subject = "youtube-malformed-catalog";
  cosmosWearer(`U:${subject}`).accounts = { youtube_music: youtubeLink() };
  const originalCreate = Innertube.create;
  t.after(() => { Innertube.create = originalCreate; });
  Innertube.create = async () => ({ music: { search: async () => ({ songs: { contents: [
    null, 42, { id: "6f8gDL-wPN8", title: "Bad duration", duration: { seconds: "180" } },
    { id: "6f8gDL-wPN8", title: "Valid", artists: [{ name: "Artist" }], duration: { seconds: 180 } },
  ] } }) } });
  const tracks = await youtube.queryYoutubeMusic(subject, { kind: "track", primary: "fixture", limit: 10 });
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].title, "Valid");
});

for (const [caseName, basic, expectedCount] of [
  ["missing-duration", { id: "6f8gDL-wPN8", title: "Song", author: "Artist" }, 0],
  ["mismatched-id", { id: "Zi_XLOBDo_Y", title: "Other song", author: "Artist", duration: 180 }, 0],
  ["valid-metadata", { id: "6f8gDL-wPN8", title: "Song", author: "Artist", duration: 180 }, 1],
]) {
  test(`YouTube ID lookup validates ${caseName} instead of inventing track metadata`, async (t) => {
    cosmosAccounts(t);
    const subject = `youtube-id-${caseName}`;
    cosmosWearer(`U:${subject}`).accounts = { youtube_music: youtubeLink() };
    const originalCreate = Innertube.create;
    t.after(() => { Innertube.create = originalCreate; });
    Innertube.create = async () => ({ music: { getInfo: async () => ({ basic_info: basic }) } });
    const tracks = await youtube.queryYoutubeMusic(subject, { kind: "ids", ids: ["youtube_music:6f8gDL-wPN8"], limit: 10 });
    assert.equal(tracks.length, expectedCount);
    if (tracks.length) assert.equal(tracks[0].duration_ms, 180_000);
  });
}

test("an aborted YouTube ID lookup never starts the remaining track requests", async (t) => {
  cosmosAccounts(t);
  const subject = "youtube-aborted-id-queue";
  cosmosWearer(`U:${subject}`).accounts = { youtube_music: youtubeLink() };
  const originalCreate = Innertube.create;
  t.after(() => { Innertube.create = originalCreate; });
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const requested = [];
  Innertube.create = async () => ({ music: { getInfo: async (id) => {
    requested.push(id);
    started.resolve();
    await release.promise;
    return { basic_info: { id, title: "Song", author: "Artist", duration: 180 } };
  } } });
  const controller = new AbortController();
  const lookup = youtube.queryYoutubeMusic(subject, { kind: "ids", ids: ["6f8gDL-wPN8", "Zi_XLOBDo_Y"], limit: 10 }, controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(lookup, (error) => error.name === "AbortError");
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requested, ["6f8gDL-wPN8"]);
});

test("an aborted YouTube collection search never starts the browse request", async (t) => {
  cosmosAccounts(t);
  const subject = "youtube-aborted-collection";
  cosmosWearer(`U:${subject}`).accounts = { youtube_music: youtubeLink() };
  const originalCreate = Innertube.create;
  t.after(() => { Innertube.create = originalCreate; });
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let browsed = 0;
  Innertube.create = async () => ({ music: {
    search: async () => { started.resolve(); await release.promise; return { albums: { contents: [{ id: "MPRfixture" }] } }; },
    getAlbum: async () => { browsed += 1; return { contents: [] }; },
  } });
  const controller = new AbortController();
  const lookup = youtube.queryYoutubeMusic(subject, { kind: "album", primary: "Album", limit: 10 }, controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(lookup, (error) => error.name === "AbortError");
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browsed, 0);
});

for (const [kind, primary, expectedQuery] of [["genre", "rock", "rock"], ["featured", undefined, "top hits"]]) {
  test(`YouTube ${kind} requests browse a public playlist instead of literal song titles`, async (t) => {
    cosmosAccounts(t);
    const subject = `youtube-${kind}-collection`;
    cosmosWearer(`U:${subject}`).accounts = { youtube_music: youtubeLink() };
    const originalCreate = Innertube.create;
    t.after(() => { Innertube.create = originalCreate; });
    const calls = [];
    // Unrecorded SDK result-shape fixture: search playlists, then their songs.
    Innertube.create = async () => ({ music: {
      search: async (query, options) => { calls.push({ query, options }); return { playlists: { contents: [{ id: "VLPLfixture" }] } }; },
      getPlaylist: async (id) => { calls.push({ playlist: id }); return { contents: [{
        id: "6f8gDL-wPN8", title: "A song from the playlist", artists: [{ name: "Artist" }], duration: { seconds: 180 },
      }] }; },
    } });
    const tracks = await youtube.queryYoutubeMusic(subject, { kind, primary, limit: 10 });
    assert.equal(tracks.length, 1);
    assert.deepEqual(calls, [{ query: expectedQuery, options: { type: "playlist" } }, { playlist: "VLPLfixture" }]);
  });
}

for (const kind of ["genre", "featured"]) {
  test(`YouTube ${kind} public playlist parses through the installed SDK into a stock-compatible queue`, async (t) => {
    cosmosAccounts(t);
    const subject = `youtube-sdk-playlist-${kind}`;
    cosmosWearer(`U:${subject}`).accounts = { youtube_music: youtubeLink() };
    const originalCreate = Innertube.create;
    t.after(() => { Innertube.create = originalCreate; });
    // Unrecorded InnerTube renderer fixture, inferred from installed SDK
    // MusicResponsiveListItem and MusicPlaylistShelf parsers. This proves
    // parser compatibility, not current live provider or editorial selection.
    const playlistId = "VLPLfixture";
    const playlistHit = new YTNodes.MusicResponsiveListItem({
      navigationEndpoint: { browseEndpoint: {
        browseId: playlistId,
        browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_PLAYLIST" } },
      } },
      flexColumns: [{ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Public playlist" }] } } }],
    });
    const songRenderer = (duration) => ({ musicResponsiveListItemRenderer: {
      playlistItemData: { videoId: "6f8gDL-wPN8" },
      flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Playlist song", navigationEndpoint: { watchEndpoint: {
          videoId: "6f8gDL-wPN8",
          watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType: "MUSIC_VIDEO_TYPE_ATV" } },
        } } }] } } },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Artist", navigationEndpoint: { browseEndpoint: { browseId: "UCfixture" } } }] } } },
      ],
      fixedColumns: [{ musicResponsiveListItemFixedColumnRenderer: { text: { runs: [{ text: duration }] } } }],
    } });
    const playlist = new YTMusic.Playlist({ data: {
      contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: {
        selected: true,
        content: { sectionListRenderer: { contents: [{ musicPlaylistShelfRenderer: {
          playlistId: "PLfixture",
          contents: [songRenderer("0:00"), songRenderer("3:00"), songRenderer("30:01")],
        } }] } },
      } }] } },
    } }, {});
    assert.equal(playlistHit.item_type, "playlist");
    assert.equal(playlistHit.id, playlistId);
    assert.equal(playlist.contents.length, 3);
    assert.ok(playlist.contents.every((row) => row instanceof YTNodes.MusicResponsiveListItem));
    Innertube.create = async () => ({ music: {
      search: async (_query, options) => {
        assert.deepEqual(options, { type: "playlist" });
        return { playlists: { contents: [playlistHit] } };
      },
      getPlaylist: async (id) => { assert.equal(id, playlistId); return playlist; },
    } });
    assert.deepEqual(await youtube.queryYoutubeMusic(subject, { kind, primary: "rock", limit: 10 }), [{
      id: "youtube_music:6f8gDL-wPN8", title: "Playlist song", artists: ["Artist"],
      album: "", duration_ms: 180_000, track_number: 0, disc_number: 0, explicit: false,
    }]);
  });
}

test("YouTube catalog preserves the SDK's explicit badge", async (t) => {
  cosmosAccounts(t);
  const subject = "youtube-explicit-catalog";
  cosmosWearer(`U:${subject}`).accounts = { youtube_music: youtubeLink() };
  const originalCreate = Innertube.create;
  t.after(() => { Innertube.create = originalCreate; });
  // Unrecorded provider-shape fixture, constructed by the installed SDK parser.
  const badge = new YTNodes.MusicInlineBadge({ icon: { iconType: "MUSIC_EXPLICIT_BADGE" } });
  Innertube.create = async () => ({ music: { search: async () => ({ songs: { contents: [{
    id: "6f8gDL-wPN8", title: "Explicit song", artists: [{ name: "Artist" }],
    duration: { seconds: 180 }, badges: [badge],
  }] } }) } });
  const tracks = await youtube.queryYoutubeMusic(subject, { kind: "track", primary: "fixture", limit: 1 });
  assert.equal(tracks[0].explicit, true);
});

for (const expiry of ["3600", -1, null, 1e30]) {
  test(`TIDAL refuses invalid token expiry ${JSON.stringify(expiry)} before storing a grant`, async (t) => {
    cosmosAccounts(t);
    environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
    environment(t, "LUMA_MUSIC_GATEWAY_ORIGIN", "https://center.example.test");
    const subject = `tidal-invalid-expiry-${String(expiry).replace(/[^a-z0-9]/gi, "")}`;
    const authorization = new URL(await tidal.startTidalConnection(subject));
    useProviderFetch(t, async () => Response.json({ access_token: "secret-sentinel", expires_in: expiry }));
    await assert.rejects(() => tidal.finishTidalConnection(subject, "fixture-code", authorization.searchParams.get("state")), (error) => {
      assert.ok(error instanceof tidal.TidalMusicError);
      assert.doesNotMatch(error.message, /secret-sentinel/);
      return true;
    });
    assert.equal(cosmosWearer(`U:${subject}`).accounts.tidal?.credentials, undefined);
  });
}

test("a stalled YouTube Music lookup answers Cosmos 504 within its budget", async (t) => {
  cosmosAccounts(t);
  environment(t, "COSMOS_ADMIN_TOKEN", "a".repeat(40));
  // The route's budget is AbortSignal.timeout(), whose timer is unrefed. This
  // ref'd keep-alive holds the test runner's empty event loop open until the
  // 100 ms budget can fire. Production is unaffected: the server's own
  // listeners hold the loop.
  const keepAlive = setTimeout(() => {}, 10_000);
  t.after(() => clearTimeout(keepAlive));
  const subject = "youtube-stalled-catalog";
  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    youtube_music: {
      connected_at: "2026-09-01T00:00:00.000Z",
      credentials: { access_token: "a", refresh_token: "r", expiry_date: "2026-09-26T00:00:00.000Z" },
    },
  }));
  const originalCreate = Innertube.create;
  t.after(() => {
    Innertube.create = originalCreate;
  });
  Innertube.create = async () => ({ music: { search: () => new Promise(() => {}) } });

  const startedAt = performance.now();
  const response = await internalQuery.internalMusicQuery(
    new Request("http://center:4000/api/internal/music/query", {
      method: "POST",
      headers: { authorization: `Bearer ${"a".repeat(40)}`, "content-type": "application/json" },
      body: JSON.stringify({ principal: `U:${subject}`, provider: "youtube_music", query: "One Dance Drake" }),
    }),
    undefined,
    100,
  );
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "YouTube Music took too long." });
  assert.ok(performance.now() - startedAt < 2_000, "the lookup outlived its budget");
});

test("a TIDAL lookup stops its requests when the caller's budget ends", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  const subject = "tidal-stalled-catalog";
  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    tidal: {
      connected_at: "2026-09-01T00:00:00.000Z",
      credentials: {
        access_token: "valid-access",
        refresh_token: "valid-refresh",
        expires_at: Date.now() + 3_600_000,
        user_id: "1",
        country_code: "DK",
      },
    },
  }));
  const aborted = [];
  useProviderFetch(t, (_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      aborted.push(true);
      reject(init.signal.reason);
    });
  }));

  const budget = new AbortController();
  const lookup = gateway.gatewayQuery(
    subject,
    { provider: "tidal", kind: "track", primary: "Blue", limit: 1 },
    budget.signal,
  ).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 20));
  budget.abort();
  const error = await lookup;
  assert.ok(error instanceof tidal.TidalMusicError);
  assert.deepEqual(aborted, [true]);
});

// Ad-filter failure modes: newer/nested scheduling fields survive. Filtering
// damages song data. Denied hosts reach the network. Undeclared bodies bypass
// the size bound. Malformed JSON is passed to the SDK. Synthetic, unrecorded.
test("YouTube Music removes ad payloads and refuses ad or non-media hosts", () => {
  assert.deepEqual(
    youtube.pruneYoutubeAdFields({
      playerAds: ["top-level"],
      adBreakHeartbeatParams: { adBreakHeartbeatToken: "fixture-ad-token" },
      playabilityStatus: {
        adPlacements: ["nested"],
        keep: { adSlots: ["deep"], adBreakHeartbeatParams: "nested", title: "track" },
      },
    }),
    { playabilityStatus: { keep: { title: "track" } } },
  );
  assert.equal(youtube.isBlockedYoutubeAdHost("ads.googleads.g.doubleclick.net"), true);
  assert.equal(youtube.isAllowedYoutubeRequestUrl("https://music.youtube.com/youtubei/v1/player"), true);
  assert.equal(youtube.isAllowedYoutubeRequestUrl("https://googleads.g.doubleclick.net/pagead"), false);
  assert.equal(youtube.isAllowedGoogleVideoStream("https://r1---sn.example.googlevideo.com/videoplayback?id=x"), true);
  assert.equal(youtube.isAllowedGoogleVideoStream("https://example.test/audio"), false);
  assert.deepEqual(youtube.youtubeCollectionPlan("album_artist"), {
    searchType: "album",
    loader: "album",
  });
  assert.deepEqual(youtube.youtubeCollectionPlan("playlist"), {
    searchType: "playlist",
    loader: "playlist",
  });
  assert.deepEqual(youtube.youtubeCollectionPlan("artist"), {
    searchType: "artist",
    loader: "artist_songs",
  });
  assert.equal(youtube.youtubeCollectionPlan("track"), null);
});

test("YouTube Music cancels declared oversized JSON instead of bypassing ad pruning", async (t) => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream({
    cancel() {
      cancelled = true;
    },
  }), {
    headers: {
      "content-length": String(16 * 1024 * 1024 + 1),
      "content-type": "application/json",
    },
  });
  t.after(() => upstream.body?.cancel().catch(() => undefined));
  const scopedFetch = youtube.adBlockingYoutubeFetchUsing(async () => upstream);

  await assert.rejects(
    () => scopedFetch("https://youtubei.googleapis.com/youtubei/v1/player"),
    (error) =>
      error instanceof youtube.YoutubeMusicError &&
      error.status === 502 &&
      error.message === "YouTube Music returned an oversized response.",
  );
  assert.equal(cancelled, true);
});

test("YouTube integrity responses enforce the 64 KiB streaming limit and cancel upstream", async () => {
  let pulls = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(pulls === 1 ? 64 * 1024 : 1));
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 }));

  await assert.rejects(
    () => youtubeProof.readYoutubeIntegrityResponse(response),
    /YouTube integrity response was oversized/,
  );
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
});

test("YouTube playback fetches share one absolute resolution budget", async () => {
  const sharedSignal = AbortSignal.timeout(200);
  const observedSignals = [];
  const scopedFetch = youtube.adBlockingYoutubeFetchUsing(async (_input, init) => {
    observedSignals.push(init?.signal);
    await waitWithSignal(120, init?.signal);
    return Response.json({ playabilityStatus: { status: "OK" } });
  }, sharedSignal);

  await scopedFetch("https://youtubei.googleapis.com/youtubei/v1/player");
  await assert.rejects(
    () => scopedFetch("https://youtubei.googleapis.com/youtubei/v1/player"),
    (error) => error?.name === "TimeoutError",
  );
  assert.equal(observedSignals.length, 2);
  assert.ok(observedSignals.every((signal) => signal instanceof AbortSignal));
});

test("YouTube Music binds a content proof to the player request and stream URL", async () => {
  const calls = [];
  const player = { id: "fixture-player" };
  const client = {
    session: { player },
    getBasicInfo: async (videoId, options) => {
      calls.push({ videoId, options });
      return {
        basic_info: { id: videoId },
        playability_status: { status: "OK" },
        streaming_data: { formats: [], adaptive_formats: [{
            bitrate: 128_000,
            mime_type: "audio/mp4",
            is_original: true,
            has_audio: true,
            has_video: false,
            has_text: false,
            drm_families: [],
            fair_play_key_uri: undefined,
            drm_track_type: undefined,
            decipher: async (receivedPlayer) => {
              calls.push({ player: receivedPlayer });
              return "https://r1---sn.example.googlevideo.com/videoplayback?id=fixture";
            },
        }] },
      };
    },
  };

  const url = new URL(
    await youtube.resolveYoutubeAudioStream(
      client,
      "Zi_XLOBDo_Y",
      "fixture-content-proof",
    ),
  );

  assert.deepEqual(calls, [
    {
      videoId: "Zi_XLOBDo_Y",
      options: { client: "YTMUSIC", po_token: "fixture-content-proof" },
    },
    { player },
  ]);
  assert.equal(url.hostname, "r1---sn.example.googlevideo.com");
  assert.equal(url.searchParams.get("pot"), "fixture-content-proof");
});

for (const [codecName, mimeType, itag] of [
  ["AAC", 'audio/mp4; codecs="mp4a.40.2"', 140],
  ["Opus", 'audio/webm; codecs="opus"', 251],
]) {
  test(`YouTube installed SDK ${codecName} playback preserves its public player fingerprint through Pin egress`, async (t) => {
    environment(t, "LUMA_SPOTIFY_ADAPTER_URL", "http://pin-adapter.test:18081");
    environment(t, "LUMA_SPOTIFY_ADAPTER_TOKEN_FILE", undefined);
    environment(t, "LUMA_SPOTIFY_ADAPTER_TOKEN", "fixture-adapter-token".repeat(3));
    const videoId = "Zi_XLOBDo_Y";
    const proof = "fixture-content-proof";
    const calls = [];
    // Unrecorded provider player fixture. Use the actual SDK session,
    // HTTPClient, getBasicInfo, VideoInfo and Format parsers. No OAuth/cookies.
    const playerResponse = {
      playabilityStatus: { status: "OK" },
      videoDetails: { videoId, title: "Fixture song", author: "Fixture artist", lengthSeconds: "180", thumbnail: { thumbnails: [] } },
      streamingData: { expiresInSeconds: "3600", formats: [], adaptiveFormats: [{
        itag, mimeType, bitrate: 128_000, audioQuality: "AUDIO_QUALITY_MEDIUM",
        audioSampleRate: "48000", audioChannels: 2,
        url: `https://r1.googlevideo.com/videoplayback?itag=${itag}`,
      }] },
    };
    const pinEgress = (input, init) => spotifyBridge.deviceMusicProviderFetch(input, init, async (url, bridgeInit) => {
      assert.equal(url, "http://pin-adapter.test:18081/api/pin-remote/api/music/egress");
      const envelope = JSON.parse(bridgeInit.body);
      calls.push(envelope);
      return Response.json({ status: 200, headers: { "content-type": "application/json" },
        body_base64: Buffer.from(JSON.stringify(playerResponse)).toString("base64") });
    });
    const client = await Innertube.create({ fetch: youtube.adBlockingYoutubeFetchUsing(pinEgress),
      retrieve_player: false, generate_session_locally: true, enable_session_cache: false });
    const visitor = client.session.context.client.visitorData;
    const stream = new URL(await youtube.resolveYoutubeAudioStream(client, videoId, proof));
    assert.equal(stream.searchParams.get("itag"), String(itag));
    assert.equal(stream.searchParams.get("pot"), proof);
    assert.equal(calls.length, 2, "locally generated SDK session still retrieves public config before the player");
    assert.equal(new URL(calls[0].url).pathname, "/youtubei/v1/config");
    const request = calls[1];
    assert.equal(request.provider, "youtube_music");
    assert.equal(request.method, "POST");
    const requestUrl = new URL(request.url);
    assert.equal(requestUrl.hostname, "www.youtube.com");
    assert.equal(requestUrl.pathname, "/youtubei/v1/player");
    assert.equal(request.headers["x-youtube-client-name"], "67");
    assert.equal(request.headers["x-goog-visitor-id"], visitor);
    assert.ok(request.headers["x-youtube-client-version"]);
    assert.ok(request.headers["user-agent"]);
    assert.equal(request.headers.origin, "https://www.youtube.com");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    const requestBody = Buffer.from(request.body_base64, "base64");
    assert.ok(requestBody.length < 512 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(request)) < 1024 * 1024);
    const payload = JSON.parse(requestBody.toString("utf8"));
    assert.equal(payload.context.client.clientName, "WEB_REMIX");
    assert.equal(payload.context.client.visitorData, visitor);
    assert.equal(payload.videoId, videoId);
    assert.equal(payload.serviceIntegrityDimensions.poToken, proof);
  });
}

test("YouTube installed proof SDK headers and endpoints pass the Pin egress boundary", async (t) => {
  environment(t, "LUMA_SPOTIFY_ADAPTER_URL", "http://pin-adapter.test:18081");
  environment(t, "LUMA_SPOTIFY_ADAPTER_TOKEN_FILE", undefined);
  environment(t, "LUMA_SPOTIFY_ADAPTER_TOKEN", "fixture-adapter-token".repeat(3));
  const { buildURL, getHeaders } = await import("bgutils-js/utils");
  // No attestation is made: the bridge receives synthetic responses. This
  // checks only the installed proof SDK's real endpoint/header fingerprint.
  for (const [endpoint, youtubeApi] of [["Create", false], ["GenerateIT", true]]) {
    const url = buildURL(endpoint, youtubeApi);
    const headers = getHeaders();
    let forwarded;
    const response = await spotifyBridge.deviceMusicProviderFetch(url, {
      method: "POST", headers, body: JSON.stringify(["unrecorded fixture"]),
    }, async (_url, init) => {
      forwarded = JSON.parse(init.body);
      return Response.json({ status: 200, headers: { "content-type": "application/json" },
        body_base64: Buffer.from("[]").toString("base64") });
    });
    assert.equal(response.status, 200);
    assert.equal(forwarded.url, url);
    assert.equal(forwarded.method, "POST");
    assert.deepEqual(forwarded.headers, Object.fromEntries(new Headers(headers)));
    assert.equal(forwarded.headers.authorization, undefined);
    assert.equal(forwarded.headers.cookie, undefined);
  }
});

test("YouTube playback chooses playable audio when a higher bitrate stream needs DRM", async () => {
  // Unrecorded player-shape fixture, parsed into actual SDK Format instances.
  const format = (itag, bitrate, extra = {}) => new Misc.Format({
    itag, bitrate, mimeType: 'audio/mp4; codecs="mp4a.40.2"', audioQuality: "AUDIO_QUALITY_MEDIUM",
    url: `https://r1.googlevideo.com/videoplayback?itag=${itag}`, ...extra,
  });
  const streaming_data = { formats: [], adaptive_formats: [
    format(141, 256_000, { drmFamilies: ["WIDEVINE"] }), format(140, 128_000),
  ] };
  const client = { session: {}, getBasicInfo: async () => ({
    basic_info: { id: "Zi_XLOBDo_Y" }, playability_status: { status: "OK" }, streaming_data,
    chooseFormat: (options) => FormatUtils.chooseFormat(options, streaming_data),
  }) };
  const resolved = new URL(await youtube.resolveYoutubeAudioStream(client, "Zi_XLOBDo_Y", "proof"));
  assert.equal(resolved.searchParams.get("itag"), "140");
});

for (const [name, basic_info, playability_status] of [
  ["different video", { id: "6f8gDL-wPN8" }, { status: "OK" }],
  ["provider refusal", { id: "Zi_XLOBDo_Y" }, { status: "LOGIN_REQUIRED" }],
]) {
  test(`YouTube playback refuses ${name} before deciphering`, async () => {
    let deciphered = false;
    const format = { has_audio: true, has_video: false, has_text: false, is_original: true,
      mime_type: "audio/mp4", bitrate: 128_000, decipher: async () => {
        deciphered = true;
        return "https://r1.googlevideo.com/videoplayback";
      } };
    const streaming_data = { formats: [], adaptive_formats: [format] };
    const client = { session: {}, getBasicInfo: async () => ({ basic_info, playability_status,
      streaming_data, chooseFormat: () => format }) };
    await assert.rejects(() => youtube.resolveYoutubeAudioStream(client, "Zi_XLOBDo_Y", "proof"),
      (error) => error instanceof youtube.YoutubeMusicError);
    assert.equal(deciphered, false);
  });
}

test("YouTube Music installs an isolated evaluator before deciphering player URLs", async (t) => {
  const originalEvaluator = Platform.shim.eval;
  t.after(() => {
    Platform.shim.eval = originalEvaluator;
  });
  Platform.shim.eval = () => {
    throw new Error("fixture evaluator was not configured");
  };

  const player = new Player("fixture-player", 0, {
    output: `
class FixtureUrl {
  constructor(value) {
    this.url = new URL(value);
  }
  clone() {
    return new FixtureUrl(this.url.toString());
  }
  set(name, value) {
    this.url.searchParams.set(name, value);
  }
  get(name) {
    return this.url.searchParams.get(name);
  }
  transform() {
    this.set("n", this.get("n").split("").reverse().join(""));
  }
}
const exportedVars = {
  nsigFunction: (value) => new FixtureUrl(value),
};`,
    exported: ["nsigFunction"],
  });
  const client = {
    session: { player },
    getBasicInfo: async () => ({
      basic_info: { id: "Zi_XLOBDo_Y" },
      playability_status: { status: "OK" },
      streaming_data: { formats: [], adaptive_formats: [{
        bitrate: 128_000,
        mime_type: "audio/mp4",
        is_original: true,
        has_audio: true,
        has_video: false,
        has_text: false,
        drm_families: [],
        fair_play_key_uri: undefined,
        drm_track_type: undefined,
        decipher: () =>
          player.decipher(
            "https://r1---sn.example.googlevideo.com/videoplayback?id=fixture&n=abcdef",
          ),
      }] },
    }),
  };

  const url = new URL(
    await youtube.resolveYoutubeAudioStream(
      client,
      "Zi_XLOBDo_Y",
      "fixture-content-proof",
    ),
  );

  assert.equal(url.searchParams.get("n"), "fedcba");
  assert.equal(url.searchParams.get("pot"), "fixture-content-proof");
  assert.equal("window" in globalThis, false);
  assert.equal("document" in globalThis, false);
});

test("YouTube Music player evaluation rejects script-breaking values and hides host APIs", async () => {
  assert.throws(
    () =>
      youtubePlayer.evaluateYoutubePlayerScript(
        { output: "return { n: 'unused' };" },
        { n: 'unsafe"; process.exit(); //' },
      ),
    /player environment was invalid/,
  );
  assert.deepEqual(
    await youtubePlayer.evaluateYoutubePlayerScript(
      {
        output:
          "return { n: typeof process + typeof Function + typeof XMLHttpRequest };",
      },
      {},
    ),
    { n: "undefinedundefinedundefined" },
  );
});

test("YouTube Music filters tracks the stock Music contract cannot consume", () => {
  const valid = {
    id: "youtube_music:SD4yRDY9mek",
    title: "One Dance",
    artists: ["Drake"],
    album: "Views",
    duration_ms: 173_987,
    track_number: 0,
    disc_number: 0,
    explicit: false,
  };
  assert.equal(youtube.isStockCompatibleYoutubeTrack(valid), true);
  assert.equal(
    youtube.isStockCompatibleYoutubeTrack({ ...valid, duration_ms: 60 * 60 * 1_000 }),
    false,
  );
  assert.equal(youtube.isStockCompatibleYoutubeTrack({ ...valid, artists: [] }), false);
  assert.equal(youtube.isStockCompatibleYoutubeTrack({ ...valid, artists: [""] }), false);
});

for (const [setting, value] of [
  ["TIDAL_CLIENT_ID", undefined],
  ["TIDAL_SCOPES", "invalid\nscopes"],
  ["LUMA_MUSIC_GATEWAY_ORIGIN", "http://center.example.test"],
]) {
  test(`TIDAL refuses invalid ${setting} before creating a pending sign-in`, async (t) => {
    cosmosAccounts(t);
    environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
    environment(t, "TIDAL_SCOPES", undefined);
    environment(t, "LUMA_MUSIC_GATEWAY_ORIGIN", "https://center.example.test");
    environment(t, setting, value);

    await assert.rejects(
      () => tidal.startTidalConnection("tidal-wearer"),
      (error) => error instanceof tidal.TidalMusicError && error.status === 409,
    );
    assert.equal(cosmos.requests.length, 0, "configuration errors never mutate the account");
  });
}

test("TIDAL connection uses official OAuth authorization code + PKCE state", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  environment(t, "TIDAL_SCOPES", undefined);
  environment(t, "LUMA_MUSIC_GATEWAY_ORIGIN", "https://center.example.test");
  const subject = "tidal-wearer";

  const authorization = new URL(await tidal.startTidalConnection(subject));
  assert.equal(authorization.origin, "https://login.tidal.com");
  assert.equal(authorization.pathname, "/authorize");
  assert.equal(authorization.searchParams.get("client_id"), "tidal-client-id");
  assert.equal(authorization.searchParams.get("response_type"), "code");
  assert.equal(
    authorization.searchParams.get("scope"),
    "user.read collection.read collection.write search.read playback",
  );
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    authorization.searchParams.get("redirect_uri"),
    "https://center.example.test/api/settings/services/music/tidal/callback",
  );

  const pending = (await accounts.readMusicAccountRecord(subject)).tidal.pending;
  assert.ok(pending);
  assert.equal(authorization.searchParams.get("state"), pending.state);
  assert.equal(
    authorization.searchParams.get("code_challenge"),
    createHash("sha256").update(pending.verifier).digest("base64url"),
  );
  assert.doesNotMatch(authorization.toString(), new RegExp(pending.verifier));
});

test("TIDAL status shows an expired grant without a refresh token as not connected", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  const subject = WEB_WEARER;
  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    tidal: {
      connected_at: "2026-08-18T00:00:00.000Z",
      credentials: {
        access_token: "expired-access-token",
        expires_at: Date.now() - 1_000,
        user_id: "wearer-123",
      },
    },
  }));

  assert.deepEqual((await gateway.musicAccountStatus(subject)).providers.tidal, {
    configured: true,
    state: "not_connected",
  });

  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    tidal: {
      ...record.tidal,
      credentials: {
        ...record.tidal.credentials,
        refresh_token: "refresh-token",
      },
    },
  }));
  assert.deepEqual((await gateway.musicAccountStatus(subject)).providers.tidal, {
    configured: true,
    state: "connected",
  });
  assert.deepEqual(tidal.tidalConnectionStatus({ linked: false, connecting: true }), {
    configured: true,
    state: "connecting",
  });
  assert.deepEqual(tidal.tidalConnectionStatus(null), { configured: true, state: "error" });
});

test("TIDAL invalid_grant disconnects the persisted account and requires reconnection", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  const subject = WEB_WEARER;
  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    tidal: {
      connected_at: "2026-08-18T00:00:00.000Z",
      credentials: {
        access_token: "expired-access-token",
        refresh_token: "rejected-refresh-token",
        expires_at: Date.now() - 1_000,
        user_id: "wearer-123",
      },
    },
  }));

  useProviderFetch(t, async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, "https://auth.tidal.com");
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  });

  const error = await tidal.tidalStreamUrl(subject, "tidal:rejected").catch((reason) => reason);
  assert.ok(error instanceof tidal.TidalMusicError);
  assert.equal(error.status, 401);
  assert.equal(error.message, "Reconnect TIDAL in Center.");
  assert.deepEqual((await gateway.musicAccountStatus(subject)).providers.tidal, {
    configured: true,
    state: "not_connected",
  });
  assert.equal((await accounts.readMusicAccountRecord(subject)).tidal, undefined);
});

test("a failed or cancelled TIDAL sign-in stops reading as connecting", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  environment(t, "LUMA_MUSIC_GATEWAY_ORIGIN", "https://center.example.test");
  const subject = WEB_WEARER;
  const state = new URL(await tidal.startTidalConnection(subject)).searchParams.get("state");
  useProviderFetch(t, async () => new Response("upstream failure", { status: 500 }));

  const failure = await tidal.finishTidalConnection(subject, "code", state).catch((error) => error);
  assert.ok(failure instanceof tidal.TidalMusicError);
  assert.equal((await gateway.musicAccountStatus(subject)).providers.tidal.state, "connecting");

  // The callback abandons exactly the sign-in it was answering.
  await tidal.abandonTidalConnection(subject, "another-sign-in");
  assert.equal((await gateway.musicAccountStatus(subject)).providers.tidal.state, "connecting");
  await tidal.abandonTidalConnection(subject, state);
  assert.deepEqual((await gateway.musicAccountStatus(subject)).providers.tidal, {
    configured: true,
    state: "not_connected",
  });
  assert.equal((await accounts.readMusicAccountRecord(subject)).tidal, undefined);
});

test("abandoning a TIDAL re-sign-in keeps the linked account", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  environment(t, "LUMA_MUSIC_GATEWAY_ORIGIN", "https://center.example.test");
  const subject = WEB_WEARER;
  const credentials = {
    access_token: "linked-access",
    refresh_token: "linked-refresh",
    expires_at: Date.now() + 3_600_000,
  };
  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    tidal: { connected_at: "2026-09-01T00:00:00.000Z", credentials },
  }));
  const state = new URL(await tidal.startTidalConnection(subject)).searchParams.get("state");

  await tidal.abandonTidalConnection(subject, state);
  const record = (await accounts.readMusicAccountRecord(subject)).tidal;
  assert.equal(record.pending, undefined);
  assert.deepEqual(record.credentials, credentials);
  assert.equal((await gateway.musicAccountStatus(subject)).providers.tidal.state, "connected");
});

test("a TIDAL token revoked before its expiry is renewed once and the request retried", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  const subject = WEB_WEARER;
  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    tidal: {
      connected_at: "2026-09-01T00:00:00.000Z",
      credentials: {
        access_token: "revoked-access",
        refresh_token: "good-refresh",
        expires_at: Date.now() + 12 * 3_600_000,
        user_id: "1",
        country_code: "DK",
      },
    },
  }));
  const calls = [];
  useProviderFetch(t, async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const bearer = new Headers(init?.headers).get("authorization");
    calls.push(`${url.host} ${bearer ?? ""}`.trim());
    if (url.host === "auth.tidal.com") {
      return Response.json({ access_token: "fresh-access", expires_in: 3600 });
    }
    if (bearer === "Bearer revoked-access") return new Response(null, { status: 401 });
    return Response.json({
      data: { attributes: { url: "https://audio.tdlcdn.com/full.m4a", trackPresentation: "FULL" } },
    });
  });

  assert.equal(await tidal.tidalStreamUrl(subject, "tidal:123"), "https://audio.tdlcdn.com/full.m4a");
  assert.deepEqual(calls, [
    "openapi.tidal.com Bearer revoked-access",
    "auth.tidal.com",
    "openapi.tidal.com Bearer fresh-access",
  ]);
  assert.equal(
    (await accounts.readMusicAccountRecord(subject)).tidal.credentials.access_token,
    "fresh-access",
  );
});

test("a revoked TIDAL token whose renewal is refused unlinks the account", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  const subject = WEB_WEARER;
  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    tidal: {
      connected_at: "2026-09-01T00:00:00.000Z",
      credentials: {
        access_token: "revoked-access",
        refresh_token: "revoked-refresh",
        expires_at: Date.now() + 12 * 3_600_000,
        user_id: "1",
        country_code: "DK",
      },
    },
  }));
  let lookups = 0;
  useProviderFetch(t, async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host === "auth.tidal.com") return Response.json({ error: "invalid_grant" }, { status: 400 });
    lookups += 1;
    return new Response(null, { status: 401 });
  });

  const error = await tidal.tidalStreamUrl(subject, "tidal:123").catch((reason) => reason);
  assert.ok(error instanceof tidal.TidalMusicError);
  assert.equal(error.status, 401);
  assert.equal(error.message, "Reconnect TIDAL in Center.");
  assert.equal(lookups, 1);
  assert.deepEqual((await gateway.musicAccountStatus(subject)).providers.tidal, {
    configured: true,
    state: "not_connected",
  });
});

test("a TIDAL 403 is TIDAL refusing the request, not a lost sign-in", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  const subject = WEB_WEARER;
  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    tidal: {
      connected_at: "2026-09-01T00:00:00.000Z",
      credentials: {
        access_token: "valid-access",
        refresh_token: "valid-refresh",
        expires_at: Date.now() + 3_600_000,
        user_id: "1",
        country_code: "DK",
      },
    },
  }));
  const hosts = [];
  useProviderFetch(t, async (input) => {
    hosts.push(new URL(input instanceof Request ? input.url : String(input)).host);
    return new Response(null, { status: 403 });
  });

  const error = await tidal.tidalStreamUrl(subject, "tidal:123").catch((reason) => reason);
  assert.ok(error instanceof tidal.TidalMusicError);
  assert.equal(error.status, 403);
  assert.equal(error.message, "TIDAL refused that request.");
  assert.deepEqual(hosts, ["openapi.tidal.com"]);
  assert.equal((await gateway.musicAccountStatus(subject)).providers.tidal.state, "connected");
});

// Unrecorded provider fixtures from TIDAL's published OpenAPI. The owner still
// needs to record a live search, library read/write and full-track playback.
// https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json
test("TIDAL search and library use documented resources without a token user id", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  environment(t, "TIDAL_COUNTRY_CODE", undefined);
  const subject = "tidal-current-api-wearer";
  await accounts.updateMusicAccountRecord(subject, () => ({
    tidal: { credentials: { access_token: "valid-access", expires_at: Date.now() + 3_600_000 } },
  }));
  const calls = [];
  useProviderFetch(t, async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/v2/users/me")
      return Response.json({ data: { type: "users", id: "42", attributes: { country: "DK" } } });
    if (url.pathname === "/v2/searchResults") {
      assert.equal(url.searchParams.get("filter[query]"), "Song Artist");
      assert.equal(url.searchParams.get("include"), "tracks");
      assert.equal(url.searchParams.get("countryCode"), "DK");
      return Response.json({ data: [{ type: "searchResults", id: "opaque/query+id=", relationships: {
        tracks: { data: [{ type: "tracks", id: "2" }, { type: "tracks", id: "1" }] },
      } }] });
    }
    if (url.pathname === "/v2/userCollectionTracks/me/relationships/items") {
      if (init?.method === "POST") {
        assert.deepEqual(JSON.parse(init.body), { data: [{ type: "tracks", id: "2" }] });
        return Response.json({ data: [{ type: "tracks", id: "2" }] });
      }
      assert.equal(url.searchParams.get("include"), "items");
      assert.equal(url.searchParams.has("countryCode"), false, "the library relationship accepts no countryCode");
      return Response.json({ data: [{ type: "tracks", id: "1" }] });
    }
    if (url.pathname === "/v2/tracks") {
      const ids = url.searchParams.get("filter[id]").split(",");
      return Response.json({ data: [...ids].reverse().map((id) => ({
        type: "tracks", id, attributes: { title: `Track ${id}`, duration: "PT3M" },
      })) });
    }
    throw new Error(`undocumented TIDAL request: ${url}`);
  });

  const tracks = await tidal.queryTidal(subject, { kind: "track", primary: "Song", secondary: "Artist", limit: 10 });
  assert.deepEqual(tracks.map((track) => track.id), ["tidal:2", "tidal:1"]);
  const favorites = await tidal.queryTidal(subject, { kind: "favorites", limit: 10 });
  assert.deepEqual(favorites.map((track) => track.id), ["tidal:1"]);
  await tidal.saveTidalTrack(subject, "tidal:2");
  assert.ok(calls.includes("POST /v2/userCollectionTracks/me/relationships/items"));
  assert.equal(calls.filter((call) => call === "GET /v2/users/me").length, 1);
});

test("TIDAL collection prompts resolve official relationships and preserve item order", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  environment(t, "TIDAL_COUNTRY_CODE", undefined);
  const subject = "tidal-catalog-wearer";
  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    tidal: {
      connected_at: "2026-08-18T00:00:00.000Z",
      credentials: {
        access_token: "tidal-access-token",
        refresh_token: "tidal-refresh-token",
        expires_at: Date.now() + 60 * 60_000,
        user_id: "wearer-123",
      },
    },
  }));

  const calls = [];
  const relationshipIds = {
    albums: "album-1",
    artists: "artist-1",
    playlists: "playlist-1",
  };
  const collectionTrackIds = {
    albums: ["track-2", "track-1"],
    artists: ["track-3"],
    playlists: ["track-4", "track-3"],
  };
  useProviderFetch(t, async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/v2/users/wearer-123") {
      return Response.json({ data: { type: "users", id: "wearer-123", attributes: { country: "dk" } } });
    }
    if (url.pathname === "/v2/searchResults") {
      const type = url.searchParams.get("include");
      assert.ok(["albums", "artists", "playlists"].includes(type));
      assert.ok(url.searchParams.get("filter[query]"));
      assert.equal(url.searchParams.get("countryCode"), "DK");
      return Response.json({ data: [{ type: "searchResults", id: "opaque/query+id=", relationships: {
        [type]: { data: [{ type, id: relationshipIds[type] }] },
      } }] });
    }
    const collection = /^\/v2\/(albums|artists|playlists)\/[^/]+\/relationships\/(items|tracks)$/u.exec(url.pathname);
    if (collection) {
      const type = collection[1];
      assert.equal(url.searchParams.get("countryCode"), "DK");
      assert.equal(url.searchParams.get("include"), collection[2]);
      if (type === "artists") assert.equal(url.searchParams.get("collapseBy"), "NONE");
      return Response.json({ data: collectionTrackIds[type].map((id) => ({ type: "tracks", id })) });
    }
    if (url.pathname === "/v2/tracks") {
      assert.equal(url.searchParams.get("countryCode"), "DK");
      assert.equal(url.searchParams.get("include"), "artists,albums");
      const ids = url.searchParams.get("filter[id]").split(",");
      return Response.json({
        data: [...ids].reverse().map((id, index) => ({
          type: "tracks",
          id,
          attributes: { title: `Track ${id}`, duration: "PT3M", trackNumber: index + 1 },
          relationships: {
            artists: { data: [{ type: "artists", id: `artist-${id}` }] },
            albums: { data: [{ type: "albums", id: `album-${id}` }] },
          },
        })),
        included: ids.flatMap((id) => [
          { type: "artists", id: `artist-${id}`, attributes: { name: `Artist ${id}` } },
          { type: "albums", id: `album-${id}`, attributes: { title: `Album ${id}` } },
        ]),
      });
    }
    throw new Error(`unexpected TIDAL request: ${url}`);
  });

  const album = await tidal.queryTidal(subject, {
    kind: "album_artist",
    primary: "Kind of Blue",
    secondary: "Miles Davis",
    limit: 10,
  });
  const artist = await tidal.queryTidal(subject, {
    kind: "artist",
    primary: "Nina Simone",
    limit: 10,
  });
  const playlist = await tidal.queryTidal(subject, {
    kind: "playlist",
    primary: "Late night jazz",
    limit: 10,
  });

  assert.deepEqual(album.map((track) => track.id), ["tidal:track-2", "tidal:track-1"]);
  assert.deepEqual(artist.map((track) => track.id), ["tidal:track-3"]);
  assert.deepEqual(playlist.map((track) => track.id), ["tidal:track-4", "tidal:track-3"]);
  assert.equal((await accounts.readMusicAccountRecord(subject)).tidal.credentials.country_code, "DK");
  assert.equal(calls.filter((call) => call === "/v2/users/wearer-123").length, 1);
  assert.ok(calls.some((call) => {
    const url = new URL(call, "https://openapi.tidal.com");
    return url.pathname === "/v2/searchResults" &&
      url.searchParams.get("filter[query]") === "Kind of Blue Miles Davis" &&
      url.searchParams.get("include") === "albums";
  }));
  assert.ok(calls.some((call) => call.startsWith("/v2/albums/album-1/relationships/items?")));
  assert.ok(calls.some((call) => call.startsWith("/v2/artists/artist-1/relationships/tracks?")));
  assert.ok(calls.some((call) => call.startsWith("/v2/playlists/playlist-1/relationships/items?")));
});

test("TIDAL resolves more than twenty track IDs in bounded batches and preserves their order", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  environment(t, "TIDAL_COUNTRY_CODE", "DK");
  const subject = "tidal-large-collection";
  await accounts.updateMusicAccountRecord(subject, () => ({
    tidal: { credentials: { access_token: "valid-access", expires_at: Date.now() + 3_600_000 } },
  }));
  const requested = Array.from({ length: 45 }, (_, index) => `tidal:${index + 1}`);
  const batches = [];
  useProviderFetch(t, async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.pathname, "/v2/tracks");
    const ids = url.searchParams.get("filter[id]").split(",");
    assert.ok(ids.length <= 20, "the official filter[id] schema allows at most twenty IDs");
    batches.push(ids);
    return Response.json({ data: [...ids].reverse().map((id) => ({
      type: "tracks", id, attributes: { title: `Track ${id}` },
    })) });
  });

  const tracks = await tidal.queryTidal(subject, { kind: "ids", ids: requested, limit: 100 });
  assert.deepEqual(tracks.map((track) => track.id), requested);
  assert.deepEqual(batches.map((ids) => ids.length), [20, 20, 5]);
});

test("TIDAL disconnect wins a race with token refresh and cannot recreate credentials", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  environment(t, "TIDAL_COUNTRY_CODE", "DK");
  const subject = "tidal-refresh-race";
  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    tidal: {
      connected_at: "2026-08-18T00:00:00.000Z",
      credentials: {
        access_token: "expired-access-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - 1_000,
        user_id: "wearer-123",
      },
    },
  }));

  let releaseRefresh;
  const refreshStarted = Promise.withResolvers();
  useProviderFetch(t, async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://auth.tidal.com") throw new Error(`unexpected TIDAL request: ${url}`);
    refreshStarted.resolve();
    await new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    return Response.json({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 3600,
      user_id: "wearer-123",
    });
  });

  const query = tidal.queryTidal(subject, { kind: "track", primary: "Blue", limit: 1 });
  await refreshStarted.promise;
  await tidal.disconnectTidal(subject);
  releaseRefresh();
  await assert.rejects(
    query,
    (error) => error instanceof tidal.TidalMusicError && error.status === 401,
  );
  assert.equal((await accounts.readMusicAccountRecord(subject)).tidal, undefined);
});

test("concurrent TIDAL playbacks share one expired-token refresh per wearer", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  const subject = "tidal-refresh-single-flight";
  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    tidal: {
      connected_at: "2026-08-18T00:00:00.000Z",
      credentials: {
        access_token: "expired-access-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - 1_000,
        user_id: "wearer-123",
      },
    },
  }));

  const releaseRefresh = Promise.withResolvers();
  const refreshStarted = Promise.withResolvers();
  let refreshCalls = 0;
  let lookupCalls = 0;
  useProviderFetch(t, async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://auth.tidal.com") {
      refreshCalls += 1;
      refreshStarted.resolve();
      await releaseRefresh.promise;
      return Response.json({
        access_token: "rotated-access-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 3_600,
        user_id: "wearer-123",
      });
    }
    lookupCalls += 1;
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer rotated-access-token");
    const id = url.pathname.split("/").at(-1);
    return Response.json({
      data: {
        type: "trackFiles",
        id,
        attributes: {
          trackPresentation: "FULL",
          url: `https://audio.tdlcdn.com/${id}.m4a`,
        },
      },
    });
  });

  const first = tidal.tidalStreamUrl(subject, "tidal:first");
  await refreshStarted.promise;
  const second = tidal.tidalStreamUrl(subject, "tidal:second");
  await new Promise((resolve) => setTimeout(resolve, 100));
  releaseRefresh.resolve();

  assert.deepEqual(await Promise.all([first, second]), [
    "https://audio.tdlcdn.com/first.m4a",
    "https://audio.tdlcdn.com/second.m4a",
  ]);
  assert.equal(refreshCalls, 1);
  assert.equal(lookupCalls, 2);
});

test("a TIDAL caller leaving after refresh dispatch cannot invalidate the rotation", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  const subject = "tidal-abandoned-refresh-flight";
  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    tidal: {
      connected_at: "2026-08-18T00:00:00.000Z",
      credentials: {
        access_token: "expired-access-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - 1_000,
        user_id: "wearer-123",
      },
    },
  }));

  const firstRefreshStarted = Promise.withResolvers();
  const releaseFirstRefresh = Promise.withResolvers();
  let refreshCalls = 0;
  t.after(() => {
    releaseFirstRefresh.resolve();
  });
  useProviderFetch(t, async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://auth.tidal.com") {
      const call = ++refreshCalls;
      if (call > 1) return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (call === 1) {
        firstRefreshStarted.resolve();
        await releaseFirstRefresh.promise;
      }
      return Response.json({
        access_token: "rotated-access-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 3_600,
        user_id: "wearer-123",
      });
    }
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer rotated-access-token");
    return Response.json({
      data: {
        type: "trackFiles",
        id: "replacement",
        attributes: {
          trackPresentation: "FULL",
          url: "https://audio.tdlcdn.com/replacement.m4a",
        },
      },
    });
  });

  const firstDeadline = new AbortController();
  const abandoned = tidal.tidalStreamUrl(subject, "tidal:abandoned", firstDeadline.signal);
  await firstRefreshStarted.promise;
  firstDeadline.abort(new DOMException("caller left", "AbortError"));
  await assert.rejects(
    abandoned,
    (error) => error instanceof tidal.TidalMusicError && error.status === 503,
  );

  const replacement = tidal.tidalStreamUrl(subject, "tidal:replacement");
  void replacement.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 100));
  releaseFirstRefresh.resolve();

  assert.equal(await replacement, "https://audio.tdlcdn.com/replacement.m4a");
  assert.equal(refreshCalls, 1);
});

test("a completed TIDAL rotation remains usable after its caller leaves", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  const subject = "tidal-abandoned-queued-refresh";
  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    tidal: {
      connected_at: "2026-08-18T00:00:00.000Z",
      credentials: {
        access_token: "expired-access-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - 1_000,
        user_id: "wearer-123",
      },
    },
  }));

  // A slow writer read the expired grant before the rotation and writes after
  // it. Its stale write is refused, so it cannot put the expired token back.
  const slowWriterRead = Promise.withResolvers();
  const releaseSlowWriter = Promise.withResolvers();
  const slowWriter = accounts.updateMusicAccountRecord(subject, async (record) => {
    slowWriterRead.resolve();
    await releaseSlowWriter.promise;
    return record;
  });
  await slowWriterRead.promise;

  const firstRefreshBodyStarted = Promise.withResolvers();
  const releaseFirstRefreshBody = Promise.withResolvers();
  let firstRefreshBodyCancelled = false;
  let refreshCalls = 0;
  t.after(async () => {
    releaseSlowWriter.resolve();
    releaseFirstRefreshBody.resolve();
    await slowWriter;
  });
  useProviderFetch(t, async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://auth.tidal.com") {
      const call = ++refreshCalls;
      if (call > 1) return Response.json({ error: "invalid_grant" }, { status: 400 });
      const encoded = new TextEncoder().encode(JSON.stringify({
        access_token: "rotated-access-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 3_600,
        user_id: "wearer-123",
      }));
      let bodyStarted = false;
      return new Response(new ReadableStream({
        pull(controller) {
          if (bodyStarted) return;
          bodyStarted = true;
          firstRefreshBodyStarted.resolve();
          void releaseFirstRefreshBody.promise.then(() => {
            if (firstRefreshBodyCancelled) return;
            controller.enqueue(encoded);
            controller.close();
          });
        },
        cancel() {
          firstRefreshBodyCancelled = true;
        },
      }, { highWaterMark: 0 }), {
        headers: { "content-type": "application/json" },
      });
    }
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer rotated-access-token");
    return Response.json({
      data: {
        type: "trackFiles",
        id: "replacement",
        attributes: {
          trackPresentation: "FULL",
          url: "https://audio.tdlcdn.com/replacement.m4a",
        },
      },
    });
  });

  const firstDeadline = new AbortController();
  const abandoned = tidal.tidalStreamUrl(subject, "tidal:abandoned", firstDeadline.signal);
  await firstRefreshBodyStarted.promise;
  firstDeadline.abort(new DOMException("caller left", "AbortError"));
  await assert.rejects(
    abandoned,
    (error) => error instanceof tidal.TidalMusicError && error.status === 503,
  );

  const replacement = tidal.tidalStreamUrl(subject, "tidal:replacement");
  releaseFirstRefreshBody.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  releaseSlowWriter.resolve();
  await slowWriter;

  assert.equal(await replacement, "https://audio.tdlcdn.com/replacement.m4a");
  assert.equal(refreshCalls, 1);
  assert.equal(firstRefreshBodyCancelled, false);
  assert.equal(
    cosmos.requests.filter((request) => request.method === "PUT" && request.body.revision === 1).length,
    2,
    "the rotation and the slow writer both wrote from revision 1; only the rotation was kept",
  );
  assert.equal(
    (await accounts.readMusicAccountRecord(subject)).tidal.credentials.access_token,
    "rotated-access-token",
  );
});

test("a stale TIDAL credential read reuses the rotation that already settled", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  const subject = "tidal-stale-read-after-refresh";
  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    tidal: {
      connected_at: "2026-08-18T00:00:00.000Z",
      credentials: {
        access_token: "expired-access-token",
        refresh_token: "single-use-refresh-token",
        expires_at: Date.now() - 1_000,
        user_id: "wearer-123",
      },
    },
  }));

  const firstRefreshStarted = Promise.withResolvers();
  const releaseFirstRefresh = Promise.withResolvers();
  let refreshCalls = 0;
  useProviderFetch(t, async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://auth.tidal.com") {
      const call = ++refreshCalls;
      if (call > 1) return Response.json({ error: "invalid_grant" }, { status: 400 });
      firstRefreshStarted.resolve();
      await releaseFirstRefresh.promise;
      return Response.json({
        access_token: "rotated-access-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 3_600,
        user_id: "wearer-123",
      });
    }
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer rotated-access-token");
    const id = url.pathname.split("/").at(-1);
    return Response.json({
      data: {
        type: "trackFiles",
        id,
        attributes: {
          trackPresentation: "FULL",
          url: `https://audio.tdlcdn.com/${id}.m4a`,
        },
      },
    });
  });

  const staleReadStarted = Promise.withResolvers();
  const releaseStaleRead = Promise.withResolvers();
  t.after(() => {
    releaseFirstRefresh.resolve();
    releaseStaleRead.resolve();
  });

  const first = tidal.tidalStreamUrl(subject, "tidal:first");
  await firstRefreshStarted.promise;
  // The second playback's read takes the expired grant, then waits here
  // while the first playback's rotation lands.
  cosmos.afterRead = async () => {
    staleReadStarted.resolve();
    await releaseStaleRead.promise;
  };
  const second = tidal.tidalStreamUrl(subject, "tidal:second");
  await staleReadStarted.promise;

  releaseFirstRefresh.resolve();
  assert.equal(await first, "https://audio.tdlcdn.com/first.m4a");
  await new Promise((resolve) => setImmediate(resolve));
  releaseStaleRead.resolve();

  assert.equal(await second, "https://audio.tdlcdn.com/second.m4a");
  assert.equal(refreshCalls, 1);
  assert.equal(
    (await accounts.readMusicAccountRecord(subject)).tidal.credentials.access_token,
    "rotated-access-token",
  );
});

test("TIDAL catalog rejects malformed documents without inventing an empty library", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  environment(t, "TIDAL_COUNTRY_CODE", "DK");
  const subject = "tidal-malformed-document";
  cosmosWearer(`U:${subject}`).accounts = { tidal: { credentials: { access_token: "fixture-token", expires_at: Date.now() + 3_600_000 } } };
  let response;
  useProviderFetch(t, async () => Response.json(response));
  for (response of [null, {}, { data: [null] }, { data: [{ type: "tracks", id: "1", attributes: { title: 42 } }] }]) {
    await assert.rejects(() => tidal.queryTidal(subject, { kind: "ids", ids: ["tidal:1"], limit: 1 }), (error) => error instanceof tidal.TidalMusicError);
  }
  response = { data: [] };
  assert.deepEqual(await tidal.queryTidal(subject, { kind: "ids", ids: ["tidal:1"], limit: 1 }), []);
});

test("TIDAL playback accepts only official full-track HTTPS files", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  environment(t, "LUMA_MUSIC_GATEWAY_ORIGIN", "https://center.example.test");
  const subject = "tidal-playback-wearer";
  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    tidal: {
      connected_at: "2026-08-18T00:00:00.000Z",
      credentials: {
        access_token: "tidal-access-token",
        refresh_token: "tidal-refresh-token",
        expires_at: Date.now() + 60 * 60_000,
        user_id: "wearer-123",
      },
    },
  }));

  useProviderFetch(t, async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const id = url.pathname.split("/").at(-1);
    return Response.json({
      data: {
        type: "trackFiles",
        id,
        attributes: {
          trackPresentation: id === "preview" ? "PREVIEW" : "FULL",
          url: `https://audio.tdlcdn.com/${id}.m4a`,
        },
      },
    });
  });

  await assert.rejects(
    () => tidal.tidalStreamUrl(subject, "tidal:preview"),
    (error) => error instanceof tidal.TidalMusicError && error.status === 403,
  );
  assert.equal(
    await tidal.tidalStreamUrl(subject, "tidal:full"),
    "https://audio.tdlcdn.com/full.m4a",
  );
  assert.deepEqual(
    await gateway.gatewayPlayback(subject, "tidal", "tidal:full"),
    { url: "https://audio.tdlcdn.com/full.m4a" },
  );
});

test("TIDAL refresh and playback lookup share one absolute resolution budget", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  const subject = "tidal-shared-playback-budget";
  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    tidal: {
      connected_at: "2026-08-18T00:00:00.000Z",
      credentials: {
        access_token: "expired-access-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - 1_000,
        user_id: "wearer-123",
      },
    },
  }));

  const calls = [];
  const cancelledBodies = [];
  useProviderFetch(t, async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const kind = url.origin === "https://auth.tidal.com" ? "refresh" : "lookup";
    calls.push(kind);
    if (url.origin === "https://auth.tidal.com") {
      return delayedJsonBody({
        access_token: "refreshed-access-token",
        refresh_token: "refreshed-refresh-token",
        expires_in: 3_600,
        user_id: "wearer-123",
      }, 120, () => cancelledBodies.push(kind));
    }
    return delayedJsonBody({
      data: {
        type: "trackFiles",
        id: "shared",
        attributes: {
          trackPresentation: "FULL",
          url: "https://audio.tdlcdn.com/shared.m4a",
        },
      },
    }, 120, () => cancelledBodies.push(kind));
  });

  const operationSignal = AbortSignal.timeout(200);
  const originalTimeout = AbortSignal.timeout;
  const requestCaps = [];
  AbortSignal.timeout = (milliseconds) => {
    requestCaps.push(milliseconds);
    return originalTimeout(milliseconds);
  };
  t.after(() => {
    AbortSignal.timeout = originalTimeout;
  });
  await assert.rejects(
    () => tidal.tidalStreamUrl(subject, "tidal:shared", operationSignal),
    (error) =>
      error instanceof tidal.TidalMusicError &&
      error.status === 503 &&
      error.message === "TIDAL could not be reached.",
  );
  assert.deepEqual(calls, ["refresh", "lookup"]);
  assert.deepEqual(cancelledBodies, ["lookup"]);
  assert.deepEqual(
    requestCaps.filter((milliseconds) => milliseconds !== COSMOS_DEADLINE_MS),
    [15_000, 15_000],
    "each TIDAL request keeps its own cap; the Cosmos account reads keep theirs",
  );
});

test("TIDAL playback deadlines preserve an accepted token rotation", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  const subject = "tidal-refresh-playback-deadline";
  await accounts.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    tidal: {
      connected_at: "2026-08-18T00:00:00.000Z",
      credentials: {
        access_token: "expired-access-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - 1_000,
        user_id: "wearer-123",
      },
    },
  }));

  const refreshBodyStarted = Promise.withResolvers();
  const releaseRefreshBody = Promise.withResolvers();
  const cancelledBodies = [];
  let refreshCalls = 0;
  t.after(() => {
    releaseRefreshBody.resolve();
  });
  useProviderFetch(t, async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://auth.tidal.com") {
      refreshCalls += 1;
      const encoded = new TextEncoder().encode(JSON.stringify({
        access_token: "refreshed-access-token",
        refresh_token: "refreshed-refresh-token",
        expires_in: 3_600,
        user_id: "wearer-123",
      }));
      let bodyStarted = false;
      let bodyCancelled = false;
      return new Response(new ReadableStream({
        pull(controller) {
          if (bodyStarted) return;
          bodyStarted = true;
          refreshBodyStarted.resolve();
          void releaseRefreshBody.promise.then(() => {
            if (bodyCancelled) return;
            controller.enqueue(encoded);
            controller.close();
          });
        },
        cancel() {
          bodyCancelled = true;
          cancelledBodies.push("refresh");
        },
      }, { highWaterMark: 0 }), {
        headers: { "content-type": "application/json" },
      });
    }
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer refreshed-access-token");
    return Response.json({
      data: {
        type: "trackFiles",
        id: "shared",
        attributes: {
          trackPresentation: "FULL",
          url: "https://audio.tdlcdn.com/shared.m4a",
        },
      },
    });
  });

  const deadline = new AbortController();
  const playback = tidal.tidalStreamUrl(subject, "tidal:shared", deadline.signal);
  await refreshBodyStarted.promise;
  deadline.abort(new DOMException("playback deadline", "TimeoutError"));

  await assert.rejects(
    () => playback,
    (error) =>
      error instanceof tidal.TidalMusicError &&
      error.status === 503 &&
      error.message === "TIDAL could not be reached.",
  );
  const replacement = tidal.tidalStreamUrl(subject, "tidal:shared");
  releaseRefreshBody.resolve();

  assert.equal(await replacement, "https://audio.tdlcdn.com/shared.m4a");
  assert.equal(refreshCalls, 1);
  assert.deepEqual(cancelledBodies, []);
});

test("Apple MusicKit user-token handoff is kept in Cosmos and remains playback-gated", async (t) => {
  cosmosAccounts(t);
  environment(t, "APPLE_MUSIC_DEVELOPER_TOKEN", "header.payload.signature");
  const subject = WEB_WEARER;

  await apple.connectAppleMusic(subject, "apple-music-user-token", "DK");
  assert.deepEqual((await gateway.musicAccountStatus(subject)).providers.apple_music, {
    configured: true,
    state: "connected_playback_runtime_required",
  });
  const account = (await accounts.readMusicAccountRecord(subject)).apple_music;
  assert.equal(account.music_user_token, "apple-music-user-token");
  assert.equal(account.storefront, "dk");

  await apple.disconnectAppleMusic(subject);
  assert.deepEqual((await gateway.musicAccountStatus(subject)).providers.apple_music, {
    configured: true,
    state: "not_connected",
  });
  assert.deepEqual(await accounts.readMusicAccountRecord(subject), {});
});

test("album artwork is resolved by Cosmos, and only an HTTPS cover is relayed", async (t) => {
  cosmosAccounts(t);
  assert.equal(
    await accounts.musicArtworkUrl("youtube_music", "Zi_XLOBDo_Y"),
    "https://i.ytimg.com/vi/Zi_XLOBDo_Y/hqdefault.jpg",
  );
  assert.equal(cosmos.requests.at(-1).path, "/music/artwork/youtube_music/Zi_XLOBDo_Y");
  for (const [provider, id] of [["spotify", "5ChkMS8OtdzJeqyybCc9R5"], ["tidal", "1"]]) {
    await assert.rejects(() => accounts.musicArtworkUrl(provider, id));
  }
  const route = await source("src/app/api/settings/services/music/artwork/[provider]/[id]/route.ts");
  assert.match(route, /requireSpotifySession/);
  assert.match(route, /musicArtworkUrl\(provider, id\)/);
  assert.match(route, /status: 302/);
});

test("the Pin gateway bearer is derived, constant-time checked, and errors retain provider status", async (t) => {
  environment(t, "LUMA_SPOTIFY_ADAPTER_TOKEN_FILE", undefined);
  environment(t, "LUMA_SPOTIFY_ADAPTER_TOKEN", "adapter-root-token-".repeat(3));
  const bridgeFetch = await configuredPinBridge(t);
  environment(t, "LUMA_MUSIC_GATEWAY_ORIGIN", "https://center.example.test");
  const bearer = await spotifyBridge.deviceMusicGatewayToken(undefined, bridgeFetch);

  assert.notEqual(bearer, process.env.LUMA_SPOTIFY_ADAPTER_TOKEN);
  assert.equal(
    await gateway.authenticateMusicGateway(new Request("https://center.example.test/api/music-gateway/query", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
    }), undefined, bridgeFetch),
    "owner-subject",
  );
  await assert.rejects(
    () => gateway.authenticateMusicGateway(new Request("https://center.example.test/api/music-gateway/query", {
      method: "POST",
      headers: { authorization: `Bearer ${"x".repeat(43)}` },
    }), undefined, bridgeFetch),
    (error) => error instanceof gateway.MusicGatewayError && error.status === 401,
  );

  assert.equal(gateway.musicGatewayError(new tidal.TidalMusicError("busy", 429)).status, 429);
  assert.equal(gateway.musicGatewayError(new apple.AppleMusicError("bad token", 400)).status, 400);
});

test("a caller without a device bearer is refused before the Pin's state is read", async () => {
  let asked = false;
  const neverAsked = async () => {
    asked = true;
    throw new Error("the Pin bridge must not be asked for an anonymous caller");
  };
  for (const headers of [{}, { authorization: "Bearer short" }, { authorization: "Basic abc" }]) {
    await assert.rejects(
      () => gateway.authenticateMusicGateway(new Request("https://center.example.test/api/music-gateway/query", {
        method: "POST",
        headers,
      }), undefined, neverAsked),
      (error) => error instanceof gateway.MusicGatewayError && error.status === 401 && error.message === "Unauthorized.",
    );
  }
  assert.equal(asked, false);
});

test("device music authentication honors the playback deadline", async (t) => {
  environment(t, "LUMA_SPOTIFY_ADAPTER_TOKEN_FILE", undefined);
  environment(t, "LUMA_SPOTIFY_ADAPTER_TOKEN", "adapter-root-token-".repeat(3));
  const bridgeFetch = await configuredPinBridge(t);
  const bearer = await spotifyBridge.deviceMusicGatewayToken(undefined, bridgeFetch);
  const request = new Request("https://center.example.test/api/music-gateway/playback", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ provider: "tidal", id: "tidal:track" }),
  });
  const timeoutError = new DOMException("playback deadline", "TimeoutError");
  const deadline = AbortSignal.abort(timeoutError);

  await assert.rejects(
    () => routeSupport.deviceMusicRequest(request, deadline, bridgeFetch),
    (error) => error === timeoutError,
  );
});

test("the playback deadline includes authentication and request-body parsing", async (t) => {
  environment(t, "LUMA_SPOTIFY_ADAPTER_TOKEN_FILE", undefined);
  environment(t, "LUMA_SPOTIFY_ADAPTER_TOKEN", "adapter-root-token-".repeat(3));
  const bridgeFetch = await configuredPinBridge(t);
  const bearer = await spotifyBridge.deviceMusicGatewayToken(undefined, bridgeFetch);
  useProviderFetch(t, bridgeFetch);

  const originalTimeout = AbortSignal.timeout;
  const playbackDeadline = new AbortController();
  AbortSignal.timeout = (milliseconds) =>
    milliseconds === 40_000 ? playbackDeadline.signal : originalTimeout(milliseconds);
  t.after(() => {
    AbortSignal.timeout = originalTimeout;
  });

  const requestController = new AbortController();
  const fallbackAbort = setTimeout(() => requestController.abort(), 250);
  t.after(() => clearTimeout(fallbackAbort));
  let bodyCancelled = false;
  const bodyStarted = Promise.withResolvers();
  const request = new Request("https://center.example.test/api/music-gateway/playback", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: new ReadableStream({
      pull() {
        bodyStarted.resolve();
      },
      cancel() {
        bodyCancelled = true;
      },
    }),
    duplex: "half",
    signal: requestController.signal,
  });

  const responsePromise = playbackRoute.POST(request);
  await bodyStarted.promise;
  const startedAt = performance.now();
  playbackDeadline.abort(new DOMException("playback deadline", "TimeoutError"));
  const response = await responsePromise;

  assert.equal(response.status, 408);
  assert.deepEqual(await response.json(), { error: "Music request timed out." });
  assert.equal(bodyCancelled, true);
  assert.equal(requestController.signal.aborted, false);
  assert.ok(performance.now() - startedAt < 150, "the 40-second route budget did not cover the body read");
});

test("Center exposes only exact authenticated gateway operations and no public audio relay", async () => {
  const [middleware, requestSupport, playbackRoute, musicView, appleRoute, nextConfig] = await Promise.all([
    source("src/middleware.ts"),
    source("src/app/api/music-gateway/routeSupport.ts"),
    source("src/app/api/music-gateway/playback/route.ts"),
    source("src/app/settings/account/services/SpotifyServiceCard.tsx"),
    source("src/app/api/settings/services/music/apple/route.ts"),
    source("next.config.mjs"),
  ]);
  assert.match(middleware, /\/api\/music-gateway\/query/);
  assert.match(middleware, /\/api\/music-gateway\/playback/);
  assert.match(middleware, /\/api\/music-gateway\/save/);
  assert.doesNotMatch(middleware, /music-gateway\/stream/);
  assert.match(requestSupport, /request\.body.*getReader/);
  assert.match(requestSupport, /QUERY_KINDS/);
  assert.match(requestSupport, /exactKeys/);
  assert.match(playbackRoute, /MUSIC_PLAYBACK_RESOLUTION_TIMEOUT_MS\s*=\s*40_000/);
  assert.match(playbackRoute, /AbortSignal\.any\(\[\s*request\.signal,\s*AbortSignal\.timeout/);
  assert.match(playbackRoute, /gatewayPlayback\([^;]+playbackSignal/s);
  assert.match(musicView, /musickit\/v3\/musickit\.js/);
  assert.match(musicView, /instance\.authorize\(\)/);
  assert.match(musicView, /music_user_token: musicUserToken/);
  assert.match(musicView, /Your Apple Music account is stored securely/);
  assert.match(musicView, /Apple Music playback isn’t supported on the Pin yet/);
  assert.match(appleRoute, /maxBytes: 24 \* 1024/);
  assert.match(nextConfig, /connect-src[^\n]+https:\/\/api\.music\.apple\.com/);
  assert.match(nextConfig, /frame-src[^\n]+https:\/\/authorize\.music\.apple\.com/);
  assert.doesNotMatch(musicView, /Metrolist|NewPipe APK|install (?:an|the) app on the Pin/i);
  // Apple's consent sheet shows this app name. The card speaks of Luma.
  assert.match(musicView, /app: \{ name: "Luma Center"/);
  assert.doesNotMatch(musicView, /Penumbra/);
});


// Unrecorded player fixture: exercise the exact fetch boundary the SDK uses.
test("YouTube player fetch strips scheduling fields while preserving song formats", async () => {
  const player = {
    videoDetails: { videoId: "Zi_XLOBDo_Y", title: "Fixture song" },
    streamingData: { adaptiveFormats: [{ itag: 140, mimeType: "audio/mp4", url: "https://r1.googlevideo.com/videoplayback?id=song" }] },
    playerAds: [{ ad: "fixture" }],
    adBreakHeartbeatParams: { token: "fixture" },
    nested: [{ adSlots: [1], adPlacements: [2], adBreakHeartbeatParams: {}, keep: true }],
  };
  let calls = 0;
  const filteredFetch = youtube.adBlockingYoutubeFetchUsing(async (_input, init) => {
    calls++;
    assert.equal(init.redirect, "error");
    return new Response(JSON.stringify(player), { headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": "12345", "content-encoding": "gzip", "x-fixture": "preserved",
    } });
  });
  const response = await filteredFetch("https://music.youtube.com/youtubei/v1/player");
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(response.headers.get("x-fixture"), "preserved");
  assert.deepEqual(await response.json(), {
    videoDetails: player.videoDetails, streamingData: player.streamingData,
    nested: [{ keep: true }],
  });
  for (const url of [
    "https://ads.doubleclick.net/pagead", "https://pagead2.googlesyndication.com/pagead",
    "https://youtube.com.example.test/youtubei/v1/player", "http://music.youtube.com/youtubei/v1/player",
  ]) await assert.rejects(() => filteredFetch(url), /blocked an advertising or unexpected request/);
  assert.equal(calls, 1);
});

test("YouTube player filtering rejects malformed and streamed oversized JSON", async () => {
  const malformed = youtube.adBlockingYoutubeFetchUsing(async () => new Response("{broken", {
    headers: { "content-type": "application/json" },
  }));
  await assert.rejects(() => malformed("https://www.youtube.com/youtubei/v1/player"), /invalid response/);
  let pulls = 0;
  let cancelled = false;
  const oversized = youtube.adBlockingYoutubeFetchUsing(async () => new Response(new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(pulls === 1 ? 16 * 1024 * 1024 : 1));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } }));
  await assert.rejects(() => oversized("https://www.youtube.com/youtubei/v1/player"), /oversized response/);
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
});


test("YouTube player JSON cannot bypass ad filtering through a wrong media type", async () => {
  const fetchPlayer = youtube.adBlockingYoutubeFetchUsing(async () => new Response(
    JSON.stringify({ videoDetails: { videoId: "Zi_XLOBDo_Y" }, playerAds: ["fixture"] }),
    { headers: { "content-type": "text/plain" } },
  ));
  await assert.rejects(() => fetchPlayer("https://music.youtube.com/youtubei/v1/player"),
    (error) => error instanceof youtube.YoutubeMusicError && error.status === 502);
  const script = new Response("fixture script", { headers: { "content-type": "text/javascript" } });
  const fetchScript = youtube.adBlockingYoutubeFetchUsing(async () => script);
  assert.equal(await fetchScript("https://www.youtube.com/s/player/fixture/base.js"), script);
});


test("YouTube stripped player response parses through the SDK into the requested audio stream", async () => {
  const { Mixins } = await import("youtubei.js");
  const videoId = "Zi_XLOBDo_Y";
  const payload = {
    playabilityStatus: { status: "OK" },
    videoDetails: { videoId, title: "Fixture song", author: "Fixture artist", lengthSeconds: "180", thumbnail: { thumbnails: [] } },
    streamingData: { expiresInSeconds: "3600", formats: [], adaptiveFormats: [{
      itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000,
      audioQuality: "AUDIO_QUALITY_MEDIUM", audioSampleRate: "44100", audioChannels: 2,
      url: "https://r1.googlevideo.com/videoplayback?id=song",
    }] },
    playerAds: [{ ad: "fixture" }], adBreakHeartbeatParams: { token: "fixture" },
  };
  const filteredFetch = youtube.adBlockingYoutubeFetchUsing(async () => Response.json(payload));
  const client = {
    session: { player: undefined },
    getBasicInfo: async (requested, options) => {
      assert.equal(requested, videoId);
      assert.equal(options.client, "YTMUSIC");
      const response = await filteredFetch("https://music.youtube.com/youtubei/v1/player");
      const data = await response.json();
      assert.equal(data.playerAds, undefined);
      assert.equal(data.adBreakHeartbeatParams, undefined);
      return new Mixins.MediaInfo([{ data }], { session: { player: undefined } }, "fixture-cpn");
    },
  };
  const stream = new URL(await youtube.resolveYoutubeAudioStream(client, videoId, "fixture-proof"));
  assert.equal(stream.searchParams.get("id"), "song");
  assert.equal(stream.searchParams.get("pot"), "fixture-proof");
});

// Lifecycle failures: a delayed country lookup can overwrite a newly linked
// account's region or continue a cancelled catalog request under its grant.
test("TIDAL country lookup cannot overwrite a replacement after disconnect", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_COUNTRY_CODE", undefined);
  const subject = "tidal-country-replacement";
  const oldCredentials = { access_token: "generated-old-token", refresh_token: "generated-old-refresh", expires_at: Date.now() + 3_600_000 };
  await accounts.updateMusicAccountRecord(subject, () => ({ tidal: { credentials: oldCredentials } }));
  let lookupStarted;
  const started = new Promise((resolve) => { lookupStarted = resolve; });
  let releaseLookup;
  const released = new Promise((resolve) => { releaseLookup = resolve; });
  let catalogCalls = 0;
  useProviderFetch(t, async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v2/users/me") {
      lookupStarted();
      await released;
      return Response.json({ data: { type: "users", id: "fixture-old-user", attributes: { country: "US" } } });
    }
    catalogCalls += 1;
    return Response.json({ data: [] });
  });
  const operation = tidal.queryTidal(subject, { kind: "favorites", limit: 1 });
  const outcome = operation.then(() => null, (error) => error);
  await started;
  await tidal.disconnectTidal(subject);
  await accounts.updateMusicAccountRecord(subject, () => ({ tidal: { credentials: { ...oldCredentials, access_token: "generated-new-token", refresh_token: "generated-new-refresh", country_code: "FR" } } }));
  releaseLookup();
  const error = await outcome;
  assert.equal((await accounts.readMusicAccountRecord(subject)).tidal.credentials.country_code, "FR");
  assert.ok(error instanceof tidal.TidalMusicError);
  assert.equal(error.status, 409);
  assert.equal(catalogCalls, 0);
});

test("TIDAL re-sign-in cancels the previous account country lookup", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_COUNTRY_CODE", undefined);
  environment(t, "TIDAL_CLIENT_ID", "fixture-client-id");
  environment(t, "LUMA_MUSIC_GATEWAY_ORIGIN", "https://center.example.test");
  const subject = "tidal-country-resign-in";
  await accounts.updateMusicAccountRecord(subject, () => ({ tidal: { credentials: { access_token: "generated-old-token", refresh_token: "generated-old-refresh", expires_at: Date.now() + 3_600_000 } } }));
  let lookupStarted;
  const started = new Promise((resolve) => { lookupStarted = resolve; });
  let releaseLookup;
  const released = new Promise((resolve) => { releaseLookup = resolve; });
  let catalogCalls = 0;
  useProviderFetch(t, async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v2/users/me") {
      lookupStarted();
      await released;
      return Response.json({ data: { type: "users", id: "fixture-old-user", attributes: { country: "US" } } });
    }
    if (url.pathname === "/v1/oauth2/token") {
      return Response.json({ access_token: "generated-new-token", refresh_token: "generated-new-refresh", expires_in: 3600, country_code: "FR" });
    }
    catalogCalls += 1;
    return Response.json({ data: [] });
  });
  const outcome = tidal.queryTidal(subject, { kind: "favorites", limit: 1 }).then(() => null, (error) => error);
  await started;
  const authorization = new URL(await tidal.startTidalConnection(subject));
  await tidal.finishTidalConnection(subject, "fixture-code", authorization.searchParams.get("state"));
  releaseLookup();
  const error = await outcome;
  const credentials = (await accounts.readMusicAccountRecord(subject)).tidal.credentials;
  assert.equal(credentials.country_code, "FR");
  assert.equal(credentials.access_token, "generated-new-token");
  assert.ok(error instanceof tidal.TidalMusicError);
  assert.equal(error.status, 409);
  assert.equal(catalogCalls, 0);
});

test("TIDAL abandoned re-sign-in preserves a dispatched credential rotation", async (t) => {
  cosmosAccounts(t);
  environment(t, "TIDAL_CLIENT_ID", "fixture-client-id");
  environment(t, "LUMA_MUSIC_GATEWAY_ORIGIN", "https://center.example.test");
  const subject = "tidal-pending-sign-in-refresh";
  await accounts.updateMusicAccountRecord(subject, () => ({ tidal: { credentials: { access_token: "generated-expired-token", refresh_token: "generated-old-refresh", expires_at: Date.now() - 1000, country_code: "DK" } } }));
  let refreshStarted;
  const started = new Promise((resolve) => { refreshStarted = resolve; });
  let releaseRefresh;
  const released = new Promise((resolve) => { releaseRefresh = resolve; });
  useProviderFetch(t, async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/oauth2/token") {
      refreshStarted();
      await released;
      return Response.json({ access_token: "generated-rotated-token", refresh_token: "generated-rotated-refresh", expires_in: 3600 });
    }
    return Response.json({ data: [] });
  });
  const outcome = tidal.queryTidal(subject, { kind: "favorites", limit: 1 }).then((items) => ({ items }), (error) => ({ error }));
  await started;
  const authorization = new URL(await tidal.startTidalConnection(subject));
  await tidal.abandonTidalConnection(subject, authorization.searchParams.get("state"));
  releaseRefresh();
  const result = await outcome;
  assert.equal((await accounts.readMusicAccountRecord(subject)).tidal.credentials.access_token, "generated-rotated-token");
  assert.deepEqual(result.items, []);
});
