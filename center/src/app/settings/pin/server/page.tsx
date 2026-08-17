"use client";

import { useEffect, useId, useMemo, useState } from "react";
import type { UpdateSettingsRequest } from "@/lib/pin-device";
import { StatusMessage } from "@/components/Status";
import styles from "../_lib/panes.module.css";
import {
  DeviceRequired,
  FormRow,
  PaneLoadState,
  PaneSection,
  SaveBar,
  ToggleRow,
} from "../_lib/PaneShell";
import { SecretField } from "../_lib/SecretField";
import { UnsavedChangesGuard } from "../_lib/UnsavedChangesGuard";
import { usePinPaneSession } from "../_lib/pinSession";
import { useDeviceSettings } from "../_lib/useDeviceSettings";

/*
 * The Pin's own server: identity, the LAN admin credential, the Wi-Fi listener,
 * and the two prompt templates.
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
 * set the credential a LAN dashboard session would later have to present — so
 * it is write-only, never echoed, and validated before it leaves the browser.
 */

const ADMIN_TOKEN_PATTERN = /^[\x21-\x7e]{32,512}$/;

const SCOPE = "pin-server-pane";

export default function PinServerPane() {
  const { client, connectionError, attachedWithoutServer } = usePinPaneSession();
  const controller = useDeviceSettings(SCOPE);
  const { settings, capabilities } = controller;

  const displayNameId = useId();
  const systemPromptId = useId();
  const statusPromptId = useId();

  const [displayName, setDisplayName] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [lanDashboardEnabled, setLanDashboardEnabled] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [statusPrompt, setStatusPrompt] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  // Re-seed the form whenever the device's own document changes identity —
  // first load, a save from this pane, or a save from another pane sharing the
  // same cache entry. Editing state is deliberately discarded on a real change:
  // silently keeping a stale draft over new device values is how two panes
  // overwrite each other.
  useEffect(() => {
    if (!settings) return;
    setDisplayName(settings.server.display_name ?? "");
    setAdminToken("");
    setLanDashboardEnabled(settings.server.lan_dashboard_enabled ?? false);
    setSystemPrompt(settings.server.system_prompt);
    setStatusPrompt(settings.server.status_prompt ?? "");
    setValidationError(null);
  }, [settings]);

  const request = useMemo<UpdateSettingsRequest | null>(() => {
    if (!settings) return null;
    const server: NonNullable<UpdateSettingsRequest["server"]> = {};

    if (displayName !== (settings.server.display_name ?? "")) {
      server.display_name = displayName;
    }
    if (systemPrompt !== settings.server.system_prompt) {
      server.system_prompt = systemPrompt;
    }
    if (statusPrompt !== (settings.server.status_prompt ?? "")) {
      server.status_prompt = statusPrompt;
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

    return Object.keys(server).length > 0 ? { server } : null;
  }, [
    adminToken,
    capabilities.lanDashboard,
    displayName,
    lanDashboardEnabled,
    settings,
    statusPrompt,
    systemPrompt,
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
          Saved. Restart the Pin to apply the Wi-Fi dashboard listener change.
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
            help="What the assistant calls itself, and the name this Pin announces on the network."
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

        <PaneSection title="Network administration" testId="pin-server-network">
          {capabilities.adminTokenAuth ? (
            <FormRow
              label="LAN admin token"
              help={
                <>
                  Write-only. This is the bearer token a browser on the Pin&rsquo;s Wi-Fi
                  network would have to present to reach the Pin&rsquo;s admin API. It is
                  never read back — the Pin only reports whether one is set. Setting
                  it here goes over Center&rsquo;s authenticated Iroh connection or USB,
                  so the change cannot lock this page out of the device.
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
                This Pin&rsquo;s server does not advertise LAN admin authentication.
                Install a newer Revival release over USB before enabling network
                administration.
              </StatusMessage>
            </div>
          )}

          {capabilities.lanDashboard ? (
            <FormRow
              label="Wi-Fi dashboard"
              help="Takes effect after the Pin restarts. Traffic is protected by the admin token above but uses plaintext HTTP, so enable it only on a network you trust."
            >
              <ToggleRow
                ariaLabel="Wi-Fi dashboard listener"
                copy="Make the authenticated Pin API discoverable and reachable on the Pin's current Wi-Fi network."
                checked={lanDashboardEnabled}
                onChange={setLanDashboardEnabled}
              />
            </FormRow>
          ) : null}
        </PaneSection>

        <PaneSection title="Assistant instructions" testId="pin-server-prompts">
          <FormRow
            label="Main instructions"
            htmlFor={systemPromptId}
            help={
              <>
                Sent before each request. Available{" "}
                <a
                  href="https://handlebarsjs.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Handlebars substitutions
                </a>
                : <code>{"{{run_id}}"}</code>,{" "}
                <code>{"{{assistant_display_name}}"}</code>,{" "}
                <code>{"{{server_public_addr}}"}</code>,{" "}
                <code>{"{{current_timestamp}}"}</code>,{" "}
                <code>{"{{current_date}}"}</code>, <code>{"{{current_time}}"}</code>,{" "}
                <code>{"{{location_name}}"}</code>, <code>{"{{latitude}}"}</code>,{" "}
                <code>{"{{longitude}}"}</code>, <code>{"{{coordinates}}"}</code>. Use
                conditionals like <code>{"{{#if location_name}}"}</code>…
                <code>{"{{/if}}"}</code> for optional values.
              </>
            }
          >
            <textarea
              id={systemPromptId}
              className={styles.textarea}
              rows={8}
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              spellCheck={false}
            />
          </FormRow>

          <FormRow
            label="Status instructions"
            htmlFor={statusPromptId}
            help="Adds current Pin status before each request. Uses the same placeholders as the main instructions."
          >
            <textarea
              id={statusPromptId}
              className={styles.textarea}
              rows={8}
              value={statusPrompt}
              onChange={(event) => setStatusPrompt(event.target.value)}
              spellCheck={false}
            />
          </FormRow>
        </PaneSection>
      </fieldset>

      <UnsavedChangesGuard when={request !== null} />
    </>
  );
}
