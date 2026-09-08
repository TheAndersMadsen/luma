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
/**
 * One weighed device, as the runtime logs it. `shape_fit` is zero for a device
 * that was blocked and stands on the eligible floor otherwise; `attention` is
 * the one term that may be negative, and it is what "not in front" looks like
 * for a device that was still eligible.
 */
const candidate = (surface_id: string, channel: string, blocker: string | null,
  shape_fit = blocker === null ? 1200 : 0, attention = 0) =>
  ({ surface_id, channel, blocker, score_version: 3, shape_fit, origin_affinity: 0, hint: 0, attention, preference: 0 });
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
    "Your Mac could show a card.", "Your phone could show a card.", "Your TV could not show a card — it was not connected.",
    "Your phone could not speak it — it cannot speak this.",
  ], events: [], choice: [], hint: "You asked for the Mac", privacy: "This reply was safe to show on a screen other people can see.", expression: false });
  expect(rows[6].why).toEqual({ candidates: [
    "Your phone could show a card.", "Your Mac could not show a card — private content is not allowed there.",
    "A browser could not show a card — private content is not allowed there.",
  ], events: [], choice: [], hint: null, privacy: "This reply was private to you.", expression: true });
  expect(rows[4].why.candidates).toEqual(["A browser could not show a card — private content is not allowed there.",
    "Your TV could not show a card — private content is not allowed there."]);
  expect(rows[0].why).toEqual({ candidates: [], events: [], choice: [], hint: null, privacy: "This reply was safe to show on a screen other people can see.", expression: false });
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

it("parses device action rows and says what the device reported, never what it accepted", () => {
  const began = event({ kind: "turn_began", turn_id: turn(20), generation: 1, origin: pin, request_digest: "c".repeat(64), privacy: "shared_room" });
  const changed = (status: string, channel: string, surface_id: string) =>
    event({ kind: "action_changed", action_id: action(20), turn_id: turn(20), generation: 1, status, channel,
      surface_id, incarnation: gone, content_digest: "d".repeat(64), deadline_ms: 5, attempt: 1 });
  const row = (events: unknown[]) => activityRows(parseLedgerTurns({ events }), kinds)[0];
  const decision = event({ kind: "decision", turn_id: turn(20), generation: 1, action_id: action(20), privacy: "shared_room",
    candidates: [candidate(tv, "action.play", null), candidate(mac, "action.run", "capability"), candidate(pin, "action.play", "capability")] });
  // Bound and legal at the device is not an outcome; only its report is.
  expect(row([began, decision, changed("dispatched", "action.play", tv)]).outcome).toBe("Waiting for a device…");
  expect(row([began, decision, changed("acknowledged", "action.play", tv)]).outcome).toBe("Waiting for a device…");
  expect(row([began, decision, changed("acknowledged", "confirm.tap", mac)]).outcome).toBe("Waiting for a device…");
  expect(row([began, decision, changed("running", "action.run", mac)]).outcome).toBe("Working on a device…");
  expect(row([began, decision, changed("awaiting_grant", "action.run", mac)]).outcome).toBe("Waiting for your confirmation…");
  expect(row([began, decision, changed("completed", "action.play", tv)]).outcome).toBe("Done on your TV");
  expect(row([began, decision, changed("refused", "action.run", mac)]).outcome).toBe("Not done on your Mac");
  expect(row([began, decision, changed("failed", "action.run", mac)]).outcome).toBe("Not done on your Mac");
  expect(row([began, decision, changed("outcome_unknown", "action.play", tv)]).outcome).toBe("Cannot confirm");
  expect(row([began, decision, changed("completed", "action.play", tv)]).why.candidates).toEqual([
    "Your TV could play it.",
    "Your Mac could not run that task — it is not approved for that.",
    "Your Ai Pin could not play it — it is not approved for that.",
  ]);
  // The ceremony channel is named in the owner's own words too.
  expect(row([began, event({ kind: "decision", turn_id: turn(20), generation: 1, action_id: action(20), privacy: "shared_room",
    candidates: [candidate(mac, "confirm.tap", null)] })]).why.candidates).toEqual(["Your Mac could ask you to confirm."]);
  // Nothing about an action names an operation, a locator or a digest.
  const text = JSON.stringify(row([began, decision, changed("completed", "action.play", tv)]));
  for (const secret of ["d".repeat(64), gone, tv, "action.play"]) expect(text).not.toContain(secret);
});

