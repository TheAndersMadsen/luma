import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = new URL("../../../", import.meta.url);

function markdownHeadingAnchor(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/gu, "-");
}

test("every setup documentation anchor resolves in the README", async () => {
  const [contractSource, readme] = await Promise.all([
    readFile(new URL("../../../contracts/operator-setup.json", import.meta.url), "utf8"),
    readFile(new URL("../../../README.md", import.meta.url), "utf8"),
  ]);
  const contract = JSON.parse(contractSource);
  const availableAnchors = new Set(
    [...readme.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((match) =>
      markdownHeadingAnchor(match[1]),
    ),
  );
  const documentedEntries = [
    ...contract.commands,
    ...contract.journeys.flatMap((journey) => journey.steps),
  ].filter((entry) => entry.documentationAnchor !== null);

  for (const entry of documentedEntries) {
    const match = /^README\.md#(.+)$/u.exec(entry.documentationAnchor);
    assert.ok(match, `${entry.id}: unsupported documentation anchor ${entry.documentationAnchor}`);
    assert.ok(
      availableAnchors.has(match[1]),
      `${entry.id}: ${entry.documentationAnchor} does not resolve to a README heading`,
    );
  }
});

test("Center's committed setup projection matches the root contract", async () => {
  const result = spawnSync(process.execPath, ["platform/setup/generate.mjs", "--check"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const [model, generated] = await Promise.all([
    readFile(
      new URL("../../../center/src/lib/pin-setup/steps.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../../../center/src/lib/pin-setup/generated/journey.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  assert.match(model, /from "\.\/generated\/journey"/);
  assert.doesNotMatch(
    model,
    /(?:from|import\()\s*["'][^"']*contracts\/operator-setup\.json/,
  );
  assert.match(generated, /\.\/revival pin release import/);
  assert.doesNotMatch(generated, /pin release (?:build|ship)/);
  assert.match(generated, /"centerRoute": "\/wifi"/);
});
