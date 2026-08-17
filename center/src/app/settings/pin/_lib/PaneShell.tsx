"use client";

import Link from "next/link";
import settings from "../../settings.module.css";
import styles from "./panes.module.css";
import { StatusMessage, Switch } from "@/components/Status";
import { EmptyState, SectionSkeleton } from "@/components/States";
import { PIN_SERVICE_LOST_MESSAGE } from "../PinDeviceProvider";
import { usePinPaneSession } from "./pinSession";
import type { SaveStatus } from "./useDeviceSettings";

/*
 * The shared furniture for every device pane.
 *
 * These wrap Center's own primitives rather than replacing them: a section is
 * `settings.module.css`'s `.section` (the same surface as
 * /settings/account/devices), an on/off control is the privacy pane's
 * <Switch>, and anything that failed is <StatusMessage>. The panes below
 * therefore inherit Center's one rule about failure colour without restating
 * it seven times.
 */

/**
 * The state every one of these panes is in until a Pin is plugged in — and the
 * different state it is in when a Pin IS plugged in but has no Revival server.
 *
 * Both are ABSENCES, not failures: neither offers a "Try again" that cannot
 * work. They differ in the action that resolves them, which is the whole reason
 * they are told apart. A stock, un-injected Pin answers ADB perfectly and has
 * no server to read settings from; telling that wearer to "connect a Pin" would
 * send them round a loop they are already at the end of.
 */
export function DeviceRequired({
  what,
  connectionError,
  attachedWithoutServer = false,
}: {
  /** What this pane would show, e.g. "eSIM profiles". */
  what: string;
  connectionError?: string | null;
  /** A device is attached, but its Revival server is not answering. */
  attachedWithoutServer?: boolean;
}) {
  return (
    <section className={settings.section} data-testid="pin-device-required">
      <div className={settings.sectionHeader}>
        <span className={settings.sectionTitle}>
          {attachedWithoutServer ? "Pin software needs attention" : "Your Pin is offline"}
        </span>
      </div>
      {attachedWithoutServer ? (
        <EmptyState
          inline
          title="This Pin is connected, but its software needs attention."
          detail={`Update or repair it to use ${what}. Keep the cable connected, then come back.`}
          action={{ label: "Check software", href: "/settings/pin/install" }}
        />
      ) : (
        <EmptyState
          inline
          title={`Your Pin must be online to see ${what}.`}
          detail="Open Connection & maintenance to reconnect or repair it."
          action={{ label: "Open connection & maintenance", href: "/settings/pin" }}
        />
      )}
      {connectionError ? (
        <div className={settings.stateRow}>
          <StatusMessage tone="warning">{connectionError}</StatusMessage>
        </div>
      ) : null}
    </section>
  );
}

/** A maintenance surface that intentionally requires physical possession. */
export function UsbRequired({ what }: { what: string }) {
  return (
    <section className={settings.section} data-testid="pin-usb-required">
      <div className={settings.sectionHeader}>
        <span className={settings.sectionTitle}>Connect your Pin with a cable</span>
      </div>
      <EmptyState
        inline
        title={`A cable is required to manage ${what}.`}
        detail="Everyday settings work wirelessly. This maintenance action requires physical access to protect your Pin."
        action={{ label: "Open connection help", href: "/settings/pin" }}
      />
    </section>
  );
}

