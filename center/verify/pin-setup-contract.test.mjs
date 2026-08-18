import "./tsResolve.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = new URL("../../", import.meta.url);
const contract = JSON.parse(
  await readFile(new URL("../../contracts/operator-setup.json", import.meta.url), "utf8"),
);
const { PIN_SETUP_JOURNEY } = await import(
  "../src/lib/pin-setup/generated/journey.ts"
);
const { derivePinSetupPlan } = await import("../src/lib/pin-setup/steps.ts");

function facts(overrides = {}) {
  return {
    usb: {
      browserSupported: true,
      connected: true,
      connecting: false,
      recognizedAiPin: true,
      serial: "1H4MPA42230112",
    },
    release: { availability: "published", version: "2026-08-18.1", detail: null },
    install: {
      state: "read",
      rolesTotal: 5,
      rolesInstalled: 5,
      rolesMatchingTarget: 5,
      unhealthyRoles: 0,
      conflicts: 0,
      deviceLocked: false,
      detail: null,
    },
    server: {
      answering: "online",
      assistantProvider: "openai",
      assistantModel: "gpt-5",
      assistantKeyPresent: true,
    },
    activation: {
      state: "active",
      edgeIpv4: "203.0.113.9",
      expectedEdgeState: "available",
      expectedEdgeIpv4: "203.0.113.9",
      detail: null,
    },
    cloud: {
      state: "live",
      pairedCount: 1,
      reportingCount: 1,
      lastReportAtEpoch: 1_755_000_000,
    },
    operator: true,
    ...overrides,
  };
}

test("the committed Center journey is an in-sync projection of the root contract", () => {
  const result = spawnSync(process.execPath, ["platform/setup/generate.mjs", "--check"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const pinJourney = contract.journeys.find((journey) => journey.id === "pin");
  assert.ok(pinJourney);
  assert.deepEqual(
    PIN_SETUP_JOURNEY.steps.map(({ id, title, commandId, centerRoute }) => ({
      id,
      title,
      commandId,
      centerRoute,
    })),
    pinJourney.steps.map(({ id, title, commandId, centerRoute }) => ({
      id,
      title,
      commandId,
      centerRoute,
    })),
  );
});

test("Center exposes the canonical build, ship, PKI, activation, and network commands", () => {
  const steps = new Map(derivePinSetupPlan(facts()).steps.map((step) => [step.id, step]));
  assert.equal(steps.get("release").command, "./revival pin release build");
  assert.equal(steps.get("ship").command, "./revival pin release ship");
  assert.equal(steps.get("identity").command, "./revival pki import");
  assert.equal(steps.get("activate").command, "./revival pin activate");
  assert.equal(steps.get("network").command, "./revival pin network qr");
  assert.equal(steps.get("network").centerRoute, "/wifi");
});

test("one step is focused and aggregate software health proves neither exact network nor physical acceptance", () => {
  const plan = derivePinSetupPlan(facts());
  const actionable = plan.steps.filter(
    (step) => !["done", "blocked", "unobservable"].includes(step.status),
  );
  assert.deepEqual(actionable.map((step) => step.id), ["network", "confirm"]);
  assert.equal(plan.focusStepId, "network");
  assert.equal(plan.steps.find((step) => step.id === "network").status, "manual");
  assert.match(
    plan.steps.find((step) => step.id === "network").summary,
    /reports do not identify the exact Pin attached here.*network path remains unverified/,
  );
  assert.equal(plan.steps.find((step) => step.id === "confirm").status, "manual");
  assert.match(
    plan.steps.find((step) => step.id === "confirm").summary,
    /Physical gesture, microphone, speaker, and wearer-response acceptance are separate/,
  );
});

test("an unpublished build and ship use separate truthful actions", () => {
  const plan = derivePinSetupPlan(
    facts({
      release: { availability: "not-published", version: null, detail: null },
    }),
  );
  const release = plan.steps.find((step) => step.id === "release");
  const ship = plan.steps.find((step) => step.id === "ship");
  assert.equal(release.status, "manual");
  assert.deepEqual(release.commands, ["./revival pin release build"]);
  assert.match(release.summary, /cannot tell whether a signed release was built/);
  assert.equal(ship.status, "manual");
  assert.deepEqual(ship.commands, ["./revival pin release ship"]);
  assert.doesNotMatch(ship.summary, /copy/i);
});

test("invalid deployment edge configuration cannot look absent or verified", () => {
  const plan = derivePinSetupPlan(
    facts({
      activation: {
        state: "active",
        edgeIpv4: "203.0.113.9",
        expectedEdgeState: "invalid",
        expectedEdgeIpv4: null,
        detail: null,
      },
    }),
  );
  const activation = plan.steps.find((step) => step.id === "activate");
  assert.equal(activation.status, "attention");
  assert.match(activation.summary, /REVIVAL_DEVICE_EDGE_IPV4 value is invalid/);
  assert.equal(plan.focusStepId, "activate");
});

test("the Wi-Fi helper keeps credentials browser-local", async () => {
  const source = await readFile(new URL("../src/app/wifi/page.tsx", import.meta.url), "utf8");
  assert.match(source, /useState\(""\)/);
  assert.match(source, /stay in this browser/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/);
});
