// @vitest-environment node
import { expect, it } from "vitest";
import { ACTIVITY_TURNS, activityRows, LEDGER_LIMIT, parseLedgerTurns } from "./activity";

const phone = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const mac = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const tv = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const browser = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const pin = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const gone = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const turn = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const action = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const kinds = new Map([[phone, "android"], [mac, "macos"], [tv, "android_tv"], [browser, "browser"], [pin, "pin"]]);
let sequence = 0;
const event = (data: Record<string, unknown>, receipt_ms = 1_757_000_000_000 + sequence * 1000) =>
  ({ version: 3, principal: "U:owner", sequence: ++sequence, previous_hash: "a".repeat(64), receipt_ms, data });
const candidate = (surface_id: string, channel: string, blocker: string | null) =>
  ({ surface_id, channel, blocker, score_version: 1, shape_fit: 10, origin_affinity: 0, hint: 0, preference: 0 });
const enrollment = { version: 2, principal: "U:owner", sequence: ++sequence, previous_hash: "", kind: "surface.approved", surface_id: phone, revision: 1, receipt_ms: 1, visible: false, approved_manifest: {}, binding_digest: "b".repeat(64) };

function ledger() {
  return { events: [
    enrollment,
    // 1: asked on the phone, shown on the Mac after the phone was told to hold it.
    event({ kind: "turn_began", turn_id: turn(1), generation: 1, origin: phone, request_digest: "c".repeat(64), privacy: "shared_room" }),
    event({ kind: "decision", turn_id: turn(1), generation: 1, action_id: action(1), privacy: "shared_room", hint: "macos", candidates: [
      candidate(mac, "visual.card", null), candidate(phone, "visual.card", null), candidate(tv, "visual.card", "unavailable"), candidate(phone, "audio.tts", "capability")] }),
    event({ kind: "action_changed", action_id: action(1), turn_id: turn(1), generation: 1, status: "dispatched", channel: "visual.card", surface_id: mac, incarnation: gone, content_digest: "d".repeat(64), deadline_ms: 5, attempt: 1 }),
    event({ kind: "action_changed", action_id: action(1), turn_id: turn(1), generation: 1, status: "acknowledged", channel: "visual.card", surface_id: mac, incarnation: gone, content_digest: "d".repeat(64), deadline_ms: 5, attempt: 1 }),
    event({ kind: "turn_finished", turn_id: turn(1), generation: 1 }),
    // 2: a private request from the Mac, answered privately on the phone; the Mac got a shared-safe expression.
    event({ kind: "turn_began", turn_id: turn(2), generation: 1, origin: mac, request_digest: "c".repeat(64), privacy: "private" }),
    event({ kind: "private_context_offered", fence: { turn_id: turn(2), generation: 1, worker: gone, origin_surface: mac }, source: "notes", count: 2 }),
    event({ kind: "decision", turn_id: turn(2), generation: 1, action_id: action(2), privacy: "private", candidates: [
      candidate(phone, "visual.card", null), candidate(mac, "visual.card", "privacy"), candidate(browser, "visual.card", "privacy")] }),
    event({ kind: "decision", turn_id: turn(2), generation: 1, action_id: action(3), privacy: "shared_room", expression: true, candidates: [candidate(mac, "visual.card", null)] }),
    event({ kind: "action_changed", action_id: action(3), turn_id: turn(2), generation: 1, status: "acknowledged", channel: "visual.card", surface_id: mac, incarnation: gone, content_digest: "d".repeat(64), deadline_ms: 5, attempt: 1 }),
    event({ kind: "action_changed", action_id: action(2), turn_id: turn(2), generation: 1, status: "acknowledged", channel: "visual.card", surface_id: phone, incarnation: gone, content_digest: "d".repeat(64), deadline_ms: 5, attempt: 1 }),
    event({ kind: "turn_finished", turn_id: turn(2), generation: 1 }),
    // 3: spoken on the Pin.
    event({ kind: "turn_began", turn_id: turn(3), generation: 1, origin: pin, request_digest: "c".repeat(64), privacy: "shared_room" }),
    event({ kind: "decision", turn_id: turn(3), generation: 1, action_id: action(4), privacy: "shared_room", candidates: [candidate(pin, "audio.tts", null)] }),
    event({ kind: "action_changed", action_id: action(4), turn_id: turn(3), generation: 1, status: "acknowledged", channel: "audio.tts", surface_id: pin, incarnation: gone, content_digest: "d".repeat(64), deadline_ms: 5, attempt: 1 }),
    event({ kind: "turn_finished", turn_id: turn(3), generation: 1 }),
    // 4: nowhere to show it.
    event({ kind: "turn_began", turn_id: turn(4), generation: 1, origin: browser, request_digest: "c".repeat(64), privacy: "private" }),
    event({ kind: "decision", turn_id: turn(4), generation: 1, action_id: null, privacy: "private", candidates: [candidate(browser, "visual.card", "privacy"), candidate(tv, "visual.card", "privacy")] }),
    event({ kind: "turn_finished", turn_id: turn(4), generation: 1 }),
    // 5: cancelled while the removed device held it.
    event({ kind: "turn_began", turn_id: turn(5), generation: 1, origin: gone, request_digest: "c".repeat(64), privacy: "shared_room" }),
    event({ kind: "decision", turn_id: turn(5), generation: 1, action_id: action(5), privacy: "shared_room", candidates: [candidate(gone, "visual.card", null)] }),
    event({ kind: "action_changed", action_id: action(5), turn_id: turn(5), generation: 1, status: "dispatched", channel: "visual.card", surface_id: gone, incarnation: gone, content_digest: "d".repeat(64), deadline_ms: 5, attempt: 1 }),
    event({ kind: "turn_cancelled", turn_id: turn(5), generation: 1 }),
    // 6: the outcome is unknown.
    event({ kind: "turn_began", turn_id: turn(6), generation: 1, origin: phone, request_digest: "c".repeat(64), privacy: "shared_room" }),
    event({ kind: "decision", turn_id: turn(6), generation: 1, action_id: action(6), privacy: "shared_room", candidates: [candidate(tv, "visual.card", null)] }),
    event({ kind: "action_changed", action_id: action(6), turn_id: turn(6), generation: 1, status: "outcome_unknown", channel: "visual.card", surface_id: tv, incarnation: gone, content_digest: "d".repeat(64), deadline_ms: 5, attempt: 2 }),
    event({ kind: "turn_finished", turn_id: turn(6), generation: 1 }),
    // 7: still waiting.
    event({ kind: "turn_began", turn_id: turn(7), generation: 1, origin: phone, request_digest: "c".repeat(64), privacy: "shared_room" }),
    event({ kind: "screen_context_offered", fence: { turn_id: turn(7), generation: 1, worker: gone, origin_surface: phone }, app_digest: "e".repeat(64), bytes: 120 }),
    event({ kind: "decision", turn_id: turn(7), generation: 1, action_id: action(7), privacy: "shared_room", candidates: [candidate(mac, "visual.card", null)] }),
    event({ kind: "action_changed", action_id: action(7), turn_id: turn(7), generation: 1, status: "dispatched", channel: "visual.card", surface_id: mac, incarnation: gone, content_digest: "d".repeat(64), deadline_ms: 5, attempt: 1 }),
    // 8: just began.
    event({ kind: "turn_began", turn_id: turn(8), generation: 1, origin: mac, request_digest: "c".repeat(64), privacy: "shared_room" }),
    // A decision for a turn that began before this window is ignored, not shown as a turn.
    event({ kind: "decision", turn_id: turn(9), generation: 1, action_id: action(9), privacy: "shared_room", candidates: [] }),
  ] };
}

