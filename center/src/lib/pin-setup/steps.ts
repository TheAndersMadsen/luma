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
  readonly unhealthyRoles: number;
  readonly conflicts: number;
  /** Credential-encrypted storage. `null` when it was not read. */
  readonly deviceLocked: boolean | null;
  readonly detail: string | null;
}

/** The Revival server on the Pin, over the same USB session. */
export interface PinSetupServerFacts {
  readonly answering: "unknown" | "checking" | "online" | "offline";
  readonly assistantProvider: string | null;
  readonly assistantModel: string | null;
  /** Whether the device holds an assistant API key. `null` until settings load. */
  readonly assistantKeyPresent: boolean | null;
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
}

export interface PinSetupFacts {
  readonly usb: PinSetupUsbFacts;
  readonly release: PinSetupReleaseFacts;
  readonly install: PinSetupInstallFacts;
  readonly server: PinSetupServerFacts;
  readonly activation: PinSetupActivationFacts;
  readonly cloud: PinSetupCloudFacts;
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
      next: "Open Center in a desktop Chromium browser, over HTTPS or on localhost. WebUSB is a browser capability, so no command replaces it.",
    };
  }

  if (usb.connected && usb.recognizedAiPin === false) {
    return {
      status: "attention",
      summary: "A device is attached, but it does not identify as an Ai Pin.",
      next: "Disconnect it. Installing Revival software on another device is not supported and can leave it unusable.",
    };
  }

  if (usb.connected) {
    return {
      status: "done",
      summary: usb.serial
        ? `A Pin is attached to this browser over USB (serial ${usb.serial}).`
        : "A Pin is attached to this browser over USB.",
      next: null,
    };
  }

  if (usb.connecting) {
    return { status: "todo", summary: "Waiting for the browser's device picker.", next: null };
  }

  return {
    status: "todo",
    summary: "No Pin is attached to this browser.",
    next: "Plug the Pin into this computer with a USB-C cable, then choose it in the browser's device picker.",
  };
}

function deriveRelease(release: PinSetupReleaseFacts): DraftStep {
  switch (release.availability) {
    case "published":
      return {
        status: "done",
        summary: release.version
          ? `Signed release ${release.version} is imported; Center verified its manifest.`
          : "A signed release exists; Center verified its published manifest.",
        next: null,
      };
    case "checking":
      return {
        status: "todo",
        summary: "Checking the signed release store mounted by this Center…",
        next: null,
      };
    case "not-published":
      return {
        status: "manual",
        summary:
          "Center has no signed Pin release in its release store.",
        next: "Download the signed Pin archive from GitHub Releases, then import it with the command below.",
        manualNote:
          "The import verifies every APK and makes the complete release current atomically.",
      };
    case "unreadable":
      return {
        status: "attention",
        summary: release.detail
          ? `Center could not verify the imported release: ${release.detail}`
          : "Center could not verify the imported release.",
        next: "Download the signed archive again and re-import it.",
      };
    default:
      return {
        status: "todo",
        summary: "Whether a signed release exists has not been established yet.",
        next: null,
      };
  }
}

function deriveInstall(facts: PinSetupFacts): DraftStep {
  const { usb, release, install } = facts;

  if (!usb.connected) {
    return {
      status: "blocked",
      summary: "Installing needs the Pin attached over USB.",
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
        ? "Waiting to hear which release this Center serves."
        : "There is no verified release to install.",
      next: stillChecking
        ? null
        : "Publish a release first — the installer resolves its target from this Center and refuses anything it cannot verify.",
    };
  }

  if (install.state !== "read") {
    return {
      status: "blocked",
      summary: "The Pin has not been read yet, so there is nothing to compare against the release.",
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
      summary: "None of the Revival packages are on this Pin yet.",
      next: "Run the installer: it downloads the release, checks every artifact's SHA-256, and installs the roles.",
    };
  }

  if (
    install.rolesInstalled < install.rolesTotal ||
    install.unhealthyRoles > 0 ||
    install.rolesMatchingTarget < install.rolesTotal
  ) {
    return {
      status: "attention",
      summary: `${install.rolesMatchingTarget} of ${install.rolesTotal} packages match the published release${
        install.unhealthyRoles > 0
          ? `, and ${install.unhealthyRoles} installed package${install.unhealthyRoles === 1 ? " is" : "s are"} not answering`
          : ""
      }.`,
      next: "Run the installer to bring every role to the published version.",
    };
  }

  return {
    status: "done",
    summary: `All ${install.rolesTotal} packages are installed, answering, and match the published release.`,
    next: null,
  };
}

