/*
 * Notable events — the My Data surface — read over the stock gRPC plane and
 * deleted over the clone's REST webapi, plus the gRPC health probe that
 * exercises the same service the panes do.
 */

import {
  CARRY_ENABLED,
  CARRY_WEBAPI_ENABLED,
  ORIGINATORS,
  Services,
  call,
  structToJson,
  type DomainKey,
} from "../cosmos";
import type { MyDataOverviewEntry } from "@/lib/types";
import {
  NOTHING_MATCHED,
  WEBAPI_UNSET_FOR_DELETE,
  failedGrpc,
  failedWebapi,
  live,
  tsToIso,
  unconfigured,
  webapiDelete,
  type Deleted,
  type Sourced,
} from "./provenance";

interface CarryEvent {
  eventIdentifier?: { value?: string };
  originatorIdentifier?: string;
  creationTime?: { seconds?: string | number; nanos?: number };
  /** google.protobuf.Struct — wire form, decode with structToJson. */
  eventData?: unknown;
  eventType?: string;
}

/** Maps a carry NotableEvent onto .Center's `{uuid, userCreatedAt, data:{eventData}}`. */
function toCenterEvent(e: CarryEvent) {
  return {
    uuid: e.eventIdentifier?.value ?? crypto.randomUUID(),
    userCreatedAt: tsToIso(e.creationTime),
    // event_data is a protobuf Struct on the wire; the UI wants plain JSON.
    data: { eventData: structToJson(e.eventData) },
  };
}

/**
 * QueryEvents does not promise an order. The dashboard renders the first Ai Mic
 * row, so order it here once for every consumer: newest first, then UUID as a
 * stable tie-breaker for events created in the same clock tick.
 */
function compareEventsNewestFirst(a: CarryEvent, b: CarryEvent): number {
  const aMs = timestampMs(a.creationTime);
  const bMs = timestampMs(b.creationTime);
  if (aMs !== bMs) return bMs - aMs;
  return (b.eventIdentifier?.value ?? "").localeCompare(a.eventIdentifier?.value ?? "");
}

function timestampMs(ts: CarryEvent["creationTime"]): number {
  const seconds = Number(ts?.seconds ?? 0);
  if (!Number.isFinite(seconds)) return 0;
  return seconds * 1000 + Math.floor((ts?.nanos ?? 0) / 1e6);
}

const NOTABLE_EVENTS_UNSET =
  "Carry gRPC is unset - this Center cannot read the wearer's notable events";

export async function getEvents(domain: DomainKey, max = 200): Promise<Sourced<unknown[]>> {
  // Never substitute recovered wearer data on an authenticated My Data route.
  // Empty + provenance is both safe and loud in the UI.
  if (!CARRY_ENABLED) return unconfigured([], "empty", NOTABLE_EVENTS_UNSET);
  try {
    const res = await call<
      { filters: { eventOriginatorId: string }; maxResults: number },
      { events?: CarryEvent[] }
    >(Services.events, "QueryEvents", {
      filters: { eventOriginatorId: ORIGINATORS[domain] },
      maxResults: max,
    });
    return live([...(res.events ?? [])].sort(compareEventsNewestFirst).map(toCenterEvent));
  } catch (error) {
    return failedGrpc([], error);
  }
}

/**
 * Forget one notable event — the trash control on every My Data row.
 *
 * That control has been rendered since the recovered original and has never had
 * a backend: `events.proto` carries only QueryEvents / Ingest / IngestBatch, so
 * there is no delete RPC to call and the button sat disabled. The clone's webapi
 * now exposes `DELETE /event/:id`, scoped to the caller's principal, which is
 * how the real .Center must have done it — it was a web app talking REST.
 *
 * Events are read over gRPC and deleted over REST, so the two planes have to
 * agree on who the wearer is. They do: `webapiHeaders` forwards the same Bearer
 * (or the same static principal) that `requestMetadata` sends, and the backend
 * collapses both to one `U:<user>` partition.
 */
export async function deleteEvent(eventIdentifier: string): Promise<Sourced<Deleted>> {
  if (!CARRY_WEBAPI_ENABLED) {
    return unconfigured({ deleted: false }, "empty", WEBAPI_UNSET_FOR_DELETE);
  }
  try {
    const deleted = await webapiDelete(`/event/${encodeURIComponent(eventIdentifier)}`);
    return deleted ? live({ deleted: true }) : live({ deleted: false }, NOTHING_MATCHED);
  } catch (error) {
    return failedWebapi({ deleted: false }, error);
  }
}

