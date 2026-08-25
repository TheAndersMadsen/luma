"use client";

/*
 * The provenance primitives.
 *
 * OURS, NOT RECOVERED — none of this was in the Feb-2025 bundle, and that is
 * the point: the recovered .Center talked to a backend that answered. This one
 * talks to a clone that may be unconfigured, may be down, and holds no
 * counterpart at all for several things the original showed. Those are three
 * different sentences and the app used to say all of them in the same grey, or
 * not at all.
 *
 * Four words, everywhere:
 *
 *   live       this came from the configured cosmos backend and is current
 *   absent     no counterpart exists here — a fact about the evidence, not a
 *              runtime outcome, so it never offers a retry and never looks red
 *   degraded   a call failed, so affected wearer data is unavailable — always
 *              with a way to try again
 *   off        a capability that exists but is switched off in this deployment
 */

import Link from "next/link";
import { useState } from "react";
import styles from "./status.module.css";
import { useBackendHealth } from "@/lib/queries";

export type StatusTone = "live" | "absent" | "degraded" | "off";

const TONE_CLASS: Record<StatusTone, string> = {
  live: styles.toneLive,
  absent: styles.toneAbsent,
  degraded: styles.toneDegraded,
  off: styles.toneOff,
};

/**
 * One dot in a pill. `variant="tag"` is the same vocabulary at marker density —
 * the "hidden network", "override", "device"/"server" idioms.
 */
export function StatusChip({
  tone,
  label,
  detail,
  variant = "chip",
  className,
  wrap = false,
}: {
  tone: StatusTone;
  /**
   * Usually a string. Accepts a node so a caller can offer two phrasings and let
   * CSS pick one by width — the chrome badge does that, because a full sentence
   * does not fit a phone's toolbar.
   */
  label: React.ReactNode;
  detail?: string;
  variant?: "chip" | "tag";
  /** Extra class for placement only — never for colour. */
  className?: string;
  /** Let a full sentence wrap instead of truncating. */
  wrap?: boolean;
}) {
  const base = variant === "tag" ? styles.tag : styles.chip;
  return (
    <span
      className={[base, TONE_CLASS[tone], className].filter(Boolean).join(" ")}
      title={detail}
      data-status-tone={tone}
      data-testid="status-chip"
    >
      {variant === "chip" ? <i className={styles.dot} aria-hidden="true" /> : null}
      <span className={wrap ? styles.chipLabelWrap : styles.chipLabel}>{label}</span>
    </span>
  );
}

/**
 * Which backend answered — rendered in the chrome of every page.
 *
 * When Cosmos is configured but not reachable, source routes return empty
 * values with degraded provenance. This component keeps that failure visible
 * across every Center surface without implying saved content is being shown.
 *
 * Renders nothing while loading. Dismissible, because a badge you cannot put
 * away becomes furniture you stop reading.
 */
export function SourceBadge() {
  const { data } = useBackendHealth();
  const [dismissed, setDismissed] = useState(false);

  // Healthy operation is quiet. The global chrome only interrupts the wearer
  // when the backend is degraded or no backend is configured.
  if (!data || dismissed || data.state === "live") return null;

  const state = data.state;

  /*
   * An expired Keycloak grant is degraded, but it is not an outage, and it is
   * the only degraded cause the WEARER can clear. Saying "Your Pin couldn't be
   * reached" here was wrong twice over: it points the wearer at hardware that
   * is fine, and it points whoever is on call at a Cosmos that is answering
   * perfectly. The BFF has flagged this case for a while — 401 plus
   * `reauthenticate` on the routes, `x-data-reauthenticate` on the headers —
   * and nothing on screen read it.
   */
  const expired = data.reauthenticate === true;

  const tone: StatusTone = state === "degraded" ? "degraded" : "absent";

  const label = expired
    ? "Your session expired. Sign in again to see your data."
    : state === "degraded"
      ? "Cosmos couldn't be reached just now."
      : "Connect a Pin to see your data here.";

  /*
   * The same fact, short enough for a phone's toolbar. The full sentence there
   * was squeezed by the flex row into a ~53px column of wrapped text 190px tall.
   * CSS picks one by width; the sentence survives in the title, and the
   * page-level StatusMessage beside the affected content carries it in full.
   */
  const shortLabel = expired ? "Sign in" : state === "degraded" ? "Offline" : "Set up Pin";

  // Keep low-level service responses out of the consumer chrome.
  const detail = label;

  return (
    <span className={styles.sourceBadge} role="status" data-testid="source-badge">
      <StatusChip
        tone={tone}
        label={
          <>
            <span className={styles.badgeLabelFull}>{label}</span>
            <span className={styles.badgeLabelShort}>{shortLabel}</span>
          </>
        }
        detail={detail}
        className={styles.sourceBadgeChip}
        wrap
      />
      {/*
        A way out, not just a diagnosis. Reloading does NOT fix this case — the
        Center cookie is still valid, so middleware has no reason to redirect —
        which is precisely why an expired grant could sit there indefinitely
        looking like an outage. `/login` is always reachable without a session.
      */}
      {expired ? (
        <Link href="/login" className={styles.statusRetry}>
          Sign in
        </Link>
      ) : null}
      <button
        type="button"
        className={styles.badgeDismiss}
        aria-label="Dismiss status"
        onClick={() => setDismissed(true)}
      >
        ✕
      </button>
    </span>
  );
}

