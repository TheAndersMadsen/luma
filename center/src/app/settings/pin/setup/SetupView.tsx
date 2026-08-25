"use client";

/**
 * Guided setup — the ordered path from a stock Ai Pin to a provisioned one.
 *
 * The Pin console already had every capability this page needs: connect,
 * install, server, assistant, service keys, eSIM, flags, diagnostics. What it
 * did not have was an ORDER. Each pane assumed you already knew which one came
 * first and what it was for, which is fine for the person who built them and
 * useless for anyone else. This page adds the sequence and nothing else: it
 * links into those panes rather than reimplementing them, and the one device
 * action it performs itself — claiming the USB session — is the same shared
 * session every pane uses, so connecting here IS connecting there.
 *
 * Two rules it holds itself to:
 *
 *  1. Every state on this page was READ. Nothing is marked done because the
 *     step above it is; `usePinSetupFacts` names the authority for each one.
 *  2. Where a step cannot be finished in a browser today, it says so and prints
 *     the command projected from the canonical setup contract. Physical
 *     acceptance remains a separate wearer-observed gate.
 */

import Link from "next/link";
import { useState } from "react";
import settings from "../../settings.module.css";
import pin from "../pin.module.css";
import styles from "./setup.module.css";
import { StatusChip, StatusMessage } from "@/components/Status";
import {
  derivePinSetupPlan,
  type PinSetupFacts,
  type PinSetupStep,
  type PinSetupStepStatus,
} from "@/lib/pin-setup";
import { usePinDevice } from "../PinDeviceProvider";
import { usePinSetupFacts } from "./usePinSetupFacts";

const STATE_LABELS: Record<PinSetupStepStatus, string> = {
  done: "Done",
  todo: "Do this next",
  // Covers both the terminal-only steps (build a release, activate over ADB)
  // and the operator-only one (mint a credential): none can be finished in this
  // browser session, which is the honest thing they have in common.
  manual: "Outside this browser",
  attention: "Needs attention",
  blocked: "Waiting",
  unobservable: "Not visible here",
};

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
  const activation = activationEvidence(readings.facts.activation);
  const [connecting, setConnecting] = useState(false);

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

  const percent =
    plan.observableCount === 0
      ? 0
      : Math.round((plan.doneCount / plan.observableCount) * 100);

  return (
    <>
      <section className={settings.section} data-testid="pin-setup-overview">
        <div className={settings.sectionHeader}>
          <span className={settings.sectionTitle}>Where you are</span>
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
              {plan.doneCount} of {plan.observableCount} checks passing
            </span>
            <span className={styles.progressMeta}>
              {plan.focusStepId
                ? `Next: ${plan.steps.find((step) => step.id === plan.focusStepId)?.title}`
                : "Every step this page can check has passed."}
            </span>
          </div>
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-valuenow={plan.doneCount}
            aria-valuemin={0}
            aria-valuemax={plan.observableCount}
            aria-label="Pin setup progress"
          >
            <div className={styles.progressFill} style={{ width: `${percent}%` }} />
          </div>
        </div>

        <div className={pin.noteRow}>
          <p className={pin.note}>
            Complete the highlighted step. Some steps require a terminal, an operator,
            or the physical Pin.
          </p>
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
          <span className={settings.sectionTitle}>The path</span>
        </div>

        {plan.steps.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            focused={step.id === plan.focusStepId}
            actions={renderStepActions({
              step,
              provisioningHref,
              connecting,
              usbSupported: readings.facts.usb.browserSupported !== false,
              onConnect: () => void onConnect(),
            })}
          />
        ))}
      </section>

      <section className={settings.section} data-testid="pin-setup-evidence">
        <div className={settings.sectionHeader}>
          <span className={settings.sectionTitle}>Setup checks</span>
        </div>

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
            readings.facts.cloud.state === "degraded"
              ? "degraded"
              : readings.facts.cloud.state === "absent"
                ? "absent"
                : readings.facts.cloud.reportingCount > 0
                  ? "live"
                  : "off"
          }
          chip={
            readings.facts.cloud.state === "degraded"
              ? "Couldn’t check"
              : readings.facts.cloud.state === "absent"
                ? "Not connected"
                : readings.facts.cloud.reportingCount > 0
                  ? `${readings.facts.cloud.reportingCount} online`
                  : "Not reporting"
          }
          detail={
            readings.lastReportAtEpoch
              ? `Last report ${new Date(readings.lastReportAtEpoch).toLocaleString()}.`
              : "The latest status reported by your paired Pin."
          }
        />
      </section>
    </>
  );
}

