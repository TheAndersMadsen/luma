import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("runtime has no recovered dashboard dataset or data-bearing fixtures", async () => {
  await assert.rejects(access(new URL("data/recovered.json", root)));
  await assert.rejects(access(new URL("src/lib/fixtures.ts", root)));

  const dataSource = await source("src/server/source.ts");

  assert.doesNotMatch(dataSource, /from\s+["']@\/lib\/fixtures["']/);
  assert.match(dataSource, /unconfigured\(\[\], "empty", WEBAPI_UNSET\)/);
  // The capture list degrades to an EMPTY list, never to recovered sample data.
  // `failed(…, describeWebapi(error), "empty")` is now spelled `failedWebapi([],
  // error)` — the same stand-in, through the helper that also tells an expired
  // wearer session apart from a backend outage. The stand-in is what this
  // asserts, so both the value and the fallback are pinned.
  assert.match(dataSource, /failedWebapi\(\[\], error\)/);
  assert.match(
    dataSource,
    /function failedWebapi[\s\S]{0,200}?failed\(data, describeWebapi\(error\), "empty"\)/,
  );
  assert.doesNotMatch(
    dataSource,
    /(?:unconfigured|failed|failedGrpc|failedWebapi)\(captureRecords/,
  );
});

test("test-only fixture is explicit, synthetic and outside runtime imports", async () => {
  const fixtureUrl = new URL("verify/fixtures/synthetic-center.json", root);
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const runtimeSources = await Promise.all([source("src/server/source.ts")]);

  assert.equal(fixture.synthetic, true);
  assert.match(fixture.note.data.note.text, /Not wearer data/);
  assert.ok(runtimeSources.every((contents) => !contents.includes("synthetic-center")));
});

test("Memories and Captures never describe an empty fallback as sample data", async () => {
  const [memoriesPage, capturesPage, healthRoute, status] = await Promise.all([
    source("src/app/page.tsx"),
    source("src/app/captures/page.tsx"),
    source("src/app/api/health/route.ts"),
    source("src/components/Status.tsx"),
  ]);

  for (const runtimeSurface of [memoriesPage, capturesPage, healthRoute, status]) {
    assert.doesNotMatch(runtimeSurface, /Showing recovered|Recovered sample data|Showing the most recent saved data/);
  }
  assert.match(memoriesPage, /couldn’t be loaded from your Pin/);
  assert.match(capturesPage, /Captures couldn&rsquo;t be loaded/);
  assert.match(healthRoute, /fallback: state === "live" \? undefined : "empty"/);
  assert.match(healthRoute, /state: "degraded",\s+fallback: "empty"/);
  assert.match(status, /Your Pin couldn't be reached just now/);
  assert.doesNotMatch(status, /data\.fallback === "fixtures"/);
});