it("folds the ledger into newest-first turns and says in plain words where each was asked, what happened and why", () => {
  const rows = activityRows(parseLedgerTurns(ledger()), kinds);
  expect(rows.map(row => [row.asked, row.outcome])).toEqual([
    ["Asked from your Mac", "Working…"],
    ["Asked from your phone", "Waiting for a device…"],
    ["Asked from your phone", "Cannot confirm"],
    ["Asked from a removed device", "Cancelled"],
    ["Asked from a browser", "Nowhere to show it"],
    ["Asked from your Ai Pin", "Spoken on your Ai Pin"],
    ["Asked from your Mac", "Private reply on your phone"],
    ["Asked from your phone", "Shown on your Mac"],
  ]);
  expect(rows[7].why).toEqual({ candidates: [
    "Your Mac could show a card.", "Your phone could show a card.", "Your TV could not show a card — its app was not in front.",
    "Your phone could not speak it — it cannot speak this.",
  ], hint: "You asked for the Mac", privacy: "This reply was safe to show on a screen other people can see.", expression: false });
  expect(rows[6].why).toEqual({ candidates: [
    "Your phone could show a card.", "Your Mac could not show a card — private content is not allowed there.",
    "A browser could not show a card — private content is not allowed there.",
  ], hint: null, privacy: "This reply was private to you.", expression: true });
  expect(rows[4].why.candidates).toEqual(["A browser could not show a card — private content is not allowed there.",
    "Your TV could not show a card — private content is not allowed there."]);
  expect(rows[0].why).toEqual({ candidates: [], hint: null, privacy: "This reply was safe to show on a screen other people can see.", expression: false });
  expect(rows.map(row => row.startedAt)).toEqual([...rows.map(row => row.startedAt)].sort((a, b) => b - a));
  const text = JSON.stringify(rows);
  for (const secret of ["c".repeat(64), "d".repeat(64), "e".repeat(64), gone, phone, "U:owner", "notes"]) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/digest|incarnation|request/u);
});

