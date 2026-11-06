"use client";

import { useEffect, useId, useMemo, useState } from "react";
import type { TemperatureUnit, UpdateSettingsRequest } from "@/lib/pin-device";
import { StatusMessage } from "@/components/Status";
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
import { SecretField } from "../_lib/SecretField";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { usePinPaneSession } from "../_lib/pinSession";
import { useDeviceSettings } from "../_lib/useDeviceSettings";

/*
 * The Pin's own server: identity, the LAN admin credential and the Wi-Fi listener.
 *
 * Ported from the "Server" card of the retired Setup SPA's
 * `SettingsPage.tsx:886-1059`.
 *
 * The admin-token control is the one genuinely dangerous field on this pane and
 * it has changed meaning in Center. In the SPA the rotation was performed by a
 * LAN session that then had to re-authenticate itself with the new value, which
 * is why PinClient carries a whole reconciliation path and an
 * AdminTokenRotationUncertainError. Center now uses either its authenticated
 * Iroh route or USB, neither of which authenticates with this LAN token, so
 * `updateSettings` takes the plain success path. What the field still does is
 * set the credential a LAN dashboard session would later have to present, so
 * it is write-only, never echoed, and validated before it leaves the browser.
 */

const ADMIN_TOKEN_PATTERN = /^[\x21-\x7e]{32,512}$/;

const SCOPE = "pin-server-pane";

