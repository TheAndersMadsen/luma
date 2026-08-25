import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Innertube } from "youtubei.js";

// Node 22.14 supports the out-of-thread register() hook used by every other
// Center source test, but not the newer synchronous registerHooks() API.
import "./tsResolve.mjs";

const root = new URL("../", import.meta.url);
const source = async (file) => readFile(new URL(file, root), "utf8");

const store = await import("../src/server/musicProviderStore.ts");
const youtube = await import("../src/server/youtubeMusic.ts");
const tidal = await import("../src/server/tidalMusic.ts");
const apple = await import("../src/server/appleMusic.ts");
const gateway = await import("../src/server/musicGateway.ts");
const spotifyBridge = await import("../src/server/spotifyBridge.ts");

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

test("TIDAL playback accepts only official full-track HTTPS files", async (t) => {
  await encryptedStore(t);
  environment(t, "TIDAL_CLIENT_ID", "tidal-client-id");
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

test("opaque stream tickets accept one byte range and only audio-like MIME types", () => {
  for (const range of [null, "bytes=0-", "bytes=0-4095", "bytes=-4096"]) {
    assert.equal(gateway.isAllowedMusicRange(range), true);
  }
  for (const range of ["bytes=-", "bytes=0-1,4-5", "items=0-1", "bytes=abc-def"]) {
    assert.equal(gateway.isAllowedMusicRange(range), false);
  }
  for (const contentType of ["audio/mp4", "audio/webm; codecs=opus", "video/mp4", "application/octet-stream"]) {
    assert.equal(gateway.isAllowedMusicStreamContentType(contentType), true);
  }
  for (const contentType of [null, "text/html", "application/json", "video/webm"]) {
    assert.equal(gateway.isAllowedMusicStreamContentType(contentType), false);
  }
});

test("Center exposes only exact authenticated gateway operations and exact opaque stream reads", async () => {
  const [middleware, requestSupport, musicView, appleRoute, nextConfig] = await Promise.all([
    source("src/middleware.ts"),
    source("src/app/api/music-gateway/routeSupport.ts"),
    source("src/app/settings/account/services/SpotifyServiceCard.tsx"),
    source("src/app/api/settings/services/music/apple/route.ts"),
    source("next.config.mjs"),
  ]);
  assert.match(middleware, /\/api\/music-gateway\/query/);
  assert.match(middleware, /\/api\/music-gateway\/playback/);
  assert.match(middleware, /\/api\/music-gateway\/save/);
  assert.match(middleware, /\[A-Za-z0-9_-\]\{43\}/);
  assert.match(requestSupport, /request\.body.*getReader/);
  assert.match(requestSupport, /QUERY_KINDS/);
  assert.match(requestSupport, /exactKeys/);
  assert.match(musicView, /musickit\/v3\/musickit\.js/);
  assert.match(musicView, /instance\.authorize\(\)/);
  assert.match(musicView, /music_user_token: musicUserToken/);
  assert.match(musicView, /No Apple Music app is installed on the Pin/);
  assert.match(musicView, /official Android playback and DRM runtime/);
  assert.match(appleRoute, /maxBytes: 24 \* 1024/);
  assert.match(nextConfig, /connect-src[^\n]+https:\/\/api\.music\.apple\.com/);
  assert.match(nextConfig, /frame-src[^\n]+https:\/\/authorize\.music\.apple\.com/);
  assert.doesNotMatch(musicView, /Metrolist|NewPipe APK|install (?:an|the) app on the Pin/i);
});
