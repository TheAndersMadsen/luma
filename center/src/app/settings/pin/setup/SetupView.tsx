"use client";

/**
 * Guided setup: one row per stage of the Pin journey in
 * `contracts/operator-setup.json`, in the order a real Pin needs. Titles and
 * waiting descriptions come from the generated journey. What each row says now
 * comes from facts read off the Pin, the server, and the backend.
 */

import Link from "next/link";
import { useState } from "react";
import settings from "../../settings.module.css";
import pin from "../pin.module.css";
import styles from "./setup.module.css";
import { StatusChip, StatusMessage } from "@/components/Status";
import {
  derivePinSetupPlan,
  PIN_SETUP_CAPABILITIES,
  type PinSetupFacts,
  type PinSetupPlan,
  type PinSetupStep,
} from "@/lib/pin-setup";
import { usePinDevice } from "../PinDeviceProvider";
import { deviceErrorMessage } from "../_lib/deviceErrorPresentation";
import { remoteLinkMessage } from "../_lib/remoteLinkCopy";
import { centerRemoteAccess, enableRemoteAccess } from "../provision/browserActivation";
import { ConnectionHelpModal } from "../install/ConnectionHelpModal";
import { NetworkTimePanel } from "./NetworkTimePanel";
import { OnboardingPasscodePanel } from "./OnboardingPasscodePanel";
import { usePinSetupFacts } from "./usePinSetupFacts";

type StageState = "done" | "focus" | "attention" | "waiting";

function stageState(plan: PinSetupPlan, step: PinSetupStep): StageState {
  if (step.status === "done") return "done";
  if (step.id !== plan.focusStepId) return "waiting";
  return step.status === "attention" ? "attention" : "focus";
}

type EvidenceTone = "live" | "absent" | "degraded" | "off";

function activationEvidence(activation: PinSetupFacts["activation"]): {
  tone: EvidenceTone;
  chip: string;
} {
  if (activation.expectedEdgeState === "invalid") {
    return { tone: "degraded", chip: "Server address invalid" };
  }
  if (activation.expectedEdgeState === "unreadable") {
    return { tone: "degraded", chip: "Server address unreadable" };
  }
  if (activation.state === "unreadable") {
    return { tone: "degraded", chip: "Unreadable" };
  }
  if (activation.state === "inactive") {
    return { tone: "off", chip: "Not connected" };
  }
  if (
    activation.state === "active" &&
    activation.expectedEdgeState === "available" &&
    activation.edgeIpv4 === activation.expectedEdgeIpv4
  ) {
    return { tone: "live", chip: "Connected to this server" };
  }
  if (activation.state === "active") {
    // "Elsewhere" is a claim, and it needs both addresses to make it: while
    // this server's address is still being read, or the deployment declared
    // none, there is nothing to compare against and the chip says so instead.
    if (
      activation.expectedEdgeState === "available" &&
      activation.expectedEdgeIpv4 !== null
    ) {
      return { tone: "off", chip: "Connected elsewhere" };
    }
    if (
      activation.expectedEdgeState === "checking" ||
      activation.expectedEdgeState === "unknown"
    ) {
      return { tone: "off", chip: "Checking" };
    }
    return { tone: "off", chip: "Not verified" };
  }
  return { tone: "off", chip: "Unknown" };
}

const RELEASES_URL = "https://github.com/TheAndersMadsen/luma/releases";

