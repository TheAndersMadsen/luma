// First-run Pin configuration fixtures; falsifiable with no device attached.
//
// Every assertion here runs against a pure exported function or against
// `main()` on a path that provably performs no device I/O (the dry run). No
// test in this file spawns adb, so a green run cannot be an artefact of a
// happened-to-be-connected Pin — and a red run cannot be blamed on one.
//
// What each group is designed to catch, stated so the guard is falsifiable:
//   * classifyProbeAnswer  — the honest-verification lesson. If someone
//     replaces it with a latency check or a "did anything come back" check,
//     the decline tests go red because those replies are SHORT and PRESENT.
//   * buildProviderPatch   — invented field names. Every emitted key is
//     compared against the documented set from runtime/core/src/api.rs:643-665.
//   * redaction            — a secret reaching stdout. Asserted against the
//     literal fixture string, so any format change that leaks it goes red.
//   * read-only default    — a write happening without --apply.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  ALLOWED_LLM_FIELDS,
  DECLINE_ANSWERS,
  DEFAULT_CODEX_PROVIDER_NAME,
  DEFAULT_CODEX_WIRE_API,
  PROVIDER_CHOICES,
  buildProviderPatch,
  buildVerifyReport,
  classifyProbeAnswer,
  classifyProbeExtraction,
  codexLoginInstructions,
  encodeMaintenanceUpdateArg,
  formatStatusLines,
  formatVerifyLines,
  main,
  newStagedBodyPath,
  parseCliArgs,
  parseMaintenanceBundle,
  patchCarriesSecret,
  putSettingsOverAdminHttp,
  redactPatch,
  redactUrlUserinfo,
  renderPatch,
  resolveSecretSource,
  shouldApplySettingsWrite,
  summarizeStatus,
} from "./configure.mjs";
import { extractAnswer } from "./prompt-suite.mjs";
import { summarizeResponses } from "./pinbox/shared/evidence.mjs";

const FIXTURE_SECRET = "sk-test-DO-NOT-LEAK-0123456789";

function captureRuntime(environment = {}) {
  const stdout = [];
  const stderr = [];
  return {
    runtime: {
      environment,
      out: (text) => stdout.push(text),
      err: (text) => stderr.push(text),
      now: () => 1_000,
      // Any device call would need this; leaving it as a throwing stub means a
      // regression that reaches adb fails loudly instead of silently passing.
      spawn: () => {
        throw new Error("this test must never spawn a child process");
      },
    },
    stdout,
    stderr,
    text: () => stdout.join("") + stderr.join(""),
  };
}

// ─── verification honesty ───────────────────────────────────────────────────

test("classifyProbeAnswer fails a short, fast backend-unavailable style reply", () => {
  // This is the whole point. Observed on an operator-owned Pin: this 37-byte
  // decline arrived faster than a healthy answer. A latency check or a
  // "something came back" check calls this healthy; content does not.
  const result = classifyProbeAnswer("I couldn't complete that request.");
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "decline");
  assert.ok(result.chars < 40, "the failing reply really is short");
});

test("classifyProbeAnswer fails every decline sentence the server can speak", () => {
  for (const sentence of DECLINE_ANSWERS) {
    const result = classifyProbeAnswer(sentence);
    assert.equal(result.ok, false, `should have failed: ${sentence}`);
    assert.equal(result.verdict, "decline");
  }
});

test("classifyProbeAnswer fails an unavailable-style reply regardless of casing or padding", () => {
  const result = classifyProbeAnswer(
    "  The AI Service Is Temporarily Unavailable. Please try again shortly.  ",
  );
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "decline");
});

test("classifyProbeAnswer passes a real answer that is shorter than the failures", () => {
  const real = classifyProbeAnswer("Paris.");
  assert.equal(real.ok, true);
  assert.equal(real.verdict, "answer");
  // Proof the classifier is not using length as a signal: the PASS is shorter
  // than the FAIL asserted above.
  assert.ok(real.chars < classifyProbeAnswer("I couldn't complete that request.").chars);
});

test("classifyProbeAnswer passes a normal long answer", () => {
  const result = classifyProbeAnswer(
    "The capital of France is Paris, which sits on the river Seine in the north of the country.",
  );
  assert.equal(result.ok, true);
});

test("classifyProbeAnswer fails an empty or missing answer", () => {
  for (const value of ["", "   ", null, undefined, 42]) {
    const result = classifyProbeAnswer(value);
    assert.equal(result.ok, false, `should have failed: ${String(value)}`);
    assert.equal(result.verdict, "empty");
  }
});

test("classifyProbeAnswer takes only text, so latency cannot influence it", () => {
  assert.equal(classifyProbeAnswer.length, 1);
});

test("classifyProbeAnswer fails the bridge's own unavailable reply", () => {
  // THE REGRESSION THIS PINS. This sentence is not one of DECLINE_ANSWERS and
  // carries none of DECLINE_MARKERS — those are transcribed from the SERVER,
  // and this one comes from the codex bridge. It is well-formed, it is short,
  // and it was measured arriving in ~4s, faster than a correct answer. Before
  // the imported vocabulary it classified as `answer`, so a dead assistant
  // verified as a fast PASS.
  const result = classifyProbeAnswer("Codex is unavailable on the host. Check its login status.");
  assert.equal(result.ok, false, "an unavailable reply must never read as an answer");
  assert.equal(result.verdict, "decline");

  // The same reply the model actually emits, with the curly apostrophe it
  // really uses.
  assert.equal(classifyProbeAnswer("I can’t help with that right now.").ok, false);
  assert.equal(classifyProbeAnswer("Something went wrong. Please try again later.").ok, false);
});