function deriveConfigure(facts: PinSetupFacts): DraftStep {
  const { usb, server, install } = facts;

  if (!usb.connected) {
    return { status: "blocked", summary: "Configuration is read from the Pin itself over USB.", next: null };
  }

  if (server.answering === "checking") {
    return { status: "todo", summary: "Checking whether the Pin's server answers…", next: null };
  }

  if (server.answering === "unknown") {
    return {
      status: "todo",
      summary: "Whether the Pin runs a Revival server has not been established yet.",
      next: null,
    };
  }

  if (server.answering === "offline") {
    const installed = install.state === "read" && install.rolesInstalled > 0;
    return {
      status: installed ? "attention" : "blocked",
      summary: installed
        ? "The Revival packages are installed, but the Pin's server is not answering over USB."
        : "The Pin is not running a Revival server yet, which is expected before the software is installed.",
      next: installed
        ? "Reinstall or repair the software, then come back — every setting on this page is read from that server."
        : null,
    };
  }

  if (server.assistantKeyPresent === null) {
    return { status: "todo", summary: "Reading the Pin's settings…", next: null };
  }

  if (!server.assistantKeyPresent) {
    return {
      status: "todo",
      summary: server.assistantProvider
        ? `The assistant is set to ${server.assistantProvider}${server.assistantModel ? ` · ${server.assistantModel}` : ""}, but the Pin holds no API key for it.`
        : "The Pin's server is answering, but no assistant provider is configured.",
      next: "Choose a provider and give the Pin its API key. Service keys — maps, places, speech — are optional and live beside it.",
    };
  }

  return {
    status: "done",
    summary: `The Pin answers over USB and its assistant is configured${
      server.assistantProvider
        ? ` (${server.assistantProvider}${server.assistantModel ? ` · ${server.assistantModel}` : ""})`
        : ""
    }.`,
    next: null,
  };
}

/** The one warning that is true of the minted bundle in every branch below. */
const IDENTITY_CREDENTIAL_NOTE =
  "The private key is issued once and never stored anywhere. Treat the response as credential material: it is the device's identity.";

function deriveIdentity(facts: PinSetupFacts): DraftStep {
  const { activation, operator } = facts;

  // Activation enables remote mode only after AndroidKeyStore accepts the
  // minted key and certificate chain, so active mode proves identity import.
  if (activation.state === "active") {
    return {
      status: "done",
      summary:
        "This Pin holds an imported device identity: activation turns clone mode on only after a minted certificate and key are validated and installed, so a credential was issued for this device.",
      next: null,
    };
  }

  /*
   * Not proven. This is not a no-op — it is a mandatory step Center cannot check
   * for you, so it says exactly that and points at the one place it is done.
   * For an operator that place is a console in this browser (the Provisioning
   * card), so the honest status is a to-do with a real link; for anyone else the
   * card is gated away, so it is work that happens outside this session.
   */
  if (operator) {
    return {
      status: "todo",
      summary:
        "Center cannot confirm whether this Pin has a credential — the bundle is shown once and never stored, and this Pin is not activated, so there is nothing to read back. Mint one if you have not.",
      next: "Open the operator console and use the Provisioning card. It returns the device id, certificate, private key, CA certificate and enrolment pincode — once. Keep the bundle: activation needs it.",
      manualNote: IDENTITY_CREDENTIAL_NOTE,
    };
  }

  return {
    status: "manual",
    summary:
      "Center cannot confirm whether this Pin has a credential, and this session cannot mint one — the Provisioning card is behind the operator gate, which this session does not contain.",
    next: "Ask an operator to mint a device credential. From the operator console's Provisioning card it returns the device id, certificate, private key, CA certificate and enrolment pincode — once.",
    manualNote: IDENTITY_CREDENTIAL_NOTE,
  };
}

