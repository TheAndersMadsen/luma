"use client";

/**
 * The Device Installer, as a Center pane.
 *
 * Replaces the retired Setup SPA's `install/app/InstallApp.tsx`. The pipeline
 * it drives is unchanged and complete: connect over WebUSB → inspect the
 * installed packages → resolve and lock a verified release target → download
 * and SHA-256 verify the artifacts → remove known conflicts → bootstrap the
 * installer through the setup-helper flow (with its restarts) → install the five
 * APK roles → configure → verify readiness. Uninstall, conflict removal and
 * local-APK install are all still here, each behind its
 * confirmation.
 *
 * The one structural difference from the SPA: the ADB session is shared. It
 * comes from `@/lib/pin-session`, which holds exactly one
 * `WebUsbAdbSessionTransport` at module scope for the whole tab, so the
 * installer and every configuration pane under /settings/pin talk to the same
 * device over the same handle, and navigating away mid-flow cannot unplug it,
 * because nothing here disconnects on unmount.
 */

import { useEffect, useState } from "react";
import {
  disconnectPinAdbSession,
  getWearerPinAdbSession,
  usePinAdbSession,
} from "@/lib/pin-session";
import { GuidedSetupReturn } from "@/components/GuidedSetupReturn";
import { installedLumaRelease } from "@/lib/pin-install";
import { rememberPinRelease } from "@/lib/updateNotices";
import styles from "./install.module.css";
import { ConfirmActionModal } from "./ConfirmActionModal";
import { InstallDiagnosticsCard } from "./InstallDiagnosticsCard";
import { InstallPrimaryCard } from "./InstallPrimaryCard";
import { useInstallActionConfirmation } from "./useInstallActionConfirmation";
import { useInstallController } from "./useInstallController";

export default function InstallView({
  terminalHref = null,
  postInstallLink,
}: {
  /** Where a successful install leads: Guided setup when the wearer came from it. */
  postInstallLink?: { readonly label: string; readonly href: string };
  /**
   * /admin/pin/terminal when the server confirmed an operator session, null
   * otherwise. Passed down rather than derived here: the operator claim is a
   * server-side fact and a client component must not be the one deciding it.
   */
  terminalHref?: string | null;
}) {
  /*
   * One session for the tab, in its WEARER form. `/settings/pin/install` is an
   * ungated wearer path, so this pane must not be able to reach the device
   * shell or a free-form ADB service, `getWearerPinAdbSession()` is the
   * accessor that carries neither. It creates the transport but never connects
   * it: `connect()` needs a user gesture, and the controller issues it from the
   * "Connect Device" click. The façade re-resolves the underlying transport on
   * every call, so holding it in `useState` stays correct across a disconnect.
   */
  const [session] = useState(() => getWearerPinAdbSession());
  const sessionState = usePinAdbSession();
  const controller = useInstallController({
    session,
    releaseDevice: disconnectPinAdbSession,
    postInstallLink,
  });

  const confirmation = useInstallActionConfirmation({
    state: controller.state,
    commands: controller.commands,
    runPrimaryAction: controller.runPrimaryAction,
    runUninstall: controller.runUninstall,
    runRemoveConflicts: controller.runRemoveConflicts,
    runFixConflictsThenPrimaryAction:
      controller.runFixConflictsThenPrimaryAction,
  });

  const { connectAndInspect } = controller;
  const stage = controller.state.stage;
  const pinRelease = installedLumaRelease(controller.state.inspection);

  // The operator's update banner compares this with the Pin release the
  // server now offers ("New Pin apps are ready"). It cannot reach the Pin.
  useEffect(() => {
    rememberPinRelease(pinRelease);
  }, [pinRelease]);
  const alreadyAttached = sessionState.connection !== null;

  /*
   * Adopt a device that was already attached elsewhere (the Connect pane, or a
   * configuration pane the wearer visited first). `connect()` on a live session
   * short-circuits without re-prompting, so this only runs the inspection. It
   * never opens a second WebUSB session and never shows a chooser the wearer
   * did not ask for.
   */
  useEffect(() => {
    if (stage !== "intro" || !alreadyAttached) {
      return;
    }

    void connectAndInspect();
  }, [alreadyAttached, connectAndInspect, stage]);

  return (
    <div className={styles.pane}>
      <InstallPrimaryCard
        controller={controller}
        terminalHref={terminalHref}
        handlers={{
          onPrimaryAction: () => {
            void confirmation.requestPrimaryAction();
          },
          onUninstall: () => {
            void confirmation.requestUninstall();
          },
          onRemoveConflicts: () => {
            void confirmation.requestRemoveConflicts();
          },
        }}
      />

      <InstallDiagnosticsCard controller={controller} />

      <GuidedSetupReturn />

      <ConfirmActionModal
        dialog={confirmation.dialog}
        onCancel={confirmation.dismissDialog}
        onConfirm={confirmation.confirmDialog}
      />
    </div>
  );
}