export default function SetupView({
  operator,
  provisioningHref,
}: {
  /** Whether the signed-in session carries the operator claim (decided server-side). */
  operator: boolean;
  /** The operator-only provisioning pane, when this session may reach it. */
  provisioningHref: string | null;
}) {
  const {
    connect,
    clearError,
    error,
    remoteUnpaired,
    support,
    borrowSession,
    client,
    connectionMode,
  } = usePinDevice();
  const readings = usePinSetupFacts({ operator });
  const { facts } = readings;
  const plan = derivePinSetupPlan(facts);
  const focused = plan.steps.find((step) => step.id === plan.focusStepId) ?? null;
  const activation = activationEvidence(facts.activation);
  const [connecting, setConnecting] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [enablingRemote, setEnablingRemote] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [acceptanceError, setAcceptanceError] = useState<string | null>(null);
  const [connectionHelpOpen, setConnectionHelpOpen] = useState(false);

  async function onConnect() {
    setConnecting(true);
    clearError();
    try {
      await connect();
    } catch {
      // The provider already carries the message in `error`. This catch only
      // stops it from becoming an unhandled rejection.
    } finally {
      setConnecting(false);
    }
  }

  async function onPair() {
    const deviceId = facts.usb.deviceId;
    if (!deviceId || pairing) return;
    setPairing(true);
    setPairError(null);
    try {
      const response = await fetch("/api/devices/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_id: deviceId }),
      });
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (!response.ok) {
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : "Center could not pair this Pin with your account.",
        );
      }
      readings.refresh();
    } catch (pairingError) {
      setPairError(
        pairingError instanceof Error
          ? pairingError.message
          : "Center could not pair this Pin with your account.",
      );
    } finally {
      setPairing(false);
    }
  }

  /*
   * Point Center's remote link at this Pin, over USB: the same steps
   * Provisioning runs after activation, for a Pin that is already connected to
   * your Luma and paired (activated from a file, re-paired here, a replacement
   * Pin, or a server whose link was reset).
   */
  async function onEnableRemote() {
    const deviceId = facts.usb.deviceId;
    if (!deviceId || enablingRemote) return;
    if (!client || connectionMode !== "usb" || client.mode !== "usb") {
      setRemoteError("Luma on this Pin isn’t answering over USB yet. Choose Check again in a moment.");
      return;
    }
    setEnablingRemote(true);
    setRemoteError(null);
    try {
      await enableRemoteAccess(borrowSession(), client, centerRemoteAccess, deviceId);
      readings.refresh();
    } catch (remoteFailure) {
      setRemoteError(
        deviceErrorMessage(
          remoteFailure,
          remoteFailure instanceof Error && remoteFailure.message
            ? remoteFailure.message
            : "Center could not turn on remote access.",
        ),
      );
    } finally {
      setEnablingRemote(false);
    }
  }

  async function onConfirm() {
    if (confirming) return;
    setConfirming(true);
    setAcceptanceError(null);
    try {
      await readings.confirmAcceptance();
    } catch (confirmationError) {
      setAcceptanceError(
        confirmationError instanceof Error
          ? confirmationError.message
          : "The Pin could not retain the physical acceptance confirmation.",
      );
    } finally {
      setConfirming(false);
    }
  }

  function stageActions(step: PinSetupStep): React.ReactNode {
    switch (step.id) {
      case "connect":
        return (
          <>
            {step.status === "todo" ? (
              <button
                type="button"
                className={pin.button}
                disabled={connecting || facts.usb.browserSupported === false}
                onClick={() => void onConnect()}
                data-testid="pin-setup-connect"
              >
                {connecting ? "Connecting…" : "Connect over USB"}
              </button>
            ) : null}
            <button
              type="button"
              className={pin.buttonQuiet}
              onClick={() => setConnectionHelpOpen(true)}
            >
              Connection help
            </button>
          </>
        );

      case "network":
        return (
          <NetworkTimePanel
            network={facts.network}
            device={borrowSession}
            onChanged={readings.refresh}
          />
        );

      case "install":
        if (step.commands.length > 0) {
          return (
            <>
              {step.commands.map((command) => (
                <code key={command}>{command}</code>
              ))}
              <a className={settings.additionLink} href={RELEASES_URL} target="_blank" rel="noreferrer">
                Luma releases
              </a>
            </>
          );
        }
        return (
          <Link className={settings.additionLink} href="/settings/pin/install">
            Open installer
          </Link>
        );

      case "services":
        return operator ? (
          <Link className={settings.additionLink} href="/settings/account/services">
            Set up services
          </Link>
        ) : null;

      case "activate":
        if (
          facts.activation.state === "active" &&
          facts.cloud.state === "live" &&
          facts.cloud.connectedPinPaired === false
        ) {
          return (
            <button type="button" className={pin.button} disabled={pairing} onClick={() => void onPair()}>
              {pairing ? "Pairing…" : "Pair this Pin"}
            </button>
          );
        }
        if (
          facts.activation.state === "active" &&
          facts.cloud.connectedPinPaired === true &&
          facts.remote.state === "unassigned"
        ) {
          return (
            <button
              type="button"
              className={pin.button}
              disabled={enablingRemote}
              onClick={() => void onEnableRemote()}
              data-testid="pin-setup-remote-access"
            >
              {enablingRemote ? "Turning on remote access…" : "Turn on remote access"}
            </button>
          );
        }
        return (
          <>
            {facts.activation.state === "inactive" &&
            facts.onboarding.setupComplete === false &&
            facts.passcode.state === "not-set" ? (
              <Link className={settings.additionLink} href="/settings/account/security">
                Set your Pin passcode
              </Link>
            ) : null}
            {provisioningHref ? (
              <Link className={settings.additionLink} href={provisioningHref}>
                Open Provisioning
              </Link>
            ) : null}
          </>
        );

      case "passcode":
        if (facts.passcode.state === "not-set" || facts.passcode.state === "unreadable") {
          return (
            <Link className={settings.additionLink} href="/settings/account/security">
              Set your Pin passcode
            </Link>
          );
        }
        return facts.passcode.state === "set" &&
          facts.onboarding.setupComplete === false &&
          facts.activation.state === "active" ? (
          <OnboardingPasscodePanel
            device={borrowSession}
            onChanged={readings.refresh}
          />
        ) : null;

      case "confirm":
        return (
          <button
            type="button"
            className={pin.button}
            onClick={() => void onConfirm()}
            disabled={confirming}
            data-testid="pin-setup-confirm"
          >
            {confirming ? "Saving on this Pin…" : "Confirm microphone, speaker & gesture"}
          </button>
        );
    }
  }

  const percent = Math.round((plan.doneCount / plan.total) * 100);
  const stockSetupAlreadyDone =
    facts.onboarding.setupComplete === true && facts.activation.state === "inactive";
  // Where every setup starts, not a failure: said once, calmly, and only until
  // a USB session takes over the page.
  const unpairedLine =
    remoteUnpaired && !facts.usb.connected && !facts.usb.connecting
      ? remoteLinkMessage(remoteUnpaired, "setup")
      : null;

  return (
    <>
      {!facts.usb.connected && !facts.usb.connecting ? (
        <section className={settings.section}>
          <div className={settings.sectionHeader}>
            <span className={settings.sectionTitle}>Start with Center</span>
          </div>
          <div className={styles.introduction}>
            <p className={settings.additionNote}>
              You can set up Center and your services now, then connect your Pin
              when you are ready. This server supports one Pin.
            </p>
            <div className={styles.actions}>
              <Link className={settings.additionLink} href="/settings/account/services">
                Set up Assistant &amp; voice
              </Link>
            </div>
          </div>
        </section>
      ) : null}
      <section className={settings.section} data-testid="pin-setup-overview">
        <div className={settings.sectionHeader}>
          <span className={settings.sectionTitle}>Set up your Ai Pin</span>
          <button
            type="button"
            className={pin.buttonQuiet}
            onClick={readings.refresh}
            disabled={readings.refreshing}
            data-testid="pin-setup-refresh"
          >
            {readings.refreshing ? "Checking…" : "Check again"}
          </button>
        </div>

        <div className={styles.progress}>
          <div className={styles.progressHead}>
            <span className={styles.progressCount} data-testid="pin-setup-progress">
              {plan.doneCount} of {plan.total} steps complete
            </span>
            <span className={styles.progressMeta}>
              {focused ? `Next: ${focused.title}` : "Your Pin is ready."}
            </span>
          </div>
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-valuenow={plan.doneCount}
            aria-valuemin={0}
            aria-valuemax={plan.total}
            aria-label="Pin setup progress"
          >
            <div className={styles.progressFill} style={{ width: `${percent}%` }} />
          </div>
        </div>

        {unpairedLine ? (
          <div className={pin.stateRow} data-testid="pin-setup-unpaired">
            <StatusMessage tone="info">{unpairedLine}</StatusMessage>
          </div>
        ) : null}

        {error ? (
          <div className={pin.stateRow}>
            {/* A retry is only offered when retrying could help. A device that
                stopped answering mid-session is not fixed by the picker. */}
            <StatusMessage
              tone="warning"
              onRetry={facts.usb.connected ? undefined : () => void onConnect()}
            >
              {error}
            </StatusMessage>
          </div>
        ) : null}

        {pairError ? (
          <div className={pin.stateRow}>
            <StatusMessage tone="warning">{pairError}</StatusMessage>
          </div>
        ) : null}

        {remoteError ? (
          <div className={pin.stateRow}>
            <StatusMessage tone="warning">{remoteError}</StatusMessage>
          </div>
        ) : null}

        {acceptanceError ? (
          <div className={pin.stateRow}>
            <StatusMessage tone="warning">{acceptanceError}</StatusMessage>
          </div>
        ) : null}

        {stockSetupAlreadyDone ? (
          <div className={pin.stateRow} data-testid="pin-setup-stock-setup-done">
            <StatusMessage tone="info">
              This Pin already finished Humane’s original setup, so it won’t show
              its welcome screens or ask for a passcode again. It keeps unlocking
              with the passcode it has today.
            </StatusMessage>
          </div>
        ) : null}

        {support && !support.supported ? (
          <div className={pin.stateRow}>
            <StatusMessage tone="warning">
              This browser cannot reach a Pin over USB.
              <ul className={pin.reasons}>
                {support.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </StatusMessage>
          </div>
        ) : null}
      </section>

      <section className={settings.section} data-testid="pin-setup-steps">
        <div className={settings.sectionHeader}>
          <span className={settings.sectionTitle}>Your setup</span>
        </div>

        {plan.steps.map((step) => (
          <StageRow
            key={step.id}
            step={step}
            state={stageState(plan, step)}
            actions={stageActions(step)}
          />
        ))}
      </section>

      <section className={settings.section} data-testid="pin-setup-capabilities">
        <div className={settings.sectionHeader}>
          <span className={settings.sectionTitle}>Services</span>
        </div>
        {[true, false].map((required) => (
          <div key={String(required)}>
            <p className={styles.capabilityGroup}>
              {required ? "Needed to answer questions" : "Optional"}
            </p>
            <div className={styles.capabilityGrid}>
              {PIN_SETUP_CAPABILITIES.filter((capability) => capability.required === required).map(
                ({ id, label, detail }) => {
                  const ready = facts.server.capabilities[id];
                  return (
                    <div
                      className={styles.capability}
                      data-testid={`pin-setup-capability-${id}`}
                      key={id}
                    >
                      <span className={styles.capabilityText}>
                        <span className={styles.capabilityTitle}>{label}</span>
                        <span className={styles.capabilityDetail}>{detail}</span>
                      </span>
                      <StatusChip
                        tone={ready === true ? "live" : ready === false && required ? "absent" : "off"}
                        variant="tag"
                        label={
                          ready === true
                            ? "Ready"
                            : ready === false
                              ? required
                                ? "Needs setup"
                                : "Not set up"
                              : "Checking"
                        }
                        detail={detail}
                      />
                    </div>
                  );
                },
              )}
            </div>
          </div>
        ))}
      </section>

      <section className={settings.section} data-testid="pin-setup-evidence">
        <details className={styles.evidenceDetails}>
          <summary className={settings.sectionHeader}>
            <span className={settings.sectionTitle}>Connection details</span>
          </summary>

          <EvidenceRow
            label="Published release"
            tone={
              facts.release.availability === "published"
                ? "live"
                : facts.release.availability === "not-published"
                  ? "absent"
                  : facts.release.availability === "unreadable"
                    ? "degraded"
                    : "off"
            }
            chip={
              facts.release.availability === "published"
                ? (facts.release.version ?? "Published")
                : facts.release.availability === "not-published"
                  ? "None published"
                  : facts.release.availability === "unreadable"
                    ? "Refused"
                    : "Checking"
            }
            detail="The Luma release your server offers to Pins."
          />
          <EvidenceRow
            label="Luma on this Pin"
            tone={
              facts.server.answering === "online"
                ? "live"
                : facts.server.answering === "offline"
                  ? "degraded"
                  : "off"
            }
            chip={
              facts.server.answering === "online"
                ? "Answering"
                : facts.server.answering === "offline"
                  ? "Not answering"
                  : "Unknown"
            }
            detail="The Luma service running on this Pin."
          />
          <EvidenceRow
            label="Connected to this server"
            tone={activation.tone}
            chip={activation.chip}
            detail="The server address this Pin reports."
          />
          <EvidenceRow
            label="Reporting to this Center"
            tone={
              facts.cloud.connectedPinReporting
                ? "live"
                : facts.cloud.state === "degraded"
                  ? "degraded"
                  : facts.cloud.state === "absent"
                    ? "absent"
                    : "off"
            }
            chip={
              facts.cloud.connectedPinReporting
                ? "This Pin online"
                : facts.cloud.state === "degraded"
                  ? "Couldn’t check"
                  : facts.cloud.state === "absent"
                    ? "Not connected"
                    : "Not reporting"
            }
            detail={
              readings.lastReportAtEpoch
                ? `Last report ${new Date(readings.lastReportAtEpoch).toLocaleString()}.`
                : "The latest status reported by your paired Pin."
            }
          />
        </details>
      </section>
      <ConnectionHelpModal
        open={connectionHelpOpen}
        onClose={() => setConnectionHelpOpen(false)}
      />
    </>
  );
}