it("shows every device as removed when no list could be read and bounds the window", () => {
  const rows = activityRows(parseLedgerTurns(ledger()), new Map());
  expect(rows[7].outcome).toBe("Shown on a removed device");
  expect(rows[5].outcome).toBe("Spoken on a removed device");
  expect(rows[7].asked).toBe("Asked from a removed device");
  const many = { events: Array.from({ length: ACTIVITY_TURNS + 5 }, (_, index) =>
    event({ kind: "turn_began", turn_id: turn(100 + index), generation: 1, origin: phone, request_digest: "c".repeat(64), privacy: "public" })) };
  const turns = parseLedgerTurns(many);
  expect(turns).toHaveLength(ACTIVITY_TURNS);
  expect(turns[0].turnId).toBe(turn(100 + ACTIVITY_TURNS + 4));
  expect(() => parseLedgerTurns({ events: Array.from({ length: LEDGER_LIMIT + 1 }, () => enrollment) })).toThrow("invalid_ledger");
  expect(parseLedgerTurns({ events: [] })).toEqual([]);
});

it("rejects malformed routing events instead of guessing", () => {
  const began = event({ kind: "turn_began", turn_id: turn(1), generation: 1, origin: phone, request_digest: "c".repeat(64), privacy: "shared_room" });
  for (const bad of [
    { ...began, data: { ...began.data, privacy: "secret" } },
    { ...began, data: { ...began.data, origin: "phone" } },
    event({ kind: "decision", turn_id: turn(1), generation: 1, action_id: null, privacy: "shared_room", hint: "watch", candidates: [] }),
    event({ kind: "decision", turn_id: turn(1), generation: 1, action_id: null, privacy: "shared_room", candidates: [candidate(mac, "visual.card", "busy")] }),
    event({ kind: "decision", turn_id: turn(1), generation: 1, action_id: null, privacy: "shared_room", candidates: [candidate(mac, "audio.file", null)] }),
    event({ kind: "action_changed", action_id: action(1), turn_id: turn(1), generation: 1, status: "delivered", channel: "visual.card", surface_id: mac, incarnation: gone, content_digest: "d".repeat(64), deadline_ms: 5, attempt: 1 }),
    "event",
  ]) {
    expect(() => parseLedgerTurns({ events: bad === began ? [bad] : [began, bad] }), JSON.stringify(bad)).toThrow();
  }
  expect(() => parseLedgerTurns({ turns: [] })).toThrow();
});