/** The one sentence for absence. Also the title on every inert control. */
export const ABSENT_TITLE = "Unavailable";

/**
 * The shared reduced opacity for a control that exists in the recovered
 * original and has no backend here. Pair it with `disabled` and `ABSENT_TITLE`.
 */
export const absentControlClass: string = styles.absentControl;

/**
 * "This backend holds no counterpart for that."
 *
 * One implementation and one stem, replacing five phrasings ("Not exposed by",
 * "No counterpart in", "Not reported by", "unavailable from", "isn't available
 * from"). `why` is one short clause; `evidence` is the longer rationale and
 * stays secondary — a title, never the row's primary text.
 *
 * This is NOT a failure state. It never carries a failure colour and never
 * offers a retry, because retrying cannot make evidence exist.
 */
export function AbsentValue({ why, evidence }: { why?: string; evidence?: string }) {
  const stem = (
    <span className={evidence ? styles.absentEvidence : undefined} title={evidence}>
      {ABSENT_TITLE}
    </span>
  );

  return (
    <span className={styles.absentValue} data-absent="true">
      <span className={styles.absentMark} aria-hidden="true">
        —
      </span>
      <span>
        {stem}
        {why ? <span className={styles.absentWhy}> {why}</span> : null}
      </span>
    </span>
  );
}

/**
 * Anything that failed, or that a wearer needs warning about.
 *
 * The rule this exists to enforce: a failure is never rendered in the caption
 * colour and never in an off-palette hex. `danger` and `warning` come from
 * Humane's own red-100 / orange-100 via --hu-status-*.
 */
export function StatusMessage({
  tone = "info",
  onRetry,
  inline = false,
  children,
}: {
  tone?: "danger" | "warning" | "info";
  onRetry?: () => void;
  /** Sit next to the control that produced it, with no panel of its own. */
  inline?: boolean;
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "danger"
      ? styles.statusDanger
      : tone === "warning"
        ? styles.statusWarning
        : styles.statusInfo;

  return (
    <div
      className={[styles.statusMessage, toneClass, inline ? styles.statusMessageInline : ""]
        .filter(Boolean)
        .join(" ")}
      role={tone === "danger" ? "alert" : "status"}
      data-testid="status-message"
    >
      <span className={styles.statusMark} aria-hidden="true" />
      <span className={styles.statusBody}>{children}</span>
      {onRetry ? (
        <button type="button" className={styles.statusRetry} onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/**
 * One on/off control. Privacy's geometry (46x28, white knob), always
 * `role="switch"` + `aria-checked`, with the console's trailing label as an
 * option — so flipping a feature flag feels like flipping a privacy toggle.
 * Both write a boolean the wearer's device reads.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Visible trailing text. Becomes the control's accessible name. */
  label?: string;
  disabled?: boolean;
  /** Accessible name when the switch has no visible label of its own. */
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`${styles.switchRow} ${checked ? styles.switchOn : ""}`}
      data-testid="switch"
    >
      <span className={styles.switchTrack}>
        <span className={styles.switchKnob} />
      </span>
      {label ? <span className={styles.switchLabel}>{label}</span> : null}
    </button>
  );
}