function StepRow({
  step,
  focused,
  actions,
}: {
  step: PinSetupStep;
  focused: boolean;
  actions: React.ReactNode;
}) {
  // Exactly one step exposes instructions and controls. Other steps still show
  // their current fact, without competing calls to action.
  const expanded = focused;
  const dim = step.status === "blocked" || step.status === "unobservable";

  return (
    <div
      className={`${styles.step} ${focused ? styles.stepFocus : ""} ${dim ? styles.stepDim : ""}`}
      data-testid={`pin-setup-step-${step.id}`}
      data-state={step.status}
      aria-current={focused ? "step" : undefined}
    >
      <span className={styles.badge} data-state={step.status} aria-hidden="true">
        {step.status === "done" ? "✓" : step.ordinal}
      </span>
      <div className={styles.body}>
        <div className={styles.head}>
          <span className={styles.title}>{step.title}</span>
          <span className={styles.state} data-state={step.status}>
            {STATE_LABELS[step.status]}
          </span>
        </div>
        <p className={styles.summary}>{step.summary}</p>
        {expanded && step.next ? <p className={styles.next}>{step.next}</p> : null}
        {expanded && (step.commands.length > 0 || step.manualNote) ? (
          <div className={styles.manual}>
            {step.manualNote ? <p className={styles.manualNote}>{step.manualNote}</p> : null}
            {step.commands.length > 0 ? (
              <div className={styles.commands}>
                {step.commands.map((command) => (
                  <pre className={styles.command} key={command}>
                    {command}
                  </pre>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {expanded && actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
    </div>
  );
}

/**
 * What can be clicked for a step — and deliberately nothing where nothing can.
 *
 * Every link here goes to a pane that already exists. The one exception is
 * "Connect over USB", which drives the shared session directly because that is
 * the session the whole console runs on; it is the same call the Connect pane
 * makes, against the same module-scoped transport.
 *
 * A plain function rather than a component, so a step with no affordance
 * returns null to its CALLER and the row can leave the control area out
 * entirely instead of rendering an empty one.
 */
function renderStepActions({
  step,
  provisioningHref,
  connecting,
  usbSupported,
  onConnect,
}: {
  step: PinSetupStep;
  provisioningHref: string | null;
  connecting: boolean;
  usbSupported: boolean;
  onConnect: () => void;
}): React.ReactNode {
  switch (step.id) {
    case "connect":
      /*
       * The button appears only when connecting is actually the thing to do.
       * The two "attention" cases — an unsupported browser, and a device that
       * is not an Ai Pin — are both resolved somewhere other than this button,
       * and offering it anyway would say "click here" about a problem clicking
       * cannot fix. Releasing a device is the Connect pane's job, not this
       * page's, so that is where the link goes.
       */
      if (step.status !== "todo") {
        return step.centerRoute ? (
          <Link className={settings.additionLink} href={step.centerRoute}>
            Connection details
          </Link>
        ) : null;
      }
      return (
        <button
          type="button"
          className={pin.button}
          disabled={connecting || !usbSupported}
          onClick={onConnect}
          data-testid="pin-setup-connect"
        >
          {connecting ? "Connecting…" : "Connect over USB"}
        </button>
      );

    case "release":
      // These are operator-host mutations. The generated CLI command is the
      // action; an adjacent Center link would falsely imply the browser can do it.
      return null;

    case "install":
      if (step.status === "blocked") return null;
      return step.centerRoute ? (
        <Link className={settings.additionLink} href={step.centerRoute}>
          Open the installer
        </Link>
      ) : null;

    case "configure":
      if (step.status === "blocked") return null;
      return step.centerRoute ? (
        <Link className={settings.additionLink} href={step.centerRoute}>
          Open Pin settings
        </Link>
      ) : null;

    case "identity":
      // No link at all without the operator claim: an entry point that only
      // bounces the wearer back to "/" is worse than none.
      if (!provisioningHref) return null;
      return (
        <Link className={settings.additionLink} href={provisioningHref}>
          Open provisioning
        </Link>
      );

    case "activate":
      // The generated exact-device command is the only mutation affordance.
      return null;

    case "network":
      return step.centerRoute ? (
        <Link className={settings.additionLink} href={step.centerRoute}>
          Create Wi-Fi QR code
        </Link>
      ) : null;

    case "confirm":
      return step.centerRoute ? (
        <Link className={settings.additionLink} href={step.centerRoute}>
          Open Pin status
        </Link>
      ) : null;

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