test("classifyProbeAnswer fails raw tool machinery spoken as an answer", () => {
  const result = classifyProbeAnswer(
    "<tool_call_result>Tool call failed: function not found</tool_call_result>",
  );
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "machinery");
});

// Frames shaped exactly like the decoder emits them
// (agentic-release-smoke-lib.mjs:768-786): `kind`/`action`/`input`, and
// `isFinal` false — it is false on 113/113 real frames, so anything selecting
// the terminal frame by `isFinal` selects nothing.
function respondFrame(text) {
  return {
    kind: "action",
    isFinal: false,
    action: "Respond",
    thought: "",
    input: JSON.stringify({ Response: text }),
  };
}

const LONG_INTERIM =
  "Let me look that up for you — one moment while I check the current details.";

test("the verifier reads the LAST Respond frame, not the longest one", () => {
  const frames = [respondFrame(LONG_INTERIM), respondFrame("Paris.")];

  // The terminal answer is the SHORTEST string in the turn. Measured on this
  // device, min/median/max answer length is 4/42/93 characters, so this is the
  // normal case and not a corner one.
  assert.equal(extractAnswer(frames).text, "Paris.");
  assert.ok("Paris.".length < LONG_INTERIM.length);

  const verdict = classifyProbeExtraction(extractAnswer(frames));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.chars, "Paris.".length, "the judged text is the terminal answer");

  // The shared helper USED to be unable to see that answer at all: it read
  // `answer ?? text ?? speech`, and no decoded frame carries any of the three,
  // so this assertion pinned the broken behaviour to stop anyone reaching for
  // it as "the obvious existing helper". That helper was FIXED (it now
  // delegates to `extractAnswer`), so the pin is inverted rather than deleted:
  // it still guards the same boundary, now asserting the correct contract.
  const shared = summarizeResponses(frames);
  assert.equal(shared.answer, "Paris.", "the shared helper now sees the terminal answer");
  assert.equal(shared.answerStatus, "ok");
  assert.equal(shared.unavailableAnswer, false);
  // Longest-wins is gone too. A frame carrying only a legacy `.answer` key is
  // not a decoded Respond frame at all, so it yields no answer and says why —
  // which is the honest outcome, and is what stops a verbose interim from ever
  // being judged as the terminal answer.
  assert.equal(
    summarizeResponses([{ answer: LONG_INTERIM }, { answer: "Paris." }]).answerStatus,
    "no-respond-frame",
  );
});

test("a fast unavailable reply delivered as a real frame is a FAILURE, not a fast success", () => {
  const frames = [respondFrame("Codex is unavailable on the host. Check its login status.")];
  const verdict = classifyProbeExtraction(extractAnswer(frames));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.verdict, "decline");
});

test("a genuine short answer delivered as a real frame is a SUCCESS", () => {
  const verdict = classifyProbeExtraction(extractAnswer([respondFrame("Paris.")]));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.verdict, "answer");
  // Shorter than the failure above: length is provably not the signal.
  assert.ok(
    verdict.chars <
      classifyProbeExtraction(
        extractAnswer([respondFrame("Codex is unavailable on the host. Check its login status.")]),
      ).chars,
  );
});

test("buildVerifyReport judges the frames `verify` actually receives", () => {
  // The wiring, not just the rule. If this were rebuilt on
  // `summarizeResponses(...).answer` — the obvious existing helper — the first
  // case reports an empty answer and FAILS a working assistant, and the second
  // reports an empty answer too, so the two become indistinguishable.
  const good = buildVerifyReport({
    prompt: "What is the capital of France?",
    elapsedMs: 21_400,
    responses: [respondFrame(LONG_INTERIM), respondFrame("Paris.")],
  });
  assert.equal(good.verdict.ok, true, "a real short answer must PASS");
  assert.equal(good.answerPreview, "Paris.");
  assert.equal(good.answerStatus, "ok");

  const broken = buildVerifyReport({
    prompt: "What is the capital of France?",
    // Faster than the passing run above, on purpose: a fast failure must never
    // read as a fast success.
    elapsedMs: 4_300,
    responses: [respondFrame("Codex is unavailable on the host. Check its login status.")],
  });
  assert.equal(broken.verdict.ok, false, "an unavailable reply must FAIL");
  assert.ok(broken.elapsedMs < good.elapsedMs, "the failing run really is the faster one");

  // A probe that never completed is a failure with its own verdict, not
  // silence.
  const transport = buildVerifyReport({
    prompt: "p",
    elapsedMs: 1,
    responses: null,
    probeError: "the device closed the stream",
  });
  assert.equal(transport.verdict.ok, false);
  assert.equal(transport.verdict.verdict, "transport");
  assert.equal(transport.frames, 0);
});