const STATE_LABELS: Record<StageState, string> = {
  done: "Complete",
  focus: "Next",
  attention: "Check",
  waiting: "Waiting",
};

function StageRow({
  step,
  state,
  actions,
}: {
  step: PinSetupStep;
  state: StageState;
  actions: React.ReactNode;
}) {
  const focused = state === "focus" || state === "attention";

  return (
    <div
      className={`${styles.step} ${focused ? styles.stepFocus : ""}`}
      data-testid={`pin-setup-stage-${step.id}`}
      data-state={state}
      aria-current={focused ? "step" : undefined}
    >
      <span className={styles.badge} data-state={state} aria-hidden="true">
        {state === "done" ? "✓" : step.ordinal}
      </span>
      <div className={styles.body}>
        <div className={styles.head}>
          <span className={styles.title}>{step.title}</span>
          <span className={styles.state} data-state={state}>
            {STATE_LABELS[state]}
          </span>
        </div>
        <p className={styles.summary}>{state === "waiting" ? step.description : step.summary}</p>
        {focused && step.next ? <p className={styles.next}>{step.next}</p> : null}
        {focused && actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
    </div>
  );
}

function EvidenceRow({
  label,
  chip,
  tone,
  detail,
}: {
  label: string;
  chip: string;
  tone: EvidenceTone;
  detail: string;
}) {
  return (
    <div className={pin.row}>
      <span className={pin.rowText}>
        <span className={pin.rowTitle}>{label}</span>
        <span className={pin.rowDesc}>{detail}</span>
      </span>
      <StatusChip tone={tone} variant="tag" label={chip} detail={detail} />
    </div>
  );
}
