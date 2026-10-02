"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  FeatureFlagsResponse,
  SettingsGlobalFeatureGate,
} from "@/lib/pin-device";
import { logError, logInfo } from "@/lib/pin-device";
import { StatusMessage, Switch } from "@/components/Status";
import styles from "../_lib/panes.module.css";
import local from "./flags.module.css";
import {
  CrossAuthorityNote,
  DeviceRequired,
  PaneLoadState,
  PaneSection,
  SaveBar,
} from "../_lib/PaneShell";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { usePinPaneSession } from "../_lib/pinSession";
import { deviceErrorMessage } from "../_lib/deviceErrorPresentation";
import {
  buildSettingsGlobalUpdate,
  createSettingsGlobalDrafts,
  displaySettingsGlobalDraft,
  settingsGlobalRecoveryDraft,
  settingsGlobalRecoveryRequired,
  type SettingsGlobalDrafts,
} from "../_lib/featureFlagsState";

/*
 * The Pin's on-device Android Settings.Global gates (stock `humane_*_enabled`
 * selectors and explicit Luma-owned device features).
 *
 * Stock reads these through ProtoSettings on the device, and no cloud flag can
 * reach them, so they are the one feature-flag plane Center edits on the Pin.
 * Cloud feature flags are not here: stock `FeatureFlagSyncWorker` fetches them
 * with `FeatureFlagsService.GetFlags` over the channel Luma routes to Cosmos,
 * and /settings/account/features edits what Cosmos serves.
 */

type SaveStatus = "idle" | "saving" | "saved" | "error";

const SCOPE = "pin-flags-pane";

// INFERRED: end-user wording for the device-owned catalog in
// pin/runtime/core/src/feature_flags.rs. The Pin still owns values and policy.
const GATE_COPY: Record<string, { label: string; description: string; warning?: string }> = {
  luma_root_access_enabled: {
    label: "Root access",
    description: "Restore full system access a few minutes after each restart.",
    warning: "Experimental. Your Pin may restart or freeze. Requires supported firmware, external power and at least 20% battery.",
  },
  humane_photo_sharing_enabled: {
    label: "Photo sharing",
    description: "Sharing directly from your Pin isn’t available yet. You can still share captures in Center.",
  },
  humane_photography_jpg_enabled: {
    label: "Photo format",
    description: "Photos are saved as JPG so they can upload to Center.",
  },
  humane_food_enabled: {
    label: "Food logging",
    description: "Log food and nutrition from your Pin.",
    warning: "Requires Open Food Facts and its data acknowledgement.",
  },
  humane_health_tracker_enabled: {
    label: "Weather light sensor",
    description: "Try the light-sensor feature in your Pin’s weather display.",
  },
  humane_clock_enabled: {
    label: "Clock setting",
    description: "Timers, alarms and world clocks work without this older setting.",
  },
  humane_cmu_ultra_enabled: {
    label: "Catch Me Up setting",
    description: "Catch Me Up works without this older setting.",
  },
};

const LEGACY_GATES = new Set(["humane_clock_enabled", "humane_cmu_ultra_enabled"]);

