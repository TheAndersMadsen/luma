"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatusChip, StatusMessage, Switch, type StatusTone } from "@/components/Status";
import settings from "../../settings.module.css";
import styles from "./services.module.css";
import {
  MUSIC_PROVIDERS,
  musicProviderSchema,
  spotifySearchResultSchema,
  spotifyStatusSchema,
  type MusicProvider,
  type SpotifySearchTrack,
  type SpotifyStatus,
} from "@/lib/contracts/music";
import { parseResponse } from "@/lib/contracts/parse";
import * as z from "zod/mini";

const STATUS_URL = "/api/settings/services/spotify";
const PAIR_URL = `${STATUS_URL}/pair`;
const CANCEL_URL = `${STATUS_URL}/cancel`;
const SEARCH_URL = `${STATUS_URL}/search`;
const MUSIC_SEARCH_URL = "/api/settings/services/music/search";
const YOUTUBE_CONNECT_URL = "/api/settings/services/music/youtube";
const TIDAL_CONNECT_URL = "/api/settings/services/music/tidal";
const APPLE_CONNECT_URL = "/api/settings/services/music/apple";
const APPLE_MUSICKIT_SCRIPT_URL = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
/** The adapter and the bridge both enforce this. The input agrees with them. */
const MAX_SEARCH_QUERY_CHARACTERS = 80;
const PAIRING_WINDOW_MS = 2 * 60 * 1_000;
const POLL_INTERVAL_MS = 2_500;
const BROWSER_REQUEST_TIMEOUT_MS = 12_000;

const responseErrorSchema = z.object({ error: z.string() });
function responseError(value: unknown, fallback: string) {
  const parsed = responseErrorSchema.safeParse(value);
  return parsed.success ? parsed.data.error : fallback;
}
const tidalAuthorizationSchema = z.object({ authorization_url: z.url({ protocol: /^https$/ }) });
const appleDeveloperTokenSchema = z.object({ developer_token: z.string().check(z.minLength(1)) });

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
    const cleanup = () => {
      script.removeEventListener("load", loaded);
      script.removeEventListener("error", failed);
    };
    const loaded = () => {
      cleanup();
      if (window.MusicKit) resolve(window.MusicKit);
      else {
        script.remove();
        reject(new Error("Apple Music sign-in did not load."));
      }
    };
    const failed = () => {
      cleanup();
      script.remove();
      reject(new Error("Apple Music sign-in could not be loaded."));
    };
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

/** Card copy per provider. The label and playback capability are the contract's. */
const PROVIDER_DETAIL: Record<MusicProvider, string> = {
  spotify: "Plays on your Pin; pair Spotify Premium from your phone.",
  youtube_music: "Sign in with Google to listen on your Pin.",
  apple_music: "Apple Music playback isn’t supported on the Pin yet.",
  tidal: "Sign in with TIDAL to listen on your Pin.",
};

const MUSIC_PROVIDER_OPTIONS = musicProviderSchema.options.map((value) => ({
  value,
  label: MUSIC_PROVIDERS[value].label,
  detail: PROVIDER_DETAIL[value],
  playbackAvailable: MUSIC_PROVIDERS[value].pinPlayback,
}));

function providerOption(provider: MusicProvider) {
  return {
    value: provider,
    label: MUSIC_PROVIDERS[provider].label,
    detail: PROVIDER_DETAIL[provider],
    playbackAvailable: MUSIC_PROVIDERS[provider].pinPlayback,
  };
}

/**
 * What the card says once a provider account is linked. Linking alone does not
 * change what the Pin plays: Save does, and only when the Pin can be reached
 * and the saved default is another provider.
 */
function linkedMessage(status: SpotifyStatus | null, provider: MusicProvider): string {
  const label = providerOption(provider).label;
  return status && status.state !== "unavailable" && status.active_provider !== provider
    ? `${label} connected. Press Save to play from it on your Pin.`
    : `${label} connected to Center.`;
}

type MusicReturn = {
  outcome: "tidal-connected" | "tidal-error";
  /** A sign-in the callback could not drop because Center's own had lapsed. */
  unfinishedTidalState: string | null;
};

/**
 * TIDAL's sign-in ends on Center's callback, which sends the owner back here
 * with `?music=tidal-connected` or `?music=tidal-error` (and `tidal_state` when
 * Center's sign-in lapsed on the way). Read it once and drop it from the
 * address bar so a reload does not repeat the notice.
 */
function takeMusicReturn(): MusicReturn | null {
  const url = new URL(window.location.href);
  const outcome = url.searchParams.get("music");
  const unfinishedTidalState = url.searchParams.get("tidal_state");
  url.searchParams.delete("tidal_state");
  if (outcome !== "tidal-connected" && outcome !== "tidal-error") return null;
  url.searchParams.delete("music");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return { outcome, unfinishedTidalState: outcome === "tidal-error" ? unfinishedTidalState : null };
}