test("the rendered verify result reports FAIL and refuses to credit the latency", () => {
  const broken = buildVerifyReport({
    prompt: "What is the capital of France?",
    elapsedMs: 4_300,
    responses: [respondFrame("Codex is unavailable on the host. Check its login status.")],
  });
  const lines = formatVerifyLines(broken, { serial: "YOUR_PIN_SERIAL" }).join("\n");
  assert.match(lines, /RESULT {3}: FAIL/);
  assert.equal(/PASS/.test(lines), false, "a failing run must not print the word PASS anywhere");
  // The elapsed number is printed, but never as evidence.
  assert.match(lines, /NOT a success signal/);
  assert.match(lines, /status --serial YOUR_PIN_SERIAL/);

  const good = formatVerifyLines(
    buildVerifyReport({ prompt: "p", elapsedMs: 21_400, responses: [respondFrame("Paris.")] }),
  ).join("\n");
  assert.match(good, /RESULT {3}: PASS/);
  assert.match(good, /answer {3}: Paris\./);
  assert.equal(/FAIL/.test(good), false);
});

test("classifyProbeExtraction fails every non-answer frame shape", () => {
  // No frames at all, and the probe-threw case (`extractAnswer(null)`).
  for (const responses of [null, []]) {
    const verdict = classifyProbeExtraction(extractAnswer(responses));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.verdict, "empty");
  }

  // A device action answered. Correct for "play something"; never an answer to
  // the knowledge question `verify` asks.
  const deviceOnly = classifyProbeExtraction(
    extractAnswer([{ kind: "action", isFinal: false, action: "PlayMusic", thought: "", input: '{"Track":"x"}' }]),
  );
  assert.equal(deviceOnly.ok, false);
  assert.equal(deviceOnly.verdict, "no-answer");

  // A Respond frame whose input is not parseable — a decode defect, not silence.
  const malformed = classifyProbeExtraction(
    extractAnswer([{ kind: "action", isFinal: false, action: "Respond", thought: "", input: "not json" }]),
  );
  assert.equal(malformed.ok, false);
  assert.equal(malformed.verdict, "malformed");

  // An empty Respond string is still an empty answer.
  assert.equal(classifyProbeExtraction(extractAnswer([respondFrame("")])).ok, false);

  // An unknown status must fail closed rather than fall through to "answer".
  assert.equal(classifyProbeExtraction({ status: "something-new", text: "Paris." }).ok, false);
  assert.equal(classifyProbeExtraction(undefined).ok, false);
});

// ─── the PUT body: documented field names only ──────────────────────────────

test("buildProviderPatch emits only documented llm field names", () => {
  const patches = [
    buildProviderPatch("codex-chatgpt", { model: "gpt-5.6-sol" }),
    buildProviderPatch("codex-chatgpt", { model: "gpt-5.6-sol", clearCodexCustom: true }),
    buildProviderPatch("codex-custom", {
      codexBaseUrl: "https://api.example.com/compatible-mode/v1",
      codexModel: "qwen-plus",
      apiKey: FIXTURE_SECRET,
    }),
    buildProviderPatch("openai-compatible", {
      model: "some-model",
      baseUrl: "https://api.example.com/v1",
      apiKey: FIXTURE_SECRET,
    }),
    buildProviderPatch("openai", { model: "gpt-4.1", apiKey: FIXTURE_SECRET, enableTools: true }),
    buildProviderPatch("anthropic", { model: "claude-x", apiKey: FIXTURE_SECRET }),
    buildProviderPatch("gemini", { model: "gemini-x", apiKey: FIXTURE_SECRET }),
  ];
  for (const patch of patches) {
    assert.deepEqual(Object.keys(patch), ["llm"]);
    for (const field of Object.keys(patch.llm)) {
      assert.ok(
        ALLOWED_LLM_FIELDS.includes(field),
        `undocumented settings field emitted: ${field}`,
      );
    }
  }
});

test("buildProviderPatch uses the documented provider values", () => {
  assert.equal(buildProviderPatch("codex-chatgpt", { model: "m" }).llm.provider, "codex");
  assert.equal(
    buildProviderPatch("openai-compatible", {
      model: "m",
      baseUrl: "https://api.example.com/v1",
      apiKey: FIXTURE_SECRET,
    }).llm.provider,
    "openai-compatible",
  );
  for (const [choice, spec] of Object.entries(PROVIDER_CHOICES)) {
    assert.ok(
      ["echo", "codex", "gemini", "anthropic", "openai", "openai-compatible"].includes(
        spec.provider,
      ),
      `${choice} maps to an unknown provider value`,
    );
  }
});

test("buildProviderPatch builds codex/ChatGPT with no credential field at all", () => {
  const patch = buildProviderPatch("codex-chatgpt", { model: "gpt-5.6-sol" });
  assert.deepEqual(patch, { llm: { provider: "codex", model: "gpt-5.6-sol" } });
  assert.equal(patchCarriesSecret(patch), false);
});

test("buildProviderPatch clears a leftover custom codex block only when asked", () => {
  const kept = buildProviderPatch("codex-chatgpt", { model: "m" });
  assert.equal("codex_provider_base_url" in kept.llm, false);
  const cleared = buildProviderPatch("codex-chatgpt", { model: "m", clearCodexCustom: true });
  assert.equal(cleared.llm.codex_provider_base_url, "");
  assert.equal(cleared.llm.codex_model, "");
  assert.equal(cleared.llm.codex_api_key, "");
});

