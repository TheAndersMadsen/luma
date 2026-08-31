/**
 * The guided setup plan: what it takes to get from a stock Ai Pin to a
 * provisioned one, in order, and what is ALREADY true about the Pin in front of
 * you.
 *
 * This module is the model, and it is deliberately framework-free: no React, no
 * Next, no `window`, no device access. It takes facts that somebody else read
 * (a USB session, a release manifest, a package inspection, `Settings.Global`,
 * the pairing roster) and answers one question per step — done, blocked, needs
 * attention, or not something Center can see at all.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a step is never marked done because the
 * step before it was. Every "done" here is backed by something that was
 * actually read from the device, the server, or the backend, and a step whose
 * state cannot be observed says so in those words rather than guessing. The
 * console this sits on top of already has a checklist's worth of panes; what it
 * did not have was an honest answer to "where am I, and what is next".
 *
 * Static titles, command paths, routes, and verification modes come from the
 * generated projection of `contracts/operator-setup.json`. Center owns only the
 * fact-based derivation below.
 */

import {
  PIN_SETUP_JOURNEY,
  type GeneratedPinSetupStep,
} from "./generated/journey";

export type PinSetupStepId = GeneratedPinSetupStep["id"];
export const PIN_SETUP_STEP_IDS = PIN_SETUP_JOURNEY.steps.map(
  (step) => step.id,
) as readonly PinSetupStepId[];

/**
 * Where a step stands.
 *
 *   done          evidence says this is finished
 *   todo          not finished, and it can be done here, now
 *   manual        not finished, and today it is done outside the browser — the
 *                 commands are named rather than a button being implied
 *   attention     something was read and it is wrong, or needs a decision
 *   blocked       an earlier step has to land first; nothing to do here yet
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
  /** How the privileged installer relates to the published runtime release. */
  readonly installerState: "unknown" | "target" | "retained" | "unsupported";
  /** Runtime roles that would have to be downgraded to match Center. */
  readonly runtimeRolesNewerThanTarget: number;
  readonly unhealthyRoles: number;
  readonly conflicts: number;
  /** Credential-encrypted storage. `null` when it was not read. */
  readonly deviceLocked: boolean | null;
  readonly detail: string | null;
}

/** The Revival server on the Pin, over the same USB session. */
export interface PinSetupServerFacts {
  readonly answering: "unknown" | "checking" | "online" | "offline";
  readonly assistantModel: string | null;
  /** Whether the Cosmos assistant is configured. `null` until Center reads it. */
  readonly assistantReady: boolean | null;
}

/**
 * `Settings.Global` clone mode — read over ADB, never written from here.
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
   * `null` means the deployment has not declared one, so no claim can be made —
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
      detail: "REVIVAL_DEVICE_EDGE_IPV4 must be one canonical dotted-decimal IPv4 address.",
    };
  }
  return { state: "available", edgeIpv4: declared };
}

/** What this Center's backend knows about the wearer's Pins. */
export interface PinSetupCloudFacts {
  /** `absent` means nothing is configured to answer — not "you have none". */
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

export interface PinSetupFacts {
  readonly usb: PinSetupUsbFacts;
  readonly release: PinSetupReleaseFacts;
  readonly install: PinSetupInstallFacts;
  readonly server: PinSetupServerFacts;
  readonly activation: PinSetupActivationFacts;
  readonly cloud: PinSetupCloudFacts;
  /** Explicit wearer confirmation after trying microphone, speaker, and gesture. */
  readonly physicalAcceptanceConfirmed: boolean;
  /** Whether the signed-in session carries the operator claim. */
  readonly operator: boolean;
}

export interface PinSetupStep {
  readonly id: PinSetupStepId;
  /** 1-based position, for the numbered rail. */
  readonly ordinal: number;
  readonly title: string;
  readonly commandId: GeneratedPinSetupStep["commandId"];
  readonly command: string;
  readonly centerRoute: string | null;
  readonly verification: GeneratedPinSetupStep["verification"];
  readonly status: PinSetupStepStatus;
  /** What is true right now, in one sentence. Never a prediction. */
  readonly summary: string;
  /** What to do next, when there is something to do. */
  readonly next: string | null;
  /** Commands that must be run outside Center. Empty when there are none. */
  readonly commands: readonly string[];
  /** Why this cannot be finished in the browser today. */
  readonly manualNote: string | null;
}

export interface PinSetupPlan {
  readonly steps: readonly PinSetupStep[];
  /** The first step that is neither done nor unobservable. */
  readonly focusStepId: PinSetupStepId | null;
  readonly doneCount: number;
  /** Steps whose state Center can actually read. The progress denominator. */
  readonly observableCount: number;
  readonly total: number;
}

interface DraftStep {
  readonly status: PinSetupStepStatus;
  readonly summary: string;
  readonly next?: string | null;
  readonly commands?: readonly string[];
  readonly manualNote?: string | null;
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
      next: "Disconnect it. Revival supports Ai Pin hardware only.",
    };
  }

  if (usb.connected) {
    return {
      status: "done",
      summary: usb.serial
        ? `Connected over USB · ${usb.serial}`
        : "Connected over USB.",
      next: null,
    };
  }

  if (usb.connecting) {
    return { status: "todo", summary: "Choose your Pin in the USB prompt.", next: null };
  }

  return {
    status: "todo",
    summary: "No Pin is connected.",
    next: "Connect the Pin with USB-C, then choose it in the USB prompt.",
  };
}

