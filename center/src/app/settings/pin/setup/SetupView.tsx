"use client";

/** Four wearer-facing stages backed by the canonical setup checks. */

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
import { ConnectionHelpModal } from "../install/ConnectionHelpModal";
import { usePinSetupFacts } from "./usePinSetupFacts";

type SetupStageId = "connect" | "install" | "cosmos" | "finish";
type SetupStageState = "done" | "focus" | "attention" | "waiting";

type SetupStage = {
  id: SetupStageId;
  ordinal: number;
  title: string;
  summary: string;
  state: SetupStageState;
  focusedStep: PinSetupStep | null;
};

const SETUP_STAGES: ReadonlyArray<{
  id: SetupStageId;
  title: string;
  summary: string;
  done: string;
  steps: ReadonlyArray<PinSetupStep["id"]>;
}> = [
  {
    id: "connect",
    title: "Connect your Pin",
    summary: "Use USB-C and choose your Ai Pin in the browser.",
    done: "Your Pin is connected.",
    steps: ["connect"],
  },
  {
    id: "install",
    title: "Install the software",
    summary: "Center installs and verifies the current Revival release.",
    done: "The current software is installed.",
    steps: ["release", "install"],
  },
  {
    id: "cosmos",
    title: "Connect to Cosmos",
    summary: "Choose your services, then activate this Pin from Center.",
    done: "This Pin is connected to Cosmos.",
    steps: ["configure", "identity", "activate"],
  },
  {
    id: "finish",
    title: "Get online and try it",
    summary: "Use Wi-Fi or LTE, then make a voice request on the Pin.",
    done: "Your Pin is ready to use.",
    steps: ["network", "confirm"],
  },
];

function setupStages(plan: PinSetupPlan): SetupStage[] {
  return SETUP_STAGES.map((definition, index) => {
    const steps = definition.steps.map((id) => plan.steps.find((step) => step.id === id)!);
    const focusedStep = steps.find((step) => step.id === plan.focusStepId) ?? null;
    const done = steps.every((step) => step.status === "done");
    const attention = focusedStep?.status === "attention";
    return {
      id: definition.id,
      ordinal: index + 1,
      title: definition.title,
      summary: done
        ? definition.done
        : focusedStep
          ? (focusedStep.next ?? focusedStep.summary)
          : definition.summary,
      state: done ? "done" : focusedStep ? (attention ? "attention" : "focus") : "waiting",
      focusedStep,
    };
  });
}

type EvidenceTone = "live" | "absent" | "degraded" | "off";

function activationEvidence(activation: PinSetupFacts["activation"]): {
  tone: EvidenceTone;
  chip: string;
} {
  if (activation.expectedEdgeState === "invalid") {
    return { tone: "degraded", chip: "Edge config invalid" };
  }
  if (activation.expectedEdgeState === "unreadable") {
    return { tone: "degraded", chip: "Edge config unreadable" };
  }
  if (activation.state === "unreadable") {
    return { tone: "degraded", chip: "Unreadable" };
  }
  if (activation.state === "inactive") {
    return { tone: "off", chip: "Clone mode off" };
  }
  if (
    activation.state === "active" &&
    activation.expectedEdgeState === "available" &&
    activation.edgeIpv4 === activation.expectedEdgeIpv4
  ) {
    return { tone: "live", chip: "Verified for this Center" };
  }
  if (activation.state === "active") {
    return { tone: "off", chip: "Clone mode on · unverified target" };
  }
  return { tone: "off", chip: "Unknown" };
}