test("buildProviderPatch builds codex-custom with the server's own defaults", () => {
  const patch = buildProviderPatch("codex-custom", {
    codexBaseUrl: "https://api.example.com/compatible-mode/v1",
    codexModel: "qwen-plus",
    apiKey: FIXTURE_SECRET,
  });
  assert.equal(patch.llm.provider, "codex");
  assert.equal(patch.llm.codex_provider_base_url, "https://api.example.com/compatible-mode/v1");
  assert.equal(patch.llm.codex_model, "qwen-plus");
  assert.equal(patch.llm.codex_provider_name, DEFAULT_CODEX_PROVIDER_NAME);
  assert.equal(patch.llm.codex_wire_api, DEFAULT_CODEX_WIRE_API);
  assert.equal(patch.llm.codex_api_key, FIXTURE_SECRET);
});

test("buildProviderPatch refuses a non-HTTPS or credential-bearing codex base URL", () => {
  assert.throws(
    () =>
      buildProviderPatch("codex-custom", {
        codexBaseUrl: "http://api.example.com/v1",
        codexModel: "m",
        apiKey: FIXTURE_SECRET,
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      buildProviderPatch("codex-custom", {
        codexBaseUrl: "https://user:pass@api.example.com/v1",
        codexModel: "m",
        apiKey: FIXTURE_SECRET,
      }),
    /credentials/,
  );
});

test("buildProviderPatch requires a base_url for openai-compatible", () => {
  assert.throws(
    () => buildProviderPatch("openai-compatible", { model: "m", apiKey: FIXTURE_SECRET }),
    /--base-url/,
  );
});

test("buildProviderPatch refuses a credential inside ANY base URL", () => {
  // THE REGRESSION THIS PINS: --base-url was validated with `requireText`
  // while --codex-base-url got the strict check, so a basic-auth gateway URL —
  // a real OpenAI-compatible deployment shape — carried a password straight
  // into the printed body and the --json output.
  assert.throws(
    () =>
      buildProviderPatch("openai-compatible", {
        model: "m",
        baseUrl: "https://gateway-user:gateway-pass@api.example.com/v1",
        apiKey: FIXTURE_SECRET,
      }),
    /credentials/,
  );
  // The optional base URL on the other direct providers is the same field with
  // the same exposure, so it is held to the same rule.
  for (const choice of ["openai", "anthropic", "gemini"]) {
    assert.throws(
      () =>
        buildProviderPatch(choice, {
          model: "m",
          baseUrl: "https://gateway-user:gateway-pass@api.example.com/v1",
          apiKey: FIXTURE_SECRET,
        }),
      /credentials/,
      `${choice} accepted a credential-bearing base URL`,
    );
  }
});

test("buildProviderPatch refuses cleartext http except to a loopback host", () => {
  assert.throws(
    () =>
      buildProviderPatch("openai-compatible", {
        model: "m",
        baseUrl: "http://api.example.com/v1",
        apiKey: FIXTURE_SECRET,
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      buildProviderPatch("openai-compatible", {
        model: "m",
        baseUrl: "not-a-url",
        apiKey: FIXTURE_SECRET,
      }),
    /valid URL/,
  );
  // Loopback is allowed on purpose: the codex bridge listens on 127.0.0.1:8765,
  // the server accepts such a base_url, and nothing crosses a network — so
  // refusing it would block a working deployment rather than protect anything.
  for (const url of ["http://127.0.0.1:8765/v1", "http://localhost:11434/v1"]) {
    assert.equal(
      buildProviderPatch("openai-compatible", { model: "m", baseUrl: url, apiKey: FIXTURE_SECRET })
        .llm.base_url,
      url,
    );
  }
});

test("buildProviderPatch requires a key for every provider that carries one", () => {
  for (const [choice, spec] of Object.entries(PROVIDER_CHOICES)) {
    if (spec.secret === null) continue;
    assert.throws(
      () =>
        buildProviderPatch(choice, {
          model: "m",
          baseUrl: "https://api.example.com/v1",
          codexBaseUrl: "https://api.example.com/v1",
          codexModel: "m",
        }),
      /API key/,
      `${choice} accepted a missing key`,
    );
  }
});

test("buildProviderPatch adds llm.tools.enabled only when asked", () => {
  assert.equal("tools" in buildProviderPatch("gemini", { model: "m", apiKey: FIXTURE_SECRET }).llm, false);
  assert.deepEqual(
    buildProviderPatch("gemini", { model: "m", apiKey: FIXTURE_SECRET, enableTools: true }).llm.tools,
    { enabled: true },
  );
});

test("buildProviderPatch rejects an unknown provider choice", () => {
  assert.throws(() => buildProviderPatch("not-a-provider", {}), /unknown provider choice/);
});

// ─── redaction ──────────────────────────────────────────────────────────────

test("renderPatch redacts every secret field it is given", () => {
  const patch = buildProviderPatch("openai-compatible", {
    model: "some-model",
    baseUrl: "https://api.example.com/v1",
    apiKey: FIXTURE_SECRET,
  });
  const rendered = renderPatch(patch);
  assert.equal(rendered.includes(FIXTURE_SECRET), false, "the rendered body leaked the key");
  assert.ok(rendered.includes("<redacted>"));
  // The real body still carries the real key — redaction is a rendering
  // concern, never a data concern.
  assert.equal(patch.llm.api_key, FIXTURE_SECRET);
});

test("renderPatch redacts the codex credential too", () => {
  const rendered = renderPatch(
    buildProviderPatch("codex-custom", {
      codexBaseUrl: "https://api.example.com/v1",
      codexModel: "qwen-plus",
      apiKey: FIXTURE_SECRET,
    }),
  );
  assert.equal(rendered.includes(FIXTURE_SECRET), false);
});

test("a URL that IS printed is rendered without its userinfo", () => {
  // `buildProviderPatch` refuses this shape, so this covers the bodies this
  // tool did NOT build — a device readback, or a future caller. Redaction that
  // relies on upstream validation is redaction that fails when it matters.
  assert.equal(
    redactUrlUserinfo("https://gateway-user:gateway-pass@api.example.com/v1"),
    "https://<redacted>@api.example.com/v1",
  );
  const rendered = renderPatch({
    llm: {
      provider: "openai-compatible",
      base_url: "https://gateway-user:gateway-pass@api.example.com/v1",
      codex_provider_base_url: "https://other-user:other-pass@codex.example.com/v1",
      api_key: FIXTURE_SECRET,
    },
  });
  assert.equal(rendered.includes("gateway-pass"), false, "the rendered body leaked a URL password");
  assert.equal(rendered.includes("gateway-user"), false);
  assert.equal(rendered.includes("other-pass"), false);
  assert.equal(rendered.includes(FIXTURE_SECRET), false);

  // A URL with no userinfo is returned byte-for-byte: this must not silently
  // normalise a value an operator is reading back off the device.
  assert.equal(
    redactUrlUserinfo("https://api.example.com/compatible-mode/v1"),
    "https://api.example.com/compatible-mode/v1",
  );
  assert.equal(redactUrlUserinfo("not-a-url"), "not-a-url");
  assert.equal(redactUrlUserinfo(""), "");
  assert.equal(redactUrlUserinfo(null), null);
});

test("redactPatch leaves non-secret values untouched and does not mutate its input", () => {
  const patch = buildProviderPatch("openai-compatible", {
    model: "some-model",
    baseUrl: "https://api.example.com/v1",
    apiKey: FIXTURE_SECRET,
  });
  const redacted = redactPatch(patch);
  assert.equal(redacted.llm.base_url, "https://api.example.com/v1");
  assert.equal(redacted.llm.model, "some-model");
  assert.equal(patch.llm.api_key, FIXTURE_SECRET);
});

// ─── read-only default ──────────────────────────────────────────────────────

test("shouldApplySettingsWrite is false without --apply", () => {
  assert.equal(shouldApplySettingsWrite({ serial: "YOUR_PIN_SERIAL" }), false);
  assert.equal(shouldApplySettingsWrite({ serial: "YOUR_PIN_SERIAL", apply: false }), false);
  assert.equal(shouldApplySettingsWrite({}), false);
  assert.equal(shouldApplySettingsWrite(undefined), false);
});

test("shouldApplySettingsWrite is false with --apply but no --serial", () => {
  assert.equal(shouldApplySettingsWrite({ apply: true }), false);
  assert.equal(shouldApplySettingsWrite({ apply: true, serial: null }), false);
  assert.equal(shouldApplySettingsWrite({ apply: true, serial: "" }), false);
});

test("shouldApplySettingsWrite is true only with both", () => {
  assert.equal(shouldApplySettingsWrite({ apply: true, serial: "YOUR_PIN_SERIAL" }), true);
});

test("set-provider without --apply prints the exact PUT body, writes nothing, and exits 0", async () => {
  const { runtime, stdout, text } = captureRuntime({ OPENAI_API_KEY: FIXTURE_SECRET });
  const code = await main(
    [
      "set-provider",
      "--provider",
      "openai-compatible",
      "--model",
      "some-model",
      "--base-url",
      "https://api.example.com/v1",
    ],
    runtime,
  );
  assert.equal(code, 0);
  const printed = stdout.join("");
  assert.ok(printed.includes("DRY RUN"), "a read-only run must say so");
  assert.ok(printed.includes("PUT /api/settings"));
  assert.ok(printed.includes('"provider": "openai-compatible"'));
  assert.ok(printed.includes('"base_url": "https://api.example.com/v1"'));
  assert.equal(text().includes(FIXTURE_SECRET), false, "the dry run leaked the key");
  // `runtime.spawn` throws on use, so reaching adb would have failed the run.
});

test("set-provider for codex/ChatGPT says the sign-in is the human's job", async () => {
  const { runtime, stdout } = captureRuntime({});
  const code = await main(
    ["set-provider", "--provider", "codex-chatgpt", "--model", "gpt-5.6-sol"],
    runtime,
  );
  assert.equal(code, 0);
  const printed = stdout.join("");
  assert.ok(printed.includes("cannot sign in for you"));
  assert.ok(printed.includes("device-code"));
  assert.equal(
    /logged in|signed you in|login complete/i.test(printed),
    false,
    "the tool must never imply it completed the login",
  );
});

test("set-provider --apply without --serial is a usage error, not a write", async () => {
  const { runtime, stderr } = captureRuntime({ OPENAI_API_KEY: FIXTURE_SECRET });
  const code = await main(
    ["set-provider", "--provider", "openai", "--model", "gpt-4.1", "--apply"],
    runtime,
  );
  assert.equal(code, 2);
  assert.ok(stderr.join("").includes("--apply requires --serial"));
});

test("set-provider reports a missing credential instead of writing an empty one", async () => {
  const { runtime, stderr } = captureRuntime({});
  const code = await main(["set-provider", "--provider", "gemini", "--model", "gemini-x"], runtime);
  assert.equal(code, 1);
  assert.ok(stderr.join("").includes("GEMINI_API_KEY"));
});

// ─── credentials never come from argv ───────────────────────────────────────

test("parseCliArgs refuses an --api-key command-line argument", () => {
  assert.throws(() => parseCliArgs(["set-provider", "--api-key", FIXTURE_SECRET]), /refusing --api-key/);
  assert.throws(() => parseCliArgs(["set-provider", `--api-key=${FIXTURE_SECRET}`]), /refusing --api-key/);
});

test("main's refusal of --api-key never echoes the key", async () => {
  const { runtime, text } = captureRuntime({});
  const code = await main(["set-provider", "--api-key", FIXTURE_SECRET], runtime);
  assert.equal(code, 2);
  assert.equal(text().includes(FIXTURE_SECRET), false);
});

test("resolveSecretSource defaults to the server's own env var per provider", () => {
  assert.deepEqual(resolveSecretSource("gemini", {}), { kind: "env", name: "GEMINI_API_KEY" });
  assert.deepEqual(resolveSecretSource("anthropic", {}), { kind: "env", name: "ANTHROPIC_API_KEY" });
  assert.deepEqual(resolveSecretSource("openai", {}), { kind: "env", name: "OPENAI_API_KEY" });
  assert.deepEqual(resolveSecretSource("openai-compatible", {}), {
    kind: "env",
    name: "OPENAI_API_KEY",
  });
  assert.deepEqual(resolveSecretSource("codex-custom", {}), {
    kind: "env",
    name: "DASHSCOPE_API_KEY",
  });
  assert.equal(resolveSecretSource("codex-chatgpt", {}), null);
});

test("parseCliArgs rejects supplying both key sources", () => {
  assert.throws(
    () =>
      parseCliArgs([
        "set-provider",
        "--provider",
        "openai",
        "--model",
        "m",
        "--api-key-env",
        "X",
        "--api-key-file",
        "/tmp/k",
      ]),
    /not both/,
  );
});

// ─── status summary ─────────────────────────────────────────────────────────

const HEALTH_OK = { status: "ok", name: "Penumbra", version: "0.0.0-test" };

test("summarizeStatus reports a missing API key for a direct provider", () => {
  const summary = summarizeStatus(
    { llm: { provider: "gemini", model: "gemini-x", has_api_key: false, tools: { enabled: true } } },
    HEALTH_OK,
    null,
  );
  assert.equal(summary.ok, false);
  assert.ok(summary.missing.some((item) => item.id === "api_key_missing"));
  assert.equal(summary.credential.present, false);
});

test("summarizeStatus is ok for a configured direct provider", () => {
  const summary = summarizeStatus(
    {
      llm: {
        provider: "openai-compatible",
        model: "some-model",
        base_url: "https://api.example.com/v1",
        has_api_key: true,
        tools: { enabled: true },
      },
    },
    HEALTH_OK,
    null,
  );
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.missing, []);
});

test("summarizeStatus flags an openai-compatible provider with no base_url", () => {
  const summary = summarizeStatus(
    {
      llm: {
        provider: "openai-compatible",
        model: "some-model",
        base_url: "",
        has_api_key: true,
        tools: { enabled: true },
      },
    },
    HEALTH_OK,
    null,
  );
  assert.equal(summary.ok, false);
  assert.ok(summary.missing.some((item) => item.id === "base_url_missing"));
});

test("summarizeStatus reports the codex sign-in state and hands the login back to the human", () => {
  const summary = summarizeStatus(
    {
      llm: {
        provider: "codex",
        model: "gpt-5.6-sol",
        codex_custom_active: false,
        tools: { enabled: true },
      },
    },
    HEALTH_OK,
    { state: "signed_out", ready: false, login_pending: false, login_mode: null },
  );
  assert.equal(summary.ok, false);
  assert.equal(summary.mode, "codex-chatgpt");
  assert.equal(summary.codex.state, "signed_out");
  // A read state that is not ready is a KNOWN-absent credential, not unknown.
  assert.equal(summary.credential.present, false);
  const login = summary.missing.find((item) => item.id === "codex_login_required");
  assert.ok(login, "the login requirement must be reported");
  assert.ok(
    /cannot sign in for you/.test(login.remedy),
    "the tool must not imply it can complete the login",
  );
  assert.ok(/device-code/.test(login.remedy));
});

test("summarizeStatus is ok for a ready codex/ChatGPT login", () => {
  const summary = summarizeStatus(
    {
      llm: {
        provider: "codex",
        model: "gpt-5.6-sol",
        codex_custom_active: false,
        tools: { enabled: true },
      },
    },
    HEALTH_OK,
    { state: "ready", ready: true, login_pending: false, login_mode: "chatgpt" },
  );
  assert.equal(summary.ok, true);
  assert.equal(summary.credential.present, true);
});

test("summarizeStatus reports an unknown codex login state as missing, never as fine", () => {
  const summary = summarizeStatus(
    {
      llm: {
        provider: "codex",
        model: "gpt-5.6-sol",
        codex_custom_active: false,
        tools: { enabled: true },
      },
    },
    null,
    null,
  );
  assert.equal(summary.ok, false);
  assert.ok(summary.missing.some((item) => item.id === "codex_status_unknown"));
});

test("summarizeStatus is ok for an active custom codex provider without any login", () => {
  const summary = summarizeStatus(
    {
      llm: {
        provider: "codex",
        codex_custom_active: true,
        codex_model: "qwen-plus",
        has_codex_api_key: true,
        tools: { enabled: true },
      },
    },
    HEALTH_OK,
    { state: "signed_out", ready: false, login_pending: false, login_mode: null },
  );
  assert.equal(summary.ok, true);
  assert.equal(summary.mode, "codex-custom");
  assert.equal(summary.model, "qwen-plus");
});

test("summarizeStatus refuses to call the echo provider configured", () => {
  const summary = summarizeStatus({ llm: { provider: "echo", model: "" } }, HEALTH_OK, null);
  assert.equal(summary.ok, false);
  assert.ok(summary.missing.some((item) => item.id === "provider_echo"));
});

test("summarizeStatus warns when llm.tools.enabled is false", () => {
  const summary = summarizeStatus(
    {
      llm: {
        provider: "gemini",
        model: "gemini-x",
        has_api_key: true,
        tools: { enabled: false },
      },
    },
    HEALTH_OK,
    null,
  );
  assert.ok(summary.warnings.some((item) => item.id === "tools_disabled"));
});

test("summarizeStatus warns when health is not ok or was never read", () => {
  const unhealthy = summarizeStatus(
    { llm: { provider: "gemini", model: "m", has_api_key: true, tools: { enabled: true } } },
    { status: "degraded" },
    null,
  );
  assert.ok(unhealthy.warnings.some((item) => item.id === "health_not_ok"));
  const unread = summarizeStatus(
    { llm: { provider: "gemini", model: "m", has_api_key: true, tools: { enabled: true } } },
    null,
    null,
  );
  assert.ok(unread.warnings.some((item) => item.id === "health_unknown"));
});

test("summarizeStatus survives an unreadable settings document", () => {
  for (const value of [null, undefined, {}, { llm: null }]) {
    const summary = summarizeStatus(value, null, null);
    assert.equal(summary.ok, false);
    assert.ok(summary.missing.some((item) => item.id === "settings_unavailable"));
  }
});

test("formatStatusLines states that presence is not proof", () => {
  const lines = formatStatusLines(
    summarizeStatus(
      { llm: { provider: "gemini", model: "m", has_api_key: true, tools: { enabled: true } } },
      HEALTH_OK,
      null,
    ),
    { transport: "test" },
  ).join("\n");
  assert.ok(lines.includes("presence is not proof"));
  assert.ok(lines.includes("verify"));
});

test("codexLoginInstructions never claims the tool performs the login", () => {
  const text = codexLoginInstructions();
  assert.ok(/cannot sign in for you/.test(text));
  assert.ok(/device-code/.test(text));
});

// ─── the staged PUT body (the only file that ever holds the key) ────────────

test("the staged body path is unpredictable and shell-safe", () => {
  const first = newStagedBodyPath();
  const second = newStagedBodyPath();

  // A fixed name can be guessed and camped on before the file exists, in a
  // directory every adb shell can write. /data/local/tmp cannot be made
  // private, so an unguessable name is the mitigation that is actually
  // available.
  assert.notEqual(first, second);
  assert.match(first, /^\/data\/local\/tmp\/revival-pin-configure-[0-9a-f]{24}\.json$/);
  // It is interpolated into an `adb shell` command line, so nothing in it may
  // be readable as a shell metacharacter.
  assert.equal(/[^A-Za-z0-9/._-]/.test(first), false);

  // 12 random bytes, not a timestamp or a pid: both of those are guessable.
  const paths = new Set(Array.from({ length: 200 }, () => newStagedBodyPath()));
  assert.equal(paths.size, 200);
});

// A child-process double shaped like the one `spawnCapture` drives
// (platform/deploy/acceptance/pin/pinbox/shared/adb.mjs:37-89). No adb, no device: `handler` decides the
// exit code per call, so the failure paths are reachable on a laptop.
function fakeAdb(handler) {
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stderr.resume = () => {};
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {};
    const { code = 0, stdout = "" } = handler(args.slice(2)) ?? {};
    setImmediate(() => {
      if (stdout.length > 0) child.stdout.emit("data", Buffer.from(stdout, "utf8"));
      child.exitCode = code;
      child.emit("close", code, null);
    });
    return child;
  };
  return { spawn, calls };
}

const ADB_OPTIONS = Object.freeze({ serial: "YOUR_PIN_SERIAL", adbPath: "adb" });

function stagedPathsOf(calls) {
  const pushed = calls.find(({ args }) => args[2] === "push")?.args?.[4] ?? null;
  const chmodded = calls.find(({ args }) => args[3] === "chmod")?.args?.[5] ?? null;
  const removed = calls.find(({ args }) => args[3] === "rm")?.args?.[5] ?? null;
  return { pushed, chmodded, removed };
}

test("a failed settings PUT still removes the staged body from the device", async () => {
  const patch = buildProviderPatch("gemini", { model: "gemini-x", apiKey: FIXTURE_SECRET });
  // curl exits 7 (could not connect): the PUT fails after the body is already
  // on the device. That is the case that used to leave a plaintext API key
  // sitting in shared scratch space.
  const { spawn, calls } = fakeAdb((args) =>
    args[0] === "shell" && String(args[1]).startsWith("exec curl") ? { code: 7 } : { code: 0 },
  );

  await assert.rejects(() => putSettingsOverAdminHttp(ADB_OPTIONS, "token", patch, spawn));

  const { pushed, chmodded, removed } = stagedPathsOf(calls);
  assert.ok(pushed !== null, "the body must have been staged");
  assert.equal(removed, pushed, "the file that was staged is the file that must be removed");
  assert.equal(chmodded, pushed, "the staged body must be narrowed to owner-only");
  assert.ok(calls.some(({ args }) => args.includes("600")), "0644 from adb push is not acceptable");

  // The key travelled on stdin, never in an argument vector.
  assert.equal(JSON.stringify(calls).includes(FIXTURE_SECRET), false);
});

test("a body that cannot be secured is not sent, and is still removed", async () => {
  const patch = buildProviderPatch("gemini", { model: "gemini-x", apiKey: FIXTURE_SECRET });
  const { spawn, calls } = fakeAdb((args) =>
    args[0] === "shell" && args[1] === "chmod" ? { code: 1 } : { code: 0 },
  );

  await assert.rejects(() => putSettingsOverAdminHttp(ADB_OPTIONS, "token", patch, spawn), /owner-only/);

  // Fail closed: a world-readable file holding an API key must not be used
  // just because the next step would probably have worked.
  assert.equal(
    calls.some(({ args }) => String(args[3] ?? "").startsWith("exec curl")),
    false,
    "the PUT must not run once the body could not be secured",
  );
  const { pushed, removed } = stagedPathsOf(calls);
  assert.equal(removed, pushed, "the staged body must be removed on this path too");
});

test("a failed push still triggers the removal of the path it tried to stage", async () => {
  const patch = buildProviderPatch("gemini", { model: "gemini-x", apiKey: FIXTURE_SECRET });
  const { spawn, calls } = fakeAdb((args) => (args[0] === "push" ? { code: 1 } : { code: 0 }));

  await assert.rejects(() => putSettingsOverAdminHttp(ADB_OPTIONS, "token", patch, spawn), /staged/);

  // `adb push` can fail after writing a partial file, so cleanup is
  // unconditional rather than conditional on a successful push.
  const { pushed, removed } = stagedPathsOf(calls);
  assert.equal(removed, pushed);
});

// ─── maintenance-provider encoding ──────────────────────────────────────────

test("encodeMaintenanceUpdateArg emits padding-free base64url the device accepts", () => {
  const encoded = encodeMaintenanceUpdateArg({ llm: { provider: "codex", model: "m" } });
  // UsbMaintenanceProvider.kt:405-407 accepts letters/digits/-/_ only and
  // refuses length % 4 == 1.
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(encoded.length % 4, 1);
  assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")), {
    llm: { provider: "codex", model: "m" },
  });
});

