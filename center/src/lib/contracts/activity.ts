import { PRIVACY_CLASSES, type PrivacyClass } from "./ambianceRuntime";
import { integer, record, UUID } from "./surfaces";
import { CLASS, device, devices, privateClass, where } from "../turnOutcome";

/** How many ledger events one Activity read asks Cosmos for, newest last. */
export const LEDGER_LIMIT = 300;
/** How many turns the page shows. */
export const ACTIVITY_TURNS = 50;
export const CHANNELS = ["visual.card", "audio.tts", "action.open", "action.route", "action.play", "action.run", "confirm.tap"] as const;
export type Channel = typeof CHANNELS[number];
/** Channels that change something about the world rather than showing or saying it. */
const ACTION_CHANNELS: readonly Channel[] = ["action.open", "action.route", "action.play", "action.run"];
export const BLOCKERS = ["privacy", "capability", "unavailable"] as const;
export type Blocker = typeof BLOCKERS[number];
export const ROUTING_TARGETS = ["browser", "macos", "linux", "android", "android_tv"] as const;
export type RoutingTarget = typeof ROUTING_TARGETS[number];
const ACTION_STATUSES = ["proposed", "awaiting_grant", "dispatched", "acknowledged", "running", "completed", "refused", "failed", "cancelled", "outcome_unknown"] as const;
type ActionStatus = typeof ACTION_STATUSES[number];
/** How a confirmation ceremony ended. */
const GRANT_OUTCOMES = ["granted", "declined", "expired", "voided"] as const;
type GrantOutcome = typeof GRANT_OUTCOMES[number];
/** What the executing installation proved about the person who confirmed. */
const ATTESTATIONS = ["foreground_tap", "device_owner_auth"] as const;
type Attestation = typeof ATTESTATIONS[number];
const RISKS = ["low", "moderate", "high"] as const;
type Risk = typeof RISKS[number];
/** The device's own account of what happened. `unknown` is honest and common; it is never rounded up. */
const REPORT_OUTCOMES = ["completed", "refused", "failed", "cancelled", "unknown"] as const;
type ReportOutcome = typeof REPORT_OUTCOMES[number];
const EVIDENCE_KINDS = ["open", "route", "playback", "command", "declined"] as const;
type EvidenceKind = typeof EVIDENCE_KINDS[number];
const REVOKE_REASONS = ["cancelled", "preempted", "superseded", "expired", "revalidation_failed"] as const;
type RevokeReason = typeof REVOKE_REASONS[number];

export interface Candidate { surfaceId: string; channel: Channel; blocker: Blocker | null }
/** One ceremony: the sentence a person was asked to answer at the device that would act. */
interface Grant {
  grantId: string; actionId: string; venueSurfaceId: string; risk: Risk;
  outcome: GrantOutcome | null; attestation: Attestation | null; dwellMs: number | null;
}
/** What the executing device said afterwards. Only this may claim an effect happened. */
interface Report { outcome: ReportOutcome; evidence: EvidenceKind; exitCode: number | null; elapsedMs: number }
interface Action {
  actionId: string; surfaceId: string; channel: Channel; status: ActionStatus; failed: boolean;
  report: Report | null; revoked: RevokeReason | null;
}
/** One turn as the ledger tells it: content-free, so there is nothing here but routing. */
export interface LedgerTurn {
  turnId: string; generation: number; startedAt: number; origin: string; privacy: PrivacyClass;
  hint: RoutingTarget | null; expression: boolean; candidates: Candidate[];
  actions: Action[]; grants: Grant[];
  /** Six device actions in ten minutes, or one already in flight. */
  budget: { windowMs: number; limit: number } | null;
  /** The surface whose newer request voided this turn while its effect was still live. */
  preemptedBy: string | null;
  finished: boolean; cancelled: boolean;
}

const uuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const lower = (value: string) => value.toLowerCase();
const oneOf = <T extends string>(names: readonly T[], value: unknown): value is T => names.some(name => name === value);

/**
 * Folds the runtime ledger into turns. Unknown or older event kinds are skipped, not
 * rejected: the ledger grows new kinds and this page only reads the routing story.
 * Events that name a turn this window never saw begin are ignored.
 */
