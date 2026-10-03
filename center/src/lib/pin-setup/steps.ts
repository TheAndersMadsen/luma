/**
 * The guided setup plan: what it takes to get from a stock Ai Pin to one that
 * answers through your Luma, in the order a real Pin needs, and what is ALREADY
 * true about the Pin in front of you.
 *
 *   connect → network & time → install → required services → activate →
 *   passcode → try it
 *
 * Network and time come before everything that talks to your server: a Pin
 * with its clock stuck in 2025 rejects every certificate your server issued,
 * so activation and status reports would fail with no hint why.
 *
 * This module is the model, and it is deliberately framework-free: no React, no
 * Next, no `window`, no device access. It takes facts that somebody else read
 * (a USB session, a release manifest, a package inspection, `Settings.Global`,
 * the pairing roster) and answers one question per step, done, blocked, needs
 * attention, or not something Center can see at all.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a step is never marked done because the
 * step before it was. Every "done" here is backed by something that was
 * actually read from the device, the server, or the backend, and a step whose
 * state cannot be observed says so in those words rather than guessing.
 *
 * Step order, titles, summaries, routes, and CLI equivalents come from the
 * generated projection of `contracts/operator-setup.json`. Center owns only the
 * fact-based derivation below.
 */

import {
  PIN_SETUP_JOURNEY,
  type GeneratedPinSetupStep,
} from "./generated/journey";
import { CLOCK_TOLERANCE_MS, describeClockSkew } from "./network";

export type PinSetupStepId = GeneratedPinSetupStep["id"];
export const PIN_SETUP_STEP_IDS = PIN_SETUP_JOURNEY.steps.map(
  (step) => step.id,
) as readonly PinSetupStepId[];

/**
 * Where a step stands.
 *
 *   done          evidence says this is finished
 *   todo          not finished, and it can be done here, now
 *   manual        not finished, and it is done somewhere else, on the Pin, or
 *                 on the server, with the commands named
 *   attention     something was read and it is wrong, or needs a decision
 *   blocked       an earlier step has to land first. Nothing to do here yet
 *   unobservable  Center cannot see this state from here, and says so
 */
export type PinSetupStepStatus =
  | "done"
  | "todo"
  | "manual"
  | "attention"
  | "blocked"
  | "unobservable";

/** Whether this browser can reach a Pin, and whether one is attached. */
export interface PinSetupUsbFacts {
  /** `null` until the browser check has run after mount. */
  readonly browserSupported: boolean | null;
  readonly connected: boolean;
  readonly connecting: boolean;
  /** `getprop` recognition. `null` while identity is still being read. */
  readonly recognizedAiPin: boolean | null;
  readonly serial: string | null;
  /** Stable hardware ID read from ro.boot.deviceid, used by enrollment. */
  readonly deviceId: string | null;
}

/**
 * The Pin's own network and clock, read over the USB session.
 *
 * `online` is Android's validation of a network (Wi-Fi or mobile data), not
 * merely an association. `clockSkewMs` is the Pin's clock minus Center's.
 */
export interface PinSetupNetworkFacts {
  readonly state: "unknown" | "checking" | "read" | "unreadable";
  readonly wifiEnabled: boolean | null;
  readonly wifiNetwork: string | null;
  readonly online: boolean | null;
  readonly transport: "wifi" | "cellular" | null;
  readonly pinTimeEpochMs: number | null;
  readonly clockSkewMs: number | null;
  readonly detail: string | null;
}

export type PinSetupReleaseAvailability =
  | "unknown"
  | "checking"
  | "published"
  | "not-published"
  | "unreadable";

/** What `/api/pin/releases/current` answered, after manifest verification. */
export interface PinSetupReleaseFacts {
  readonly availability: PinSetupReleaseAvailability;
  readonly version: string | null;
  /** The verifier's own message when the manifest was refused. */
  readonly detail: string | null;
}

