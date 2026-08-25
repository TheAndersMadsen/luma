"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

type IntegrationsView = {
  assistant: {
    provider: AssistantProvider;
    configured: boolean;
    base_url: string;
    api_key_configured: boolean;
    model: string;
    reasoning_effort: string | null;
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
};

type IntegrationDraft = {
  provider: AssistantProvider;
  baseUrl: string;
  model: string;
  reasoningEffort: string;
  maxTokens: string;
  searxngBaseUrl: string;
  perplexityModel: string;
  azureRegion: string;
  azureVoice: string;
};

type SecretName =
  | "assistantApiKey"
  | "serpapiKey"
  | "perplexityKey"
  | "wolframAppId"
  | "weatherApiKey"
  | "googleMapsKey"
  | "azureKey";

type SecretDraft = Record<SecretName, string | null>;

type DeviceCode = {
  login_id: string;
  verification_url: string;
  user_code: string;
  expires_in_seconds: number;
  expiresAt: number;
};

const SERVICES: readonly ServiceState[] = [
  {
    name: "Assistant",
    detail: "Language-model requests and tool orchestration",
    ready: (status) => status.assistant,
  },
  {
    name: "Web search",
    detail: "Current results through the server search profile",
    ready: (status) => status.tools.some((tool) => tool.name === "web_search" && tool.live),
  },
  {
    name: "Maps & places",
    detail: "Nearby search, reverse geocoding and directions",
    ready: (status) => status.tools.some((tool) => tool.name === "nearby" && tool.live),
  },
  {
    name: "Speech",
    detail: "Cloud transcription and spoken responses",
    ready: (status) => status.speech,
  },
];

const EMPTY_SECRETS: SecretDraft = {
  assistantApiKey: null,
  serpapiKey: null,
  perplexityKey: null,
  wolframAppId: null,
  weatherApiKey: null,
  googleMapsKey: null,
  azureKey: null,
};

function chip(status: AssistantStatus | undefined, ready: boolean): {
  tone: StatusTone;
  label: string;
} {
  if (!status || status.model === "unreachable") {
    return { tone: "degraded", label: "Unavailable" };
  }
  return ready
    ? { tone: "live", label: "Ready" }
    : { tone: "off", label: "Needs setup" };
}

function draftFrom(view: IntegrationsView): IntegrationDraft {
  return {
    provider: view.assistant.provider,
    baseUrl: view.assistant.base_url,
    model: view.assistant.model,
    reasoningEffort: view.assistant.reasoning_effort ?? "",
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
}: {
  label: string;
  detail: string;
  configured: boolean;
  value: string | null;
  onChange: (value: string) => void;
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

  async function save() {
    if (!draft) return;
    setSaving(true);
    setMessage(undefined);
    const payload = {
      assistant: {
        provider: draft.provider,
        base_url: draft.baseUrl,
        model: draft.model,
        reasoning_effort: draft.reasoningEffort,
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
    };
    try {
      const next = await responseJson<IntegrationsView>(await fetch("/api/admin/integrations", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }));
      setView(next);
      setDraft(draftFrom(next));
      setSecrets(EMPTY_SECRETS);
      setMessage({ tone: "ok", text: "Cosmos settings saved. New requests use them immediately." });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Settings could not be saved." });
    } finally {
      setSaving(false);
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
        <strong>One provider authority</strong>
        <span>
          Center saves these settings directly to Cosmos. Your Ai Pin receives only the Cosmos endpoint, trust root and its own device identity during activation; no search, maps, assistant or speech key is copied to the device.
        </span>
      </div>

      {!operator ? (
        <div className={styles.providerNote}>
          <strong>Operator access required</strong>
          <span>Sign in as this Center&rsquo;s operator to change server integrations.</span>
        </div>
      ) : loading || !draft || !view ? (
        <div className={styles.integrationMessage} role="status">Loading Cosmos settings…</div>
      ) : (
        <div className={styles.integrationSettings}>
          <section className={styles.integrationGroup}>
            <div className={styles.integrationIntro}>
              <span><strong>Assistant</strong><small>Choose one server-side model provider.</small></span>
              <StatusChip tone={view.assistant.configured ? "live" : "off"} label={view.assistant.configured ? "Connected" : "Needs setup"} />
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
                    ? "gpt-5.6-terra"
                    : provider === "openai-compatible" && draft.model === "gpt-5.6-terra"
                      ? "openai/gpt-5.6-luna"
                      : draft.model;
                  setDraft({ ...draft, provider, model });
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
                      : "Sign in once here. The official Codex app server keeps and refreshes the session on Cosmos."}
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
                <option value="minimal">Minimal</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Extra high</option>
              </select>
            </div>
            <div className={styles.integrationField}>
              <label htmlFor="max-tokens"><strong>Maximum response tokens</strong><small>Bounds each assistant model step.</small></label>
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
              <input id="searxng-url" className={styles.integrationInput} type="url" value={draft.searxngBaseUrl} placeholder="https://search.example.com" onChange={(event) => setDraft({ ...draft, searxngBaseUrl: event.target.value })} />
            </div>
            <SecretField label="SerpAPI key" detail="Alternative web-search provider." configured={view.search.serpapi_key_configured} value={secrets.serpapiKey} onChange={(value) => secret("serpapiKey", value)} />
            <SecretField label="Perplexity API key" detail="Optional research answer provider." configured={view.search.perplexity_key_configured} value={secrets.perplexityKey} onChange={(value) => secret("perplexityKey", value)} />
            <div className={styles.integrationField}>
              <label htmlFor="perplexity-model"><strong>Perplexity model</strong><small>Only used when a Perplexity key is configured.</small></label>
              <input id="perplexity-model" className={styles.integrationInput} value={draft.perplexityModel} placeholder="sonar" onChange={(event) => setDraft({ ...draft, perplexityModel: event.target.value })} />
            </div>
            <SecretField label="Google Maps key" detail="Places, geocoding and directions." configured={view.maps.configured} value={secrets.googleMapsKey} onChange={(value) => secret("googleMapsKey", value)} />
            <SecretField label="Weather API key" detail="Pirate Weather forecasts." configured={view.search.weather_configured} value={secrets.weatherApiKey} onChange={(value) => secret("weatherApiKey", value)} />
            <SecretField label="Wolfram App ID" detail="Computational knowledge queries." configured={view.search.wolfram_configured} value={secrets.wolframAppId} onChange={(value) => secret("wolframAppId", value)} />
          </section>

          <section className={styles.integrationGroup}>
            <div className={styles.integrationIntro}>
              <span><strong>Speech</strong><small>Cosmos transcribes requests and renders spoken answers.</small></span>
              <StatusChip tone={view.speech.configured ? "live" : "off"} label={view.speech.configured ? "Configured" : "Needs setup"} />
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
            <span>Changes apply to new Cosmos requests. Re-provisioning the Pin is not required.</span>
            <button className={styles.primaryButton} type="button" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save Cosmos settings"}</button>
          </div>
        </div>
      )}
    </section>
  );
}
