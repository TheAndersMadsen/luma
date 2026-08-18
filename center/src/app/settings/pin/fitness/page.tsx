"use client";

import { useCallback, useEffect, useState } from "react";
import type { FitnessSession, FitnessSessionFile } from "@/lib/pin-device";
import { PinApiError, logError, logInfo } from "@/lib/pin-device";
import { StatusMessage } from "@/components/Status";
import { EmptyState, SectionSkeleton } from "@/components/States";
import settings from "../../settings.module.css";
import styles from "../_lib/panes.module.css";
import { ArmedClearControl, DeviceRequired, PaneSection } from "../_lib/PaneShell";
import { usePinPaneSession } from "../_lib/pinSession";
import {
  fitnessFileLabel,
  formatFitnessDuration,
  formatFitnessFileSize,
  formatFitnessTimestampMs,
  saveFitnessFileBlob,
} from "../_lib/fitnessPresentation";

/*
 * Workouts recorded on the Pin.
 *
 * Ported from the fitness tab of the retired Setup SPA's `ActivityPage.tsx`
 * plus its `pages/fitnessPresentation.ts`. The Notes, Prompts and Music tabs of
 * that page were dropped here on the grounds that "Center owns /notes,
 * /my-data/ai-mic and /my-data/music" while fitness had no counterpart. Half of
 * that was wrong: those three Center surfaces are COSMOS CLOUD views, and the
 * SPA's tabs read three tables on the device. Center now presents assistant
 * history through Ai Mic instead of exposing a second activity surface.
 *
 * These sessions live on the device and are not synced to the cloud. Deleting
 * one here deletes the only copy, which is why both destructive actions confirm
 * first and why the exports are offered before them.
 *
 * File downloads go through `client.fetchFitnessSessionFile`, which routes
 * through `requireFitnessSessionFilename` — a three-name allowlist enforced on
 * both sides. A session id is likewise canonicalised before it reaches a URL,
 * so no value from the device can be used to traverse out of the fitness
 * namespace.
 */

type LoadState = "idle" | "loading" | "ready" | "unavailable" | "error";

const SCOPE = "pin-fitness-pane";

function isUnsupported(error: unknown): boolean {
  return (
    error instanceof PinApiError &&
    (error.status === 404 || error.status === 405 || error.status === 501)
  );
}

