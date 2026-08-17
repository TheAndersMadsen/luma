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
 * The ceremony itself is the one written down in `docs/operations.md`
 * ("Onboarding a Pin"), including which of its steps have no console yet. Where
 * a step cannot be performed from a browser, `commands` carries the exact shell
 * commands and `manualNote` says why — the UI must not imply a button exists.
 */

export const PIN_SETUP_STEP_IDS = [
  "connect",
  "inspect",
  "release",
  "install",
  "configure",
  "identity",
  "activate",
  "confirm",
] as const;

export type PinSetupStepId = (typeof PIN_SETUP_STEP_IDS)[number];

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
 * `penumbra_carry_remote_mode=1` is the commit gate the on-device activation
 * transaction writes LAST, so reading it is the honest answer to "is this Pin
 * pointed at our stack".
 */
export interface PinSetupActivationFacts {
  readonly state: "unknown" | "checking" | "active" | "inactive" | "unreadable";
  /** Where the Pin is pointed, read off the device. */
  readonly edgeIpv4: string | null;
  /**
   * Where it SHOULD be pointed for this deployment, from /api/pin/edge.
   * `null` means the deployment has not declared one, so no claim can be made —
   * which the flow says out loud rather than assuming the two agree.
   */
  readonly expectedEdgeIpv4: string | null;
  readonly detail: string | null;
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

const STEP_TITLES: Readonly<Record<PinSetupStepId, string>> = Object.freeze({
  connect: "Connect the Pin to this computer",
  inspect: "See what is on the Pin",
  release: "Publish a release this Center can serve",
  install: "Install the Revival software",
  configure: "Configure the Pin",
  identity: "Mint a device credential",
  activate: "Point the Pin at this server",
  confirm: "Bring it online and confirm",
});

/**
 * `pin release build` publishes to the store on the operator's own machine;
 * nothing in `revival` copies it to the server. Named here so the UI can say so
 * instead of showing an installer with nothing to install.
 */
const RELEASE_BUILD_COMMAND =
  "./revival pin release build --version YYYY-MM-DD.N --version-code INTEGER";
const RELEASE_PUBLISH_COMMAND =
  "# then copy the whole store to $REMOTE_ROOT/data/pin-releases on the server (atomic rename)";

/**
 * Activation is one journalled transaction inside the Pin's own runtime, so the
 * keys are never written by hand. These two commands hand it `activation.json`
 * and ask it to commit.
 */
const ACTIVATE_WRITE_COMMAND =
  "adb shell content write --uri content://com.penumbraos.server.carryidentity/attestation.json < activation.json";
const ACTIVATE_CALL_COMMAND =
  "adb shell content call --uri content://com.penumbraos.server.carryidentity --method ACTIVATE";

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

function deriveInspect(facts: PinSetupFacts): DraftStep {
  const { usb, install } = facts;

  if (!usb.connected) {
    return {
      status: "blocked",
      summary: "Nothing has been read from a Pin yet.",
      next: "Connect a Pin first — every reading below comes over that one USB session.",
    };
  }

  if (install.state === "checking") {
    return { status: "todo", summary: "Reading the Pin's installed packages…", next: null };
  }

  if (install.state === "failed") {
    return {
      status: "attention",
      summary: install.detail
        ? `The Pin could not be inspected: ${install.detail}`
        : "The Pin could not be inspected.",
      next: "Check the cable and try again. A device that answers ADB but not package queries is usually still booting.",
    };
  }

  if (install.state === "read") {
    if (install.deviceLocked === true) {
      return {
        status: "attention",
        summary:
          "The Pin answered, but its credential-encrypted storage is locked, so nothing can be installed.",
        next: "Unlock the device, then read it again.",
      };
    }
    return {
      status: "done",
      summary: `Read: ${install.rolesInstalled} of ${install.rolesTotal} Revival packages are installed${
        install.conflicts > 0
          ? `, and ${install.conflicts} known conflicting package${install.conflicts === 1 ? "" : "s"} ${install.conflicts === 1 ? "is" : "are"} present`
          : ""
      }.`,
      next: null,
    };
  }

  return {
    status: "todo",
    summary: "This Pin has not been read yet.",
    next: "Read the device to see which Revival packages it already has.",
  };
}

function deriveRelease(release: PinSetupReleaseFacts): DraftStep {
  switch (release.availability) {
    case "published":
      return {
        status: "done",
        summary: release.version
          ? `Release ${release.version} is published here, and its manifest verified.`
          : "A verified release is published on this Center.",
        next: null,
      };
    case "checking":
      return { status: "todo", summary: "Asking this Center which release it serves…", next: null };
    case "not-published":
      return {
        status: "manual",
        summary: "This Center is serving no Pin release, so the installer has nothing to install.",
        next: "Build a release, then copy the store onto the server Center reads.",
        commands: [RELEASE_BUILD_COMMAND, RELEASE_PUBLISH_COMMAND],
        manualNote:
          "`pin release build` publishes to the store on your own machine. Nothing in `revival` copies it to the server's /var/lib/ai-pin-revival/pin-releases, so that copy is done by hand today.",
      };
    case "unreadable":
      return {
        status: "attention",
        summary: release.detail
          ? `The published release was refused: ${release.detail}`
          : "The published release could not be verified.",
        next: "A manifest that does not verify is never installed. Fix the store on the server rather than retrying here.",
      };
    default:
      return { status: "todo", summary: "The published release has not been checked yet.", next: null };
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

  /*
   * The credential itself is never observable: the bundle is shown once, at
   * mint time, and never stored, so before activation there is nothing on the
   * device or the server to read back. But there is ONE thing Center can read
   * that proves a credential was minted — and it is downstream, not upstream, so
   * reading it does not break the rule this file exists to enforce.
   *
   * Activation imports the minted identity into AndroidKeyStore, validating that
   * the certificate and private key match and chain to the pinned root, and only
   * THEN writes `penumbra_carry_remote_mode=1` — last, as the commit gate
   * (docs/operations.md §7, `CosmosActivationTransaction.kt:292-301`). So clone
   * mode being on is committed evidence that a credential was minted for this
   * device and accepted by it. This is the inverse of the forbidden inference:
   * not "the step before finished, so this one did", but "a later step reached a
   * state it could only reach if this one already had".
   */
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
      "Center cannot confirm whether this Pin has a credential, and this session cannot mint one — the Provisioning card is behind the operator gate, which this session does not carry.",
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
    // `penumbra_carry_remote_mode=1` says the Pin is pointed at SOME server; it
    // does not say it is pointed at this one. Reporting done on that alone told
    // a newcomer the step was finished while their captures went to an address
    // they may not control — the worst thing a setup flow can get wrong.
    if (activation.expectedEdgeIpv4 === null) {
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
    next: "Write the minted bundle plus your edge IPv4 into activation.json, hand it to the Pin's own runtime, and ask it to activate.",
    commands: [ACTIVATE_WRITE_COMMAND, ACTIVATE_CALL_COMMAND],
    manualNote:
      "There is no console for this yet, and the three Settings.Global keys must never be written by hand: activation is one journalled transaction that validates trust, subject, and key/certificate match before anything is committed, and rolls back on any failure.",
  };
}

function deriveConfirm(cloud: PinSetupCloudFacts): DraftStep {
  if (cloud.state === "absent") {
    return {
      status: "unobservable",
      summary:
        "This Center is not connected to Pin services yet.",
      next: null,
    };
  }

  if (cloud.state === "degraded") {
    return {
      status: "attention",
      summary: "Center could not check whether your Pin is reporting.",
      next: "Your Pin may still be online. Try again shortly.",
    };
  }

  if (cloud.state === "unknown") {
    return { status: "todo", summary: "Checking your Pins…", next: null };
  }

  if (cloud.reportingCount > 0) {
    return {
      status: "done",
      summary: `${cloud.reportingCount} Pin${cloud.reportingCount === 1 ? "" : "s"} paired with this account ${
        cloud.reportingCount === 1 ? "is" : "are"
      } reporting to this Center.`,
      next: null,
    };
  }

  if ((cloud.pairedCount ?? 0) === 0) {
    return {
      status: "todo",
      summary: "No Pin is paired with this account yet.",
      next: "Pair the Pin with the device id from provisioning, get it onto Wi-Fi with the QR page, and finish the on-device onboarding.",
    };
  }

  return {
    status: "todo",
    summary: `${cloud.pairedCount} Pin${cloud.pairedCount === 1 ? " is" : "s are"} paired, and none has reported in.`,
    next: "Get the Pin onto Wi-Fi with the QR page. With clone mode active, the stock onboarding flow runs the enrolment ceremony against your pincode.",
  };
}

const DERIVATIONS: Readonly<
  Record<PinSetupStepId, (facts: PinSetupFacts) => DraftStep>
> = Object.freeze({
  connect: (facts) => deriveConnect(facts.usb),
  inspect: deriveInspect,
  release: (facts) => deriveRelease(facts.release),
  install: deriveInstall,
  configure: deriveConfigure,
  identity: deriveIdentity,
  activate: deriveActivate,
  confirm: (facts) => deriveConfirm(facts.cloud),
});

export function derivePinSetupPlan(facts: PinSetupFacts): PinSetupPlan {
  const steps = PIN_SETUP_STEP_IDS.map((id, index): PinSetupStep => {
    const draft = DERIVATIONS[id](facts);
    return {
      id,
      ordinal: index + 1,
      title: STEP_TITLES[id],
      status: draft.status,
      summary: draft.summary,
      next: draft.next ?? null,
      commands: draft.commands ?? [],
      manualNote: draft.manualNote ?? null,
    };
  });

  const focus = steps.find(
    (step) => step.status !== "done" && step.status !== "unobservable",
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
