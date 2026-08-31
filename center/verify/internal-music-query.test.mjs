import assert from "node:assert/strict";
import test from "node:test";

import "./tsResolve.mjs";

const { internalMusicQuery } = await import(
  "../src/app/api/internal/music/query/routeSupport.ts"
);
const { SpotifyBridgeError } = await import("../src/server/spotifyBridge.ts");

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
  query: "Hotline Bling Drake",
};

test("Cosmos music lookup rejects missing and incorrect internal credentials", async (t) => {
  environment(t, "COSMOS_ADMIN_TOKEN", token);
  const dependencies = {
    status: async () => assert.fail("authorization must precede provider access"),
    spotifySearch: async () => assert.fail("authorization must precede provider access"),
    gatewayQuery: async () => assert.fail("authorization must precede provider access"),
  };

  for (const presented of [undefined, "wrong-token-that-is-long-enough-000"]) {
    const response = await internalMusicQuery(request(presented, baseBody), dependencies);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorized." });
  }
});

test("Cosmos music lookup passes the principal through the dynamic bridge ownership gate", async (t) => {
  environment(t, "COSMOS_ADMIN_TOKEN", token);
  const response = await internalMusicQuery(
    request(token, { ...baseBody, principal: "V:01:D:pin-01:U:someone-else" }),
    {
      status: async (session) => {
        assert.equal(session.sub, "someone-else");
        throw new SpotifyBridgeError("wrong_owner", 403, "This music bridge is not assigned to that wearer.");
      },
      spotifySearch: async () => assert.fail("wearer validation must precede provider access"),
      gatewayQuery: async () => assert.fail("wearer validation must precede provider access"),
    },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "This music bridge is not assigned to that wearer." });
});

test("Cosmos music lookup selects Spotify and projects only bounded track fields", async (t) => {
  environment(t, "COSMOS_ADMIN_TOKEN", token);
  let searched = "";
  const response = await internalMusicQuery(request(token, baseBody), {
    status: async (session) => {
      assert.equal(session.sub, owner);
      return { active_provider: "spotify" };
    },
    spotifySearch: async (_session, query) => {
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

test("Cosmos music lookup uses the active account provider and preserves not-ranked provenance", async (t) => {
  environment(t, "COSMOS_ADMIN_TOKEN", token);
  const response = await internalMusicQuery(request(token, baseBody), {
    status: async () => ({ active_provider: "youtube_music" }),
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
