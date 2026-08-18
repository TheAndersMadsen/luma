#!/usr/bin/env node
// Guided first-run Ai Pin configuration helper.
//
// The gap this closes: installing the Pin runtime does not configure a model
// provider or its credential. The assistant still answers nothing until both
// exist, because no provider works with zero user input (device bootstrap ships
// `provider = codex` with no login;
// `runtime/core/config.toml` ships `provider = gemini` with a commented-out key).
// This tool reads that gap out loud and, on request, closes the part of it that
// can be closed without a human at a browser.
//
// Three subcommands, all small:
//   status        read provider/model/credential-presence/health/codex login
//                 state and print what is still missing (READ-ONLY, always)
//   set-provider  build the minimal settings PUT for one provider choice
//                 (DRY RUN by default; a write needs --apply AND --serial)
//   verify        send one real turn and judge the ANSWER, not the latency
//
// Design rules this file keeps (each was learned the hard way in this repo):
//
//   1. Read-only by default. `shouldApplySettingsWrite()` is the single
//      decision point and returns false unless BOTH --apply and --serial are
//      present. Without them the exact PUT body is printed with every secret
//      redacted, and the process exits 0.
//   2. A secret is never a command-line argument. `--api-key VALUE` is
//      refused by the parser with an explanation; keys come from an
//      environment variable or a mode-600 file and are never printed. The
//      default env-var names are the server's own
//      (`runtime/core/src/config.rs:1446-1450`, `:318-320`).
//   3. Interactive ChatGPT/codex sign-in is NOT automated. This tool detects
//      the login state (`GET /api/codex/status`,
//      `runtime/core/src/api/codex.rs:87-137`) and prints the two steps the
//      operator must run themselves. It never opens a browser and never
//      pretends the login happened.
//   4. Verification judges CONTENT. Observed on an operator-owned Pin: a
//      misconfigured backend returned `backend_unavailable` at about 4.3s,
//      faster than healthy answers,
//      so "a response came back" and "it was quick" both report a broken
//      assistant as healthy. `classifyProbeAnswer()` takes only the answer
//      text — it cannot be fooled by latency because it never sees it.
//   5. There is ONE answer extractor in this tree, and it is not here.
//      `extractAnswer` (platform/deploy/acceptance/pin/prompt-suite.mjs:449-488) is imported rather
//      than re-implemented, because both obvious re-implementations are wrong
//      on this device's real frames: `answer`/`text`/`speech` are keys no
//      decoded frame carries, `isFinal` is false on 113/113 real frames, and
//      longest-frame-wins prefers a verbose interim over the terminal answer
//      (measured min/median/max answer length = 4/42/93 characters).
//
// Field names, provider values and endpoints are taken from the server, not
// invented:
//   * PUT body shape          runtime/core/src/api.rs:643-665 (UpdateLlmSettings)
//   * provider values         runtime/core/src/config.rs:106-116 (LlmProvider)
//   * codex flat->nested map  runtime/core/src/api.rs:960-1008
//   * presence-only readback  runtime/core/src/api.rs:479-526 (has_* booleans)
//   * codex login states      runtime/core/src/api/codex.rs:40-48
//   * maintenance ADB surface runtime/android/src/main/kotlin/com/penumbraos/server/
//                             UsbMaintenanceProvider.kt:52-92, :404-421
//
// This is a standalone tool. It is deliberately NOT registered in
// platform/deploy/acceptance/pin/pinbox/registry.mjs (that file is owned elsewhere); run it directly.

import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runAdb } from "./pinbox/shared/adb.mjs";
import {
  summarizeResponses,
  MAX_ANSWER_CHARS_STDOUT,
} from "./pinbox/shared/evidence.mjs";
// The answer extractor and the measured failure vocabulary, imported so this
// file cannot drift into being a third copy of either. prompt-suite.mjs is data
// plus pure functions — no imports, no I/O — so pulling it in costs nothing.
import {
  UNAVAILABLE_ANSWER_PATTERNS,
  extractAnswer,
  isMachineryLeak,
  isUnavailableAnswer,
} from "./prompt-suite.mjs";
import { OPERATIONAL_MARKERS } from "./tier-a-symbols.mjs";

const PROGRAM = "revival-pin-configure";

// The Hook redirects api.prod.humane.cloud to this loopback port; the same
// port `pinbox probe` uses for the real Understand RPC (platform/deploy/acceptance/pin/pinbox/
// commands/probe.mjs:53).
const AIBUS_DEVICE_PORT = 9_090;

// Fixed admin HTTP origin, matching the existing device transports
// (platform/deploy/acceptance/pin/agentic-release-smoke.mjs:375, platform/deploy/acceptance/pin/pinbox/shared/admin-http.mjs:26).
// A non-default port is exactly why the maintenance provider exists: it reads
// the effective port on-device (UsbMaintenanceProvider.kt:106-110).
const ADMIN_HTTP_ORIGIN = "http://127.0.0.1:8080";
const SETTINGS_PATH = "/api/settings";

const MAINTENANCE_URI = "content://com.penumbraos.server.maintenance";

// The PUT body carries the plaintext API key, so for the length of one curl
// call that key exists as a FILE on the device. `/data/local/tmp` is the only
// directory `adb push` can write without root, and it cannot be made private:
// it is shared, shell-owned scratch space that any other adb shell can list. So
// this does not pretend the directory is safe — it minimises the window:
//   * an unpredictable per-run name, so the path cannot be guessed and camped
//     on before the file exists;
//   * chmod 600 immediately after the push (adb push lands 0644), which is a
//     narrow race the unpredictable name is what actually covers;
//   * removal in a `finally`, so a PUT that fails — the case that would
//     otherwise leave a live credential on the device — still cleans up.
const STAGED_BODY_DIRECTORY = "/data/local/tmp";
const STAGED_BODY_NAME_BYTES = 12;
const HTTP_STATUS_MARKER = "\n__PENUMBRA_CONFIGURE_HTTP__:";

const MAX_MAINTENANCE_OUTPUT_BYTES = 512 * 1024;
const MAX_SECRET_FILE_BYTES = 8 * 1024;
const DEFAULT_VERIFY_TIMEOUT_MS = 90_000;

// A knowledge question: no tool, no device state, no personal data, and a
// famously short correct answer — so a PASS cannot be an artefact of length.
const DEFAULT_VERIFY_PROMPT = "What is the capital of France?";

const REDACTED = "<redacted>";

class UsageError extends Error {}
class ConfigureError extends Error {}

// ─── provider table ─────────────────────────────────────────────────────────
//
// `provider` values are the serde renames in runtime/core/src/config.rs:106-116.
// `fields` are the flat UpdateLlmSettings names in runtime/core/src/api.rs:643-665.
// Nothing here is invented; `buildProviderPatch` emits these names only.

export const PROVIDER_CHOICES = Object.freeze({
  "codex-chatgpt": Object.freeze({
    provider: "codex",
    summary:
      "On-device codex app-server driving your own ChatGPT account (interactive sign-in required).",
    // model is the ChatGPT model id; no credential lives in settings for this
    // mode (runtime/core/src/config.rs:1443-1449 returns None for Codex).
    secret: null,
    interactiveLogin: true,
  }),
  "codex-custom": Object.freeze({
    provider: "codex",
    summary:
      "On-device codex app-server pointed at your own OpenAI-compatible endpoint (no ChatGPT login).",
    secret: Object.freeze({ field: "codex_api_key", defaultEnv: "DASHSCOPE_API_KEY" }),
    interactiveLogin: false,
  }),
  "openai-compatible": Object.freeze({
    provider: "openai-compatible",
    summary: "Any OpenAI-compatible HTTP endpoint, called directly by the server.",
    secret: Object.freeze({ field: "api_key", defaultEnv: "OPENAI_API_KEY" }),
    interactiveLogin: false,
  }),
  openai: Object.freeze({
    provider: "openai",
    summary: "OpenAI, called directly by the server.",
    secret: Object.freeze({ field: "api_key", defaultEnv: "OPENAI_API_KEY" }),
    interactiveLogin: false,
  }),
  anthropic: Object.freeze({
    provider: "anthropic",
    summary: "Anthropic, called directly by the server.",
    secret: Object.freeze({ field: "api_key", defaultEnv: "ANTHROPIC_API_KEY" }),
    interactiveLogin: false,
  }),
  gemini: Object.freeze({
    provider: "gemini",
    summary: "Google Gemini, called directly by the server.",
    secret: Object.freeze({ field: "api_key", defaultEnv: "GEMINI_API_KEY" }),
    interactiveLogin: false,
  }),
});

