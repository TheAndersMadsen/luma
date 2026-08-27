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
      deviceId: "00aa11bb",
    },
    release: { availability: "published", version: "2026-08-18.1", detail: null },
    install: {
      state: "read",
      rolesTotal: 4,
      rolesInstalled: 4,
      rolesMatchingTarget: 4,
      installerState: "target",
      runtimeRolesNewerThanTarget: 0,
      unhealthyRoles: 0,
      conflicts: 0,
      deviceLocked: false,
      detail: null,
    },
    server: {
      answering: "online",
      assistantModel: "gpt-5",
      assistantReady: true,
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
      connectedPinReporting: false,
      connectedPinLastReportAtEpoch: null,
      connectedPinPaired: true,
    },
    physicalAcceptanceConfirmed: false,
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

test("Center exposes the canonical release import, PKI, activation, and network commands", () => {
  const steps = new Map(derivePinSetupPlan(facts()).steps.map((step) => [step.id, step]));
  assert.equal(steps.get("release").command, "./revival pin release import");
  assert.equal(steps.has("ship"), false);
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
    /This Pin still needs a network check/,
  );
  assert.equal(plan.steps.find((step) => step.id === "confirm").status, "manual");
  assert.match(
    plan.steps.find((step) => step.id === "confirm").summary,
    /Test this Pin.*microphone, speaker, and gesture/,
  );
});

test("a failed package inspection is not presented as an endless in-progress check", () => {
  const plan = derivePinSetupPlan(
    facts({
      install: {
        state: "failed",
        rolesTotal: 4,
        rolesInstalled: 0,
        rolesMatchingTarget: 0,
        installerState: "unknown",
        runtimeRolesNewerThanTarget: 0,
        unhealthyRoles: 0,
        conflicts: 0,
        deviceLocked: null,
        detail: "Android package service is not ready.",
      },
    }),
  );
  const install = plan.steps.find((step) => step.id === "install");
  assert.equal(install.status, "attention");
  assert.match(install.summary, /couldn.t inspect this Pin/i);
  assert.match(install.summary, /Android package service is not ready/i);
  assert.match(install.next, /reconnect|Android.*finish|check again/i);
});

test("a healthy retained installer completes setup when every runtime package is current", () => {
  const plan = derivePinSetupPlan(
    facts({
      install: {
        state: "read",
        rolesTotal: 4,
        rolesInstalled: 4,
        rolesMatchingTarget: 3,
        installerState: "retained",
        runtimeRolesNewerThanTarget: 0,
        unhealthyRoles: 0,
        conflicts: 0,
        deviceLocked: false,
        detail: null,
      },
    }),
  );
  const install = plan.steps.find((step) => step.id === "install");

  assert.equal(install.status, "done");
  assert.match(install.summary, /runtime packages match/i);
  assert.match(install.summary, /installer.*retained/i);
});

test("a Pin newer than Center focuses release import instead of offering a downgrade", () => {
  const plan = derivePinSetupPlan(
    facts({
      release: { availability: "published", version: "2026-08-27.3", detail: null },
      install: {
        state: "read",
        rolesTotal: 4,
        rolesInstalled: 4,
        rolesMatchingTarget: 0,
        installerState: "retained",
        runtimeRolesNewerThanTarget: 3,
        unhealthyRoles: 0,
        conflicts: 0,
        deviceLocked: false,
        detail: null,
      },
    }),
  );
  const release = plan.steps.find((step) => step.id === "release");
  const install = plan.steps.find((step) => step.id === "install");

  assert.equal(plan.focusStepId, "release");
  assert.equal(release.status, "manual");
  assert.match(release.summary, /Pin runs newer runtime software/i);
  assert.match(release.next, /computer that installed.*export/i);
  assert.deepEqual(release.commands, [
    "./revival pin release export --output ai-pin-revival-pin-current.tar.gz",
    "./revival pin release import ai-pin-revival-pin-current.tar.gz",
  ]);
  assert.equal(install.status, "blocked");
  assert.doesNotMatch(install.next ?? "", /update|downgrade|installer/i);
});

test("a recent report from the connected Pin proves its network without claiming physical acceptance", () => {
  const plan = derivePinSetupPlan(
    facts({
      cloud: {
        state: "live",
        pairedCount: 1,
        reportingCount: 1,
        lastReportAtEpoch: 1_755_000_000,
        connectedPinReporting: true,
        connectedPinLastReportAtEpoch: 1_755_000_000,
      },
    }),
  );
  const network = plan.steps.find((step) => step.id === "network");
  const confirm = plan.steps.find((step) => step.id === "confirm");
  assert.equal(network.status, "done");
  assert.match(network.summary, /This Pin is online and reporting/);
  assert.equal(confirm.status, "manual");
  assert.equal(plan.focusStepId, "confirm");
});

test("an unavailable reporting path does not send the owner to add Wi-Fi", () => {
  for (const state of ["absent", "degraded"]) {
    const plan = derivePinSetupPlan(
      facts({
        cloud: {
          state,
          pairedCount: state === "absent" ? null : 1,
          reportingCount: 0,
          lastReportAtEpoch: null,
          connectedPinReporting: false,
          connectedPinLastReportAtEpoch: null,
        },
      }),
    );
    const network = plan.steps.find((step) => step.id === "network");
    assert.equal(network.status, "attention");
    assert.match(network.next, /Cosmos|report/i);
    assert.doesNotMatch(network.next, /Wi-Fi|QR/i);
  }
});

