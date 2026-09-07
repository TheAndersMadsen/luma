import { PRIVACY_CLASSES, type PrivacyClass } from "./ambianceRuntime";
import { integer, record, UUID } from "./surfaces";
import { CLASS, device, privateClass, where } from "../turnOutcome";

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

export interface Candidate { surfaceId: string; channel: Channel; blocker: Blocker | null }
interface Action { actionId: string; surfaceId: string; channel: Channel; status: ActionStatus; failed: boolean }
/** One turn as the ledger tells it: content-free, so there is nothing here but routing. */
export interface LedgerTurn {
  turnId: string; generation: number; startedAt: number; origin: string; privacy: PrivacyClass;
  hint: RoutingTarget | null; expression: boolean; candidates: Candidate[];
  actions: Action[]; finished: boolean; cancelled: boolean;
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
  for (const item of events) {
    const event = record(item);
    if (event.version !== 3 || !integer(event.receipt_ms)) continue;
    const data = record(event.data);
    switch (data.kind) {
      case "turn_began": {
        const id = key(data.turn_id, data.generation);
        if (!id || !uuid(data.origin) || !oneOf(PRIVACY_CLASSES, data.privacy)) throw new Error("invalid_turn");
        turns.set(id, { turnId: lower(data.turn_id as string), generation: data.generation as number, startedAt: event.receipt_ms, origin: lower(data.origin),
          privacy: data.privacy, hint: null, expression: false, candidates: [], actions: [], finished: false, cancelled: false });
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
        else if (turn.actions.length < 16) turn.actions.push({ actionId: data.action_id, surfaceId: lower(data.surface_id), channel: data.channel, status: data.status, failed: false });
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
  for (const turn of turns.values()) turn.actions = turn.actions.filter(action => !expressions.has(action.actionId));
  return Array.from(turns.values()).reverse().slice(0, ACTIVITY_TURNS);
}

/** Kinds of approved surface by ID, from the owner's device lists; a missing entry is a device since removed. */
export type SurfaceKinds = ReadonlyMap<string, string>;
export interface ActivityRow {
  turnId: string;
  startedAt: number;
  asked: string;
  outcome: string;
  why: { candidates: string[]; hint: string | null; privacy: string; expression: boolean };
}

/** Why a device was passed over, as the end of a sentence. */
const BLOCKER: Record<Blocker, string> = {
  privacy: "private content is not allowed there",
  capability: "it cannot show this",
  unavailable: "its app was not in front",
};
const HINT: Record<RoutingTarget, string> = { browser: "the browser", macos: "the Mac", linux: "the Linux PC", android: "the phone", android_tv: "the TV" };
/** What each channel was asked to do, as the end of "X could …". */
const ACT: Record<Channel, string> = {
  "visual.card": "show a card", "audio.tts": "speak it", "action.open": "open it",
  "action.route": "show the way there", "action.play": "play it", "action.run": "run that task",
  "confirm.tap": "ask you to confirm",
};
const named = (kinds: SurfaceKinds, surfaceId: string) => kinds.has(surfaceId) ? device(kinds.get(surfaceId)) : "a removed device";
const placed = (kinds: SurfaceKinds, surfaceId: string) => kinds.has(surfaceId) ? where(kinds.get(surfaceId)) : "on a removed device";
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function outcome(turn: LedgerTurn, kinds: SurfaceKinds): string {
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
  if (turn.actions.length === 0 && turn.candidates.every(candidate => candidate.blocker !== null)) return "Nowhere to show it";
  return "Cannot confirm";
}

/** Plain words for the owner: where it was asked, what happened, and why each device was or was not chosen. */
export function activityRows(turns: LedgerTurn[], kinds: SurfaceKinds): ActivityRow[] {
  return turns.map(turn => ({
    turnId: turn.turnId,
    startedAt: turn.startedAt,
    asked: `Asked from ${named(kinds, turn.origin)}`,
    outcome: outcome(turn, kinds),
    why: {
      candidates: turn.candidates.map(candidate => {
        const act = ACT[candidate.channel];
        const name = capitalize(named(kinds, candidate.surfaceId));
        if (!candidate.blocker) return `${name} could ${act}.`;
        const reason = candidate.blocker !== "capability" ? BLOCKER[candidate.blocker]
          : candidate.channel === "audio.tts" ? "it cannot speak this"
          : candidate.channel === "visual.card" ? BLOCKER.capability
          : "it is not approved for that";
        return `${name} could not ${act} — ${reason}.`;
      }),
      hint: turn.hint ? `You asked for ${HINT[turn.hint]}` : null,
      privacy: CLASS[turn.privacy],
      expression: turn.expression,
    },
  }));
}
