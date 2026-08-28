// Tests for the prompt suite and its answer extractor.
//
// Run: node --test platform/deploy/acceptance/pin/prompt-suite.test.mjs   (no device, no network)
//
// These exist because the instrument was WRONG in a way nothing could see: the
// runner read the spoken answer from `response.answer ?? .text ?? .speech`,
// none of which exist on any frame, so every answer-scored case reported "empty
// answer" and `isUnavailableAnswer` never fired once. A harness with no tests is
// a harness whose failures are indistinguishable from the thing it measures.
//
// Every case here is pure data and must be able to go RED. The ones that
// actually separate a correct implementation from a plausible-looking wrong one
// are marked LOAD-BEARING.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import {
  SUITE,
  KNOWN_ABSENT_ACTION_NAMES,
  evaluateAnswer,
  evaluateCase,
  extractAnswer,
  isMachineryLeak,
  isUnavailableAnswer,
} from "./prompt-suite.mjs";
import { NATIVE_ACTIONS } from "./tier-a-symbols.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../pin");

/** A decoded `Respond` frame, matching the real decoder output exactly. */
const respondFrame = (text, overrides = {}) => ({
  kind: "action",
  isFinal: false,
  user: 2,
  hasIdentifier: true,
  hasParentIdentifier: true,
  identifier: "id",
  parentIdentifier: "parent",
  thought: "I should return the final answer from bounded read-only planning",
  action: "Respond",
  input: JSON.stringify({ Response: text }),
  devicePayloadBytes: 0,
  source: 1,
  ...overrides,
});

// ---- extraction ---------------------------------------------------------

test("extractAnswer: a Respond frame yields its spoken text", () => {
  const result = extractAnswer([respondFrame("Paris.")]);
  assert.equal(result.status, "ok");
  assert.equal(result.text, "Paris.");
  assert.equal(result.frameIndex, 0);
});

test("extractAnswer: an unavailable reply yields text that isUnavailableAnswer flags", () => {
  // The exact frame observed on 2026-07-28 when codex was wedged.
  const result = extractAnswer([
    respondFrame("Codex is unavailable on the host. Check its login status."),
  ]);
  assert.equal(result.status, "ok");
  assert.equal(isUnavailableAnswer(result.text), true);
});

test("extractAnswer: malformed input does not throw and is reported, not silently empty", () => {
  const malformed = [
    respondFrame("x", { input: undefined }), // field absent
    respondFrame("x", { input: "not json" }),
    respondFrame("x", { input: "[1,2]" }), // JSON, but an array
    respondFrame("x", { input: '"hi"' }), // JSON, but a string
    respondFrame("x", { input: JSON.stringify({ Response: 42 }) }), // wrong type
    respondFrame("x", { input: JSON.stringify({ response: "nope" }) }), // lowercase key
  ];
  for (const frame of malformed) {
    const result = extractAnswer([frame]);
    assert.equal(result.status, "malformed-respond", `input=${JSON.stringify(frame.input)}`);
    assert.equal(result.text, "");
    assert.equal(result.malformedRespondFrames, 1);
  }
});

test("extractAnswer: a silent turn yields empty without throwing", () => {
  for (const input of [null, undefined, {}, [], [null, null]]) {
    const result = extractAnswer(input);
    assert.equal(result.text, "");
    assert.ok(["no-frames", "no-respond-frame"].includes(result.status), String(result.status));
  }
  // Distinguishes a probe that threw (null) from a legitimately empty stream.
  assert.equal(extractAnswer(null).status, "no-frames");
  assert.equal(extractAnswer([]).status, "no-frames");
  assert.equal(extractAnswer([null, null]).status, "no-respond-frame");
});

test("extractAnswer: an EMPTY Response string is 'ok', not 'no answer'", () => {
  // The server did answer, emptily. That is a different defect from silence.
  const result = extractAnswer([respondFrame("")]);
  assert.equal(result.status, "ok");
  assert.equal(result.text, "");
});