const OVERVIEW_META: Array<{ key: DomainKey; label: string; href: string }> = [
  { key: "AI_MIC", label: "Ai Mic", href: "/my-data/ai-mic" },
  { key: "CALL", label: "Calls", href: "/my-data/calls" },
  { key: "MUSIC", label: "Music", href: "/my-data/music" },
  { key: "TRANSLATION", label: "Translation", href: "/my-data/translation" },
];

/**
 * How far one overview tile counts.
 *
 * `DeviceEventsHistoryService` carries QueryEvents, Ingest and IngestBatch and
 * nothing else, so there is no count RPC: a total here is the LENGTH of what
 * came back, and every event that comes back is web-plane decrypted server side
 * (`project_event_for_web`) to produce one integer. The cap bounds that work; it
 * does not make it cheap, and past the cap the total is a floor rather than a
 * count — which is why reaching it is now said out loud instead of quietly
 * plateauing. Retiring both properly needs a counting endpoint on Cosmos.
 */
const OVERVIEW_MAX_RESULTS = 1000;

export async function getMyDataOverview(): Promise<Sourced<MyDataOverviewEntry[]>> {
  if (!CARRY_ENABLED) return unconfigured([], "empty", NOTABLE_EVENTS_UNSET);
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const entries = await Promise.all(
      OVERVIEW_META.map(async (meta) => {
        const res = await call<
          { filters: { eventOriginatorId: string }; maxResults: number },
          { events?: CarryEvent[] }
        >(Services.events, "QueryEvents", {
          filters: { eventOriginatorId: ORIGINATORS[meta.key] },
          maxResults: OVERVIEW_MAX_RESULTS,
        });
        const events = res.events ?? [];
        // An event with no creation time is not evidence that it happened today.
        // It used to be counted as one, because tsToIso substituted the current
        // time for the missing value.
        const today = events.filter((e) => {
          const when = new Date(tsToIso(e.creationTime));
          return !Number.isNaN(when.getTime()) && when >= startOfDay;
        }).length;
        return { ...meta, today, total: events.length };
      }),
    );

    // The store returns newest first, so a capped domain has counted its recent
    // events exactly and stopped; the tile's "Total" is then a lower bound. Say
    // which domains that applies to rather than reporting the cap as a count.
    const capped = entries.filter((entry) => entry.total >= OVERVIEW_MAX_RESULTS);
    return live(
      entries,
      capped.length > 0
        ? `${capped.map((entry) => entry.label).join(", ")}: at least ${OVERVIEW_MAX_RESULTS} events - totals are counted up to that point and no further`
        : undefined,
    );
  } catch (error) {
    return failedGrpc([], error);
  }
}

/**
 * Is the gRPC plane answering, for this wearer?
 *
 * /api/health used to ask this by calling `getMyDataOverview()` — four
 * QueryEvents at a thousand results each, every one of them decrypted server
 * side — from the SourceBadge in the chrome of every page, every 60 seconds,
 * to decide a single boolean. That made the honesty endpoint the heaviest call
 * in the system and put it first in line to blow CARRY_DEADLINE_MS, at which
 * point the badge reports a healthy backend as unreachable.
 *
 * One originator, one result, and a one-hour window so the store's WHERE clause
 * does the narrowing rather than a truncate after the fact. It exercises the
 * same service, the same metadata and the same wearer identity the panes use, so
 * it fails exactly when they do. Carries no data — the answer is the state.
 */
export async function getGrpcHealth(): Promise<Sourced<null>> {
  if (!CARRY_ENABLED) return unconfigured(null, "empty", NOTABLE_EVENTS_UNSET);
  const since = Math.floor(Date.now() / 1000) - 3600;
  try {
    await call<
      {
        filters: { eventOriginatorId: string; eventStartTime: { seconds: string; nanos: number } };
        maxResults: number;
      },
      { events?: CarryEvent[] }
    >(Services.events, "QueryEvents", {
      filters: {
        eventOriginatorId: ORIGINATORS.AI_MIC,
        eventStartTime: { seconds: String(since), nanos: 0 },
      },
      maxResults: 1,
    });
    return live(null);
  } catch (error) {
    return failedGrpc(null, error);
  }
}
