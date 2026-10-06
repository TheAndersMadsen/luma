"use client";

import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useState } from "react";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { StatusChip, Switch, type StatusTone } from "@/components/Status";
import { useAssistantStatus, type AssistantStatus } from "@/components/AiMicChat";
import settings from "../../settings.module.css";
import styles from "./services.module.css";

type ServiceState = {
  name: string;
  detail: string;
  ready: (status: AssistantStatus) => boolean;
  /** Shown for its status only: the overall chip and Pin setup never wait on it. */
  optional?: boolean;
  /** The operator's OS3 card knows its last contact. The overview row says the same. */
  os3?: boolean;
};

/** What Cosmos last saw of OS3: connected only when the contact went through, else the failed step. */
type Os3Status =
  | "not_configured"
  | "untested"
  | "connected"
  | "sign_in_expired"
  | "blocked"
  | "no_instance"
  | "socket_refused"
  | "unavailable"
  | "dropped"
  | "timed_out";

type AssistantProvider = "openai-compatible" | "codex-subscription";

/** A saved assistant profile: its settings and whether it holds a key, never the key. */
type AssistantProfileView = {
  name: string;
  provider: AssistantProvider;
  base_url: string;
  api_key_configured: boolean;
  model: string;
  reasoning_effort: string | null;
  fast_mode: boolean;
  max_tokens: number;
};

type IntegrationsView = {
  assistant: {
    provider: AssistantProvider;
    configured: boolean;
    base_url: string;
    api_key_configured: boolean;
    model: string;
    reasoning_effort: string | null;
    fast_mode: boolean;
    max_tokens: number;
    codex: {
      available: boolean;
      connected: boolean;
      plan: string | null;
      email: string | null;
    };
    /** The saved profile whose settings are in use, if any. */
    profile: string | null;
    profiles: AssistantProfileView[];
  };
  search: {
    configured: boolean;
    searxng_base_url: string | null;
    serpapi_key_configured: boolean;
    perplexity_key_configured: boolean;
    perplexity_model: string | null;
    wolfram_configured: boolean;
    weather_configured: boolean;
  };
  maps: { configured: boolean };
  speech: {
    configured: boolean;
    azure_key_configured: boolean;
    azure_region: string | null;
    azure_voice: string;
  };
  food: {
    configured: boolean;
    username_configured: boolean;
    password_configured: boolean;
  };
  os3: {
    enabled: boolean;
    configured: boolean;
    session_cookie_configured: boolean;
    /** What the last test or question showed of the OS3 sign-in. */
    status: Os3Status;
    /** OS3's display name for the agent while connected. Never the account email. */
    butler_name: string | null;
    checked_at_ms: number | null;
    last_used_at_ms: number | null;
  };
};

type IntegrationDraft = {
  /** The saved profile the assistant fields belong to; null is unsaved settings or a new profile. */
  profileSource: string | null;
  /** The name the assistant fields are saved under. Empty saves them without a name. */
  profileName: string;
  /** A profile being created: a blank form that inherits no key and is saved only once named. */
  newProfile: boolean;
  provider: AssistantProvider;
  baseUrl: string;
  model: string;
  reasoningEffort: string;
  fastMode: boolean;
  maxTokens: string;
  searxngBaseUrl: string;
  perplexityModel: string;
  azureRegion: string;
  azureVoice: string;
  os3Enabled: boolean;
};

type SecretName =
  | "assistantApiKey"
  | "serpapiKey"
  | "perplexityKey"
  | "wolframAppId"
  | "weatherApiKey"
  | "googleMapsKey"
  | "azureKey"
  | "openFoodFactsUsername"
  | "openFoodFactsPassword"
  | "os3SessionCookie";

type SecretDraft = Record<SecretName, string | null>;

type IntegrationTestTarget =
  | "assistant"
  | "searxng"
  | "serpapi"
  | "perplexity"
  | "maps"
  | "weather"
  | "wolfram"
  | "speech"
  | "open_food_facts"
  | "os3";

type IntegrationTestView = { ok: boolean; message: string };

type DeviceCode = {
  login_id: string;
  verification_url: string;
  user_code: string;
  expires_in_seconds: number;
  expiresAt: number;
};

const OPENAI_COMPATIBLE_REASONING_EFFORTS = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
] as const;

const CODEX_REASONING_EFFORTS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Maximum" },
  { value: "ultra", label: "Ultra" },
] as const;

const SERVICES: readonly ServiceState[] = [
  {
    name: "Assistant",
    detail: "Understands your questions and finds the answers",
    ready: (status) => status.assistant,
  },
  {
    name: "Web search",
    optional: true,
    detail: "Current answers from the web",
    ready: (status) => status.tools.some((tool) => tool.name === "web_search" && tool.live),
  },
  {
    name: "Maps & places",
    optional: true,
    detail: "Nearby places, addresses and directions",
    ready: (status) => status.tools.some((tool) => tool.name === "nearby" && tool.live),
  },
  {
    name: "Speech",
    detail: "Hears what you say and speaks the answer",
    ready: (status) => status.speech,
  },
  {
    name: "OS3 (Rabbit)",
    detail: "Optional requests and tasks for your other devices",
    // Cosmos reports it live only once its last contact went through.
    ready: (status) => status.tools.some((tool) => tool.name === "ask_os3" && tool.live),
    optional: true,
    os3: true,
  },
];

const REQUIRED_SERVICES = SERVICES.filter((service) => !service.optional);

/** The switcher's value while a profile is being created; no saved profile can have it. */
const NEW_PROFILE = "\u0000new";
/** Cosmos keeps at most this many saved profiles. */
const MAX_PROFILES = 16;

const EMPTY_SECRETS: SecretDraft = {
  assistantApiKey: null,
  serpapiKey: null,
  perplexityKey: null,
  wolframAppId: null,
  weatherApiKey: null,
  googleMapsKey: null,
  azureKey: null,
  openFoodFactsUsername: null,
  openFoodFactsPassword: null,
  os3SessionCookie: null,
};

