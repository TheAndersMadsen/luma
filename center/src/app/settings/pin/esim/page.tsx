"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CellularServicePayload,
  EsimEvent,
  EsimProfile,
  EsimSnapshot,
} from "@/lib/pin-device";
import { logError, logInfo, logWarn } from "@/lib/pin-device";
import { StatusMessage } from "@/components/Status";
import { useDialogFocus } from "@/components/useDialogFocus";
import settings from "../../settings.module.css";
import styles from "../_lib/panes.module.css";
import { DeviceRequired, FormRow, PaneSection, UsbRequired } from "../_lib/PaneShell";
import { usePinPaneSession } from "../_lib/pinSession";
import { deviceErrorMessage } from "../_lib/deviceErrorPresentation";
import {
  canDeleteEsimProfile,
  canDisableEsimProfile,
  canEnableEsimProfile,
  isEsimProfileEnabled,
} from "../_lib/esimSafety";
import {
  STALE_THRESHOLD_MS,
  classifyApiError,
  classifyCellularResponse,
  classifyEidResult,
  classifyProfilesResult,
  describeDataState,
  esimEventMessage,
  formatSignal,
  formatStaleness,
  isTerminalEsimEvent,
  labelizeCellularValue,
  onOff,
  profileTitle,
  yesNo,
  type DataState,
} from "../_lib/esimPresentation";

/*
 * eSIM and cellular.
 *
 * Ported from the retired Setup SPA's `EsimSettingsPage.tsx`, with
 * esimSafety.ts's delete gate moved across unmodified.
 *
 * The shape of this pane is dictated by the device: every mutation is
 * ASYNCHRONOUS. `enableEsimProfile` / `deleteEsimProfile` /
 * `downloadVerifyEnableEsim` return a request id, and the outcome arrives
 * either on the /api/esim/events NDJSON stream or through a bounded poll of
 * /api/esim/requests/{id}. Both paths are kept: the stream is the fast path,
 * the poll is what makes the operation still resolve when the stream drops
 * mid-flight. A terminal event on either path is what closes the modal.
 *
 * Two credential rules survive verbatim from the SPA:
 *   - the LPA activation code is typed into a password field and dropped from
 *     browser state the moment the Pin accepts the request;
 *   - the code, the ICCID, the EID and the IMEI are all SENSITIVE_KEY /
 *     activation-code patterns in @/lib/pin-device's redaction layer, so none of
 *     them can reach a log line through logInfo/logWarn/logError.
 */

type PendingAction =
  | { kind: "enable"; iccid: string; requestId?: string }
  | { kind: "disable"; iccid: string; requestId?: string }
  | { kind: "delete"; iccid: string; requestId?: string }
  | { kind: "nickname"; iccid: string; requestId?: string }
  | { kind: "download"; requestId?: string }
  | null;

const SCOPE = "pin-esim-pane";
const POLL_ATTEMPTS = 24;
const POLL_INTERVAL_MS = 2_500;
const EVENT_HISTORY = 12;

function operationTitle(action: PendingAction): string {
  if (!action) return "Working";
  switch (action.kind) {
    case "enable":
      return "Activating profile";
    case "disable":
      return "Disabling profile";
    case "delete":
      return "Deleting profile";
    case "nickname":
      return "Renaming profile";
    case "download":
      return "Activating eSIM";
  }
}

function operationFallbackMessage(action: PendingAction): string {
  if (!action?.requestId) return "Sending request…";
  switch (action.kind) {
    case "enable":
      return "Activating profile…";
    case "disable":
      return "Disabling profile…";
    case "delete":
      return "Deleting profile…";
    case "nickname":
      return "Renaming profile…";
    case "download":
      return "Activating eSIM…";
  }
}