function deriveRelease(facts: PinSetupFacts): DraftStep {
  const { release, install } = facts;
  switch (release.availability) {
    case "published":
      if (install.state === "read" && install.runtimeRolesNewerThanTarget > 0) {
        return {
          status: "manual",
          summary: `This Pin runs newer runtime software than Center's published release${release.version ? ` ${release.version}` : ""}.`,
          next: "Use the operator release whose descriptor names this Pin release, or explicitly choose a supported device downgrade recovery.",
          commands: ["./revival pin release acquire --check"],
          manualNote: "The installer will not silently downgrade a newer Pin or mix it with another operator release.",
        };
      }
      return {
        status: "done",
        summary: release.version
          ? `Release ${release.version} is ready.`
          : "A signed release is ready.",
        next: null,
      };
    case "checking":
      return {
        status: "todo",
        summary: "Checking for a signed release…",
        next: null,
      };
    case "not-published":
      return {
        status: "manual",
        summary: "No signed Pin release is available.",
        next: "On the operator host, acquire the exact archive named by this release.",
        commands: ["./revival pin release acquire"],
        manualNote: "Acquisition verifies the descriptor, archive, signer receipts, and every APK before publishing.",
      };
    case "unreadable":
      return {
        status: "attention",
        summary: release.detail
          ? `Center could not verify the imported release: ${release.detail}`
          : "Center could not verify the imported release.",
        next: "Run the descriptor-bound release check on the operator host before changing anything.",
        commands: ["./revival pin release acquire --check"],
      };
    default:
      return {
        status: "todo",
        summary: "Release status has not been checked.",
        next: null,
      };
  }
}

function deriveInstall(facts: PinSetupFacts): DraftStep {
  const { usb, release, install } = facts;

  if (!usb.connected) {
    return {
      status: "blocked",
      summary: "Connect the Pin over USB to install.",
      next: null,
    };
  }

  if (release.availability !== "published") {
    // Only claim there is nothing to install once the release read has actually
    // come back negative. While it is still in flight, saying "no release" is
    // the same overclaim this flow exists to avoid — it just happens to be brief.
    const stillChecking =
      release.availability === "unknown" || release.availability === "checking";
    return {
      status: "blocked",
      summary: stillChecking
        ? "Checking the published release."
        : "There is no verified release to install.",
      next: stillChecking
        ? null
        : "Publish a verified release first.",
    };
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
    return {
      status: "blocked",
      summary: "Inspecting the Pin.",
      next: null,
    };
  }

  if (install.conflicts > 0) {
    return {
      status: "attention",
      summary: `${install.conflicts} known conflicting package${install.conflicts === 1 ? "" : "s"} must be removed before installing.`,
      next: "The installer can remove them and continue in one action.",
    };
  }

  if (install.rolesInstalled === 0) {
    return {
      status: "todo",
      summary: "Revival is not installed on this Pin.",
      next: "Open the installer.",
    };
  }

  if (install.runtimeRolesNewerThanTarget > 0) {
    return {
      status: "blocked",
      summary: "Publish the signed release already running on this Pin before changing its software.",
      next: null,
    };
  }

  if (install.installerState === "unsupported") {
    return {
      status: "attention",
      summary: "The privileged installer is not in a supported routine-install state.",
      next: "Open the installer to inspect the recovery options for this Pin.",
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
      summary: `${install.rolesMatchingTarget} of ${install.rolesTotal} packages match the published release${
        install.unhealthyRoles > 0
          ? `, and ${install.unhealthyRoles} installed package${install.unhealthyRoles === 1 ? " is" : "s are"} not answering`
          : ""
      }.`,
      next: "Open the installer to update the runtime packages.",
    };
  }

  if (install.installerState === "retained") {
    return {
      status: "done",
      summary: `All ${Math.max(0, install.rolesTotal - 1)} runtime packages match the published release; the healthy installer is intentionally retained.`,
      next: null,
    };
  }

  return {
    status: "done",
    summary: `All ${install.rolesTotal} packages match the published release.`,
    next: null,
  };
}

