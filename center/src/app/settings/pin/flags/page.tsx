"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FeatureFlagDefinition,
  FeatureFlagDelivery,
  FeatureFlagSource,
  FeatureFlagsResponse,
  PinClient,
  SettingsGlobalFeatureGate,
  UpdateFeatureFlagsRequest,
} from "@/lib/pin-device";
import { logError, logInfo } from "@/lib/pin-device";
import { StatusMessage, Switch } from "@/components/Status";
import settings from "../../settings.module.css";
import styles from "../_lib/panes.module.css";
import {
  DeviceRequired,
  PaneLoadState,
  PaneSection,
  SaveBar,
} from "../_lib/PaneShell";
import { UnsavedChangesGuard } from "../_lib/UnsavedChangesGuard";
import { usePinPaneSession } from "../_lib/pinSession";
import { deviceErrorMessage } from "../_lib/deviceErrorPresentation";
import {
  FEATURE_FLAG_DELIVERY_POLL_MAX_ATTEMPTS,
  buildFeatureFlagUpdate,
  buildSettingsGlobalUpdate,
  createFeatureFlagDrafts,
  createSettingsGlobalDrafts,
  displayDraftValue,
  displaySettingsGlobalDraft,
  featureFlagAssignmentDescription,
  featureFlagDeliveryAcknowledgesHash,
  featureFlagDeliveryDescription,
  featureFlagDeliveryLabel,
  featureFlagSaveMessage,
  hasRestartRecommendedConsumers,
  pollFeatureFlagDelivery,
  settingsGlobalRecoveryDraft,
  settingsGlobalRecoveryRequired,
  type FeatureFlagDeliveryPollStatus,
  type FeatureFlagDraftValue,
  type FeatureFlagDrafts,
  type SettingsGlobalDrafts,
} from "../_lib/featureFlagsState";

/*
 * DEVICE feature flags — deliberately NOT the same thing as
 * /settings/account/features.
 *
 * Ported from the retired Setup SPA's `pages/FeatureFlagsSettingsPage.tsx` +
 * pages/featureFlagsState.ts.
 *
 * Center's account Features pane is a cloud allowlist: thirteen named
 * capabilities read from CARRY_WEBAPI's /demo-api/flags for the signed-in
 * wearer. This pane is the DEVICE's own authority and has three concepts the
 * cloud one has no counterpart for:
 *
 *   - an assignment set with a SHA-256 identity, which stock arcOS fetches over
 *     the FeatureFlags gRPC service;
 *   - `grpc_fetch_observed` / `stock_cache_verified`, which are the only
 *     evidence that a saved value actually reached the stock cache rather than
 *     merely being persisted by the Pin's server;
 *   - Android Settings.Global gates, which are on-device integer booleans that
 *     no cloud flag can reach.
 *
 * The bounded delivery poll is the part worth protecting. It refuses any
 * acknowledgement whose `desired_assignment_hash` is not the exact set it is
 * waiting for, so a LATER unrelated save can never be mistaken for confirmation
 * of an earlier one — it reports "superseded" instead.
 */

type SaveStatus = "idle" | "saving" | "saved" | "error";
type DeliveryPollOrigin = "load" | "save" | "retry";

interface DeliveryPollRequest {
  id: number;
  expectedHash: string;
  origin: DeliveryPollOrigin;
  client: PinClient;
}

const SCOPE = "pin-flags-pane";

function compactAssignmentHash(hash: string): string {
  return hash.length > 24 ? `${hash.slice(0, 12)}…${hash.slice(-8)}` : hash;
}

function formatObservedTime(unixMs?: number | null): string | null {
  if (unixMs == null) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(unixMs));
}

function sourceLabel(source: FeatureFlagSource): string {
  switch (source) {
    case "override":
      return "Override";
    case "penumbra_default":
      return "Revival default";
    case "firmware_default":
      return "Stock firmware default";
  }
}

function inheritedSource(flag: FeatureFlagDefinition): FeatureFlagSource {
  return flag.penumbra_default != null ? "penumbra_default" : "firmware_default";
}

