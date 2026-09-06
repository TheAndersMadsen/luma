"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { StatusChip, type StatusTone } from "@/components/Status";
import { useAssistantStatus, type AssistantStatus } from "@/components/AiMicChat";
import settings from "../../settings.module.css";
import styles from "./services.module.css";

type ServiceState = {
  name: string;
  detail: string;
  ready: (status: AssistantStatus) => boolean;
};

type AssistantProvider = "openai-compatible" | "codex-subscription";
type CognitionProvider = "openai-realtime" | "openrouter-text";

type IntegrationsView = {
  realtime: {
    provider: CognitionProvider; configured: boolean; api_key_configured: boolean;
    model: string; upstream: string | null; max_output_tokens: number;
  };
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
};

type IntegrationDraft = {
  cognitionProvider: CognitionProvider;
  cognitionModel: string;
  cognitionUpstream: string;
  cognitionMaxTokens: string;
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
};

type SecretName =
  | "cognitionApiKey"
  | "assistantApiKey"
  | "serpapiKey"
  | "perplexityKey"
  | "wolframAppId"
  | "weatherApiKey"
  | "googleMapsKey"
  | "azureKey"
  | "openFoodFactsUsername"
  | "openFoodFactsPassword";

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
  | "open_food_facts";

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
    detail: "Model configuration for supported conversation and analysis requests",
    ready: (status) => status.assistant,
  },
  {
    name: "Web search",
    detail: "Sourced conversation results after web lookup approval in Devices",
    ready: (status) => status.tools.some((tool) => tool.name === "web_search" && tool.live),
  },
  {
    name: "Maps & places",
    detail: "Maps provider configuration; conversation support is being restored",
    ready: (status) => status.tools.some((tool) => tool.name === "nearby" && tool.live),
  },
  {
    name: "Speech",
    detail: "Azure Speech configuration; voice support depends on the client",
    ready: (status) => status.speech,
  },
];

const EMPTY_SECRETS: SecretDraft = {
  cognitionApiKey: null,
  assistantApiKey: null,
  serpapiKey: null,
  perplexityKey: null,
  wolframAppId: null,
  weatherApiKey: null,
  googleMapsKey: null,
  azureKey: null,
  openFoodFactsUsername: null,
  openFoodFactsPassword: null,
};

function chip(status: AssistantStatus | undefined, ready: boolean): {
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
    ? { tone: "live", label: "Configured" }
    : { tone: "off", label: "Needs setup" };
}

function draftFrom(view: IntegrationsView): IntegrationDraft {
  return {
    cognitionProvider: view.realtime.provider,
    cognitionModel: view.realtime.model,
    cognitionUpstream: view.realtime.upstream ?? "",
    cognitionMaxTokens: String(view.realtime.max_output_tokens),
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
  };
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error ?? "The request could not be completed.");
  return body;
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
  action,
}: {
  label: string;
  detail: string;
  configured: boolean;
  value: string | null;
  onChange: (value: string) => void;
  action?: ReactNode;
}) {
  return (
    <div className={styles.integrationField}>
      <label>
        <strong>{label}</strong>
        <small>{detail}</small>
      </label>
      <div className={styles.secretControl}>
        <input
          className={styles.integrationInput}
          aria-label={label}
          type="password"
          value={value ?? ""}
          placeholder={configured && value === null ? "Configured — leave blank to keep" : "Paste secret"}
          autoComplete="new-password"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
        {configured ? (
          <button className={styles.inlineButton} type="button" onClick={() => onChange("")}>
            Remove
          </button>
        ) : null}
        {action}
      </div>
    </div>
  );
}

