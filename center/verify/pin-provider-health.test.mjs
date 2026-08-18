/*
 * Behavioural guards for `_lib/providerHealth`, the Settings panel that reports
 * whether the Pin's configured LLM provider is working.
 *
 * The module's whole design is a negative claim: nothing Center can call proves
 * a model answers. `/api/health` returns a hardcoded "ok" without touching the
 * LLM, and `/api/codex/status` reads an account record, not a model call. So
 * there is deliberately no "healthy" verdict — the panel can prove FAILURE from
 * evidence the Pin already persisted, prove a configuration gap, and otherwise
 * says "unproven" and names the one check that would settle it.
 *
 * That makes two properties worth pinning, and both are here:
 *
 *   - It cannot invent a green. The combinatorial case at the end runs every
 *     complete configuration against every bridge status and every innocuous
 *     reply and requires "unproven" from all of them. A green indicator that
 *     cannot go red is the defect this repo keeps rediscovering.
 *   - It cannot invent a red, and it never echoes model output. Failure is
 *     recognised by exact-matching the sentences the Pin's Rust side persists
 *     as the assistant reply; anything else — including a plausible answer — is
 *     evidence of nothing, and `evidenceText` stays null so an arbitrary reply
 *     never reaches the settings panel.
 *
 * The coupling to those sentences is to prose, so the constants below are
 * copied from the server (runtime/core/src/llm/error.rs `friendly_error_message`
 * and runtime/core/src/synapse/chat_turn_loop.rs `speakable_backend_error`) and
 * the test pins the cross-language contract: if the server rewords one, this
 * fails rather than the panel silently degrading to "cannot tell".
 *
 * Ported from the `pin/setup` SPA's vitest suite. Center's copy of the module is
 * byte-identical to the SPA's apart from a header comment and the
 * `../api` -> `@/lib/pin-device` type import.
 */

// Registers the resolve hook that lets these `src/` modules reach their own
// extensionless siblings and `@/lib/…` aliases under Node's type stripping.
// Static, so it is evaluated before the dynamic imports below.
import "./tsResolve.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const QUERY = "?pin-provider-health-test";

const {
  classifyLastTurnEvidence,
  describeCodexBridge,
  describeConfiguredProvider,
  summarizeProviderHealth,
} = await import(`../src/app/settings/pin/_lib/providerHealth.ts${QUERY}`);
const { normalizeSettingsResponse } = await import(
  `../src/app/settings/pin/_lib/settingsResponse.ts${QUERY}`
);

// Sentences copied from the server so the test pins the cross-language
// contract: runtime/core/src/llm/error.rs (friendly_error_message) and
// runtime/core/src/synapse/chat_turn_loop.rs (speakable_backend_error). These are
// the exact strings persisted as the assistant reply when a turn fails.
const SERVICE_UNAVAILABLE =
  "The AI service is temporarily unavailable. Please try again shortly.";
const BAD_API_KEY =
  "There's a problem with the API key configuration. Please check the server settings.";
const CONTENT_FILTER =
  "The AI service declined to answer that. Try rephrasing your question.";

function settingsFrom(llm) {
  return normalizeSettingsResponse({
    llm: {
      provider: "echo",
      model: "",
      has_api_key: false,
      base_url: null,
      ...llm,
    },
    server: {
      http_bind_addr: "0.0.0.0:8080",
      system_prompt: "You are a helpful assistant.",
    },
    storage: { media_dir: "./media", db_path: "./data/penumbra.db" },
    weather: { has_api_key: false },
  }).settings;
}

/** The configuration installed on the user's Pin today. */
function livePinSettings() {
  return settingsFrom({
    provider: "codex",
    model: "gpt-5.6-sol",
    codex_bridge_url: "http://127.0.0.1:8765",
    has_codex_bridge_token: true,
    codex_provider_base_url:
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    codex_model: "qwen-plus",
    has_codex_api_key: true,
    codex_custom_active: true,
  });
}