test("LOAD-BEARING extractAnswer: a non-Respond action is never scored as the answer", () => {
  // PlayMusic carries prose (Track/Artist/Album). Scoring it would report the
  // album name as the assistant's spoken answer.
  const playMusic = respondFrame("unused", {
    action: "PlayMusic",
    input: JSON.stringify({ Track: "Sparks", Artist: "coldplay", Album: "Parachutes" }),
  });
  const playResult = extractAnswer([playMusic]);
  assert.equal(playResult.status, "no-respond-frame");
  assert.equal(playResult.text, "");
  assert.ok(!playResult.text.includes("Parachutes"));

  // UnderstandScene echoes the USER'S OWN WORDS back as {"Question": …}. An
  // extractor that scanned every input would score the user as the assistant.
  const utterance = "what am I looking at";
  const scene = respondFrame("unused", {
    action: "UnderstandScene",
    input: JSON.stringify({ Question: utterance }),
  });
  const sceneResult = extractAnswer([scene]);
  assert.equal(sceneResult.text, "");
  assert.notEqual(sceneResult.text, utterance);
});

test("extractAnswer: an observation frame is not an answer", () => {
  const result = extractAnswer([{ kind: "observation", actionName: "knowledge_lookup" }]);
  assert.equal(result.status, "no-respond-frame");
  assert.equal(result.text, "");
});

test("extractAnswer: a legacy-text frame is reported, not treated as silence", () => {
  const result = extractAnswer([{ kind: "other", isFinal: false, hasLegacyResponse: true }]);
  assert.equal(result.status, "legacy-text-dropped");
});

test("LOAD-BEARING extractAnswer: LAST Respond wins, not the longest", () => {
  // Kills longest-wins. The terminal answer is frequently the SHORTEST string in
  // the turn (measured min/median/max = 4/42/93 chars over the on-disk corpus).
  const result = extractAnswer([
    respondFrame("Let me think about the capital city of France for a moment."),
    respondFrame("Paris."),
  ]);
  assert.equal(result.text, "Paris.");
  assert.equal(result.frameIndex, 1);
  assert.equal(result.respondFrames, 2);
});

test("LOAD-BEARING extractAnswer: isFinal is NOT the terminal selector", () => {
  // The only production builder hard-codes is_final:false (actions.rs:36) and
  // it is false on 113/113 real frames. An implementation filtering on
  // isFinal===true would return nothing here.
  const result = extractAnswer([
    { kind: "action", thought: "", action: "Respond", input: "{}", isFinal: false },
    respondFrame("Rome.", { isFinal: false }),
  ]);
  assert.equal(result.text, "Rome.");
});

test("extractAnswer: cue + observation + terminal Respond picks the terminal", () => {
  const result = extractAnswer([
    { kind: "action", thought: "", action: "knowledge_lookup", input: "{}", isFinal: false },
    { kind: "observation", actionName: "knowledge_lookup" },
    respondFrame("Paris."),
  ]);
  assert.equal(result.text, "Paris.");
  assert.equal(result.frameIndex, 2);
  assert.equal(result.interimCueFrames, 1);
});

test("extractAnswer: a malformed Respond before a good one does not hide the good one", () => {
  const result = extractAnswer([
    respondFrame("x", { input: "not json" }),
    respondFrame("Berlin."),
  ]);
  assert.equal(result.status, "ok");
  assert.equal(result.text, "Berlin.");
  assert.equal(result.malformedRespondFrames, 1);
});

test("LOAD-BEARING: the server's own timeout fallback is flagged as unavailable", () => {
  // stock_deadline.rs:40-41. Before this, isUnavailableAnswer returned false for
  // it, so a timed-out turn scored as a WRONG ANSWER and was blamed on the
  // planner instead of the environment.
  const fallback = "I couldn't finish that request in time. Please try again.";
  const result = extractAnswer([respondFrame("A good earlier answer."), respondFrame(fallback)]);
  assert.equal(result.text, fallback);
  assert.equal(isUnavailableAnswer(fallback), true);
});

