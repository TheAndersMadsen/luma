"use client";

/**
 * The primary card — ported from the retired Setup SPA's
 * `install/components/InstallPrimaryCard.tsx`.
 *
 * All of the decision-making still lives in
 * `derivePrimaryCardViewModel(state, commands)` in `@/lib/pin-install`; this
 * component only renders it, which is why the stage copy, the notice tones, the
 * package rows and the primary/secondary/overflow action split are identical to
 * the SPA's.
 *
 * Two Center-specific changes:
 *  - An action with an `href` renders as a `next/link`, so the post-install
 *    hand-off and the device shell are client-side navigations rather than full
 *    page loads.
 *  - The `openTerminal` overflow action becomes a LINK to the operator-gated
 *    /admin/pin/terminal instead of swapping an in-page terminal card into the
 *    installer. A browser-reachable root shell on someone's device is not a
 *    wearer affordance, so it is a separate operator route, and the entry only
 *    appears at all when the server has confirmed this session is an operator's
 *    (`terminalHref === null` for everyone else).
 */

import Link from "next/link";
import { useState } from "react";
import {
  derivePrimaryCardViewModel,
  type PrimaryCardActionViewModel,
} from "@/lib/pin-install";
import { StatusChip, StatusMessage } from "@/components/Status";
import styles from "./install.module.css";
import { ConnectionHelpModal } from "./ConnectionHelpModal";
import { OverflowMenu } from "./OverflowMenu";
import { PackageStatusList } from "./PackageStatusList";
import type { InstallController } from "./useInstallController";

export interface PrimaryCardHandlers {
  onPrimaryAction: () => void;
  onRollback: () => void;
  onUninstall: () => void;
  onRemoveConflicts: () => void;
}

function runAction(options: {
  action: PrimaryCardActionViewModel;
  controller: InstallController;
  handlers: PrimaryCardHandlers;
}) {
  const { action, controller, handlers } = options;

  if (action.disabled) {
    return;
  }

  switch (action.key) {
    case "rollback":
      handlers.onRollback();
      return;
    case "primaryAction":
      handlers.onPrimaryAction();
      return;
    case "installApkFile":
      void controller.runInstallApkFile();
      return;
    case "uninstall":
      handlers.onUninstall();
      return;
    case "removeConflicts":
      handlers.onRemoveConflicts();
      return;
    case "connect":
      void controller.connectAndInspect();
      return;
    case "recheck":
      void controller.recheck();
      return;
    case "startOver":
      void controller.startOver();
      return;
    default:
      // `openTerminal` and `goToCenter` are links; they never reach here.
      return;
  }
}

function ActionControl({
  action,
  controller,
  handlers,
  className,
  linkClassName,
}: {
  action: PrimaryCardActionViewModel;
  controller: InstallController;
  handlers: PrimaryCardHandlers;
  className: string;
  linkClassName: string;
}) {
  if (action.href) {
    return (
      <Link href={action.href} className={linkClassName}>
        {action.label}
      </Link>
    );
  }

  return (
    <button
      type="button"
      className={className}
      onClick={() => runAction({ action, controller, handlers })}
      disabled={action.disabled}
      title={action.reason ?? undefined}
    >
      {action.label}
    </button>
  );
}

export function InstallPrimaryCard({
  controller,
  handlers,
  terminalHref,
}: {
  controller: InstallController;
  handlers: PrimaryCardHandlers;
  /** /admin/pin/terminal for an operator session; null for everyone else. */
  terminalHref: string | null;
}) {
  const viewModel = derivePrimaryCardViewModel(
    controller.state,
    controller.commands,
  );
  const [helpOpen, setHelpOpen] = useState(false);
  const showConnectionHelp = viewModel.primaryAction?.key === "connect";

  // The view model always offers a terminal entry once a device is attached.
  // Center only shows it to an operator, and points it at the gated route.
  const overflowActions = viewModel.overflowActions.flatMap((action) => {
    if (action.key !== "openTerminal") {
      return [action];
    }

    if (!terminalHref) {
      return [];
    }

    return [{ ...action, label: "Device shell", href: terminalHref }];
  });

  return (
    <section className={styles.card} aria-labelledby="install-stage-title">
      <div className={styles.cardBody}>
        <header className={styles.heading}>
          <h2 id="install-stage-title" className={styles.title}>
            {viewModel.title}
          </h2>
          <p className={styles.copy}>{viewModel.copy}</p>
        </header>

        {viewModel.notice ? (
          <StatusMessage tone={viewModel.notice.tone}>
            {viewModel.notice.text}
          </StatusMessage>
        ) : null}

        {viewModel.showProgress ? (
          <div className={styles.progress} aria-live="polite">
            <div className={styles.progressMeta}>
              <span>In progress</span>
              <span>{viewModel.progressPercent}%</span>
            </div>
            <progress
              className={styles.progressBar}
              max={100}
              value={viewModel.progressPercent}
            />
          </div>
        ) : null}

        {viewModel.device ? (
          <section className={styles.device} aria-label="Connected device">
            <div className={styles.deviceHead}>
              <div className={styles.deviceIdentity}>
                <div className={styles.deviceName}>{viewModel.device.name}</div>
                <div className={styles.deviceSerial}>{viewModel.device.serial}</div>
              </div>
              {viewModel.device.badge ? (
                <StatusChip
                  tone={viewModel.device.badge === "Ai Pin" ? "live" : "degraded"}
                  variant="tag"
                  label={viewModel.device.badge}
                  detail={
                    viewModel.device.badge === "Ai Pin"
                      ? "This device matches the recognized Humane Ai Pin identity."
                      : "This device does not match the recognized Humane Ai Pin identity check."
                  }
                />
              ) : null}
            </div>

            <PackageStatusList
              ariaLabel="Managed packages and detected conflicts"
              rows={viewModel.packageRows.map((pkg) => ({
                id: `${pkg.category ?? "managed"}-${pkg.role}`,
                ...pkg,
              }))}
              conflictRows={viewModel.conflictRows.map((pkg) => ({
                id: `${pkg.category ?? "conflict"}-${pkg.role}`,
                ...pkg,
              }))}
            />
          </section>
        ) : null}
      </div>

      <footer className={styles.footer}>
        <div className={styles.primarySlot}>
          {viewModel.primaryAction ? (
            <ActionControl
              action={viewModel.primaryAction}
              controller={controller}
              handlers={handlers}
              className={styles.primaryButton}
              linkClassName={styles.primaryLink}
            />
          ) : null}
        </div>

        {viewModel.secondaryActions.length > 0 ||
        showConnectionHelp ||
        overflowActions.length > 0 ? (
          <div className={styles.linksWrap}>
            <nav className={styles.links} aria-label="More actions">
              {viewModel.secondaryActions.map((action) => (
                <ActionControl
                  key={action.key}
                  action={action}
                  controller={controller}
                  handlers={handlers}
                  className={styles.link}
                  linkClassName={styles.link}
                />
              ))}
              {showConnectionHelp ? (
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => setHelpOpen(true)}
                >
                  Connection help
                </button>
              ) : null}
            </nav>
            {overflowActions.length > 0 ? (
              <OverflowMenu
                actions={overflowActions}
                onAction={(action) =>
                  runAction({ action, controller, handlers })
                }
              />
            ) : null}
          </div>
        ) : null}
      </footer>

      <ConnectionHelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </section>
  );
}
