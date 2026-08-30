import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Innertube, Platform, Player } from "youtubei.js";

// Node 22.14 supports the out-of-thread register() hook used by every other
// Center source test, but not the newer synchronous registerHooks() API.
import "./tsResolve.mjs";

const root = new URL("../", import.meta.url);
const source = async (file) => readFile(new URL(file, root), "utf8");

const store = await import("../src/server/musicProviderStore.ts");
const youtube = await import("../src/server/youtubeMusic.ts");
const youtubeProof = await import("../src/server/youtubePoToken.ts");
const youtubePlayer = await import("../src/server/youtubePlayerEvaluator.ts");
const tidal = await import("../src/server/tidalMusic.ts");
const apple = await import("../src/server/appleMusic.ts");
const gateway = await import("../src/server/musicGateway.ts");
const spotifyBridge = await import("../src/server/spotifyBridge.ts");
const playbackRoute = await import("../src/app/api/music-gateway/playback/route.ts");
const routeSupport = await import("../src/app/api/music-gateway/routeSupport.ts");

function environment(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

async function encryptedStore(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "revival-music-provider-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  environment(t, "REVIVAL_MUSIC_SESSION_DIR", directory);
  environment(t, "REVIVAL_MUSIC_SESSION_SECRET", "music-session-secret-".repeat(3));
  return directory;
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

test("wearer music sessions are encrypted at rest and written with owner-only permissions", async (t) => {
  await encryptedStore(t);
  const subject = "encrypted-wearer";
  const refreshToken = "youtube-refresh-token-that-must-not-appear-at-rest";
  await store.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    youtube_music: {
      connected_at: "2026-08-18T00:00:00.000Z",
      credentials: {
        access_token: "youtube-access-token",
        refresh_token: refreshToken,
        expiry_date: "2026-08-19T00:00:00.000Z",
      },
    },
  }));

  const file = store.musicSessionStoreFile(subject);
  const raw = await readFile(file, "utf8");
  assert.doesNotMatch(raw, /youtube|refresh-token|access-token|encrypted-wearer/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(
    (await store.readMusicAccountRecord(subject)).youtube_music.credentials.refresh_token,
    refreshToken,
  );
});

test("obsolete provider selection cannot invalidate saved music credentials", async (t) => {
  await encryptedStore(t);
  const subject = "provider-selection-wearer";
  const record = await store.updateMusicAccountRecord(subject, () => ({
    version: 1,
    active_provider: "youtube_music",
    youtube_music: {
      connected_at: "2026-08-20T00:00:00.000Z",
      credentials: {
        access_token: "youtube-access-token",
        refresh_token: "youtube-refresh-token",
        expiry_date: "2026-08-26T00:00:00.000Z",
      },
    },
  }));

  assert.equal("active_provider" in record, false);
  assert.deepEqual(await youtube.youtubeConnectionStatus(subject), { state: "connected" });
});

