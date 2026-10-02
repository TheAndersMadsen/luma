import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const { internalMusicQuery } = await import(
  "../src/app/api/internal/music/query/routeSupport.ts"
);
const { SpotifyBridgeError } = await import("../src/server/spotifyBridge.ts");

/*
 * Cosmos names the provider: it reads the wearer's own choice from its account
 * store (`backends/music_discovery.rs`). Nothing here asks the Pin which
 * provider is active. Only a Spotify lookup runs on the Pin, whose Spotify
 * session is the catalog.
 */

function environment(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

function request(token, body) {
  return new Request("http://center.test/api/internal/music/query", {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const owner = "wearer-01";
const token = "cosmos-admin-token-that-is-long-enough";
const baseBody = {
  principal: `V:01:D:pin-01:U:${owner}`,
  provider: "spotify",
  query: "Hotline Bling Drake",
};

test("Cosmos music lookup rejects missing and incorrect internal credentials", async (t) => {
  environment(t, "COSMOS_ADMIN_TOKEN", token);
  const dependencies = {
    spotifySearch: async () => assert.fail("authorization must precede provider access"),
    gatewayQuery: async () => assert.fail("authorization must precede provider access"),
  };

  for (const presented of [undefined, "wrong-token-that-is-long-enough-000"]) {
    const response = await internalMusicQuery(request(presented, baseBody), dependencies);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorized." });
  }
});

test("a Spotify lookup passes the principal through the Pin's ownership gate", async (t) => {
  environment(t, "COSMOS_ADMIN_TOKEN", token);
  const response = await internalMusicQuery(
    request(token, { ...baseBody, principal: "V:01:D:pin-01:U:someone-else" }),
    {
      spotifySearch: async (session) => {
        assert.equal(session.sub, "someone-else");
        throw new SpotifyBridgeError("wrong_owner", 403, "This music bridge is not assigned to that wearer.");
      },
      gatewayQuery: async () => assert.fail("Spotify is the named provider"),
    },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "This music bridge is not assigned to that wearer." });
});

test("Spotify setup the owner must finish reaches Cosmos as its own status", async (t) => {
  environment(t, "COSMOS_ADMIN_TOKEN", token);
  // Cosmos speaks "link your provider" for 401 and "turn it on" for 412.
  for (const [status, error] of [
    [401, "Pair Spotify with your Pin in Center."],
    [412, "Spotify is turned off on your Pin. Turn it on in Center."],
  ]) {
    const response = await internalMusicQuery(request(token, baseBody), {
      spotifySearch: async () => {
        throw new SpotifyBridgeError("pin_rejected", status, error);
      },
      gatewayQuery: async () => assert.fail("Spotify is the named provider"),
    });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
  }
});

test("Cosmos must name a provider this lookup can search", async (t) => {
  environment(t, "COSMOS_ADMIN_TOKEN", token);
  const untouched = {
    spotifySearch: async () => assert.fail("no catalog may be searched"),
    gatewayQuery: async () => assert.fail("no catalog may be searched"),
  };
  for (const [provider, status, error] of [
    [undefined, 400, "Unsupported music provider."],
    ["deezer", 400, "Unsupported music provider."],
    ["apple_music", 409, "Apple Music playback is not available on this Pin."],
  ]) {
    const response = await internalMusicQuery(request(token, { ...baseBody, provider }), untouched);
    assert.equal(response.status, status, String(provider));
    assert.deepEqual(await response.json(), { error });
  }
  const unknown = await internalMusicQuery(
    request(token, { ...baseBody, active_provider: "spotify" }),
    untouched,
  );
  assert.equal(unknown.status, 400);
});

test("Cosmos music lookup selects Spotify and projects only bounded track fields", async (t) => {
  environment(t, "COSMOS_ADMIN_TOKEN", token);
  let searched = "";
  const response = await internalMusicQuery(request(token, baseBody), {
    spotifySearch: async (session, query) => {
      assert.equal(session.sub, owner);
      searched = query;
      return {
        items: [{
          id: "spotify:track:1",
          title: "Hotline Bling",
          artists: ["Drake"],
          album: "Views",
          duration_ms: 267_000,
          explicit: false,
          secret: "drop-me",
        }],
      };
    },
    gatewayQuery: async () => assert.fail("the inactive provider must not be queried"),
  });

  assert.equal(response.status, 200);
  assert.equal(searched, baseBody.query);
  assert.deepEqual(await response.json(), {
    provider: "spotify",
    ranking_provenance: "not_ranked",
    items: [{
      id: "spotify:track:1",
      title: "Hotline Bling",
      artists: ["Drake"],
      album: "Views",
      duration_ms: 267_000,
      explicit: false,
    }],
  });
});

test("Cosmos music lookup searches the provider Cosmos named and preserves not-ranked provenance", async (t) => {
  environment(t, "COSMOS_ADMIN_TOKEN", token);
  const response = await internalMusicQuery(request(token, { ...baseBody, provider: "youtube_music" }), {
    spotifySearch: async () => assert.fail("Spotify is inactive"),
    gatewayQuery: async (subject, body) => {
      assert.equal(subject, owner);
      assert.deepEqual(body, {
        provider: "youtube_music",
        kind: "track",
        primary: baseBody.query,
        limit: 10,
      });
      return {
        ranking_provenance: "not_ranked",
        items: [{
          id: "youtube_music:dQw4w9WgXcQ",
          title: "Hotline Bling",
          artists: ["Drake"],
          album: "Views",
          duration_ms: 267_000,
          track_number: 1,
          disc_number: 1,
          explicit: false,
        }],
      };
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    provider: "youtube_music",
    ranking_provenance: "not_ranked",
    items: [{
      id: "youtube_music:dQw4w9WgXcQ",
      title: "Hotline Bling",
      artists: ["Drake"],
      album: "Views",
      duration_ms: 267_000,
      explicit: false,
    }],
  });
});

test("the lookup never asks the Pin which provider is active", async () => {
  const routeSupport = await readFile(
    new URL("../src/app/api/internal/music/query/routeSupport.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(routeSupport, /runSpotifyBridgeAction|active_provider/);
});

test("a provider lookup that outlives its budget answers 504 and is told to stop", async (t) => {
  environment(t, "COSMOS_ADMIN_TOKEN", token);
  // AbortSignal.timeout()'s timer is unrefed, so this ref'd keep-alive holds
  // the test runner's empty event loop open until the 50 ms budget can fire.
  // Production is unaffected: the server's own listeners hold the loop.
  const keepAlive = setTimeout(() => {}, 10_000);
  t.after(() => clearTimeout(keepAlive));
  let lookupSignal;
  const startedAt = performance.now();
  const response = await internalMusicQuery(
    request(token, { ...baseBody, provider: "tidal" }),
    {
      spotifySearch: async () => assert.fail("TIDAL is the named provider"),
      gatewayQuery: (_subject, _body, signal) => {
        lookupSignal = signal;
        return new Promise(() => {});
      },
    },
    50,
  );
  // A lookup that never settles by itself must still be answered.
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "TIDAL took too long." });
  assert.equal(lookupSignal?.aborted, true);
  assert.ok(performance.now() - startedAt < 2_000);
});