// Every field name this tool is allowed to place inside the `llm` object.
// A test asserts buildProviderPatch never emits anything outside this set, so
// a typo cannot reach the device as a silently-ignored key.
export const ALLOWED_LLM_FIELDS = Object.freeze([
  "provider",
  "model",
  "base_url",
  "api_key",
  "codex_provider_base_url",
  "codex_model",
  "codex_provider_name",
  "codex_wire_api",
  "codex_api_key",
  "tools",
]);

// Any settings field whose value must never be rendered. Wider than what this
// tool writes on purpose: redaction should not need updating to stay correct.
export const SECRET_FIELD_NAMES = Object.freeze([
  "api_key",
  "codex_api_key",
  "codex_bridge_token",
  "admin_token",
]);

// Fields whose value is a URL. A URL is not itself a secret, but it can COSMOS
// one in its userinfo, so these are rendered through `redactUrlUserinfo`
// instead of verbatim.
export const URL_FIELD_NAMES = Object.freeze(["base_url", "codex_provider_base_url"]);

// Server defaults for the codex subtable (runtime/core/src/config.rs:322-328).
// Sent explicitly so a first run is deterministic even when a previous codex
// block is still persisted.
export const DEFAULT_CODEX_PROVIDER_NAME = "dashscope";
export const DEFAULT_CODEX_WIRE_API = "responses";

// ─── failure vocabulary (the whole point of `verify`) ────────────────────────
//
// These are the exact sentences a user hears when a turn FAILS. They are
// transcribed from the server, not guessed:
//   runtime/core/src/llm/error.rs:10-60   friendly_error_message (9 sentences)
//   runtime/core/src/synapse/chat_turn_loop.rs:97,923-931,938-941  decline_speech
// Each is short and arrives fast, which is exactly why a latency check or a
// "did anything come back" check calls a dead assistant healthy.

export const DECLINE_ANSWERS = Object.freeze([
  // llm/error.rs:12
  "I'm getting too many requests right now. Please try again in a moment.",
  // llm/error.rs:20
  "There's a problem with the API key configuration. Please check the server settings.",
  // llm/error.rs:26
  "The configured AI model wasn't found. Please check the server settings.",
  // llm/error.rs:34
  "The AI service is temporarily unavailable. Please try again shortly.",
  // llm/error.rs:39
  "The request to the AI service timed out. Please try again.",
  // llm/error.rs:45
  "I couldn't reach the AI service. Please check the server's internet connection.",
  // llm/error.rs:50
  "The AI service declined to answer that. Try rephrasing your question.",
  // llm/error.rs:57
  "That conversation got too long for the AI service to handle. Try starting a new one.",
  // llm/error.rs:60
  "Something went wrong while contacting the AI service. Please try again.",
  // chat_turn_loop.rs:97
  "I couldn't complete that request.",
  // chat_turn_loop.rs:923
  "That needed more steps than I can take in one go. Try asking for one thing at a time.",
  // chat_turn_loop.rs:928
  "I didn't get an answer back that time. Please try again.",
  // chat_turn_loop.rs:931
  "I couldn't work out how to do that one. Try rephrasing it.",
  // chat_turn_loop.rs:938
  "This device's AI model isn't set up for that. Please check the server settings.",
  // chat_turn_loop.rs:941
  "That request got too large for me to handle.",
]);

// Narrow, highly specific substrings, so wording drift in the server does not
// silently turn a decline into a "pass". Each is a phrase that only appears in
// the failure vocabulary above (or in a raw trace that leaked through).
export const DECLINE_MARKERS = Object.freeze([
  "please check the server settings",
  "contacting the ai service",
  "reach the ai service",
  "ai service is temporarily unavailable",
  OPERATIONAL_MARKERS.backend_unavailable.value,
]);

function normalizeAnswer(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const NORMALIZED_DECLINES = new Map(
  DECLINE_ANSWERS.map((sentence) => [normalizeAnswer(sentence), sentence]),
);

/**
 * Judge one spoken answer. TEXT ONLY — no latency, no frame count, no
 * "something came back" signal, because all three report a broken assistant as
 * healthy. Returns `{ ok, verdict, reason, matched, chars }`.
 */
export function classifyProbeAnswer(text) {
  const normalized = normalizeAnswer(text);
  const chars = typeof text === "string" ? text.length : 0;
  if (normalized.length === 0) {
    return {
      ok: false,
      verdict: "empty",
      reason: "no spoken answer came back (an empty answer is a failure, not a fast pass)",
      matched: null,
      chars,
    };
  }
  const exact = NORMALIZED_DECLINES.get(normalized);
  if (exact !== undefined) {
    return {
      ok: false,
      verdict: "decline",
      reason: "the reply is a known server decline sentence, not an answer",
      matched: exact,
      chars,
    };
  }
  for (const marker of DECLINE_MARKERS) {
    if (normalized.includes(marker)) {
      return {
        ok: false,
        verdict: "decline",
        reason: `the reply carries a backend-failure marker (${marker})`,
        matched: marker,
        chars,
      };
    }
  }
  // The two lists above are transcribed from the SERVER's own sentences, and
  // that is exactly what let the reply that motivated this check through: the
  // bridge's "Codex is unavailable on the host. Check its login status." is not
  // one of them, is well-formed, and arrived in ~4s — faster than a correct
  // answer. `isUnavailableAnswer` is the measured vocabulary for replies that
  // mean BROKEN rather than declined, imported so there is one list, not two.
  if (isUnavailableAnswer(text)) {
    const pattern = UNAVAILABLE_ANSWER_PATTERNS.find((entry) => entry.test(text));
    return {
      ok: false,
      verdict: "decline",
      reason: "the reply says the assistant is unavailable, which is a failure however fast it arrived",
      matched: pattern === undefined ? null : String(pattern),
      chars,
    };
  }
  // A shipped defect rather than a configuration problem, kept a separate
  // verdict so it is never read as "the backend is down".
  if (isMachineryLeak(text)) {
    return {
      ok: false,
      verdict: "machinery",
      reason: "raw tool machinery was spoken instead of an answer",
      matched: null,
      chars,
    };
  }
  return {
    ok: true,
    verdict: "answer",
    reason: "the reply is not in the server's failure vocabulary",
    matched: null,
    chars,
  };
}

// What each non-`ok` `extractAnswer` status means for THIS command. `verify`
// asks one knowledge question, so every status other than `ok` is a failure
// here — including `no-respond-frame`, which is a perfectly correct outcome for
// the prompt suite ("play something" ends in a device action) but never for
// "What is the capital of France?".
const EXTRACTION_FAILURES = Object.freeze({
  "no-frames": Object.freeze({
    verdict: "empty",
    reason: "the turn produced no frames at all (silence is a failure, not a fast pass)",
  }),
  "no-respond-frame": Object.freeze({
    verdict: "no-answer",
    reason: "the turn ended in a device action and never spoke an answer",
  }),
  "malformed-respond": Object.freeze({
    verdict: "malformed",
    reason: "the Respond frame's input was not parseable JSON containing a string Response",
  }),
  "legacy-text-dropped": Object.freeze({
    verdict: "malformed",
    reason: "the answer exists on the wire but is unreachable from the decoded frame",
  }),
});

/**
 * Judge an `extractAnswer` result. Also text-only: the extraction carries frame
 * shape, never timing.
 *
 * Statuses are scored rather than collapsed to an empty string, because "no
 * frames", "a device action answered" and "a Respond frame we could not parse"
 * are three different defects and only one of them is silence. Unknown statuses
 * fail closed.
 */
export function classifyProbeExtraction(extraction) {
  const status = extraction?.status ?? "no-frames";
  const chars = typeof extraction?.text === "string" ? extraction.text.length : 0;
  if (status !== "ok") {
    const failure = EXTRACTION_FAILURES[status] ?? {
      verdict: "no-answer",
      reason: `the answer extractor reported status "${String(status)}"`,
    };
    return { ok: false, verdict: failure.verdict, reason: failure.reason, matched: null, chars };
  }
  return classifyProbeAnswer(extraction.text);
}

// ─── the PUT body ───────────────────────────────────────────────────────────

function requireText(value, what) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigureError(`${what} is required`);
  }
  return value.trim();
}