test("parseMaintenanceBundle extracts status, ok and the JSON body", () => {
  const parsed = parseMaintenanceBundle(
    'Result: Bundle[{status=200, ok=true, body={"restart_required":false,"llm":{"provider":"codex","has_api_key":false}}}]',
  );
  assert.equal(parsed.status, 200);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.body.llm.provider, "codex");
});

test("parseMaintenanceBundle is not confused by a status field inside the body", () => {
  const parsed = parseMaintenanceBundle(
    'Result: Bundle[{ok=false, body={"error":"invalid update","status":"200, ok=true"}, status=400}]',
  );
  assert.equal(parsed.status, 400);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.body.error, "invalid update");
});

test("parseMaintenanceBundle returns null for output that is not a bundle", () => {
  for (const value of ["", "Error: java.lang.SecurityException", "Result: null"]) {
    assert.equal(parseMaintenanceBundle(value), null);
  }
});

// ─── CLI surface ────────────────────────────────────────────────────────────

test("parseCliArgs defaults set-provider to read-only", () => {
  const options = parseCliArgs(["set-provider", "--provider", "gemini", "--model", "m"]);
  assert.equal(options.apply, false);
  assert.equal(shouldApplySettingsWrite(options), false);
});

test("parseCliArgs requires --serial for the device-reading commands", () => {
  assert.throws(() => parseCliArgs(["status"]), /requires --serial/);
  assert.throws(() => parseCliArgs(["verify"]), /requires --serial/);
});