export default function PinFlagsPane() {
  const { client, connectionError, attachedWithoutServer } = usePinPaneSession();

  const [data, setData] = useState<FeatureFlagsResponse | null>(null);
  const [drafts, setDrafts] = useState<FeatureFlagDrafts>({});
  const [globalDrafts, setGlobalDrafts] = useState<SettingsGlobalDrafts>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [pollRequest, setPollRequest] = useState<DeliveryPollRequest | null>(null);
  const [pollStatus, setPollStatus] = useState<FeatureFlagDeliveryPollStatus>({
    state: "idle",
  });
  // Bumped by the retry affordance so the load effect re-runs without a full
  // page reload, which would tear down the shared WebUSB session.
  const [reloadToken, setReloadToken] = useState(0);
  const pollSequence = useRef(0);

  const populate = useCallback((response: FeatureFlagsResponse) => {
    setData(response);
    setDrafts(createFeatureFlagDrafts(response.flags));
    setGlobalDrafts(createSettingsGlobalDrafts(response.settings_global_gates));
  }, []);

  const beginDeliveryPoll = useCallback(
    (delivery: FeatureFlagDelivery, origin: DeliveryPollOrigin) => {
      if (!client) return;
      const expectedHash = delivery.desired_assignment_hash;
      if (featureFlagDeliveryAcknowledgesHash(delivery, expectedHash)) {
        setPollRequest(null);
        setPollStatus(
          origin === "load" ? { state: "idle" } : { state: "verified", attempts: 0 },
        );
        return;
      }

      pollSequence.current += 1;
      setPollRequest({
        id: pollSequence.current,
        expectedHash,
        origin,
        client,
      });
      setPollStatus({
        state: "polling",
        attempt: 0,
        maxAttempts: FEATURE_FLAG_DELIVERY_POLL_MAX_ATTEMPTS,
      });
    },
    [client],
  );

  useEffect(() => {
    if (!client) return;

    const controller = new AbortController();
    logInfo(SCOPE, "Loading device feature flags");
    client
      .getFeatureFlags(controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        populate(response);
        setLoadError(null);
        beginDeliveryPoll(response.delivery, "load");
        logInfo(SCOPE, "Device feature flags loaded", {
          count: response.flags.length,
        });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        logError(SCOPE, "Failed to load device feature flags", error);
        setLoadError(deviceErrorMessage(error, "Couldn’t load device flags."));
      });

    return () => controller.abort();
  }, [beginDeliveryPoll, client, populate, reloadToken]);

  useEffect(() => {
    if (!client || !pollRequest || pollRequest.client !== client) return;

    const controller = new AbortController();
    let lastAttempt = 0;
    logInfo(SCOPE, "Starting bounded delivery checks", {
      origin: pollRequest.origin,
      maxAttempts: FEATURE_FLAG_DELIVERY_POLL_MAX_ATTEMPTS,
    });

    void pollFeatureFlagDelivery({
      expectedHash: pollRequest.expectedHash,
      signal: controller.signal,
      fetchDelivery: async (signal) => (await client.getFeatureFlags(signal)).delivery,
      onObservation: (delivery, attempt) => {
        lastAttempt = attempt;
        if (delivery.desired_assignment_hash === pollRequest.expectedHash) {
          // Refresh delivery evidence ONLY. Recreating the drafts here would
          // erase edits made while this bounded poll is running.
          setData((current) => (current == null ? current : { ...current, delivery }));
        }
        setPollStatus({
          state: "polling",
          attempt,
          maxAttempts: FEATURE_FLAG_DELIVERY_POLL_MAX_ATTEMPTS,
        });
      },
    })
      .then((result) => {
        if (controller.signal.aborted || result.outcome === "aborted") return;
        switch (result.outcome) {
          case "verified":
            setPollStatus({ state: "verified", attempts: result.attempts });
            break;
          case "timed_out":
            setPollStatus({ state: "timed_out", attempts: result.attempts });
            break;
          case "superseded":
            setPollStatus({ state: "superseded", attempts: result.attempts });
            break;
        }
        setPollRequest((current) => (current?.id === pollRequest.id ? null : current));
        logInfo(SCOPE, "Bounded delivery checks finished", {
          outcome: result.outcome,
          attempts: result.attempts,
        });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setPollStatus({ state: "error", attempts: lastAttempt });
        setPollRequest((current) => (current?.id === pollRequest.id ? null : current));
        logError(SCOPE, "Automatic delivery checks failed", error);
      });

    return () => controller.abort();
  }, [client, pollRequest]);

  const cloudUpdateResult = useMemo(
    () => buildFeatureFlagUpdate(data?.flags ?? [], drafts),
    [data, drafts],
  );
  const globalUpdate = useMemo(
    () => buildSettingsGlobalUpdate(data?.settings_global_gates ?? [], globalDrafts),
    [data, globalDrafts],
  );
  const updateRequest = useMemo<UpdateFeatureFlagsRequest | null>(() => {
    if (Object.keys(cloudUpdateResult.errors).length > 0) return null;
    if (!cloudUpdateResult.update && !globalUpdate) return null;
    return {
      ...(cloudUpdateResult.update ?? {}),
      ...(globalUpdate ? { settings_global: globalUpdate } : {}),
    };
  }, [cloudUpdateResult, globalUpdate]);

  const isDirty =
    updateRequest !== null || Object.keys(cloudUpdateResult.errors).length > 0;

  const consumerPending = useMemo(
    () =>
      pollStatus.state === "verified" &&
      data != null &&
      hasRestartRecommendedConsumers(data.flags, data.settings_global_gates),
    [data, pollStatus.state],
  );

  function setDraft(key: string, value: FeatureFlagDraftValue) {
    setDrafts((current) => ({ ...current, [key]: value }));
    setSaveStatus("idle");
    setSaveMessage(null);
  }

  function setGlobalDraft(key: string, value: boolean | null) {
    setGlobalDrafts((current) => ({ ...current, [key]: value }));
    setSaveStatus("idle");
    setSaveMessage(null);
  }

  async function handleSave() {
    if (!client || !updateRequest) return;
    setSaveStatus("saving");
    setSaveMessage(null);
    const cloudCount = Object.keys(updateRequest.overrides ?? {}).length;
    const globalCount = Object.keys(updateRequest.settings_global ?? {}).length;
    logInfo(SCOPE, "Saving device feature flags", { cloudCount, globalCount });

    try {
      const response = await client.updateFeatureFlags(updateRequest);
      populate(response);
      if (cloudCount > 0) beginDeliveryPoll(response.delivery, "save");
      setSaveStatus("saved");
      setSaveMessage(
        featureFlagSaveMessage(response.delivery, cloudCount, globalCount),
      );
      logInfo(SCOPE, "Device feature flags saved", {
        cloudCount,
        globalCount,
        syncRequested: response.sync_requested ?? false,
        deliveryState: response.delivery.state,
        grpcFetchObserved: response.delivery.grpc_fetch_observed,
        stockCacheVerified: response.delivery.stock_cache_verified,
      });
    } catch (error) {
      setSaveStatus("error");
      setSaveMessage(deviceErrorMessage(error, "Couldn’t save device flags."));
      logError(SCOPE, "Failed to save device feature flags", error);
    }
  }

  if (!client) {
    return (
      <DeviceRequired
        attachedWithoutServer={attachedWithoutServer} what="this Pin's feature flags" connectionError={connectionError} />
    );
  }

  if (!data) {
    return (
      <PaneLoadState
        error={loadError}
        onRetry={() => setReloadToken((token) => token + 1)}
        rows={6}
      />
    );
  }

  const writableFlags = data.flags.filter((flag) => flag.writable);
  const lockedFlags = data.flags.filter((flag) => !flag.writable);
  const saving = saveStatus === "saving";

  return (
    <>
      <SaveBar
        status={saveStatus}
        error={saveStatus === "error" ? saveMessage : null}
        dirty={updateRequest !== null}
        onSave={() => void handleSave()}
        label="Save overrides"
      />

      {saveStatus === "saved" && saveMessage ? (
        <StatusMessage tone="info">{saveMessage}</StatusMessage>
      ) : null}

      <PaneSection title="What this pane is" testId="pin-flags-authority">
        <div className={settings.additionRow}>
          <span className={settings.additionRowText}>
            <span className={settings.additionRowDesc}>
              These flags belong to the connected <strong>device</strong>: they are the
              assignment set stock arcOS fetches over its FeatureFlags gRPC service,
              plus the Pin&rsquo;s own Android Settings.Global gates. Your account&rsquo;s
              Features list is a different authority — a cloud allowlist for your
              wearer profile — and changing one does not change the other.
            </span>
          </span>
          <Link className={settings.additionLink} href="/settings/account/features">
            Account features
          </Link>
        </div>
      </PaneSection>

      <DeliverySection delivery={data.delivery} />
      <DeliveryPollNotice
        status={pollStatus}
        consumerPending={consumerPending}
        onRetry={() => beginDeliveryPoll(data.delivery, "retry")}
      />

      <fieldset
        className={styles.fieldset}
        disabled={saving}
        aria-busy={saving}
      >
        <PaneSection title="Cloud feature flags" testId="pin-flags-cloud">
          <div className={styles.formRow}>
            <p className={styles.formHelp}>
              &ldquo;Use default&rdquo; removes the server override. A Revival baseline
              remains in the gRPC assignment set; otherwise the key is omitted and
              stock arcOS resolves its firmware default.
            </p>
          </div>
          {writableFlags.map((flag) => (
            <FlagControl
              key={flag.key}
              flag={flag}
              draft={drafts[flag.key] ?? null}
              error={cloudUpdateResult.errors[flag.key]}
              onChange={(value) => setDraft(flag.key, value)}
              onReset={() => setDraft(flag.key, null)}
            />
          ))}
        </PaneSection>

        {lockedFlags.length > 0 ? (
          <PaneSection title="Locked cloud assignments" testId="pin-flags-locked">
            <div className={styles.formRow}>
              <p className={styles.formHelp}>
                Visible for completeness, but excluded from the writable allowlist
                because an unsafe value could delay recovery.
              </p>
            </div>
            {lockedFlags.map((flag) => (
              <FlagControl
                key={flag.key}
                flag={flag}
                draft={null}
                onChange={() => undefined}
                onReset={() => undefined}
              />
            ))}
          </PaneSection>
        ) : null}

        <PaneSection
          title="On-device Settings.Global gates"
          testId="pin-flags-settings-global"
        >
          <div className={styles.formRow}>
            <p className={styles.formHelp}>{data.settings_global_note}</p>
          </div>
          {data.settings_global_gates.map((gate) => (
            <GateControl
              key={gate.key}
              gate={gate}
              draft={globalDrafts[gate.key]}
              onChange={(value) => setGlobalDraft(gate.key, value)}
              onReset={() => setGlobalDraft(gate.key, null)}
            />
          ))}
        </PaneSection>
      </fieldset>

      <UnsavedChangesGuard when={isDirty} />
    </>
  );
}