test("an unpaired Pin is identified before network onboarding", () => {
  const plan = derivePinSetupPlan(
    facts({
      cloud: {
        state: "live",
        pairedCount: 0,
        reportingCount: 0,
        lastReportAtEpoch: null,
        connectedPinReporting: false,
        connectedPinLastReportAtEpoch: null,
        connectedPinPaired: false,
      },
    }),
  );
  const network = plan.steps.find((step) => step.id === "network");
  assert.equal(network.status, "todo");
  assert.match(network.summary, /not paired with this account/i);
  assert.match(network.next, /Pair this Pin/i);
  assert.doesNotMatch(network.next, /Wi-Fi|QR/i);
});

test("another paired Pin never makes the exact connected Pin look paired", () => {
  const plan = derivePinSetupPlan(
    facts({
      cloud: {
        state: "live",
        pairedCount: 1,
        reportingCount: 0,
        lastReportAtEpoch: null,
        connectedPinReporting: false,
        connectedPinLastReportAtEpoch: null,
        connectedPinPaired: false,
      },
    }),
  );
  const network = plan.steps.find((step) => step.id === "network");
  assert.equal(network.status, "todo");
  assert.match(network.summary, /This Pin is not paired/i);
  assert.doesNotMatch(network.next, /Wi-Fi|QR/i);
});

test("the owner can explicitly complete physical acceptance after trying the Pin", () => {
  const plan = derivePinSetupPlan(
    facts({
      cloud: {
        state: "live",
        pairedCount: 1,
        reportingCount: 1,
        lastReportAtEpoch: 1_755_000_000,
        connectedPinReporting: true,
        connectedPinLastReportAtEpoch: 1_755_000_000,
      },
      physicalAcceptanceConfirmed: true,
    }),
  );
  assert.equal(plan.steps.find((step) => step.id === "confirm").status, "done");
  assert.equal(plan.focusStepId, null);
});

test("an unpublished release points directly to the verified archive import", () => {
  const plan = derivePinSetupPlan(
    facts({
      release: { availability: "not-published", version: null, detail: null },
    }),
  );
  const release = plan.steps.find((step) => step.id === "release");
  assert.equal(release.status, "manual");
  assert.deepEqual(release.commands, ["./revival pin release import ARCHIVE"]);
  assert.match(release.summary, /No signed Pin release/);
  assert.match(release.next, /Download the signed archive/);
  assert.match(release.manualNote, /verifies every APK/);
  assert.equal(plan.steps.some((step) => step.id === "ship"), false);
});

test("an unpublished release never sends the owner to an installer with nothing to install", async () => {
  const setupView = await readFile(
    new URL("../src/app/settings/pin/setup/SetupView.tsx", import.meta.url),
    "utf8",
  );
  const installAction = /case "install":([\s\S]*?)(?=\n\s*case "cosmos":)/u.exec(setupView)?.[1];
  assert.ok(installAction, "guided setup is missing the install-stage action");
  assert.match(installAction, /step\.id === "release"/u);
  assert.match(installAction, /github\.com\/TheAndersMadsen\/ai-pin-revival\/releases/u);
  assert.match(installAction, /step\.commands\.map/u);
  assert.match(installAction, /exportCurrentRelease \? null/u);
  assert.equal(
    PIN_SETUP_JOURNEY.steps.find((step) => step.id === "release")?.centerRoute,
    null,
  );
});

test("normal Center activation does not tell an operator to create or move a private-key file", () => {
  const plan = derivePinSetupPlan(
    facts({
      activation: {
        state: "inactive",
        edgeIpv4: null,
        expectedEdgeState: "available",
        expectedEdgeIpv4: "203.0.113.9",
        detail: null,
      },
    }),
  );
  for (const id of ["identity", "activate"]) {
    const step = plan.steps.find((candidate) => candidate.id === id);
    assert.equal(step.status, "todo");
    assert.match(step.next, /Provisioning|connect this Pin/i);
    assert.doesNotMatch(`${step.summary} ${step.next} ${step.manualNote}`, /file|private key|command/i);
    assert.deepEqual(step.commands, []);
  }
});

test("a wearer is told to ask the operator when Cosmos services need configuration", async () => {
  const plan = derivePinSetupPlan(
    facts({
      server: {
        answering: "online",
        assistantModel: null,
        assistantReady: false,
      },
      operator: false,
    }),
  );
  const configure = plan.steps.find((step) => step.id === "configure");
  assert.equal(configure.status, "manual");
  assert.match(configure.summary, /operator/i);
  assert.match(configure.next, /Ask.*operator/i);
  assert.deepEqual(configure.commands, []);

  const setupView = await readFile(
    new URL("../src/app/settings/pin/setup/SetupView.tsx", import.meta.url),
    "utf8",
  );
  const configureAction = /if \(step\.id === "configure"\) \{([\s\S]*?)(?=\n\s*\})/u.exec(setupView)?.[1];
  assert.ok(configureAction, "guided setup is missing the configuration action");
  assert.match(configureAction, /provisioningHref/u);
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
  assert.match(activation.summary, /edge setting is invalid/);
  assert.match(activation.next, /REVIVAL_DEVICE_EDGE_IPV4/);
  assert.equal(plan.focusStepId, "activate");
});

test("the Wi-Fi helper keeps credentials browser-local", async () => {
  const source = await readFile(new URL("../src/app/wifi/page.tsx", import.meta.url), "utf8");
  assert.match(source, /useState\(""\)/);
  assert.match(source, /stay in this browser/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/);
});
