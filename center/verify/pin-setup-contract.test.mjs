
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
const { derivePinSetupPlan, musicPlaybackReadiness } = await import(
  "../src/lib/pin-setup/steps.ts"
);

const STUCK_CLOCK = Date.UTC(2025, 1, 18, 15, 43);
const NOW = Date.UTC(2026, 8, 23, 12, 0);

/** A Pin that is fully set up except for the owner's physical confirmation. */
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
    network: {
      state: "read",
      wifiEnabled: true,
      wifiNetwork: "Home",
      online: true,
      transport: "wifi",
      pinTimeEpochMs: NOW,
      clockSkewMs: 300,
      detail: null,
    },
    release: { availability: "published", version: "2026-08-18.1", detail: null },
    install: {
      state: "read",
      rolesTotal: 5,
      rolesInstalled: 5,
      rolesMatchingTarget: 5,
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
      capabilities: {
        assistant: true,
        speech: true,
        weather: true,
        nearbyNavigation: true,
        musicPlayback: true,
        foodLogging: true,
      },
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
      connectedPinReporting: true,
      connectedPinLastReportAtEpoch: 1_755_000_000,
      connectedPinPaired: true,
    },
    remote: { state: "assigned" },
    onboarding: { setupComplete: true },
    passcode: { state: "set" },
    physicalAcceptanceConfirmed: false,
    operator: true,
    ...overrides,
  };
}

function step(plan, id) {
  const found = plan.steps.find((candidate) => candidate.id === id);
  assert.ok(found, `plan has no ${id} step`);
  return found;
}