function chip(status: AssistantStatus | undefined, ready: boolean, optional = false): {
  tone: StatusTone;
  label: string;
} {
  if (!status) {
    return { tone: "off", label: "Checking…" };
  }
  if (status.model === "unreachable") {
    return { tone: "degraded", label: "Unavailable" };
  }
  return ready
    ? { tone: "live", label: "Ready" }
    : { tone: "off", label: optional ? "Optional" : "Needs setup" };
}

/** The OS3 card's chip and sentence for what the last contact showed. */
function os3Summary(os3: IntegrationsView["os3"]): { tone: StatusTone; label: string; text: string } {
  switch (os3.status) {
    case "connected":
      return {
        tone: "live",
        label: "Connected",
        text: os3.butler_name ? `Connected as ${os3.butler_name}.` : "Connected.",
      };
    case "sign_in_expired":
      return {
        tone: "degraded",
        label: "Sign-in expired",
        text: "Sign-in expired. Paste a fresh cookie from os3.rabbit.tech, then Test.",
      };
    case "blocked":
      return {
        tone: "degraded",
        label: "Blocked",
        text: "Rabbit's network refused the last connection before OS3 checked the sign-in. Your cookie was not rejected; test again later.",
      };
    case "no_instance":
      return {
        tone: "degraded",
        label: "No instance",
        text: "OS3 accepted the sign-in but named no instance for your account. Test again in a moment.",
      };
    case "socket_refused":
      return {
        tone: "degraded",
        label: "Refused",
        text: "OS3 accepted the sign-in, but its conversation socket refused the connection. Test again in a moment.",
      };
    case "unavailable":
      return {
        tone: "degraded",
        label: "Unreachable",
        text: "OS3 could not be reached the last time Cosmos tried. Test again in a moment.",
      };
    case "dropped":
      return {
        tone: "degraded",
        label: "Dropped",
        text: "The connection to OS3 dropped during the last question. Test again, or ask again later for the result.",
      };
    case "timed_out":
      return {
        tone: "degraded",
        label: "Timed out",
        text: "OS3 did not respond in time the last time Cosmos tried. Test again in a moment.",
      };
    case "untested":
      return { tone: "off", label: "Not tested", text: "Saved. Use Test to check the connection." };
    default:
      return os3.enabled
        ? { tone: "off", label: "Needs setup", text: "Not configured. Paste a session cookie, then Test." }
        : { tone: "off", label: "Optional", text: "Not configured. Turn on Use OS3 to connect your OS3 account." };
  }
}

function formatWhen(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(ms);
}

function draftFrom(view: IntegrationsView): IntegrationDraft {
  return {
    profileSource: view.assistant.profile,
    profileName: view.assistant.profile ?? "",
    newProfile: false,
    provider: view.assistant.provider,
    baseUrl: view.assistant.base_url,
    model: view.assistant.model,
    reasoningEffort: view.assistant.reasoning_effort ?? "",
    fastMode: view.assistant.fast_mode,
    maxTokens: String(view.assistant.max_tokens),
    searxngBaseUrl: view.search.searxng_base_url ?? "",
    perplexityModel: view.search.perplexity_model ?? "",
    azureRegion: view.speech.azure_region ?? "",
    azureVoice: view.speech.azure_voice,
    os3Enabled: view.os3.enabled,
  };
}

/** The draft with the assistant fields of the settings in use; the other sections keep their edits. */
function draftForActiveProfile(draft: IntegrationDraft, view: IntegrationsView): IntegrationDraft {
  const source = view.assistant;
  return {
    ...draft,
    profileSource: source.profile,
    profileName: source.profile ?? "",
    newProfile: false,
    provider: source.provider,
    baseUrl: source.base_url,
    model: source.model,
    reasoningEffort: source.reasoning_effort ?? "",
    fastMode: source.fast_mode,
    maxTokens: String(source.max_tokens),
  };
}

/** The draft with a blank assistant form for a profile that does not exist yet. */
function draftForNewProfile(draft: IntegrationDraft): IntegrationDraft {
  return {
    ...draft,
    profileSource: null,
    profileName: "",
    newProfile: true,
    provider: "openai-compatible",
    baseUrl: "",
    model: "openai/gpt-5.6-luna",
    reasoningEffort: "",
    fastMode: false,
    maxTokens: "512",
  };
}

/**
 * A 401 from the admin routes: the operator's session ended mid-edit. It is
 * not a generic failure, the only fix is signing in again, so the card says
 * so instead of showing the bare "Not authenticated." sentence.
 */
class SessionExpired extends Error {}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) {
    if (response.status === 401) throw new SessionExpired();
    throw new Error(body.error ?? "The request could not be completed.");
  }
  return body;
}

/** What a failed call puts in the message area, and whether sign-in fixes it. */
function failureMessage(
  error: unknown,
  expired: string,
  fallback: string,
): { text: string; signIn: boolean } {
  if (error instanceof SessionExpired) {
    return { text: expired, signIn: true };
  }
  return { text: error instanceof Error ? error.message : fallback, signIn: false };
}

