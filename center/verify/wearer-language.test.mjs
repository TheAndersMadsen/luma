import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * The wearer-language boundary, Center side.
 *
 * The Pin owns the canonical corpus (chat_turn_loop/speech.rs); Center mirrors
 * it in src/lib/wearerLanguage.ts. This suite (1) pins the mirror to the Pin
 * source so the two cannot drift, (2) proves the guards catch every fixture
 * phrase the boundary is contracted to reject, and (3) holds Center's own
 * fixed wearer-facing strings to the register. User content — notes, contact
 * names, search results, quoted answers — is deliberately never scanned.
 */

const {
  INTERNAL_VOCABULARY,
  CANNED_FILLER,
  internalVocabularyHit,
  cannedFillerHit,
  isApologyLoop,
} = await import("../src/lib/wearerLanguage.ts");

const pinSpeech = await readFile(
  new URL("../../pin/runtime/core/src/synapse/chat_turn_loop/speech.rs", import.meta.url),
  "utf8",
);

test("the mirror carries every term the Pin's corpus carries", () => {
  const pinTerms = [...pinSpeech.matchAll(/^\s{4}\(\s*\n?\s*"([^"]+)",/gmu)].map((m) => m[1]);
  // The Rust corpus is tuples of (term, reason); collect terms from both the
  // single-line and wrapped tuple shapes.
  const singleLine = [...pinSpeech.matchAll(/^\s{4}\("([^"]+)", "/gmu)].map((m) => m[1]);
  const terms = new Set([...pinTerms, ...singleLine]);
  assert.ok(terms.size >= 30, `the Pin corpus scan found only ${terms.size} terms`);
  for (const term of terms) {
    const list = CANNED_FILLER.includes(term) ? CANNED_FILLER : INTERNAL_VOCABULARY;
    assert.ok(
      list.includes(term),
      `Pin corpus term is missing from the Center mirror: ${term}`,
    );
  }
});

test("the guards catch the canonical leaks, filler, and the apology loop", () => {
  for (const leak of [
    "As an AI, I cannot do that.",
    "I am a language model.",
    "The LLM backend failed.",
    "the backend did not answer",
    "the provider timed out",
    "that tool call failed",
    "per my system prompt",
    "the JSON was malformed",
  ]) {
    assert.ok(internalVocabularyHit(leak), `internal vocabulary guard missed: ${leak}`);
  }
  for (const filler of ["I can help with that!", "Let me check the weather."]) {
    assert.ok(cannedFillerHit(filler), `canned filler guard missed: ${filler}`);
  }
  assert.ok(isApologyLoop("Sorry — I apologize for the trouble."));
  assert.ok(!isApologyLoop("Sorry, that didn't work. Try again."));
  for (const fine of ["It's 12 degrees and clear.", "Saved.", "Your Pin couldn't be reached just now."]) {
    assert.equal(internalVocabularyHit(fine), null);
    assert.equal(cannedFillerHit(fine), null);
  }
});

test("Center's fixed wearer-facing strings hold the register", async () => {
  // The strings a wearer reads with no Pin in hand: the shared truth-state
  // components and the wearer pages' own empty/degraded/error lines. Operator
  // surfaces (/admin) keep their technical vocabulary on purpose, and server
  // `degraded` diagnostics are provenance detail rather than the headline.
  const surfaces = [
    "../src/components/Status.tsx",
    "../src/components/States.tsx",
    "../src/app/page.tsx",
    "../src/app/captures/page.tsx",
    "../src/app/notes/page.tsx",
  ];
  for (const surface of surfaces) {
    const raw = await readFile(new URL(surface, import.meta.url), "utf8");
    // Comments are the author talking to the next reader, not the wearer;
    // strip them before scanning so a quoted counter-example cannot fail the
    // gate. What remains is JSX text and string literals that reach a screen.
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/[^\n]*$/gm, "");
    for (const match of source.matchAll(/"([A-Z][^"\\]{10,140})"/g)) {
      const sentence = match[1];
      const vocabulary = internalVocabularyHit(sentence);
      assert.equal(
        vocabulary,
        null,
        `${surface}: fixed wearer string carries internal vocabulary (${vocabulary}): ${sentence}`,
      );
      assert.equal(
        cannedFillerHit(sentence),
        null,
        `${surface}: fixed wearer string is canned filler: ${sentence}`,
      );
      assert.ok(!isApologyLoop(sentence), `${surface}: apology loop: ${sentence}`);
    }
  }
});