function deriveConfigure(facts: PinSetupFacts): DraftStep {
  const { usb, server, install, operator } = facts;

  if (!usb.connected) {
    return { status: "blocked", summary: "Connect the Pin over USB to check its setup.", next: null };
  }

  if (server.answering === "checking") {
    return { status: "todo", summary: "Checking whether the Pin's server answers…", next: null };
  }

  if (server.answering === "unknown") {
    return {
      status: "todo",
      summary: "Pin service status has not been checked.",
      next: null,
    };
  }

  if (server.answering === "offline") {
    const installed = install.state === "read" && install.rolesInstalled > 0;
    return {
      status: installed ? "attention" : "blocked",
      summary: installed
        ? "Revival is installed but not responding."
        : "Install Revival first.",
      next: installed
        ? "Repair or reinstall it."
        : null,
    };
  }

  if (server.assistantReady === null) {
    return { status: "todo", summary: "Checking Cosmos services…", next: null };
  }

  if (!server.assistantReady) {
    return operator
      ? {
          status: "todo",
          summary: "Cosmos Assistant needs setup.",
          next: "Configure Assistant in Settings → Services.",
        }
      : {
          status: "manual",
          summary: "Cosmos Assistant needs operator setup.",
          next: "Ask this Center’s operator to configure Assistant.",
          commands: [],
        };
  }

  return {
    status: "done",
    summary: `Pin and Cosmos are ready${
      server.assistantModel ? ` (${server.assistantModel})` : ""
    }.`,
    next: null,
  };
}

function deriveIdentity(facts: PinSetupFacts): DraftStep {
  const { activation, operator } = facts;

  // Activation enables remote mode only after AndroidKeyStore accepts the
  // minted key and certificate chain, so active mode proves identity import.
  if (activation.state === "active") {
    return {
      status: "done",
      summary: "Device identity is installed.",
      next: null,
    };
  }

  if (operator) {
    return {
      status: "todo",
      summary: "This Pin has not been activated.",
      next: "Open Provisioning and connect this Pin directly to Cosmos.",
    };
  }

  return {
    status: "manual",
    summary: "This Pin has not been activated.",
    next: "Ask an operator to connect this Pin to Cosmos.",
  };
}

function deriveActivate(facts: PinSetupFacts): DraftStep {
  const { usb, activation, operator } = facts;

  if (!usb.connected) {
    return {
      status: "blocked",
      summary: "Connect over USB to check activation.",
      next: null,
    };
  }

  if (activation.state === "checking") {
    return { status: "todo", summary: "Checking activation…", next: null };
  }

  if (activation.state === "unknown") {
    return { status: "todo", summary: "Activation has not been checked.", next: null };
  }

  if (activation.state === "unreadable") {
    return {
      status: "attention",
      summary: activation.detail
        ? `Couldn’t read activation: ${activation.detail}`
        : "Couldn’t read activation from the Pin.",
      next: null,
    };
  }

  if (activation.state === "active") {
    if (!activation.edgeIpv4) {
      return {
        status: "manual",
        summary: "Activation is incomplete: no edge address is set.",
        next: "Run activation again with the Cosmos edge IPv4.",
      };
    }
    // `penumbra_cosmos_remote_mode=1` says the Pin is pointed at SOME server; it
    // does not say it is pointed at this one. Reporting done on that alone told
    // a newcomer the step was finished while their captures went to an address
    // they may not control — the worst thing a setup flow can get wrong.
    if (activation.expectedEdgeState === "checking" || activation.expectedEdgeState === "unknown") {
      return {
        status: "todo",
        summary: `Pin edge: ${activation.edgeIpv4}. Checking Cosmos…`,
        next: null,
      };
    }
    if (activation.expectedEdgeState === "invalid") {
      return {
        status: "attention",
        summary: `Pin edge is ${activation.edgeIpv4}, but Center’s edge setting is invalid.`,
        next: "Set REVIVAL_DEVICE_EDGE_IPV4 to one IPv4 address.",
      };
    }
    if (activation.expectedEdgeState === "unreadable") {
      return {
        status: "attention",
        summary: `Pin edge is ${activation.edgeIpv4}, but Center’s edge setting couldn’t be read.`,
        next: "Check Center’s environment and try again.",
      };
    }
    if (activation.expectedEdgeState === "absent" || activation.expectedEdgeIpv4 === null) {
      return {
        status: "attention",
        summary: `Pin edge is ${activation.edgeIpv4}, but Center has no edge address to compare.`,
        next: "Set REVIVAL_DEVICE_EDGE_IPV4 to this Cosmos edge.",
      };
    }
    if (activation.expectedEdgeIpv4 !== activation.edgeIpv4) {
      return {
        status: "attention",
        summary: `Pin edge ${activation.edgeIpv4} does not match Cosmos ${activation.expectedEdgeIpv4}.`,
        next: "Run activation again with the Cosmos edge IPv4.",
      };
    }
    return {
      status: "done",
      summary: `Pin is connected to Cosmos at ${activation.edgeIpv4}.`,
      next: null,
    };
  }

  return operator
    ? {
        status: "todo",
        summary: "This Pin is not connected to Cosmos.",
        next: "Open Provisioning and connect this Pin directly to Cosmos.",
      }
    : {
        status: "manual",
        summary: "This Pin is not connected to Cosmos.",
        next: "Ask an operator to connect this Pin to Cosmos.",
      };
}