/** What the managed-package inspection found on the device. */
export interface PinSetupInstallFacts {
  readonly state: "unknown" | "checking" | "read" | "failed";
  readonly rolesTotal: number;
  readonly rolesInstalled: number;
  /** Installed AND queryable AND the same version as the published release. */
  readonly rolesMatchingTarget: number;
  /** How the Device Installer relates to the published runtime release. */
  readonly installerState: "unknown" | "target" | "retained" | "unsupported";
  /** Runtime roles that would have to be downgraded to match Center. */
  readonly runtimeRolesNewerThanTarget: number;
  readonly unhealthyRoles: number;
  readonly conflicts: number;
  /** Credential-encrypted storage. `null` when it was not read. */
  readonly deviceLocked: boolean | null;
  readonly detail: string | null;
}

/**
 * Every capability Center reports on. Only the `required` ones gate setup: a
 * Pin that can hear you and answer is set up. The rest are optional and never
 * block the next step.
 */
export const PIN_SETUP_CAPABILITIES = [
  {
    id: "assistant",
    label: "Assistant",
    detail: "Understands your questions and finds the answers",
    required: true,
  },
  {
    id: "speech",
    label: "Speech",
    detail: "Hears what you say and speaks the answer",
    required: true,
  },
  {
    id: "weather",
    label: "Weather",
    detail: "Current weather where you are",
    required: false,
  },
  {
    id: "nearbyNavigation",
    label: "Nearby & navigation",
    detail: "Places, routes, and directions",
    required: false,
  },
  {
    id: "musicPlayback",
    label: "Music playback",
    detail: "Your chosen music service can play on this Pin",
    required: false,
  },
  {
    id: "foodLogging",
    label: "Food logging",
    detail: "Looks up foods and keeps your food log",
    required: false,
  },
] as const;

export type PinSetupCapabilityId = (typeof PIN_SETUP_CAPABILITIES)[number]["id"];

export type PinSetupCapabilityFacts = Readonly<
  Record<PinSetupCapabilityId, boolean | null>
>;

