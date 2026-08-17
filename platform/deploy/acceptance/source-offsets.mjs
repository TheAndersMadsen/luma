import assert from "node:assert/strict";

/*
 * Guarded offsets for the tests that assert ORDER inside a deploy script's
 * source text.
 *
 * Those tests read deploy.sh / rollback.sh / preflight.sh as a string and prove
 * things like "the wearer channel key is applied before the candidate starts"
 * by comparing `indexOf(a) < indexOf(b)`. That comparison has a hole big enough
 * to drive a whole outage through: `String.prototype.indexOf` and
 * `lastIndexOf` both answer -1 when the needle is absent, and -1 is smaller
 * than every real offset. So deleting `a` from the script does not fail the
 * assertion — it satisfies it. Two separate ordering tests in this directory
 * were entirely `-1 < n`, including the one whose name claims to prove that
 * CANDIDATE_ACTIVATION_ARMED is written before the candidate is started; the
 * marker was never pinned anywhere at all, and preflight.sh keys its crashed-
 * deploy recovery branch on exactly that file.
 *
 * Every offset that ends up on either side of a `<` must come from one of these
 * two, which fail loudly and name the token that went missing. Do not
 * reintroduce a bare indexOf/lastIndexOf into an ordering comparison.
 */

/**
 * Index of `event` in a recorded trace, asserting the event happened at all.
 *
 * The same -1 hole, one type over: `Array.prototype.indexOf` also answers -1 for
 * an absent element, so `events.indexOf("bridge-start") < firstCanary` is
 * satisfied by a recovery path that never started the bridge. The traces these
 * tests read are produced by running the real recovery function against stubbed
 * helpers, so a deleted call shows up here as a missing event and nowhere else.
 */
export function eventAt(events, event) {
  const index = events.indexOf(event);
  assert.ok(
    index >= 0,
    `the recovery path never recorded ${event}; recorded: ${events.join(", ")}`,
  );
  return index;
}

/** First offset of `needle` in `haystack`, asserting the token is present. */
export function at(haystack, needle) {
  const index = haystack.indexOf(needle);
  assert.ok(index >= 0, `missing from the script under test: ${needle}`);
  return index;
}

/**
 * Last offset of `needle` in `haystack`, asserting the token is present — and,
 * when `before` is given, that an occurrence exists at or before that offset.
 * The bounded form is what proves "X happens before the containers start"
 * rather than merely "X appears somewhere in the file".
 */
export function lastAt(haystack, needle, before) {
  const index = before === undefined ? haystack.lastIndexOf(needle) : haystack.lastIndexOf(needle, before);
  assert.ok(
    index >= 0,
    before === undefined
      ? `missing from the script under test: ${needle}`
      : `missing from the script under test before offset ${before}: ${needle}`,
  );
  return index;
}
