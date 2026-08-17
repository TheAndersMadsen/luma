"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { StatusChip, StatusMessage, Switch, type StatusTone } from "@/components/Status";
import settings from "../../settings.module.css";
import styles from "./services.module.css";

const STATUS_URL = "/api/settings/services/spotify";
const PAIR_URL = `${STATUS_URL}/pair`;
const CANCEL_URL = `${STATUS_URL}/cancel`;
const SEARCH_URL = `${STATUS_URL}/search`;
/** The adapter and the bridge both enforce this; the input agrees with them. */
const MAX_SEARCH_QUERY_CHARACTERS = 80;
const PAIRING_WINDOW_MS = 2 * 60 * 1_000;
const POLL_INTERVAL_MS = 2_500;
const BROWSER_REQUEST_TIMEOUT_MS = 12_000;

type SpotifyState =
  | "disabled"
  | "not_configured"
  | "pairing"
  | "ready"
  | "error"
  | "unavailable";

type SpotifyStatus = {
  enabled: boolean;
  experimental_acknowledged: boolean;
  state: SpotifyState;
  device_name: string;
  username?: string;
  engine_ready: boolean;
  pairing_expires_at?: number;
  last_error?: string;
  unavailable_reason?:
    | "not_configured"
    | "pairing_unconfirmed"
    | "pin_unavailable"
    | "pin_update_required";
  fallback_setup?: boolean;
};

type Action = "idle" | "saving" | "pairing" | "cancelling" | "disconnecting";

type SpotifySearchTrack = {
  id: string;
  title: string;
  artists: string[];
  album?: string;
  duration_ms?: number;
  explicit?: boolean;
};