/** Device Services on the Pin, over the same USB session. */
export interface PinSetupServerFacts {
  readonly answering: "unknown" | "checking" | "online" | "offline";
  readonly assistantModel: string | null;
  /** `null` means the authoritative status path has not answered. */
  readonly capabilities: PinSetupCapabilityFacts;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Prove music playback from both sides of the boundary.
 *
 * The Pin status proves which playback runtime is selected and answering. The
 * authenticated provider status proves that the selected Center account is
 * connected. Provider/catalog state alone is deliberately insufficient.
 */
export function musicPlaybackReadiness(
  pinStatusValue: unknown,
  providerStatusValue: unknown,
): boolean | null {
  const pinStatus = objectRecord(pinStatusValue);
  if (!pinStatus) return null;

  const activeProvider = pinStatus.active_provider;
  const state = pinStatus.state;
  const engineReady = pinStatus.engine_ready;
  if (
    !["spotify", "youtube_music", "apple_music", "tidal"].includes(
      String(activeProvider),
    ) ||
    !["disabled", "not_configured", "pairing", "ready", "error"].includes(
      String(state),
    ) ||
    typeof engineReady !== "boolean"
  ) {
    return null;
  }

  if (activeProvider === "spotify") {
    return state === "ready" && engineReady;
  }
  if (activeProvider === "apple_music") return false;

  const providers = objectRecord(providerStatusValue);
  const selected = providers ? objectRecord(providers[String(activeProvider)]) : null;
  if (!selected || typeof selected.state !== "string") return null;

  const acceptedStates =
    activeProvider === "youtube_music"
      ? ["not_connected", "pairing", "connected", "error"]
      : ["not_configured", "not_connected", "connecting", "connected", "error"];
  return acceptedStates.includes(selected.state)
    ? selected.state === "connected"
    : null;
}

/**
 * `Settings.Global` activation state, read over ADB, never written from here.
 *
 * `penumbra_cosmos_remote_mode=1` is the commit gate the on-device activation
 * transaction writes LAST, so reading it is the honest answer to "is this Pin
 * pointed at our stack".
 */
export interface PinSetupActivationFacts {
  readonly state: "unknown" | "checking" | "active" | "inactive" | "unreadable";
  /** Where the Pin is pointed, read off the device. */
  readonly edgeIpv4: string | null;
  /** Whether this Center has a usable, absent, or malformed edge declaration. */
  readonly expectedEdgeState:
    | "unknown"
    | "checking"
    | "available"
    | "absent"
    | "invalid"
    | "unreadable";
  /**
   * Where it SHOULD be pointed for this deployment, from /api/pin/edge.
   * `null` means the deployment has not declared one, so no claim can be made,
   * which the flow says out loud rather than assuming the two agree.
   */
  readonly expectedEdgeIpv4: string | null;
  readonly detail: string | null;
}

export type DeviceEdgeDeclaration =
  | { readonly state: "available"; readonly edgeIpv4: string }
  | { readonly state: "absent"; readonly edgeIpv4: null }
  | { readonly state: "invalid"; readonly edgeIpv4: null; readonly detail: string };

/** Parse one canonical dotted-decimal IPv4 address, with no octal-like padding. */
export function parseDeviceEdgeDeclaration(value: string | undefined): DeviceEdgeDeclaration {
  const declared = value?.trim() ?? "";
  if (declared === "") return { state: "absent", edgeIpv4: null };

  const octets = declared.split(".");
  const canonical =
    octets.length === 4 &&
    octets.every(
      (octet) =>
        /^(?:0|[1-9][0-9]{0,2})$/.test(octet) &&
        Number(octet) >= 0 &&
        Number(octet) <= 255,
    );
  if (!canonical) {
    return {
      state: "invalid",
      edgeIpv4: null,
      detail: "LUMA_DEVICE_EDGE_IPV4 must be one canonical dotted-decimal IPv4 address.",
    };
  }
  return { state: "available", edgeIpv4: declared };
}

/** What this Center's backend knows about the wearer's Pins. */
export interface PinSetupCloudFacts {
  /** `absent` means nothing is configured to answer, not "you have none". */
  readonly state: "unknown" | "live" | "degraded" | "absent";
  readonly pairedCount: number | null;
  /** Paired Pins that have reported recently enough to count as online. */
  readonly reportingCount: number;
  readonly lastReportAtEpoch: number | null;
  /** A recent status whose serial matches the Pin currently attached over USB. */
  readonly connectedPinReporting: boolean;
  readonly connectedPinLastReportAtEpoch: number | null;
  /** Exact device-id match against this account's pairing roster. */
  readonly connectedPinPaired: boolean | null;
}

/**
 * Center's remote link to the Pin (the Iroh bridge), from `GET /api/pin/bridge`.
 *
 *   unknown      not read yet
 *   assigned     the link reaches the Pin attached over USB
 *   elsewhere    the link reaches another Pin paired with this account (one
 *                link per server, so turning it on here would move it)
 *   unassigned   the link answers but reaches no Pin, or one that was
 *                released or replaced
 *   unavailable  this server has no remote link, or it could not be read
 *
 * Pairing with Cosmos does not set this up: only Provisioning's activation and
 * Guided setup's "Turn on remote access" do, over USB.
 */
export interface PinSetupRemoteFacts {
  readonly state: "unknown" | "assigned" | "elsewhere" | "unassigned" | "unavailable";
}

/**
 * The Pin's own first-run setup, read from
 * `Settings.Global humane.settings.global.DUC_PROVISIONED`.
 *
 * Stock onboarding writes it as its very last act, after the passcode
 * ceremony, and never runs again once it is set. A Pin that finished Humane's
 * setup years ago therefore skips its welcome screens and keeps the passcode it
 * already unlocks with.
 */
export interface PinSetupOnboardingFacts {
  /** `null` while unread. */
  readonly setupComplete: boolean | null;
}

/** Whether the signed-in owner set the passcode a Pin asks for during setup. */
export interface PinSetupPasscodeFacts {
  readonly state: "unknown" | "set" | "not-set" | "unreadable";
}

export interface PinSetupFacts {
  readonly usb: PinSetupUsbFacts;
  readonly network: PinSetupNetworkFacts;
  readonly release: PinSetupReleaseFacts;
  readonly install: PinSetupInstallFacts;
  readonly server: PinSetupServerFacts;
  readonly activation: PinSetupActivationFacts;
  readonly cloud: PinSetupCloudFacts;
  readonly remote: PinSetupRemoteFacts;
  readonly onboarding: PinSetupOnboardingFacts;
  readonly passcode: PinSetupPasscodeFacts;
  /** Explicit wearer confirmation after trying microphone, speaker, and gesture. */
  readonly physicalAcceptanceConfirmed: boolean;
  /** Whether the signed-in session carries the operator claim. */
  readonly operator: boolean;
}

export interface PinSetupStep {
  readonly id: PinSetupStepId;
  /** 1-based position, for the numbered rail. */
  readonly ordinal: number;
  /** The owner-facing stage title, from the contract. */
  readonly title: string;
  /** What the stage is for, from the contract. Shown while it waits. */
  readonly description: string;
  /** The CLI equivalent, when one exists. */
  readonly commandId: GeneratedPinSetupStep["commandId"];
  readonly command: GeneratedPinSetupStep["command"];
  readonly centerRoute: string | null;
  readonly verification: GeneratedPinSetupStep["verification"];
  readonly status: PinSetupStepStatus;
  /** What is true right now, in one sentence. Never a prediction. */
  readonly summary: string;
  /** What to do next, when there is something to do. */
  readonly next: string | null;
  /** Commands that must be run on the server. Empty when there are none. */
  readonly commands: readonly string[];
}

export interface PinSetupPlan {
  readonly steps: readonly PinSetupStep[];
  /** The first step that is neither done, blocked, nor unobservable. */
  readonly focusStepId: PinSetupStepId | null;
  readonly doneCount: number;
  readonly total: number;
}

interface DraftStep {
  readonly status: PinSetupStepStatus;
  readonly summary: string;
  readonly next?: string | null;
  readonly commands?: readonly string[];
}

/** Capabilities that must be ready before a Pin can answer a question. */
export const PIN_SETUP_REQUIRED_CAPABILITIES = PIN_SETUP_CAPABILITIES.filter(
  (capability) => capability.required,
);

function formatList(values: readonly string[]): string {
  if (values.length < 2) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function deriveConnect(usb: PinSetupUsbFacts): DraftStep {
  if (usb.browserSupported === false) {
    return {
      status: "attention",
      summary: "This browser cannot reach a Pin over USB.",
      next: "Use desktop Chrome or Edge over HTTPS, or on localhost.",
    };
  }

  if (usb.connected && usb.recognizedAiPin === false) {
    return {
      status: "attention",
      summary: "A device is attached, but it does not identify as an Ai Pin.",
      next: "Disconnect it. Luma supports Ai Pin hardware only.",
    };
  }

  if (usb.connected) {
    return {
      status: "done",
      summary: usb.serial
        ? `Connected over USB · ${usb.serial}`
        : "Connected over USB.",
    };
  }

  if (usb.connecting) {
    return { status: "todo", summary: "Choose your Pin in the USB prompt." };
  }

  return {
    status: "todo",
    summary: "No Pin is connected.",
    next: "Place the Pin on a USB interposer, then choose it in the USB prompt.",
  };
}

function deriveNetwork(facts: PinSetupFacts): DraftStep {
  const { usb, network } = facts;
  if (!usb.connected) {
    return { status: "blocked", summary: "Connect the Pin over USB to check its network and clock." };
  }
  if (network.state === "unknown" || network.state === "checking") {
    return { status: "todo", summary: "Checking the Pin’s network and clock…" };
  }
  if (network.state === "unreadable") {
    return {
      status: "attention",
      summary: network.detail ?? "Center couldn’t read the Pin’s network.",
      next: "Wait for the Pin to finish starting, then choose Check again.",
    };
  }

  const clockWrong =
    network.clockSkewMs !== null && Math.abs(network.clockSkewMs) > CLOCK_TOLERANCE_MS;
  const clock =
    clockWrong && network.pinTimeEpochMs !== null
      ? describeClockSkew(network.clockSkewMs!, network.pinTimeEpochMs)
      : null;

  if (!network.online) {
    const clockNote = clock
      ? ` Its clock is ${clock}. That corrects itself once the Pin is online.`
      : "";
    return network.wifiEnabled === false
      ? {
          status: "todo",
          summary: `Wi-Fi is off on this Pin.${clockNote}`,
          next: "Turn on Wi-Fi, then choose your network.",
        }
      : {
          status: "todo",
          summary: `This Pin is not online.${clockNote}`,
          next: "Choose the Wi-Fi network your Pin should use.",
        };
  }

  if (network.clockSkewMs === null) {
    return { status: "todo", summary: "Checking the Pin’s clock…" };
  }
  if (clock) {
    return {
      status: "attention",
      summary: `This Pin is online, but its clock is ${clock}.`,
      next: "Let Center set the Pin’s clock.",
    };
  }

  const via =
    network.transport === "cellular"
      ? "over mobile data"
      : network.wifiNetwork
        ? `on ${network.wifiNetwork}`
        : "over Wi-Fi";
  return { status: "done", summary: `Online ${via}, and the clock is right.` };
}

function deriveInstall(facts: PinSetupFacts): DraftStep {
  const { usb, release, install } = facts;

  // A missing or refused release is fixed on the server, not on the Pin, so it
  // is named first and with the exact command.
  if (release.availability === "not-published") {
    return {
      status: "manual",
      summary: "Your server has no Pin release to install yet.",
      next: "On the server, stage the Pin archive that came with this Luma release. For a release published on GitHub with its signed SHA256SUMS, leave out --archive and the server downloads it.",
      commands: ["./luma pin release acquire --archive luma-pin-VERSION.tar.gz"],
    };
  }
  if (release.availability === "unreadable") {
    return {
      status: "attention",
      summary: release.detail
        ? `Center couldn’t verify the server’s Pin release: ${release.detail}`
        : "Center couldn’t verify the server’s Pin release.",
      next: "Run the release check on the server before changing anything.",
      commands: ["./luma pin release acquire --check"],
    };
  }

  if (!usb.connected) {
    return { status: "blocked", summary: "Connect the Pin over USB to install." };
  }

  if (release.availability !== "published") {
    return { status: "todo", summary: "Checking the published release…" };
  }

  if (install.state === "failed") {
    return {
      status: "attention",
      summary: install.detail
        ? `Center couldn’t inspect this Pin: ${install.detail}`
        : "Center couldn’t inspect this Pin.",
      next: "Reconnect the Pin or wait for Android to finish starting, then choose Check again.",
    };
  }

  if (install.state !== "read") {
    return { status: "todo", summary: "Inspecting the Pin…" };
  }

  if (install.runtimeRolesNewerThanTarget > 0) {
    return {
      status: "manual",
      summary: `This Pin runs newer Luma software than your server’s release${release.version ? ` ${release.version}` : ""}.`,
      next: "Update the server to the Luma release that matches this Pin. The installer never downgrades a Pin on its own.",
      commands: ["./luma pin release acquire --check"],
    };
  }

  if (install.conflicts > 0) {
    return {
      status: "attention",
      summary: `${install.conflicts} known conflicting app${install.conflicts === 1 ? "" : "s"} must be removed before installing.`,
      next: "The installer can remove them and continue in one action.",
    };
  }

  if (install.rolesInstalled === 0) {
    return {
      status: "todo",
      summary: "Luma is not installed on this Pin.",
      next: "Open the installer. Keep the Pin unlocked and on the cable while it restarts.",
    };
  }

  if (install.installerState === "unsupported") {
    return {
      status: "attention",
      summary: "The Device Installer is not ready for routine software updates.",
      next: "Open the installer to see the recovery options for this Pin.",
    };
  }

  const rolesSatisfied =
    install.rolesMatchingTarget + (install.installerState === "retained" ? 1 : 0);
  if (
    install.rolesInstalled < install.rolesTotal ||
    install.unhealthyRoles > 0 ||
    rolesSatisfied < install.rolesTotal
  ) {
    return {
      status: "attention",
      summary: `${install.rolesMatchingTarget} of ${install.rolesTotal} Luma apps match the published release${
        install.unhealthyRoles > 0
          ? `, and ${install.unhealthyRoles} installed app${install.unhealthyRoles === 1 ? " is" : "s are"} not answering`
          : ""
      }.`,
      next: "Open the installer to update them.",
    };
  }

  return {
    status: "done",
    summary: release.version
      ? `Luma ${release.version} is installed.`
      : "The published Luma release is installed.",
  };
}

function deriveServices(facts: PinSetupFacts): DraftStep {
  const { usb, server, install, operator } = facts;

  if (!usb.connected) {
    return { status: "blocked", summary: "Connect the Pin over USB to check its services." };
  }
  if (server.answering === "checking" || server.answering === "unknown") {
    return { status: "todo", summary: "Checking whether Luma answers on the Pin…" };
  }
  if (server.answering === "offline") {
    const installed = install.state === "read" && install.rolesInstalled > 0;
    return installed
      ? { status: "attention", summary: "Luma is installed but not responding.", next: "Open the installer to repair it." }
      : { status: "blocked", summary: "Install Luma first." };
  }

  const required = PIN_SETUP_REQUIRED_CAPABILITIES;
  const unread = required.filter(({ id }) => server.capabilities[id] === null).map(({ label }) => label);
  if (unread.length > 0) {
    return { status: "todo", summary: `Checking ${formatList(unread)}…` };
  }

  const missing = required.filter(({ id }) => server.capabilities[id] === false).map(({ label }) => label);
  if (missing.length > 0) {
    return operator
      ? {
          status: "todo",
          summary: `${formatList(missing)} ${missing.length === 1 ? "needs" : "need"} setting up.`,
          next: "Set them up in Settings → Assistant & voice. Everything else there is optional.",
        }
      : {
          status: "manual",
          summary: `${formatList(missing)} ${missing.length === 1 ? "needs" : "need"} setting up by this Center’s operator.`,
          next: `Ask this Center’s operator to set up ${formatList(missing)}.`,
        };
  }

  return {
    status: "done",
    summary: `The assistant and speech are ready${server.assistantModel ? ` (${server.assistantModel})` : ""}.`,
  };
}

function deriveActivate(facts: PinSetupFacts): DraftStep {
  const { usb, activation, cloud, operator } = facts;
  const connectHere = operator
    ? "Open Provisioning and choose Connect this Pin to Cosmos."
    : "Ask this Center’s operator to connect this Pin.";

  if (!usb.connected) {
    return { status: "blocked", summary: "Connect the Pin over USB to check its connection to your Luma." };
  }
  if (activation.state === "checking" || activation.state === "unknown") {
    return { status: "todo", summary: "Checking whether this Pin is connected to your Luma…" };
  }
  if (activation.state === "unreadable") {
    return {
      status: "attention",
      summary: activation.detail
        ? `Center couldn’t read the Pin’s connection: ${activation.detail}`
        : "Center couldn’t read the Pin’s connection.",
      next: "Choose Check again.",
    };
  }
  if (activation.state === "inactive") {
    // A Pin still in its own setup asks for the passcode as soon as it
    // connects, so an owner without one chooses it first.
    const passcodeFirst =
      facts.onboarding.setupComplete === false && facts.passcode.state === "not-set";
    return {
      status: operator ? "todo" : "manual",
      summary: "This Pin is not connected to your Luma yet.",
      next: passcodeFirst
        ? `First choose your Pin passcode in Settings → Passcode & password: your Pin asks for it as soon as it connects. Then: ${connectHere}`
        : connectHere,
    };
  }

  // `penumbra_cosmos_remote_mode=1` says the Pin is pointed at SOME server. It
  // does not say it is pointed at this one. Reporting done on that alone would
  // tell a newcomer the step was finished while their captures went to an
  // address they may not control.
  if (!activation.edgeIpv4) {
    return {
      status: "attention",
      summary: "The Pin’s connection is incomplete: it has no server address.",
      next: connectHere,
    };
  }
  if (activation.expectedEdgeState === "checking" || activation.expectedEdgeState === "unknown") {
    return { status: "todo", summary: `The Pin points at ${activation.edgeIpv4}. Checking your server…` };
  }
  if (activation.expectedEdgeState === "invalid") {
    return {
      status: "attention",
      summary: `The Pin points at ${activation.edgeIpv4}, but Center’s edge setting is invalid.`,
      next: "Set LUMA_DEVICE_EDGE_IPV4 to one IPv4 address.",
    };
  }
  if (activation.expectedEdgeState === "unreadable") {
    return {
      status: "attention",
      summary: `The Pin points at ${activation.edgeIpv4}, but Center’s edge setting couldn’t be read.`,
      next: "Check Center’s environment and try again.",
    };
  }
  if (activation.expectedEdgeState === "absent" || activation.expectedEdgeIpv4 === null) {
    return {
      status: "attention",
      summary: `The Pin points at ${activation.edgeIpv4}, but Center has no edge address to compare.`,
      next: "Set LUMA_DEVICE_EDGE_IPV4 to this server’s public IPv4 address.",
    };
  }
  if (activation.expectedEdgeIpv4 !== activation.edgeIpv4) {
    return {
      status: "attention",
      summary: `The Pin points at ${activation.edgeIpv4}, not at your server (${activation.expectedEdgeIpv4}).`,
      next: connectHere,
    };
  }

  // Activation pairs the Pin with the signed-in account. An unpaired Pin is
  // still offered a one-click pairing rather than a second activation.
  if (cloud.state === "absent") {
    return {
      status: "attention",
      summary: "Pin pairing is not configured for this Center.",
      next: "Finish the Cosmos device connection setup, then try again.",
    };
  }
  if (cloud.state === "degraded") {
    return {
      status: "attention",
      summary: "Center couldn’t check this Pin’s pairing just now.",
      next: "Check the Cosmos connection, then try again.",
    };
  }
  if (cloud.state === "unknown" || cloud.connectedPinPaired === null) {
    return { status: "todo", summary: "Checking that this Pin is paired with your account…" };
  }
  if (!cloud.connectedPinPaired) {
    return {
      status: "todo",
      summary: `The Pin points at your server, but it is not paired with your account.`,
      next: "Pair this Pin.",
    };
  }
  // A paired Pin is still unreachable without the cable until Center's remote
  // link points at it. A server without that link does not hold setup back.
  if (facts.remote.state === "unknown") {
    return { status: "todo", summary: "Checking remote access to this Pin…" };
  }
  if (facts.remote.state === "unassigned") {
    return {
      status: "todo",
      summary: `Connected to your Luma at ${activation.edgeIpv4} and paired with your account. Center can’t reach it without the cable yet.`,
      next: "Turn on remote access.",
    };
  }
  return {
    status: "done",
    summary: facts.remote.state === "elsewhere"
      ? `Connected to your Luma at ${activation.edgeIpv4} and paired with your account. Remote access stays with your other Pin.`
      : `Connected to your Luma at ${activation.edgeIpv4} and paired with your account.`,
  };
}

function derivePasscode(facts: PinSetupFacts): DraftStep {
  const { usb, onboarding, passcode, activation } = facts;

  if (!usb.connected) {
    return { status: "blocked", summary: "Connect the Pin over USB to check its own setup." };
  }
  if (onboarding.setupComplete === null) {
    return { status: "todo", summary: "Checking the Pin’s own setup…" };
  }
  // Stock onboarding never runs again once it has finished, whether it finished
  // with Humane or with your Luma, and the Pin keeps the lock passcode it has.
  if (onboarding.setupComplete) {
    return {
      status: "done",
      summary: "This Pin has finished its own setup and unlocks with the passcode it already has.",
    };
  }

  if (passcode.state === "unknown") {
    return { status: "todo", summary: "Checking your Pin passcode…" };
  }
  if (passcode.state === "unreadable") {
    return {
      status: "attention",
      summary: "Center couldn’t check whether your Pin passcode is set.",
      next: "Open your passcode settings and check it there.",
    };
  }
  if (passcode.state === "not-set") {
    return {
      status: "todo",
      summary: "You haven’t chosen a Pin passcode yet.",
      next: "Choose four digits. Your Pin asks for them during its own setup and then uses them to unlock.",
    };
  }
  if (activation.state !== "active") {
    return {
      status: "blocked",
      summary: "Your passcode is set. Your Pin asks for it after it connects to your Luma.",
    };
  }
  return {
    status: "todo",
    summary: "Your passcode is set. This Pin still needs to finish its own setup.",
    next: "Re-enter the same four digits here. This browser sends this copy directly to this Pin over USB and clears the field.",
  };
}

function deriveConfirm(facts: PinSetupFacts): DraftStep {
  if (facts.physicalAcceptanceConfirmed) {
    return {
      status: "done",
      summary: "You confirmed the microphone, speaker, and gesture on this Pin.",
    };
  }
  const { cloud } = facts;
  const evidence = cloud.connectedPinReporting
    ? "This Pin is reporting to your Luma."
    : "This Pin hasn’t reported to your Luma yet. Its first report can take a minute.";
  return {
    status: "manual",
    summary: `${evidence} Test the microphone, speaker, and gesture.`,
    next: "Hold the touchpad, ask a question, and confirm here once the Pin answers.",
  };
}

const DERIVATIONS: Readonly<
  Record<PinSetupStepId, (facts: PinSetupFacts) => DraftStep>
> = Object.freeze({
  connect: (facts) => deriveConnect(facts.usb),
  network: deriveNetwork,
  install: deriveInstall,
  services: deriveServices,
  activate: deriveActivate,
  passcode: derivePasscode,
  confirm: deriveConfirm,
});

export function derivePinSetupPlan(facts: PinSetupFacts): PinSetupPlan {
  const steps = PIN_SETUP_JOURNEY.steps.map((definition, index): PinSetupStep => {
    const draft = DERIVATIONS[definition.id](facts);
    return {
      id: definition.id,
      ordinal: index + 1,
      title: definition.title,
      description: definition.summary,
      commandId: definition.commandId,
      command: definition.command,
      centerRoute: definition.centerRoute,
      verification: definition.verification,
      status: draft.status,
      summary: draft.summary,
      next: draft.next ?? null,
      commands: draft.commands ?? [],
    };
  });

  const focus = steps.find(
    (step) =>
      step.status !== "done" &&
      step.status !== "blocked" &&
      step.status !== "unobservable",
  );

  return {
    steps,
    focusStepId: focus?.id ?? null,
    doneCount: steps.filter((step) => step.status === "done").length,
    total: steps.length,
  };
}