function requireHttpsUrl(value, what) {
  const text = requireText(value, what);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigureError(`${what} must be a valid URL`);
  }
  // Mirrors validate_codex_provider_base_url (runtime/core/src/config.rs:1713-1724)
  // so the operator gets the refusal here instead of an HTTP 400 later.
  if (url.protocol !== "https:") {
    throw new ConfigureError(`${what} must use HTTPS`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new ConfigureError(`${what} must not contain credentials in the URL`);
  }
  return text;
}

// Hosts where plain http never leaves the machine. An OpenAI-compatible
// endpoint on the device's own loopback is a real shape here — the codex bridge
// listens on 127.0.0.1:8765 — and the server accepts it, so refusing it outright
// would make this tool unable to configure a working deployment.
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Validate a provider base URL.
 *
 * Userinfo is refused for EVERY base URL, not only the codex one. A basic-auth
 * gateway (`https://user:pass@host/v1`) is a real OpenAI-compatible deployment
 * shape, and `base_url` IS printed — in the dry-run body and in `--json` — so
 * validating it with `requireText` alone put a password on stdout, breaking
 * this file's own rule that a credential never reaches a printed surface.
 *
 * The server does not validate `llm.base_url` at all (only the codex one, at
 * runtime/core/src/config.rs:1713-1724), so the HTTPS rule is this tool's policy
 * rather than a mirror of the server's: the API key travels inside that
 * request, and cleartext is only tolerable when the request never leaves the
 * device.
 */
function requireProviderBaseUrl(value, what) {
  const text = requireText(value, what);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigureError(`${what} must be a valid URL`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new ConfigureError(`${what} must not contain credentials in the URL`);
  }
  if (url.protocol === "https:") return text;
  if (url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname)) return text;
  throw new ConfigureError(
    `${what} must use HTTPS (plain http is accepted only for a loopback host, where the API key never leaves the device)`,
  );
}

function requireSlug(value, what, maxLength) {
  const text = requireText(value, what);
  if (text.length > maxLength || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new ConfigureError(
      `${what} must be 1-${maxLength} alphanumeric, dash or underscore characters`,
    );
  }
  return text;
}

/**
 * Build the minimal `PUT /api/settings` body for one provider choice.
 *
 * Emits documented flat field names only (runtime/core/src/api.rs:643-665). The
 * real secret goes IN (the device needs it); redaction is a rendering concern,
 * never a data concern — see `renderPatch`.
 */
export function buildProviderPatch(choice, opts = {}) {
  const spec = PROVIDER_CHOICES[choice];
  if (spec === undefined) {
    throw new ConfigureError(
      `unknown provider choice: ${String(choice)} (expected one of ${Object.keys(PROVIDER_CHOICES).join(", ")})`,
    );
  }
  const llm = { provider: spec.provider };

  if (choice === "codex-chatgpt") {
    llm.model = requireText(opts.model, "--model");
    if (opts.clearCodexCustom === true) {
      // Empty string clears each value server-side (runtime/core/src/api.rs:975,
      // :979, :999-1004), so a previously configured custom provider cannot
      // keep `codex_custom_active` true while the operator expects ChatGPT.
      llm.codex_provider_base_url = "";
      llm.codex_model = "";
      llm.codex_api_key = "";
    }
  } else if (choice === "codex-custom") {
    llm.codex_provider_base_url = requireHttpsUrl(opts.codexBaseUrl, "--codex-base-url");
    llm.codex_model = requireText(opts.codexModel, "--codex-model");
    llm.codex_provider_name = requireSlug(
      opts.codexProviderName ?? DEFAULT_CODEX_PROVIDER_NAME,
      "--codex-provider-name",
      64,
    );
    llm.codex_wire_api = requireSlug(
      opts.codexWireApi ?? DEFAULT_CODEX_WIRE_API,
      "--codex-wire-api",
      32,
    );
    llm.codex_api_key = requireText(opts.apiKey, "an API key");
  } else {
    llm.model = requireText(opts.model, "--model");
    if (choice === "openai-compatible") {
      // The server does not enforce this (base_url is applied only when
      // present, runtime/core/src/llm/providers/openai.rs:28-30) — but an
      // openai-compatible provider with no base URL silently talks to the
      // default OpenAI endpoint, which is never what the operator meant.
      llm.base_url = requireProviderBaseUrl(opts.baseUrl, "--base-url");
    } else if (typeof opts.baseUrl === "string" && opts.baseUrl.trim().length > 0) {
      // Optional here, but held to the same rule: an overridden endpoint for
      // openai/anthropic/gemini carries the same key and is printed the same way.
      llm.base_url = requireProviderBaseUrl(opts.baseUrl, "--base-url");
    }
    llm.api_key = requireText(opts.apiKey, "an API key");
  }

  if (opts.enableTools === true) {
    // llm.tools.enabled defaults true (runtime/core/src/config.rs:900-902); when
    // it is false the stock path runs instead of the agentic one and a green
    // probe proves nothing (platform/deploy/acceptance/pin/pinbox/shared/evidence.mjs:46-56).
    llm.tools = { enabled: true };
  }

  const unexpected = Object.keys(llm).filter((key) => !ALLOWED_LLM_FIELDS.includes(key));
  if (unexpected.length > 0) {
    throw new ConfigureError(`refusing an undocumented settings field: ${unexpected.join(", ")}`);
  }
  return { llm };
}

/**
 * A URL that is safe to print: its userinfo, if any, is replaced rather than
 * shown. Everything else is returned byte-for-byte, so this never "helpfully"
 * normalises a URL an operator is trying to read back.
 */
export function redactUrlUserinfo(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.username.length === 0 && url.password.length === 0) return value;
  return `${url.protocol}//${REDACTED}@${url.host}${url.pathname}${url.search}${url.hash}`;
}

/**
 * Deep copy with every secret-valued field replaced by a fixed placeholder, and
 * every URL-valued field stripped of userinfo.
 *
 * `buildProviderPatch` already refuses a credential-bearing base URL, so the
 * URL pass is defence in depth for the bodies this tool did not build — a
 * device readback, or a patch assembled by a future caller. Redaction that
 * depends on validation upstream is redaction that fails the one time it
 * matters.
 */
export function redactPatch(value) {
  if (Array.isArray(value)) return value.map((entry) => redactPatch(entry));
  if (value === null || typeof value !== "object") return value;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_FIELD_NAMES.includes(key) && typeof entry === "string" && entry.length > 0) {
      output[key] = REDACTED;
    } else if (URL_FIELD_NAMES.includes(key)) {
      output[key] = redactUrlUserinfo(entry);
    } else {
      output[key] = redactPatch(entry);
    }
  }
  return output;
}

/** The exact body that would be sent, safe to print, log, or paste. */
export function renderPatch(patch) {
  return JSON.stringify(redactPatch(patch), null, 2);
}

/**
 * The ONLY place that decides whether bytes reach the device. Read-only is the
 * default: both an explicit --apply and an explicit --serial are required.
 */
export function shouldApplySettingsWrite(options) {
  return (
    options?.apply === true &&
    typeof options?.serial === "string" &&
    options.serial.length > 0
  );
}