export default function PinEsimPane() {
  const { client, connectionError, attachedWithoutServer } = usePinPaneSession();
  const usbClient = client?.mode === "usb" ? client : null;
  const activationCodeId = useId();
  const operationDialogRef = useRef<HTMLDivElement | null>(null);

  const [snapshot, setSnapshot] = useState<EsimSnapshot | null>(null);
  const [profilesState, setProfilesState] = useState<DataState<EsimProfile[]>>({
    kind: "idle",
  });
  const [cellularState, setCellularState] = useState<
    DataState<CellularServicePayload>
  >({ kind: "idle" });
  const [eidState, setEidState] = useState<
    DataState<{ eid: string | null; imei: string | null }>
  >({ kind: "idle" });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [latestOperationEvent, setLatestOperationEvent] = useState<EsimEvent | null>(
    null,
  );
  const [activationCode, setActivationCode] = useState("");
  const [events, setEvents] = useState<EsimEvent[]>([]);
  const [renaming, setRenaming] = useState<{ iccid: string; value: string } | null>(
    null,
  );
  const pendingActionRef = useRef<PendingAction>(null);

  useDialogFocus({
    open: Boolean(pendingAction),
    dialogRef: operationDialogRef,
    closeOnEscape: false,
  });

  useEffect(() => {
    pendingActionRef.current = pendingAction;
  }, [pendingAction]);

  const loadEsimState = useCallback(
    async (options: { showLoading?: boolean } = {}) => {
      if (!usbClient) {
        setProfilesState({ kind: "disconnected" });
        setCellularState({ kind: "disconnected" });
        setEidState({ kind: "disconnected" });
        setLoading(false);
        setRefreshing(false);
        return;
      }

      if (options.showLoading ?? false) setLoading(true);
      setRefreshing(true);
      setProfilesState({ kind: "loading" });
      setCellularState({ kind: "loading" });
      setEidState({ kind: "loading" });

      try {
        logInfo(SCOPE, "Loading eSIM state");

        // allSettled, not all: a Pin whose modem is asleep answers three of
        // these and times out on the fourth, and losing the other three to that
        // is how the SPA's predecessor rendered a blank page.
        const [nextSnapshot, profilesResult, eidResult, cellularResult] =
          await Promise.allSettled([
            usbClient.getEsimState(),
            usbClient.getEsimProfiles(),
            usbClient.getEsimEid(),
            usbClient.getCellularServiceStatus(),
          ]);

        if (nextSnapshot.status === "fulfilled") {
          setSnapshot(nextSnapshot.value);
        } else {
          logWarn(SCOPE, "Failed to load eSIM snapshot", {
            error: nextSnapshot.reason,
          });
        }

        if (profilesResult.status === "fulfilled") {
          setProfilesState(classifyProfilesResult(profilesResult.value));
        } else {
          logError(SCOPE, "Failed to load eSIM profiles", profilesResult.reason);
          setProfilesState(classifyApiError(profilesResult.reason));
        }

        if (eidResult.status === "fulfilled") {
          setEidState(classifyEidResult(eidResult.value));
        } else {
          logWarn(SCOPE, "Failed to load eSIM device identifiers", {
            error: eidResult.reason,
          });
          setEidState(classifyApiError(eidResult.reason));
        }

        if (cellularResult.status === "fulfilled") {
          setCellularState(classifyCellularResponse(cellularResult.value));
        } else {
          logWarn(SCOPE, "Failed to load cellular service status", {
            error: cellularResult.reason,
          });
          setCellularState(classifyApiError(cellularResult.reason));
        }

        setLastLoadedAt(Date.now());
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [usbClient],
  );

  useEffect(() => {
    void loadEsimState({ showLoading: true });
  }, [loadEsimState]);

  const finishPendingOperation = useCallback(async () => {
    setPendingAction(null);
    setRenaming(null);
    await loadEsimState();
  }, [loadEsimState]);

  // The device's own event stream. Reconnects for as long as this pane is
  // mounted, because an eSIM download can outlive several stream drops.
  useEffect(() => {
    if (!usbClient) return;

    let cancelled = false;
    let reconnectAttempt = 0;
    // Held out here purely so cleanup can abort whichever attempt is live.
    let activeController: AbortController | null = null;
    const activeClient = usbClient;

    async function connect() {
      while (!cancelled) {
        reconnectAttempt += 1;
        // A fresh controller for each attempt, matching the SPA this pane was
        // ported from: reusing one meant every retry after the first was issued
        // with an already-aborted signal, and the pane silently lost live eSIM
        // progress for the rest of the visit.
        const controller = new AbortController();
        activeController = controller;
        if (cancelled) {
          controller.abort();
          break;
        }
        try {
          const stream = await activeClient.openStream(
            "/api/esim/events",
            controller.signal,
          );
          const reader = stream.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          // Cancelling the reader is the only path that runs the body stream's
          // socket releaser, so without this `finally` each reconnect and each
          // visit to this pane leaked a `localabstract:penumbra_http` socket
          // and the Pin-side relay thread behind it.
          try {
            while (!cancelled) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";

              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const event = JSON.parse(line) as EsimEvent;
                  const isCurrentOperationEvent =
                    Boolean(pendingActionRef.current?.requestId) &&
                    event.request_id === pendingActionRef.current?.requestId;
                  if (event.type !== "esim.heartbeat") {
                    setEvents((current) =>
                      [event, ...current].slice(0, EVENT_HISTORY),
                    );
                    if (isCurrentOperationEvent) setLatestOperationEvent(event);
                  }
                  if (isCurrentOperationEvent && isTerminalEsimEvent(event)) {
                    void finishPendingOperation();
                  }
                } catch {
                  // A truncated line is not worth a user-visible error, and its
                  // CONTENT must not be logged — an eSIM event can contain an ICCID.
                  logWarn(SCOPE, "Failed to parse eSIM event", {
                    lineLength: line.length,
                  });
                }
              }
            }
          } finally {
            await reader.cancel().catch(() => undefined);
          }
        } catch (error) {
          if (!cancelled) {
            logError(SCOPE, "eSIM event stream failed", error, { reconnectAttempt });
          }
        }

        if (!cancelled) {
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
      }
    }

    void connect();

    return () => {
      cancelled = true;
      activeController?.abort();
    };
  }, [usbClient, finishPendingOperation]);

  const pollRequestUntilTerminal = useCallback(
    async (requestId: string) => {
      if (!usbClient) return;

      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        try {
          const request = await usbClient.getEsimRequest(requestId);
          const latest =
            request.final_event ?? request.events[request.events.length - 1] ?? null;
          if (latest) setLatestOperationEvent(latest);
          if (request.final_event) {
            const finalEvent = request.final_event;
            setEvents((current) => [finalEvent, ...current].slice(0, EVENT_HISTORY));
          }
          if (request.status === "completed" || request.status === "error") {
            await finishPendingOperation();
            return;
          }
        } catch (error) {
          logWarn(SCOPE, "Failed to poll eSIM request", { error, requestId });
        }
      }
    },
    [usbClient, finishPendingOperation],
  );

  async function runProfileMutation(
    action: NonNullable<PendingAction>,
    perform: () => Promise<{ request_id: string }>,
    failureMessage: string,
  ) {
    if (!usbClient || pendingAction) return;
    setActionError(null);
    setLatestOperationEvent(null);
    setPendingAction(action);

    try {
      const response = await perform();
      setPendingAction({ ...action, requestId: response.request_id });
      void pollRequestUntilTerminal(response.request_id);
    } catch (error) {
      const message = deviceErrorMessage(error, failureMessage);
      logError(SCOPE, failureMessage, error);
      setActionError(message);
      setPendingAction(null);
    }
  }

  async function handleEnable(profile: EsimProfile) {
    if (!usbClient || !canEnableEsimProfile(profile, Boolean(pendingAction))) return;
    await runProfileMutation(
      { kind: "enable", iccid: profile.iccid },
      () => usbClient.enableEsimProfile(profile.iccid),
      "Failed to activate eSIM profile",
    );
  }

  async function handleDisable(profile: EsimProfile) {
    if (!usbClient || !canDisableEsimProfile(profile, Boolean(pendingAction))) return;
    if (
      !globalThis.confirm(
        `Disable ${profileTitle(profile)}? The Pin loses this profile's cellular service until you activate it again.`,
      )
    ) {
      return;
    }
    await runProfileMutation(
      { kind: "disable", iccid: profile.iccid },
      () => usbClient.disableEsimProfile(profile.iccid),
      "Failed to disable eSIM profile",
    );
  }

  async function handleDelete(profile: EsimProfile) {
    // The gate, unmodified from the SPA: not while another operation is in
    // flight, never a carrier-protected profile, and only one that is already
    // disabled. Deleting an eSIM is irreversible.
    if (!usbClient || !canDeleteEsimProfile(profile, Boolean(pendingAction))) return;
    if (
      !globalThis.confirm(
        `Delete eSIM profile ${profileTitle(profile)}? This cannot be undone.`,
      )
    ) {
      return;
    }
    await runProfileMutation(
      { kind: "delete", iccid: profile.iccid },
      () => usbClient.deleteEsimProfile(profile.iccid),
      "Failed to delete eSIM profile",
    );
  }

  async function handleRename(profile: EsimProfile, nickname: string) {
    if (!usbClient || pendingAction) return;
    const trimmed = nickname.trim();
    if (!trimmed) {
      setActionError("Enter a name for this profile.");
      return;
    }
    await runProfileMutation(
      { kind: "nickname", iccid: profile.iccid },
      () => usbClient.setEsimNickname(profile.iccid, trimmed),
      "Failed to rename eSIM profile",
    );
  }

  async function handleActivateNew() {
    if (!usbClient || pendingAction) return;
    const code = activationCode.trim();
    if (!code) {
      setActionError("Enter an activation code.");
      return;
    }

    setActionError(null);
    setLatestOperationEvent(null);
    setPendingAction({ kind: "download" });

    try {
      const response = await usbClient.downloadVerifyEnableEsim(code);
      // The activation code is a provisioning credential. Drop the browser copy
      // as soon as the Pin has accepted the request.
      setActivationCode("");
      setPendingAction({ kind: "download", requestId: response.request_id });
      void pollRequestUntilTerminal(response.request_id);
    } catch (error) {
      const message = deviceErrorMessage(error, "Couldn’t activate this eSIM.");
      logError(SCOPE, "Failed to activate new eSIM", error);
      setActionError(message);
      setPendingAction(null);
    }
  }

  if (client?.mode === "remote") {
    return <UsbRequired what="eSIM and cellular settings" />;
  }

  if (!usbClient) {
    return (
      <DeviceRequired
        attachedWithoutServer={attachedWithoutServer}
        what="this Pin's eSIM profiles"
        connectionError={connectionError}
      />
    );
  }

  const cellularValue = cellularState.kind === "loaded" ? cellularState.value : null;
  const eidValue = eidState.kind === "loaded" ? eidState.value : null;
  const profiles = profilesState.kind === "loaded" ? profilesState.value : [];
  const isStale =
    lastLoadedAt != null && Date.now() - lastLoadedAt > STALE_THRESHOLD_MS;
  const operationMessage = latestOperationEvent
    ? esimEventMessage(latestOperationEvent)
    : operationFallbackMessage(pendingAction);

  return (
    <>
      <div className={styles.actionRowEnd}>
        {lastLoadedAt != null ? (
          <span className={styles.saveState}>
            {isStale ? "Data may be out of date · " : ""}
            Last updated {formatStaleness(lastLoadedAt)}
          </span>
        ) : null}
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => void loadEsimState()}
          disabled={refreshing || Boolean(pendingAction)}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {actionError ? <StatusMessage tone="danger">{actionError}</StatusMessage> : null}

      <PaneSection title="Wireless status" testId="pin-esim-wireless">
        <div className={styles.formRow}>
          <span className={styles.formLabel}>Carrier and connection</span>
          {cellularState.kind === "loaded" && cellularValue ? (
            <dl className={styles.factList}>
              <dt>Carrier</dt>
              <dd>{cellularValue.details.operator_name ?? "Unavailable"}</dd>
              <dt>Network</dt>
              <dd>{cellularValue.details.network_type ?? "Unavailable"}</dd>
              <dt>Service</dt>
              <dd>{labelizeCellularValue(cellularValue.details.service_state)}</dd>
              <dt>Signal</dt>
              <dd>{formatSignal(cellularValue)}</dd>
            </dl>
          ) : (
            <DataStateNotice state={cellularState} />
          )}
        </div>

        <div className={styles.formRow}>
          <span className={styles.formLabel}>Internet</span>
          {cellularState.kind === "loaded" && cellularValue ? (
            <dl className={styles.factList}>
              <dt>Mobile data</dt>
              <dd>{onOff(cellularValue.details.mobile_data_enabled)}</dd>
              <dt>Data connection</dt>
              <dd>
                {labelizeCellularValue(cellularValue.details.data_connection_state)}
              </dd>
              <dt>Connected</dt>
              <dd>{yesNo(cellularValue.details.data_connected)}</dd>
              <dt>Internet validated</dt>
              <dd>{yesNo(cellularValue.details.internet_validated)}</dd>
              {cellularValue.details.reject_cause != null ? (
                <>
                  <dt>Reject cause</dt>
                  <dd>{cellularValue.details.reject_cause}</dd>
                </>
              ) : null}
            </dl>
          ) : (
            <DataStateNotice state={cellularState} />
          )}
        </div>

        <div className={styles.formRow}>
          <span className={styles.formLabel}>Device identifiers</span>
          {eidState.kind === "loaded" && eidValue ? (
            <dl className={styles.factList}>
              <dt>EID</dt>
              <dd className={styles.mono}>{eidValue.eid ?? "Unavailable"}</dd>
              <dt>IMEI</dt>
              <dd className={styles.mono}>{eidValue.imei ?? "Unavailable"}</dd>
            </dl>
          ) : (
            <DataStateNotice state={eidState} />
          )}
        </div>
      </PaneSection>

      <PaneSection title="eSIM profiles" testId="pin-esim-profiles">
        {profilesState.kind === "loaded" ? (
          profiles.map((profile) => {
            const enabled = isEsimProfileEnabled(profile);
            const busy = Boolean(pendingAction);
            const isRenaming = renaming?.iccid === profile.iccid;

            return (
              <article
                className={styles.card}
                key={profile.iccid}
                data-testid="pin-esim-profile"
              >
                <div className={styles.cardHeading}>
                  <span className={styles.cardTitleGroup}>
                    <span className={styles.cardTitleLine}>
                      <h3 className={styles.cardTitle}>{profileTitle(profile)}</h3>
                      <span
                        className={`${styles.chip} ${enabled ? styles.chipLive : ""}`}
                      >
                        {profile.state ?? "Unknown"}
                      </span>
                      {profile.protected === true ? (
                        <span className={styles.chip}>Carrier protected</span>
                      ) : null}
                    </span>
                    {profile.service_provider ? (
                      <span className={styles.toggleCopy}>
                        Provider: {profile.service_provider}
                      </span>
                    ) : null}
                  </span>
                </div>

                {isRenaming ? (
                  <div className={styles.actionRow}>
                    <input
                      className={styles.input}
                      type="text"
                      value={renaming.value}
                      onChange={(event) =>
                        setRenaming({ iccid: profile.iccid, value: event.target.value })
                      }
                      placeholder="Profile name"
                      aria-label="Profile name"
                      autoFocus
                    />
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      disabled={busy}
                      onClick={() => void handleRename(profile, renaming.value)}
                    >
                      Save name
                    </button>
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => setRenaming(null)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className={styles.actionRow}>
                    {enabled ? (
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        disabled={!canDisableEsimProfile(profile, busy)}
                        title={
                          profile.protected === true
                            ? "A carrier-protected profile cannot be disabled from here."
                            : undefined
                        }
                        onClick={() => void handleDisable(profile)}
                      >
                        Disable
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        disabled={!canEnableEsimProfile(profile, busy)}
                        onClick={() => void handleEnable(profile)}
                      >
                        Activate
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.smallButton}
                      disabled={busy}
                      onClick={() =>
                        setRenaming({
                          iccid: profile.iccid,
                          value: profile.nickname ?? profile.name ?? "",
                        })
                      }
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className={styles.dangerButton}
                      disabled={!canDeleteEsimProfile(profile, busy)}
                      title={
                        profile.protected === true
                          ? "A carrier-protected profile cannot be deleted."
                          : enabled
                            ? "Disable this profile before deleting it."
                            : undefined
                      }
                      onClick={() => void handleDelete(profile)}
                    >
                      Delete
                    </button>
                  </div>
                )}

              </article>
            );
          })
        ) : (
          <div className={settings.stateRow}>
            <DataStateNotice state={profilesState} />
          </div>
        )}
      </PaneSection>

      <PaneSection title="Activate a new eSIM" testId="pin-esim-activate">
        <FormRow
          label="Activation code"
          htmlFor={activationCodeId}
          help="Carrier activation code. Center clears it after the Pin accepts it."
        >
          <input
            id={activationCodeId}
            className={styles.input}
            type="password"
            value={activationCode}
            onChange={(event) => setActivationCode(event.target.value)}
            placeholder="LPA:1$..."
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={pendingAction?.kind === "download"}
          />
          <div className={styles.actionRow}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => void handleActivateNew()}
              disabled={Boolean(pendingAction) || activationCode.trim() === ""}
            >
              {pendingAction?.kind === "download" ? "Activating eSIM…" : "Activate eSIM"}
            </button>
          </div>
        </FormRow>
      </PaneSection>

      <PaneSection title="Recent eSIM activity" testId="pin-esim-activity">
        {snapshot?.requests?.length ? (
          <div className={settings.stateRow}>
            <span className={settings.muted}>
              {snapshot.requests.length} request
              {snapshot.requests.length === 1 ? "" : "s"} tracked by the Pin.
            </span>
          </div>
        ) : null}
        {events.length === 0 ? (
          <div className={settings.stateRow}>
            <span className={settings.muted}>No recent eSIM activity.</span>
          </div>
        ) : (
          events.map((event, index) => (
            <div
              className={styles.card}
              key={`${event.type}-${event.request_id ?? "event"}-${index}`}
            >
              <span className={styles.cardTitleLine}>
                <code className={styles.mono}>{event.type}</code>
              </span>
              <span className={styles.toggleCopy}>{esimEventMessage(event)}</span>
              {event.request_id ? (
                <span className={styles.cardMeta}>Request {event.request_id}</span>
              ) : null}
            </div>
          ))
        )}
      </PaneSection>

      {!pendingAction && (loading || refreshing) ? (
        <div className={styles.actionRow} role="status" aria-live="polite">
          <span className={styles.spinner} aria-hidden="true" />
          <span className={styles.saveState}>
            {loading ? "Loading eSIM data…" : "Refreshing eSIM data…"}
          </span>
        </div>
      ) : null}

      {pendingAction && typeof document !== "undefined" ? createPortal(
        <div className={styles.overlay} data-dialog-overlay>
          <div
            ref={operationDialogRef}
            className={styles.overlayCard}
            role="dialog"
            aria-modal="true"
            aria-labelledby="pin-esim-operation-title"
            aria-describedby="pin-esim-operation-copy"
            tabIndex={-1}
          >
            <h2 id="pin-esim-operation-title" className={styles.overlayTitle}>
              {operationTitle(pendingAction)}
            </h2>
            <div className={styles.actionRow}>
              <span className={styles.spinner} aria-hidden="true" />
              <p
                id="pin-esim-operation-copy"
                className={styles.overlayCopy}
                aria-live="polite"
              >
                {operationMessage}
              </p>
            </div>
            {pendingAction.requestId ? (
              <p className={styles.overlayCopy}>Request {pendingAction.requestId}</p>
            ) : null}
            <p className={styles.overlayCopy}>
              Keep the Pin connected until this finishes.
            </p>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function DataStateNotice({ state }: { state: DataState<unknown> }) {
  const notice = describeDataState(state);
  if (!notice) return null;
  if (notice.tone === "info") {
    return <span className={settings.muted}>{notice.text}</span>;
  }
  return <StatusMessage tone={notice.tone}>{notice.text}</StatusMessage>;
}