export default function PinServerPane() {
  const { client, connectionError, attachedWithoutServer } = usePinPaneSession();
  const controller = useDeviceSettings(SCOPE);
  const { settings, capabilities } = controller;

  const displayNameId = useId();
  const temperatureUnitId = useId();

  const [displayName, setDisplayName] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [lanDashboardEnabled, setLanDashboardEnabled] = useState(false);
  const [temperatureUnit, setTemperatureUnit] = useState<TemperatureUnit | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Re-seed the form whenever the device's own document changes identity,
  // first load, a save from this pane, or a save from another pane sharing the
  // same cache entry. Editing state is deliberately discarded on a real change:
  // silently keeping a stale draft over new device values is how two panes
  // overwrite each other.
  useEffect(() => {
    if (!settings) return;
    setDisplayName(settings.server.display_name ?? "");
    setAdminToken("");
    setLanDashboardEnabled(settings.server.lan_dashboard_enabled ?? false);
    setTemperatureUnit(settings.units?.temperature_unit ?? null);
    setValidationError(null);
  }, [settings]);

  const request = useMemo<UpdateSettingsRequest | null>(() => {
    if (!settings) return null;
    const server: NonNullable<UpdateSettingsRequest["server"]> = {};

    if (displayName !== (settings.server.display_name ?? "")) {
      server.display_name = displayName;
    }
    if (adminToken !== "") {
      server.admin_token = adminToken;
    }
    if (
      capabilities.lanDashboard &&
      lanDashboardEnabled !== (settings.server.lan_dashboard_enabled ?? false)
    ) {
      server.lan_dashboard_enabled = lanDashboardEnabled;
    }

    const next: UpdateSettingsRequest = {};
    if (Object.keys(server).length > 0) next.server = server;
    if (
      capabilities.temperatureUnit &&
      temperatureUnit !== null &&
      temperatureUnit !== settings.units?.temperature_unit
    ) {
      next.units = { temperature_unit: temperatureUnit };
    }
    return Object.keys(next).length > 0 ? next : null;
  }, [
    adminToken,
    capabilities.lanDashboard,
    capabilities.temperatureUnit,
    displayName,
    lanDashboardEnabled,
    settings,
    temperatureUnit,
  ]);

  async function handleSave() {
    if (!request) return;

    // Validate the credential HERE rather than letting the device reject it:
    // a rejected rotation over LAN is the ambiguous case PinClient has to
    // reconcile, and the cheapest way to never enter it is to not send a token
    // the server would refuse.
    if (
      request.server?.admin_token !== undefined &&
      !ADMIN_TOKEN_PATTERN.test(request.server.admin_token)
    ) {
      setValidationError(
        "The admin token must be 32–512 visible ASCII characters with no spaces.",
      );
      return;
    }
    setValidationError(null);
    await controller.save(request);
  }

  if (client?.mode === "remote") {
    return <UsbRequired what="this Pin's server settings" />;
  }

  if (!client) {
    return <DeviceRequired
        attachedWithoutServer={attachedWithoutServer} what="this Pin's server settings" connectionError={connectionError} />;
  }

  if (!settings) {
    return (
      <PaneLoadState
        error={controller.loadError}
        onRetry={controller.reload}
        rows={5}
      />
    );
  }

  const saving = controller.saveStatus === "saving";

  return (
    <>
      <SaveBar
        status={controller.saveStatus}
        error={validationError ?? controller.saveError}
        dirty={request !== null}
        onSave={() => void handleSave()}
      />

      {validationError ? (
        <StatusMessage tone="danger">{validationError}</StatusMessage>
      ) : null}

      {controller.restartRequired ? (
        <StatusMessage tone="warning">
          Saved. Restart the Pin to apply this change.
        </StatusMessage>
      ) : null}

      <fieldset
        className={styles.fieldset}
        disabled={saving}
        aria-busy={saving}
      >
        <PaneSection title="Identity" testId="pin-server-identity">
          <FormRow
            label="Display name"
            htmlFor={displayNameId}
            help="How this Pin is identified in Center and on its local network."
          >
            <input
              id={displayNameId}
              className={styles.input}
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="My Ai Pin"
            />
          </FormRow>
        </PaneSection>

        <PaneSection title="Weather" testId="pin-server-weather">
          {capabilities.temperatureUnit && temperatureUnit !== null ? (
            <FormRow
              label="Temperature unit"
              htmlFor={temperatureUnitId}
              help="How the weather card on the Pin shows the temperature. To hear spoken answers in the same unit, add it to your custom instructions in Assistant & voice."
            >
              <select
                id={temperatureUnitId}
                className={styles.input}
                value={temperatureUnit}
                onChange={(event) => setTemperatureUnit(event.target.value as TemperatureUnit)}
              >
                <option value="fahrenheit">Fahrenheit (°F)</option>
                <option value="celsius">Celsius (°C)</option>
              </select>
            </FormRow>
          ) : (
            <div className={styles.formRow}>
              <StatusMessage tone="warning">
                Update the Pin apps to choose the temperature unit.
              </StatusMessage>
            </div>
          )}
        </PaneSection>

        <PaneSection title="Network administration" testId="pin-server-network">
          {capabilities.adminTokenAuth ? (
            <FormRow
              label="LAN admin token"
              help={
                <>
                  Used by the Pin&rsquo;s local Wi-Fi API. It is write-only and does not
                  affect Center&rsquo;s connection.
                </>
              }
            >
              <SecretField
                value={adminToken}
                onChange={setAdminToken}
                hasExisting={false}
                placeholder="Set a new 32–512 character token"
                ariaLabel="LAN admin token"
              />
            </FormRow>
          ) : (
            <div className={styles.formRow}>
              <StatusMessage tone="warning">
                Update the Pin before enabling network administration.
              </StatusMessage>
            </div>
          )}

          {capabilities.lanDashboard ? (
            <FormRow
              label="Wi-Fi dashboard"
              help="Takes effect after restart. Enable only on a trusted network; it uses HTTP."
            >
              <ToggleRow
                ariaLabel="Wi-Fi dashboard listener"
                copy="Make the Pin's local API available over Wi-Fi."
                checked={lanDashboardEnabled}
                onChange={setLanDashboardEnabled}
              />
            </FormRow>
          ) : null}
        </PaneSection>

      </fieldset>

      <UnsavedChangesGuard when={request !== null} />
    </>
  );
}