function prompt(id, response, createdAt = "2026-07-27T10:00:00Z") {
  return {
    id,
    run_id: `run-${id}`,
    prompt: "what is the weather",
    response,
    is_vision: false,
    created_at: createdAt,
  };
}

function codexStatus(state, overrides = {}) {
  return { state, ready: state === "ready", ...overrides };
}

/* ── classifyLastTurnEvidence ─────────────────────────────────────────────── */

test("recognizes a persisted provider-error sentence as a backend failure", () => {
  assert.equal(
    classifyLastTurnEvidence(prompt(1, SERVICE_UNAVAILABLE)),
    "backend_failure",
  );
  assert.equal(
    classifyLastTurnEvidence(prompt(1, BAD_API_KEY)),
    "backend_failure",
  );
});

test("does not call a provider refusal a backend failure", () => {
  // The provider was reached and answered; reporting this as a dead backend
  // would be a false red.
  assert.equal(
    classifyLastTurnEvidence(prompt(1, CONTENT_FILTER)),
    "service_refusal",
  );
});

test("treats a planner outcome or a plain answer as no evidence at all", () => {
  assert.equal(
    classifyLastTurnEvidence(prompt(1, "Action: PlayMusic")),
    "no_llm_evidence",
  );
  assert.equal(
    classifyLastTurnEvidence(prompt(1, "The capital of France is Paris.")),
    "no_llm_evidence",
  );
});

test("reports an absent or blank reply as nothing recorded", () => {
  assert.equal(classifyLastTurnEvidence(prompt(1, null)), "none_recorded");
  assert.equal(classifyLastTurnEvidence(prompt(1, "   ")), "none_recorded");
  assert.equal(classifyLastTurnEvidence(null), "none_recorded");
});

/* ── describeConfiguredProvider ───────────────────────────────────────────── */

test("names the codex block's model when the custom provider is active", () => {
  // config.rs effective_model sends the codex model, not the top-level one,
  // so naming llm.model here would name a model the Pin never asks for.
  const configured = describeConfiguredProvider(livePinSettings());

  assert.equal(configured.effectiveModel, "qwen-plus");
  assert.ok(
    configured.routedThrough.includes(
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    ),
    "the route must name the custom provider base URL a turn actually goes to",
  );
  assert.deepEqual(configured.missing, []);
});

test("does not guess whether a ChatGPT sign-in exists", () => {
  const configured = describeConfiguredProvider(
    settingsFrom({
      provider: "codex",
      model: "gpt-5.6-sol",
      codex_bridge_url: "http://127.0.0.1:8765",
      has_codex_bridge_token: true,
    }),
  );

  assert.equal(configured.effectiveModel, "gpt-5.6-sol");
  assert.equal(configured.credentialPresent, null);
});

test("lists the fields a keyed provider cannot start without", () => {
  assert.deepEqual(
    describeConfiguredProvider(
      settingsFrom({ provider: "openai-compatible", model: "" }),
    ).missing,
    ["API key", "Model ID", "Base URL"],
  );

  assert.deepEqual(
    describeConfiguredProvider(
      settingsFrom({
        provider: "openai-compatible",
        model: "qwen3-max",
        has_api_key: true,
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      }),
    ).missing,
    [],
  );
});

/* ── describeCodexBridge ──────────────────────────────────────────────────── */

test("does not ask a custom-provider owner to sign in to ChatGPT", () => {
  // codex.rs get_status recomputes ready as `ready && login_mode ==
  // "chatgpt"`, so a fully keyed DashScope Pin always reports signed_out.
  const bridge = describeCodexBridge(codexStatus("signed_out"), {
    customProviderActive: true,
  });

  assert.equal(bridge.failing, false);
  assert.equal(bridge.nextStep, null);
  assert.doesNotMatch(`${bridge.label} ${bridge.detail}`, /sign[- ]?in/i);
  assert.match(bridge.detail, /custom service is selected/i);
});