function deriveActivate(facts: PinSetupFacts): DraftStep {
  const { usb, activation } = facts;

  if (!usb.connected) {
    return {
      status: "blocked",
      summary: "Whether the Pin is pointed at this server is read from the device over USB.",
      next: null,
    };
  }

  if (activation.state === "checking") {
    return { status: "todo", summary: "Reading clone mode from the device…", next: null };
  }

  if (activation.state === "unknown") {
    return { status: "todo", summary: "Clone mode has not been read from this Pin yet.", next: null };
  }

  if (activation.state === "unreadable") {
    return {
      status: "attention",
      summary: activation.detail
        ? `Clone mode could not be read: ${activation.detail}`
        : "Clone mode could not be read from the device.",
      next: null,
    };
  }

  if (activation.state === "active") {
    if (!activation.edgeIpv4) {
      return {
        status: "manual",
        summary:
          "Clone mode is on, but no edge address is set — the hook has nothing to resolve the stock hostnames to.",
        next: "Re-run activation with the edge IPv4 in the bundle; clone mode without an address leaves every hook inert.",
      };
    }
    // `penumbra_cosmos_remote_mode=1` says the Pin is pointed at SOME server; it
    // does not say it is pointed at this one. Reporting done on that alone told
    // a newcomer the step was finished while their captures went to an address
    // they may not control — the worst thing a setup flow can get wrong.
    if (activation.expectedEdgeState === "checking" || activation.expectedEdgeState === "unknown") {
      return {
        status: "todo",
        summary: `Clone mode is on and the Pin resolves stock Humane hostnames to ${activation.edgeIpv4}; Center is still checking its own declared edge address.`,
        next: null,
      };
    }
    if (activation.expectedEdgeState === "invalid") {
      return {
        status: "attention",
        summary: `Clone mode is on and the Pin resolves stock Humane hostnames to ${activation.edgeIpv4}, but this deployment's REVIVAL_DEVICE_EDGE_IPV4 value is invalid.`,
        next: "Set REVIVAL_DEVICE_EDGE_IPV4 to one canonical IPv4 address. Center will not treat malformed configuration as an absent declaration.",
      };
    }
    if (activation.expectedEdgeState === "unreadable") {
      return {
        status: "attention",
        summary: `Clone mode is on and the Pin resolves stock Humane hostnames to ${activation.edgeIpv4}, but Center could not read its expected edge declaration.`,
        next: "Check Center's setup endpoint, then read this step again. The Pin's address cannot be accepted without an independent deployment value.",
      };
    }
    if (activation.expectedEdgeState === "absent" || activation.expectedEdgeIpv4 === null) {
      return {
        status: "attention",
        summary: `Clone mode is on: the Pin resolves the stock Humane hostnames to ${activation.edgeIpv4}. This deployment has not declared its own edge address, so the dashboard cannot confirm that is this server.`,
        next: "Set REVIVAL_DEVICE_EDGE_IPV4 for Center to the address this deployment's device edge answers on, and this step will verify itself.",
      };
    }
    if (activation.expectedEdgeIpv4 !== activation.edgeIpv4) {
      return {
        status: "attention",
        summary: `Clone mode is on, but the Pin resolves the stock Humane hostnames to ${activation.edgeIpv4} — not this server (${activation.expectedEdgeIpv4}).`,
        next: "Re-run activation with this server's edge IPv4, or the Pin will keep sending its captures elsewhere.",
      };
    }
    return {
      status: "done",
      summary: `Clone mode is on: the Pin resolves the stock Humane hostnames to ${activation.edgeIpv4}, which is this server.`,
      next: null,
    };
  }

  return {
    status: "manual",
    summary: "Clone mode is off: this Pin is still talking to the original Humane cloud.",
    next: "Run the canonical activation command with the exact Pin serial, credential bundle, and edge IPv4.",
    manualNote:
      "Activation is a confirmed, exact-device mutation. The CLI uses the Pin's journalled transaction; never write the three Settings.Global keys by hand.",
  };
}

function deriveNetwork(cloud: PinSetupCloudFacts): DraftStep {
  if (cloud.state === "unknown") {
    return {
      status: "todo",
      summary: "Checking account-wide reports for supporting network context…",
      next: null,
    };
  }

  let context: string;
  if (cloud.state === "degraded") {
    context = "Center could not read the account-wide reporting context.";
  } else if (cloud.state === "absent") {
    context = "This deployment has no reporting service to provide account-wide context.";
  } else if (cloud.reportingCount > 0) {
    context = `${cloud.reportingCount} paired Pin${cloud.reportingCount === 1 ? " is" : "s are"} reporting somewhere on this account, but those reports do not identify the exact Pin attached here.`;
  } else {
    context = `${cloud.pairedCount ?? 0} Pin${cloud.pairedCount === 1 ? " is" : "s are"} paired, and none is currently reporting.`;
  }

  return {
    status: "manual",
    summary: `${context} The connected Pin's network path remains unverified.`,
    next: "Create the Wi-Fi QR code in this browser, scan it with the Pin, then run the exact-device network check.",
    manualNote:
      "The /wifi page creates the QR payload entirely in this browser. Center never receives or stores the network name or password, and account-wide reports are never accepted as exact-device proof.",
  };
}

function deriveConfirm(cloud: PinSetupCloudFacts): DraftStep {
  const onlineEvidence =
    cloud.state === "live" && cloud.reportingCount > 0
      ? `${cloud.reportingCount} paired Pin${cloud.reportingCount === 1 ? " is" : "s are"} reporting, so the software path is online.`
      : "Center does not currently have a live report proving the full software path is online.";
  return {
    status: "manual",
    summary: `${onlineEvidence} Physical gesture, microphone, speaker, and wearer-response acceptance are separate and are not recorded by this page.`,
    next: "On the physical Pin, trigger a known prompt and confirm the gesture, audible response, and expected action yourself.",
    manualNote:
      "Center never turns service health into a physical-pass claim and never saves a checkbox as substitute evidence. Re-run the CLI status check for software facts; perform physical acceptance on the device.",
  };
}

const DERIVATIONS: Readonly<
  Record<PinSetupStepId, (facts: PinSetupFacts) => DraftStep>
> = Object.freeze({
  connect: (facts) => deriveConnect(facts.usb),
  release: (facts) => deriveRelease(facts.release),
  install: deriveInstall,
  configure: deriveConfigure,
  identity: deriveIdentity,
  activate: deriveActivate,
  network: (facts) => deriveNetwork(facts.cloud),
  confirm: (facts) => deriveConfirm(facts.cloud),
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