export default function SetupView({
  operator,
  provisioningHref,
}: {
  /** Whether the signed-in session carries the operator claim (decided server-side). */
  operator: boolean;
  /** The operator-only provisioning pane, when this session may reach it. */
  provisioningHref: string | null;
}) {
  const { connect, clearError, error, support } = usePinDevice();
  const readings = usePinSetupFacts({ operator });
  const plan = derivePinSetupPlan(readings.facts);
  const stages = setupStages(plan);
  const completeStages = stages.filter((stage) => stage.state === "done").length;
  const focusedStage = stages.find((stage) => stage.state === "focus" || stage.state === "attention");
  const activation = activationEvidence(readings.facts.activation);
  const [connecting, setConnecting] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [acceptanceError, setAcceptanceError] = useState<string | null>(null);
  const [connectionHelpOpen, setConnectionHelpOpen] = useState(false);

  async function onConnect() {
    setConnecting(true);
    clearError();
    try {
      await connect();
    } catch {
      // The provider already carries the message in `error`; this catch only
      // stops it from becoming an unhandled rejection.
    } finally {
      setConnecting(false);
    }
  }

  async function onPair() {
    const deviceId = readings.facts.usb.deviceId;
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

  const percent = Math.round((completeStages / stages.length) * 100);

  return (
    <>
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
              {completeStages} of {stages.length} steps complete
            </span>
            <span className={styles.progressMeta}>
              {focusedStage ? `Next: ${focusedStage.title}` : "Your Pin is ready."}
            </span>
          </div>
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-valuenow={completeStages}
            aria-valuemin={0}
            aria-valuemax={stages.length}
            aria-label="Pin setup progress"
          >
            <div className={styles.progressFill} style={{ width: `${percent}%` }} />
          </div>
        </div>

        {error ? (
          <div className={pin.stateRow}>
            {/* Same rule as the Connect pane: a retry is only offered when
                retrying is the thing that could help. A device that stopped
                answering mid-session is not fixed by re-running the picker. */}
            <StatusMessage
              tone="warning"
              onRetry={readings.facts.usb.connected ? undefined : () => void onConnect()}
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

        {acceptanceError ? (
          <div className={pin.stateRow}>
            <StatusMessage tone="warning">{acceptanceError}</StatusMessage>
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

        {stages.map((stage) => (
          <StageRow
            key={stage.id}
            stage={stage}
            actions={renderStageAction({
              stage,
              provisioningHref,
              connecting,
              usbSupported: readings.facts.usb.browserSupported !== false,
              needsPairing:
                readings.facts.cloud.state === "live" &&
                readings.facts.cloud.connectedPinPaired === false,
              onConnect: () => void onConnect(),
              onConnectionHelp: () => setConnectionHelpOpen(true),
              onPair: () => void onPair(),
              pairing,
              onConfirm: () => void onConfirm(),
              confirming,
            })}
          />
        ))}
      </section>

      <section className={settings.section} data-testid="pin-setup-capabilities">
        <div className={settings.sectionHeader}>
          <span className={settings.sectionTitle}>Capability readiness</span>
        </div>
        <div className={styles.capabilityGrid}>
          {PIN_SETUP_CAPABILITIES.map(({ id, label, detail }) => {
            const ready = readings.facts.server.capabilities[id];
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
                  tone={ready === true ? "live" : ready === false ? "absent" : "off"}
                  variant="tag"
                  label={ready === true ? "Ready" : ready === false ? "Needs setup" : "Checking"}
                  detail={detail}
                />
              </div>
            );
          })}
        </div>
      </section>

      <section className={settings.section} data-testid="pin-setup-evidence">
        <details className={styles.evidenceDetails}>
          <summary className={settings.sectionHeader}>
            <span className={settings.sectionTitle}>Connection details</span>
          </summary>

          <EvidenceRow
            label="Published release"
            tone={
              readings.facts.release.availability === "published"
                ? "live"
                : readings.facts.release.availability === "not-published"
                  ? "absent"
                  : readings.facts.release.availability === "unreadable"
                    ? "degraded"
                    : "off"
            }
            chip={
              readings.facts.release.availability === "published"
                ? (readings.facts.release.version ?? "Published")
                : readings.facts.release.availability === "not-published"
                  ? "None published"
                  : readings.facts.release.availability === "unreadable"
                    ? "Refused"
                    : "Checking"
            }
            detail="The current release published by Center."
          />
          <EvidenceRow
            label="Pin's own server"
            tone={
              readings.facts.server.answering === "online"
                ? "live"
                : readings.facts.server.answering === "offline"
                  ? "degraded"
                  : "off"
            }
            chip={
              readings.facts.server.answering === "online"
                ? "Answering"
                : readings.facts.server.answering === "offline"
                  ? "Not answering"
                  : "Unknown"
            }
            detail="The Revival service running on this Pin."
          />
          <EvidenceRow
            label="Pointed at this server"
            tone={activation.tone}
            chip={activation.chip}
            detail="The Cosmos address reported by this Pin."
          />
          <EvidenceRow
            label="Reporting to this Center"
            tone={
              readings.facts.cloud.connectedPinReporting
                ? "live"
                : readings.facts.cloud.state === "degraded"
                ? "degraded"
                : readings.facts.cloud.state === "absent"
                  ? "absent"
                  : "off"
            }
            chip={
              readings.facts.cloud.connectedPinReporting
                ? "This Pin online"
                : readings.facts.cloud.state === "degraded"
                ? "Couldn’t check"
                : readings.facts.cloud.state === "absent"
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

const STAGE_LABELS: Record<SetupStageState, string> = {
  done: "Complete",
  focus: "Next",
  attention: "Check",
  waiting: "Waiting",
};

function StageRow({
  stage,
  actions,
}: {
  stage: SetupStage;
  actions: React.ReactNode;
}) {
  const focused = stage.state === "focus" || stage.state === "attention";

  return (
    <div
      className={`${styles.step} ${focused ? styles.stepFocus : ""}`}
      data-testid={`pin-setup-stage-${stage.id}`}
      data-state={stage.state}
      aria-current={focused ? "step" : undefined}
    >
      <span className={styles.badge} data-state={stage.state} aria-hidden="true">
        {stage.state === "done" ? "✓" : stage.ordinal}
      </span>
      <div className={styles.body}>
        <div className={styles.head}>
          <span className={styles.title}>{stage.title}</span>
          <span className={styles.state} data-state={stage.state}>
            {STAGE_LABELS[stage.state]}
          </span>
        </div>
        <p className={styles.summary}>{stage.summary}</p>
        {focused && actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
    </div>
  );
}

function renderStageAction({
  stage,
  provisioningHref,
  connecting,
  usbSupported,
  needsPairing,
  onConnect,
  onConnectionHelp,
  onPair,
  pairing,
  onConfirm,
  confirming,
}: {
  stage: SetupStage;
  provisioningHref: string | null;
  connecting: boolean;
  usbSupported: boolean;
  needsPairing: boolean;
  onConnect: () => void;
  onConnectionHelp: () => void;
  onPair: () => void;
  pairing: boolean;
  onConfirm: () => void;
  confirming: boolean;
}): React.ReactNode {
  const step = stage.focusedStep;
  if (!step) return null;

  switch (stage.id) {
    case "connect":
      if (step.status !== "todo") {
        return step.centerRoute ? (
          <Link className={settings.additionLink} href={step.centerRoute}>
            Connection details
          </Link>
        ) : null;
      }
      return (
        <>
          <button
            type="button"
            className={pin.button}
            disabled={connecting || !usbSupported}
            onClick={onConnect}
            data-testid="pin-setup-connect"
          >
            {connecting ? "Connecting…" : "Connect over USB"}
          </button>
          <button type="button" className={pin.buttonQuiet} onClick={onConnectionHelp}>
            Connection help
          </button>
        </>
      );

    case "install":
      if (step.id === "release") {
        const exportCurrentRelease = step.commands.some((command) =>
          command.includes(" pin release export "),
        );
        return (
          <>
            {exportCurrentRelease ? null : (
              <a
                className={settings.additionLink}
                href="https://github.com/TheAndersMadsen/ai-pin-revival/releases"
                target="_blank"
                rel="noreferrer"
              >
                Download signed release
              </a>
            )}
            {step.commands.map((command) => (
              <code key={command}>{command}</code>
            ))}
          </>
        );
      }
      return (
        <Link className={settings.additionLink} href="/settings/pin/install">
          Open installer
        </Link>
      );

    case "cosmos":
      if (step.id === "configure") {
        return provisioningHref ? (
          <Link className={settings.additionLink} href="/settings/account/services">
            Set up services
          </Link>
        ) : null;
      }
      return provisioningHref ? (
        <Link className={settings.additionLink} href={provisioningHref}>
          Connect to Cosmos
        </Link>
      ) : null;

    case "finish":
      if (step.id === "network") {
        if (step.status === "attention") {
          return provisioningHref ? (
            <Link className={settings.additionLink} href={provisioningHref}>
              Check Cosmos setup
            </Link>
          ) : null;
        }
        if (needsPairing) {
          return (
            <button
              type="button"
              className={pin.button}
              disabled={pairing}
              onClick={onPair}
            >
              {pairing ? "Pairing…" : "Pair this Pin"}
            </button>
          );
        }
        return (
          <Link className={settings.additionLink} href="/wifi">
            Add Wi-Fi
          </Link>
        );
      }
      return (
        <button
          type="button"
          className={pin.button}
          onClick={onConfirm}
          disabled={confirming}
          data-testid="pin-setup-confirm"
        >
          {confirming ? "Saving on this Pin…" : "Confirm microphone, speaker & gesture"}
        </button>
      );

    default:
      return null;
  }
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