/** True when the body carries a credential that must not enter any argv. */
export function patchCarriesSecret(patch) {
  const llm = patch?.llm ?? {};
  return SECRET_FIELD_NAMES.some(
    (field) => typeof llm[field] === "string" && llm[field].length > 0,
  );
}

// ─── status summary ─────────────────────────────────────────────────────────

const CODEX_LOGIN_HELP = Object.freeze({
  signed_out:
    "the codex app-server is reachable but no ChatGPT account is signed in",
  not_configured: "no codex bridge is configured for this server",
  unauthorized: "the codex bridge rejected its access token",
  unreachable: "the codex bridge could not be reached",
  unavailable: "the codex bridge answered but could not report a usable state",
});

/**
 * Turn the three read-only GETs into a verdict plus an explicit missing-list.
 * Pure: every input is already-parsed JSON, so this is unit-testable with no
 * device and no network.
 *
 *   settings    GET /api/settings     (presence-only, runtime/core/src/api.rs:479-526)
 *   health      GET /api/health       (runtime/core/src/api.rs:206-218)
 *   codexStatus GET /api/codex/status (runtime/core/src/api/codex.rs:87-137)
 *
 * `codexStatus` may be null when only the token-free maintenance transport was
 * available — that is reported as unknown, never as fine.
 */
export function summarizeStatus(settings, health, codexStatus) {
  const missing = [];
  const warnings = [];
  const summary = {
    ok: false,
    provider: null,
    model: null,
    mode: null,
    credential: { required: false, present: null, field: null },
    server: null,
    codex: null,
    toolsEnabled: null,
    missing,
    warnings,
  };

  if (health && typeof health === "object") {
    summary.server = {
      status: health.status ?? null,
      name: health.name ?? null,
      version: health.version ?? null,
    };
    if (health.status !== "ok") {
      warnings.push({
        id: "health_not_ok",
        detail: `GET /api/health reported status=${String(health.status)} (expected "ok")`,
      });
    }
  } else {
    warnings.push({
      id: "health_unknown",
      detail: "server health was not read (the admin token is needed for GET /api/health)",
    });
  }

  const llm = settings?.llm ?? null;
  if (llm === null || typeof llm !== "object") {
    missing.push({
      id: "settings_unavailable",
      detail: "GET /api/settings returned no llm object, so nothing about the provider is known",
      remedy: "confirm the Server is installed and running, then re-run status",
    });
    return summary;
  }

  summary.provider = llm.provider ?? null;
  summary.toolsEnabled = llm.tools?.enabled ?? null;
  if (llm.tools?.enabled === false) {
    warnings.push({
      id: "tools_disabled",
      detail:
        "llm.tools.enabled is FALSE — the stock path runs, not the agentic one, so a passing probe does not exercise the tool loop",
    });
  }

  if (llm.provider === "echo") {
    // Echo is the one provider that cannot drive the agentic runtime
    // (runtime/core/src/config.rs:142-144).
    summary.mode = "echo";
    missing.push({
      id: "provider_echo",
      detail: "provider is `echo`, a plumbing stub that cannot answer anything",
      remedy: `${PROGRAM} set-provider --provider <choice> ... (see --help)`,
    });
    return summary;
  }

  if (llm.provider === "codex") {
    const customActive = llm.codex_custom_active === true;
    summary.mode = customActive ? "codex-custom" : "codex-chatgpt";
    summary.model = customActive ? (llm.codex_model ?? null) : (llm.model ?? null);
    summary.credential = {
      required: true,
      present: customActive ? true : null,
      field: customActive ? "llm.codex.api_key / api_key_env" : "ChatGPT account (no settings field)",
    };
    if (customActive) {
      if (!summary.model) {
        missing.push({
          id: "codex_model_missing",
          detail: "the custom codex provider is active but codex_model is empty",
          remedy: `${PROGRAM} set-provider --provider codex-custom --codex-base-url URL --codex-model ID`,
        });
      }
    } else {
      // Native ChatGPT mode: the credential lives in the codex account record,
      // never in settings, so only /api/codex/status can answer this.
      const state = codexStatus?.state ?? null;
      summary.codex = codexStatus
        ? {
            state,
            ready: codexStatus.ready === true,
            loginPending: codexStatus.login_pending === true,
            loginMode: codexStatus.login_mode ?? null,
          }
        : null;
      if (codexStatus === null || codexStatus === undefined) {
        missing.push({
          id: "codex_status_unknown",
          detail:
            "provider is codex/ChatGPT but GET /api/codex/status was not read, so the sign-in state is unknown",
          remedy:
            "re-run status with a readable admin token file so /api/codex/status can be queried",
        });
      } else if (state !== "ready") {
        // The state was read and it is not ready: that is a known-absent
        // credential, not an unknown one.
        summary.credential.present = false;
        missing.push({
          id: "codex_login_required",
          detail: `codex sign-in state is "${String(state)}"${
            CODEX_LOGIN_HELP[state] ? ` — ${CODEX_LOGIN_HELP[state]}` : ""
          }`,
          remedy: codexLoginInstructions(),
        });
      } else {
        summary.credential.present = true;
      }
      if (!summary.model) {
        missing.push({
          id: "model_missing",
          detail: "llm.model is empty, so no ChatGPT model id is selected",
          remedy: `${PROGRAM} set-provider --provider codex-chatgpt --model <chatgpt-model-id>`,
        });
      }
    }
    return finish(summary);
  }

  // Direct rig providers: gemini / anthropic / openai / openai-compatible.
  summary.mode = "direct";
  summary.model = llm.model ?? null;
  summary.credential = {
    required: true,
    present: llm.has_api_key === true,
    field: "llm.api_key (or the provider env var)",
  };
  if (!summary.model) {
    missing.push({
      id: "model_missing",
      detail: "llm.model is empty",
      remedy: `${PROGRAM} set-provider --provider ${String(llm.provider)} --model <model-id>`,
    });
  }
  if (llm.has_api_key !== true) {
    missing.push({
      id: "api_key_missing",
      detail: `no API key resolves for provider ${String(llm.provider)} (has_api_key is false)`,
      remedy: `export the key, then: ${PROGRAM} set-provider --provider ${String(llm.provider)} --model <model-id> --apply --serial <serial>`,
    });
  }
  if (
    llm.provider === "openai-compatible" &&
    (typeof llm.base_url !== "string" || llm.base_url.trim().length === 0)
  ) {
    missing.push({
      id: "base_url_missing",
      detail:
        "provider is openai-compatible but base_url is empty, so requests silently go to the default OpenAI endpoint",
      remedy: `${PROGRAM} set-provider --provider openai-compatible --model <id> --base-url <url>`,
    });
  }
  return finish(summary);
}

function finish(summary) {
  summary.ok = summary.missing.length === 0;
  return summary;
}

export function codexLoginInstructions() {
  // Deliberately instructions, not automation: the browser step is the
  // operator's (runtime/core/src/api/codex.rs:140-167, :278-310 pins the
  // verification host to auth.openai.com).
  return [
    "this tool cannot sign in for you — the browser step is yours:",
    "  1. start the device-code login on the Pin:",
    "     POST /api/codex/login/device-code  (returns verification_url + user_code)",
    "  2. open that URL in a browser, enter the code, approve the ChatGPT account",
    `  3. re-run: node platform/deploy/acceptance/pin/${PROGRAM}.mjs status --serial <serial>  (expect state=ready)`,
  ].join("\n");
}