test("parseCliArgs rejects an unknown provider choice and an unknown flag", () => {
  assert.throws(
    () => parseCliArgs(["set-provider", "--provider", "chatgpt-plus"]),
    /unknown --provider/,
  );
  assert.throws(() => parseCliArgs(["status", "--serial", "S", "--nope"]), /unknown argument/);
});

test("parseCliArgs bounds the verify timeout", () => {
  assert.throws(
    () => parseCliArgs(["verify", "--serial", "S", "--timeout-ms", "10"]),
    /--timeout-ms/,
  );
  assert.equal(
    parseCliArgs(["verify", "--serial", "S", "--timeout-ms", "30000"]).timeoutMs,
    30_000,
  );
});

test("--help prints the usage without needing a device and exits 0", async () => {
  const { runtime, stdout } = captureRuntime({});
  assert.equal(await main(["--help"], runtime), 0);
  const printed = stdout.join("");
  assert.ok(printed.includes("status"));
  assert.ok(printed.includes("set-provider"));
  assert.ok(printed.includes("verify"));
  assert.ok(printed.includes("no --api-key flag"), "the help must explain the missing flag");
});

test("no command prints usage and exits 2", async () => {
  const { runtime } = captureRuntime({});
  assert.equal(await main([], runtime), 2);
});