function DeliverySection({ delivery }: { delivery: FeatureFlagDelivery }) {
  const grpcFetchTime = formatObservedTime(delivery.last_grpc_fetch_unix_ms);
  const stockApplyTime = formatObservedTime(delivery.last_stock_cache_apply_unix_ms);

  return (
    <PaneSection
      title="Assignment-set delivery"
      testId="pin-flags-delivery"
      action={
        <span className={styles.chipRow}>
          <span
            className={`${styles.chip} ${
              delivery.stock_cache_verified ? styles.chipLive : ""
            }`}
          >
            {featureFlagDeliveryLabel(delivery.state)}
          </span>
          {!delivery.stock_cache_verified ? (
            <span className={`${styles.chip} ${styles.chipWarning}`}>
              Stock application unverified
            </span>
          ) : null}
        </span>
      }
    >
      <div className={styles.formRow}>
        <p className={styles.formHelp}>{featureFlagDeliveryDescription(delivery)}</p>
        <dl className={styles.factList}>
          <dt>Assignment-set hash</dt>
          <dd>
            <code className={styles.mono} title={delivery.desired_assignment_hash}>
              {compactAssignmentHash(delivery.desired_assignment_hash)}
            </code>
          </dd>
          <dt>Matching GetFlags fetch</dt>
          <dd>
            {delivery.grpc_fetch_observed
              ? (grpcFetchTime ?? "Observed (time unavailable)")
              : "Not observed for this assignment set"}
          </dd>
          <dt>Stock cache apply</dt>
          <dd>
            {delivery.stock_cache_verified
              ? (stockApplyTime ?? "Verified (time unavailable)")
              : "Not verified for this assignment set"}
          </dd>
        </dl>
        <StatusMessage tone={delivery.stock_cache_verified ? "info" : "warning"}>
          {delivery.note}
        </StatusMessage>
      </div>
    </PaneSection>
  );
}