test("LOAD-BEARING: the curly apostrophe U+2019 is matched, not just ASCII", () => {
  // The model emits U+2019; the ASCII-only pattern was unreachable on real text
  // (measured in 8 of 109 extracted answers on disk).
  assert.equal(isUnavailableAnswer("I can’t help with that."), true);
  assert.equal(isUnavailableAnswer("I can't help with that."), true);
});

test("raw tool machinery spoken as an answer is flagged", () => {
  // A real artifact's spoken answer, verbatim.
  const leak = "<tool_call_result>Tool call failed: function not found</tool_call_result>";
  assert.equal(isMachineryLeak(leak), true);
  assert.equal(isMachineryLeak("Paris."), false);
  assert.equal(evaluateAnswer({ id: "x" }, leak).pass, false);
});

// ---- evaluateAnswer -----------------------------------------------------

test("LOAD-BEARING evaluateAnswer: an unavailable reply FAILS even though it is short and well-formed", () => {
  // This is the whole reason answer-scoring exists: the error reply is FASTER
  // than a real answer and carries a valid Respond action, so an action-and-
  // latency reading scored the broken backend as the winner.
  const score = evaluateAnswer(
    { id: "answer-arithmetic", expectAnswer: ["12"] },
    "Codex is unavailable on the host. Check its login status.",
  );
  assert.equal(score.checked, true);
  assert.equal(score.pass, false);
  assert.match(score.reason, /unavailable/);
});

test("evaluateAnswer: an unavailable reply fails even for a case with NO expectAnswer", () => {
  const score = evaluateAnswer({ id: "chitchat-joke" }, "Codex is unavailable on the host.");
  assert.equal(score.pass, false);
});

test("evaluateAnswer: correct content passes, wrong content fails", () => {
  const testCase = { id: "answer-arithmetic", expectAnswer: ["12"] };
  assert.equal(evaluateAnswer(testCase, "That is 12.").pass, true);
  assert.equal(evaluateAnswer(testCase, "That is 15.").pass, false);
});

test("evaluateAnswer: matching is case-insensitive", () => {
  assert.equal(evaluateAnswer({ expectAnswer: ["austen"] }, "Jane AUSTEN wrote it.").pass, true);
});

test("evaluateAnswer: no expectation is checked:false and never a pass", () => {
  const score = evaluateAnswer({ id: "definition" }, "Ubiquitous means everywhere.");
  assert.equal(score.checked, false);
  assert.equal(score.pass, null);
  assert.notEqual(score.pass, true);
});

test("evaluateAnswer: an empty answer fails a case that expects content", () => {
  const score = evaluateAnswer({ expectAnswer: ["12"] }, "");
  assert.equal(score.pass, false);
  assert.equal(score.reason, "empty answer");
});

test("LOAD-BEARING evaluateAnswer: no-frames fails EVERY case, answer-anchored or not", () => {
  // Under the old code a silent turn returned checked:false for any case
  // without expectAnswer, so it never blocked a pass — which is how a wedged
  // backend passed six forbid-only cases.
  const score = evaluateAnswer({ id: "chitchat-joke" }, { status: "no-frames", text: "" });
  assert.equal(score.checked, true);
  assert.equal(score.pass, false);
});

test("evaluateAnswer: malformed-respond fails every case", () => {
  const score = evaluateAnswer({ id: "chitchat-joke" }, { status: "malformed-respond", text: "" });
  assert.equal(score.pass, false);
});

test("LOAD-BEARING evaluateAnswer: a device-action turn is NOT an answer failure", () => {
  // PlayMusic / GetCurrentTime / IncrementVolume legitimately have no Respond
  // frame (4 real artifacts). Failing these would re-create the same false-red
  // the original bug produced, in a new place — and music-pause, music-next and
  // every volume case are exactly this shape.
  const score = evaluateAnswer({ id: "music-pause" }, { status: "no-respond-frame", text: "" });
  assert.equal(score.checked, false);
  assert.notEqual(score.pass, false);

  // …but a case that explicitly demands spoken words still fails.
  const spoken = evaluateAnswer(
    { id: "answer-arithmetic", expectAnswer: ["12"] },
    { status: "no-respond-frame", text: "" },
  );
  assert.equal(spoken.pass, false);
});

