#!/usr/bin/env node

// Repeated-measure A/B harness for assistant prompts.
//
// Reuses the audited raw Understand probe from `agentic-release-smoke.mjs`:
// returned stock actions are DECODED AND COUNTED, never dispatched, so running
// this cannot start playback, place a call, or change device state.
//
// WHAT THIS IS NOT: it bypasses stock speech recognition and the stock client,
// so it is a prompt/planner tuning instrument, never physical acceptance. A
// result here says the server planned something; it says nothing about what the
// Pin spoke or how it sounded.
//
// Why repeated + interleaved: a single timing is not evidence. Provider latency
// drifts over minutes, so comparing prompt A measured now against prompt B
// measured five minutes ago attributes drift to the prompt. Rounds are
// interleaved (A,B,A,B…) so drift hits both arms equally, and the report
// refuses to call a winner when the gap is inside the observed spread.
//
// Usage:
//   node platform/deploy/acceptance/pin/prompt-eval.mjs --serial SERIAL --prompt "what's nearby" [--prompt "..."] [--repeat 5] [--json]

import { execFileSync } from "node:child_process";

import { readAdminToken, runUnderstand } from "./agentic-release-smoke.mjs";
import {
  SUITE,
  evaluateCase,
  evaluateAnswer,
  extractAnswer,
  isUnavailableAnswer,
} from "./prompt-suite.mjs";
import { OPERATIONAL_MARKERS } from "./tier-a-symbols.mjs";

const DEFAULT_REPEAT = 5;
const DEFAULT_TIMEOUT_MS = 90_000;
const REGEXP_META = /[.*+?^${}()|[\]\\]/g;
const markerPattern = (marker) => marker.replace(REGEXP_META, "\\$&");
const TOOL_EXECUTED_PATTERN = new RegExp(
  `${markerPattern(OPERATIONAL_MARKERS.tool_executed.value)} .*?tool=([A-Za-z_][A-Za-z0-9_]*) ok=(true|false)(?: reason=("?)([^"\\n]{0,80}))?`,
  "g",
);
const MUTATION_PATTERN = new RegExp(
  `${markerPattern(OPERATIONAL_MARKERS.mutation.value)}\\b(?!\\s+rejected)[^\\n]*?tool=([A-Za-z_][A-Za-z0-9_]*)`,
  "g",
);
// The Hook redirects stock gRPC to this loopback port (observed on device:
// "ChannelFactory.getGatewayUri() redirected: api.prod.humane.cloud -> 127.0.0.1:9090").
const DEVICE_PORT = 9_090;
// Cool-down between probes so a burst does not measure its own queueing.
const SETTLE_MS = 1_500;