export function parseLedgerTurns(value: unknown): LedgerTurn[] {
  const { events } = record(value);
  if (!Array.isArray(events) || events.length > LEDGER_LIMIT) throw new Error("invalid_ledger");
  const turns = new Map<string, LedgerTurn>();
  const expressions = new Set<string>();
  const key = (turnId: unknown, generation: unknown) => uuid(turnId) && integer(generation, 1) ? `${turnId}:${generation}` : null;
  /** A turn named by an event's own fence rather than by flat fields. */
  const fenced = (value: unknown) => {
    const fence = record(value);
    return turns.get(key(fence.turn_id, fence.generation) ?? "");
  };
  /** The turn that holds one action; some events carry only the action they belong to. */
  const holding = (actionId: unknown) => uuid(actionId)
    ? Array.from(turns.values()).find(turn => turn.actions.some(action => action.actionId === actionId)) : undefined;
  for (const item of events) {
    const event = record(item);
    if (event.version !== 3 || !integer(event.receipt_ms)) continue;
    const data = record(event.data);
    switch (data.kind) {
      case "turn_began": {
        const id = key(data.turn_id, data.generation);
        if (!id || !uuid(data.origin) || !oneOf(PRIVACY_CLASSES, data.privacy)) throw new Error("invalid_turn");
        turns.set(id, { turnId: lower(data.turn_id as string), generation: data.generation as number, startedAt: event.receipt_ms, origin: lower(data.origin),
          privacy: data.privacy, hint: null, expression: false, candidates: [], actions: [], grants: [], budget: null, preemptedBy: null, finished: false, cancelled: false });
        break;
      }
      case "decision": {
        const turn = turns.get(key(data.turn_id, data.generation) ?? "");
        if (!turn) break;
        if (data.expression === true) {
          turn.expression = true;
          if (uuid(data.action_id)) expressions.add(data.action_id);
          break;
        }
        if (data.hint !== undefined && !oneOf(ROUTING_TARGETS, data.hint) || !Array.isArray(data.candidates) || data.candidates.length > 64) throw new Error("invalid_decision");
        turn.hint = data.hint === undefined ? null : data.hint;
        turn.candidates = data.candidates.map(value => {
          const candidate = record(value);
          if (!uuid(candidate.surface_id) || !oneOf(CHANNELS, candidate.channel)
            || candidate.blocker !== null && !oneOf(BLOCKERS, candidate.blocker)) throw new Error("invalid_candidate");
          return { surfaceId: lower(candidate.surface_id), channel: candidate.channel, blocker: candidate.blocker };
        });
        break;
      }
      case "action_changed": {
        const turn = turns.get(key(data.turn_id, data.generation) ?? "");
        if (!turn) break;
        if (!uuid(data.action_id) || !uuid(data.surface_id) || !oneOf(CHANNELS, data.channel) || !oneOf(ACTION_STATUSES, data.status)) throw new Error("invalid_action");
        const action = turn.actions.find(candidate => candidate.actionId === data.action_id);
        if (action) { action.status = data.status; action.surfaceId = lower(data.surface_id); action.channel = data.channel; }
        else if (turn.actions.length < 16) turn.actions.push({ actionId: data.action_id, surfaceId: lower(data.surface_id), channel: data.channel, status: data.status, failed: false, report: null, revoked: null });
        break;
      }
      // A confirmation ceremony was put in front of a person at the exact
      // installation that would carry the command out.
      case "grant_requested": {
        if (!uuid(data.grant_id) || !uuid(data.action_id) || !uuid(data.venue_surface) || !oneOf(RISKS, data.risk)) throw new Error("invalid_grant");
        const turn = fenced(data.fence);
        if (!turn || turn.grants.length >= 16) break;
        turn.grants.push({ grantId: data.grant_id, actionId: data.action_id, venueSurfaceId: lower(data.venue_surface),
          risk: data.risk, outcome: null, attestation: null, dwellMs: null });
        break;
      }
      // How the ceremony ended, and how long the person took. Habituation is
      // instrumented, never celebrated.
      case "grant_resolved": {
        if (!uuid(data.grant_id) || !oneOf(GRANT_OUTCOMES, data.outcome) || !integer(data.dwell_ms)
          || data.attestation !== undefined && !oneOf(ATTESTATIONS, data.attestation)) throw new Error("invalid_grant");
        for (const turn of turns.values()) for (const grant of turn.grants) {
          if (grant.grantId !== data.grant_id) continue;
          grant.outcome = data.outcome;
          grant.attestation = data.attestation === undefined ? null : data.attestation;
          grant.dwellMs = data.dwell_ms;
        }
        break;
      }
      // The executing device's own account. Only this may say what happened.
      case "action_reported": {
        if (!uuid(data.action_id) || !oneOf(CHANNELS, data.channel) || !oneOf(REPORT_OUTCOMES, data.outcome)
          || !oneOf(EVIDENCE_KINDS, data.evidence) || !integer(data.elapsed_ms)
          || data.exit_code !== undefined && !Number.isSafeInteger(data.exit_code)) throw new Error("invalid_report");
        const action = holding(data.action_id)?.actions.find(candidate => candidate.actionId === data.action_id);
        if (action) action.report = { outcome: data.outcome, evidence: data.evidence,
          exitCode: data.exit_code === undefined ? null : data.exit_code as number, elapsedMs: data.elapsed_ms };
        break;
      }
      case "action_budget_exhausted": {
        if (!integer(data.window_ms, 1) || !integer(data.limit, 1)) throw new Error("invalid_budget");
        const turn = fenced(data.fence);
        if (turn) turn.budget = { windowMs: data.window_ms, limit: data.limit };
        break;
      }
      case "effect_revoked": {
        if (!uuid(data.action_id) || !oneOf(REVOKE_REASONS, data.reason)) throw new Error("invalid_revoke");
        const action = holding(data.action_id)?.actions.find(candidate => candidate.actionId === data.action_id);
        if (action) action.revoked = data.reason;
        break;
      }
      case "turn_preempted": {
        if (!uuid(data.by_surface)) throw new Error("invalid_preemption");
        const turn = turns.get(key(data.turn_id, data.generation) ?? "");
        if (turn) turn.preemptedBy = lower(data.by_surface);
        break;
      }
      case "delivery_failed": {
        for (const turn of turns.values()) for (const action of turn.actions) if (action.actionId === data.action_id) action.failed = true;
        break;
      }
      case "turn_finished": case "turn_cancelled": {
        const turn = turns.get(key(data.turn_id, data.generation) ?? "");
        if (turn) { if (data.kind === "turn_cancelled") turn.cancelled = true; else turn.finished = true; }
        break;
      }
      default: break;
    }
  }
  for (const turn of turns.values()) {
    turn.actions = turn.actions.filter(action => !expressions.has(action.actionId));
    turn.grants = turn.grants.filter(grant => !expressions.has(grant.actionId));
  }
  return Array.from(turns.values()).reverse().slice(0, ACTIVITY_TURNS);
}

