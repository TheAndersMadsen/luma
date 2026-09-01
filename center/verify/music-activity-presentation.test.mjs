import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  musicActivityPresentations,
  musicArtworkPath,
  musicProviderLabel,
} from "../src/lib/musicActivityPresentation.ts";
import { resolveMusicArtwork } from "../src/server/musicArtwork.ts";

const event = (uuid, created, title = "Billie Jean") => ({
  uuid,
  userCreatedAt: created,
  data: {
    eventData: {
      trackTitle: title,
      artistName: "Michael Jackson",
      albumName: "Thriller",
      albumArtUuid: "",
      albumArtHexcode: "",
    },
  },
});

const activity = (id, trackId, started) => ({
  id,
  track_id: trackId,
  title: "Billie Jean",
  artists: ["Michael Jackson"],
  album: "Thriller",
  status: "completed",
  started_at: started,
});

test("music cards correlate duplicate stock events to their exact provider activity", () => {
  const cards = musicActivityPresentations(
    [
      event("new", "2026-09-01T20:57:00.000Z"),
      event("old", "2026-09-01T20:55:00.000Z"),
    ],
    [
      activity(12, "youtube_music:Zi_XLOBDo_Y", "1788296220"),
      activity(11, "tidal:77676495", "1788296100"),
    ],
  );

  assert.deepEqual(cards.map((card) => card.provider), ["youtube_music", "tidal"]);
  assert.equal(cards[0].activity?.id, 12);
  assert.equal(cards[1].activity?.id, 11);
});

test("provider artwork paths are same-origin and labels never hardcode TIDAL", () => {
  assert.equal(
    musicArtworkPath("youtube_music", "youtube_music:Zi_XLOBDo_Y"),
    "/api/settings/services/music/artwork/youtube_music/Zi_XLOBDo_Y",
  );
  assert.equal(
    musicArtworkPath("spotify", "5ChkMS8OtdzJeqyybCc9R5"),
    "/api/settings/services/music/artwork/spotify/5ChkMS8OtdzJeqyybCc9R5",
  );
  assert.equal(musicProviderLabel("youtube_music"), "YouTube Music");
  assert.equal(musicProviderLabel("tidal"), "TIDAL");
});

test("the dashboard renders the correlated provider instead of a fixed TIDAL label", async () => {
  const dashboard = await readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(dashboard, /· TIDAL/u);
  assert.match(dashboard, /MusicProviderIcon provider=\{provider\}/u);
  assert.match(dashboard, /musicProviderLabel\(provider\)/u);
});

test("the music detail page renders correlated provider artwork and identity", async () => {
  const detail = await readFile(
    new URL("../src/app/my-data/DomainView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(detail, /musicActivityPresentations/u);
  assert.match(detail, /useRemoteMusicActivity\(100, domain === "MUSIC"\)/u);
  assert.match(detail, /<MusicArtwork/u);
  assert.match(detail, /MusicProviderIcon provider=\{provider\}/u);
  assert.match(detail, /musicProviderLabel\(provider\)/u);
  assert.doesNotMatch(detail, /album-art thumbnail \/ albumArtHexcode tint was an invention/u);
});

test("an unmatched legacy TIDAL event keeps its recovered cover and identity", () => {
  const legacy = event("legacy", "2026-09-01T20:50:00.000Z");
  legacy.data.eventData.albumArtUuid = "e8d1b6d7-abc1-4f8c-9df4-1ec984894abc";
  const [card] = musicActivityPresentations([legacy], []);

  assert.equal(card.provider, "tidal");
  assert.match(card.artwork ?? "", /^https:\/\/resources\.tidal\.com\/images\//u);
});

test("artwork resolution accepts only the selected provider's bounded image host", async () => {
  let calls = 0;
  assert.equal(
    await resolveMusicArtwork("youtube_music", "Zi_XLOBDo_Y", async () => {
      calls += 1;
      throw new Error("YouTube ids do not need a metadata request");
    }),
    "https://i.ytimg.com/vi/Zi_XLOBDo_Y/hqdefault.jpg",
  );
  assert.equal(calls, 0);

  const spotify = await resolveMusicArtwork(
    "spotify",
    "5ChkMS8OtdzJeqyybCc9R5",
    async () => Response.json({
      thumbnail_url:
        "https://image-cdn-fa.spotifycdn.com/image/ab67616d00001e024121faee8df82c526cbab2be",
    }),
  );
  assert.match(spotify, /^https:\/\/image-cdn-fa\.spotifycdn\.com\/image\//u);

  await assert.rejects(
    () => resolveMusicArtwork(
      "spotify",
      "5ChkMS8OtdzJeqyybCc9R5",
      async () => Response.json({ thumbnail_url: "https://attacker.invalid/cover.jpg" }),
    ),
    /artwork response/u,
  );
});