function usage() {
  console.error(
    [
      "usage: node platform/deploy/acceptance/pin/prompt-eval.mjs --serial SERIAL --prompt TEXT [--prompt TEXT ...]",
      "                                  [--repeat N] [--timeout-ms N] [--json]",
      "",
      "  --serial      ADB serial. Required and never guessed.",
      "  --prompt      Utterance to evaluate. Repeat the flag to compare arms.",
      "  --repeat      Rounds per arm (default 5). Rounds are interleaved.",
      "  --adb-path    ADB executable (default: adb from PATH).",
      "  --suite       Run the committed behavioural suite (platform/deploy/acceptance/pin/prompt-suite.mjs).",
      "  --json        Emit the machine-readable report instead of the table.",
      "",
      "Actions returned by the device are counted, never dispatched.",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const options = {
    prompts: [],
    repeat: DEFAULT_REPEAT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    // The tunnel spawns this directly; resolved from PATH unless overridden.
    adbPath: "adb",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--serial") options.serial = argv[++index];
    else if (arg === "--prompt") options.prompts.push(argv[++index]);
    else if (arg === "--repeat") options.repeat = Number(argv[++index]);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--adb-path") options.adbPath = argv[++index];
    else if (arg === "--suite") options.suite = true;
    else if (arg === "--include-answers") options.includeAnswers = true;
    else if (arg === "--json") options.json = true;
    else return { error: `unknown argument: ${arg}` };
  }
  if (!options.serial) return { error: "--serial is required" };
  if (options.suite) options.prompts = SUITE.map((testCase) => testCase.prompt);
  if (options.prompts.length === 0) {
    return { error: "at least one --prompt is required (or --suite)" };
  }
  if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > 25) {
    return { error: "--repeat must be an integer between 1 and 25" };
  }
  return { options };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Shape, plus the answer text held IN MEMORY for scoring only.
//
// The prose is deliberately never persisted: `answerText` is consumed by
// `evaluateAnswer` and then stripped from the report unless --include-answers is
// passed explicitly, so a shared report still carries no response content.
//
// Answer text has to be read at all because action-shape alone cannot see the
// failure that actually bit this device: a backend error arrives as a
// well-formed `Respond` FASTER than a real answer, so counting actions (and
// measuring only `answerChars`) scores a broken assistant as healthy.
// The answer half of this used to read `response.answer ?? response.text ??
// response.speech`. Those keys exist on NO frame, so `answerText` was always ""
// — every answer-scored case reported "empty answer" and `isUnavailableAnswer`
// never fired once. Extraction now lives in prompt-suite.mjs (`extractAnswer`),
// where it is unit-tested against the real frame shape and the on-disk corpus.
function summarizeResponses(responses) {
  const actions = [];
  let frames = 0;
  for (const response of responses ?? []) {
    frames += 1;
    // NOTE: an observation frame contributes `actionName`, and a Hermes progress
    // cue contributes a read-tool name identical to those used in suite
    // expect/forbid lists. No artifact contains either yet (113/113 are
    // single action frames), but if multi-frame turns start appearing this can
    // satisfy an `expect` or trip a `forbid` without the tool ever executing.
    const action = response?.action ?? response?.actionName;
    if (typeof action === "string" && action.length > 0) actions.push(action);
  }
  const answer = extractAnswer(responses);
  return {
    frames,
    actions,
    answerChars: answer.text.length,
    answerText: answer.text,
    answerStatus: answer.status,
  };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

/**
 * Tools the server actually executed, read from the device log.
 *
 * Read tools do NOT appear as streamed actions — only terminal mutations do —
 * so scoring a case on returned actions alone reports "knowledge_lookup never
 * ran" when it ran twice. It also hides `ok=false`: a tool that was called and
 * FAILED looked identical to one that was never called, which is the same
 * false-green shape that let .120 ship inert.
 */
function executedTools(options, sinceLogTime) {
  try {
    const out = execFileSync(
      options.adbPath,
      ["-s", options.serial, "logcat", "-d", "-t", sinceLogTime],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    const executed = [];
    // Name class widened from [a-z_]+ so a hallucinated CamelCase tool in an
    // `unknown_tool` failure is COUNTED rather than dropped silently. Under the
    // old class such a line produced no entry at all — not even a failedTools
    // note — so a model calling a tool that does not exist looked identical to a
    // model that called nothing.
    for (const match of out.matchAll(TOOL_EXECUTED_PATTERN)) {
      executed.push({ tool: match[1], ok: match[2] === "true", reason: match[4]?.trim() });
    }
    // Mutations and play_music emit OPERATIONAL_MARKERS.mutation, not
    // OPERATIONAL_MARKERS.tool_executed (tools/catalog.rs:2569 vs :2242), and a
    // grounding refusal emits OPERATIONAL_MARKERS.mutation_rejected. Neither
    // was parsed, so "the model never asked" and "a gate refused the model's
    // call" were the same observation — the false-green shape that let .120
    // ship inert. These are reported separately and never counted as executed
    // tools.
    const mutations = [...out.matchAll(MUTATION_PATTERN)].map(
      (match) => match[1],
    );
    const mutationsRejected = out.includes(
      OPERATIONAL_MARKERS.mutation_rejected.value,
    );
    const declined = out.includes(
      `reason="${OPERATIONAL_MARKERS.backend_unavailable.value}"`,
    );
    return { executed, mutations, mutationsRejected, declined };
  } catch (error) {
    // Previously a bare `catch {}` returning an empty result — byte-identical to
    // a healthy turn that ran no tools, so a broken instrument read as a broken
    // assistant. Name the failure so the case can be reported as environmental.
    return {
      executed: [],
      mutations: [],
      mutationsRejected: false,
      declined: false,
      logcatError: String(error?.message ?? error),
    };
  }
}

// End of the PREVIOUS turn's probe, so this turn's log window cannot reach back
// into it. See logcatStamp().
let previousTurnEndedAt = 0;

function logcatStamp() {
  // Widened from 2s: a tool execution landing just outside the window was
  // reported as a hard FAIL when it was actually environmental (no GPS fix).
  //
  // But 6s of lookback with only a 1.5s settle meant up to 4.5s of the PREVIOUS
  // prompt's tail sat inside this prompt's window — structural cross-attribution,
  // not a hypothetical: a real artifact shows OPERATIONAL_MARKERS.decline
  // landing 3.07s
  // into its own turn, i.e. ~2.1s before the next prompt starts. That leak is
  // OPTIMISTIC, which is the dangerous direction: a leaked decline downgrades a
  // genuine FAIL to "FAIL? environment: provider declined" and excuses a real
  // regression. Clamping to the previous turn's end keeps the full lookback on
  // the first turn and everything belonging to THIS turn, while excluding the
  // neighbour. A boundary marker (platform/deploy/acceptance/pin/pinbox/shared/logcat.mjs) would be
  // stronger still; this is the small version of that fix.
  const lookbackMs = previousTurnEndedAt
    ? Math.max(0, Math.min(6000, Date.now() - previousTurnEndedAt))
    : 6000;
  const now = new Date(Date.now() - lookbackMs);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.000`;
}

async function probeOnce(options, utterance) {
  const sinceLogTime = logcatStamp();
  const startedAt = Date.now();
  try {
    const responses = await runUnderstand(options, DEVICE_PORT, utterance, {
      timeoutMs: options.timeoutMs,
      userTurnId: `prompt-eval-${startedAt}`,
      excludedTools: [],
      authToken: options.authToken,
    });
    const summary = summarizeResponses(responses);
    const { executed, mutations, mutationsRejected, declined, logcatError } = executedTools(
      options,
      sinceLogTime,
    );
    previousTurnEndedAt = Date.now();
    // Only SUCCESSFUL tools count as the planner having done the thing.
    const okTools = executed.filter((entry) => entry.ok).map((entry) => entry.tool);
    const failedTools = executed
      .filter((entry) => !entry.ok)
      .map((entry) => (entry.reason ? `${entry.tool} (${entry.reason})` : entry.tool));
    // A turn that produced NO actions and executed NO tools did not reach the
    // model at all. Observed on device: the Pin lost its network relay, so
    // every case failed with no decline logged and no ok=false tool — the two
    // signals this harness watched for. Without this, a network drop reads as
    // a planner regression across the whole suite.
    const silent = summary.actions.length === 0 && executed.length === 0;
    return {
      ok: true,
      ms: Date.now() - startedAt,
      ...summary,
      actions: [...summary.actions, ...okTools],
      failedTools,
      // Kept apart from `actions`: a mutation the model PROPOSED and a gate
      // refused must never be scored as one the planner performed.
      mutations,
      mutationsRejected,
      declined,
      logcatError,
      // Raw count of OPERATIONAL_MARKERS.tool_executed lines matched, ok or
      // not. Feeds the
      // suite-wide positive control: if this is zero everywhere, the tool
      // parser proved nothing and every tool-name expect/forbid is unverified.
      toolLines: executed.length,
      // Distinguishes "answered directly, no tool" from "a tool failed to fire".
      // Both previously looked like an empty action list.
      answeredWithoutTool: executed.length === 0 && summary.answerStatus === "ok",
      silent,
    };
  } catch (error) {
    return { ok: false, ms: Date.now() - startedAt, error: String(error?.message ?? error) };
  }
}

function summarizeArm(prompt, runs) {
  const ok = runs.filter((run) => run.ok);
  const durations = ok.map((run) => run.ms);
  const actionCounts = new Map();
  for (const run of ok) {
    for (const action of run.actions) {
      actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1);
    }
  }
  const failedTools = new Set(ok.flatMap((run) => run.failedTools ?? []));
  const declined = ok.some((run) => run.declined);
  const silentRuns = ok.filter((run) => run.silent).length;
  // An "unavailable" reply is a FAILED turn wearing a successful turn's clothes:
  // it is fast, well-formed, and carries a Respond action. Counted here so the
  // report can distinguish "the planner is wrong" from "the backend was down".
  //
  // Empties are PRESERVED. The old `.filter(text => text.length > 0)` deleted
  // silence from the record, so once extraction works a genuinely silent turn
  // would look identical to a turn that never ran.
  const answers = ok.map((run) => ({
    text: run.answerText ?? "",
    status: run.answerStatus ?? "no-frames",
  }));
  const answerTexts = answers.map((answer) => answer.text);
  const unavailableRuns = answerTexts.filter((text) => isUnavailableAnswer(text)).length;
  const mutationsRejected = ok.some((run) => run.mutationsRejected);
  const proposedMutations = [...new Set(ok.flatMap((run) => run.mutations ?? []))];
  const logcatErrors = [...new Set(ok.map((run) => run.logcatError).filter(Boolean))];
  const answeredWithoutToolRuns = ok.filter((run) => run.answeredWithoutTool).length;
  return {
    prompt,
    failedTools: [...failedTools],
    providerDeclined: declined,
    silentRuns,
    unavailableRuns,
    mutationsRejected,
    proposedMutations,
    logcatErrors,
    answeredWithoutToolRuns,
    toolLines: ok.reduce((total, run) => total + (run.toolLines ?? 0), 0),
    answers,
    answerTexts,
    runs: runs.length,
    ok: ok.length,
    failed: runs.length - ok.length,
    medianMs: median(durations),
    minMs: durations.length ? Math.min(...durations) : null,
    maxMs: durations.length ? Math.max(...durations) : null,
    spreadMs: durations.length ? Math.max(...durations) - Math.min(...durations) : null,
    actions: Object.fromEntries([...actionCounts].sort((a, b) => b[1] - a[1])),
    perRunMs: durations,
  };
}

/**
 * Compare two arms honestly.
 *
 * A gap smaller than the noise in either arm is not a finding. Returning
 * "inconclusive" is the whole point of this harness: it is what stops a
 * two-sample fluke from being reported as an improvement.
 */
function compare(a, b) {
  if (a.medianMs == null || b.medianMs == null) return { verdict: "insufficient data" };
  const gap = Math.abs(a.medianMs - b.medianMs);
  const noise = Math.max(a.spreadMs ?? 0, b.spreadMs ?? 0);
  const faster = a.medianMs < b.medianMs ? a : b;
  if (gap <= noise) {
    return {
      verdict: "inconclusive",
      gapMs: gap,
      noiseMs: noise,
      detail: `median gap ${gap}ms is within the ${noise}ms run-to-run spread; not a difference`,
    };
  }
  return {
    verdict: "difference",
    gapMs: gap,
    noiseMs: noise,
    fasterPrompt: faster.prompt,
    detail: `median gap ${gap}ms exceeds the ${noise}ms spread`,
  };
}

async function main() {
  const { options, error } = parseArgs(process.argv.slice(2));
  if (error) {
    console.error(error);
    usage();
    process.exitCode = 2;
    return;
  }

  const results = new Map(options.prompts.map((prompt) => [prompt, []]));
  options.authToken = await readAdminToken();
  // Interleave: round 1 of every arm, then round 2 … so provider drift is
  // shared rather than concentrated in whichever arm ran last.
  for (let round = 0; round < options.repeat; round += 1) {
    for (const prompt of options.prompts) {
      results.get(prompt).push(await probeOnce(options, prompt));
      await sleep(SETTLE_MS);
    }
  }

  const arms = options.prompts.map((prompt) => summarizeArm(prompt, results.get(prompt)));
  const report = {
    harness: "prompt-eval",
    caveat:
      "Raw Understand probes bypass stock speech recognition and the stock client. Planner evidence only; not physical acceptance.",
    repeat: options.repeat,
    arms,
    comparison: arms.length === 2 ? compare(arms[0], arms[1]) : undefined,
  };

  if (options.json) {
    // Answer prose is scoring input, not report content. Strip it unless the
    // operator explicitly opts in, so a shared/committed report carries verdicts
    // and counts but never what the assistant actually said.
    // `answers` carries the same prose as `answerTexts` (plus its status), so it
    // is stripped with it. Statuses are kept — they are verdicts, not content.
    const emitted = options.includeAnswers
      ? report
      : {
          ...report,
          arms: (report.arms ?? []).map(({ answerTexts, answers, ...arm }) => ({
            ...arm,
            answerStatuses: (answers ?? []).map((answer) => answer.status),
          })),
        };
    console.log(JSON.stringify(emitted, null, 2));
    return;
  }

  console.log(`prompt-eval — ${options.repeat} interleaved rounds per arm\n`);
  for (const arm of arms) {
    console.log(`  "${arm.prompt}"`);
    console.log(`    ok ${arm.ok}/${arm.runs}${arm.failed ? `  FAILED ${arm.failed}` : ""}`);
    console.log(
      `    median ${arm.medianMs}ms   min ${arm.minMs}ms   max ${arm.maxMs}ms   spread ${arm.spreadMs}ms`,
    );
    console.log(`    runs: ${arm.perRunMs.join(", ")}ms`);
    const actions = Object.entries(arm.actions);
    console.log(
      `    actions: ${actions.length ? actions.map(([name, n]) => `${name}×${n}`).join(", ") : "(none returned)"}`,
    );
    console.log("");
  }
  if (options.suite) {
    let passed = 0;
    let measured = 0;
    console.log("  behavioural suite\n");
    for (const testCase of SUITE) {
      const arm = arms.find((candidate) => candidate.prompt === testCase.prompt);
      const actions = Object.keys(arm?.actions ?? {});
      const actionScore = evaluateCase(testCase, actions);
      const { missing, forbidden } = actionScore;
      // The ANSWER is scored as well as the action, because an error reply is
      // fast, well-formed and action-correct. A case passes only if both agree.
      // The STATUS is passed, not just the text, so "no frames at all" and
      // "a device action was the answer" are different verdicts instead of both
      // collapsing to an empty string.
      // Scored across EVERY run, worst-first — not just run[0], which discarded
      // the repeat-measure design this harness exists for. A case where 1 of 5
      // runs returned an error reply was passing on the strength of run[0]
      // while the environment line simultaneously reported the bad run.
      const answerRuns = arm?.answers?.length
        ? arm.answers
        : [{ status: "no-frames", text: "" }];
      const answerScores = answerRuns.map((answer) => evaluateAnswer(testCase, answer));
      const answerScore = answerScores.find((score) => score.pass === false) ?? answerScores[0];
      const pass = actionScore.pass && answerScore.pass !== false;
      // Counted AFTER the skip: previously a skipped case that happened to pass
      // still incremented `passed` while `scored` excluded it, so the summary
      // could report more passes than scored cases.
      if (testCase.requiresDeviceRoundTrip) {
        console.log(`  SKIP  ${testCase.id} — needs a device preflight round-trip`);
        continue;
      }
      const env = [];
      if (arm?.silentRuns) {
        env.push(`${arm.silentRuns} run(s) produced no actions and no tool calls — model unreachable`);
      }
      // An arm whose every run threw used to print a bare FAIL identical to a
      // planner regression, because summarizeArm filters failed runs out before
      // any environment signal is computed.
      if (arm && arm.ok === 0 && arm.runs > 0) {
        env.push(`all ${arm.runs} run(s) failed the Understand RPC`);
      }
      if (arm?.logcatErrors?.length) {
        env.push(`log window unavailable: ${arm.logcatErrors.join("; ")}`);
      }
      if (arm?.providerDeclined) {
        env.push(
          `provider declined (${OPERATIONAL_MARKERS.backend_unavailable.value})`,
        );
      }
      if (arm?.unavailableRuns) {
        env.push(`${arm.unavailableRuns} run(s) returned an unavailable/error reply — backend down, not a planner regression`);
      }
      if (arm?.failedTools?.length) env.push(`tools failed: ${arm.failedTools.join(", ")}`);
      // "The model never asked" vs "a gate refused the model's call" are
      // different defects that both used to show as a missing action.
      if (arm?.mutationsRejected) {
        env.push("a mutation was PROPOSED and refused as ungrounded — not a missing tool call");
      }
      // A measurement case is reported, never counted. It cannot fail the run.
      if (testCase.measurement) {
        measured += 1;
        const observed = actions.length ? actions.join(", ") : "(no actions)";
        console.log(`  MEASURE ${testCase.id} — observed: ${observed}`);
        if (env.length) console.log(`          environment: ${env.join("; ")}`);
        if (testCase.note) console.log(`          ${testCase.note}`);
        continue;
      }
      if (pass) passed += 1;
      const label = pass ? "PASS" : env.length ? "FAIL?" : "FAIL";
      const detail = pass
        ? ""
        : `  missing=[${missing.join(", ")}] forbidden=[${forbidden.join(", ")}]` +
          (answerScore.checked && !answerScore.pass ? `  answer=${answerScore.reason}` : "");
      console.log(`  ${label}  ${testCase.id}${detail}`);
      // A failure with a known environmental cause is not evidence of a
      // regression. Say so rather than letting a flat FAIL imply a code defect.
      if (!pass && env.length) console.log(`          environment: ${env.join("; ")}`);
      if (!pass && testCase.note) console.log(`          ${testCase.note}`);
    }
    const scored = SUITE.filter(
      (testCase) => !testCase.requiresDeviceRoundTrip && !testCase.measurement,
    ).length;
    const skipped = SUITE.filter((testCase) => testCase.requiresDeviceRoundTrip).length;
    console.log(
      `\n  ${passed}/${scored} scored cases pass` +
        `${skipped ? ` (${skipped} skipped: need a device round-trip)` : ""}` +
        `${measured ? ` (${measured} reported as MEASURE, not counted)` : ""}`,
    );
    // POSITIVE CONTROL for the logcat path. Every tool-name expect/forbid in
    // this suite is scored from OPERATIONAL_MARKERS.tool_executed lines; if
    // that parser
    // matched nothing all run, "no tools ran" and "tool lines were missed" are
    // indistinguishable — which is exactly the state the 2026-07-28 baseline was
    // in, with 4 tool FAILs and 3 forbid-only PASSes that nothing could
    // corroborate. Exit 3 to keep it distinct from a behavioural failure (1).
    const toolLines = arms.reduce((total, arm) => total + (arm.toolLines ?? 0), 0);
    if (toolLines === 0) {
      console.log(
        "\n  INSTRUMENT UNTRUSTWORTHY: the tool-execution parser never matched a line.\n" +
          "  Tool-name expectations and forbids in this run are UNPROVEN — a passing\n" +
          "  forbid may simply be vacuous. Check adb, the serial, and ANDROID_LOG_TAGS.",
      );
      process.exitCode = 3;
      return;
    }
    if (passed < scored) process.exitCode = 1;
  }
  if (report.comparison) {
    console.log(`  verdict: ${report.comparison.verdict} — ${report.comparison.detail ?? ""}`);
    if (report.comparison.verdict === "difference") {
      console.log(`  faster: "${report.comparison.fasterPrompt}"`);
    }
  }
  console.log(`\n  ${report.caveat}`);
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exitCode = 1;
});
