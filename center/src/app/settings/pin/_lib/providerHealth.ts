/*
 * Ported from the retired Setup SPA's `providerHealth.ts` — only the type
 * import moved (`../api` -> `@/lib/pin-device`). Everything else, including the
 * exact failure sentences the Pin persists, is byte-identical: the match is
 * against server prose, so an edit here silently turns a red into a
 * "cannot tell".
 */

import type { ActivityPrompt, CodexStatusResponse } from "@/lib/pin-device";
import type { NormalizedSettings } from "./settingsResponse";

/**
 * Provider health for the Settings page, built only from surfaces the server
 * already serves.
 *
 * No endpoint proves that the configured model answers. `GET /api/health`
 * returns a hardcoded `"ok"` (runtime/core/src/api.rs `health`) without touching
 * the LLM, and `GET /api/codex/status` only reads the Codex app-server's
 * *account record* (runtime/core/src/llm/codex_app_server.rs `account_ready`) —
 * it never issues a model call. The failure this panel exists for (bridge
 * listening, identity verified, upstream call failing seconds later) is
 * structurally invisible to both.
 *
 * So there is deliberately no "healthy" verdict in this module's types. It can
 * prove FAILURE from evidence the server already persists, and it can prove a
 * configuration gap; everything else is reported as unproven together with the
 * one check that would settle it. A green indicator that cannot go red is the
 * defect this repo keeps rediscovering, so the guarantee is structural rather
 * than a convention someone has to remember.
 */

export type ProviderHealthVerdict = "failing" | "incomplete" | "unproven";

export type HealthTone = "danger" | "warning" | "info";

export type LastTurnEvidence =
  | "backend_failure"
  | "service_refusal"
  | "no_llm_evidence"
  | "none_recorded";

type FailureCategory =
  | "credentials"
  | "model"
  | "reachability"
  | "rate_limit"
  | "unsupported"
  | "unknown";

interface BackendFailureSentence {
  readonly text: string;
  readonly category: FailureCategory;
}

/**
 * Every sentence `llm::error::friendly_error_message` can produce
 * (runtime/core/src/llm/error.rs), plus the one developer-facing translation from
 * `speakable_backend_error` (runtime/core/src/synapse/chat_turn_loop.rs).
 *
 * These are the exact strings the server persists as the assistant message when
 * a turn fails — `spawn_save_conversation` on the `agent.chat` error arm, and
 * `agentic_respond_or_empty` for a hermes decline (both in
 * runtime/core/src/services/aibus/understand.rs). Matching them is how Setup
 * recognises a backend failure without a new endpoint.
 *
 * The coupling is to prose, so if the server ever reworded one the match
 * degrades to "cannot tell" — never to a false green, and never to a false red.
 */
const BACKEND_FAILURE_SENTENCES: readonly BackendFailureSentence[] = [
  {
    text: "I'm getting too many requests right now. Please try again in a moment.",
    category: "rate_limit",
  },
  {
    text: "There's a problem with the API key configuration. Please check the server settings.",
    category: "credentials",
  },
  {
    text: "The configured AI model wasn't found. Please check the server settings.",
    category: "model",
  },
  {
    text: "The AI service is temporarily unavailable. Please try again shortly.",
    category: "reachability",
  },
  {
    text: "The request to the AI service timed out. Please try again.",
    category: "reachability",
  },
  {
    text: "I couldn't reach the AI service. Please check the server's internet connection.",
    category: "reachability",
  },
  {
    text: "Something went wrong while contacting the AI service. Please try again.",
    category: "unknown",
  },
  {
    text: "This device's AI model isn't set up for that. Please check the server settings.",
    category: "unsupported",
  },
];

/**
 * Failures where the provider was reached and answered with a refusal
 * (content filter, context overflow). Counting these as a backend failure
 * would be a false red: the transport and the credentials both worked.
 */