/**
 * "This Pin's server stopped answering" — said once, above whatever pane the
 * wearer is on.
 *
 * WHY IT IS HERE AND NOT IN THE PANES. The health monitor downgrades the SERVICE
 * without dropping the USB session, deliberately: the device is physically
 * attached and the installer may be mid-reboot. So it sets `serviceStatus =
 * "offline"` and `PIN_SERVICE_LOST_MESSAGE`, and leaves `client` non-null. Every
 * pane except four rendered that message only inside <DeviceRequired>, which
 * they reach through `if (!client)` — a branch this condition is defined never
 * to take. The message was therefore structurally unreachable on nine panes.
 *
 * What a wearer got instead: they were on /settings/pin/server when the Pin's
 * server stopped answering (a routine reboot during an install does this), and
 * the pane went on rendering a fully populated, editable settings form out of a
 * React Query cache, with an enabled Save button and nothing at all to say the
 * device was gone. They edited fields against a Pin that was not listening and
 * found out when they pressed Save. Same on llm, services, diagnostics, flags,
 * esim, activity, fitness and contacts.
 *
 * A BANNER, not a replacement screen. `serviceStatus` has no route back to
 * "online" except `refreshService()`, which is only reachable from the Connect
 * pane — so a pane that swapped itself out for this message would stay swapped
 * out after the Pin came back, which is exactly the mid-reboot survivability the
 * provider goes out of its way to protect.
 */
export function PinServiceLostBanner() {
  const { client, serviceStatus, connectionError } = usePinPaneSession();
  if (!client || serviceStatus !== "offline") return null;
  return (
    <div className={settings.stateRow} data-testid="pin-service-lost">
      <StatusMessage tone="warning">
        {connectionError ?? PIN_SERVICE_LOST_MESSAGE}
      </StatusMessage>
    </div>
  );
}

/** One settings surface, identical in shape to /settings/account/devices. */
export function PaneSection({
  title,
  action,
  testId,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={settings.section} data-testid={testId}>
      <div className={settings.sectionHeader}>
        <span className={settings.sectionTitle}>{title}</span>
        {action ?? null}
      </div>
      {children}
    </section>
  );
}

/**
 * The gate in front of a control that wipes a whole category off the device.
 *
 * `confirm()` is what the rest of this console uses for a single record, and it
 * is enough there. It is not enough here. Its default button is the destructive
 * one in every browser the console runs in, so a stray click on "Delete all"
 * followed by a reflexive Enter destroys the category before any sentence has
 * been read — and unlike one note, there is nothing left to compare against
 * afterwards to notice it happened.
 *
 * So the first press only ARMS. It swaps the control for the question, which
 * names the count and the category, and for two buttons in a different place
 * from the one just pressed: Cancel first, the destructive one second, neither
 * focused. Nothing reaches the Pin until that second press.
 */
export function ArmedClearControl({
  armed,
  question,
  armLabel,
  confirmLabel,
  busy = false,
  disabled = false,
  onArm,
  onCancel,
  onConfirm,
  testId,
}: {
  armed: boolean;
  /** States the count and the category. See clearActivityConfirmation. */
  question: string;
  armLabel: string;
  confirmLabel: string;
  /** The clear is in flight. */
  busy?: boolean;
  /**
   * Some other device operation is running, so a wipe must not start.
   *
   * Applies in BOTH states. Gating only the arm button would mean a control
   * armed a moment earlier stays live: on the Activity pane `disabled` also
   * carries "a page of older rows is in flight", and confirming into that race
   * empties the list and then has the late page re-populate it with rows the
   * device has just deleted.
   */
  disabled?: boolean;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  testId?: string;
}) {
  if (!armed) {
    return (
      <div className={styles.clearRow} data-testid={testId}>
        <button
          type="button"
          className={styles.linkButton}
          onClick={onArm}
          disabled={disabled}
          data-testid={testId ? `${testId}-arm` : undefined}
        >
          {armLabel}
        </button>
      </div>
    );
  }

  return (
    <div className={styles.clearRow} data-testid={testId} data-armed="true">
      {/* Announced, because arming changed the meaning of the next click. */}
      <p className={styles.clearQuestion} role="alert">
        {question}
      </p>
      <span className={styles.chipRow}>
        <button
          type="button"
          className={styles.quietButton}
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        {/* Cancel stays reachable whatever else is running; only the wipe is gated. */}
        <button
          type="button"
          className={styles.dangerButton}
          onClick={onConfirm}
          disabled={busy || disabled}
          data-testid={testId ? `${testId}-confirm` : undefined}
        >
          {busy ? "Deleting…" : confirmLabel}
        </button>
      </span>
    </div>
  );
}