/** Drop the unfinished sign-in, so TIDAL stops reading as connecting. */
async function abandonTidalSignIn(state: string | null): Promise<void> {
  if (!state) return;
  await fetch(`${TIDAL_CONNECT_URL}?pending=${encodeURIComponent(state)}`, {
    method: "DELETE",
    cache: "no-store",
    signal: AbortSignal.timeout(BROWSER_REQUEST_TIMEOUT_MS),
  }).catch(() => undefined);
}

function providerConnected(status: SpotifyStatus, provider: MusicProvider): boolean {
  if (provider === "spotify") return status.state === "ready";
  const state = status.providers?.[provider]?.state;
  return state === "connected" || state === "connected_playback_runtime_required";
}

type Action = "idle" | "saving" | "pairing" | "cancelling" | "disconnecting" | "connecting_provider";

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
      status.unavailable_reason === "pin_not_paired"
        ? "Connect an account now. Pair your Pin when you’re ready to choose the default."
        : status.unavailable_reason === "not_configured"
          ? "Music accounts are available, but Pin playback is not configured."
        : status.unavailable_reason === "pairing_unconfirmed"
          ? "Your Pin pairing couldn’t be confirmed."
          : status.unavailable_reason === "pin_update_required"
            ? "Update your Pin’s music service."
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