export function CosmosServicesCard({ operator }: { operator: boolean }) {
  const { data: status } = useAssistantStatus();
  const cosmos = status?.provider_authority === "cosmos";
  const overall = chip(status, Boolean(cosmos && SERVICES.every((service) => service.ready(status!))));
  const [view, setView] = useState<IntegrationsView>();
  const [draft, setDraft] = useState<IntegrationDraft>();
  const [secrets, setSecrets] = useState<SecretDraft>(EMPTY_SECRETS);
  const [loading, setLoading] = useState(operator);
  const [saving, setSaving] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [testing, setTesting] = useState<IntegrationTestTarget>();
  const [testResults, setTestResults] = useState<Partial<Record<IntegrationTestTarget, "Working" | "Failed">>>({});
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string }>();
  const [deviceCode, setDeviceCode] = useState<DeviceCode>();
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async (replaceDraft: boolean) => {
    const next = await responseJson<IntegrationsView>(await fetch("/api/admin/integrations", {
      cache: "no-store",
    }));
    setView(next);
    if (replaceDraft) {
      setDraft(draftFrom(next));
      setSecrets(EMPTY_SECRETS);
      setNeedsRefresh(false);
    }
    return next;
  }, []);

  useEffect(() => {
    if (!operator) return;
    let active = true;
    void load(true)
      .catch((error: unknown) => {
        if (active) setMessage({ tone: "error", text: error instanceof Error ? error.message : "Cosmos is unreachable." });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [load, operator]);

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
    setSecrets((current) => ({ ...current, [name]: value }));
  }

  function updatePayload() {
    if (!draft) return;
    const outputLimit = Number(draft.cognitionMaxTokens);
    if (!Number.isInteger(outputLimit) || outputLimit < 64 || outputLimit > 4096) throw new Error("Conversation response limit must be an integer from 64 to 4096.");
    return {
      realtime: {
        provider: draft.cognitionProvider,
        model: draft.cognitionModel,
        upstream: draft.cognitionUpstream,
        max_output_tokens: outputLimit,
        ...(secrets.cognitionApiKey === null ? {} : { api_key: secrets.cognitionApiKey }),
      },
      assistant: {
        provider: draft.provider,
        base_url: draft.baseUrl,
        model: draft.model,
        reasoning_effort: draft.reasoningEffort,
        fast_mode: draft.fastMode,
        max_tokens: Number(draft.maxTokens),
        ...(secrets.assistantApiKey === null ? {} : { api_key: secrets.assistantApiKey }),
      },
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
    };
  }

  async function persist() {
    if (needsRefresh) throw new Error("Refresh Cosmos settings before another change.");
    const payload = updatePayload();
    if (!payload) throw new Error("Cosmos settings are still loading.");
    setNeedsRefresh(true);
    const next = await responseJson<IntegrationsView>(await fetch("/api/admin/integrations", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }));
    if (next.realtime?.provider !== payload.realtime.provider || next.realtime.model !== payload.realtime.model.trim()
      || (next.realtime.upstream ?? "") !== payload.realtime.upstream.trim()
      || next.realtime.max_output_tokens !== payload.realtime.max_output_tokens
      || (payload.realtime.api_key !== undefined && next.realtime.api_key_configured !== !!payload.realtime.api_key.trim())) {
      throw new Error("Cosmos did not confirm the requested conversation settings. Refresh settings before trying again.");
    }
    setView(next);
    setDraft(draftFrom(next));
    setSecrets(EMPTY_SECRETS);
    setNeedsRefresh(false);
    return next;
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setMessage(undefined);
    try {
      await persist();
      setMessage({ tone: "ok", text: "Cosmos settings saved. New requests use them immediately." });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Settings could not be saved." });
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
      setMessage({
        tone: "error",
        text: error instanceof Error ? `${label}: ${error.message}` : `${label} could not be tested.`,
      });
    } finally {
      setTesting(undefined);
    }
  }

  async function connectCodex() {
    if (!draft) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const configured = await responseJson<IntegrationsView>(await fetch("/api/admin/integrations", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assistant: {
            provider: "codex-subscription",
            base_url: draft.baseUrl,
            model: draft.model,
            reasoning_effort: draft.reasoningEffort,
            fast_mode: draft.fastMode,
            max_tokens: Number(draft.maxTokens),
          },
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
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Codex sign-in could not start." });
    } finally {
      setSaving(false);
    }
  }

  async function disconnectCodex() {
    setMessage(undefined);
    try {
      await responseJson(await fetch("/api/admin/integrations/codex", { method: "DELETE" }));
      setDeviceCode(undefined);
      await load(false);
      setMessage({ tone: "ok", text: "Codex was disconnected from Cosmos." });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Codex could not be disconnected." });
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
          disabled={disabled || needsRefresh || saving || testing !== undefined}
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

  return (
    <section className={settings.section} data-testid="cosmos-services-card">
      <div className={settings.sectionHeader}>
        <span className={settings.sectionTitle}>Cosmos</span>
      </div>

      <div className={styles.serviceHead}>
        <span className={styles.cosmosMark} aria-hidden="true">✦</span>
        <span className={styles.serviceCopy}>
          <strong>Server services</strong>
          <span>Assistant, search, maps and speech run on your Cosmos server.</span>
        </span>
        <StatusChip tone={overall.tone} label={overall.label} />
      </div>

      <div className={styles.settingsForm}>
        {SERVICES.map((service) => {
          const state = chip(status, Boolean(cosmos && status && service.ready(status)));
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
      </div>

      <div className={styles.providerNote}>
        <strong>Managed by Cosmos</strong>
        <span>Provider credentials stay in Cosmos. Configured services still need the requesting device’s permission and a supported conversation path.</span>
      </div>

      {!operator ? (
        <div className={styles.providerNote}>
          <strong>Operator access required</strong>
          <span>Only this Center&rsquo;s operator can change integrations.</span>
        </div>
      ) : loading || !draft || !view ? (
        <div className={styles.integrationMessage} role="status">Loading Cosmos settings…</div>
      ) : (
        <div className={styles.integrationSettings}>
          <section className={styles.integrationGroup}>
            <div className={styles.integrationIntro}>
              <span><strong>Ambiance conversation</strong><small>Choose the model that proposes replies to Cosmos for approved surfaces.</small></span>
              <StatusChip tone={view.realtime.configured ? "live" : "off"} label={view.realtime.configured ? "Configured" : "Needs setup"} />
            </div>
            <div className={styles.integrationField}>
              <label htmlFor="cognition-provider"><strong>Conversation provider</strong><small>Changing providers clears the retained conversation key.</small></label>
              <select id="cognition-provider" className={styles.providerSelect} value={draft.cognitionProvider} onChange={event => {
                const provider = event.target.value as CognitionProvider;
                setDraft({ ...draft, cognitionProvider: provider, cognitionModel: provider === "openrouter-text" ? "openai/gpt-4.1-mini" : "gpt-realtime", cognitionUpstream: provider === "openrouter-text" ? "openai" : "" });
                setSecrets(current => ({ ...current, cognitionApiKey: "" }));
              }}>
                <option value="openai-realtime">OpenAI Realtime</option>
                <option value="openrouter-text">OpenRouter · text</option>
              </select>
            </div>
            <div className={styles.integrationField}>
              <label htmlFor="cognition-model"><strong>Conversation model</strong></label>
              <input id="cognition-model" className={styles.integrationInput} maxLength={128} value={draft.cognitionModel} onChange={event => setDraft({ ...draft, cognitionModel: event.target.value })} />
            </div>
            {draft.cognitionProvider === "openrouter-text" && <div className={styles.integrationField}>
              <label htmlFor="cognition-upstream"><strong>OpenRouter provider endpoint</strong><small>One provider slug, such as openai. Cosmos will not switch to another endpoint.</small></label>
              <input id="cognition-upstream" className={styles.integrationInput} maxLength={128} value={draft.cognitionUpstream} onChange={event => setDraft({ ...draft, cognitionUpstream: event.target.value })} />
            </div>}
            <SecretField label="Conversation API key" detail="Enter the selected provider's key. Assistant and Codex credentials are never reused automatically." configured={draft.cognitionProvider === view.realtime.provider && view.realtime.api_key_configured} value={secrets.cognitionApiKey} onChange={value => secret("cognitionApiKey", value)} />
            <div className={styles.integrationField}>
              <label htmlFor="cognition-tokens"><strong>Conversation response limit</strong><small>Maximum output tokens, from 64 to 4096.</small></label>
              <input id="cognition-tokens" className={styles.integrationInput} type="number" min={64} max={4096} value={draft.cognitionMaxTokens} onChange={event => setDraft({ ...draft, cognitionMaxTokens: event.target.value })} />
            </div>
            <p className={styles.providerNote}>Both options currently accept public text. Native microphone capture and playback are still being integrated. Configured credentials do not establish a successful provider response.</p>
          </section>
          <section className={styles.integrationGroup}>
            <div className={styles.integrationIntro}>
              <span><strong>Food & nutrition</strong><small>Connect an Open Food Facts account for authenticated contributions.</small></span>
              <span className={styles.integrationIntroActions}>
                <StatusChip tone={view.food.configured ? "live" : "off"} label={view.food.configured ? "Connected" : "Optional"} />
                {testControl(
                  "open_food_facts",
                  "Open Food Facts",
                  !secretReady("openFoodFactsUsername", view.food.username_configured)
                    || !secretReady("openFoodFactsPassword", view.food.password_configured),
                )}
              </span>
            </div>
            <SecretField label="Open Food Facts username" detail="Stored only in Cosmos and sent only in a POST body." configured={view.food.username_configured} value={secrets.openFoodFactsUsername} onChange={(value) => secret("openFoodFactsUsername", value)} />
            <SecretField label="Open Food Facts password" detail="Stored only in Cosmos and never returned to Center." configured={view.food.password_configured} value={secrets.openFoodFactsPassword} onChange={(value) => secret("openFoodFactsPassword", value)} />
            <p className={styles.providerNote}>Nutrition lookups remain keyless as required by Open Food Facts; this account is verified for authenticated contribution APIs.</p>
          </section>

          <section className={styles.integrationGroup}>
            <div className={styles.integrationIntro}>
              <span><strong>Assistant</strong><small>Choose a model for answers and photo search.</small></span>
              <span className={styles.integrationIntroActions}>
                <StatusChip tone={view.assistant.configured ? "live" : "off"} label={view.assistant.configured ? "Connected" : "Needs setup"} />
                {testControl(
                  "assistant",
                  "Assistant",
                  !draft.model.trim() || (draft.provider === "codex-subscription"
                    ? !view.assistant.codex.connected
                    : !draft.baseUrl.trim() || !secretReady("assistantApiKey", view.assistant.api_key_configured)),
                )}
              </span>
            </div>
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
                <SecretField label="API key" detail="Stored only in Cosmos." configured={view.assistant.api_key_configured} value={secrets.assistantApiKey} onChange={(value) => secret("assistantApiKey", value)} />
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
                  <button className={styles.dangerButton} type="button" onClick={() => void disconnectCodex()}>Disconnect</button>
                ) : (
                  <button className={styles.primaryButton} type="button" disabled={!view.assistant.codex.available} onClick={() => void connectCodex()}>
                    {view.assistant.codex.available ? "Connect Codex" : "Codex unavailable"}
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
          </section>

          <section className={styles.integrationGroup}>
            <div className={styles.integrationIntro}>
              <span><strong>Search, maps & knowledge</strong><small>Cosmos calls these services for the Pin.</small></span>
              <StatusChip tone={view.search.configured || view.maps.configured ? "live" : "off"} label={view.search.configured || view.maps.configured ? "Configured" : "Optional"} />
            </div>
            <div className={styles.integrationField}>
              <label htmlFor="searxng-url"><strong>SearxNG URL</strong><small>Recommended self-hosted web search.</small></label>
              <div className={styles.secretControl}>
                <input id="searxng-url" className={styles.integrationInput} type="url" value={draft.searxngBaseUrl} placeholder="https://search.example.com" onChange={(event) => setDraft({ ...draft, searxngBaseUrl: event.target.value })} />
                {testControl("searxng", "SearXNG", !draft.searxngBaseUrl.trim())}
              </div>
            </div>
            <SecretField label="SerpAPI key" detail="Alternative web-search provider." configured={view.search.serpapi_key_configured} value={secrets.serpapiKey} onChange={(value) => secret("serpapiKey", value)} action={testControl("serpapi", "SerpApi", !secretReady("serpapiKey", view.search.serpapi_key_configured))} />
            <SecretField label="Perplexity API key" detail="Optional research answer provider." configured={view.search.perplexity_key_configured} value={secrets.perplexityKey} onChange={(value) => secret("perplexityKey", value)} action={testControl("perplexity", "Perplexity", !secretReady("perplexityKey", view.search.perplexity_key_configured))} />
            <div className={styles.integrationField}>
              <label htmlFor="perplexity-model"><strong>Perplexity model</strong><small>Only used when a Perplexity key is configured.</small></label>
              <input id="perplexity-model" className={styles.integrationInput} value={draft.perplexityModel} placeholder="sonar" onChange={(event) => setDraft({ ...draft, perplexityModel: event.target.value })} />
            </div>
            <SecretField label="Google Maps key" detail="Places, geocoding and directions." configured={view.maps.configured} value={secrets.googleMapsKey} onChange={(value) => secret("googleMapsKey", value)} action={testControl("maps", "Google Maps", !secretReady("googleMapsKey", view.maps.configured))} />
            <SecretField label="Weather API key" detail="Pirate Weather forecasts." configured={view.search.weather_configured} value={secrets.weatherApiKey} onChange={(value) => secret("weatherApiKey", value)} action={testControl("weather", "Pirate Weather", !secretReady("weatherApiKey", view.search.weather_configured))} />
            <SecretField label="Wolfram App ID" detail="Computational knowledge queries." configured={view.search.wolfram_configured} value={secrets.wolframAppId} onChange={(value) => secret("wolframAppId", value)} action={testControl("wolfram", "Wolfram|Alpha", !secretReady("wolframAppId", view.search.wolfram_configured))} />
          </section>

          <section className={styles.integrationGroup}>
            <div className={styles.integrationIntro}>
              <span><strong>Speech</strong><small>Cosmos transcribes requests and renders spoken answers.</small></span>
              <span className={styles.integrationIntroActions}>
                <StatusChip tone={view.speech.configured ? "live" : "off"} label={view.speech.configured ? "Configured" : "Needs setup"} />
                {testControl("speech", "Azure Speech", !draft.azureRegion.trim() || !secretReady("azureKey", view.speech.azure_key_configured))}
              </span>
            </div>
            <SecretField label="Azure Speech key" detail="Stored only in Cosmos." configured={view.speech.azure_key_configured} value={secrets.azureKey} onChange={(value) => secret("azureKey", value)} />
            <div className={styles.integrationField}>
              <label htmlFor="azure-region"><strong>Azure region</strong><small>For example, westeurope.</small></label>
              <input id="azure-region" className={styles.integrationInput} value={draft.azureRegion} placeholder="westeurope" onChange={(event) => setDraft({ ...draft, azureRegion: event.target.value })} />
            </div>
            <div className={styles.integrationField}>
              <label htmlFor="azure-voice"><strong>Azure voice</strong><small>Neural voice used for spoken responses.</small></label>
              <input id="azure-voice" className={styles.integrationInput} value={draft.azureVoice} onChange={(event) => setDraft({ ...draft, azureVoice: event.target.value })} />
            </div>
          </section>

          {message ? <div className={styles.integrationMessage} data-tone={message.tone} role="status">{message.text}</div> : null}
          <div className={styles.integrationActions}>
            <span>Changes apply to the next request.</span>
            {needsRefresh && !saving && testing === undefined && <button className={styles.inlineButton} type="button" onClick={() => { void load(true).then(() => setMessage(undefined)).catch(() => setMessage({ tone: "error", text: "Cosmos settings could not be refreshed." })); }}>Refresh Cosmos settings</button>}
            <button className={styles.primaryButton} type="button" disabled={needsRefresh || saving || testing !== undefined} onClick={() => void save()}>{saving ? "Saving…" : "Save Cosmos settings"}</button>
          </div>
        </div>
      )}
    </section>
  );
}