test("evaluateAnswer: accepts a bare string (back-compatible with the old signature)", () => {
  assert.equal(evaluateAnswer({ expectAnswer: ["12"] }, "It is 12.").pass, true);
});

// ---- evaluateCase (contract pinned; probe.mjs imports this) --------------

test("evaluateCase: passes when expects are present and forbids are absent", () => {
  const score = evaluateCase({ expect: ["IncrementVolume"], forbid: ["SetVolume"] }, [
    "IncrementVolume",
  ]);
  assert.deepEqual(score, { missing: [], forbidden: [], pass: true });
});

test("evaluateCase: reports a missing expect", () => {
  const score = evaluateCase({ expect: ["PlayMusic"] }, ["Respond"]);
  assert.deepEqual(score.missing, ["PlayMusic"]);
  assert.equal(score.pass, false);
});

test("evaluateCase: reports a forbidden action", () => {
  const score = evaluateCase({ forbid: ["PlayMusic"] }, ["PlayMusic"]);
  assert.deepEqual(score.forbidden, ["PlayMusic"]);
  assert.equal(score.pass, false);
});

test("evaluateCase: a case with neither expect nor forbid passes on any actions", () => {
  assert.equal(evaluateCase({}, ["Anything"]).pass, true);
  assert.equal(evaluateCase({}, []).pass, true);
});

test("evaluateCase: matching is exact, not substring", () => {
  // "Volume" must not satisfy an expect for "IncrementVolume", and
  // "IncrementVolume" must not trip a forbid for "Volume".
  assert.equal(evaluateCase({ expect: ["IncrementVolume"] }, ["Volume"]).pass, false);
  assert.equal(evaluateCase({ forbid: ["Volume"] }, ["IncrementVolume"]).pass, true);
});

// ---- suite integrity ----------------------------------------------------

test("suite: no duplicate ids or prompts", () => {
  // Cases are matched to measured arms BY PROMPT TEXT, so a duplicate prompt
  // would silently score two cases against the same arm.
  const ids = SUITE.map((testCase) => testCase.id);
  const prompts = SUITE.map((testCase) => testCase.prompt);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(prompts).size, prompts.length);
});

test("suite: every case has an id, a prompt and a note", () => {
  for (const testCase of SUITE) {
    assert.ok(testCase.id, `case missing id: ${JSON.stringify(testCase)}`);
    assert.ok(testCase.prompt, `${testCase.id} missing prompt`);
    assert.ok(
      typeof testCase.note === "string" && testCase.note.length > 0,
      `${testCase.id} has no note — an expectation with no recorded reason cannot be audited`,
    );
  }
});

test("LOAD-BEARING suite: no case names an action that does not exist in the product", () => {
  // `current_time` and `TakePhoto` were asserted for weeks. Both exist nowhere
  // in the canonical product catalogs, so the expects could never pass and the forbid
  // could never trip. This is the check that would have caught both before the
  // baseline ran.
  for (const testCase of SUITE) {
    for (const name of [...(testCase.expect ?? []), ...(testCase.forbid ?? [])]) {
      assert.ok(
        !(name in KNOWN_ABSENT_ACTION_NAMES),
        `${testCase.id} names "${name}", which does not exist — use ${KNOWN_ABSENT_ACTION_NAMES[name]}`,
      );
    }
  }
});