test("does ask for a sign-in when no custom provider is active", () => {
  const bridge = describeCodexBridge(codexStatus("signed_out"), {
    customProviderActive: false,
  });

  assert.match(bridge.nextStep, /ChatGPT sign-in/i);
  assert.equal(bridge.failing, false);
});

test("marks only the states that stop a turn reaching a model as failing", () => {
  const failing = (state) =>
    describeCodexBridge(codexStatus(state), {
      customProviderActive: false,
    }).failing;

  assert.equal(failing("unreachable"), true);
  assert.equal(failing("unauthorized"), true);
  assert.equal(failing("unavailable"), true);
  assert.equal(failing("not_configured"), true);
  assert.equal(failing("ready"), false);
  assert.equal(failing("signed_out"), false);
});

test("a ready account record is described without claiming an answer came back", () => {
  const bridge = describeCodexBridge(codexStatus("ready"), {
    customProviderActive: false,
  });

  assert.match(bridge.detail, /connected on this Pin/i);
  assert.doesNotMatch(`${bridge.label} ${bridge.detail}`, /answered|model call/i);
});

/* ── summarizeProviderHealth ──────────────────────────────────────────────── */

test("reports the live Pin's failing turn instead of a ChatGPT sign-in prompt", () => {
  const summary = summarizeProviderHealth({
    settings: livePinSettings(),
    // The bridge is listening and passes identity verification, so the
    // status endpoint reports the same signed_out it always does here.
    codexStatus: codexStatus("signed_out"),
    recentPrompts: [prompt(9, SERVICE_UNAVAILABLE, "2026-07-27T10:05:00Z")],
  });

  assert.equal(summary.verdict, "failing");
  assert.equal(summary.tone, "danger");
  assert.equal(summary.evidenceText, SERVICE_UNAVAILABLE);
  assert.equal(summary.evidenceAt, "2026-07-27T10:05:00Z");
  assert.doesNotMatch(
    `${summary.headline} ${summary.detail} ${summary.nextStep}`,
    /ChatGPT/i,
  );
  assert.ok(
    summary.nextStep.includes(
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    ),
    "the fix must point at the endpoint the turn actually failed against",
  );
});

test("stays unproven when the newest turn is only a planner outcome", () => {
  const summary = summarizeProviderHealth({
    settings: livePinSettings(),
    codexStatus: codexStatus("signed_out"),
    recentPrompts: [prompt(4, "Action: PlayMusic")],
  });

  assert.equal(summary.verdict, "unproven");
  assert.equal(summary.evidenceText, null);
  assert.match(summary.detail, /No service error was found/i);
});

test("surfaces an older failure in the window without inventing a red verdict", () => {
  const summary = summarizeProviderHealth({
    settings: livePinSettings(),
    codexStatus: codexStatus("signed_out"),
    recentPrompts: [
      prompt(4, "Action: PlayMusic"),
      prompt(3, SERVICE_UNAVAILABLE),
      prompt(2, "Action: SetTimer"),
    ],
  });

  assert.equal(summary.verdict, "unproven");
  assert.equal(summary.tone, "warning");
  assert.equal(summary.recentFailureCount, 1);
  assert.ok(summary.detail.includes("1 of 3 recent requests failed"));
});

test("points a key failure at the field the owner actually has to edit", () => {
  const codex = summarizeProviderHealth({
    settings: livePinSettings(),
    codexStatus: codexStatus("signed_out"),
    recentPrompts: [prompt(1, BAD_API_KEY)],
  });
  const gemini = summarizeProviderHealth({
    settings: settingsFrom({
      provider: "gemini",
      model: "gemini-2.5-flash",
      has_api_key: true,
    }),
    codexStatus: null,
    recentPrompts: [prompt(1, BAD_API_KEY)],
  });

  // The Codex key lives in the custom-provider block, not the top-level field.
  assert.ok(codex.nextStep.includes("service API key"));
  assert.ok(gemini.nextStep.includes("Google Gemini API key"));
});