test("a durable YouTube connection wins over a failed in-memory retry", async (t) => {
  await encryptedStore(t);
  const subject = "youtube-retry-wearer";
  const originalCreate = Innertube.create;
  t.after(() => {
    Innertube.create = originalCreate;
  });

  Innertube.create = async () => {
    const session = new EventEmitter();
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
  await store.updateMusicAccountRecord(subject, (record) => ({
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

  assert.deepEqual(await youtube.youtubeConnectionStatus(subject), { state: "connected" });
});

test("YouTube Music keeps connected OAuth credentials out of public catalog searches", async (t) => {
  await encryptedStore(t);
  const subject = "youtube-catalog-wearer";
  await store.updateMusicAccountRecord(subject, (record) => ({
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

test("YouTube Music removes ad payloads and refuses ad or non-media hosts", () => {
  assert.deepEqual(
    youtube.pruneYoutubeAdFields({
      playerAds: ["top-level"],
      playabilityStatus: {
        adPlacements: ["nested"],
        keep: { adSlots: ["deep"], title: "track" },
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
        chooseFormat: (formatOptions) => {
          calls.push({ formatOptions });
          return {
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
          };
        },
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
    { formatOptions: { type: "audio", quality: "best", format: "any" } },
    { player },
  ]);
  assert.equal(url.hostname, "r1---sn.example.googlevideo.com");
  assert.equal(url.searchParams.get("pot"), "fixture-content-proof");
});

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
      chooseFormat: () => ({
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
      }),
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

test("YouTube Music player evaluation rejects script-breaking values and hides host APIs", () => {
  assert.throws(
    () =>
      youtubePlayer.evaluateYoutubePlayerScript(
        { output: "return { n: 'unused' };" },
        { n: 'unsafe"; process.exit(); //' },
      ),
    /player environment was invalid/,
  );
  assert.deepEqual(
    youtubePlayer.evaluateYoutubePlayerScript(
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

test("TIDAL connection uses official OAuth authorization code + PKCE state", async (t) => {
  await encryptedStore(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  environment(t, "TIDAL_SCOPES", undefined);
  environment(t, "REVIVAL_MUSIC_GATEWAY_ORIGIN", "https://center.example.test");
  const subject = "tidal-wearer";

  const authorization = new URL(await tidal.startTidalConnection(subject));
  assert.equal(authorization.origin, "https://login.tidal.com");
  assert.equal(authorization.pathname, "/authorize");
  assert.equal(authorization.searchParams.get("client_id"), "tidal-client-id");
  assert.equal(authorization.searchParams.get("response_type"), "code");
  assert.equal(
    authorization.searchParams.get("scope"),
    "user.read collection.read collection.write playback",
  );
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    authorization.searchParams.get("redirect_uri"),
    "https://center.example.test/api/settings/services/music/tidal/callback",
  );

  const pending = (await store.readMusicAccountRecord(subject)).tidal.pending;
  assert.ok(pending);
  assert.equal(authorization.searchParams.get("state"), pending.state);
  assert.equal(
    authorization.searchParams.get("code_challenge"),
    createHash("sha256").update(pending.verifier).digest("base64url"),
  );
  assert.doesNotMatch(authorization.toString(), new RegExp(pending.verifier));
});

test("TIDAL status does not expose expired credentials without a refresh token as connected", async (t) => {
  await encryptedStore(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  const subject = "tidal-expired-status";
  await store.updateMusicAccountRecord(subject, (record) => ({
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

  assert.deepEqual(await tidal.tidalConnectionStatus(subject), {
    configured: true,
    state: "not_connected",
  });
  assert.deepEqual((await gateway.musicProviderStatus(subject)).tidal, {
    configured: true,
    state: "not_connected",
  });

  await store.updateMusicAccountRecord(subject, (record) => ({
    ...record,
    tidal: {
      ...record.tidal,
      credentials: {
        ...record.tidal.credentials,
        refresh_token: "refresh-token",
      },
    },
  }));
  assert.deepEqual(await tidal.tidalConnectionStatus(subject), {
    configured: true,
    state: "connected",
  });
});

test("TIDAL invalid_grant disconnects the persisted account and requires reconnection", async (t) => {
  await encryptedStore(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  const subject = "tidal-rejected-refresh";
  await store.updateMusicAccountRecord(subject, (record) => ({
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

  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, "https://auth.tidal.com");
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  };

  const error = await tidal.tidalStreamUrl(subject, "tidal:rejected").catch((reason) => reason);
  assert.ok(error instanceof tidal.TidalMusicError);
  assert.equal(error.status, 401);
  assert.equal(error.message, "Reconnect TIDAL in Center.");
  assert.deepEqual(await tidal.tidalConnectionStatus(subject), {
    configured: true,
    state: "not_connected",
  });
  assert.equal((await store.readMusicAccountRecord(subject)).tidal, undefined);
});

test("TIDAL collection prompts resolve official relationships and preserve item order", async (t) => {
  await encryptedStore(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  environment(t, "TIDAL_COUNTRY_CODE", undefined);
  const subject = "tidal-catalog-wearer";
  await store.updateMusicAccountRecord(subject, (record) => ({
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
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
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
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/v2/users/wearer-123") {
      return Response.json({ data: { type: "users", id: "wearer-123", attributes: { country: "dk" } } });
    }
    const search = /^\/v2\/searchresults\/[^/]+\/relationships\/(albums|artists|playlists)$/u.exec(url.pathname);
    if (search) {
      const type = search[1];
      assert.equal(url.searchParams.get("countryCode"), "DK");
      assert.equal(url.searchParams.get("include"), type);
      return Response.json({ data: [{ type, id: relationshipIds[type] }] });
    }
    const collection = /^\/v2\/(albums|artists|playlists)\/[^/]+\/relationships\/(items|tracks)$/u.exec(url.pathname);
    if (collection) {
      const type = collection[1];
      assert.equal(url.searchParams.get("countryCode"), "DK");
      assert.equal(url.searchParams.get("include"), collection[2]);
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
  };

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
  assert.equal((await store.readMusicAccountRecord(subject)).tidal.credentials.country_code, "DK");
  assert.equal(calls.filter((call) => call === "/v2/users/wearer-123").length, 1);
  assert.ok(calls.some((call) => call.startsWith("/v2/searchresults/Kind%20of%20Blue%20Miles%20Davis/relationships/albums?")));
  assert.ok(calls.some((call) => call.startsWith("/v2/albums/album-1/relationships/items?")));
  assert.ok(calls.some((call) => call.startsWith("/v2/artists/artist-1/relationships/tracks?")));
  assert.ok(calls.some((call) => call.startsWith("/v2/playlists/playlist-1/relationships/items?")));
});

test("TIDAL disconnect wins a race with token refresh and cannot recreate credentials", async (t) => {
  await encryptedStore(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  environment(t, "TIDAL_COUNTRY_CODE", "DK");
  const subject = "tidal-refresh-race";
  await store.updateMusicAccountRecord(subject, (record) => ({
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
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  globalThis.fetch = async (input) => {
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
  };

  const query = tidal.queryTidal(subject, { kind: "track", primary: "Blue", limit: 1 });
  await refreshStarted.promise;
  await tidal.disconnectTidal(subject);
  releaseRefresh();
  await assert.rejects(
    query,
    (error) => error instanceof tidal.TidalMusicError && error.status === 401,
  );
  assert.equal((await store.readMusicAccountRecord(subject)).tidal, undefined);
});

test("concurrent TIDAL playbacks share one expired-token refresh per wearer", async (t) => {
  await encryptedStore(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  const subject = "tidal-refresh-single-flight";
  await store.updateMusicAccountRecord(subject, (record) => ({
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
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  globalThis.fetch = async (input, init) => {
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
  };

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
  await encryptedStore(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  const subject = "tidal-abandoned-refresh-flight";
  await store.updateMusicAccountRecord(subject, (record) => ({
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
  const previousFetch = globalThis.fetch;
  t.after(() => {
    releaseFirstRefresh.resolve();
    globalThis.fetch = previousFetch;
  });
  globalThis.fetch = async (input, init) => {
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
  };

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
  await encryptedStore(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  const subject = "tidal-abandoned-queued-refresh";
  await store.updateMusicAccountRecord(subject, (record) => ({
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

  const lockHeld = Promise.withResolvers();
  const releaseLock = Promise.withResolvers();
  const blocker = store.updateMusicAccountRecord(subject, async (record) => {
    lockHeld.resolve();
    await releaseLock.promise;
    return record;
  });
  await lockHeld.promise;

  const firstRefreshBodyStarted = Promise.withResolvers();
  const releaseFirstRefreshBody = Promise.withResolvers();
  let firstRefreshBodyCancelled = false;
  let refreshCalls = 0;
  const previousFetch = globalThis.fetch;
  t.after(async () => {
    releaseLock.resolve();
    releaseFirstRefreshBody.resolve();
    await blocker;
    globalThis.fetch = previousFetch;
  });
  globalThis.fetch = async (input, init) => {
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
  };

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
  releaseLock.resolve();
  await blocker;

  assert.equal(await replacement, "https://audio.tdlcdn.com/replacement.m4a");
  assert.equal(refreshCalls, 1);
  assert.equal(firstRefreshBodyCancelled, false);
  assert.equal(
    (await store.readMusicAccountRecord(subject)).tidal.credentials.access_token,
    "rotated-access-token",
  );
});

test("a stale TIDAL credential read reuses the rotation that already settled", async (t) => {
  await encryptedStore(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  const subject = "tidal-stale-read-after-refresh";
  await store.updateMusicAccountRecord(subject, (record) => ({
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
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
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
  };

  const sessionFile = store.musicSessionStoreFile(subject);
  const previousReadFile = fs.promises.readFile;
  const staleReadStarted = Promise.withResolvers();
  const releaseStaleRead = Promise.withResolvers();
  let pauseNextSubjectRead = false;
  fs.promises.readFile = async (...arguments_) => {
    const bytes = await previousReadFile(...arguments_);
    if (pauseNextSubjectRead && String(arguments_[0]) === sessionFile) {
      pauseNextSubjectRead = false;
      staleReadStarted.resolve();
      await releaseStaleRead.promise;
    }
    return bytes;
  };
  syncBuiltinESMExports();
  t.after(() => {
    releaseFirstRefresh.resolve();
    releaseStaleRead.resolve();
    fs.promises.readFile = previousReadFile;
    syncBuiltinESMExports();
    globalThis.fetch = previousFetch;
  });

  const first = tidal.tidalStreamUrl(subject, "tidal:first");
  await firstRefreshStarted.promise;
  pauseNextSubjectRead = true;
  const second = tidal.tidalStreamUrl(subject, "tidal:second");
  await staleReadStarted.promise;

  releaseFirstRefresh.resolve();
  assert.equal(await first, "https://audio.tdlcdn.com/first.m4a");
  await new Promise((resolve) => setImmediate(resolve));
  releaseStaleRead.resolve();

  assert.equal(await second, "https://audio.tdlcdn.com/second.m4a");
  assert.equal(refreshCalls, 1);
  assert.equal(
    (await store.readMusicAccountRecord(subject)).tidal.credentials.access_token,
    "rotated-access-token",
  );
});

test("TIDAL playback accepts only official full-track HTTPS files", async (t) => {
  await encryptedStore(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  environment(t, "REVIVAL_MUSIC_GATEWAY_ORIGIN", "https://center.example.test");
  const subject = "tidal-playback-wearer";
  await store.updateMusicAccountRecord(subject, (record) => ({
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

  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  globalThis.fetch = async (input) => {
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
  };

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
  await encryptedStore(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  const subject = "tidal-shared-playback-budget";
  await store.updateMusicAccountRecord(subject, (record) => ({
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
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  globalThis.fetch = async (input, init) => {
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
  };

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
  assert.deepEqual(requestCaps, [15_000, 15_000]);
});

test("TIDAL playback deadlines preserve an accepted token rotation", async (t) => {
  await encryptedStore(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
  const subject = "tidal-refresh-playback-deadline";
  await store.updateMusicAccountRecord(subject, (record) => ({
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
  const previousFetch = globalThis.fetch;
  t.after(() => {
    releaseRefreshBody.resolve();
    globalThis.fetch = previousFetch;
  });
  globalThis.fetch = async (input, init) => {
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
  };

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

test("Apple MusicKit user-token handoff stays encrypted and remains playback-gated", async (t) => {
  await encryptedStore(t);
  environment(t, "APPLE_MUSIC_DEVELOPER_TOKEN", "header.payload.signature");
  const subject = "apple-wearer";

  await apple.connectAppleMusic(subject, "apple-music-user-token", "DK");
  assert.deepEqual(await apple.appleConnectionStatus(subject), {
    configured: true,
    state: "connected_playback_runtime_required",
  });
  const account = (await store.readMusicAccountRecord(subject)).apple_music;
  assert.equal(account.music_user_token, "apple-music-user-token");
  assert.equal(account.storefront, "dk");

  await apple.disconnectAppleMusic(subject);
  assert.deepEqual(await apple.appleConnectionStatus(subject), {
    configured: true,
    state: "not_connected",
  });
});

test("the Pin gateway bearer is derived, constant-time checked, and errors retain provider status", async (t) => {
  environment(t, "REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE", undefined);
  environment(t, "REVIVAL_SPOTIFY_ADAPTER_TOKEN", "adapter-root-token-".repeat(3));
  environment(t, "REVIVAL_PIN_BRIDGE_DEVICE_ID", "2c2a00010000abcd");
  environment(t, "REVIVAL_PIN_BRIDGE_OWNER_SUB", "owner-subject");
  environment(t, "REVIVAL_MUSIC_GATEWAY_ORIGIN", "https://center.example.test");
  const bearer = await spotifyBridge.deviceMusicGatewayToken();

  assert.notEqual(bearer, process.env.REVIVAL_SPOTIFY_ADAPTER_TOKEN);
  assert.equal(
    await gateway.authenticateMusicGateway(new Request("https://center.example.test/api/music-gateway/query", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
    })),
    "owner-subject",
  );
  await assert.rejects(
    () => gateway.authenticateMusicGateway(new Request("https://center.example.test/api/music-gateway/query", {
      method: "POST",
      headers: { authorization: `Bearer ${"x".repeat(43)}` },
    })),
    (error) => error instanceof gateway.MusicGatewayError && error.status === 401,
  );

  assert.equal(gateway.musicGatewayError(new tidal.TidalMusicError("busy", 429)).status, 429);
  assert.equal(gateway.musicGatewayError(new apple.AppleMusicError("bad token", 400)).status, 400);
});

test("device music authentication honors the playback deadline", async (t) => {
  environment(t, "REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE", undefined);
  environment(t, "REVIVAL_SPOTIFY_ADAPTER_TOKEN", "adapter-root-token-".repeat(3));
  environment(t, "REVIVAL_PIN_BRIDGE_DEVICE_ID", "2c2a00010000abcd");
  environment(t, "REVIVAL_PIN_BRIDGE_OWNER_SUB", "owner-subject");
  const bearer = await spotifyBridge.deviceMusicGatewayToken();
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
    () => routeSupport.deviceMusicRequest(request, deadline),
    (error) => error === timeoutError,
  );
});

test("the playback deadline includes authentication and request-body parsing", async (t) => {
  environment(t, "REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE", undefined);
  environment(t, "REVIVAL_SPOTIFY_ADAPTER_TOKEN", "adapter-root-token-".repeat(3));
  environment(t, "REVIVAL_PIN_BRIDGE_DEVICE_ID", "2c2a00010000abcd");
  environment(t, "REVIVAL_PIN_BRIDGE_OWNER_SUB", "owner-subject");
  const bearer = await spotifyBridge.deviceMusicGatewayToken();

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
  assert.match(musicView, /Apple Music connects through MusicKit/);
  assert.match(musicView, /Full playback still requires Apple.*Android runtime/);
  assert.match(appleRoute, /maxBytes: 24 \* 1024/);
  assert.match(nextConfig, /connect-src[^\n]+https:\/\/api\.music\.apple\.com/);
  assert.match(nextConfig, /frame-src[^\n]+https:\/\/authorize\.music\.apple\.com/);
  assert.doesNotMatch(musicView, /Metrolist|NewPipe APK|install (?:an|the) app on the Pin/i);
});
