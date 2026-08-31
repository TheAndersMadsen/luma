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
  assert.match(generated, /\.\/revival pin release acquire/);
  assert.doesNotMatch(generated, /\.\/revival pin release import/);
  assert.doesNotMatch(generated, /pin release (?:build|ship)/);
  assert.match(generated, /"centerRoute": "\/wifi"/);
});

test("the setup status envelope and every state are canonical contract data", async () => {
  const contract = JSON.parse(await readFile(
    new URL("../../../contracts/operator-setup.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual(contract.status.envelope.requiredFields, [
    "schemaVersion", "contract", "state", "mode", "ok", "nextCommandId", "next", "release",
  ]);
  assert.deepEqual(contract.status.envelope.optionalFields, ["problem"]);
  assert.deepEqual(contract.status.states.map((state) => state.id), [
    "uninitialized", "local-ready", "local-invalid", "production-ready", "production-invalid",
  ]);
  assert.deepEqual(contract.status.releaseCompatibility.pinIdentityFields, [
    "version", "versionCode", "releaseId", "manifestSha256",
  ]);
  assert.deepEqual(contract.status.releaseCompatibility.observedPinFields, [
    "schemaVersion", "compatible", "acquired", "activated", "active", "staged",
    "version", "versionCode", "releaseId", "manifestSha256",
  ]);
  assert.deepEqual(contract.status.releaseCompatibility.profileDisabled, {
    observed: null,
    compatible: null,
  });
});
