/*
 * Notable events, the My Data surface, read and written on Cosmos's web
 * plane, the `notable-events` routes the recovered .Center called:
 *
 *   GET    /notable-events/mydata?domain&page&size   one page of a domain
 *   GET    /notable-events/mydata/overview?todayStart the Today / Total tiles
 *   GET    /ai-bus/search?domain&query&page&size      Ai Mic and Music search
 *   DELETE /notable-events/event/{id}                Forget
 *   POST   /notable-events/event/{id}/feedback       the Ai Mic vote
 *   DELETE /notable-events/event/{id}/feedback       withdraw the vote
 *
 * Cosmos decides which events belong to a domain, opens them, renames and
 * groups them, and counts them. This module forwards the wearer's identity and
 * reports provenance. It holds no domain rule of its own.
 *
 * Cosmos also serves the recovered `GET /notable-events/foodevents`. Center
 * does not read it. Stock records a meal as a `FoodLog` memory
 * (`FoodServiceWrapper.trackFoodItemConsumption` -> `CreateMemory`), which
 * Settings -> Food & nutrition reads through `/capture/food-log`. No stock app
 * constructs the `FoodConsumptionNotableEvent` or `FoodDetectedNotableEvent`
 * that feed the food events.
 */

import type { DomainRecord, EventVote, MyDataOverviewEntry } from "@/lib/contracts/events";
import { cosmosOverviewSchema, domainRecordSchemas, eventVoteResultSchema } from "@/lib/contracts/events";
import type { SpringPage } from "@/lib/contracts/pagination";
import { deletedSchema, springPageSchema } from "@/lib/contracts/pagination";
import { parseResponse } from "@/lib/contracts/parse";
import {
  COSMOS_ENABLED,
  COSMOS_WEBAPI_ENABLED,
  CosmosHttpError,
  Services,
  call,
  webapiGet,
  webapiRequest,
} from "../cosmos";
import {
  NOTHING_MATCHED,
  WEBAPI_UNSET_FOR_DELETE,
  boundedPageSize,
  failedGrpc,
  failedWebapi,
  live,
  unconfigured,
  webapiDelete,
  type Deleted,
  type Sourced,
} from "./provenance";

/** The My Data domains Center lists. */
export const MY_DATA_DOMAINS = ["AI_MIC", "CALL", "MUSIC", "TRANSLATION"] as const;
export type MyDataListDomain = (typeof MY_DATA_DOMAINS)[number];

export function isMyDataDomain(value: string): value is MyDataListDomain {
  return (MY_DATA_DOMAINS as readonly string[]).includes(value);
}

const WEBAPI_UNSET =
  "COSMOS_WEBAPI_BASE_URL is unset - this Center cannot read the wearer's notable events";

const EMPTY_PAGE: SpringPage<never> = {
  content: [],
  number: 0,
  size: 0,
  totalElements: 0,
  totalPages: 0,
  last: true,
  first: true,
  numberOfElements: 0,
  empty: true,
};

export interface EventPageRequest {
  /** Zero-based. */
  page?: number;
  size?: number;
}

function pageParams({ page = 0, size = 50 }: EventPageRequest): URLSearchParams {
  return new URLSearchParams({
    page: String(Number.isFinite(page) ? Math.max(0, Math.trunc(page)) : 0),
    size: String(boundedPageSize(size)),
  });
}

/** Rows Cosmos could not open for this wearer, said once for the whole page. */
function sealedNote(
  page: SpringPage<DomainRecord[MyDataListDomain]>,
): string | undefined {
  const sealed = page.content.filter((row) => row.data.sealed === true).length;
  return sealed
    ? `${sealed} entr${sealed === 1 ? "y" : "ies"} sealed under a key Cosmos does not hold`
    : undefined;
}

async function readPage(
  path: string,
  domain: MyDataListDomain,
): Promise<Sourced<SpringPage<DomainRecord[MyDataListDomain]>>> {
  if (!COSMOS_WEBAPI_ENABLED)
    return unconfigured(EMPTY_PAGE, "empty", WEBAPI_UNSET);
  try {
    const page = parseResponse(
      springPageSchema(domainRecordSchemas[domain]),
      await webapiGet(path),
    );
    // A sealed row exists and cannot be opened here. The read itself succeeded.
    return live(page, sealedNote(page));
  } catch (error) {
    return failedWebapi(EMPTY_PAGE, error);
  }
}

/** One page of a My Data domain, newest first, exactly as Cosmos pages it. */
export function getMyData(
  domain: MyDataListDomain,
  request: EventPageRequest = {},
): Promise<Sourced<SpringPage<DomainRecord[MyDataListDomain]>>> {
  const params = pageParams(request);
  params.set("domain", domain);
  return readPage(`/notable-events/mydata?${params}`, domain);
}

/**
 * The My Data domains Cosmos searches. Humane's own words: "Only Ai Mic and
 * Music events are searchable" (`services::events::SEARCHABLE_EVENT_TYPES`).
 */
export const MY_DATA_SEARCH_DOMAINS = ["AI_MIC", "MUSIC"] as const;
export type MyDataSearchDomain = (typeof MY_DATA_SEARCH_DOMAINS)[number];

export function isMyDataSearchDomain(value: string): value is MyDataSearchDomain {
  return (MY_DATA_SEARCH_DOMAINS as readonly string[]).includes(value);
}

/** The longest search Cosmos accepts, in characters (`MAX_QUERY_CHARS`). */
export const MY_DATA_SEARCH_MAX_CHARS = 256;

