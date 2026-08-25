import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { OPERATIONAL_MARKERS as TIER_A_OPERATIONAL_MARKERS } from "./tier-a-symbols.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../pin");
const RUST_ROOT = path.join(ROOT, "runtime/core/src");

const OPERATIONAL_MARKERS = Object.freeze([
  TIER_A_OPERATIONAL_MARKERS.terminal_native_action.value,
  TIER_A_OPERATIONAL_MARKERS.time_budget_grace.value,
  TIER_A_OPERATIONAL_MARKERS.slow_model_step.value,
  TIER_A_OPERATIONAL_MARKERS.step_backend_error.value,
  TIER_A_OPERATIONAL_MARKERS.forcing_deterministic_terminal_action.value,
  TIER_A_OPERATIONAL_MARKERS.verification_gate_rejected.value,
  TIER_A_OPERATIONAL_MARKERS.final_answer.value,
  TIER_A_OPERATIONAL_MARKERS.first_step_retry.value,
  TIER_A_OPERATIONAL_MARKERS.observation_replayed.value,
  TIER_A_OPERATIONAL_MARKERS.artist_scoped_completion.value,
  TIER_A_OPERATIONAL_MARKERS.decline.value,
  TIER_A_OPERATIONAL_MARKERS.step_completed.value,
  TIER_A_OPERATIONAL_MARKERS.tool_executed.value,
  TIER_A_OPERATIONAL_MARKERS.mutation_rejected.value,
  TIER_A_OPERATIONAL_MARKERS.mutation.value,
]);

const LEGACY_VOCABULARY_ALLOWLIST = Object.freeze([
  {
    id: "retired-config-key",
    matches: (line) => /\bhermes_progress_turns\b/.test(line),
  },
  {
    id: "wire-label",
    matches: (line) => /"hermes_tool_loop"/.test(line),
  },
  {
    id: "operational-marker",
    matches: (line) => OPERATIONAL_MARKERS.some((marker) => line.includes(`"${marker}"`)),
  },
]);

function rustFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...rustFiles(absolute));
    if (entry.isFile() && entry.name.endsWith(".rs")) files.push(absolute);
  }
  return files.sort();
}

function classifyLegacyLine(line) {
  if (!/hermes/i.test(line)) return null;
  return LEGACY_VOCABULARY_ALLOWLIST.find((entry) => entry.matches(line))?.id ?? "unexpected";
}

function unexpectedLegacyStrings(line) {
  const code = line.split("//", 1)[0];
  const strings = [...code.matchAll(/"((?:\\.|[^"\\])*)"/g)]
    .map((match) => match[1])
    .filter((value) => /hermes/i.test(value));
  return strings.filter((value) => {
    if (OPERATIONAL_MARKERS.includes(value)) return false;
    if (value === "hermes_tool_loop") return false;
    if (value === "hermes_progress_turns") return false;
    if (value === "hermes_progress_turns = true") return false;
    return true;
  });
}

function forbiddenLegacyIdentifiers(line) {
  const code = line
    .split("//", 1)[0]
    .replaceAll(/"(?:\\.|[^"\\])*"/g, '""');
  return (code.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).filter(
    (identifier) =>
      /hermes/i.test(identifier) && identifier !== "hermes_progress_turns",
  );
}

test("Tier C Rust vocabulary has only explicit compatibility-contract carve-outs", () => {
  const files = rustFiles(RUST_ROOT);
  assert.ok(files.length > 100, "the guard must scan the real Rust source tree");
  assert.deepEqual(
    files.filter((file) => /hermes/i.test(path.relative(ROOT, file))),
    [],
    "no live Rust module path may retain the foreign project name",
  );

  const seen = new Set();
  const unexpected = [];
  const unexpectedStrings = [];
  const forbiddenIdentifiers = [];
  for (const file of files) {
    const relative = path.relative(ROOT, file);
    for (const [index, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
      const classification = classifyLegacyLine(line);
      if (!classification) continue;
      if (classification === "unexpected") {
        unexpected.push(`${relative}:${index + 1}: ${line.trim()}`);
      } else {
        seen.add(classification);
      }
      for (const value of unexpectedLegacyStrings(line)) {
        unexpectedStrings.push(`${relative}:${index + 1}: ${value}`);
      }
      for (const identifier of forbiddenLegacyIdentifiers(line)) {
        forbiddenIdentifiers.push(`${relative}:${index + 1}: ${identifier}`);
      }
    }
  }

  assert.deepEqual(unexpected, []);
  assert.deepEqual(unexpectedStrings, []);
  assert.deepEqual(forbiddenIdentifiers, []);
  assert.deepEqual(
    [...seen].sort(),
    LEGACY_VOCABULARY_ALLOWLIST.map((entry) => entry.id).sort(),
    "every carve-out must remain live and explicit",
  );
});

test("mutation fixture: a new foreign-named Rust type makes the guard red", () => {
  assert.equal(classifyLegacyLine("pub struct HermesSneak;"), "unexpected");
  assert.deepEqual(forbiddenLegacyIdentifiers("pub struct HermesSneak;"), [
    "HermesSneak",
  ]);
  assert.deepEqual(
    forbiddenLegacyIdentifiers(
      'pub struct HermesSneak; // hermes-agent external reference',
    ),
    ["HermesSneak"],
  );
  assert.deepEqual(
    forbiddenLegacyIdentifiers(
      'const HermesSneak: &str = "hermes_tool_loop";',
    ),
    ["HermesSneak"],
  );
});

test("mutation fixture: an unknown operational marker makes the guard red", () => {
  assert.equal(
    classifyLegacyLine('tracing::info!("<<< hermes marker that does not exist");'),
    "unexpected",
  );
  assert.deepEqual(
    unexpectedLegacyStrings(
      'tracing::info!(if x { "<<< hermes tool executed" } else { "<<< hermes new marker" });',
    ),
    ["<<< hermes new marker"],
  );
});