export default function PinFitnessPane() {
  const { client, connectionError, attachedWithoutServer } = usePinPaneSession();

  const [sessions, setSessions] = useState<FitnessSession[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [clearArmed, setClearArmed] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    const requestClient = client;
    setState("loading");
    setMessage(null);
    try {
      const response = await requestClient.listFitnessSessions();
      setSessions(response.sessions);
      setState("ready");
      logInfo(SCOPE, "Fitness sessions loaded", {
        count: response.sessions.length,
      });
    } catch (error) {
      const unsupported = isUnsupported(error);
      setState(unsupported ? "unavailable" : "error");
      setMessage(
        unsupported
          ? "This Pin's software does not provide fitness history yet."
          : "Could not load fitness history from the Pin.",
      );
      logError(SCOPE, "Fitness load failed", error);
    }
  }, [client]);

  // A connected client is a privacy boundary: never retain one Pin's workouts
  // across a disconnect and reconnect in the same browser tab.
  useEffect(() => {
    setSessions([]);
    setState("idle");
    setMessage(null);
    setClearArmed(false);
    if (client) void load();
  }, [client, load]);

  // An armed "Delete all 12 workouts" left standing over a list that is no
  // longer 12 is a button whose label is a lie, so any change disarms it.
  useEffect(() => {
    setClearArmed(false);
  }, [sessions.length]);

  async function deleteSession(session: FitnessSession) {
    if (!client || mutating) return;
    if (
      !globalThis.confirm(
        `Delete this workout from ${formatFitnessTimestampMs(session.started_at_ms)}? It is only stored on the Pin, so this cannot be undone.`,
      )
    ) {
      return;
    }
    setMutating(true);
    try {
      await client.deleteFitnessSession(session.session_id);
      setSessions((current) =>
        current.filter((candidate) => candidate.session_id !== session.session_id),
      );
      setMessage(null);
    } catch (error) {
      setMessage(
        isUnsupported(error)
          ? "Deleting fitness sessions is not supported by this Pin's software."
          : "Could not delete this workout.",
      );
      logError(SCOPE, "Fitness delete failed", error, {
        sessionId: session.session_id,
      });
    } finally {
      setMutating(false);
    }
  }

  // No confirm() of its own: the caller is <ArmedClearControl>, which has
  // already made the wearer press twice and shown them the count.
  async function clearAll() {
    if (!client || mutating) return;
    setMutating(true);
    try {
      await client.clearFitnessSessions();
      setSessions([]);
      setState("ready");
      setMessage(null);
    } catch (error) {
      setMessage(
        isUnsupported(error)
          ? "Clearing fitness sessions is not supported by this Pin's software."
          : "Could not clear fitness history.",
      );
      logError(SCOPE, "Fitness clear failed", error);
    } finally {
      setMutating(false);
    }
  }

  async function download(session: FitnessSession, file: FitnessSessionFile) {
    if (!client || downloading) return;
    const key = `${session.session_id}/${file.filename}`;
    setDownloading(key);
    setMessage(null);
    try {
      const blob = await client.fetchFitnessSessionFile(
        session.session_id,
        file.filename,
      );
      saveFitnessFileBlob(blob, file.filename);
      logInfo(SCOPE, "Fitness export downloaded", {
        sessionId: session.session_id,
        filename: file.filename,
      });
    } catch (error) {
      setMessage(
        isUnsupported(error)
          ? "Downloading fitness exports is not supported by this Pin's software."
          : "Could not download this export.",
      );
      logError(SCOPE, "Fitness download failed", error, {
        sessionId: session.session_id,
        filename: file.filename,
      });
    } finally {
      setDownloading(null);
    }
  }

  if (!client) {
    return (
      <DeviceRequired
        attachedWithoutServer={attachedWithoutServer}
        what="workouts recorded on this Pin"
        connectionError={connectionError}
      />
    );
  }

  if (state === "loading" || state === "idle") {
    return <SectionSkeleton rows={4} />;
  }

  if (state === "unavailable" || state === "error") {
    return (
      <PaneSection title="Fitness" testId="pin-fitness">
        <div className={settings.stateRow}>
          <StatusMessage
            tone="warning"
            onRetry={state === "error" ? () => void load() : undefined}
          >
            {message}
          </StatusMessage>
        </div>
      </PaneSection>
    );
  }

  return (
    <PaneSection
      title="Workouts on this Pin"
      testId="pin-fitness"
      action={
        <span className={styles.chipRow}>
          <button
            type="button"
            className={styles.smallButton}
            onClick={() => void load()}
            disabled={mutating}
          >
            Refresh
          </button>
        </span>
      }
    >
      <div className={styles.formRow}>
        <p className={styles.formHelp}>
          Recorded by the Pin and stored only on the Pin — Center holds no copy, so
          export anything you want to keep before deleting it.
        </p>
        {message ? <StatusMessage tone="warning">{message}</StatusMessage> : null}
      </div>

      {sessions.length > 0 ? (
        <ArmedClearControl
          armed={clearArmed}
          question={`Delete all ${sessions.length} saved ${sessions.length === 1 ? "workout" : "workouts"} from this Pin? They are not synced anywhere, so this cannot be undone — export anything you want to keep first.`}
          armLabel="Delete all workouts on this Pin"
          confirmLabel={`Delete all ${sessions.length} ${sessions.length === 1 ? "workout" : "workouts"}`}
          busy={mutating}
          disabled={mutating || downloading !== null}
          onArm={() => setClearArmed(true)}
          onCancel={() => setClearArmed(false)}
          onConfirm={() => void clearAll()}
          testId="pin-fitness-clear"
        />
      ) : null}

      {sessions.length === 0 ? (
        <EmptyState
          inline
          title="No workouts recorded yet"
          detail="Start an activity on the Pin and it will appear here the next time this pane loads."
        />
      ) : (
        sessions.map((session) => (
          <article
            className={styles.card}
            key={session.session_id}
            data-testid="pin-fitness-session"
          >
            <div className={styles.cardHeading}>
              <span className={styles.cardTitleGroup}>
                <span className={styles.cardTitleLine}>
                  <h3 className={styles.cardTitle}>
                    Workout · {formatFitnessDuration(session.duration_ms)}
                  </h3>
                </span>
                <span className={styles.cardMeta}>
                  {formatFitnessTimestampMs(session.started_at_ms)} —{" "}
                  {formatFitnessTimestampMs(session.stopped_at_ms)}
                </span>
              </span>
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => void deleteSession(session)}
                disabled={mutating || downloading !== null}
              >
                Delete
              </button>
            </div>

            {session.summary ? (
              <dl className={styles.factList}>
                <dt>Distance</dt>
                <dd>
                  {session.summary.cumulative_distance_km.toLocaleString(undefined, {
                    maximumFractionDigits: 3,
                  })}{" "}
                  km
                </dd>
                <dt>Steps</dt>
                <dd>{session.summary.step_count.toLocaleString()}</dd>
                <dt>Pace</dt>
                <dd>{session.summary.pace}</dd>
                <dt>Elapsed</dt>
                <dd>{session.summary.elapsed_time}</dd>
                <dt>Moving</dt>
                <dd>{session.summary.moving_time}</dd>
                <dt>Splits</dt>
                <dd>{session.summary.splits}</dd>
                <dt>Motion</dt>
                <dd>{session.summary.motion_breakdown}</dd>
              </dl>
            ) : (
              <p className={styles.formHelp}>
                The stock summary was unavailable for this session, but the raw
                exports below are preserved.
              </p>
            )}

            <div className={styles.actionRow} aria-label="Fitness exports">
              {session.files.map((file) => {
                const key = `${session.session_id}/${file.filename}`;
                const isDownloading = downloading === key;
                return (
                  <button
                    key={file.filename}
                    type="button"
                    className={styles.smallButton}
                    disabled={mutating || downloading !== null}
                    onClick={() => void download(session, file)}
                  >
                    {isDownloading
                      ? "Downloading…"
                      : `${fitnessFileLabel(file.filename)} · ${formatFitnessFileSize(file.size_bytes)}`}
                  </button>
                );
              })}
            </div>

            <span className={styles.cardMeta}>
              <code className={styles.mono}>{session.session_id}</code>
            </span>
          </article>
        ))
      )}
    </PaneSection>
  );
}