function DeliveryPollNotice({
  status,
  onRetry,
  consumerPending,
}: {
  status: FeatureFlagDeliveryPollStatus;
  onRetry: () => void;
  consumerPending: boolean;
}) {
  if (status.state === "idle") return null;

  const message = (() => {
    switch (status.state) {
      case "polling":
        return status.attempt === 0
          ? "Starting automatic checks for exact stock-cache acknowledgement."
          : `Checking for exact stock-cache acknowledgement (attempt ${status.attempt} of ${status.maxAttempts}).`;
      case "verified":
        return consumerPending
          ? "Stock acknowledged the exact assignment-set hash. Automatic checks are complete. Restart-required consumers are still pending."
          : "Stock acknowledged the exact assignment-set hash. Automatic checks are complete.";
      case "timed_out":
        return `Automatic checks stopped after ${status.attempts} attempts without exact stock-cache acknowledgement.`;
      case "superseded":
        return "Automatic checks stopped because the Pin desired a different assignment set. Reload this page before making more changes.";
      case "error":
        return "Automatic delivery checks could not continue because the Pin became unavailable.";
    }
  })();

  const canRetry = status.state === "timed_out" || status.state === "error";
  const tone =
    status.state === "verified" ? "info" : status.state === "polling" ? "info" : "warning";

  return (
    <StatusMessage tone={tone} onRetry={canRetry ? onRetry : undefined}>
      {message}
    </StatusMessage>
  );
}