export function formatStatusLines(summary, extra = {}) {
  const lines = [];
  lines.push("first-run status");
  if (extra.transport) lines.push(`  read via         : ${extra.transport}`);
  if (summary.server) {
    lines.push(
      `  server           : ${summary.server.name ?? "?"} ${summary.server.version ?? "?"} (status=${summary.server.status ?? "?"})`,
    );
  } else {
    lines.push("  server           : not read");
  }
  lines.push(`  provider         : ${summary.provider ?? "?"}`);
  lines.push(`  mode             : ${summary.mode ?? "?"}`);
  lines.push(`  model            : ${summary.model ?? "(none)"}`);
  lines.push(
    `  credential       : ${
      summary.credential.required === false
        ? "not required"
        : summary.credential.present === true
          ? `present (${summary.credential.field})`
          : summary.credential.present === false
            ? `MISSING (${summary.credential.field})`
            : `unknown (${summary.credential.field})`
    }`,
  );
  lines.push(`  llm.tools.enabled: ${summary.toolsEnabled ?? "?"}`);
  if (summary.codex) {
    lines.push(
      `  codex sign-in    : state=${summary.codex.state} ready=${summary.codex.ready} pending=${summary.codex.loginPending}`,
    );
  }
  for (const warning of summary.warnings) lines.push(`  WARN  ${warning.detail}`);
  if (summary.missing.length === 0) {
    lines.push("");
    lines.push("  nothing missing. Confirm it actually answers:");
    lines.push(`    node platform/deploy/acceptance/pin/${PROGRAM}.mjs verify --serial <serial>`);
  } else {
    lines.push("");
    lines.push(`  MISSING (${summary.missing.length}):`);
    for (const item of summary.missing) {
      lines.push(`   - ${item.id}: ${item.detail}`);
      for (const remedyLine of String(item.remedy ?? "").split("\n")) {
        if (remedyLine.length > 0) lines.push(`     ${remedyLine}`);
      }
    }
  }
  lines.push("");
  lines.push("  settings presence is not proof: a key can be present and invalid.");
  lines.push("  Only `verify` judges a real answer.");
  return lines;
}

// ─── maintenance-provider encoding (ADB, no admin token) ────────────────────

/**
 * base64url, unpadded — the exact alphabet and length rule the device provider
 * enforces (UsbMaintenanceProvider.kt:404-407: letters/digits/`-`/`_` only, and
 * `length % 4 != 1`).
 */
export function encodeMaintenanceUpdateArg(patch) {
  const json = typeof patch === "string" ? patch : JSON.stringify(patch);
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) {
    throw new ConfigureError("the settings body could not be encoded for the maintenance provider");
  }
  return encoded;
}

function extractBalancedJson(text, start) {
  if (text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return { json: text.slice(start, index + 1), end: index + 1 };
    }
  }
  return null;
}

/**
 * Parse `content call` output: `Result: Bundle[{status=200, ok=true, body={...}}]`
 * (bundle keys from UsbMaintenanceProvider.kt:353-357). The body is pulled out
 * by brace balancing FIRST, so a `status=` inside the JSON cannot be mistaken
 * for the bundle's own status.
 */
export function parseMaintenanceBundle(value) {
  const text = (Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "")).trim();
  if (!/^Result:\s*Bundle\[\{/.test(text)) return null;
  let scan = text;
  let bodyText = null;
  const bodyIndex = text.indexOf("body=");
  if (bodyIndex >= 0) {
    const extracted = extractBalancedJson(text, bodyIndex + "body=".length);
    if (extracted !== null) {
      bodyText = extracted.json;
      scan = text.slice(0, bodyIndex) + text.slice(extracted.end);
    }
  }
  const statusMatch = /(?:[[{,]\s*)status=(\d{1,3})(?=\s*[,\]}])/.exec(scan);
  const okMatch = /(?:[[{,]\s*)ok=(true|false)(?=\s*[,\]}])/.exec(scan);
  let body = null;
  if (bodyText !== null) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = null;
    }
  }
  return {
    status: statusMatch === null ? null : Number(statusMatch[1]),
    ok: okMatch === null ? null : okMatch[1] === "true",
    body,
    bodyText,
  };
}

// ─── credential resolution (never argv, never printed) ──────────────────────

export function resolveSecretSource(choice, options) {
  const spec = PROVIDER_CHOICES[choice];
  if (spec === undefined || spec.secret === null) return null;
  if (options.apiKeyFile !== undefined) return { kind: "file", path: options.apiKeyFile };
  return { kind: "env", name: options.apiKeyEnv ?? spec.secret.defaultEnv };
}

async function readSecretFile(path) {
  if (!isAbsolute(path)) {
    throw new ConfigureError("--api-key-file must be an absolute path");
  }
  const resolved = resolve(path);
  let handle = null;
  let bytes = null;
  try {
    handle = await open(resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new ConfigureError("--api-key-file must be a regular file");
    }
    // Same fail-closed permission rule the admin-token reader uses
    // (platform/deploy/acceptance/pin/agentic-release-smoke.mjs:325-334).
    if ((metadata.mode & 0o077) !== 0) {
      throw new ConfigureError(
        `--api-key-file is group/world readable; run: chmod 600 ${resolved}`,
      );
    }
    if (metadata.size === 0 || metadata.size > MAX_SECRET_FILE_BYTES) {
      throw new ConfigureError("--api-key-file is empty or implausibly large");
    }
    bytes = await handle.readFile();
  } catch (error) {
    if (error instanceof ConfigureError) throw error;
    throw new ConfigureError("--api-key-file is missing or unreadable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  try {
    const key = bytes.toString("utf8").replace(/\r?\n$/, "").trim();
    if (key.length === 0) throw new ConfigureError("--api-key-file contained no key");
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(key)) {
      throw new ConfigureError("--api-key-file contained control characters");
    }
    return key;
  } finally {
    bytes.fill(0);
  }
}

async function resolveSecret(source, environment) {
  if (source === null) return null;
  if (source.kind === "env") {
    const raw = environment?.[source.name];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new ConfigureError(
        `no API key in $${source.name}. Export it (never pass a key as a CLI argument) or use --api-key-file PATH`,
      );
    }
    return raw.trim();
  }
  return readSecretFile(source.path);
}

export function describeSecretSource(source) {
  if (source === null) return "none (this provider carries no credential in settings)";
  return source.kind === "env" ? `environment variable $${source.name}` : `file ${source.path}`;
}

// ─── device I/O ─────────────────────────────────────────────────────────────

async function assertDeviceReady(options, spawn) {
  const state = await runAdb(
    options,
    ["get-state"],
    { timeoutMs: 10_000, maxStdoutBytes: 128 },
    "the explicitly selected ADB device is not ready",
    spawn,
  );
  if (state.toString("utf8").trim() !== "device") {
    throw new ConfigureError("the explicitly selected ADB device is not ready");
  }
}

async function maintenanceCall(options, method, arg, spawn) {
  const args = [
    "shell",
    "content",
    "call",
    "--user",
    "0",
    "--uri",
    MAINTENANCE_URI,
    "--method",
    method,
  ];
  if (arg !== null) args.push("--arg", arg);
  const output = await runAdb(
    options,
    args,
    { timeoutMs: 60_000, maxStdoutBytes: MAX_MAINTENANCE_OUTPUT_BYTES },
    `the maintenance ${method} call failed`,
    spawn,
  );
  const parsed = parseMaintenanceBundle(output);
  if (parsed === null) {
    throw new ConfigureError(`the maintenance ${method} call returned an unrecognised result`);
  }
  return parsed;
}

/**
 * A fresh, unpredictable path for the one file that ever holds the key on the
 * device. Hex only, so nothing in the name can be read as a shell
 * metacharacter by the `adb shell` command line it is interpolated into.
 */
export function newStagedBodyPath(random = randomBytes) {
  const suffix = random(STAGED_BODY_NAME_BYTES).toString("hex");
  return `${STAGED_BODY_DIRECTORY}/revival-pin-configure-${suffix}.json`;
}