/** Kinds of approved surface by ID, from the owner's device lists; a missing entry is a device since removed. */
export type SurfaceKinds = ReadonlyMap<string, string>;
export interface ActivityRow {
  turnId: string;
  startedAt: number;
  asked: string;
  outcome: string;
  why: {
    /** What actually happened, in order: the ceremony, the device's own report, a stop, a limit. */
    events: string[];
    candidates: string[];
    hint: string | null;
    privacy: string;
    expression: boolean;
  };
}

/** Why a device was passed over, as the end of a sentence: one device, then several. */
const BLOCKER: Record<Blocker, [string, string]> = {
  privacy: ["private content is not allowed there", "private content is not allowed there"],
  capability: ["it cannot show this", "they cannot show this"],
  unavailable: ["its app was not in front", "their apps were not in front"],
};
const CANNOT_SPEAK: [string, string] = ["it cannot speak this", "they cannot speak this"];
const NOT_APPROVED: [string, string] = ["it is not approved for that", "they are not approved for that"];
const HINT: Record<RoutingTarget, string> = { browser: "the browser", macos: "the Mac", linux: "the Linux PC", android: "the phone", android_tv: "the TV" };
/** What each channel was asked to do, as the end of "X could …". */
const ACT: Record<Channel, string> = {
  "visual.card": "show a card", "audio.tts": "speak it", "action.open": "open it",
  "action.route": "show the way there", "action.play": "play it", "action.run": "run that task",
  "confirm.tap": "ask you to confirm",
};
const named = (kinds: SurfaceKinds, surfaceId: string) => kinds.has(surfaceId) ? device(kinds.get(surfaceId)) : "a removed device";
const counted = (kinds: SurfaceKinds, surfaceId: string, count: number) =>
  kinds.has(surfaceId) ? devices(kinds.get(surfaceId), count) : count === 1 ? "a removed device" : `${count} removed devices`;