const SERVICE_REACHED_REFUSAL_SENTENCES: readonly string[] = [
  "The AI service declined to answer that. Try rephrasing your question.",
  "That conversation got too long for the AI service to handle. Try starting a new one.",
];

/** Provider ids and labels, shared by the Settings select and this panel. */
export const LLM_PROVIDERS = [
  { value: "echo", label: "Echo (no API)" },
  { value: "gemini", label: "Google Gemini" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "openai-compatible", label: "OpenAI-compatible" },
  { value: "codex", label: "Codex subscription (on-device)" },
] as const;

export function providerDisplayLabel(provider: string): string {
  return (
    LLM_PROVIDERS.find((candidate) => candidate.value === provider)?.label ??
    provider
  );
}

export interface ConfiguredProviderDescription {
  provider: string;
  providerLabel: string;
  /** The model id the server actually sends, or null when there is none. */
  effectiveModel: string | null;
  /** Where a turn physically goes before it can reach a model. */
  routedThrough: string;
  credentialRequirement: string;
  /** null when settings alone cannot see whether the credential exists. */
  credentialPresent: boolean | null;
  /** Required fields this provider needs that the server reports as unset. */
  missing: string[];
}

/**
 * What the stored settings say the Pin will do with the next question.
 *
 * `codex_custom_active` is parsed by settingsResponse.ts and, until now, never
 * rendered. It matters here because it changes which model id is really sent:
 * `ResolvedConfig::effective_model` (runtime/core/src/config.rs) uses the codex
 * block's model when a custom provider is active, so showing the top-level
 * `model` would name a model the Pin never asks for.
 */
export function describeConfiguredProvider(
  settings: NormalizedSettings,
): ConfiguredProviderDescription {
  const llm = settings.llm;
  const provider = llm.provider;
  const providerLabel = providerDisplayLabel(provider);
  const model = llm.model.trim();

  if (provider === "echo") {
    return {
      provider,
      providerLabel,
      effectiveModel: null,
      routedThrough: "On-device echo",
      credentialRequirement: "None.",
      credentialPresent: null,
      missing: [],
    };
  }

  if (provider === "codex") {
    const bridgeUrl = llm.codex_bridge_url?.trim() ?? "";
    const bridgeLabel = bridgeUrl || "bridge URL not set";
    // Every codex turn is proxied through the on-device bridge, and the bridge
    // token is the one credential the provider build hard-requires
    // (runtime/core/src/llm/providers/codex.rs).
    const missing = llm.has_codex_bridge_token === true ? [] : ["Codex bridge token"];

    if (llm.codex_custom_active === true) {
      const customModel = llm.codex_model?.trim() ?? "";
      const customBase = llm.codex_provider_base_url?.trim() ?? "";
      return {
        provider,
        providerLabel,
        effectiveModel: customModel || null,
        routedThrough: customBase ? `Codex (${bridgeLabel}) → ${customBase}` : `Codex (${bridgeLabel}) → custom service`,
        credentialRequirement: "Custom service API key.",
        credentialPresent: llm.has_codex_api_key === true,
        missing,
      };
    }

    return {
      provider,
      providerLabel,
      effectiveModel: model || null,
      routedThrough: `Codex (${bridgeLabel}) → ChatGPT`,
      credentialRequirement: "ChatGPT sign-in or custom service credentials.",
      // The ChatGPT sign-in lives in the Codex account record, not in settings,
      // so settings alone must not claim it is present or absent.
      credentialPresent: null,
      missing,
    };
  }

  // gemini / anthropic / openai / openai-compatible all fail to build without a
  // resolved API key (runtime/core/src/llm/providers/*.rs), so a missing key here
  // is a real configuration gap rather than a guess.
  const baseUrl = llm.base_url?.trim() ?? "";
  const missing: string[] = [];
  if (!llm.has_api_key) missing.push("API key");
  if (!model) missing.push("Model ID");
  if (provider === "openai-compatible" && !baseUrl) missing.push("Base URL");

  return {
    provider,
    providerLabel,
    effectiveModel: model || null,
    routedThrough: baseUrl || providerLabel,
    credentialRequirement: `${providerLabel} API key.`,
    credentialPresent: llm.has_api_key,
    missing,
  };
}