/** A labelled control, its help prose, and any inline validation. */
export function FormRow({
  label,
  htmlFor,
  help,
  children,
  testId,
}: {
  label: string;
  htmlFor?: string;
  help?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className={styles.formRow} data-testid={testId}>
      <div className={styles.field}>
        {htmlFor ? (
          <label className={styles.formLabel} htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className={styles.formLabel}>{label}</span>
        )}
        {children}
        {help ? <p className={styles.formHelp}>{help}</p> : null}
      </div>
    </div>
  );
}

/** Copy on the left, one <Switch> on the right. */
export function ToggleRow({
  copy,
  checked,
  onChange,
  disabled = false,
  ariaLabel,
}: {
  copy: React.ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <div className={styles.toggleRow}>
      <span className={styles.toggleCopy}>{copy}</span>
      <Switch
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        ariaLabel={ariaLabel}
      />
    </div>
  );
}

/**
 * An explicit acknowledgement gate.
 *
 * Kept as a real checkbox rather than a <Switch>: it is a statement the wearer
 * makes, not a capability they operate, and the SPA's own copy is a sentence
 * that has to stay legible next to the box.
 */
export function AcknowledgementRow({
  checked,
  onChange,
  disabled = false,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={styles.checkboxRow}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

/** The save affordance, with the save state rendered next to it, not under it. */
export function SaveBar({
  status,
  error,
  dirty,
  onSave,
  label = "Save changes",
}: {
  status: SaveStatus;
  error: string | null;
  dirty: boolean;
  onSave: () => void;
  label?: string;
}) {
  return (
    <div className={styles.saveBar}>
      {status === "saving" ? (
        <span className={styles.saveState} role="status" aria-live="polite">Saving…</span>
      ) : status === "saved" ? (
        <span className={`${styles.saveState} ${styles.saveStateSaved}`} role="status" aria-live="polite">Saved</span>
      ) : null}
      <button
        type="button"
        className={styles.primaryButton}
        disabled={!dirty || status === "saving"}
        onClick={onSave}
        data-testid="pin-save-button"
      >
        {status === "saving" ? "Saving…" : label}
      </button>
      {status === "error" && error ? (
        <StatusMessage tone="danger">{error}</StatusMessage>
      ) : null}
    </div>
  );
}

/**
 * Loading / failed states for a pane whose whole body comes from the device.
 *
 * Deliberately keyed on the ERROR, not on a loading flag: React Query reports
 * neither `isLoading` nor an error for a refetch that is queued but has not
 * started, and branching on the flag renders a blank pane in that window.
 * "Not failed yet" is the skeleton.
 */
export function PaneLoadState({
  error,
  onRetry,
  rows = 4,
}: {
  error: string | null;
  onRetry: () => void;
  rows?: number;
}) {
  if (!error) return <SectionSkeleton rows={rows} />;
  return (
    <section className={settings.section}>
      <div className={settings.stateRow}>
        <StatusMessage tone="warning" onRetry={onRetry}>
          {error}
        </StatusMessage>
      </div>
    </section>
  );
}

/**
 * The cross-link every pane carries to the OTHER feature-flag authority.
 *
 * Center's /settings/account/features is a cloud allowlist for the wearer's
 * account; /settings/pin/flags writes the device's own assignment set. They are
 * different authorities with overlapping vocabulary, so the distinction is
 * stated in the UI rather than left for a support thread to discover.
 */
export function CrossAuthorityNote({
  children,
  href,
  linkLabel,
}: {
  children: React.ReactNode;
  href: string;
  linkLabel: string;
}) {
  return (
    <div className={settings.additionRow}>
      <span className={settings.additionRowText}>
        <span className={settings.additionRowDesc}>{children}</span>
      </span>
      <Link className={settings.additionLink} href={href}>
        {linkLabel}
      </Link>
    </div>
  );
}