function FlagControl({
  flag,
  draft,
  error,
  onChange,
  onReset,
}: {
  flag: FeatureFlagDefinition;
  draft: FeatureFlagDraftValue;
  error?: string;
  onChange: (value: FeatureFlagDraftValue) => void;
  onReset: () => void;
}) {
  const displayed = displayDraftValue(flag, draft);
  const source = draft === null ? inheritedSource(flag) : "override";
  const inputId = `pin-flag-${flag.key}`;

  return (
    <article className={styles.card} data-testid="pin-flag-row">
      <div className={styles.cardHeading}>
        <span className={styles.cardTitleGroup}>
          <span className={styles.cardTitleLine}>
            <h3 className={styles.cardTitle}>{flag.label}</h3>
            <span className={styles.chip}>{sourceLabel(source)}</span>
            {flag.restart_recommended ? (
              <span className={`${styles.chip} ${styles.chipWarning}`}>
                Restart recommended
              </span>
            ) : null}
          </span>
          <span className={styles.toggleCopy}>{flag.description}</span>
        </span>
        {flag.writable ? (
          <button
            type="button"
            className={styles.linkButton}
            disabled={draft === null}
            onClick={onReset}
          >
            Use default
          </button>
        ) : null}
      </div>

      {flag.value_type === "bool" ? (
        <div className={styles.toggleRow}>
          <span className={styles.toggleCopy}>
            {displayed ? "Enabled" : "Disabled"}
          </span>
          <Switch
            checked={Boolean(displayed)}
            disabled={!flag.writable}
            onChange={(next) => onChange(next)}
            ariaLabel={flag.label}
          />
        </div>
      ) : (
        <div className={styles.subpanelRow}>
          <label className={styles.formLabel} htmlFor={inputId}>
            {flag.value_type === "int"
              ? "Whole number"
              : flag.value_type === "float"
                ? "Number"
                : "Text"}
          </label>
          <input
            id={inputId}
            className={styles.input}
            type={flag.value_type === "string" ? "text" : "number"}
            step={flag.value_type === "int" ? "1" : "any"}
            min={flag.key.endsWith("_timeout_millis") ? "0" : undefined}
            value={String(displayed)}
            disabled={!flag.writable}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
      )}

      <div className={styles.cardMeta}>
        <code className={styles.mono}>{flag.key}</code>
        <span>Type: {flag.value_type}</span>
      </div>
      <p className={styles.formHelp}>{featureFlagAssignmentDescription(flag)}</p>
      {flag.warning ? (
        <StatusMessage tone="warning">{flag.warning}</StatusMessage>
      ) : null}
      {error ? <StatusMessage tone="danger">{error}</StatusMessage> : null}
    </article>
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
  const recoveryRequired = settingsGlobalRecoveryRequired(gate);
  const recoveryPending = recoveryRequired && draft !== undefined;
  const source = !gate.available
    ? "Unavailable"
    : !gate.writable
      ? "Read-only"
      : draft === null
        ? "Default"
        : "Stored";

  return (
    <article className={styles.card} data-testid="pin-settings-global-row">
      <div className={styles.cardHeading}>
        <span className={styles.cardTitleGroup}>
          <span className={styles.cardTitleLine}>
            <h3 className={styles.cardTitle}>{gate.label}</h3>
            <span className={styles.chip}>{source}</span>
            {gate.restart_recommended ? (
              <span className={`${styles.chip} ${styles.chipWarning}`}>
                Restart recommended
              </span>
            ) : null}
          </span>
          <span className={styles.cardMeta}>
            <code className={styles.mono}>{gate.key}</code>
            <span>Android Settings.Global · integer bool</span>
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

      <div className={styles.toggleRow}>
        <span className={styles.toggleCopy}>
          {gate.available
            ? displayed
              ? "Enabled"
              : "Disabled"
            : "Current value unavailable"}
        </span>
        <Switch
          checked={displayed}
          disabled={!gate.available || !gate.writable}
          onChange={(next) => onChange(next)}
          ariaLabel={gate.label}
        />
      </div>

      {gate.error ? <StatusMessage tone="danger">{gate.error}</StatusMessage> : null}
      {gate.warning ? (
        <StatusMessage tone="warning">{gate.warning}</StatusMessage>
      ) : null}
      {recoveryRequired ? (
        <StatusMessage tone="warning">
          {recoveryPending
            ? "The safe disabled value will be restored when you save."
            : "An unsafe legacy enabled value is stored. You can only restore this locked gate to its safe disabled default."}
        </StatusMessage>
      ) : null}
    </article>
  );
}