function deriveNetwork(cloud: PinSetupCloudFacts): DraftStep {
  if (cloud.connectedPinReporting) {
    return {
      status: "done",
      summary: "This Pin is online and reporting to Center.",
      next: null,
    };
  }

  if (cloud.state === "unknown") {
    return {
      status: "todo",
      summary: "Checking Pin reports…",
      next: null,
    };
  }

  if (cloud.state === "degraded") {
    return {
      status: "attention",
      summary: "Center couldn’t check this Pin because Pin reports are unavailable.",
      next: "Check the Cosmos reporting connection, then try again.",
    };
  }

  if (cloud.state === "absent") {
    return {
      status: "attention",
      summary: "Pin reporting is not configured for this Center.",
      next: "Finish the Cosmos device connection setup, then try again.",
    };
  }

  if (cloud.pairedCount === 0 || cloud.connectedPinPaired === false) {
    return {
      status: "todo",
      summary: "This Pin is not paired with this account.",
      next: "Pair this Pin with your account before checking its network.",
    };
  }

  if (cloud.connectedPinPaired === null) {
    return {
      status: "todo",
      summary: "Center is checking whether this exact Pin is paired.",
      next: null,
    };
  }

  const context = cloud.reportingCount > 0
    ? `${cloud.reportingCount} other paired Pin${cloud.reportingCount === 1 ? " is" : "s are"} reporting.`
    : "No paired Pin is reporting.";
  return {
    status: "manual",
    summary: `${context} This Pin still needs a network check.`,
    next: "Create the Wi-Fi QR code, scan it on the Pin, then run the network check.",
    manualNote: "Wi-Fi details stay in this browser.",
  };
}

function deriveConfirm(facts: PinSetupFacts): DraftStep {
  if (facts.physicalAcceptanceConfirmed) {
    return {
      status: "done",
      summary: "Microphone, speaker, and gesture were confirmed on this Pin.",
      next: null,
    };
  }
  const { cloud } = facts;
  const onlineEvidence =
    cloud.state === "live" && cloud.reportingCount > 0
      ? `${cloud.reportingCount} paired Pin${cloud.reportingCount === 1 ? " is" : "s are"} online.`
      : "No live Pin report is available.";
  return {
    status: "manual",
    summary: `${onlineEvidence} Test this Pin’s microphone, speaker, and gesture.`,
    next: "Make a voice request on the Pin and confirm the response.",
    manualNote: "Use the CLI status command for software checks.",
  };
}

const DERIVATIONS: Readonly<
  Record<PinSetupStepId, (facts: PinSetupFacts) => DraftStep>
> = Object.freeze({
  connect: (facts) => deriveConnect(facts.usb),
  release: deriveRelease,
  install: deriveInstall,
  configure: deriveConfigure,
  identity: deriveIdentity,
  activate: deriveActivate,
  network: (facts) => deriveNetwork(facts.cloud),
  confirm: deriveConfirm,
});

export function derivePinSetupPlan(facts: PinSetupFacts): PinSetupPlan {
  const steps = PIN_SETUP_JOURNEY.steps.map((definition, index): PinSetupStep => {
    const id = definition.id;
    const draft = DERIVATIONS[id](facts);
    const canonicalCommand =
      (draft.status === "manual" || draft.manualNote) && draft.commands === undefined
        ? [definition.command]
        : (draft.commands ?? []);
    return {
      id,
      ordinal: index + 1,
      title: definition.title,
      commandId: definition.commandId,
      command: definition.command,
      centerRoute: definition.centerRoute,
      verification: definition.verification,
      status: draft.status,
      summary: draft.summary,
      next: draft.next ?? null,
      commands: canonicalCommand,
      manualNote: draft.manualNote ?? null,
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
    // A step Center cannot observe is not counted as achievable progress; a
    // denominator that includes it would make "6 of 8" mean two different
    // things depending on which steps happened to be unreadable.
    observableCount: steps.filter((step) => step.status !== "unobservable").length,
    total: steps.length,
  };
}