function formatCountdown(seconds: number): string {
  const safe = Math.max(0, seconds);
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function SecretField({
  label,
  detail,
  configured,
  value,
  onChange,
  onRemove,
  action,
}: {
  label: string;
  detail: string;
  configured: boolean;
  value: string | null;
  /** What typing produced. An empty field is "no pending value", never a removal. */
  onChange: (value: string) => void;
  /** The one explicit way to queue removal of the stored secret. */
  onRemove: () => void;
  action?: ReactNode;
}) {
  const removing = value === "";
  const inputId = useId();
  return (
    <div className={styles.integrationField}>
      <label htmlFor={inputId}>
        <strong>{label}</strong>
        <small>{detail}</small>
      </label>
      <div className={styles.secretControl}>
        <input
          id={inputId}
          className={styles.integrationInput}
          type="password"
          value={value ?? ""}
          placeholder={
            removing
              ? "Will be removed when saved"
              : configured && value === null
                ? "Saved. Leave blank to keep it"
                : "Paste secret"
          }
          autoComplete="new-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
        {configured ? (
          removing ? (
            <button className={styles.inlineButton} type="button" onClick={() => onChange("")}>
              Keep
            </button>
          ) : (
            <button className={styles.inlineButton} type="button" onClick={onRemove}>
              Remove
            </button>
          )
        ) : null}
        {action}
      </div>
    </div>
  );
}

export function CosmosServicesCard({ operator }: { operator: boolean }) {
  const { data: status } = useAssistantStatus();
  const cosmos = status?.provider_authority === "cosmos";
  const overall = chip(status, Boolean(cosmos && REQUIRED_SERVICES.every((service) => service.ready(status!))));
  const [view, setView] = useState<IntegrationsView>();
  const [draft, setDraft] = useState<IntegrationDraft>();
  const [secrets, setSecrets] = useState<SecretDraft>(EMPTY_SECRETS);
  const [loading, setLoading] = useState(operator);
  const [saving, setSaving] = useState(false);
  const [codexBusy, setCodexBusy] = useState(false);
  const [testing, setTesting] = useState<IntegrationTestTarget>();
  const [testResults, setTestResults] = useState<Partial<Record<IntegrationTestTarget, "Working" | "Failed">>>({});
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string; signIn?: boolean }>();
  const [deviceCode, setDeviceCode] = useState<DeviceCode>();
  const [now, setNow] = useState(Date.now());
  const os3 = view && os3Summary(view.os3);

  const load = useCallback(async (replaceDraft: boolean) => {
    const next = await responseJson<IntegrationsView>(await fetch("/api/admin/integrations", {
      cache: "no-store",
    }));
    setView(next);
    if (replaceDraft) {
      setDraft(draftFrom(next));
      setSecrets(EMPTY_SECRETS);
    }
    return next;
  }, []);

  useEffect(() => {
    if (!operator) return;
    let active = true;
    void load(true)
      .catch((error: unknown) => {
        if (active) {
          setMessage({
            tone: "error",
            ...failureMessage(error, "Your session expired, so your Cosmos settings couldn’t be read.", "Cosmos is unreachable."),
          });
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [load, operator]);

  /** The read-failure state's Try again: the same first read, once more. */
  function retryFirstRead() {
    setMessage(undefined);
    setLoading(true);
    void load(true)
      .catch((error: unknown) => {
        setMessage({
          tone: "error",
          ...failureMessage(error, "Your session expired, so your Cosmos settings couldn’t be read.", "Cosmos is unreachable."),
        });
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (!deviceCode) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= deviceCode.expiresAt) setDeviceCode(undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [deviceCode]);

  useEffect(() => {
    if (!deviceCode) return;
    let active = true;
    const poll = async () => {
      try {
        const next = await load(false);
        if (active && next.assistant.codex.connected) {
          setDeviceCode(undefined);
          setMessage({ tone: "ok", text: "Codex is connected to Cosmos." });
        }
      } catch {
        // A transient status failure must not cancel the device-code ceremony.
      }
    };
    const timer = window.setInterval(() => void poll(), 2_500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [deviceCode, load]);

  const secondsLeft = useMemo(
    () => deviceCode ? Math.max(0, Math.ceil((deviceCode.expiresAt - now) / 1_000)) : 0,
    [deviceCode, now],
  );

  function secret(name: SecretName, value: string) {
    // Cosmos clears any secret it is sent as an empty string, so a field the
    // wearer typed into and cleared goes back to "keep the stored value";
    // removal is the explicit Remove button only (removeSecret).
    setSecrets((current) => ({ ...current, [name]: value === "" ? null : value }));
  }

  function removeSecret(name: SecretName) {
    setSecrets((current) => ({ ...current, [name]: "" }));
  }

  function updatePayload() {
    if (!draft) return;
    const profileName = draft.profileName.trim();
    // A new profile is an incomplete draft until it has a name: saving another
    // section must not put its blank form into use.
    const assistant = draft.newProfile && profileName === "" ? undefined : {
      // The saved profile supplies its key; the fields below are what the owner sees.
      ...(draft.profileSource === null ? {} : { load_profile: draft.profileSource }),
      provider: draft.provider,
      base_url: draft.baseUrl,
      model: draft.model,
      reasoning_effort: draft.reasoningEffort,
      fast_mode: draft.fastMode,
      max_tokens: Number(draft.maxTokens),
      // A new profile never inherits the key in use: it gets the typed one or none.
      ...(draft.newProfile
        ? { api_key: secrets.assistantApiKey ?? "" }
        : secrets.assistantApiKey === null ? {} : { api_key: secrets.assistantApiKey }),
      ...(profileName === "" ? {} : { save_profile: profileName }),
    };
    return {
      ...(assistant ? { assistant } : {}),
      search: {
        searxng_base_url: draft.searxngBaseUrl,
        perplexity_model: draft.perplexityModel,
        ...(secrets.serpapiKey === null ? {} : { serpapi_key: secrets.serpapiKey }),
        ...(secrets.perplexityKey === null ? {} : { perplexity_api_key: secrets.perplexityKey }),
        ...(secrets.wolframAppId === null ? {} : { wolfram_app_id: secrets.wolframAppId }),
        ...(secrets.weatherApiKey === null ? {} : { weather_api_key: secrets.weatherApiKey }),
      },
      maps: secrets.googleMapsKey === null ? {} : { google_maps_key: secrets.googleMapsKey },
      speech: {
        azure_region: draft.azureRegion,
        azure_voice: draft.azureVoice,
        ...(secrets.azureKey === null ? {} : { azure_key: secrets.azureKey }),
      },
      food: {
        ...(secrets.openFoodFactsUsername === null ? {} : {
          open_food_facts_username: secrets.openFoodFactsUsername,
        }),
        ...(secrets.openFoodFactsPassword === null ? {} : {
          open_food_facts_password: secrets.openFoodFactsPassword,
        }),
      },
      os3: {
        enabled: draft.os3Enabled,
        ...(secrets.os3SessionCookie === null ? {} : { session_cookie: secrets.os3SessionCookie }),
      },
    };
  }

  async function persist() {
    const payload = updatePayload();
    if (!payload) throw new Error("Cosmos settings are still loading.");
    const next = await responseJson<IntegrationsView>(await fetch("/api/admin/integrations", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }));
    setView(next);
    // A new profile still without a name was not sent: keep its form and typed key.
    const unsent = draft?.newProfile && payload.assistant === undefined ? draft : undefined;
    setDraft(unsent
      ? {
          ...draftFrom(next),
          profileSource: null,
          profileName: unsent.profileName,
          newProfile: true,
          provider: unsent.provider,
          baseUrl: unsent.baseUrl,
          model: unsent.model,
          reasoningEffort: unsent.reasoningEffort,
          fastMode: unsent.fastMode,
          maxTokens: unsent.maxTokens,
        }
      : draftFrom(next));
    setSecrets(unsent ? { ...EMPTY_SECRETS, assistantApiKey: secrets.assistantApiKey } : EMPTY_SECRETS);
    return next;
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setMessage(undefined);
    try {
      await persist();
      setMessage({ tone: "ok", text: "Settings saved. Your next request will use them." });
    } catch (error) {
      setMessage({
        tone: "error",
        ...failureMessage(error, "Your session expired, so nothing was saved.", "Settings could not be saved."),
      });
    } finally {
      setSaving(false);
    }
  }

  async function testIntegration(target: IntegrationTestTarget, label: string) {
    setTesting(target);
    setMessage(undefined);
    setTestResults((current) => {
      const next = { ...current };
      delete next[target];
      return next;
    });
    try {
      await persist();
      const result = await responseJson<IntegrationTestView>(await fetch("/api/admin/integrations/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target }),
      }));
      setTestResults((current) => ({ ...current, [target]: "Working" }));
      setMessage({ tone: "ok", text: result.message });
    } catch (error) {
      setTestResults((current) => ({ ...current, [target]: "Failed" }));
      const failure = failureMessage(
        error,
        "Your session expired, so nothing was tested.",
        `${label} could not be tested.`,
      );
      setMessage({
        tone: "error",
        text: failure.signIn ? failure.text : `${label}: ${failure.text}`,
        signIn: failure.signIn,
      });
    } finally {
      setTesting(undefined);
    }
    // Cosmos records what the OS3 test saw. Show it on the card.
    if (target === "os3") await load(false).catch(() => undefined);
  }

  /** Switch the Pin to a saved profile at once. Unsaved edits in the other sections stay in the draft. */
  async function switchProfile(name: string) {
    if (!draft || !view || saving || testing !== undefined || codexBusy) return;
    if (
      view.assistant.profile === null
      && !window.confirm("The settings in use are not saved as a profile and will be replaced. Switch anyway?")
    ) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const next = await responseJson<IntegrationsView>(await fetch("/api/admin/integrations", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assistant: { load_profile: name } }),
      }));
      setView(next);
      setDraft((current) => current && draftForActiveProfile(current, next));
      // A typed key belonged to the profile shown before; the picked one keeps its own.
      setSecrets((current) => ({ ...current, assistantApiKey: null }));
      setTestResults((current) => {
        const results = { ...current };
        delete results.assistant;
        return results;
      });
      setMessage({ tone: "ok", text: `Now using ${name}. Your next request will use it.` });
    } catch (error) {
      setMessage({
        tone: "error",
        ...failureMessage(error, "Your session expired, so the profile was not switched.", "The profile could not be switched."),
      });
    } finally {
      setSaving(false);
    }
  }

  /** Save the assistant form as its profile and put it into use. Pending changes elsewhere are saved too. */
  async function saveProfile() {
    if (!draft) return;
    const name = draft.profileName.trim();
    setSaving(true);
    setMessage(undefined);
    try {
      await persist();
      setMessage({ tone: "ok", text: `Profile ${name} saved. Your next request will use it.` });
    } catch (error) {
      setMessage({
        tone: "error",
        ...failureMessage(error, "Your session expired, so nothing was saved.", "The profile could not be saved."),
      });
    } finally {
      setSaving(false);
    }
  }

  /** Delete a saved profile. The settings in use stay as they are. */
  async function deleteProfile(name: string) {
    if (!draft || saving || testing !== undefined || codexBusy) return;
    if (!window.confirm(`Delete the profile ${name}? Its settings stay in use until you switch.`)) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const next = await responseJson<IntegrationsView>(await fetch("/api/admin/integrations", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assistant: { delete_profile: name } }),
      }));
      setView(next);
      setDraft((current) => current && current.profileSource === name
        ? { ...current, profileSource: null, profileName: "" }
        : current);
      setMessage({ tone: "ok", text: `The profile ${name} was deleted.` });
    } catch (error) {
      setMessage({
        tone: "error",
        ...failureMessage(error, "Your session expired, so the profile was kept.", "The profile could not be deleted."),
      });
    } finally {
      setSaving(false);
    }
  }

  async function connectCodex() {
    if (!draft || saving || testing !== undefined || codexBusy) return;
    setCodexBusy(true);
    setMessage(undefined);
    try {
      const assistant = updatePayload()?.assistant;
      const configured = await responseJson<IntegrationsView>(await fetch("/api/admin/integrations", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assistant: { ...assistant, provider: "codex-subscription" },
        }),
      }));
      setView(configured);
      const result = await responseJson<Omit<DeviceCode, "expiresAt">>(await fetch(
        "/api/admin/integrations/codex",
        { method: "POST" },
      ));
      const started = Date.now();
      setNow(started);
      setDeviceCode({ ...result, expiresAt: started + result.expires_in_seconds * 1_000 });
      setMessage({ tone: "ok", text: "Codex is selected. Finish the sign-in shown below." });
    } catch (error) {
      setMessage({
        tone: "error",
        ...failureMessage(error, "Your session expired, so the sign-in did not start.", "Codex sign-in could not start."),
      });
    } finally {
      setCodexBusy(false);
    }
  }

  async function disconnectCodex() {
    if (saving || testing !== undefined || codexBusy) return;
    setCodexBusy(true);
    setMessage(undefined);
    try {
      await responseJson(await fetch("/api/admin/integrations/codex", { method: "DELETE" }));
      setDeviceCode(undefined);
      await load(false);
      setMessage({ tone: "ok", text: "Codex was disconnected from Cosmos." });
    } catch (error) {
      setMessage({
        tone: "error",
        ...failureMessage(error, "Your session expired, so Codex was not disconnected.", "Codex could not be disconnected."),
      });
    } finally {
      setCodexBusy(false);
    }
  }

  function secretReady(name: SecretName, configured: boolean): boolean {
    const value = secrets[name];
    return value === null ? configured : value.trim().length > 0;
  }

  function testControl(target: IntegrationTestTarget, label: string, disabled = false) {
    const result = testResults[target];
    return (
      <span className={styles.testControl}>
        <button
          className={styles.inlineButton}
          type="button"
          aria-label={`Test ${label}`}
          disabled={disabled || saving || testing !== undefined}
          onClick={() => void testIntegration(target, label)}
        >
          {testing === target ? "Testing…" : "Test"}
        </button>
        {result ? (
          <span className={styles.testResult} data-tone={result === "Working" ? "ok" : "error"} role="status">
            {result}
          </span>
        ) : null}
      </span>
    );
  }

  const dirty = Boolean(draft && view && (JSON.stringify(draft) !== JSON.stringify(draftFrom(view)) || Object.values(secrets).some((value) => value !== null)));
  // The key the draft would keep: none for a new profile, else its profile's or the one in use.
  const assistantKeyConfigured = Boolean(
    draft && view && !draft.newProfile && (draft.profileSource === null
      ? view.assistant.api_key_configured
      : view.assistant.profiles.find((profile) => profile.name === draft.profileSource)?.api_key_configured),
  );
  // A name typed for a new or unsaved profile must not silently replace another profile.
  const profileNameTaken = Boolean(
    draft && view && draft.profileSource === null
      && view.assistant.profiles.some((profile) => profile.name === draft.profileName.trim()),
  );
  // A new profile can be saved, tested or connected only once it has a name of its own.
  const profileSavable = Boolean(draft && !profileNameTaken && !(draft.newProfile && draft.profileName.trim() === ""));

  return (
    <section className={`${settings.section} ${styles.servicesCard}`} data-testid="cosmos-services-card">
      <UnsavedChangesGuard when={dirty} />
      <div className={styles.serviceHead}>
        <span className={styles.cosmosMark} aria-hidden="true">✦</span>
        <span className={styles.serviceCopy}>
          <strong>Your Pin’s assistant</strong>
          <span>The assistant and voice are needed to answer you. Everything else is optional.</span>
        </span>
        <StatusChip tone={overall.tone} label={overall.label} />
      </div>

      {!operator ? <div className={styles.settingsForm}>
        {SERVICES.map((service) => {
          const state = service.os3 && os3
            ? os3
            : chip(status, Boolean(cosmos && status && service.ready(status)), service.optional);
          return (
            <div className={styles.settingRow} key={service.name}>
              <span>
                <strong>{service.name}</strong>
                <small>{service.detail}</small>
              </span>
              <StatusChip tone={state.tone} label={state.label} />
            </div>
          );
        })}
      </div> : null}

      <div className={styles.providerNote}>
        <strong>Your services, securely connected</strong>
        <span>Your accounts stay on your server.</span>
      </div>

      {!operator ? (
        <div className={styles.providerNote}>
          <strong>Operator access required</strong>
          <span>Your Luma administrator manages these connections. Your personal music accounts are in Music.</span>
        </div>
      ) : loading || !draft || !view || !os3 ? (
        message ? (
          /* A failed read leaves nothing to render. The message must not be
             trapped behind the loaded branch or the card spins forever. */
          <div className={styles.integrationMessage} data-tone={message.tone} role="status">
            {message.text}
            {message.signIn ? (
              <> <Link href="/login">Sign in again</Link>.</>
            ) : (
              <>
                {" "}
                <button className={styles.inlineButton} type="button" onClick={retryFirstRead}>
                  Try again
                </button>
              </>
            )}
          </div>
        ) : (
          <div className={styles.integrationMessage} role="status">Loading your service settings…</div>
        )
      ) : (
        <fieldset className={styles.integrationSettings} disabled={saving || testing !== undefined}>
          <details className={styles.integrationGroup} open={!view.assistant.configured}>
            <summary className={styles.integrationIntro}>
              <span><strong>Assistant</strong><small>Choose how your Pin answers and searches your photos.</small></span>
              <span className={styles.integrationIntroActions}>
                <StatusChip tone={view.assistant.configured ? "live" : "off"} label={view.assistant.configured ? "Connected" : "Needs setup"} />
              </span>
            </summary>
            <div className={styles.integrationField}>
              <label htmlFor="assistant-profile"><strong>Profile</strong><small>Each profile keeps its own provider, key and model. Picking one switches your Pin to it.</small></label>
              <div className={styles.secretControl}>
                <select
                  id="assistant-profile"
                  className={styles.providerSelect}
                  value={draft.newProfile ? NEW_PROFILE : draft.profileSource ?? ""}
                  onChange={(event) => {
                    const picked = event.target.value;
                    if (view.assistant.profiles.some((profile) => profile.name === picked)) {
                      void switchProfile(picked);
                    } else if (picked === "") {
                      // Back from a new profile to the unsaved settings in use.
                      setDraft(draftForActiveProfile(draft, view));
                      setSecrets((current) => ({ ...current, assistantApiKey: null }));
                    }
                  }}
                >
                  {draft.newProfile ? <option value={NEW_PROFILE}>New profile</option> : null}
                  {view.assistant.profile === null ? <option value="">Unsaved settings</option> : null}
                  {view.assistant.profiles.map((profile) => (
                    <option key={profile.name} value={profile.name}>{profile.name}</option>
                  ))}
                </select>
                {draft.newProfile ? (
                  <button
                    className={styles.inlineButton}
                    type="button"
                    onClick={() => {
                      setDraft(draftForActiveProfile(draft, view));
                      setSecrets((current) => ({ ...current, assistantApiKey: null }));
                    }}
                  >
                    Cancel
                  </button>
                ) : (
                  <>
                    <button
                      className={styles.inlineButton}
                      type="button"
                      disabled={codexBusy || view.assistant.profiles.length >= MAX_PROFILES}
                      onClick={() => {
                        setDraft(draftForNewProfile(draft));
                        setSecrets((current) => ({ ...current, assistantApiKey: null }));
                      }}
                    >
                      New profile
                    </button>
                    {draft.profileSource !== null ? (
                      <button className={styles.inlineButton} type="button" aria-label={`Delete ${draft.profileSource}`} disabled={codexBusy} onClick={() => void deleteProfile(draft.profileSource!)}>
                        Delete
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            </div>
            {draft.newProfile || draft.profileSource === null ? (
              <div className={styles.integrationField}>
                <label htmlFor="assistant-profile-name">
                  <strong>Profile name</strong>
                  <small>
                    {profileNameTaken
                      ? "A profile with this name already exists."
                      : draft.newProfile
                        ? "Name the new profile, fill in its settings, then choose Save profile."
                        : "Name these settings to keep them when you switch profiles."}
                  </small>
                </label>
                <input id="assistant-profile-name" className={styles.integrationInput} value={draft.profileName} placeholder="For example, OpenRouter" maxLength={64} autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={profileNameTaken} onChange={(event) => setDraft({ ...draft, profileName: event.target.value })} />
              </div>
            ) : null}
            <div className={styles.integrationField}>
              <label htmlFor="assistant-provider"><strong>Provider</strong><small>OpenAI-compatible API or a Codex subscription.</small></label>
              <select
                id="assistant-provider"
                className={styles.providerSelect}
                value={draft.provider}
                onChange={(event) => {
                  const provider = event.target.value as AssistantProvider;
                  const model = provider === "codex-subscription" && draft.model === "openai/gpt-5.6-luna"
                    ? "gpt-5.6-sol"
                    : provider === "openai-compatible" && draft.model === "gpt-5.6-sol"
                      ? "openai/gpt-5.6-luna"
                      : draft.model;
                  const reasoningEffort = provider === "codex-subscription" && draft.reasoningEffort === "minimal"
                    ? "low"
                    : provider === "openai-compatible" && ["max", "ultra"].includes(draft.reasoningEffort)
                      ? ""
                      : draft.reasoningEffort;
                  setDraft({ ...draft, provider, model, reasoningEffort });
                }}
              >
                <option value="openai-compatible">OpenAI-compatible API</option>
                <option value="codex-subscription">Codex subscription</option>
              </select>
            </div>

            {draft.provider === "openai-compatible" ? (
              <>
                <div className={styles.integrationField}>
                  <label htmlFor="assistant-base-url"><strong>API base URL</strong><small>For example, https://openrouter.ai/api/v1</small></label>
                  <input id="assistant-base-url" className={styles.integrationInput} type="url" value={draft.baseUrl} placeholder="https://openrouter.ai/api/v1" onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
                </div>
                <SecretField label="API key" detail="Kept on your server. Never sent to the Pin." configured={assistantKeyConfigured} value={secrets.assistantApiKey} onChange={(value) => secret("assistantApiKey", value)} onRemove={() => removeSecret("assistantApiKey")} />
              </>
            ) : (
              <div className={styles.codexConnect}>
                <span>
                  <strong>{view.assistant.codex.connected ? "Codex connected" : "Connect Codex to Cosmos"}</strong>
                  <small>
                    {view.assistant.codex.connected
                      ? [view.assistant.codex.email, view.assistant.codex.plan].filter(Boolean).join(" · ") || "ChatGPT subscription connected"
                      : "Sign in here to connect your subscription."}
                  </small>
                </span>
                {view.assistant.codex.connected ? (
                  <button className={styles.dangerButton} type="button" disabled={saving || testing !== undefined || codexBusy} onClick={() => void disconnectCodex()}>
                    {codexBusy ? "Disconnecting…" : "Disconnect"}
                  </button>
                ) : (
                  <button className={styles.primaryButton} type="button" disabled={!view.assistant.codex.available || saving || testing !== undefined || codexBusy || !profileSavable} onClick={() => void connectCodex()}>
                    {codexBusy
                      ? "Starting…"
                      : view.assistant.codex.available
                        ? "Connect Codex"
                        : "Codex unavailable"}
                  </button>
                )}
              </div>
            )}

            {deviceCode ? (
              <div className={styles.deviceCode}>
                <span className={styles.pairingTimer} aria-label={`${secondsLeft} seconds remaining`}>{formatCountdown(secondsLeft)}</span>
                <span>
                  Open <a href={deviceCode.verification_url} target="_blank" rel="noreferrer">{deviceCode.verification_url}</a> and enter
                  <strong className={styles.userCode}> {deviceCode.user_code}</strong>.
                </span>
              </div>
            ) : null}

            <div className={styles.integrationField}>
              <label htmlFor="assistant-model"><strong>Model</strong><small>Use the provider&rsquo;s exact model identifier.</small></label>
              <input id="assistant-model" className={styles.integrationInput} value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
            </div>
            <div className={styles.integrationField}>
              <label htmlFor="reasoning-effort"><strong>Reasoning effort</strong><small>Optional. Supported values depend on the model.</small></label>
              <select id="reasoning-effort" className={styles.providerSelect} value={draft.reasoningEffort} onChange={(event) => setDraft({ ...draft, reasoningEffort: event.target.value })}>
                <option value="">Provider default</option>
                {(draft.provider === "codex-subscription"
                  ? CODEX_REASONING_EFFORTS
                  : OPENAI_COMPATIBLE_REASONING_EFFORTS
                ).map((effort) => (
                  <option key={effort.value} value={effort.value}>{effort.label}</option>
                ))}
              </select>
            </div>
            {draft.provider === "codex-subscription" ? (
              <div className={styles.integrationField}>
                <label htmlFor="assistant-speed"><strong>Speed</strong><small>Fast runs supported models about 1.5× faster and uses more ChatGPT credits.</small></label>
                <select id="assistant-speed" className={styles.providerSelect} value={draft.fastMode ? "fast" : "standard"} onChange={(event) => setDraft({ ...draft, fastMode: event.target.value === "fast" })}>
                  <option value="standard">Standard</option>
                  <option value="fast">Fast</option>
                </select>
              </div>
            ) : null}
            <div className={styles.integrationField}>
              <label htmlFor="max-tokens"><strong>Maximum response tokens</strong><small>Limit for each model response.</small></label>
              <input id="max-tokens" className={styles.integrationInput} type="number" min="64" max="8192" value={draft.maxTokens} onChange={(event) => setDraft({ ...draft, maxTokens: event.target.value })} />
            </div>
            <div className={styles.integrationTestActions}>
              {testControl(
                "assistant",
                "Assistant",
                !profileSavable || !draft.model.trim() || (draft.provider === "codex-subscription"
                  ? !view.assistant.codex.connected
                  : !draft.baseUrl.trim() || !secretReady("assistantApiKey", assistantKeyConfigured)),
              )}
              <button
                className={styles.primaryButton}
                type="button"
                disabled={saving || testing !== undefined || codexBusy || !profileSavable || draft.profileName.trim() === "" || !draft.model.trim()}
                onClick={() => void saveProfile()}
              >
                {saving ? "Saving…" : "Save profile"}
              </button>
            </div>
          </details>

          <details className={styles.integrationGroup} open={!view.speech.configured}>
            <summary className={styles.integrationIntro}>
              <span><strong>Voice</strong><small>Help your Pin hear you and speak its answers.</small></span>
              <span className={styles.integrationIntroActions}>
                <StatusChip tone={view.speech.configured ? "live" : "off"} label={view.speech.configured ? "Configured" : "Needs setup"} />
              </span>
            </summary>
            <SecretField label="Azure Speech key" detail="From your Speech resource in the Azure portal. Kept on your server." configured={view.speech.azure_key_configured} value={secrets.azureKey} onChange={(value) => secret("azureKey", value)} onRemove={() => removeSecret("azureKey")} />
            <div className={styles.integrationField}>
              <label htmlFor="azure-region"><strong>Azure region</strong><small>The region shown next to your key in the Azure portal, for example westeurope.</small></label>
              <input id="azure-region" className={styles.integrationInput} value={draft.azureRegion} placeholder="westeurope" onChange={(event) => setDraft({ ...draft, azureRegion: event.target.value })} />
            </div>
            <div className={styles.integrationField}>
              <label htmlFor="azure-voice"><strong>Azure voice</strong><small>Neural voice used for spoken responses.</small></label>
              <input id="azure-voice" className={styles.integrationInput} value={draft.azureVoice} onChange={(event) => setDraft({ ...draft, azureVoice: event.target.value })} />
            </div>
            <div className={styles.integrationTestActions}>{testControl("speech", "Azure Speech", !draft.azureRegion.trim() || !secretReady("azureKey", view.speech.azure_key_configured))}</div>
          </details>

          <details className={styles.integrationGroup}>
            <summary className={styles.integrationIntro}>
              <span><strong>Search &amp; maps</strong><small>Find answers, places and weather.</small></span>
              <StatusChip tone={view.search.configured || view.maps.configured ? "live" : "off"} label={view.search.configured || view.maps.configured ? "Configured" : "Optional"} />
            </summary>
            <div className={styles.integrationField}>
              <label htmlFor="searxng-url"><strong>SearXNG URL</strong><small>Recommended self-hosted web search.</small></label>
              <div className={styles.secretControl}>
                <input id="searxng-url" className={styles.integrationInput} type="url" value={draft.searxngBaseUrl} placeholder="https://search.example.com" onChange={(event) => setDraft({ ...draft, searxngBaseUrl: event.target.value })} />
                {testControl("searxng", "SearXNG", !draft.searxngBaseUrl.trim())}
              </div>
            </div>
            <SecretField label="SerpAPI key" detail="Alternative web-search provider." configured={view.search.serpapi_key_configured} value={secrets.serpapiKey} onChange={(value) => secret("serpapiKey", value)} onRemove={() => removeSecret("serpapiKey")} action={testControl("serpapi", "SerpApi", !secretReady("serpapiKey", view.search.serpapi_key_configured))} />
            <SecretField label="Perplexity API key" detail="Optional research answer provider." configured={view.search.perplexity_key_configured} value={secrets.perplexityKey} onChange={(value) => secret("perplexityKey", value)} onRemove={() => removeSecret("perplexityKey")} action={testControl("perplexity", "Perplexity", !secretReady("perplexityKey", view.search.perplexity_key_configured))} />
            <div className={styles.integrationField}>
              <label htmlFor="perplexity-model"><strong>Perplexity model</strong><small>Only used when a Perplexity key is configured.</small></label>
              <input id="perplexity-model" className={styles.integrationInput} value={draft.perplexityModel} placeholder="sonar" onChange={(event) => setDraft({ ...draft, perplexityModel: event.target.value })} />
            </div>
            <SecretField label="Google Maps key" detail="Places, geocoding and directions." configured={view.maps.configured} value={secrets.googleMapsKey} onChange={(value) => secret("googleMapsKey", value)} onRemove={() => removeSecret("googleMapsKey")} action={testControl("maps", "Google Maps", !secretReady("googleMapsKey", view.maps.configured))} />
            <SecretField label="Weather API key" detail="Pirate Weather forecasts." configured={view.search.weather_configured} value={secrets.weatherApiKey} onChange={(value) => secret("weatherApiKey", value)} onRemove={() => removeSecret("weatherApiKey")} action={testControl("weather", "Pirate Weather", !secretReady("weatherApiKey", view.search.weather_configured))} />
            <SecretField label="Wolfram App ID" detail="Computational knowledge queries." configured={view.search.wolfram_configured} value={secrets.wolframAppId} onChange={(value) => secret("wolframAppId", value)} onRemove={() => removeSecret("wolframAppId")} action={testControl("wolfram", "Wolfram|Alpha", !secretReady("wolframAppId", view.search.wolfram_configured))} />
          </details>

          <details className={styles.integrationGroup}>
            <summary className={styles.integrationIntro}>
              <span><strong>Food & nutrition</strong><small>Add an account to contribute food information.</small></span>
              <span className={styles.integrationIntroActions}>
                <StatusChip tone={view.food.configured ? "live" : "off"} label={view.food.configured ? "Connected" : "Optional"} />
              </span>
            </summary>
            <SecretField label="Open Food Facts username" detail="Kept on your server." configured={view.food.username_configured} value={secrets.openFoodFactsUsername} onChange={(value) => secret("openFoodFactsUsername", value)} onRemove={() => removeSecret("openFoodFactsUsername")} />
            <SecretField label="Open Food Facts password" detail="Kept on your server. Center never shows it again." configured={view.food.password_configured} value={secrets.openFoodFactsPassword} onChange={(value) => secret("openFoodFactsPassword", value)} onRemove={() => removeSecret("openFoodFactsPassword")} />
            <p className={styles.providerNote}>Food lookups work without an account. Add one only if your Pin should add food information to Open Food Facts.</p>
            <div className={styles.integrationTestActions}>{testControl(
                  "open_food_facts",
                  "Open Food Facts",
                  !secretReady("openFoodFactsUsername", view.food.username_configured)
                    || !secretReady("openFoodFactsPassword", view.food.password_configured),
                )}</div>
          </details>

          <details className={styles.integrationGroup} aria-label="OS3 (Rabbit)">
            <summary className={styles.integrationIntro}>
              <span><strong>OS3 (Rabbit)</strong><small>Ask your Pin to use your other computers.</small></span>
              <span className={styles.integrationIntroActions}>
                <StatusChip tone={os3.tone} label={os3.label} />
              </span>
            </summary>
            <p className={styles.providerNote}>Ask about your computer, or say &ldquo;Ask OS3&hellip;&rdquo; for a task. Say &ldquo;Cancel OS3&rdquo; to request a stop. Complete permissions and forms in OS3.</p>
            <p className={styles.os3Status} data-testid="os3-status" data-status={view.os3.status} data-tone={os3.tone}>
              <strong>{os3.text}</strong>
              <span>
                {view.os3.last_used_at_ms === null
                  ? "The assistant has not asked OS3 yet."
                  : `Last used ${formatWhen(view.os3.last_used_at_ms)}.`}
              </span>
            </p>
            <div className={styles.settingRow}>
              <span>
                <strong>Use OS3</strong>
                <small>Lets your Pin use your Rabbit account. Everyone using this Luma server can reach it. Available when your Pin is unlocked.</small>
              </span>
              <Switch checked={draft.os3Enabled} ariaLabel="Use OS3" onChange={(os3Enabled) => setDraft({ ...draft, os3Enabled })} />
            </div>
            <SecretField label="OS3 session cookie" detail="This is your full Rabbit sign-in; treat it like a password. Kept private on your server. Replace it if your sign-in expires." configured={view.os3.session_cookie_configured} value={secrets.os3SessionCookie} onChange={(value) => secret("os3SessionCookie", value)} onRemove={() => removeSecret("os3SessionCookie")} />
            {/* The OS3 probe stops after init_ack (WebSocket client reference §1).
                Rabbit's rabbit-agent and dlam-byok support guides own node/model setup. */}
            <p className={styles.providerNote}>
              <span>Choose a <a href="https://www.rabbit.tech/support/article/dlam-byok" target="_blank" rel="noreferrer">model in OS3</a>. For computer tasks, <a href="https://www.rabbit.tech/support/article/rabbit-agent" target="_blank" rel="noreferrer">connect your computer in OS3</a> and keep it awake and online.</span>
              <span><strong>Test</strong> checks the OS3 connection. Ask &ldquo;Ask OS3 for my Mac&rsquo;s battery level&rdquo; to check your computer.</span>
            </p>
            <div className={styles.os3Steps}>
              <strong>Copy the cookie</strong>
              <ol>
                <li>On a computer, open os3.rabbit.tech in Chrome, Edge or Firefox and sign in.</li>
                <li>Open developer tools (F12, or Option-Command-I on a Mac) and choose <em>Network</em>.</li>
                <li>Reload the page and select any request to os3.rabbit.tech.</li>
                <li>Under <em>Request Headers</em>, copy the whole value of <em>Cookie</em>.</li>
                <li>Paste it above, turn on <em>Use OS3</em>, and choose <em>Test</em>.</li>
              </ol>
            </div>
            <div className={styles.integrationTestActions}>{testControl("os3", "OS3", !draft.os3Enabled || !secretReady("os3SessionCookie", view.os3.session_cookie_configured))}</div>
          </details>

          {message ? (
            <div className={styles.integrationMessage} data-tone={message.tone} role="status">
              {message.text}
              {message.signIn ? <> <Link href="/login">Sign in again</Link>.</> : null}
            </div>
          ) : null}
          <div className={styles.integrationActions} data-dirty={dirty}>
            <span>{dirty ? "You have unsaved changes. Saving a profile or testing a service also saves them." : "Changes apply to your next request."}</span>
            <button className={styles.primaryButton} type="button" disabled={saving || testing !== undefined} onClick={() => void save()}>{saving ? "Saving…" : "Save changes"}</button>
          </div>
        </fieldset>
      )}
    </section>
  );
}