test("uses the highest id as the newest turn regardless of list order", () => {
  const summary = summarizeProviderHealth({
    settings: livePinSettings(),
    codexStatus: codexStatus("signed_out"),
    recentPrompts: [
      prompt(2, "Action: SetTimer"),
      prompt(7, BAD_API_KEY),
      prompt(5, "Action: PlayMusic"),
    ],
  });

  assert.equal(summary.verdict, "failing");
  assert.equal(summary.evidenceText, BAD_API_KEY);
});

test("calls an unreachable bridge failing even with no recorded turns", () => {
  const summary = summarizeProviderHealth({
    settings: livePinSettings(),
    codexStatus: codexStatus("unreachable"),
    recentPrompts: [],
  });

  assert.equal(summary.verdict, "failing");
  assert.match(summary.nextStep, /confirm Codex is running/i);
});

test("reports a missing credential as incomplete, not as a failure", () => {
  const summary = summarizeProviderHealth({
    settings: settingsFrom({ provider: "gemini", model: "gemini-2.5-flash" }),
    codexStatus: null,
    recentPrompts: [],
  });

  assert.equal(summary.verdict, "incomplete");
  assert.ok(summary.headline.includes("API key"));
  assert.equal(summary.bridge, null);
});

test("distinguishes turns not loaded from no turns recorded", () => {
  const settings = settingsFrom({
    provider: "gemini",
    model: "gemini-2.5-flash",
    has_api_key: true,
  });

  assert.match(
    summarizeProviderHealth({
      settings,
      codexStatus: null,
      recentPrompts: null,
    }).detail,
    /Recent activity has not been checked/i,
  );

  assert.match(
    summarizeProviderHealth({
      settings,
      codexStatus: null,
      recentPrompts: [],
    }).detail,
    /No recent requests are recorded/i,
  );
});

test("says plainly that the echo provider contacts no model", () => {
  const summary = summarizeProviderHealth({
    settings: settingsFrom({ provider: "echo" }),
    codexStatus: null,
    // A stale failure from a previous provider must not be attributed to echo.
    recentPrompts: [prompt(1, SERVICE_UNAVAILABLE)],
  });

  assert.equal(summary.verdict, "unproven");
  assert.match(summary.headline, /Echo mode is on/i);
  assert.match(summary.detail, /No assistant service is used/i);
  assert.equal(summary.evidenceText, null);
});

test("never turns a plausible reply into a healthy verdict", () => {
  // The structural guard: no combination of a complete configuration, a
  // "ready" bridge and a normal-looking reply may report health, because
  // nothing in that set is a model call.
  const configurations = [
    livePinSettings(),
    settingsFrom({
      provider: "gemini",
      model: "gemini-2.5-flash",
      has_api_key: true,
    }),
    settingsFrom({
      provider: "openai-compatible",
      model: "qwen3-max",
      has_api_key: true,
      base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    }),
  ];
  const statuses = [
    null,
    codexStatus("ready", { login_mode: "chatgpt" }),
    codexStatus("signed_out"),
  ];
  const replies = [
    "The capital of France is Paris.",
    "Action: PlayMusic",
    CONTENT_FILTER,
    null,
  ];

  for (const settings of configurations) {
    for (const status of statuses) {
      for (const reply of replies) {
        const summary = summarizeProviderHealth({
          settings,
          codexStatus: status,
          recentPrompts: [prompt(1, reply)],
        });

        assert.equal(summary.verdict, "unproven");
        assert.equal("proves" in summary, false);
        assert.equal("doesNotProve" in summary, false);
        assert.match(summary.nextStep, /Ask the Pin a question/i);
      }
    }
  }
});

test("never leaks arbitrary model output into the settings panel", () => {
  const summary = summarizeProviderHealth({
    settings: livePinSettings(),
    codexStatus: codexStatus("signed_out"),
    recentPrompts: [prompt(1, "Your bank balance is 12345.")],
  });

  assert.equal(summary.evidenceText, null);
  assert.ok(
    !JSON.stringify(summary).includes("12345"),
    "no part of the summary may contain the model's own words",
  );
});