export default function PinFlagsPane() {
  const { client, connectionError, attachedWithoutServer } = usePinPaneSession();

  const [data, setData] = useState<FeatureFlagsResponse | null>(null);
  const [drafts, setDrafts] = useState<SettingsGlobalDrafts>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  // Bumped by the retry affordance so the load effect re-runs without a full
  // page reload, which would tear down the shared WebUSB session.
  const [reloadToken, setReloadToken] = useState(0);

  const populate = useCallback((response: FeatureFlagsResponse) => {
    setData(response);
    setDrafts(createSettingsGlobalDrafts(response.settings_global_gates));
  }, []);

  useEffect(() => {
    if (!client) return;

    // The gates belong to one Pin. A client change must not leave the previous
    // Pin's values on screen, or savable, while the new one is still being
    // read. The settings panes draw the same boundary with a per-client cache
    // key, and fitness clears its list for the same reason.
    setData(null);
    setDrafts({});
    setLoadError(null);
    setSaveStatus("idle");
    setSaveMessage(null);

    const controller = new AbortController();
    logInfo(SCOPE, "Loading on-device settings");
    client
      .getFeatureFlags(controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        populate(response);
        setLoadError(null);
        logInfo(SCOPE, "On-device settings loaded", {
          count: response.settings_global_gates.length,
        });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        logError(SCOPE, "Failed to load on-device settings", error);
        setLoadError(deviceErrorMessage(error, "Couldn’t load these settings."));
      });

    return () => controller.abort();
  }, [client, populate, reloadToken]);

  const update = useMemo(
    () => buildSettingsGlobalUpdate(data?.settings_global_gates ?? [], drafts),
    [data, drafts],
  );

  function setDraft(key: string, value: boolean | null) {
    setDrafts((current) => ({ ...current, [key]: value }));
    setSaveStatus("idle");
    setSaveMessage(null);
  }

  async function handleSave() {
    if (!client || !update) return;
    setSaveStatus("saving");
    setSaveMessage(null);
    const count = Object.keys(update).length;
    logInfo(SCOPE, "Saving on-device settings", { count });
    try {
      populate(await client.updateFeatureFlags({ settings_global: update }));
      setSaveStatus("saved");
      setSaveMessage("Changes saved.");
      logInfo(SCOPE, "On-device settings saved", { count });
    } catch (error) {
      setSaveStatus("error");
      setSaveMessage(deviceErrorMessage(error, "Couldn’t save your changes."));
      logError(SCOPE, "Failed to save on-device settings", error);
    }
  }

  if (!client) {
    return (
      <DeviceRequired
        attachedWithoutServer={attachedWithoutServer}
        what="these settings"
        connectionError={connectionError}
      />
    );
  }

  if (!data) {
    return (
      <PaneLoadState
        error={loadError}
        onRetry={() => setReloadToken((token) => token + 1)}
        rows={4}
      />
    );
  }

  const saving = saveStatus === "saving";
  // Unused legacy selectors stay out of everyday controls. Recovery must stay
  // visible if the Pin reports an unsafe value. Grouping never changes policy.
  const isTechnical = (gate: SettingsGlobalFeatureGate) =>
    LEGACY_GATES.has(gate.key) && !settingsGlobalRecoveryRequired(gate);
  const mainGates = data.settings_global_gates.filter((gate) => !isTechnical(gate));
  const technicalGates = data.settings_global_gates.filter(isTechnical);

  const renderGate = (gate: SettingsGlobalFeatureGate) => (
    <GateControl
      key={gate.key}
      gate={gate}
      draft={drafts[gate.key]}
      onChange={(value) => setDraft(gate.key, value)}
      onReset={() => setDraft(gate.key, null)}
    />
  );

  return (
    <>
      <SaveBar
        status={saveStatus}
        error={saveStatus === "error" ? saveMessage : null}
        dirty={update !== null}
        onSave={() => void handleSave()}
        label="Save changes"
      />

      {saveStatus === "saved" && saveMessage ? (
        <StatusMessage tone="info">{saveMessage}</StatusMessage>
      ) : null}

      <PaneSection title="About these settings" testId="pin-flags-authority">
        <CrossAuthorityNote href="/settings/account/features" linkLabel="Pin features">
          Saved on this Pin. For everyday features, open Pin features.
        </CrossAuthorityNote>
      </PaneSection>

      <fieldset className={styles.fieldset} disabled={saving} aria-busy={saving}>
        <PaneSection
          title="On your Pin"
          testId="pin-flags-settings-global"
        >
          {mainGates.map(renderGate)}
          {technicalGates.length ? (
            <details className={local.technicalDetails}>
              <summary>Technical details</summary>
              <div className={local.technicalNote}>
                <p className={styles.formHelp}>{data.settings_global_note}</p>
              </div>
              {technicalGates.map(renderGate)}
            </details>
          ) : null}
        </PaneSection>
      </fieldset>

      <UnsavedChangesGuard when={update !== null} />
    </>
  );
}

function GateControl({
  gate,
  draft,
  onChange,
  onReset,
}: {
  gate: SettingsGlobalFeatureGate;
  draft: boolean | null | undefined;
  onChange: (value: boolean | null) => void;
  onReset: () => void;
}) {
  const displayed = displaySettingsGlobalDraft(gate, draft);
  const copy = GATE_COPY[gate.key];
  const label = copy?.label ?? gate.label;
  const recoveryRequired = settingsGlobalRecoveryRequired(gate);
  const recoveryPending = recoveryRequired && draft !== undefined;
  const source = !gate.available
    ? "Not available"
    : !gate.writable
      ? "Managed by Luma"
      : draft === null
        ? "Using default"
        : "Custom";

  return (
    <article className={styles.card} data-testid="pin-settings-global-row">
      <div className={styles.cardHeading}>
        <span className={styles.cardTitleGroup}>
          <span className={styles.cardTitleLine}>
            <h3 className={styles.cardTitle}>{label}</h3>
            {gate.restart_recommended ? (
              <span className={`${styles.chip} ${styles.chipWarning}`}>
                Restart recommended
              </span>
            ) : null}
          </span>
        </span>
        {gate.writable ? (
          <button
            type="button"
            className={styles.linkButton}
            disabled={!gate.available || draft === null}
            onClick={onReset}
          >
            Use default
          </button>
        ) : recoveryRequired ? (
          <button
            type="button"
            className={styles.linkButton}
            disabled={recoveryPending}
            onClick={() => onChange(settingsGlobalRecoveryDraft(gate))}
          >
            {recoveryPending ? "Safe default pending" : "Restore safe default"}
          </button>
        ) : null}
      </div>

      <div className={local.controlRow}>
        <span className={styles.toggleCopy}>
          {copy?.description ?? "An additional setting on this Pin."}
        </span>
        {gate.writable ? <Switch
          checked={displayed}
          disabled={!gate.available || !gate.writable}
          onChange={(next) => onChange(next)}
          ariaLabel={label}
        /> : <span className={local.fixedValue}>
          {gate.available ? displayed ? "On" : "Off" : "Not available"}
        </span>}
      </div>

      {gate.error ? <StatusMessage tone="danger">{gate.error}</StatusMessage> : null}
      {copy?.warning || (!copy && gate.warning) ? (
        <StatusMessage tone="warning">{copy?.warning ?? gate.warning}</StatusMessage>
      ) : null}
      {recoveryRequired ? (
        <StatusMessage tone="warning">
          {recoveryPending
            ? "This setting will turn off when you save."
            : "This older setting needs to be turned off. Restore the safe default, then save."}
        </StatusMessage>
      ) : null}
      <details className={local.details}>
        <summary>More details</summary>
        <div className={local.detailBody}>
          <span className={styles.cardMeta}>
            <code className={styles.mono}>{gate.key}</code>
            <span>{source}</span>
          </span>
          {gate.warning ? <p className={styles.formHelp}>{gate.warning}</p> : null}
        </div>
      </details>
    </article>
  );
}