export interface CodexBridgeDescription {
  label: string;
  tone: HealthTone;
  detail: string;
  /** True when the state itself proves no turn can reach a model this way. */
  failing: boolean;
  nextStep: string | null;
}

/**
 * Read `GET /api/codex/status` for what it actually reports.
 *
 * The handler (runtime/core/src/api/codex.rs `get_status`) re-imposes a ChatGPT
 * requirement on the bridge's own answer: `ready = status.ready && login_mode
 * == Some("chatgpt")`. A keyed custom provider therefore always lands on
 * `signed_out` even though it is fully configured, which is why the old copy
 * told such an owner to sign in to ChatGPT — an irrelevant fix. Worse, that
 * same `signed_out` is also what a genuinely not-ready bridge produces, so the
 * two are indistinguishable from here and the copy has to say so.
 */
export function describeCodexBridge(
  status: CodexStatusResponse | null,
  options: { customProviderActive: boolean },
): CodexBridgeDescription {
  if (!status) {
    return {
      label: "Not checked",
      tone: "info",
      detail: "Check the connection to read its status.",
      failing: false,
      nextStep: null,
    };
  }

  if (status.login_pending) {
    return {
      label: "ChatGPT sign-in waiting for completion",
      tone: "info",
      detail: "Finish sign-in in the browser tab.",
      failing: false,
      nextStep: null,
    };
  }

  switch (status.state) {
    case "ready":
      return {
        label: "Connected to ChatGPT",
        tone: "info",
        detail: "ChatGPT is connected on this Pin.",
        failing: false,
        nextStep: null,
      };
    case "signed_out":
      return options.customProviderActive
        ? {
            label: "Custom service configured",
            tone: "info",
            detail: "The custom service is selected.",
            failing: false,
            nextStep: null,
          }
        : {
            label: "ChatGPT sign-in required",
            tone: "warning",
            detail: "No ChatGPT account is connected.",
            failing: false,
            nextStep: "Start ChatGPT sign-in below.",
          };
    case "unauthorized":
      return {
        label: "Connection token rejected",
        tone: "danger",
        detail: "The saved token does not match the Codex connection.",
        failing: true,
        nextStep:
          "Enter the correct connection token and save.",
      };
    case "unreachable":
      return {
        label: "Codex connection unavailable",
        tone: "danger",
        detail: "The Pin cannot reach the saved address.",
        failing: true,
        nextStep:
          "Check the address and confirm Codex is running.",
      };
    case "unavailable":
      return {
        label: "Codex unavailable",
        tone: "danger",
        detail: "The connection answered, but Codex is not running.",
        failing: true,
        nextStep:
          "Start Codex, then check again.",
      };
    case "not_configured":
      return {
        label: "Codex connection not configured",
        tone: "warning",
        detail: "An address and token are required.",
        failing: true,
        nextStep: "Enter the address and token, then save.",
      };
  }
}

/**
 * Classify one recorded turn's stored assistant text.
 *
 * This can only ever prove failure. `spawn_save_local_activity`
 * (runtime/core/src/services/aibus/understand.rs) also persists deterministic
 * planner outcomes and canned on-device strings, so a text that is not a
 * recognised provider error is evidence of nothing — it is reported as
 * `no_llm_evidence`, never as success.
 *
 * Action rows now contain the arguments they were dispatched with — e.g.
 * `Action: PlayMusic {"Title":"Purple Rain","Artist":"Prince"}`, where it used
 * to be `"Action: PlayMusic"` alone. Classification here is unaffected: it
 * exact-matches known failure and refusal sentences, and everything else falls
 * through to `no_llm_evidence` regardless of what trails the action name.
 */