test("LOAD-BEARING suite: corrected names are generated and referenced by the catalog", () => {
  // Reads both sides of the Tier-A seam rather than trusting the suite. Goes
  // red if a generated value or its live catalog reference changes without
  // the suite following.
  const catalog = readFileSync(
    path.join(REPO_ROOT, "runtime/core/src/synapse/catalog.rs"),
    "utf8",
  );
  const generated = readFileSync(
    path.join(REPO_ROOT, "runtime/core/src/tier_a.rs"),
    "utf8",
  );
  for (const [symbol, name] of [
    ["GET_CURRENT_TIME", NATIVE_ACTIONS.GET_CURRENT_TIME],
    ["CAPTURE_PHOTOGRAPH", NATIVE_ACTIONS.CAPTURE_PHOTOGRAPH],
  ]) {
    assert.ok(
      generated.includes(`pub const ${symbol}: &str = "${name}";`),
      `${name} is absent from the generated Rust Tier-A binding`,
    );
    assert.ok(
      catalog.includes(`native_actions::${symbol}`),
      `${name} is not referenced by catalog.rs`,
    );
  }
  for (const absent of Object.keys(KNOWN_ABSENT_ACTION_NAMES)) {
    assert.ok(
      !catalog.includes(`"${absent}"`) &&
        !generated.includes(`"${absent}"`),
      `"${absent}" now EXISTS in the Tier-A binding or catalog — KNOWN_ABSENT_ACTION_NAMES is stale`,
    );
  }
});

test("suite: expectAnswer and expect are non-empty arrays when present", () => {
  for (const testCase of SUITE) {
    for (const key of ["expect", "forbid", "expectAnswer"]) {
      if (testCase[key] === undefined) continue;
      assert.ok(Array.isArray(testCase[key]), `${testCase.id}.${key} is not an array`);
      assert.ok(testCase[key].length > 0, `${testCase.id}.${key} is an empty array`);
    }
  }
});

test("suite: every case is scoreable — it has an expect, a forbid, or an expectAnswer", () => {
  for (const testCase of SUITE) {
    const scoreable =
      (testCase.expect?.length ?? 0) +
      (testCase.forbid?.length ?? 0) +
      (testCase.expectAnswer?.length ?? 0);
    assert.ok(scoreable > 0, `${testCase.id} asserts nothing at all`);
  }
});

test("suite: a measurement case must explain how to promote or delete it", () => {
  // Guards the flag against becoming a silent escape hatch for a failing case.
  for (const testCase of SUITE.filter((candidate) => candidate.measurement)) {
    assert.match(
      testCase.note,
      /promote|delete/i,
      `${testCase.id} is a measurement but its note does not say what would resolve it`,
    );
  }
});

// ---- golden corpus ------------------------------------------------------

test("LOAD-BEARING extractAnswer: exact tally over every on-disk artifact", (t) => {
  // This is the check that makes a field-name typo impossible to pass: the
  // count of successfully extracted answers must equal the independently
  // counted number of Respond frames. The original bug scored 0 here.
  const listing = execFileSync(
    "bash",
    ["-lc", "find test-runs -name responses.json 2>/dev/null | sort"],
    { encoding: "utf8", cwd: REPO_ROOT },
  ).trim();
  const files = listing ? listing.split("\n").filter(Boolean) : [];
  if (files.length === 0) {
    // Artifacts are gitignored, so a clean checkout has none. Skip the CURRENT
    // test loudly (t.skip, not test.skip — the latter would register a new
    // skipped test and let this one pass vacuously) rather than passing on an
    // empty corpus.
    t.skip("no test-runs artifacts present in this checkout");
    return;
  }

  const tally = { ok: 0, "no-frames": 0, "no-respond-frame": 0 };
  let respondFrames = 0;
  for (const file of files) {
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(path.join(REPO_ROOT, file), "utf8"));
    } catch {
      parsed = null;
    }
    const result = extractAnswer(parsed);
    tally[result.status] = (tally[result.status] ?? 0) + 1;
    if (Array.isArray(parsed)) {
      for (const frame of parsed) {
        if (frame && frame.kind === "action" && frame.action === "Respond") respondFrames += 1;
      }
    }
  }

  if (respondFrames === 0) {
    t.skip("test-runs artifacts contain no Respond frames to audit");
    return;
  }

  assert.equal(
    tally.ok,
    respondFrames,
    "extracted answers must equal the independently counted Respond frames",
  );
  assert.equal(tally.ok + tally["no-frames"] + tally["no-respond-frame"], files.length);
  assert.ok(tally.ok > 0, "no answer extracted from any artifact — the extractor is blind");
});
