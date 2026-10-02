"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { UpdateSettingsRequest } from "@/lib/pin-device";
import { logError, logInfo } from "@/lib/pin-device";
import { StatusMessage } from "@/components/Status";
import settings from "../../settings.module.css";
import styles from "../_lib/panes.module.css";
import {
  DeviceRequired,
  FormRow,
  PaneLoadState,
  PaneSection,
  SaveBar,
  ToggleRow,
  UsbRequired,
} from "../_lib/PaneShell";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { usePinPaneSession } from "../_lib/pinSession";
import { deviceErrorMessage } from "../_lib/deviceErrorPresentation";
import { useDeviceSettings } from "../_lib/useDeviceSettings";
import { saveTextFile } from "../_lib/fitnessPresentation";

/*
 * Diagnostics: the one real security control the Pin exposes, its logs, and the
 * software it reports running.
 *
 * Ported from the retired Setup SPA's `SettingsPage.tsx:2142-2205` (Developer +
 * Logs), with its Device Software card folded in as a read-only section.
 *
 * "Remote APK install" is not a developer convenience, it is the switch that
 * decides whether the Pin will accept an APK pushed to it over plain HTTP. It
 * is presented as a security control with its consequence stated, not as a
 * checkbox in a Developer accordion.
 *
 * Log downloads go straight from the device to a blob: URL and a synthetic
 * anchor click. Nothing is uploaded to Center and nothing is written to the
 * server: the bytes travel over the same WebUSB/ADB session as everything else
 * on this pane, so an operator can capture a log from a Pin that has no network
 * at all.
 */

const SCOPE = "pin-diagnostics-pane";

type LogKind = "server" | "logcat";

const LOG_FILENAMES: Record<LogKind, string> = {
  server: "humane-server.log",
  logcat: "penumbra-logcat.log",
};