export function classifyLastTurnEvidence(
  prompt: ActivityPrompt | null | undefined,
): LastTurnEvidence {
  const response = prompt?.response?.trim();
  if (!response) return "none_recorded";
  // One matcher, so the label shown to the user and the verdict can never
  // disagree about whether the same reply was a provider error.
  if (matchedFailure(prompt)) return "backend_failure";
  if (SERVICE_REACHED_REFUSAL_SENTENCES.includes(response)) {
    return "service_refusal";
  }
  return "no_llm_evidence";
}

function matchedFailure(
  prompt: ActivityPrompt | null | undefined,
): BackendFailureSentence | null {
  const response = prompt?.response?.trim();
  if (!response) return null;
  return (
    BACKEND_FAILURE_SENTENCES.find((entry) => entry.text === response) ?? null
  );
}

/** Highest id wins, so the verdict does not depend on the server's row order. */
function newestPrompt(
  prompts: readonly ActivityPrompt[],
): ActivityPrompt | null {
  return prompts.reduce<ActivityPrompt | null>(
    (newest, candidate) =>
      newest === null || candidate.id > newest.id ? candidate : newest,
    null,
  );
}

function failureDetail(failure: BackendFailureSentence): string {
  switch (failure.category) {
    case "credentials":
      return "The saved credentials were rejected or missing.";
    case "model":
      return "The saved model was not found.";
    case "reachability":
      return "The assistant service could not be reached.";
    case "rate_limit":
      return "The service is receiving too many requests.";
    case "unsupported":
      return "The selected model is not compatible.";
    case "unknown":
      return "The assistant service returned an error.";
  }
}

function failureNextStep(
  failure: BackendFailureSentence,
  configured: ConfiguredProviderDescription,
): string {
  switch (failure.category) {
    case "credentials":
      // The Codex key lives in the custom-provider block, not the top-level
      // API Key field, so name the field the owner actually has to edit.
      return configured.provider === "codex"
        ? "Enter the service API key and save."
        : `Enter the ${configured.providerLabel} API key and save.`;
    case "model":
      return `Check the model name “${configured.effectiveModel ?? "(none set)"}” and save.`;
    case "reachability":
      return `Check the Pin connection to ${configured.routedThrough}.`;
    case "rate_limit":
      return "Wait a moment, then try again.";
    case "unsupported":
      return "Choose a compatible model and save.";
    case "unknown":
      return `Check the service at ${configured.routedThrough}.`;
  }
}

export interface ProviderHealthInput {
  settings: NormalizedSettings;
  /** From the existing client.getCodexStatus(); null when not read. */
  codexStatus: CodexStatusResponse | null;
  /** Window from client.listActivity("prompts"); null when not read. */
  recentPrompts: readonly ActivityPrompt[] | null;
}

export interface ProviderHealthSummary {
  verdict: ProviderHealthVerdict;
  tone: HealthTone;
  headline: string;
  detail: string;
  nextStep: string;
  configured: ConfiguredProviderDescription;
  /** Present only for the Codex provider. */
  bridge: CodexBridgeDescription | null;
  lastTurn: LastTurnEvidence;
  /** Only ever a recognised failure sentence, never arbitrary model output. */
  evidenceText: string | null;
  evidenceAt: string | null;
  recentFailureCount: number;
  examinedTurnCount: number;
  turnsLoaded: boolean;
}

const ASK_AND_RELOAD =
  "Ask the Pin a question, then check this page again.";

function missingSuffix(configured: ConfiguredProviderDescription): string {
  if (configured.missing.length === 0) return "";
  return ` Missing: ${configured.missing.join(", ")}.`;
}

