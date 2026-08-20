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
const MUSIC_SEARCH_URL = "/api/settings/services/music/search";
const YOUTUBE_CONNECT_URL = "/api/settings/services/music/youtube";
const TIDAL_CONNECT_URL = "/api/settings/services/music/tidal";
const APPLE_CONNECT_URL = "/api/settings/services/music/apple";
const APPLE_MUSICKIT_SCRIPT_URL = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
/** The adapter and the bridge both enforce this; the input agrees with them. */
const MAX_SEARCH_QUERY_CHARACTERS = 80;
const PAIRING_WINDOW_MS = 2 * 60 * 1_000;
const POLL_INTERVAL_MS = 2_500;
const BROWSER_REQUEST_TIMEOUT_MS = 12_000;

type MusicProvider = "spotify" | "youtube_music" | "apple_music" | "tidal";

type AppleMusicKitInstance = {
  authorize(): Promise<string>;
  storefrontId?: string;
};

type AppleMusicKitGlobal = {
  configure(configuration: {
    developerToken: string;
    app: { name: string; build: string };
  }): AppleMusicKitInstance | Promise<AppleMusicKitInstance>;
  getInstance(): AppleMusicKitInstance;
};

declare global {
  interface Window {
    MusicKit?: AppleMusicKitGlobal;
  }
}

let appleMusicKitLoader: Promise<AppleMusicKitGlobal> | null = null;

function loadAppleMusicKit(): Promise<AppleMusicKitGlobal> {
  if (window.MusicKit) return Promise.resolve(window.MusicKit);
  if (appleMusicKitLoader) return appleMusicKitLoader;
  appleMusicKitLoader = new Promise<AppleMusicKitGlobal>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${APPLE_MUSICKIT_SCRIPT_URL}"]`,
    );
    const script = existing ?? document.createElement("script");
    const loaded = () => {
      if (window.MusicKit) resolve(window.MusicKit);
      else reject(new Error("Apple Music sign-in did not load."));
    };
    const failed = () => reject(new Error("Apple Music sign-in could not be loaded."));
    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", failed, { once: true });
    if (!existing) {
      script.src = APPLE_MUSICKIT_SCRIPT_URL;
      script.async = true;
      script.crossOrigin = "anonymous";
      document.head.append(script);
    }
  }).catch((error) => {
    appleMusicKitLoader = null;
    throw error;
  });
  return appleMusicKitLoader!;
}

const MUSIC_PROVIDER_OPTIONS: ReadonlyArray<{
  value: MusicProvider;
  label: string;
  detail: string;
}> = [
  {
    value: "spotify",
    label: "Spotify",
    detail: "Built into Penumbra; pair Spotify Premium from your phone.",
  },
  {
    value: "youtube_music",
    label: "YouTube Music",
    detail: "Connect here with a Google device code. Audio and ad payloads are filtered in Center.",
  },
  {
    value: "apple_music",
    label: "Apple Music",
    detail: "Connect your Apple Music account here; Pin playback stays gated until the official runtime is available.",
  },
  {
    value: "tidal",
    label: "TIDAL",
    detail: "Connect here with TIDAL OAuth; Center proxies the official audio stream.",
  },
];

function providerOption(provider: MusicProvider) {
  return MUSIC_PROVIDER_OPTIONS.find((option) => option.value === provider)!;
}

function providerConnected(status: SpotifyStatus, provider: MusicProvider): boolean {
  if (provider === "spotify") return status.state === "ready";
  const state = status.providers?.[provider]?.state;
  return state === "connected" || state === "connected_playback_runtime_required";
}

type SpotifyState =
  | "disabled"
  | "not_configured"
  | "pairing"
  | "ready"
  | "error"
  | "unavailable";

type SpotifyStatus = {
  active_provider: MusicProvider;
  providers?: {
    youtube_music: {
      configured: boolean;
      state: "not_connected" | "pairing" | "connected" | "error";
      device_code?: { user_code: string; verification_url: string; expires_at: number };
      ad_filtering: "pear_newpipe";
    };
    tidal: {
      configured: boolean;
      state: "not_configured" | "not_connected" | "connecting" | "connected" | "error";
    };
    apple_music: {
      configured: boolean;
      state:
        | "not_configured"
        | "not_connected"
        | "connected_playback_runtime_required"
        | "error";
    };
  };
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

type Action = "idle" | "saving" | "pairing" | "cancelling" | "disconnecting" | "connecting_provider";

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
  if (status.active_provider !== "spotify") {
    const provider = providerOption(status.active_provider);
    const connected = providerConnected(status, status.active_provider);
    if (status.active_provider === "apple_music" && connected) {
      return {
        label: "Account connected",
        tone: "degraded",
        copy: "Apple Music is connected in Center. Native Pin playback still needs Apple’s official runtime.",
      };
    }
    return {
      label: connected ? "Connected" : "Needs connection",
      tone: connected ? "live" : "degraded",
      copy: connected
        ? `${provider.label} receives native music prompts through Center.`
        : `${provider.label} must be connected in Center before it can receive prompts.`,
    };
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
    throw new Error(body?.error || "Music services couldn’t be reached.");
  }
  if (!body || typeof body.state !== "string") {
    throw new Error("Music services returned an invalid response.");
  }
  return body as SpotifyStatus;
}