export default function PinDiagnosticsPane() {
  const { client, device, connectionError, attachedWithoutServer } = usePinPaneSession();
  const usbClient = client?.mode === "usb" ? client : null;
  const controller = useDeviceSettings(SCOPE);
  const { settings: saved } = controller;

  const [apkInstallEnabled, setApkInstallEnabled] = useState(false);
  const [downloading, setDownloading] = useState<LogKind | null>(null);
  const [logError_, setLogError] = useState<string | null>(null);

  useEffect(() => {
    if (!saved) return;
    setApkInstallEnabled(saved.dev?.apk_install_enabled ?? false);
  }, [saved]);

  const request = useMemo<UpdateSettingsRequest | null>(() => {
    if (!saved) return null;
    if (apkInstallEnabled === (saved.dev?.apk_install_enabled ?? false)) return null;
    return { dev: { apk_install_enabled: apkInstallEnabled } };
  }, [apkInstallEnabled, saved]);

  async function downloadLogs(kind: LogKind) {
    if (!usbClient || downloading) return;
    setLogError(null);
    setDownloading(kind);
    try {
      logInfo(SCOPE, "Downloading device logs", { kind });
      const result = await usbClient.fetchLogs(kind);
      if (!result.available) {
        // A 503 from the device means "this log is not collectable here", which
        // is a fact about the device, not a transport failure. The Pin's own
        // sentence is more useful than anything Center could invent.
        setLogError(result.text || `The Pin cannot provide ${kind} logs.`);
        return;
      }
      saveTextFile(LOG_FILENAMES[kind], result.text);
      logInfo(SCOPE, "Device logs downloaded", { kind });
    } catch (error) {
      const message = deviceErrorMessage(error, `Couldn’t download ${kind} logs.`);
      logError(SCOPE, "Failed to download device logs", error, { kind });
      setLogError(message);
    } finally {
      setDownloading(null);
    }
  }

  if (client?.mode === "remote") {
    return <UsbRequired what="software installation and device diagnostics" />;
  }

  if (!usbClient) {
    return (
      <DeviceRequired
        attachedWithoutServer={attachedWithoutServer} what="this Pin's diagnostics" connectionError={connectionError} />
    );
  }

  if (!saved) {
    return (
      <PaneLoadState
        error={controller.loadError}
        onRetry={controller.reload}
        rows={4}
      />
    );
  }

  const saving = controller.saveStatus === "saving";
  const versions = device?.versions;

  return (
    <>
      <SaveBar
        status={controller.saveStatus}
        error={controller.saveError}
        dirty={request !== null}
        onSave={() => {
          if (request) void controller.save(request);
        }}
      />

      <fieldset
        className={styles.fieldset}
        disabled={saving}
        aria-busy={saving}
      >
        <PaneSection title="Remote APK install" testId="pin-diagnostics-apk">
          <FormRow label="Accept APK uploads over the network">
            <ToggleRow
              ariaLabel="Remote APK install"
              copy="Allow this Pin to accept an APK uploaded to its HTTP API and install it."
              checked={apkInstallEnabled}
              onChange={setApkInstallEnabled}
            />
            <StatusMessage tone={apkInstallEnabled ? "warning" : "info"}>
              {apkInstallEnabled
                ? "Remote installs are enabled. Turn this off when you finish."
                : "Off. Use the USB installer to install software."}
            </StatusMessage>
          </FormRow>
        </PaneSection>
      </fieldset>

      <PaneSection title="Device logs" testId="pin-diagnostics-logs">
        <div className={styles.formRow}>
          <p className={styles.formHelp}>
            Downloaded directly from the Pin over USB. Logs can contain personal data.
          </p>
          <div className={styles.actionRow}>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={downloading !== null}
              onClick={() => void downloadLogs("server")}
            >
              {downloading === "server" ? "Downloading…" : "Download server log"}
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={downloading !== null}
              onClick={() => void downloadLogs("logcat")}
            >
              {downloading === "logcat" ? "Downloading…" : "Download logcat"}
            </button>
          </div>
          {logError_ ? <StatusMessage tone="warning">{logError_}</StatusMessage> : null}
        </div>
      </PaneSection>

      <PaneSection title="Software on this Pin" testId="pin-diagnostics-versions">
        {versions ? (
          <div className={styles.formRow}>
            <p className={styles.formHelp}>
              Versions reported by the connected Pin.
            </p>
            <dl className={styles.factList}>
              <dt>arcOS</dt>
              <dd>{versions.os.humane_display_version || "Unavailable"}</dd>
              {versions.components.map((component) => (
                <ComponentVersionRow
                  key={component.package_name}
                  label={component.label}
                  version={component.version_name}
                />
              ))}
            </dl>
          </div>
        ) : (
          <div className={settings.stateRow}>
            <span className={settings.muted}>
              This Pin&rsquo;s server does not report component versions.
            </span>
          </div>
        )}
      </PaneSection>

      <PaneSection title="Elsewhere" testId="pin-diagnostics-elsewhere">
        <div className={settings.additionRow}>
          <span className={settings.additionRowText}>
            <span className={settings.additionRowTitle}>Software &amp; updates</span>
            <span className={settings.additionRowDesc}>
              Update, install or repair Luma over USB.
            </span>
          </span>
          <Link className={settings.additionLink} href="/settings/pin/install">
            Open
          </Link>
        </div>
        <div className={settings.additionRow}>
          <span className={settings.additionRowText}>
            <span className={settings.additionRowTitle}>
              Device Recovery Console
              <span className={styles.inlineTag}>Operators only</span>
            </span>
            <span className={settings.additionRowDesc}>
              Full administrator access for recovering a failed installation. Operators only.
            </span>
          </span>
          <Link className={settings.additionLink} href="/admin/pin/terminal">
            Open
          </Link>
        </div>
      </PaneSection>

      <UnsavedChangesGuard when={request !== null} />
    </>
  );
}

function ComponentVersionRow({
  label,
  version,
}: {
  label: string;
  version: string | null | undefined;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{version && version.trim() ? version : "Unavailable"}</dd>
    </>
  );
}