function providerAccountState(
  status: SpotifyStatus,
  provider: MusicProvider,
): { label: string; tone: StatusTone; copy: string } {
  if (provider === "spotify") return spotifyState(status);
  const providerLabel = providerOption(provider).label;
  const pinCopy = status.state === "unavailable"
    ? " Pair your Ai Pin to choose it for music."
    : "";
  const state = status.providers?.[provider]?.state;
  if (state === "connected_playback_runtime_required") {
    return {
      label: "Account connected",
      tone: "degraded",
      copy: "Your Apple Music account is connected. Playback on the Pin isn’t supported yet.",
    };
  }
  if (state === "connected") {
    return {
      label: "Connected",
      tone: "live",
      copy: `${providerLabel} is connected to Center.${pinCopy}`,
    };
  }
  if (state === "pairing" || state === "connecting") {
    return {
      label: "Connecting",
      tone: "live",
      copy: provider === "youtube_music"
        ? "Waiting for you to approve the Google device code."
        : `Finish signing in with ${providerLabel}.`,
    };
  }
  if (state === "error") {
    return {
      label: "Connection failed",
      tone: "degraded",
      copy: `${providerLabel} did not finish connecting. Try the sign-in again.`,
    };
  }
  if (state === "not_configured") {
    return {
      label: "Not available",
      tone: "off",
      copy: `${providerLabel} is not configured on this Center.`,
    };
  }
  return {
    label: "Not connected",
    tone: "absent",
    copy: `${providerLabel} is not connected to Center.`,
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
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(responseError(body, "Music services couldn’t be reached."));
  return parseResponse(spotifyStatusSchema, body);
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
  const musicReturnRef = useRef<MusicReturn | null | undefined>(undefined);
  const requestGenerationRef = useRef(0);
  const previousYoutubeStateRef = useRef<
    "not_connected" | "pairing" | "connected" | "error" | undefined
  >(undefined);
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
    if (next.state === "unavailable" && !draftInitializedRef.current) {
      const connectedProvider = MUSIC_PROVIDER_OPTIONS
        .map(({ value }) => value)
        .find((provider) => provider !== "spotify" && providerConnected(next, provider));
      setActiveProvider(connectedProvider ?? "spotify");
      draftInitializedRef.current = true;
    }
    if (next.state !== "unavailable" && (syncDraft || !draftInitializedRef.current)) {
      setActiveProvider(next.active_provider);
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
    if (musicReturnRef.current === undefined) musicReturnRef.current = takeMusicReturn();
    void abandonTidalSignIn(musicReturnRef.current?.unfinishedTidalState ?? null)
      .then(() => loadStatus(true))
      .then((next) => {
        const musicReturn = musicReturnRef.current;
        if (!next || !musicReturn) return;
        musicReturnRef.current = null;
        // Back from TIDAL: show its panel, whichever way the sign-in ended.
        setActiveProvider("tidal");
        if (musicReturn.outcome === "tidal-connected") {
          setError(null);
          setMessage(linkedMessage(next, "tidal"));
        } else {
          setMessage(null);
          setError("TIDAL sign-in didn’t finish. Try again.");
        }
      });
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

  const youtubeConnectionState = status?.providers?.youtube_music.state;
  useEffect(() => {
    const previous = previousYoutubeStateRef.current;
    previousYoutubeStateRef.current = youtubeConnectionState;
    if (previous !== "pairing") return;
    if (youtubeConnectionState === "connected") {
      setError(null);
      setMessage(linkedMessage(status, "youtube_music"));
    } else if (youtubeConnectionState === "error") {
      setMessage(null);
      setError("YouTube Music did not finish connecting. Try the sign-in again.");
    }
  }, [status, youtubeConnectionState]);

  const trimmedName = deviceName.trim();
  const spotifySelected = activeProvider === "spotify";
  const nameValid = trimmedName.length > 0 && [...trimmedName].length <= 48 && !/\p{Cc}/u.test(trimmedName);
  // The Pin lost the account's choice (a reinstall, a reset, a new Pin): Save
  // sends it again, with the gateway token, so it must stay available.
  const pinOutOfStep = Boolean(
    status &&
      status.state !== "unavailable" &&
      status.pin_active_provider &&
      status.pin_active_provider !== status.active_provider,
  );
  const dirty = Boolean(
    status &&
      (pinOutOfStep ||
        activeProvider !== status.active_provider ||
        enabled !== status.enabled ||
        acknowledged !== status.experimental_acknowledged ||
        trimmedName !== status.device_name),
  );
  const busy = action !== "idle";
  const providerReady = activeProvider === "spotify"
    ? true
    : status?.providers?.[activeProvider]?.state === "connected";
  const pinState = status ? spotifyState(status) : null;
  const state = status ? providerAccountState(status, activeProvider) : null;
  const youtubeAccountState = status ? providerAccountState(status, "youtube_music") : null;
  const tidalAccountState = status ? providerAccountState(status, "tidal") : null;
  const appleAccountState = status ? providerAccountState(status, "apple_music") : null;
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
      `Your Pin will now play music from ${providerOption(activeProvider).label}.`,
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
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(body, `${providerOption(provider).label} couldn’t be reached.`));
      if (provider === "tidal" && method === "POST") {
        window.location.assign(parseResponse(tidalAuthorizationSchema, body).authorization_url);
        return;
      }
      // A link or unlink keeps the owner's draft: the provider they chose stays
      // on screen with its device code, and Save still decides the default.
      const next = await loadStatus();
      const connected = next?.providers?.[provider]?.state === "connected";
      setMessage(
        method === "DELETE"
          ? `${providerOption(provider).label} disconnected.`
          : connected
            ? linkedMessage(next, provider)
            : `Finish connecting ${providerOption(provider).label}.`,
      );
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
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(responseError(body, "Apple Music couldn’t be disconnected."));
        await loadStatus();
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
      const tokenBody: unknown = await tokenResponse.json().catch(() => null);
      if (!tokenResponse.ok) throw new Error(responseError(tokenBody, "Apple Music sign-in is not configured."));
      const token = parseResponse(appleDeveloperTokenSchema, tokenBody);
      const configured = await musicKit.configure({
        developerToken: token.developer_token,
        app: { name: "Luma Center", build: "1.0.0" },
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
      const saveBody: unknown = await saveResponse.json().catch(() => null);
      if (!saveResponse.ok) throw new Error(responseError(saveBody, "Apple Music couldn’t be connected."));
      await loadStatus();
      setMessage("Your Apple Music account is connected. Playback on the Pin isn’t supported yet.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Apple Music couldn’t be reached.");
    } finally {
      setAction("idle");
    }
  }

  return (
    <section className={settings.section} data-testid="spotify-service-card">
      <div className={styles.serviceHead}>
        <span className={styles.musicMark} aria-hidden="true">♪</span>
        <span className={styles.serviceCopy}>
          <strong>Your music, on your Pin</strong>
          <span>Connect your account and choose where your Pin plays music from.</span>
        </span>
        {state ? <StatusChip tone={state.tone} label={state.label} /> : null}
      </div>

      {loading ? (
        <div className={settings.stateRow}>
          <span className={settings.muted}>Checking music services…</span>
        </div>
      ) : status ? (
        <>
          {status.state === "unavailable" ? (
            <div className={styles.noticeArea}>
              <StatusMessage tone="warning" onRetry={() => void loadStatus()}>
                {pinState?.copy ?? "Your Pin’s music service is unavailable."}
              </StatusMessage>
              {status.unavailable_reason === "pin_not_paired" ||
              status.unavailable_reason === "pairing_unconfirmed" ? (
                <Link className={styles.quietButton} href="/settings/pin/setup">
                  Pair My Ai Pin
                </Link>
              ) : status.fallback_setup ? (
                <Link className={styles.quietButton} href="/settings/pin">
                  Check Pin connection
                </Link>
              ) : null}
            </div>
          ) : (
            <div className={styles.summary}>
              <span>{state?.copy}</span>
              {status.username ? <span className={styles.account}>{status.username}</span> : null}
            </div>
          )}

          {pinOutOfStep && status.pin_active_provider && status.pin_active_provider !== activeProvider ? (
            <div className={styles.noticeArea} data-testid="music-pin-out-of-step">
              <StatusMessage tone="warning">
                Your Pin is set to play from {providerOption(status.pin_active_provider).label}.
                {" "}Press Save to switch it to {providerOption(activeProvider).label}.
              </StatusMessage>
            </div>
          ) : null}

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
                  <strong>{status.state === "unavailable" ? "Provider account" : "Play music from"}</strong>
                  <small>{providerOption(activeProvider).detail}</small>
                </span>
                <select
                  className={styles.providerSelect}
                  value={activeProvider}
                  disabled={busy}
                  onChange={(event) => setActiveProvider(event.target.value as MusicProvider)}
                >
                  {MUSIC_PROVIDER_OPTIONS.map((provider) => (
                    <option
                      key={provider.value}
                      value={provider.value}
                    >
                      {provider.label}
                      {!provider.playbackAvailable
                        ? " — Playback unavailable"
                        : providerConnected(status, provider.value)
                          ? " — Connected"
                          : ""}
                    </option>
                  ))}
                </select>
              </label>

              {spotifySelected && status.state === "unavailable" ? (
                <div className={styles.providerNote}>
                  <strong>Pair Spotify with your Ai Pin</strong>
                  <span>
                    Spotify pairs directly with the Pin. Pair your Pin first, or choose another
                    provider above to connect its account in Center now.
                  </span>
                </div>
              ) : spotifySelected ? (
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
                      <div className={styles.providerHeading}>
                        <strong>YouTube Music</strong>
                        {youtubeAccountState ? (
                          <StatusChip tone={youtubeAccountState.tone} label={youtubeAccountState.label} />
                        ) : null}
                      </div>
                      <span>{youtubeAccountState?.copy}</span>
                      <span>
                        Your account is stored securely. Keep your Pin connected to Wi-Fi or mobile data to listen.
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
                        ) : status.providers?.youtube_music.state === "pairing" ? (
                          <button type="button" className={styles.quietButton} disabled>Waiting for sign-in…</button>
                        ) : (
                          <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void providerAction("youtube_music", "POST")}>{action === "connecting_provider" ? "Starting…" : "Connect YouTube Music"}</button>
                        )}
                      </div>
                    </>
                  ) : activeProvider === "tidal" ? (
                    <>
                      <div className={styles.providerHeading}>
                        <strong>TIDAL</strong>
                        {tidalAccountState ? (
                          <StatusChip tone={tidalAccountState.tone} label={tidalAccountState.label} />
                        ) : null}
                      </div>
                      <span>{tidalAccountState?.copy}</span>
                      <span>TIDAL connects through its official sign-in.</span>
                      {!status.providers?.tidal.configured ? <span>Configure a TIDAL developer client first.</span> : null}
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
                      <div className={styles.providerHeading}>
                        <strong>Apple Music</strong>
                        {appleAccountState ? (
                          <StatusChip tone={appleAccountState.tone} label={appleAccountState.label} />
                        ) : null}
                      </div>
                      <span>{appleAccountState?.copy}</span>
                      <span>Your Apple Music account is stored securely.</span>
                      {!status.providers?.apple_music.configured ? (
                        <span>Configure an Apple Music developer token first.</span>
                      ) : status.providers.apple_music.state === "connected_playback_runtime_required" ? (
                        <span>Connected. Playback on the Pin isn&rsquo;t supported yet.</span>
                      ) : (
                        <span>Full tracks use Apple&rsquo;s protected playback.</span>
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
                  disabled={
                    busy ||
                    status.state === "unavailable" ||
                    !dirty ||
                    !providerReady ||
                    (spotifySelected && !nameValid)
                  }
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
            <SpotifySearchCheck key={activeProvider} busy={busy} provider={activeProvider} />
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
 * plays nothing and changes nothing, so it is safe to press twice, and only
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
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(body, "The search couldn’t be run."));
      setTracks(parseResponse(spotifySearchResultSchema, body).items);
    } catch (cause) {
      if (controller.signal.aborted) {
        // Only a Spotify search runs on the Pin. YouTube Music and TIDAL are
        // searched by Center, so their timeout says nothing about the Pin.
        setSearchError(
          provider === "spotify"
            ? "The search took too long. Your Pin may be offline."
            : `${providerOption(provider).label} took too long to answer.`,
        );
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
        <strong>Find a song</strong>
        <small>
          Check that your Pin can find a song on {providerOption(provider).label}.
          This won’t start playback.
        </small>
      </div>

      <div className={styles.searchControls}>
        <input
          className={styles.searchField}
          value={query}
          maxLength={MAX_SEARCH_QUERY_CHARACTERS}
          autoComplete="off"
          placeholder="A song or artist"
          aria-label="Find a song"
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