const placed = (kinds: SurfaceKinds, surfaceId: string) => kinds.has(surfaceId) ? where(kinds.get(surfaceId)) : "on a removed device";
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const seconds = (ms: number) => {
  const whole = Math.round(ms / 1000);
  return whole === 1 ? "1 second" : `${whole} seconds`;
};
const minutes = (ms: number) => {
  const whole = Math.round(ms / 60000);
  return whole === 1 ? "1 minute" : `${whole} minutes`;
};

/** Why a person was asked at all. Low risk never opens a ceremony, so it is never explained as one. */
const RISK_BECAUSE: Record<Risk, string> = {
  low: "",
  moderate: " because it runs a task on that device",
  high: " because it changes files on that device",
};

function ceremonyLines(turn: LedgerTurn, kinds: SurfaceKinds): string[] {
  return turn.grants.flatMap(grant => {
    const at = placed(kinds, grant.venueSurfaceId);
    const asked = `Cosmos asked you to confirm this ${at}${RISK_BECAUSE[grant.risk]}.`;
    if (grant.outcome === null) return [asked];
    const took = grant.dwellMs === null ? "" : grant.dwellMs < 1000 ? ", in under a second" : `, after ${seconds(grant.dwellMs)}`;
    const how = grant.attestation === "device_owner_auth" ? " by unlocking it" : "";
    const answer = grant.outcome === "granted" ? `You allowed it ${at}${how}${took}.`
      : grant.outcome === "declined" ? `You declined it ${at}${took}.`
        : grant.outcome === "expired" ? `The confirmation ${at} ran out of time, so nothing was done.`
          : `The confirmation ${at} stopped being valid before it was answered, so nothing was done.`;
    return [asked, answer];
  });
}

/** The device's own account. An acknowledgment claims nothing; only this does. */
function reportLine(action: Action, kinds: SurfaceKinds): string | null {
  if (!action.report) return null;
  const { outcome, evidence, exitCode, elapsedMs } = action.report;
  const name = capitalize(named(kinds, action.surfaceId));
  const took = action.channel === "action.run" && elapsedMs >= 1000 ? ` It ran for ${seconds(elapsedMs)}.` : "";
  if (outcome === "completed") {
    const what = action.channel === "action.run"
      ? exitCode === null || exitCode === 0 ? "reported that the task finished" : `reported that the task finished, with exit code ${exitCode}`
      : evidence === "playback" ? "reported that it is playing"
        : evidence === "route" ? "reported that it started the directions"
          : "reported that it opened it";
    return `${name} ${what}.${took}`;
  }
  if (outcome === "refused") return `${name} would not do it, and said so.${took}`;
  if (outcome === "failed") return `${name} tried and it did not work.${took}`;
  if (outcome === "cancelled") return `${name} stopped it before it finished.${took}`;
  return `${name} could not confirm what happened. It was not tried again.`;
}

const REVOKED: Record<RevokeReason, string> = {
  cancelled: "you cancelled it",
  preempted: "you asked for something else",
  superseded: "a newer answer replaced it",
  expired: "it ran out of time",
  revalidation_failed: "your permissions no longer allowed it",
};

function eventLines(turn: LedgerTurn, kinds: SurfaceKinds): string[] {
  const lines: string[] = [];
  if (turn.preemptedBy) lines.push(`You asked again from ${named(kinds, turn.preemptedBy)}, so Cosmos stopped this one.`);
  lines.push(...ceremonyLines(turn, kinds));
  for (const action of turn.actions) {
    const report = reportLine(action, kinds);
    if (report) lines.push(report);
  }
  const stopped = turn.actions.filter(action => action.revoked !== null);
  for (const action of stopped) {
    lines.push(`Cosmos told ${named(kinds, action.surfaceId)} to stop, because ${REVOKED[action.revoked!]}.`);
  }
  if (stopped.length) lines.push("Stopping ends the work. It cannot undo something that already opened.");
  if (turn.budget) {
    lines.push(`Cosmos had already started ${turn.budget.limit} device tasks in the last ${minutes(turn.budget.windowMs)}, so it started no more.`);
  }
  return lines;
}

