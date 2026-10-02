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
  assert.match(generated, /"command": "\.\/luma pin network"/);
  assert.match(generated, /"command": "\.\/luma pin install"/);
  assert.match(generated, /"command": "\.\/luma pin activate"/);
  // Builder preflights, PKI import, and host config checks are not owner steps.
  assert.doesNotMatch(generated, /pin doctor|pki import|config check|pin release (?:build|ship|import)/);
  assert.doesNotMatch(generated, /"surface": "cli"/);
  assert.match(generated, /"surface": "center"/);
  assert.match(generated, /"centerRoute": "\/settings\/pin\/provision"/);
  assert.match(generated, /"centerRoute": "\/settings\/account\/services"/);
  // The Pin joins Wi-Fi over USB in Guided setup. The QR page is only a fallback.
  assert.doesNotMatch(generated, /"centerRoute": "\/wifi"/);
});

test("the Pin journey projects owner-facing stage labels and optional CLI equivalents", async () => {
  const { projectPinJourney } = await import("../../setup/generate.mjs");
  const contract = JSON.parse(await readFile(
    new URL("../../../contracts/operator-setup.json", import.meta.url),
    "utf8",
  ));
  const projection = projectPinJourney(contract);
  assert.deepEqual(projection.steps.map((step) => step.id), [
    "connect", "network", "install", "services", "activate", "passcode", "confirm",
  ]);
  for (const step of projection.steps) {
    assert.ok(step.title && step.summary, `${step.id} needs a title and summary`);
    assert.equal(step.command === null, step.commandId === null, step.id);
  }

  const withJourney = (change) => ({
    ...contract,
    journeys: contract.journeys.map((journey) =>
      journey.id === "pin" ? { ...journey, steps: journey.steps.map(change) } : journey),
  });
  assert.throws(
    () => projectPinJourney(withJourney((step) => (step.id === "network" ? { ...step, summary: " " } : step))),
    /pin step network has no summary/u,
  );
  assert.throws(
    () => projectPinJourney(withJourney((step) => (step.id === "network" ? { ...step, commandId: "pin.nope" } : step))),
    /references missing command pin\.nope/u,
  );
});

test("the README walks the Pin journey's stages in contract order", async () => {
  const [contractSource, readme] = await Promise.all([
    readFile(new URL("../../../contracts/operator-setup.json", import.meta.url), "utf8"),
    readFile(new URL("../../../README.md", import.meta.url), "utf8"),
  ]);
  const titles = JSON.parse(contractSource).journeys
    .find((journey) => journey.id === "pin").steps.map((step) => step.title);
  const section = /^## Connect a Pin\n([\s\S]*?)(?=^## )/mu.exec(readme)?.[1] ?? "";
  const positions = titles.map((title) => section.indexOf(`**${title}.**`));
  assert.ok(positions.every((position) => position >= 0), `README is missing a stage: ${titles.join(", ")}`);
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
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