export function summarizeProviderHealth(
  input: ProviderHealthInput,
): ProviderHealthSummary {
  const { settings, codexStatus, recentPrompts } = input;
  const configured = describeConfiguredProvider(settings);
  const prompts = recentPrompts ?? [];
  const newest = newestPrompt(prompts);
  const lastTurn = classifyLastTurnEvidence(newest);
  const failure = matchedFailure(newest);
  const recentFailureCount = prompts.filter(
    (prompt) => classifyLastTurnEvidence(prompt) === "backend_failure",
  ).length;
  const bridge =
    configured.provider === "codex"
      ? describeCodexBridge(codexStatus, {
          customProviderActive: settings.llm.codex_custom_active === true,
        })
      : null;

  const base = {
    configured,
    bridge,
    recentFailureCount,
    examinedTurnCount: prompts.length,
    turnsLoaded: recentPrompts !== null,
  };

  if (configured.provider === "echo") {
    // Recorded turns contain no provider tag, so any stored failure here may
    // belong to whatever was configured before echo. Judging echo by them
    // would be a fabricated verdict.
    return {
      ...base,
      verdict: "unproven",
      tone: "warning",
      headline: "Echo mode is on.",
      detail: "Replies are repeated locally. No assistant service is used.",
      nextStep: "Choose an assistant service for normal answers.",
      lastTurn: "none_recorded",
      evidenceText: null,
      evidenceAt: null,
    };
  }

  if (failure) {
    return {
      ...base,
      verdict: "failing",
      tone: "danger",
      headline: "The last request failed.",
      detail: `${failureDetail(failure)}${missingSuffix(configured)}`,
      nextStep: bridge?.failing
        ? (bridge.nextStep ?? failureNextStep(failure, configured))
        : failureNextStep(failure, configured),
      lastTurn,
      evidenceText: failure.text,
      evidenceAt: newest?.created_at ?? null,
    };
  }

  if (bridge?.failing) {
    return {
      ...base,
      verdict: "failing",
      tone: "danger",
      headline: bridge.label,
      detail: `${bridge.detail}${missingSuffix(configured)}`,
      nextStep: bridge.nextStep ?? ASK_AND_RELOAD,
      lastTurn,
      evidenceText: null,
      evidenceAt: newest?.created_at ?? null,
    };
  }

  if (configured.missing.length > 0) {
    return {
      ...base,
      verdict: "incomplete",
      tone: "warning",
      headline: `${configured.providerLabel} is missing ${configured.missing.join(", ")}.`,
      detail: "Complete the missing fields below.",
      nextStep: "Fill in the missing fields below and save.",
      lastTurn,
      evidenceText: null,
      evidenceAt: newest?.created_at ?? null,
    };
  }

  const detail = unprovenDetail({
    lastTurn,
    newest,
    recentFailureCount,
    examinedTurnCount: prompts.length,
    turnsLoaded: recentPrompts !== null,
  });

  return {
    ...base,
    verdict: "unproven",
    tone: recentFailureCount > 0 ? "warning" : "info",
    headline: "Ready to try.",
    detail,
    nextStep: ASK_AND_RELOAD,
    lastTurn,
    evidenceText:
      lastTurn === "service_refusal" ? (newest?.response?.trim() ?? null) : null,
    evidenceAt: newest?.created_at ?? null,
  };
}

function unprovenDetail(input: {
  lastTurn: LastTurnEvidence;
  newest: ActivityPrompt | null;
  recentFailureCount: number;
  examinedTurnCount: number;
  turnsLoaded: boolean;
}): string {
  const { lastTurn, recentFailureCount, examinedTurnCount, turnsLoaded } = input;

  if (!turnsLoaded) {
    return "Recent activity has not been checked.";
  }
  if (examinedTurnCount === 0) {
    return "No recent requests are recorded.";
  }

  const trailer =
    recentFailureCount > 0
      ? ` ${recentFailureCount} of ${examinedTurnCount} recent requests failed.`
      : "";

  switch (lastTurn) {
    case "service_refusal":
      return `The last request reached the service but was declined.${trailer}`;
    case "none_recorded":
      return `The last request has no saved reply.${trailer}`;
    default:
      return `No service error was found in the last request.${trailer}`;
  }
}