function trackDuration(milliseconds: number | undefined): string | null {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return null;
  const seconds = Math.round(milliseconds / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Artists · Album · 3:42, with the parts that are missing simply absent. */
function trackSubtitle(track: SpotifySearchTrack): string {
  return [track.artists.join(", "), track.album, trackDuration(track.duration_ms)]
    .filter(Boolean)
    .join(" · ");
}

function spotifyState(status: SpotifyStatus): { label: string; tone: StatusTone; copy: string } {
  if (status.state === "unavailable") {
    const copy =
      status.unavailable_reason === "not_configured"
        ? "Spotify setup isn’t available in Center yet."
        : status.unavailable_reason === "pairing_unconfirmed"
          ? "Your paired Pin couldn’t be confirmed."
          : status.unavailable_reason === "pin_update_required"
            ? "Your Pin’s Spotify service needs an update."
            : "Your Pin couldn’t be reached.";
    return { label: "Unavailable", tone: "degraded", copy };
  }
  if (status.state === "disabled") {
    return { label: "Off", tone: "off", copy: "Spotify is turned off on your Pin." };
  }
  if (status.state === "not_configured") {
    return { label: "Not connected", tone: "absent", copy: "Pair Spotify to start listening." };
  }
  if (status.state === "pairing") {
    return { label: "Pairing", tone: "live", copy: "Your Pin is ready in Spotify’s device list." };
  }
  if (status.state === "ready" && !status.engine_ready) {
    return { label: "Reconnecting", tone: "degraded", copy: "Your account is paired. The player is reconnecting." };
  }
  if (status.state === "ready") {
    return { label: "Connected", tone: "live", copy: "Spotify is ready on your Pin." };
  }
  return {
    label: "Needs attention",
    tone: "degraded",
    copy: status.last_error || "Spotify needs to be paired again.",
  };
}

function expiryMilliseconds(value: number | undefined): number | null {
  if (!value || !Number.isFinite(value)) return null;
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function countdown(deadline: number | null, now: number): string {
  if (!deadline) return "2:00";
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

async function spotifyRequest(
  url: string,
  init: RequestInit | undefined,
  signal: AbortSignal,
): Promise<SpotifyStatus> {
  const response = await fetch(url, { cache: "no-store", ...init, signal });
  const body = (await response.json().catch(() => null)) as
    | (Partial<SpotifyStatus> & { error?: string })
    | null;
  if (!response.ok) {
    throw new Error(body?.error || "Spotify couldn’t be reached.");
  }
  if (!body || typeof body.state !== "string") {
    throw new Error("Spotify returned an invalid response.");
  }
  return body as SpotifyStatus;
}

export function SpotifyServiceCard() {
  const [status, setStatus] = useState<SpotifyStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [deviceName, setDeviceName] = useState("Ai Pin");
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<Action>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairingDeadline, setPairingDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const draftInitializedRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const activeRequestRef = useRef<{
    controller: AbortController;
    generation: number;
    deadline: number;
    timedOut: boolean;
  } | null>(null);

  const beginRequest = useCallback((pollOnly = false) => {
    if (pollOnly && activeRequestRef.current) return null;
    activeRequestRef.current?.controller.abort();
    const request = {
      controller: new AbortController(),
      generation: ++requestGenerationRef.current,
      deadline: 0,
      timedOut: false,
    };
    request.deadline = window.setTimeout(() => {
      request.timedOut = true;
      request.controller.abort();
    }, BROWSER_REQUEST_TIMEOUT_MS);
    activeRequestRef.current = request;
    return {
      controller: request.controller,
      timedOut: () => request.timedOut,
      isCurrent: () => activeRequestRef.current?.generation === request.generation,
      finish: () => {
        window.clearTimeout(request.deadline);
        if (activeRequestRef.current?.generation === request.generation) {
          activeRequestRef.current = null;
        }
      },
    };
  }, []);

  const acceptStatus = useCallback((next: SpotifyStatus, syncDraft = false) => {
    setStatus(next);
    setError(null);
    if (next.state !== "unavailable" && (syncDraft || !draftInitializedRef.current)) {
      setEnabled(next.enabled);
      setAcknowledged(next.experimental_acknowledged);
      setDeviceName(next.device_name || "Ai Pin");
      draftInitializedRef.current = true;
    }
    setPairingDeadline((current) => {
      if (next.state !== "pairing") return null;
      return expiryMilliseconds(next.pairing_expires_at) ?? current ?? Date.now() + PAIRING_WINDOW_MS;
    });
  }, []);

  const loadStatus = useCallback(
    async (syncDraft = false, pollOnly = false) => {
      const request = beginRequest(pollOnly);
      if (!request) return null;
      try {
        const next = await spotifyRequest(STATUS_URL, undefined, request.controller.signal);
        if (!request.isCurrent()) return null;
        acceptStatus(next, syncDraft);
        return next;
      } catch (cause) {
        if (request.isCurrent()) {
          if (request.timedOut()) setError("Spotify took too long to respond.");
          else if (!request.controller.signal.aborted) {
            setError(cause instanceof Error ? cause.message : "Spotify couldn’t be reached.");
          }
        }
        return null;
      } finally {
        const latest = request.isCurrent();
        request.finish();
        if (latest) setLoading(false);
      }
    },
    [acceptStatus, beginRequest],
  );

  useEffect(() => {
    void loadStatus(true);
  }, [loadStatus]);

  useEffect(() => () => {
    activeRequestRef.current?.controller.abort();
    if (activeRequestRef.current) window.clearTimeout(activeRequestRef.current.deadline);
  }, []);

  useEffect(() => {
    if (status?.state !== "pairing") return;
    const poll = window.setInterval(() => void loadStatus(false, true), POLL_INTERVAL_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, [loadStatus, status?.state]);

  const trimmedName = deviceName.trim();
  const nameValid = trimmedName.length > 0 && [...trimmedName].length <= 48 && !/\p{Cc}/u.test(trimmedName);
  const dirty = Boolean(
    status &&
      (enabled !== status.enabled ||
        acknowledged !== status.experimental_acknowledged ||
        trimmedName !== status.device_name),
  );
  const busy = action !== "idle";
  const state = status ? spotifyState(status) : null;
  const canPair = Boolean(
    status &&
      enabled &&
      acknowledged &&
      !dirty &&
      status.state !== "pairing" &&
      !(status.state === "ready" && status.engine_ready) &&
      !busy,
  );

  const pairingTime = useMemo(() => countdown(pairingDeadline, now), [now, pairingDeadline]);

  async function mutate(
    nextAction: Exclude<Action, "idle">,
    url: string,
    init: RequestInit,
    success: string,
    syncDraft = false,
  ) {
    if (busy) return;
    const request = beginRequest();
    if (!request) return;
    setAction(nextAction);
    setMessage(null);
    setError(null);
    try {
      const next = await spotifyRequest(url, init, request.controller.signal);
      if (!request.isCurrent()) return;
      acceptStatus(next, syncDraft);
      setMessage(success);
    } catch (cause) {
      if (request.isCurrent()) {
        if (request.timedOut()) setError("Spotify took too long to respond.");
        else if (!request.controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Spotify couldn’t be reached.");
        }
      }
    } finally {
      request.finish();
      setAction((current) => (current === nextAction ? "idle" : current));
    }
  }

  async function saveSettings() {
    if (!nameValid) {
      setError("Choose a device name between 1 and 48 characters.");
      return;
    }
    if (enabled && !acknowledged) {
      setError("Confirm personal testing and Spotify Premium before enabling Spotify.");
      return;
    }
    await mutate(
      "saving",
      STATUS_URL,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled,
          experimental_acknowledged: acknowledged,
          device_name: trimmedName,
        }),
      },
      "Spotify settings saved.",
      true,
    );
  }

  async function startPairing() {
    setPairingDeadline(Date.now() + PAIRING_WINDOW_MS);
    await mutate(
      "pairing",
      PAIR_URL,
      { method: "POST" },
      `Open Spotify and choose “${trimmedName}”.`,
    );
  }

  async function cancelPairing() {
    await mutate("cancelling", CANCEL_URL, { method: "POST" }, "Pairing cancelled.");
  }

  async function disconnect() {
    if (!window.confirm("Disconnect Spotify from this Ai Pin?")) return;
    await mutate(
      "disconnecting",
      STATUS_URL,
      { method: "DELETE" },
      "Spotify disconnected.",
      true,
    );
  }

  return (
    <section className={settings.section} data-testid="spotify-service-card">
      <div className={settings.sectionHeader}>
        <span className={settings.sectionTitle}>Music</span>
      </div>

      <div className={styles.serviceHead}>
        <span className={styles.spotifyMark} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className={styles.serviceCopy}>
          <strong>Spotify</strong>
          <span>Play Spotify Premium directly on your Ai Pin.</span>
        </span>
        {state ? <StatusChip tone={state.tone} label={state.label} /> : null}
      </div>

      {loading ? (
        <div className={settings.stateRow}>
          <span className={settings.muted}>Checking Spotify…</span>
        </div>
      ) : status?.state === "unavailable" ? (
        <div className={styles.noticeArea}>
          <StatusMessage tone="warning" onRetry={() => void loadStatus()}>
            {state?.copy ?? "Spotify is unavailable."}
          </StatusMessage>
          {status.fallback_setup ? (
            <Link className={styles.quietButton} href="/settings/pin">
              Open connection & maintenance
            </Link>
          ) : null}
        </div>
      ) : status ? (
        <>
          <div className={styles.summary}>
            <span>{state?.copy}</span>
            {status.username ? <span className={styles.account}>{status.username}</span> : null}
          </div>

          {status.state === "pairing" ? (
            <div className={styles.pairingPanel} data-testid="spotify-pairing-state">
              <div className={styles.pairingTimer} aria-live="polite">{pairingTime}</div>
              <div>
                <strong>Finish in the Spotify app</strong>
                <p>
                  On a phone using the same Wi-Fi, play anything, open Devices, then choose
                  {" "}&ldquo;{status.device_name}&rdquo;.
                </p>
              </div>
              <button
                type="button"
                className={styles.quietButton}
                disabled={busy}
                onClick={() => void cancelPairing()}
              >
                {action === "cancelling" ? "Cancelling…" : "Cancel"}
              </button>
            </div>
          ) : (
            <div className={styles.settingsForm}>
              <div className={styles.settingRow}>
                <span>
                  <strong>Use Spotify</strong>
                  <small>Spotify stays off until you enable it here.</small>
                </span>
                <Switch
                  checked={enabled}
                  disabled={busy || (!acknowledged && !enabled)}
                  ariaLabel="Use Spotify"
                  onChange={setEnabled}
                />
              </div>

              <label className={styles.fieldRow}>
                <span>
                  <strong>Device name</strong>
                  <small>This is the name you&rsquo;ll choose in Spotify.</small>
                </span>
                <input
                  className={styles.deviceName}
                  value={deviceName}
                  maxLength={48}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  onChange={(event) => setDeviceName(event.target.value)}
                />
              </label>

              <label className={styles.acknowledgement}>
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={busy}
                  onChange={(event) => {
                    const next = event.target.checked;
                    setAcknowledged(next);
                    if (!next) setEnabled(false);
                  }}
                />
                <span>I understand this is for personal testing and requires Spotify Premium.</span>
              </label>

              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={busy || !dirty || !nameValid}
                  onClick={() => void saveSettings()}
                >
                  {action === "saving" ? "Saving…" : "Save"}
                </button>
                {status.state === "not_configured" ? (
                  <button
                    type="button"
                    className={styles.primaryButton}
                    disabled={!canPair}
                    onClick={() => void startPairing()}
                  >
                    {action === "pairing" ? "Starting…" : "Start pairing"}
                  </button>
                ) : null}
                {status.state === "error" ? (
                  <button
                    type="button"
                    className={styles.primaryButton}
                    disabled={!canPair}
                    onClick={() => void startPairing()}
                  >
                    Pair again
                  </button>
                ) : null}
                {status.state === "ready" || status.state === "error" ? (
                  <button
                    type="button"
                    className={styles.dangerButton}
                    disabled={busy}
                    onClick={() => void disconnect()}
                  >
                    {action === "disconnecting" ? "Disconnecting…" : "Disconnect"}
                  </button>
                ) : null}
              </div>
            </div>
          )}

          {status.state === "ready" ? <SpotifySearchCheck busy={busy} /> : null}

          {message ? (
            <div className={styles.messageArea}>
              <StatusMessage tone="info">{message}</StatusMessage>
            </div>
          ) : null}
        </>
      ) : null}

      {error ? (
        <div className={styles.messageArea}>
          <StatusMessage tone="warning" onRetry={() => void loadStatus()}>{error}</StatusMessage>
        </div>
      ) : null}
    </section>
  );
}

/**
 * A real query through the Pin's Spotify session, run on demand.
 *
 * "Connected" above only means the Pin holds a paired session. It stays
 * "Connected" when the Premium subscription lapsed, when the engine never got a
 * usable token back, and when the Pin is unreachable but the last status read
 * is still on screen. Each of those first shows up as the wearer asking for a
 * song and getting nothing, with no way to tell which one happened.
 *
 * This runs the Pin's own `diagnostic_search` and shows what came back. It
 * plays nothing and changes nothing, so it is safe to press twice — and only
 * offered while the session is ready, because in every other state the answer
 * is already on the card.
 */
function SpotifySearchCheck({ busy }: { busy: boolean }) {
  const [query, setQuery] = useState("");
  const [tracks, setTracks] = useState<SpotifySearchTrack[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchRequestRef = useRef<AbortController | null>(null);

  useEffect(() => () => searchRequestRef.current?.abort(), []);

  const trimmed = query.trim();

  async function runSearch() {
    if (searching || !trimmed) return;
    searchRequestRef.current?.abort();
    const controller = new AbortController();
    searchRequestRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), BROWSER_REQUEST_TIMEOUT_MS);

    setSearching(true);
    setSearchError(null);
    setTracks(null);
    try {
      const response = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(trimmed)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => null)) as
        | { items?: SpotifySearchTrack[]; error?: string }
        | null;
      if (!response.ok) throw new Error(body?.error || "The search couldn’t be run.");
      setTracks(body?.items ?? []);
    } catch (cause) {
      if (controller.signal.aborted) {
        setSearchError("The search took too long. Your Pin may be offline.");
      } else {
        setSearchError(cause instanceof Error ? cause.message : "The search couldn’t be run.");
      }
    } finally {
      window.clearTimeout(timeout);
      if (searchRequestRef.current === controller) searchRequestRef.current = null;
      setSearching(false);
    }
  }

  return (
    <div className={styles.searchPanel} data-testid="spotify-search-check">
      <div className={styles.searchIntro}>
        <strong>Check that music plays</strong>
        <small>
          Search Spotify through your Pin. Nothing plays and nothing changes — it only
          confirms the Pin can still reach your account.
        </small>
      </div>

      <div className={styles.searchControls}>
        <input
          className={styles.searchField}
          value={query}
          maxLength={MAX_SEARCH_QUERY_CHARACTERS}
          autoComplete="off"
          placeholder="A song or artist"
          aria-label="Test song search"
          disabled={busy || searching}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void runSearch();
            }
          }}
        />
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={busy || searching || !trimmed}
          onClick={() => void runSearch()}
        >
          {searching ? "Searching…" : "Search"}
        </button>
      </div>

      {searchError ? (
        <StatusMessage tone="warning" inline>
          {searchError}
        </StatusMessage>
      ) : tracks === null ? null : tracks.length === 0 ? (
        <StatusMessage tone="info" inline>
          Spotify answered, but nothing matched that search.
        </StatusMessage>
      ) : (
        <ul className={styles.searchResults}>
          {tracks.map((track) => (
            <li className={styles.searchResult} key={track.id}>
              <span className={styles.searchResultTitle}>
                {track.title}
                {track.explicit ? " · Explicit" : ""}
              </span>
              {trackSubtitle(track) ? (
                <span className={styles.searchResultMeta}>{trackSubtitle(track)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