/**
 * One page of a searchable domain's events that hold `query`, newest first, in
 * the same row shape as {@link getMyData}, the recovered `search({query,
 * domain})`, served by Cosmos at `GET /ai-bus/search`. Cosmos keeps the index
 * and does the matching. Captures and notes have their own searches.
 */
export function searchMyData(
  domain: MyDataSearchDomain,
  query: string,
  request: EventPageRequest = {},
): Promise<Sourced<SpringPage<DomainRecord[MyDataListDomain]>>> {
  const params = pageParams(request);
  params.set("domain", domain);
  params.set("query", query);
  return readPage(`/ai-bus/search?${params}`, domain);
}

/** Center's name and page for each overview tile Cosmos counts. */
const OVERVIEW_TILES: Record<MyDataListDomain, { label: string; href: string }> = {
  AI_MIC: { label: "Ai Mic", href: "/my-data/ai-mic" },
  CALL: { label: "Calls", href: "/my-data/calls" },
  MUSIC: { label: "Music", href: "/my-data/music" },
  TRANSLATION: { label: "Translation", href: "/my-data/translation" },
};

/**
 * The My Data tiles, counted by Cosmos.
 *
 * `todayStart` is the wearer's own last midnight, as their browser knows it;
 * Cosmos counts "Today" from that instant. Anything that is not a date is
 * dropped rather than forwarded, and Cosmos then counts from midnight UTC.
 */
export async function getMyDataOverview(
  todayStart?: string | null,
): Promise<Sourced<MyDataOverviewEntry[]>> {
  if (!COSMOS_WEBAPI_ENABLED) return unconfigured([], "empty", WEBAPI_UNSET);
  const when = todayStart ? new Date(todayStart) : null;
  const params =
    when && !Number.isNaN(when.getTime())
      ? `?${new URLSearchParams({ todayStart: when.toISOString() })}`
      : "";
  try {
    const overview = parseResponse(
      cosmosOverviewSchema,
      await webapiGet(`/notable-events/mydata/overview${params}`),
    );
    return live(
      overview.domains.flatMap((entry) =>
        isMyDataDomain(entry.domain)
          ? [
              {
                key: entry.domain,
                ...OVERVIEW_TILES[entry.domain],
                today: entry.today,
                total: entry.total,
              },
            ]
          : [],
      ),
    );
  } catch (error) {
    return failedWebapi([], error);
  }
}

/**
 * Forget one notable event, the trash control on every My Data row.
 *
 * `events.proto` has no delete RPC. The web did it over REST, and Cosmos's
 * `DELETE /notable-events/event/{id}` is scoped to the signed-in wearer.
 */
export async function deleteEvent(eventIdentifier: string): Promise<Sourced<Deleted>> {
  if (!COSMOS_WEBAPI_ENABLED) {
    return unconfigured({ deleted: false }, "empty", WEBAPI_UNSET_FOR_DELETE);
  }
  try {
    const deleted = await webapiDelete(`/notable-events/event/${encodeURIComponent(eventIdentifier)}`);
    return deleted ? live({ deleted: true }) : live({ deleted: false }, NOTHING_MATCHED);
  } catch (error) {
    return failedWebapi({ deleted: false }, error);
  }
}

/** The wearer no longer has this event. */
export const EVENT_GONE = "This entry no longer exists.";

/**
 * Record the wearer's up/down vote on an Ai Mic answer, or withdraw it
 * (`vote: null`). `data` is the vote Cosmos now holds; `null` with a live
 * state and {@link EVENT_GONE} means the event is gone.
 */
export async function setEventVote(
  eventIdentifier: string,
  vote: EventVote | null,
): Promise<Sourced<{ vote: EventVote | null } | null>> {
  if (!COSMOS_WEBAPI_ENABLED) return unconfigured(null, "empty", WEBAPI_UNSET);
  const path = `/notable-events/event/${encodeURIComponent(eventIdentifier)}/feedback`;
  try {
    if (vote === null) {
      parseResponse(deletedSchema, await webapiRequest("DELETE", path));
      return live({ vote: null });
    }
    const stored = parseResponse(
      eventVoteResultSchema,
      await webapiRequest("POST", path, { vote }),
    );
    return live({ vote: stored.vote });
  } catch (error) {
    if (error instanceof CosmosHttpError && error.status === 404)
      return live(null, EVENT_GONE);
    return failedWebapi(null, error);
  }
}

const NOTABLE_EVENTS_UNSET =
  "Cosmos gRPC is unset - this Center cannot read the wearer's notable events";

/**
 * Is the gRPC plane answering, for this wearer?
 *
 * One event type, one result, and a one-hour window, so the store's WHERE
 * clause does the narrowing. It exercises the same service, metadata and
 * wearer identity the Pin-facing workloads use, so it fails exactly when they
 * do. Carries no data, the answer is the state.
 */
export async function getGrpcHealth(): Promise<Sourced<null>> {
  if (!COSMOS_ENABLED) return unconfigured(null, "empty", NOTABLE_EVENTS_UNSET);
  const since = Math.floor(Date.now() / 1000) - 3600;
  try {
    await call(Services.events, "QueryEvents", {
      filters: {
        eventType: "humane.respond",
        eventStartTime: { seconds: String(since), nanos: 0 },
      },
      maxResults: 1,
    });
    return live(null);
  } catch (error) {
    return failedGrpc(null, error);
  }
}
