/*
 * The wearer-language boundary, mirrored from the Pin.
 *
 * The Pin's spoken side owns the canonical corpus
 * (pin/runtime/core/src/synapse/chat_turn_loop/speech.rs): internal vocabulary
 * that must never reach a fixed wearer-facing string, the canned chatbot
 * filler, and the apology loop. Center presents the same product on a screen,
 * so its own system-authored wearer strings are held to the same register —
 * verify/wearer-language.test.mjs cross-checks this list against the Pin
 * source so the two cannot drift apart.
 *
 * These guards are for FIXED, system-authored strings and final error
 * presentation only. A wearer's note, a contact name, a search result, or any
 * quoted model answer is their content; it is never rewritten or rejected for
 * containing these terms.
 */

/** Internal terms that must not appear in fixed wearer-facing strings. */
export const INTERNAL_VOCABULARY: readonly string[] = [
  "in this run",
  "this run",
  "run",
  "call id",
  "tool step",
  "tool",
  "tools",
  "observation",
  "preflight",
  "iteration",
  "catalog",
  "grounding",
  "grounded",
  "mutation",
  "utterance",
  "trusted current user",
  "trusted user",
  "provider",
  "backend",
  "codex",
  "bridge",
  "tls",
  "http",
  "endpoint",
  "process",
  "agentic",
  "correlation",
  "schema",
  "payload",
  "json",
  "grpc",
  "token",
  "tokens",
  "as an ai",
  "language model",
  "llm",
  "system prompt",
];

/** Canned chatbot filler that performs helpfulness instead of answering. */
export const CANNED_FILLER: readonly string[] = [
  "i can help with that",
  "let me",
  "i would be happy to",
  "as requested",
];

/**
 * Normalise text for word-boundary matching, the same way the Pin does:
 * lowercase, every non-alphanumeric character becomes a separator, padded so a
 * term matches with its own boundaries included.
 */
export function normalizedForVocabulary(text: string): string {
  let normalized = " ";
  for (const character of text) {
    if (/[\p{L}\p{N}]/u.test(character)) {
      normalized += character.toLowerCase();
    } else if (!normalized.endsWith(" ")) {
      normalized += " ";
    }
  }
  if (!normalized.endsWith(" ")) normalized += " ";
  return normalized;
}

/** The first internal-vocabulary term present in `text`, if any. */
export function internalVocabularyHit(text: string): string | null {
  const haystack = normalizedForVocabulary(text);
  return (
    INTERNAL_VOCABULARY.find((term) => haystack.includes(normalizedForVocabulary(term))) ?? null
  );
}

/** The first canned-filler phrase present in `text`, if any. */
export function cannedFillerHit(text: string): string | null {
  const haystack = normalizedForVocabulary(text);
  return CANNED_FILLER.find((phrase) => haystack.includes(normalizedForVocabulary(phrase))) ?? null;
}

/**
 * True when `text` apologises more than once. One apology can be honest; a
 * second in the same message is filler.
 */
export function isApologyLoop(text: string): boolean {
  const haystack = normalizedForVocabulary(text);
  let count = 0;
  for (const term of ["sorry", "i apologize", "apologies"]) {
    const needle = normalizedForVocabulary(term);
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      count += 1;
      index = haystack.indexOf(needle, index + 1);
    }
  }
  return count > 1;
}