it("does not count a repaired status indicator as delivery of the reply", () => {
  const events = [
    event({ kind: "turn_began", turn_id: turn(21), generation: 1, origin: phone, privacy: "shared_room" }),
    event({ kind: "decision", turn_id: turn(21), generation: 1, action_id: null, privacy: "shared_room",
      candidates: [candidate(mac, "visual.card", "unavailable")] }),
    event({ kind: "decision", turn_id: turn(21), generation: 1, action_id: action(21), privacy: "shared_room", expression: true,
      candidates: [candidate(tv, "visual.card", null)] }),
    event({ kind: "repair", previous_action: action(21), action_id: action(22), surface_id: mac, candidates: [candidate(mac, "visual.card", null)] }),
    event({ kind: "repair", previous_action: action(22), action_id: action(23), surface_id: phone, candidates: [candidate(phone, "visual.card", null)] }),
    event({ kind: "action_changed", action_id: action(23), turn_id: turn(21), generation: 1, status: "acknowledged", channel: "visual.card", surface_id: phone }),
    event({ kind: "turn_finished", turn_id: turn(21), generation: 1 }),
  ];
  const [row] = activityRows(parseLedgerTurns({ events }), kinds);
  expect(row.outcome).toBe("Nowhere to show it");
  expect(row.why.expression).toBe(true);
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

/*
 * The ledger kinds the device-action release added. Each one has to reach the
 * owner as a sentence: a page that skipped them would show a turn with an
 * outcome and no account of how it got there.
 */
const fence = (turnId: string) => ({ turn_id: turnId, generation: 1, worker: gone, origin_surface: pin });

it("says every new ledger kind in one plain sentence, and still skips a kind it has never seen", () => {
  const began = event({ kind: "turn_began", turn_id: turn(30), generation: 1, origin: pin, request_digest: "c".repeat(64), privacy: "shared_room" });
  const decision = event({ kind: "decision", turn_id: turn(30), generation: 1, action_id: action(30), privacy: "shared_room",
    candidates: [candidate(mac, "action.run", null)] });
  const changed = (status: string) => event({ kind: "action_changed", action_id: action(30), turn_id: turn(30), generation: 1, status,
    channel: "action.run", surface_id: mac, incarnation: gone, content_digest: "d".repeat(64), deadline_ms: 5, attempt: 1 });
  const grantId = "30000000-0000-4000-8000-000000000001";
  const row = (events: unknown[]) => activityRows(parseLedgerTurns({ events }), kinds)[0];

  // A ceremony asked for, and answered, with the dwell time it took.
  const asked = event({ kind: "grant_requested", fence: fence(turn(30)), grant_id: grantId, action_id: action(30),
    venue_surface: mac, risk: "high", expires_at_ms: 30_000 });
  expect(row([began, decision, changed("awaiting_grant"), asked]).why.events)
    .toEqual(["Cosmos asked you to confirm this on your Mac because it changes files on that device."]);
  const resolved = (outcome: string, dwell_ms: number, attestation?: string) =>
    event({ kind: "grant_resolved", grant_id: grantId, action_id: action(30), venue_surface: mac, outcome, dwell_ms,
      ...(attestation === undefined ? {} : { attestation }) });
  expect(row([began, decision, changed("awaiting_grant"), asked, resolved("granted", 3200, "device_owner_auth")]).why.events[1])
    .toBe("You allowed it on your Mac by unlocking it, after 3 seconds.");
  // Habituation is instrumented, never celebrated: a reflex answer is visible.
  expect(row([began, decision, changed("awaiting_grant"), asked, resolved("granted", 400, "foreground_tap")]).why.events[1])
    .toBe("You allowed it on your Mac, in under a second.");
  expect(row([began, decision, changed("awaiting_grant"), asked, resolved("declined", 5000)]).why.events[1])
    .toBe("You declined it on your Mac, after 5 seconds.");
  expect(row([began, decision, changed("awaiting_grant"), asked, resolved("expired", 30_000)]).why.events[1])
    .toBe("The confirmation on your Mac ran out of time, so nothing was done.");
  expect(row([began, decision, changed("awaiting_grant"), asked, resolved("voided", 1200)]).why.events[1])
    .toBe("The confirmation on your Mac stopped being valid before it was answered, so nothing was done.");

  // Only the device's own report may say what happened.
  const reported = (outcome: string, evidence: string, extra: Record<string, unknown> = {}) =>
    event({ kind: "action_reported", action_id: action(30), channel: "action.run", outcome, evidence,
      evidence_digest: "e".repeat(64), elapsed_ms: 14_000, attempt: 1, ...extra });
  expect(row([began, decision, changed("completed"), reported("completed", "command")]).why.events)
    .toEqual(["Your Mac reported that the task finished. It ran for 14 seconds."]);
  // Exit code one is a finished task, not a failure.
  expect(row([began, decision, changed("completed"), reported("completed", "command", { exit_code: 1 })]).why.events[0])
    .toBe("Your Mac reported that the task finished, with exit code 1. It ran for 14 seconds.");
  expect(row([began, decision, changed("refused"), reported("refused", "declined")]).why.events[0])
    .toBe("Your Mac would not do it, and said so. It ran for 14 seconds.");
  expect(row([began, decision, changed("failed"), reported("failed", "command")]).why.events[0])
    .toBe("Your Mac tried and it did not work. It ran for 14 seconds.");
  expect(row([began, decision, changed("outcome_unknown"), reported("unknown", "command")]).why.events[0])
    .toBe("Your Mac could not confirm what happened. It was not tried again.");

  // A stop, with the honesty that stopping is not undoing.
  const revoked = row([began, decision, changed("cancelled"),
    event({ kind: "effect_revoked", action_id: action(30), reason: "preempted" })]);
  expect(revoked.why.events).toEqual([
    "Cosmos told your Mac to stop, because you asked for something else.",
    "Stopping ends the work. It cannot undo something that already opened.",
  ]);

  // A newer request voided a turn whose effect was still live.
  const preempted = row([began, decision, changed("running"),
    event({ kind: "turn_preempted", turn_id: turn(30), generation: 1, by_surface: phone })]);
  expect(preempted.outcome).toBe("Stopped for your next request");
  expect(preempted.why.events[0]).toBe("You asked again from your phone, so Cosmos stopped this one.");

  // The budget is where the owner learns why nothing was started.
  const exhausted = row([began, event({ kind: "action_budget_exhausted", fence: fence(turn(30)), window_ms: 600_000, limit: 6 }),
    event({ kind: "turn_finished", turn_id: turn(30), generation: 1 })]);
  expect(exhausted.outcome).toBe("Not done");
  expect(exhausted.why.events).toEqual(["Cosmos had already started 6 device tasks in the last 10 minutes, so it started no more."]);

  // A kind this page has never seen changes nothing and rejects nothing.
  const future = row([began, decision, changed("completed"), reported("completed", "command"),
    event({ kind: "effect_teleported", action_id: action(30), destination: "elsewhere" })]);
  expect(future.outcome).toBe("Done on your Mac");
  expect(future.why.events).toHaveLength(1);

  // None of it names an operation, a digest or a device id.
  const text = JSON.stringify(row([began, decision, changed("completed"), asked, resolved("granted", 900, "device_owner_auth"), reported("completed", "command")]));
  for (const secret of ["e".repeat(64), grantId, mac, "action.run", "device_owner_auth"]) expect(text).not.toContain(secret);
});

it("rejects a malformed new event rather than reading it as something else", () => {
  const began = event({ kind: "turn_began", turn_id: turn(31), generation: 1, origin: pin, request_digest: "c".repeat(64), privacy: "shared_room" });
  const grantId = "30000000-0000-4000-8000-000000000002";
  for (const bad of [
    event({ kind: "grant_requested", fence: fence(turn(31)), grant_id: grantId, action_id: action(31), venue_surface: mac, risk: "extreme", expires_at_ms: 1 }),
    event({ kind: "grant_requested", fence: fence(turn(31)), grant_id: "not-a-uuid", action_id: action(31), venue_surface: mac, risk: "low", expires_at_ms: 1 }),
    event({ kind: "grant_resolved", grant_id: grantId, action_id: action(31), venue_surface: mac, outcome: "maybe", dwell_ms: 1 }),
    event({ kind: "grant_resolved", grant_id: grantId, action_id: action(31), venue_surface: mac, outcome: "granted", dwell_ms: 1, attestation: "vibes" }),
    event({ kind: "action_reported", action_id: action(31), channel: "action.run", outcome: "probably", evidence: "command", evidence_digest: "e".repeat(64), elapsed_ms: 1, attempt: 1 }),
    event({ kind: "action_reported", action_id: action(31), channel: "action.run", outcome: "completed", evidence: "vibes", evidence_digest: "e".repeat(64), elapsed_ms: 1, attempt: 1 }),
    event({ kind: "action_budget_exhausted", fence: fence(turn(31)), window_ms: 0, limit: 6 }),
    event({ kind: "effect_revoked", action_id: action(31), reason: "bored" }),
    event({ kind: "turn_preempted", turn_id: turn(31), generation: 1, by_surface: "phone" }),
  ]) {
    expect(() => parseLedgerTurns({ events: [began, bad] }), JSON.stringify(bad)).toThrow();
  }
});

it("folds identical candidate sentences into one, counted, instead of saying the same thing twice", () => {
  // Three tabs of the same browser are three surfaces, and the sentence about them is one.
  const tabs = [0, 1, 2].map(index => `d${index}dddddd-dddd-4ddd-8ddd-dddddddddd0${index}`);
  const many = new Map([...kinds, ...tabs.map(id => [id, "browser"] as const)]);
  const began = event({ kind: "turn_began", turn_id: turn(40), generation: 1, origin: pin, request_digest: "c".repeat(64), privacy: "shared_room" });
  const decision = event({ kind: "decision", turn_id: turn(40), generation: 1, action_id: action(40), privacy: "shared_room",
    candidates: [candidate(mac, "visual.card", null), ...tabs.map(id => candidate(id, "audio.tts", "capability"))] });
  const [row] = activityRows(parseLedgerTurns({ events: [began, decision] }), many);
  expect(row.why.candidates).toEqual([
    "Your Mac could show a card.",
    "3 browsers could not speak it — they cannot speak this.",
  ]);
  // One of a kind still reads as one of a kind.
  const single = event({ kind: "decision", turn_id: turn(40), generation: 1, action_id: action(40), privacy: "shared_room",
    candidates: [candidate(tabs[0], "audio.tts", "capability")] });
  expect(activityRows(parseLedgerTurns({ events: [began, single] }), many)[0].why.candidates)
    .toEqual(["A browser could not speak it — it cannot speak this."]);
  // Different devices of the same kind are still folded; different reasons are not.
  const mixed = event({ kind: "decision", turn_id: turn(40), generation: 1, action_id: action(40), privacy: "shared_room",
    candidates: [candidate(tabs[0], "visual.card", "unavailable"), candidate(tabs[1], "visual.card", "privacy")] });
  expect(activityRows(parseLedgerTurns({ events: [began, mixed] }), many)[0].why.candidates).toEqual([
    "A browser could not show a card — it was not connected.",
    "A browser could not show a card — private content is not allowed there.",
  ]);
});

/*
 * The runtime now reads what an answer is and sends it to the screen that
 * suits it. The owner should be able to read that back as a sentence: what
 * kind of reply it was, which screen that kind belongs on, and which other
 * screens would have done. No score and no weight ever reaches the page.
 */
const shaped = (shape: string | undefined, candidates: unknown[]) =>
  event({ kind: "decision", turn_id: turn(50), generation: 1, action_id: action(50), privacy: "shared_room",
    ...(shape === undefined ? {} : { shape }), candidates });

it("says what kind of answer it was and which screen that kind belongs on", () => {
  const began = event({ kind: "turn_began", turn_id: turn(50), generation: 1, origin: mac, request_digest: "c".repeat(64), privacy: "shared_room" });
  const why = (decision: unknown) => activityRows(parseLedgerTurns({ events: [began, decision] }), kinds)[0].why;

  // A list belongs on the screen everyone in the room can see.
  expect(why(shaped("roster", [candidate(tv, "visual.card", null, 1200), candidate(mac, "visual.card", null, 1120)])).choice).toEqual([
    "This was a list to choose from, and that belongs on your TV.",
    "Your Mac could have shown a card, but your TV suits this better.",
  ]);
  // Something to sit and read belongs on the screen you are sitting at.
  expect(why(shaped("passage", [candidate(mac, "visual.card", null, 1200), candidate(tv, "visual.card", null, 1040)])).choice).toEqual([
    "This was longer text to sit and read, and that belongs on your Mac.",
    "Your TV could have shown a card, but your Mac suits this better.",
  ]);
  // Two personal screens suit a glance equally; the page says so rather than
  // inventing a reason for the one that happened to win.
  expect(why(shaped("note", [candidate(mac, "visual.card", null, 1200), candidate(phone, "visual.card", null, 1200)])).choice).toEqual([
    "This was a short card to take in at a glance, and that belongs on your Mac.",
    "Your phone suited it just as well.",
  ]);
  // Equally suitable, and behind another window: the busy-or-locked term is
  // why it lost, and saying only "just as well" would leave that unexplained.
  expect(why(shaped("note", [candidate(mac, "visual.card", null, 1200), candidate(phone, "visual.card", null, 1200, -20)])).choice[1])
    .toBe("Your phone suited it just as well, but its app was not in front.");
  // Devices of the same kind fold, exactly as the candidate lines do.
  const tabs = [0, 1].map(index => `d${index}dddddd-dddd-4ddd-8ddd-dddddddddd0${index}`);
  const folded = shaped("passage", [candidate(mac, "visual.card", null, 1200), ...tabs.map(id => candidate(id, "visual.card", null, 1040))]);
  expect(activityRows(parseLedgerTurns({ events: [began, folded] }), new Map([...kinds, ...tabs.map(id => [id, "browser"] as const)]))[0].why.choice[1])
    .toBe("2 browsers could have shown a card, but your Mac suits this better.");
  // A logged preference is separate from both selection and delivery.
  const hinted = event({ kind: "decision", turn_id: turn(50), generation: 1, action_id: action(50), privacy: "shared_room",
    shape: "roster", hint: "macos", candidates: [candidate(mac, "visual.card", null, 1120), candidate(tv, "visual.card", null, 1200)] });
  expect(why(hinted).choice).toEqual([
    "This was a list to choose from. Your TV suited that shape best; Cosmos selected your Mac.",
  ]);
  expect(why(hinted).hint).toBe("You asked for the Mac");
  const unhinted = why(shaped("roster", [candidate(mac, "visual.card", null, 1120), candidate(tv, "visual.card", null, 1200, -20)]));
  expect(unhinted.choice).toEqual(why(hinted).choice);
  expect(unhinted.hint).toBeNull();
  expect(unhinted.choice.join(" ")).not.toMatch(/sent|because you asked/);
  // Every channel is named in the owner's words when it could have been used.
  expect(why(shaped("play", [candidate(tv, "action.play", null, 1200), candidate(phone, "action.play", null, 1120)])).choice[1])
    .toBe("Your phone could have played it, but your TV suits this better.");
  expect(why(shaped("utterance", [candidate(pin, "audio.tts", null, 1200), candidate(tv, "audio.tts", null, 1120)])).choice).toEqual([
    "This was a short answer to say out loud, and that belongs on your Ai Pin.",
    "Your TV could have spoken it, but your Ai Pin suits this better.",
  ]);
  // A turn decided before the runtime bound a shape says nothing about one,
  // and a turn where nothing was eligible has no choice to explain.
  expect(why(shaped(undefined, [candidate(mac, "visual.card", null, 1200)])).choice).toEqual([]);
  expect(why(shaped("roster", [candidate(mac, "visual.card", "privacy")])).choice).toEqual([]);
  // Not one line of it is a number.
  expect(JSON.stringify(why(shaped("roster", [candidate(tv, "visual.card", null, 1200), candidate(mac, "visual.card", null, 1120)]))))
    .not.toMatch(/1200|1120|score|fit|weight/iu);
});

it("keeps a device in the background apart from a device that is not connected", () => {
  const began = event({ kind: "turn_began", turn_id: turn(51), generation: 1, origin: pin, request_digest: "c".repeat(64), privacy: "shared_room" });
  const decision = event({ kind: "decision", turn_id: turn(51), generation: 1, action_id: action(51), privacy: "shared_room",
    shape: "utterance", candidates: [candidate(pin, "audio.tts", null, 1200), candidate(mac, "audio.tts", "unattended"),
      candidate(tv, "audio.tts", "unavailable")] });
  const { candidates } = activityRows(parseLedgerTurns({ events: [began, decision] }), kinds)[0].why;
  expect(candidates).toEqual([
    "Your Ai Pin could speak it.",
    "Your Mac could not speak it — its app was not in front.",
    "Your TV could not speak it — it was not connected.",
    "A device in the background is still connected. Only speech is lost, because speech cannot wait for it.",
  ]);
  // Several of a kind read as several, and the reminder is still said once.
  const macs = [0, 1].map(index => `b${index}bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb0${index}`);
  const many = new Map([...kinds, ...macs.map(id => [id, "macos"] as const)]);
  const several = event({ kind: "decision", turn_id: turn(51), generation: 1, action_id: action(51), privacy: "shared_room",
    shape: "utterance", candidates: macs.map(id => candidate(id, "audio.tts", "unattended")) });
  expect(activityRows(parseLedgerTurns({ events: [began, several] }), many)[0].why.candidates).toEqual([
    "2 Macs could not speak it — their apps were not in front.",
    "A device in the background is still connected. Only speech is lost, because speech cannot wait for it.",
  ]);
});

it("rejects a shape or a weighing term it has never seen rather than reading it as something else", () => {
  const began = event({ kind: "turn_began", turn_id: turn(52), generation: 1, origin: pin, request_digest: "c".repeat(64), privacy: "shared_room" });
  const decision = (data: Record<string, unknown>) =>
    event({ kind: "decision", turn_id: turn(52), generation: 1, action_id: action(52), privacy: "shared_room", candidates: [], ...data });
  for (const bad of [
    decision({ shape: "hologram" }),
    decision({ shape: null }),
    decision({ candidates: [{ ...candidate(mac, "visual.card", null), shape_fit: -1 }] }),
    decision({ candidates: [{ ...candidate(mac, "visual.card", null), shape_fit: "high" }] }),
    decision({ candidates: [{ ...candidate(mac, "visual.card", null), attention: 1.5 }] }),
    decision({ candidates: [{ ...candidate(mac, "visual.card", null), attention: "busy" }] }),
  ]) {
    expect(() => parseLedgerTurns({ events: [began, bad] }), JSON.stringify(bad)).toThrow();
  }
  // A decision logged before the busy-or-locked term existed carries none, and
  // is read as saying nothing about it rather than as saying it was in front.
  const { attention: _attention, ...older } = candidate(mac, "visual.card", null, 1200);
  const [turnRow] = parseLedgerTurns({ events: [began, decision({ shape: "note", candidates: [older, candidate(phone, "visual.card", null, 1200)] })] });
  expect(turnRow.candidates.map(item => item.background)).toEqual([false, false]);
  expect(activityRows([turnRow], kinds)[0].why.choice[1]).toBe("Your phone suited it just as well.");
});