function settingsPutCurlConfig(token, maxSeconds, bodyPath) {
  // One fixed endpoint, so there is no caller-controlled path to allowlist.
  // The token travels through curl's stdin config, never argv — the same
  // reason platform/deploy/acceptance/pin/pinbox/shared/admin-http.mjs:20-40 does it this way.
  return Buffer.from(
    [
      `url = "${ADMIN_HTTP_ORIGIN}${SETTINGS_PATH}"`,
      'request = "PUT"',
      `header = "Authorization: Bearer ${token}"`,
      'header = "Content-Type: application/json"',
      'header = "Accept: application/json"',
      `header = "User-Agent: ${PROGRAM}/1"`,
      "silent",
      "show-error",
      "connect-timeout = 5",
      `max-time = ${Math.max(1, Math.min(60, Math.floor(maxSeconds)))}`,
      'noproxy = "*"',
      'proto = "=http"',
      `data-binary = "@${bodyPath}"`,
      `write-out = "${HTTP_STATUS_MARKER.replace("\n", "\\n")}%{http_code}\\n"`,
      "",
    ].join("\n"),
    "utf8",
  );
}

export async function putSettingsOverAdminHttp(options, token, patch, spawn) {
  const body = Buffer.from(JSON.stringify(patch), "utf8");
  // Named once, up here, so the `finally` removes the SAME path that was
  // staged even if the push threw halfway through.
  const bodyPath = newStagedBodyPath();
  // `adb push` takes a HOST PATH, not stdin. Pushing `/dev/stdin` makes adb
  // treat the shell's FIFO as a special file: it prints
  // `skipping special file '/dev/stdin' (mode = 0o10440)` and still **exits 0**,
  // so nothing lands on the device and the first honest symptom is the chmod
  // below failing with ENOENT — an error that blames permissions for a missing
  // file. Stage the body in an owner-only host temp file and push that instead.
  const hostStageDirectory = await mkdtemp(join(tmpdir(), "revival-pin-configure-"));
  const hostBodyPath = join(hostStageDirectory, "settings.json");
  try {
    // 0600 before the bytes exist anywhere readable: the host copy holds the
    // same live credential the device copy does.
    await writeFile(hostBodyPath, body, { mode: 0o600 });
    await runAdb(
      options,
      ["push", hostBodyPath, bodyPath],
      { timeoutMs: 15_000, maxStdoutBytes: 4 * 1024 },
      "the settings body could not be staged on the device",
      spawn,
    );
    // `adb push` reports success for a file it declined to transfer, so prove
    // the device actually has it rather than trusting the exit code.
    await runAdb(
      options,
      ["shell", "test", "-f", bodyPath],
      { timeoutMs: 10_000, maxStdoutBytes: 1024 },
      "the settings body did not arrive on the device",
      spawn,
    );
    // `adb push` lands 0644. Narrow it before the PUT, and fail closed if that
    // does not work: a world-readable file holding an API key is not something
    // to proceed past because the next step would probably have worked.
    await runAdb(
      options,
      ["shell", "chmod", "600", bodyPath],
      { timeoutMs: 10_000, maxStdoutBytes: 1024 },
      "the staged settings body could not be made owner-only",
      spawn,
    );
    const output = await runAdb(
      options,
      ["shell", "exec curl -q -K -"],
      {
        input: settingsPutCurlConfig(token, 45, bodyPath),
        timeoutMs: 60_000,
        maxStdoutBytes: 1024 * 1024,
      },
      "the settings PUT failed",
      spawn,
    );
    const marker = Buffer.from(HTTP_STATUS_MARKER, "utf8");
    const markerIndex = output.lastIndexOf(marker);
    if (markerIndex < 0) throw new ConfigureError("the settings PUT returned no HTTP status");
    const statusText = output.subarray(markerIndex + marker.length).toString("ascii").trim();
    if (!/^[0-9]{3}$/.test(statusText)) {
      throw new ConfigureError("the settings PUT returned an invalid HTTP status");
    }
    return {
      status: Number(statusText),
      bodyText: output.subarray(0, markerIndex).toString("utf8").trim(),
    };
  } finally {
    body.fill(0);
    // The host copy carries the same credential as the device copy, so it gets
    // the same unconditional, failure-swallowing removal.
    await rm(hostStageDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    // Unconditional, and deliberately last: every early exit above — a failed
    // chmod, a failed PUT, a non-200, a malformed status line — is a path that
    // would otherwise leave a live credential sitting in shared scratch space.
    // A removal that itself fails is swallowed because rethrowing here would
    // replace the real error with a cleanup error; that residual risk is what
    // the unpredictable name and the 0600 mode are for.
    await runAdb(
      options,
      ["shell", "rm", "-f", bodyPath],
      { timeoutMs: 10_000, maxStdoutBytes: 1024 },
      "the staged settings body could not be removed",
      spawn,
    ).catch(() => undefined);
  }
}

// Read settings (+ health + codex status when a token exists). Returns the raw
// JSON documents plus which transport answered, so the caller can be honest
// about what it does NOT know.
async function readCurrentState(options, spawn) {
  await assertDeviceReady(options, spawn);
  let token = null;
  let tokenError = null;
  try {
    const { readAdminToken } = await import("./agentic-release-smoke.mjs");
    token = await readAdminToken();
  } catch (error) {
    tokenError = String(error?.message ?? error);
  }
  if (token !== null) {
    // collectReadiness is all-or-nothing: it also demands /api/spotify/status
    // and /api/feature-flags (platform/deploy/acceptance/pin/agentic-release-smoke.mjs:443-457). On a
    // first run one of those can legitimately be unhappy, and a configure
    // helper must not go blind because an unrelated endpoint did. Fall back to
    // the token-free settings read and say so rather than reporting nothing.
    try {
      const { collectReadiness } = await import("./agentic-release-smoke.mjs");
      const readiness = await collectReadiness(options, token);
      return {
        transport: "admin HTTP over adb (admin token)",
        settings: readiness.settings,
        health: readiness.health,
        codexStatus: readiness.codex,
        token,
        tokenError: null,
      };
    } catch (error) {
      tokenError = `the admin-token read failed: ${String(error?.message ?? error)}`;
    }
  }
  const result = await maintenanceCall(options, "GET", null, spawn);
  if (result.ok !== true || result.body === null) {
    throw new ConfigureError(
      `the maintenance settings read returned status ${String(result.status)}`,
    );
  }
  return {
    transport: "UID-gated maintenance provider (no admin token)",
    settings: result.body,
    health: null,
    codexStatus: null,
    token: null,
    tokenError,
  };
}

// ─── commands ───────────────────────────────────────────────────────────────

async function commandStatus(options, runtime) {
  const { out } = runtime;
  const adbOptions = { serial: options.serial, adbPath: options.adb };
  const state = await readCurrentState(adbOptions, runtime.spawn);
  const summary = summarizeStatus(state.settings, state.health, state.codexStatus);
  if (options.json) {
    out(`${JSON.stringify({ transport: state.transport, summary }, null, 2)}\n`);
  } else {
    const lines = formatStatusLines(summary, { transport: state.transport });
    if (state.tokenError !== null) {
      lines.push("");
      lines.push(`  note: no admin token was readable (${state.tokenError}).`);
      lines.push("  Health and codex sign-in state cannot be read without it.");
    }
    out(`${lines.join("\n")}\n`);
  }
  return summary.ok ? 0 : 1;
}

async function commandSetProvider(options, runtime) {
  const { out, err } = runtime;
  const source = resolveSecretSource(options.provider, options);
  const apiKey = await resolveSecret(source, runtime.environment);
  const patch = buildProviderPatch(options.provider, { ...options, apiKey });
  const rendered = renderPatch(patch);
  const spec = PROVIDER_CHOICES[options.provider];

  const preface = [
    `provider choice   : ${options.provider} (llm.provider = "${spec.provider}")`,
    `credential source : ${describeSecretSource(source)}`,
    "",
    `PUT ${SETTINGS_PATH}`,
    rendered,
    "",
  ];

  if (!shouldApplySettingsWrite(options)) {
    preface.push("DRY RUN — nothing was written. This tool is read-only by default.");
    preface.push(
      `To send it: node platform/deploy/acceptance/pin/${PROGRAM}.mjs set-provider --provider ${options.provider} ... --apply --serial <serial>`,
    );
    if (spec.interactiveLogin) {
      preface.push("");
      preface.push("Settings alone will not make this provider answer — it also needs an");
      preface.push("interactive ChatGPT sign-in:");
      preface.push(codexLoginInstructions());
    }
    if (options.json) {
      out(
        `${JSON.stringify(
          {
            applied: false,
            patch: redactPatch(patch),
            credentialSource: describeSecretSource(source),
            interactiveLoginRequired: spec.interactiveLogin === true,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      out(`${preface.join("\n")}\n`);
    }
    return 0;
  }

  const adbOptions = { serial: options.serial, adbPath: options.adb };
  await assertDeviceReady(adbOptions, runtime.spawn);

  let token = null;
  try {
    const { readAdminToken } = await import("./agentic-release-smoke.mjs");
    token = await readAdminToken();
  } catch {
    token = null;
  }

  let result;
  if (token !== null) {
    const response = await putSettingsOverAdminHttp(adbOptions, token, patch, runtime.spawn);
    if (response.status !== 200) {
      err(`${PROGRAM}: the settings PUT returned HTTP ${response.status}\n`);
      if (response.bodyText.length > 0) err(`${response.bodyText.slice(0, 500)}\n`);
      return 1;
    }
    result = { transport: "admin HTTP over adb", status: response.status };
  } else {
    if (patchCarriesSecret(patch) && options.allowArgvSecret !== true) {
      err(
        [
          `${PROGRAM}: refusing to send a credential through the maintenance provider.`,
          "",
          "  No admin token was readable, so the only write path left is",
          "  `adb shell content call --arg <base64url-body>` — and that body,",
          "  including the API key, is visible in the host AND device process",
          "  tables for the duration of the call.",
          "",
          "  Either make the admin token readable (default .secrets/pin-admin-token,",
          "  mode 600) so the body can be staged as a file instead, or accept the",
          "  exposure explicitly with --allow-argv-secret.",
          "",
        ].join("\n"),
      );
      return 1;
    }
    const encoded = encodeMaintenanceUpdateArg(patch);
    const response = await maintenanceCall(adbOptions, "PUT", encoded, runtime.spawn);
    if (response.ok !== true) {
      err(`${PROGRAM}: the maintenance PUT returned status ${String(response.status)}\n`);
      return 1;
    }
    result = { transport: "maintenance provider", status: response.status };
  }

  const after = [
    `applied via ${result.transport} (HTTP ${result.status})`,
    "",
    "An llm settings change rebuilds the providers live — no restart is needed",
    "(runtime/core/src/api.rs:1564-1581). A `restart_required` in the response",
    "refers only to the LAN dashboard listener (runtime/core/src/api.rs:619-621).",
    "",
    "Next, and this is the only step that proves anything:",
    `  node platform/deploy/acceptance/pin/${PROGRAM}.mjs verify --serial ${options.serial}`,
  ];
  if (spec.interactiveLogin) {
    after.push("");
    after.push("This provider still needs an interactive ChatGPT sign-in:");
    after.push(codexLoginInstructions());
  }
  if (options.json) {
    out(`${JSON.stringify({ applied: true, ...result, patch: redactPatch(patch) }, null, 2)}\n`);
  } else {
    out(`${after.join("\n")}\n`);
  }
  return 0;
}

/**
 * The verify report, as a pure function of the decoded frames.
 *
 * Split out of `commandVerify` so the one judgement this command exists to get
 * right is reachable without a device — the previous shape put the extraction
 * and the verdict inline, where no test could reach them and both blind spots
 * lived undisturbed.
 *
 * Frames and action names come from `summarizeResponses`; the verdict is built
 * from `extractAnswer` directly. That helper USED to be unusable here: it read
 * `answer ?? text ?? speech` — keys no decoded frame carries — and kept the
 * LONGEST single frame, while the spoken answer is `JSON.parse(input).Response`
 * on the LAST `action: "Respond"` frame and is frequently the SHORTEST string in
 * the turn (measured min/median/max = 4/42/93 characters; "Paris." is 6). It has
 * since been fixed to delegate to `extractAnswer`, so its `answer` now agrees
 * with this function. Calling `extractAnswer` here regardless is deliberate: the
 * classification wants the extraction STATUS, not just the text, and one
 * extractor with one contract is what keeps the two from drifting apart again.
 */
export function buildVerifyReport({ prompt, elapsedMs, responses, probeError = null }) {
  const summary = summarizeResponses(responses);
  const extraction = extractAnswer(responses);
  const verdict =
    probeError !== null
      ? {
          ok: false,
          verdict: "transport",
          reason: `the probe did not complete: ${probeError}`,
          matched: null,
          chars: 0,
        }
      : classifyProbeExtraction(extraction);
  return {
    prompt,
    elapsedMs,
    frames: summary.frames,
    actions: summary.actions,
    answerStatus: probeError === null ? extraction.status : "probe-failed",
    answerPreview: String(extraction.text ?? "").slice(0, MAX_ANSWER_CHARS_STDOUT),
    verdict,
  };
}

/**
 * Render a verify report. Pure, and separate from `commandVerify` for the same
 * reason `formatStatusLines` is: the command itself cannot run without a
 * device, so anything left inline in it is unreachable by every test in this
 * tree — which is how the elapsed-time caveat and the PASS/FAIL line would go
 * unchecked.
 */
export function formatVerifyLines(report, extra = {}) {
  const { verdict } = report;
  return [
    "verify",
    `  prompt   : ${report.prompt}`,
    `  frames   : ${report.frames}`,
    `  actions  : ${report.actions.length === 0 ? "(none)" : report.actions.join(", ")}`,
    `  answer   : ${report.answerPreview.length === 0 ? "(empty)" : report.answerPreview}`,
    `  extracted: ${report.answerStatus} (the LAST action:"Respond" frame wins)`,
    `  elapsed  : ${report.elapsedMs} ms  (informational only — NOT a success signal;`,
    "             a failing backend declines FASTER than a real answer returns)",
    "",
    `  RESULT   : ${verdict.ok ? "PASS — a real answer came back" : "FAIL"}`,
    `             ${verdict.reason}`,
    ...(verdict.matched === null ? [] : [`             matched: ${verdict.matched}`]),
    ...(verdict.ok
      ? []
      : ["", `  Next: node platform/deploy/acceptance/pin/${PROGRAM}.mjs status --serial ${extra.serial ?? "<serial>"}`]),
  ];
}

async function commandVerify(options, runtime) {
  const { out } = runtime;
  const adbOptions = { serial: options.serial, adbPath: options.adb };
  await assertDeviceReady(adbOptions, runtime.spawn);
  const { readAdminToken, verifyExplicitDevice, runUnderstand } = await import(
    "./agentic-release-smoke.mjs"
  );
  const token = await readAdminToken();
  await verifyExplicitDevice(adbOptions);

  // The Understand RPC returns planned actions as DATA; nothing is dispatched
  // (that needs the separate stock-action-test endpoint — see
  // platform/deploy/acceptance/pin/pinbox/commands/probe.mjs:10-13). So this stays read-only.
  const startedAt = runtime.now();
  let responses = null;
  let probeError = null;
  try {
    responses = await runUnderstand(adbOptions, AIBUS_DEVICE_PORT, options.prompt, {
      timeoutMs: options.timeoutMs,
      userTurnId: `configure-verify-${startedAt}`,
      excludedTools: [],
      authToken: token,
    });
  } catch (error) {
    probeError = String(error?.message ?? error);
  }
  const elapsedMs = runtime.now() - startedAt;

  const report = buildVerifyReport({
    prompt: options.prompt,
    elapsedMs,
    responses,
    probeError,
  });
  if (options.json) {
    out(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    out(`${formatVerifyLines(report, { serial: options.serial }).join("\n")}\n`);
  }
  return report.verdict.ok ? 0 : 1;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

export function usage() {
  return [
    `Usage: node platform/deploy/acceptance/pin/${PROGRAM}.mjs <command> [options]`,
    "",
    "Commands:",
    "  status         Read provider/model/credential/health/codex sign-in state and",
    "                 print what is still missing. Always read-only.",
    "  set-provider   Print (and, with --apply, send) the minimal settings PUT.",
    "  verify         Send one real turn and judge the ANSWER, not the latency.",
    "",
    "Common options:",
    "  --serial S           ADB serial (required for status/verify, and for any write)",
    "  --adb PATH           adb binary (default: adb)",
    "  --token-file PATH    admin token file (default: <repo>/.secrets/pin-admin-token)",
    "  --json               machine-readable output",
    "  --help",
    "",
    "set-provider options:",
    "  --provider CHOICE    one of:",
    ...Object.entries(PROVIDER_CHOICES).map(
      ([name, spec]) => `      ${name.padEnd(18)} ${spec.summary}`,
    ),
    "  --model ID           model id (codex-chatgpt / openai / anthropic / gemini /",
    "                       openai-compatible)",
    "  --base-url URL       required for openai-compatible; HTTPS, or http only",
    "                       for a loopback host. Never with credentials in it.",
    "  --codex-base-url URL HTTPS endpoint for codex-custom",
    "  --codex-model ID     model id for codex-custom",
    `  --codex-provider-name NAME   default: ${DEFAULT_CODEX_PROVIDER_NAME}`,
    `  --codex-wire-api WIRE        default: ${DEFAULT_CODEX_WIRE_API}`,
    "  --api-key-env NAME   read the key from this env var (provider default applies)",
    "  --api-key-file PATH  read the key from this mode-600 absolute path",
    "  --enable-tools       also set llm.tools.enabled = true",
    "  --clear-codex-custom (codex-chatgpt only) clear a leftover custom codex block",
    "  --apply              actually write (requires --serial). WITHOUT IT: dry run.",
    "  --allow-argv-secret  permit a credential in the maintenance-provider argv",
    "",
    "verify options:",
    `  --prompt TEXT        default: ${JSON.stringify(DEFAULT_VERIFY_PROMPT)}`,
    `  --timeout-ms N       default: ${DEFAULT_VERIFY_TIMEOUT_MS}`,
    "",
    "There is deliberately no --api-key flag: a key on the command line lands in",
    "shell history and in every process listing. Use --api-key-env or --api-key-file.",
    "",
    "Exit codes: 0 success, 1 honest negative or runtime failure, 2 usage error.",
  ].join("\n");
}

const COMMANDS = new Set(["status", "set-provider", "verify"]);

export const REFUSED_API_KEY_ARGUMENT =
  "refusing --api-key: a key on the command line lands in shell history and in every process listing. Use --api-key-env NAME or --api-key-file PATH.";

export function parseCliArgs(argv, environment = process.env) {
  const options = {
    command: null,
    serial: null,
    adb: "adb",
    json: false,
    apply: false,
    help: false,
    provider: null,
    model: undefined,
    baseUrl: undefined,
    codexBaseUrl: undefined,
    codexModel: undefined,
    codexProviderName: undefined,
    codexWireApi: undefined,
    apiKeyEnv: undefined,
    apiKeyFile: undefined,
    enableTools: false,
    clearCodexCustom: false,
    allowArgvSecret: false,
    tokenFile: undefined,
    prompt: DEFAULT_VERIFY_PROMPT,
    timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
  };

  const takeValue = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.includes("\0")) {
      throw new UsageError(`${flag} requires a value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (index === 0 && COMMANDS.has(arg)) {
      options.command = arg;
      continue;
    }
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--serial":
        options.serial = takeValue(index, arg);
        index += 1;
        break;
      case "--adb":
        options.adb = takeValue(index, arg);
        index += 1;
        break;
      case "--token-file":
        options.tokenFile = takeValue(index, arg);
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--apply":
        options.apply = true;
        break;
      case "--provider":
        options.provider = takeValue(index, arg);
        index += 1;
        break;
      case "--model":
        options.model = takeValue(index, arg);
        index += 1;
        break;
      case "--base-url":
        options.baseUrl = takeValue(index, arg);
        index += 1;
        break;
      case "--codex-base-url":
        options.codexBaseUrl = takeValue(index, arg);
        index += 1;
        break;
      case "--codex-model":
        options.codexModel = takeValue(index, arg);
        index += 1;
        break;
      case "--codex-provider-name":
        options.codexProviderName = takeValue(index, arg);
        index += 1;
        break;
      case "--codex-wire-api":
        options.codexWireApi = takeValue(index, arg);
        index += 1;
        break;
      case "--api-key-env":
        options.apiKeyEnv = takeValue(index, arg);
        index += 1;
        break;
      case "--api-key-file":
        options.apiKeyFile = takeValue(index, arg);
        index += 1;
        break;
      case "--enable-tools":
        options.enableTools = true;
        break;
      case "--clear-codex-custom":
        options.clearCodexCustom = true;
        break;
      case "--allow-argv-secret":
        options.allowArgvSecret = true;
        break;
      case "--prompt":
        options.prompt = takeValue(index, arg);
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(takeValue(index, arg));
        index += 1;
        break;
      case "--api-key":
        throw new UsageError(REFUSED_API_KEY_ARGUMENT);
      default:
        // `--api-key=sk-...` never reaches the case above.
        if (arg.startsWith("--api-key=")) throw new UsageError(REFUSED_API_KEY_ARGUMENT);
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }

  if (options.help) return options;
  if (options.command === null) throw new UsageError("a command is required");
  if (options.command === "status" || options.command === "verify") {
    if (options.serial === null) throw new UsageError(`${options.command} requires --serial`);
  }
  if (options.command === "set-provider") {
    if (options.provider === null) throw new UsageError("set-provider requires --provider");
    if (PROVIDER_CHOICES[options.provider] === undefined) {
      throw new UsageError(
        `unknown --provider ${options.provider} (expected one of ${Object.keys(PROVIDER_CHOICES).join(", ")})`,
      );
    }
    if (options.apply && options.serial === null) {
      throw new UsageError("--apply requires --serial (a write must name its device)");
    }
    if (options.apiKeyEnv !== undefined && options.apiKeyFile !== undefined) {
      throw new UsageError("choose either --api-key-env or --api-key-file, not both");
    }
  }
  if (options.command === "verify") {
    if (
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 5_000 ||
      options.timeoutMs > 300_000
    ) {
      throw new UsageError("--timeout-ms must be an integer between 5000 and 300000");
    }
  }
  if (options.tokenFile !== undefined && !isAbsolute(options.tokenFile)) {
    throw new UsageError("--token-file must be an absolute path");
  }
  return options;
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  const out = runtime.out ?? ((text) => process.stdout.write(text));
  const err = runtime.err ?? ((text) => process.stderr.write(text));
  const environment = runtime.environment ?? process.env;
  const now = runtime.now ?? (() => Date.now());
  const context = { out, err, environment, now, spawn: runtime.spawn };

  let options;
  try {
    options = parseCliArgs(argv, environment);
  } catch (error) {
    err(`${PROGRAM}: ${error.message}\n`);
    err(`${usage()}\n`);
    return 2;
  }
  if (options.help || options.command === null) {
    out(`${usage()}\n`);
    return options.help ? 0 : 2;
  }
  if (options.tokenFile !== undefined) {
    // readAdminToken() reads process.env directly, so the override has to land
    // there — the same thing the pinbox dispatcher does
    // (platform/deploy/acceptance/pin/pinbox/commands/readiness.mjs:21-23).
    process.env.PENUMBRA_PIN_ADMIN_TOKEN_FILE = options.tokenFile;
  }

  try {
    if (options.command === "status") return await commandStatus(options, context);
    if (options.command === "set-provider") return await commandSetProvider(options, context);
    return await commandVerify(options, context);
  } catch (error) {
    if (error instanceof UsageError) {
      err(`${PROGRAM}: ${error.message}\n`);
      return 2;
    }
    // Bounded, credential-free failure text only.
    err(`${PROGRAM}: ${String(error?.message ?? error)}\n`);
    return 1;
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = await main();
