import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the dashboard and My Data read music from Cosmos alone, never from the Pin", async () => {
  const [dashboard, detail, queries] = await Promise.all(
    ["../src/app/page.tsx", "../src/app/my-data/DomainView.tsx", "../src/lib/queries.ts"].map(
      (path) => readFile(new URL(path, import.meta.url), "utf8"),
    ),
  );
  for (const source of [dashboard, detail, queries]) {
    assert.doesNotMatch(source, /useRemoteMusicActivity|api\/pin\/remote|activity\/music/u);
  }
  assert.doesNotMatch(dashboard, /· TIDAL/u);
  assert.match(dashboard, /MusicProviderIcon provider=\{provider\}/u);
  assert.match(dashboard, /musicProviderLabel\(provider\)/u);
  assert.match(detail, /musicPresentation\(/u);
  assert.match(detail, /<MusicArtwork/u);
  assert.match(detail, /MusicProviderIcon provider=\{provider\}/u);
  assert.match(detail, /musicProviderLabel\(provider\)/u);
});