function outcome(turn: LedgerTurn, kinds: SurfaceKinds): string {
  // A newer request from the owner voids a turn whose effect is still live.
  // The stopped task reports cancelled; it never reports completed.
  if (turn.preemptedBy) return "Stopped for your next request";
  if (turn.cancelled) return "Cancelled";
  // On an action channel a device can accept a command and then fail to carry
  // it out, so only its own report says what happened.
  const done = turn.actions.find(action => action.status === "completed");
  if (done) return `Done ${placed(kinds, done.surfaceId)}`;
  const refused = turn.actions.find(action => action.status === "refused" || action.status === "failed");
  if (refused) return `Not done ${placed(kinds, refused.surfaceId)}`;
  const shown = turn.actions.find(action => action.status === "acknowledged" && !ACTION_CHANNELS.includes(action.channel));
  if (shown) {
    if (shown.channel === "audio.tts") return `Spoken ${placed(kinds, shown.surfaceId)}`;
    return `${privateClass(turn.privacy) ? "Private reply" : "Shown"} ${placed(kinds, shown.surfaceId)}`;
  }
  if (turn.actions.some(action => action.status === "outcome_unknown" || action.failed)) return "Cannot confirm";
  const confirming = turn.actions.some(action => action.status === "awaiting_grant");
  if (confirming) return "Waiting for your confirmation…";
  const running = turn.actions.some(action => action.status === "running");
  if (running) return "Working on a device…";
  const open = turn.actions.some(action => action.status === "proposed" || action.status === "dispatched"
    || action.status === "acknowledged");
  if (!turn.finished) return open ? "Waiting for a device…" : "Working…";
  // Nothing was started because too many device tasks already were.
  if (turn.budget && turn.actions.length === 0) return "Not done";
  if (turn.actions.length === 0 && turn.candidates.every(candidate => candidate.blocker !== null)) return "Nowhere to show it";
  return "Cannot confirm";
}

/**
 * The candidate lines, with identical ones folded into a count. Two browser
 * tabs that both could not speak produced the same sentence twice, which read
 * as a stutter rather than as two devices.
 */
function candidateLines(turn: LedgerTurn, kinds: SurfaceKinds): string[] {
  const groups: { channel: Channel; blocker: Blocker | null; kind: string; surfaceId: string; count: number }[] = [];
  for (const candidate of turn.candidates) {
    const kind = kinds.get(candidate.surfaceId) ?? "";
    const found = groups.find(group => group.channel === candidate.channel && group.blocker === candidate.blocker && group.kind === kind);
    if (found) found.count++;
    else groups.push({ channel: candidate.channel, blocker: candidate.blocker, kind, surfaceId: candidate.surfaceId, count: 1 });
  }
  return groups.map(group => {
    const act = ACT[group.channel];
    const name = capitalize(counted(kinds, group.surfaceId, group.count));
    if (!group.blocker) return `${name} could ${act}.`;
    const many = group.count === 1 ? 0 : 1;
    const reason = group.blocker !== "capability" ? BLOCKER[group.blocker][many]
      : group.channel === "audio.tts" ? CANNOT_SPEAK[many]
        : group.channel === "visual.card" ? BLOCKER.capability[many]
          : NOT_APPROVED[many];
    return `${name} could not ${act} — ${reason}.`;
  });
}

/** Plain words for the owner: where it was asked, what happened, and why each device was or was not chosen. */
export function activityRows(turns: LedgerTurn[], kinds: SurfaceKinds): ActivityRow[] {
  return turns.map(turn => ({
    turnId: turn.turnId,
    startedAt: turn.startedAt,
    asked: `Asked from ${named(kinds, turn.origin)}`,
    outcome: outcome(turn, kinds),
    why: {
      events: eventLines(turn, kinds),
      candidates: candidateLines(turn, kinds),
      hint: turn.hint ? `You asked for ${HINT[turn.hint]}` : null,
      privacy: CLASS[turn.privacy],
      expression: turn.expression,
    },
  }));
}
