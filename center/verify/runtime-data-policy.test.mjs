import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("runtime has no recovered dashboard dataset or data-bearing fixtures", async () => {
  await assert.rejects(access(new URL("data/recovered.json", root)));
  await assert.rejects(access(new URL("src/lib/fixtures.ts", root)));

  // Enumerate feature owners so newly added domains are covered automatically.
  const { readdir } = await import("node:fs/promises");
  const domainNames = (await readdir(new URL("src/server/domain/", root))).filter((name) =>
    name.endsWith(".ts"),
  );
  const domainSources = await Promise.all(
    domainNames.map((name) => source(`src/server/domain/${name}`)),
  );
  const dataSource = domainSources.join("\n");
  const captures = await source("src/server/domain/captures.ts");
  const provenance = await source("src/server/domain/provenance.ts");

  assert.doesNotMatch(dataSource, /from\s+["']@\/lib\/fixtures["']/);
  assert.match(captures, /unconfigured\(\[\], "empty", WEBAPI_UNSET\)/);
  // The capture list degrades to an EMPTY list, never to recovered sample data.
  // `failed(…, describeWebapi(error), "empty")` is now spelled `failedWebapi([],
  // error)`, the same stand-in, through the helper that also tells an expired
  // wearer session apart from a backend outage. The stand-in is what this
  // asserts, so both the value and the fallback are pinned.
  assert.match(captures, /failedWebapi\(\[\], error\)/);
  assert.match(
    provenance,
    /function failedWebapi[\s\S]{0,400}?failed\(data, describeWebapi\(error\), "empty"\)/,
  );
  assert.doesNotMatch(
    dataSource,
    /(?:unconfigured|failed|failedGrpc|failedWebapi)\(captureRecords/,
  );
});

test("test-only fixture is explicit, synthetic and outside runtime imports", async () => {
  const fixtureUrl = new URL("verify/fixtures/synthetic-center.json", root);
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const { readdir } = await import("node:fs/promises");
  const domainNames = (await readdir(new URL("src/server/domain/", root))).filter((name) =>
    name.endsWith(".ts"),
  );
  const runtimeSources = await Promise.all(
    domainNames.map((name) => source(`src/server/domain/${name}`)),
  );

  assert.equal(fixture.synthetic, true);
  assert.match(fixture.note.data.note.text, /Not wearer data/);
  assert.ok(runtimeSources.every((contents) => !contents.includes("synthetic-center")));
});