test("the committed Center journey is an in-sync projection of the root contract", () => {
  const result = spawnSync(process.execPath, ["platform/setup/generate.mjs", "--check"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const pinJourney = contract.journeys.find((journey) => journey.id === "pin");
  assert.ok(pinJourney);
  const fields = ({ id, title, summary, commandId, centerRoute }) => ({
    id,
    title,
    summary,
    commandId,
    centerRoute,
  });
  assert.deepEqual(PIN_SETUP_JOURNEY.steps.map(fields), pinJourney.steps.map(fields));
});

test("the journey runs in the order a real Pin needs, with only real owner commands", () => {
  const steps = new Map(derivePinSetupPlan(facts()).steps.map((entry) => [entry.id, entry]));
  assert.deepEqual([...steps.keys()], [
    "connect",
    "network",
    "install",
    "services",
    "activate",
    "passcode",
    "confirm",
  ]);
  assert.deepEqual(
    Object.fromEntries([...steps].map(([id, entry]) => [id, entry.command])),
    {
      connect: null,
      network: "./luma pin network",
      install: "./luma pin install",
      services: null,
      activate: "./luma pin activate",
      passcode: null,
      confirm: null,
    },
  );
  // A builder preflight, PKI import, or host config check is never an owner step.
  for (const entry of steps.values()) {
    assert.doesNotMatch(entry.command ?? "", /pin doctor|pki import|config check/u);
  }
  assert.equal(steps.get("network").centerRoute, "/settings/pin/setup");
  assert.equal(steps.get("install").centerRoute, "/settings/pin/install");
  assert.equal(steps.get("services").centerRoute, "/settings/account/services");
  assert.equal(steps.get("activate").centerRoute, "/settings/pin/provision");
  assert.equal(steps.get("passcode").centerRoute, "/settings/pin/setup");
  for (const entry of steps.values()) {
    assert.ok(entry.title.length > 0 && entry.description.length > 0, `${entry.id} has no labels`);
  }
});

test("a stock Pin with Wi-Fi off and a stuck clock is sent to Network & time first", () => {
  const plan = derivePinSetupPlan(
    facts({
      network: {
        state: "read",
        wifiEnabled: false,
        wifiNetwork: null,
        online: false,
        transport: null,
        pinTimeEpochMs: STUCK_CLOCK,
        clockSkewMs: STUCK_CLOCK - NOW,
        detail: null,
      },
      install: { ...facts().install, state: "read", rolesInstalled: 0, rolesMatchingTarget: 0 },
      activation: { ...facts().activation, state: "inactive", edgeIpv4: null },
      onboarding: { setupComplete: true },
    }),
  );
  const network = step(plan, "network");
  assert.equal(plan.focusStepId, "network");
  assert.equal(network.status, "todo");
  assert.match(network.summary, /Wi-Fi is off/u);
  assert.match(network.summary, /February 18, 2025/u);
  assert.match(network.summary, /corrects itself once the Pin is online/u);
  assert.match(network.next, /Turn on Wi-Fi/u);
  assert.equal(step(plan, "install").status, "todo", "install still describes itself");
});

test("Wi-Fi on but no network asks the owner to choose one", () => {
  const plan = derivePinSetupPlan(
    facts({
      network: { ...facts().network, wifiNetwork: null, online: false, transport: null },
    }),
  );
  const network = step(plan, "network");
  assert.equal(network.status, "todo");
  assert.match(network.summary, /not online/u);
  assert.match(network.next, /Choose the Wi-Fi network/u);
});

test("an online Pin whose clock is still wrong needs Center to set it", () => {
  const plan = derivePinSetupPlan(
    facts({
      network: { ...facts().network, pinTimeEpochMs: NOW - 5 * 60_000, clockSkewMs: -5 * 60_000 },
    }),
  );
  const network = step(plan, "network");
  assert.equal(plan.focusStepId, "network");
  assert.equal(network.status, "attention");
  assert.match(network.summary, /online, but its clock is 5 minutes behind/u);
  assert.match(network.next, /set the Pin’s clock/u);
});

test("a validated network and a right clock complete Network & time", () => {
  const wifi = step(derivePinSetupPlan(facts()), "network");
  assert.equal(wifi.status, "done");
  assert.equal(wifi.summary, "Online on Home, and the clock is right.");

  const cellular = step(
    derivePinSetupPlan(
      facts({ network: { ...facts().network, wifiEnabled: false, wifiNetwork: null, transport: "cellular" } }),
    ),
    "network",
  );
  assert.equal(cellular.status, "done");
  assert.match(cellular.summary, /mobile data/u);
});

test("an unreadable network is a plain problem, not an endless check", () => {
  const network = step(
    derivePinSetupPlan(
      facts({
        network: {
          ...facts().network,
          state: "unreadable",
          online: null,
          detail: "Center couldn’t read the Pin’s network. Check that it is still connected, then try again.",
        },
      }),
    ),
    "network",
  );
  assert.equal(network.status, "attention");
  assert.match(network.summary, /couldn’t read the Pin’s network/u);
  assert.match(network.next, /Check again/u);
});

test("an unpublished or refused release names the server command in the install stage", () => {
  const missing = step(
    derivePinSetupPlan(facts({ release: { availability: "not-published", version: null, detail: null } })),
    "install",
  );
  assert.equal(missing.status, "manual");
  assert.match(missing.summary, /no Pin release to install/u);
  assert.deepEqual(missing.commands, ["./luma pin release acquire --archive luma-pin-VERSION.tar.gz"]);

  const refused = step(
    derivePinSetupPlan(
      facts({ release: { availability: "unreadable", version: null, detail: "signature mismatch" } }),
    ),
    "install",
  );
  assert.equal(refused.status, "attention");
  assert.match(refused.summary, /signature mismatch/u);
  assert.deepEqual(refused.commands, ["./luma pin release acquire --check"]);
});

test("a Pin newer than the server's release is never offered a downgrade", () => {
  const plan = derivePinSetupPlan(
    facts({
      release: { availability: "published", version: "2026-08-27.3", detail: null },
      install: {
        ...facts().install,
        rolesMatchingTarget: 0,
        installerState: "retained",
        runtimeRolesNewerThanTarget: 3,
      },
    }),
  );
  const install = step(plan, "install");
  assert.equal(plan.focusStepId, "install");
  assert.equal(install.status, "manual");
  assert.match(install.summary, /newer Luma software than your server’s release 2026-08-27\.3/u);
  assert.match(install.next, /never downgrades/u);
  assert.deepEqual(install.commands, ["./luma pin release acquire --check"]);
});

test("a failed package inspection is not presented as an endless in-progress check", () => {
  const install = step(
    derivePinSetupPlan(
      facts({
        install: {
          ...facts().install,
          state: "failed",
          rolesInstalled: 0,
          rolesMatchingTarget: 0,
          installerState: "unknown",
          deviceLocked: null,
          detail: "Android package service is not ready.",
        },
      }),
    ),
    "install",
  );
  assert.equal(install.status, "attention");
  assert.match(install.summary, /couldn.t inspect this Pin/iu);
  assert.match(install.summary, /Android package service is not ready/iu);
  assert.match(install.next, /reconnect|Android.*finish|check again/iu);
});

test("an unsupported installer uses the friendly Device Installer label", () => {
  const install = step(
    derivePinSetupPlan(facts({ install: { ...facts().install, installerState: "unsupported" } })),
    "install",
  );
  assert.equal(install.summary, "The Device Installer is not ready for routine software updates.");
});

test("a healthy retained installer completes install when every runtime app is current", () => {
  const install = step(
    derivePinSetupPlan(
      facts({ install: { ...facts().install, rolesMatchingTarget: 4, installerState: "retained" } }),
    ),
    "install",
  );
  assert.equal(install.status, "done");
  assert.equal(install.summary, "Luma 2026-08-18.1 is installed.");
});

test("only the assistant and speech gate setup; optional services never block", () => {
  const plan = derivePinSetupPlan(
    facts({
      server: {
        ...facts().server,
        capabilities: {
          assistant: true,
          speech: true,
          weather: false,
          nearbyNavigation: null,
          musicPlayback: false,
          foodLogging: false,
        },
      },
      physicalAcceptanceConfirmed: true,
    }),
  );
  const services = step(plan, "services");
  assert.equal(services.status, "done");
  assert.match(services.summary, /assistant and speech are ready/u);
  assert.equal(plan.focusStepId, null, "music, food, weather and nearby are optional");
});

test("a missing required service sends an operator to Services", () => {
  const services = step(
    derivePinSetupPlan(
      facts({
        server: {
          ...facts().server,
          capabilities: { ...facts().server.capabilities, speech: false, musicPlayback: false },
        },
      }),
    ),
    "services",
  );
  assert.equal(services.status, "todo");
  assert.equal(services.summary, "Speech needs setting up.");
  assert.doesNotMatch(services.summary, /Music/u);
  assert.match(services.next, /Settings → Services/u);
});

test("an unread required service stays checking instead of becoming a false success", () => {
  const services = step(
    derivePinSetupPlan(
      facts({ server: { ...facts().server, capabilities: { ...facts().server.capabilities, assistant: null } } }),
    ),
    "services",
  );
  assert.equal(services.status, "todo");
  assert.match(services.summary, /Checking Assistant/u);
  assert.equal(services.next, null);
});

test("a wearer is told to ask the operator when a required service needs setup", () => {
  const services = step(
    derivePinSetupPlan(
      facts({
        server: { ...facts().server, capabilities: { ...facts().server.capabilities, assistant: false } },
        operator: false,
      }),
    ),
    "services",
  );
  assert.equal(services.status, "manual");
  assert.match(services.summary, /operator/iu);
  assert.match(services.next, /Ask.*operator/iu);
  assert.deepEqual(services.commands, []);
});

test("an inactive Pin is connected from Provisioning without files or private keys", () => {
  const activate = step(
    derivePinSetupPlan(
      facts({ activation: { ...facts().activation, state: "inactive", edgeIpv4: null } }),
    ),
    "activate",
  );
  assert.equal(activate.status, "todo");
  assert.match(activate.next, /Open Provisioning and choose Connect this Pin to Cosmos/u);
  assert.doesNotMatch(`${activate.summary} ${activate.next}`, /file|private key|command/iu);
  assert.deepEqual(activate.commands, []);
});

test("a Pin pointed at another server or at an invalid edge is not called connected", () => {
  const invalid = derivePinSetupPlan(
    facts({ activation: { ...facts().activation, expectedEdgeState: "invalid", expectedEdgeIpv4: null } }),
  );
  assert.equal(step(invalid, "activate").status, "attention");
  assert.match(step(invalid, "activate").summary, /edge setting is invalid/u);
  assert.match(step(invalid, "activate").next, /LUMA_DEVICE_EDGE_IPV4/u);
  assert.equal(invalid.focusStepId, "activate");

  const elsewhere = step(
    derivePinSetupPlan(facts({ activation: { ...facts().activation, edgeIpv4: "198.51.100.4" } })),
    "activate",
  );
  assert.equal(elsewhere.status, "attention");
  assert.match(elsewhere.summary, /not at your server \(203\.0\.113\.9\)/u);
});

test("an activated but unpaired Pin is offered pairing, and another paired Pin never counts", () => {
  const activate = step(
    derivePinSetupPlan(
      facts({ cloud: { ...facts().cloud, pairedCount: 1, connectedPinPaired: false } }),
    ),
    "activate",
  );
  assert.equal(activate.status, "todo");
  assert.match(activate.summary, /not paired with your account/u);
  assert.equal(activate.next, "Pair this Pin.");
});

test("a paired Pin that Center cannot reach remotely is offered remote access", () => {
  const unassigned = step(derivePinSetupPlan(facts({ remote: { state: "unassigned" } })), "activate");
  assert.equal(unassigned.status, "todo");
  assert.match(unassigned.summary, /paired with your account/u);
  assert.match(unassigned.summary, /without the cable/u);
  assert.equal(unassigned.next, "Turn on remote access.");

  assert.equal(
    step(derivePinSetupPlan(facts({ remote: { state: "unknown" } })), "activate").status,
    "todo",
  );
  // A server without a remote link does not hold setup back, and a second Pin
  // is not pushed to take the link from the owner's first.
  for (const state of ["assigned", "elsewhere", "unavailable"]) {
    assert.equal(step(derivePinSetupPlan(facts({ remote: { state } })), "activate").status, "done", state);
  }
  assert.match(
    step(derivePinSetupPlan(facts({ remote: { state: "elsewhere" } })), "activate").summary,
    /other Pin/u,
  );
  // Pairing comes first: remote access is offered only for a paired Pin.
  const unpaired = step(
    derivePinSetupPlan(facts({
      remote: { state: "unassigned" },
      cloud: { ...facts().cloud, connectedPinPaired: false },
    })),
    "activate",
  );
  assert.equal(unpaired.next, "Pair this Pin.");
});

test("an unavailable pairing roster is named rather than sending the owner to Wi-Fi", () => {
  for (const state of ["absent", "degraded"]) {
    const activate = step(
      derivePinSetupPlan(facts({ cloud: { ...facts().cloud, state, connectedPinPaired: null } })),
      "activate",
    );
    assert.equal(activate.status, "attention");
    assert.match(activate.next, /Cosmos/u);
    assert.doesNotMatch(activate.next, /Wi-Fi|QR/u);
  }
});

test("a Pin that finished its own setup is told plainly it will not ask for a passcode", () => {
  const passcode = step(derivePinSetupPlan(facts({ onboarding: { setupComplete: true } })), "passcode");
  assert.equal(passcode.status, "done");
  assert.match(passcode.summary, /finished its own setup/u);
  assert.match(passcode.summary, /passcode it already has/u);
});

test("a Pin still in its own setup can finish from Guided setup", () => {
  const notSet = step(
    derivePinSetupPlan(facts({ onboarding: { setupComplete: false }, passcode: { state: "not-set" } })),
    "passcode",
  );
  assert.equal(notSet.status, "todo");
  assert.match(notSet.next, /Choose four digits/u);

  const waiting = step(
    derivePinSetupPlan(facts({ onboarding: { setupComplete: false }, passcode: { state: "set" } })),
    "passcode",
  );
  assert.equal(waiting.status, "todo");
  assert.match(waiting.next, /same four digits/u);
  assert.match(waiting.next, /directly to this Pin/u);

  const beforeActivation = step(
    derivePinSetupPlan(
      facts({
        onboarding: { setupComplete: false },
        passcode: { state: "set" },
        activation: { ...facts().activation, state: "inactive", edgeIpv4: null },
      }),
    ),
    "passcode",
  );
  assert.equal(beforeActivation.status, "blocked");
  assert.match(beforeActivation.summary, /after it connects to your Luma/u);
});

test("an owner without a passcode chooses it before connecting a Pin that will ask for it", () => {
  const inactive = { ...facts().activation, state: "inactive", edgeIpv4: null };
  const asks = step(
    derivePinSetupPlan(
      facts({ onboarding: { setupComplete: false }, passcode: { state: "not-set" }, activation: inactive }),
    ),
    "activate",
  );
  assert.match(asks.next, /^First choose your Pin passcode in Settings → Passcode & password/u);
  assert.match(asks.next, /Open Provisioning and choose Connect this Pin to Cosmos/u);

  // A Pin that finished its own setup never asks, so nothing is put in the way.
  const neverAsks = step(
    derivePinSetupPlan(
      facts({ onboarding: { setupComplete: true }, passcode: { state: "not-set" }, activation: inactive }),
    ),
    "activate",
  );
  assert.doesNotMatch(neverAsks.next, /passcode/u);
});

test("aggregate software health never claims the owner's physical confirmation", () => {
  const plan = derivePinSetupPlan(facts());
  assert.equal(plan.focusStepId, "confirm");
  const confirm = step(plan, "confirm");
  assert.equal(confirm.status, "manual");
  assert.match(confirm.summary, /reporting to your Luma/u);
  assert.match(confirm.summary, /microphone, speaker, and gesture/u);
  assert.equal(plan.doneCount, 6);

  const quiet = step(
    derivePinSetupPlan(facts({ cloud: { ...facts().cloud, connectedPinReporting: false } })),
    "confirm",
  );
  assert.match(quiet.summary, /hasn’t reported/u);
});

test("the owner can explicitly complete physical acceptance after trying the Pin", () => {
  const plan = derivePinSetupPlan(facts({ physicalAcceptanceConfirmed: true }));
  assert.equal(step(plan, "confirm").status, "done");
  assert.equal(plan.focusStepId, null);
  assert.equal(plan.doneCount, plan.total);
});

test("physical acceptance is persisted by the Pin and never by browser storage", async () => {
  const setupView = await readFile(
    new URL("../src/app/settings/pin/setup/SetupView.tsx", import.meta.url),
    "utf8",
  );
  const readings = await readFile(
    new URL("../src/app/settings/pin/setup/usePinSetupFacts.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(setupView, /localStorage|sessionStorage|document\.cookie/u);
  assert.match(readings, /client\.getSetupAcceptance\(\)/u);
  assert.match(readings, /client\.confirmSetupAcceptance/u);
  assert.match(readings, /setupAcceptanceConfirmed\(response, acceptanceTarget\)/u);
});

test("catalog availability alone cannot prove playback on the selected Pin", () => {
  const connectedYoutubeCatalog = {
    youtube_music: { state: "connected" },
  };

  assert.equal(
    musicPlaybackReadiness(null, connectedYoutubeCatalog),
    null,
    "provider state without a Pin runtime is unread, not ready",
  );
  assert.equal(
    musicPlaybackReadiness(
      {
        active_provider: "spotify",
        state: "not_configured",
        engine_ready: false,
      },
      connectedYoutubeCatalog,
    ),
    false,
    "a connected non-selected catalog cannot satisfy playback",
  );
  assert.equal(
    musicPlaybackReadiness(
      {
        active_provider: "youtube_music",
        state: "disabled",
        engine_ready: false,
      },
      connectedYoutubeCatalog,
    ),
    true,
    "the selected Pin runtime and authenticated provider connection together prove playback",
  );
});

test("music readiness reads both the connected Pin and authenticated provider status", async () => {
  const source = await readFile(
    new URL("../src/app/settings/pin/setup/usePinSetupFacts.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /client\.getSpotifyStatus\(\)/u);
  assert.match(source, /fetch\("\/api\/settings\/services\/music"/u);
  assert.match(
    source,
    /musicPlaybackReadiness\(\s*pinMusicQuery\.data,\s*musicProvidersQuery\.data/u,
  );
});

test("guided setup reads network, clock, and the Pin's own setup over USB", async () => {
  const source = await readFile(
    new URL("../src/app/settings/pin/setup/usePinSetupFacts.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /readPinNetwork\(session\)/u);
  assert.match(source, /readCenterClock\(\)/u);
  assert.match(source, /readPinClock\(session, center\)/u);
  assert.match(source, /"humane\.settings\.global\.DUC_PROVISIONED"/u);
  assert.match(source, /queryKey: \["account-passcode"\]/u);
});

test("Wi-Fi credentials stay in the browser and on the Pin", async () => {
  const [qrPage, panel, network] = await Promise.all([
    readFile(new URL("../src/app/wifi/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/settings/pin/setup/NetworkTimePanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/pin-setup/network.ts", import.meta.url), "utf8"),
  ]);
  assert.match(qrPage, /useState\(""\)/u);
  assert.match(qrPage, /stay in this browser/u);
  for (const source of [qrPage, panel]) {
    assert.doesNotMatch(source, /\bfetch\s*\(/u);
    assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/u);
  }
  assert.doesNotMatch(panel, /logInfo|logWarn|logError|console\./u);
  // The only fetch in the network module reads Center's clock.
  assert.deepEqual([...network.matchAll(/fetchImpl\(([^,)]*)/gu)].map((match) => match[1]), [
    '"/api/version"',
  ]);
  assert.match(network, /device\.shellWithInput\(JOIN_WIFI_COMMAND, new Blob\(\[input\]/u);
});

test("the onboarding passcode takes only the fixed write-only USB path", async () => {
  const [panel, onboarding] = await Promise.all([
    readFile(
      new URL("../src/app/settings/pin/setup/OnboardingPasscodePanel.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/lib/pin-setup/onboarding.ts", import.meta.url), "utf8"),
  ]);

  for (const source of [panel, onboarding]) {
    assert.doesNotMatch(source, /\bfetch\s*\(/u);
    assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/u);
    assert.doesNotMatch(source, /logInfo|logWarn|logError|console\./u);
  }
  assert.match(
    onboarding,
    /"content:\/\/com\.penumbraos\.server\.cosmosidentity\/onboarding-pincode"/u,
  );
  assert.match(onboarding, /device\.shellWithInput\(FINISH_ONBOARDING_COMMAND, input\)/u);
  assert.match(onboarding, /passcode = ""/u);
  assert.match(onboarding, /Math\.min\(timeoutMs, MAX_ONBOARDING_WAIT_MS\)/u);
  assert.doesNotMatch(onboarding, /"settings",\s*"put"/u);
});