export function SpotifyServiceCard() {
  const [status, setStatus] = useState<SpotifyStatus | null>(null);
  const [activeProvider, setActiveProvider] = useState<MusicProvider>("spotify");
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
      setActiveProvider(next.active_provider || "spotify");
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
          if (request.timedOut()) setError("Music services took too long to respond.");
          else if (!request.controller.signal.aborted) {
            setError(cause instanceof Error ? cause.message : "Music services couldn’t be reached.");
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

  useEffect(() => {
    if (activeProvider === "apple_music" && status?.providers?.apple_music.configured) {
      void loadAppleMusicKit().catch(() => undefined);
    }
  }, [activeProvider, status?.providers?.apple_music.configured]);

  useEffect(() => () => {
    activeRequestRef.current?.controller.abort();
    if (activeRequestRef.current) window.clearTimeout(activeRequestRef.current.deadline);
  }, []);

  useEffect(() => {
    const providerPairing =
      status?.providers?.youtube_music.state === "pairing" ||
      status?.providers?.tidal.state === "connecting";
    if (status?.state !== "pairing" && !providerPairing) return;
    const poll = window.setInterval(() => void loadStatus(false, true), POLL_INTERVAL_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, [loadStatus, status?.providers?.tidal.state, status?.providers?.youtube_music.state, status?.state]);

  const trimmedName = deviceName.trim();
  const spotifySelected = activeProvider === "spotify";
  const nameValid = trimmedName.length > 0 && [...trimmedName].length <= 48 && !/\p{Cc}/u.test(trimmedName);
  const dirty = Boolean(
    status &&
      (activeProvider !== status.active_provider ||
        enabled !== status.enabled ||
        acknowledged !== status.experimental_acknowledged ||
        trimmedName !== status.device_name),
  );
  const busy = action !== "idle";
  const providerReady = activeProvider === "spotify"
    ? true
    : status?.providers?.[activeProvider]?.state === "connected";
  const state = status ? spotifyState(status) : null;
  const canPair = Boolean(
    status &&
      spotifySelected &&
      enabled &&
      acknowledged &&
      !dirty &&
      status.state !== "pairing" &&
      !(status.state === "ready" && status.engine_ready) &&
      !busy,
  );

  const pairingTime = useMemo(() => countdown(pairingDeadline, now), [now, pairingDeadline]);
  const youtubeCode = status?.providers?.youtube_music.device_code;
  const youtubePairingTime = useMemo(
    () => countdown(youtubeCode?.expires_at ?? null, now),
    [now, youtubeCode?.expires_at],
  );

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
    if (spotifySelected && !nameValid) {
      setError("Choose a device name between 1 and 48 characters.");
      return;
    }
    if (spotifySelected && enabled && !acknowledged) {
      setError("Confirm personal testing and Spotify Premium before enabling Spotify.");
      return;
    }
    if (!providerReady) {
      setError(`Connect ${providerOption(activeProvider).label} in Center before selecting it.`);
      return;
    }
    await mutate(
      "saving",
      STATUS_URL,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          active_provider: activeProvider,
          enabled,
          experimental_acknowledged: acknowledged,
          device_name: trimmedName,
        }),
      },
      `${providerOption(activeProvider).label} selected for native music prompts.`,
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

  async function providerAction(
    provider: "youtube_music" | "tidal",
    method: "POST" | "DELETE",
  ) {
    if (busy) return;
    const request = beginRequest();
    if (!request) return;
    setAction(method === "POST" ? "connecting_provider" : "disconnecting");
    setError(null);
    setMessage(null);
    const url = provider === "youtube_music" ? YOUTUBE_CONNECT_URL : TIDAL_CONNECT_URL;
    try {
      const response = await fetch(url, { method, cache: "no-store", signal: request.controller.signal });
      const body = await response.json().catch(() => null) as { authorization_url?: string; error?: string } | null;
      if (!response.ok) throw new Error(body?.error || `${providerOption(provider).label} couldn’t be reached.`);
      if (provider === "tidal" && method === "POST" && body?.authorization_url) {
        window.location.assign(body.authorization_url);
        return;
      }
      await loadStatus(true);
      setMessage(method === "POST" ? `Finish connecting ${providerOption(provider).label}.` : `${providerOption(provider).label} disconnected.`);
    } catch (cause) {
      if (!request.controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Music provider couldn’t be reached.");
    } finally {
      request.finish();
      setAction("idle");
    }
  }

  async function appleAction(method: "POST" | "DELETE") {
    if (busy) return;
    setAction(method === "POST" ? "connecting_provider" : "disconnecting");
    setError(null);
    setMessage(null);
    try {
      if (method === "DELETE") {
        const response = await fetch(APPLE_CONNECT_URL, {
          method,
          cache: "no-store",
          signal: AbortSignal.timeout(BROWSER_REQUEST_TIMEOUT_MS),
        });
        const body = await response.json().catch(() => null) as { error?: string } | null;
        if (!response.ok) throw new Error(body?.error || "Apple Music couldn’t be disconnected.");
        await loadStatus(true);
        setMessage("Apple Music disconnected.");
        return;
      }

      const [musicKit, tokenResponse] = await Promise.all([
        loadAppleMusicKit(),
        fetch(APPLE_CONNECT_URL, {
          cache: "no-store",
          signal: AbortSignal.timeout(BROWSER_REQUEST_TIMEOUT_MS),
        }),
      ]);
      const tokenBody = await tokenResponse.json().catch(() => null) as {
        developer_token?: string;
        error?: string;
      } | null;
      if (!tokenResponse.ok || !tokenBody?.developer_token) {
        throw new Error(tokenBody?.error || "Apple Music sign-in is not configured.");
      }
      const configured = await musicKit.configure({
        developerToken: tokenBody.developer_token,
        app: { name: "Penumbra Center", build: "1.0.0" },
      });
      const instance = configured ?? musicKit.getInstance();
      const musicUserToken = await instance.authorize();
      if (!musicUserToken) throw new Error("Apple Music did not return an account token.");
      const saveResponse = await fetch(APPLE_CONNECT_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          music_user_token: musicUserToken,
          ...(instance.storefrontId ? { storefront: instance.storefrontId } : {}),
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(BROWSER_REQUEST_TIMEOUT_MS),
      });
      const saveBody = await saveResponse.json().catch(() => null) as { error?: string } | null;
      if (!saveResponse.ok) throw new Error(saveBody?.error || "Apple Music couldn’t be connected.");
      await loadStatus(true);
      setMessage("Apple Music connected in Center. Pin playback remains unavailable until the official runtime is installed in Penumbra.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Apple Music couldn’t be reached.");
    } finally {
      setAction("idle");
    }
  }

  return (
    <section className={settings.section} data-testid="spotify-service-card">
      <div className={settings.sectionHeader}>
        <span className={settings.sectionTitle}>Music</span>
      </div>

      <div className={styles.serviceHead}>
        <span className={styles.musicMark} aria-hidden="true">♪</span>
        <span className={styles.serviceCopy}>
          <strong>{providerOption(activeProvider).label}</strong>
          <span>Select the service that receives every native music prompt.</span>
        </span>
        {state ? <StatusChip tone={state.tone} label={state.label} /> : null}
      </div>

      {loading ? (
        <div className={settings.stateRow}>
          <span className={settings.muted}>Checking music services…</span>
        </div>
      ) : status?.state === "unavailable" ? (
        <div className={styles.noticeArea}>
          <StatusMessage tone="warning" onRetry={() => void loadStatus()}>
            {state?.copy ?? "Music services are unavailable."}
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

          {spotifySelected && status.state === "pairing" ? (
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
              <label className={styles.fieldRow}>
                <span>
                  <strong>Default provider</strong>
                  <small>{providerOption(activeProvider).detail}</small>
                </span>
                <select
                  className={styles.providerSelect}
                  value={activeProvider}
                  disabled={busy}
                  onChange={(event) => setActiveProvider(event.target.value as MusicProvider)}
                >
                  {MUSIC_PROVIDER_OPTIONS.map((provider) => (
                    <option key={provider.value} value={provider.value}>{provider.label}</option>
                  ))}
                </select>
              </label>

              {spotifySelected ? (
                <>
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
                </>
              ) : (
                <div className={styles.providerNote}>
                  {activeProvider === "youtube_music" ? (
                    <>
                      <strong>Connect YouTube Music in Center</strong>
                      <span>
                        No app is installed on the Pin. Center uses an audio-only InnerTube session,
                        removes Pear&rsquo;s ad fields, blocks ad/tracker hosts, and returns only opaque streams.
                      </span>
                      {youtubeCode && status.providers?.youtube_music.state === "pairing" ? (
                        <div className={styles.deviceCode}>
                          <span className={styles.pairingTimer}>{youtubePairingTime}</span>
                          <span>
                            Open <a href={youtubeCode.verification_url} target="_blank" rel="noreferrer">{youtubeCode.verification_url}</a>
                            {" "}and enter <strong>{youtubeCode.user_code}</strong>.
                          </span>
                        </div>
                      ) : null}
                      <div className={styles.providerActions}>
                        {status.providers?.youtube_music.state === "connected" ? (
                          <button type="button" className={styles.dangerButton} disabled={busy} onClick={() => void providerAction("youtube_music", "DELETE")}>Disconnect</button>
                        ) : (
                          <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void providerAction("youtube_music", "POST")}>{action === "connecting_provider" ? "Starting…" : "Connect YouTube Music"}</button>
                        )}
                      </div>
                    </>
                  ) : activeProvider === "tidal" ? (
                    <>
                      <strong>Connect TIDAL in Center</strong>
                      <span>No TIDAL app is installed on the Pin. Sign-in uses TIDAL&rsquo;s official OAuth + PKCE flow.</span>
                      {!status.providers?.tidal.configured ? <span>The operator must configure a TIDAL developer client first.</span> : null}
                      <div className={styles.providerActions}>
                        {status.providers?.tidal.state === "connected" ? (
                          <button type="button" className={styles.dangerButton} disabled={busy} onClick={() => void providerAction("tidal", "DELETE")}>Disconnect</button>
                        ) : (
                          <button type="button" className={styles.primaryButton} disabled={busy || !status.providers?.tidal.configured} onClick={() => void providerAction("tidal", "POST")}>{action === "connecting_provider" ? "Opening TIDAL…" : "Connect TIDAL"}</button>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <strong>Connect Apple Music in Center</strong>
                      <span>
                        No Apple Music app is installed on the Pin. Sign-in uses Apple&rsquo;s official
                        MusicKit window and Center stores the resulting account token encrypted.
                      </span>
                      {!status.providers?.apple_music.configured ? (
                        <span>The operator must configure an Apple Music developer token first.</span>
                      ) : status.providers.apple_music.state === "connected_playback_runtime_required" ? (
                        <span>
                          Your account is connected. Apple&rsquo;s official Android playback and DRM runtime
                          is still required before Apple Music can be selected for Pin prompts.
                        </span>
                      ) : (
                        <span>
                          Center does not substitute previews or bypass Apple&rsquo;s playback protection.
                        </span>
                      )}
                      <div className={styles.providerActions}>
                        {status.providers?.apple_music.state === "connected_playback_runtime_required" ? (
                          <button
                            type="button"
                            className={styles.dangerButton}
                            disabled={busy}
                            onClick={() => void appleAction("DELETE")}
                          >
                            Disconnect
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={styles.primaryButton}
                            disabled={busy || !status.providers?.apple_music.configured}
                            onClick={() => void appleAction("POST")}
                          >
                            {action === "connecting_provider" ? "Opening Apple Music…" : "Connect Apple Music"}
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={busy || !dirty || !providerReady || (spotifySelected && !nameValid)}
                  onClick={() => void saveSettings()}
                >
                  {action === "saving" ? "Saving…" : "Save"}
                </button>
                {spotifySelected && status.state === "not_configured" ? (
                  <button
                    type="button"
                    className={styles.primaryButton}
                    disabled={!canPair}
                    onClick={() => void startPairing()}
                  >
                    {action === "pairing" ? "Starting…" : "Start pairing"}
                  </button>
                ) : null}
                {spotifySelected && status.state === "error" ? (
                  <button
                    type="button"
                    className={styles.primaryButton}
                    disabled={!canPair}
                    onClick={() => void startPairing()}
                  >
                    Pair again
                  </button>
                ) : null}
                {spotifySelected && (status.state === "ready" || status.state === "error") ? (
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

          {(spotifySelected && status.state === "ready") || (!spotifySelected && providerReady) ? (
            <SpotifySearchCheck busy={busy} provider={activeProvider} />
          ) : null}

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
function SpotifySearchCheck({ busy, provider }: { busy: boolean; provider: MusicProvider }) {
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
      const endpoint = provider === "spotify"
        ? `${SEARCH_URL}?q=${encodeURIComponent(trimmed)}`
        : `${MUSIC_SEARCH_URL}?provider=${encodeURIComponent(provider)}&q=${encodeURIComponent(trimmed)}`;
      const response = await fetch(endpoint, {
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
        <strong>Check the connected catalog</strong>
        <small>
          Search {providerOption(provider).label} through the same provider path native Pin prompts use.
          Nothing plays and nothing changes.
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
          {providerOption(provider).label} answered, but nothing matched that search.
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
