"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import * as z from "zod/mini";
import { capturePageSchema } from "./contracts/captures";
import { dashboardBodySchema } from "./contracts/dashboard";
import { domainRecordSchemas, myDataOverviewEntrySchema, type DomainRecord } from "./contracts/events";
import { healthInfoSchema, type HealthInfo } from "./contracts/health";
import { pairedPinsSchema, passcodeViewSchema } from "./contracts/account";
import { parseDeviceStatusResponse } from "./contracts/deviceStatus";
import { cosmosNoteSchema } from "./contracts/notes";
import { springPageSchema } from "./contracts/pagination";
import { parseResponse } from "./contracts/parse";
import { mapCosmosNote } from "./noteMapping";
import type { DataFallback, DataState } from "./contracts/dataSource";

/** Provenance parsed from the response headers written by server/headers.ts. */
export interface SourceInfo {
  /**
   * live, the wearer's own current data
   * absent, no counterpart in this backend. A retry cannot help
   * degraded, cosmos is configured and did not answer
   */
  state: DataState;
  /** What is on screen instead: recovered sample data, or nothing. */
  fallback?: DataFallback;
  degraded?: string;
  /**
   * The one degraded cause the wearer can fix themselves: their Keycloak grant
   * died behind a still-valid Center cookie.
   *
   * Emitted as `x-data-reauthenticate: 1` by src/server/headers.ts. It exists
   * because several of these routes answer with a bare JSON ARRAY and have
   * nowhere in the body to put it, and because until something READ it, every
   * expiry still rendered as "your Pin couldn't be reached", which sends the
   * wearer nowhere and whoever is on call to a Cosmos that is answering fine.
   */
  reauthenticate?: true;
}

/** A route that states no provenance claims nothing: absent, never live. */
function readState(value: string | null): DataState {
  return value === "live" || value === "degraded" ? value : "absent";
}

function readFallback(value: string | null): DataFallback | undefined {
  return value === "fixtures" || value === "empty" ? value : undefined;
}

async function fetchJson<T>(url: string, schema: z.ZodMiniType<T>): Promise<{ data: T } & SourceInfo> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const message =
      res.status === 401 || res.status === 403
        ? "Sign in again to continue."
        : res.status === 429
          ? "Too many requests. Try again shortly."
          : "Try again in a moment.";
    throw new Error(message);
  }
  return {
    data: parseResponse(schema, await res.json()),
    state: readState(res.headers.get("x-data-state")),
    fallback: readFallback(res.headers.get("x-data-fallback")),
    degraded: res.headers.get("x-data-degraded") ?? undefined,
    reauthenticate: res.headers.get("x-data-reauthenticate") === "1" ? true : undefined,
  };
}

/**
 * Memories. The original polled this every 5s with a 1s stale time and no
 * refetch on focus, preserved here.
 *
 * Cosmos answers the whole aggregate in one read and decides how many records
 * each slot carries. Keeps the aggregate state: this view renders all five
 * parts at once, so "any one of these is a stand-in" is exactly what it needs.
 * `data.provenance` is there for a per-card sentence.
 */
export function useDashboard() {
  return useQuery({
    queryKey: ["memories-dashboard"],
    queryFn: () => fetchJson("/api/capture/memories", dashboardBodySchema),
    refetchInterval: 5000,
    staleTime: 1000,
    refetchOnWindowFocus: false,
  });
}

/** Which page of notes to read. Cosmos pages and searches the whole account. */
export interface NotesQuery {
  /** Zero-based. */
  page?: number;
  size?: number;
  /** Matched by Cosmos against every note's title and text. */
  query?: string;
}

export function useNotes({ page: pageNumber = 0, size, query = "" }: NotesQuery = {}) {
  const needle = query.trim();
  return useQuery({
    queryKey: ["notes", pageNumber, size ?? null, needle],
    // The BFF mirrors the stock page envelope verbatim. The dashboard's
    // NoteRecord view is derived client-side from the raw rows while keeping
    // the provenance envelope intact.
    queryFn: async () => {
      const params = new URLSearchParams();
      if (pageNumber > 0) params.set("page", String(pageNumber));
      if (size !== undefined) params.set("size", String(size));
      if (needle) params.set("query", needle);
      const search = params.toString();
      const page = await fetchJson(
        `/api/capture/notes${search ? `?${search}` : ""}`, springPageSchema(cosmosNoteSchema),
      );
      // `data` is overwritten with the mapped rows, which destroys the Spring
      // envelope it came in, including `totalElements`, the only number that
      // knows how many notes the wearer has (or how many matched) beyond this
      // page. Keeping it, and the page position, beside the rows is what lets
      // /notes say "61–120 of 340" and offer the next page.
      return {
        ...page,
        data: page.data.content.map(mapCosmosNote),
        total: page.data.totalElements,
        pageNumber: page.data.number,
        totalPages: page.data.totalPages,
      };
    },
    // Keep the page on screen while the next one, or the next search, loads.
    placeholderData: (previous) => previous,
    // A note spoken on the Pin arrives asynchronously, just like an Ai Mic
    // event. Keep an already-open Notes view current without a manual reload.
    //
    // Foreground only. `refetchIntervalInBackground` kept a hidden tab
    // decrypting the wearer's entire note history twelve times a minute for as
    // long as the tab existed, to update a view nobody was looking at;
    // `refetchOnWindowFocus: "always"` already makes it current the instant it
    // is looked at again.
    refetchInterval: 5000,
    refetchOnWindowFocus: "always",
    staleTime: 1000,
  });
}

/**
 * One note, read by uuid, so a note on any page opens. `data` is `null` both
 * when Cosmos says the wearer has no such note (`state: "live"`) and when the
 * read did not happen (any other state). Only the first is evidence it is gone.
 */
export function useNote(uuid: string) {
  return useQuery({
    queryKey: ["note", uuid],
    queryFn: async () => {
      const note = await fetchJson(
        `/api/capture/note/${encodeURIComponent(uuid)}`, z.nullable(cosmosNoteSchema),
      );
      return {
        ...note,
        data: note.data ? mapCosmosNote(note.data) : null,
        // An editor starts from a derived heading as a hint, not as a title.
        titleGenerated: note.data?.titleGenerated === true,
      };
    },
    refetchOnWindowFocus: "always",
    staleTime: 1000,
  });
}

/**
 * Captures alone, from the captures-only route.
 *
 * The state reported here is the CAPTURES leg's, not an aggregate's. Captures
 * and notes are read over the REST webapi. Ai Mic, music and calls travel over
 * separate gRPC workloads. Reading the aggregate meant a music QueryEvents
 * failure, or a webapi-only deployment, made a healthy backend that correctly
 * answered "you have no captures" render as "Couldn't reach the backend just
 * now." with a Try again that provably could not help. It also downloaded four
 * collections this view then discarded.
 *
 * `/api/capture/captures` answers with one leg, so the response's own
 * provenance IS the captures leg's and no narrowing is needed.
 * `state === "live" && !data.length` is true exactly when the captures backend
 * said the wearer has none.
 */
export function useCaptures(options: { favorites?: boolean } = {}) {
  const favorites = options.favorites === true;
  return useInfiniteQuery({
    // Under the `["captures"]` prefix, so every invalidation of the grid
    // reaches each filter's pages.
    queryKey: ["captures", { favorites }],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const res = await fetchJson(`/api/capture/captures?page=${pageParam}${favorites ? "&favorites=1" : ""}`, capturePageSchema);
      // Same reason as useNotes: `total` is what the wearer HAS, `data.length`
      // is what one capped page holds, and only the first of those two is a fact
      // about their library. `last` is Cosmos's word on whether a further page
      // exists, so the grid can walk the whole library 200 at a time.
      return {
        ...res,
        data: res.data.photos ?? [],
        total: res.data.total,
        page: res.data.page ?? pageParam,
        last: res.data.last !== false,
      };
    },
    getNextPageParam: (lastPage) => (lastPage.last ? undefined : lastPage.page + 1),
    // The favourites filter is another key under the same prefix. Keep the
    // previous filter's page on screen while the new one loads, so toggling
    // does not blank the whole view, toolbar and search field included,
    // into the initial skeleton.
    placeholderData: (previous) => previous,
    staleTime: 5000,
  });
}

/**
 * The wearer's last local midnight: only their browser knows it exactly,
 * daylight-saving days included. Cosmos counts "Today" from it.
 */
function localMidnightIso(now: Date = new Date()): string {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight.toISOString();
}

/**
 * The four My Data counters, counted by Cosmos without opening a single event.
 * Foreground only; `refetchOnWindowFocus` makes the tiles current the moment
 * the tab is looked at again.
 */
export function useMyDataOverview() {
  return useQuery({
    queryKey: ["mydata-overview"],
    queryFn: () =>
      fetchJson(
        `/api/notable-events/mydata/overview?todayStart=${encodeURIComponent(localMidnightIso())}`, z.array(myDataOverviewEntrySchema),
      ),
    refetchInterval: 5000,
    refetchOnWindowFocus: "always",
    staleTime: 1000,
  });
}

/** Rows per My Data page. Older pages load on request. */
export const MY_DATA_PAGE_SIZE = 50;

/**
 * One My Data domain, newest first, a page at a time: Cosmos pages the whole
 * history, so nothing past the first page is out of reach.
 *
 * Foreground only: each refetch opens every loaded row server side, and a
 * hidden tab does not need that twelve times a minute. `refetchOnWindowFocus`
 * still makes the list current the moment the tab is looked at again.
 */
export function useMyData<K extends keyof DomainRecord>(domain: K, { enabled = true } = {}) {
  return useInfiniteQuery({
    queryKey: ["mydata", domain],
    enabled,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const res = await fetchJson(
        `/api/notable-events/mydata?domain=${domain}&page=${pageParam}&size=${MY_DATA_PAGE_SIZE}`, springPageSchema(domainRecordSchemas[domain]),
      );
      // `totalElements` is how many events the wearer has in this domain, not
      // how many this page holds.
      return {
        ...res,
        data: res.data.content,
        total: res.data.totalElements,
        page: res.data.number ?? pageParam,
        last: res.data.last !== false,
      };
    },
    getNextPageParam: (lastPage) => (lastPage.last ? undefined : lastPage.page + 1),
    refetchInterval: 5000,
    refetchOnWindowFocus: "always",
    staleTime: 1000,
  });
}

/** The My Data domains Cosmos searches ("Only Ai Mic and Music events are searchable"). */
export type SearchableDomain = "AI_MIC" | "MUSIC";

/**
 * The events of a searchable domain that hold `query`, newest first, a page at
 * a time. Cosmos keeps the index and does the matching over the whole history.
 *
 * Not polled: every search reads the domain's whole index server side, so it
 * runs when the query changes and when the tab is looked at again.
 */
export function useMyDataSearch<K extends SearchableDomain>(domain: K | null, query: string) {
  const needle = query.trim();
  return useInfiniteQuery({
    queryKey: ["mydata-search", domain, needle],
    enabled: domain !== null && needle !== "",
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({
        domain: domain ?? "",
        query: needle,
        page: String(pageParam),
        size: String(MY_DATA_PAGE_SIZE),
      });
      const res = await fetchJson(`/api/ai-bus/search?${params}`, springPageSchema(domainRecordSchemas[domain ?? "AI_MIC"]));
      return {
        ...res,
        data: res.data.content,
        total: res.data.totalElements,
        page: res.data.number ?? pageParam,
        last: res.data.last !== false,
      };
    },
    getNextPageParam: (lastPage) => (lastPage.last ? undefined : lastPage.page + 1),
    // Keep the matches on screen while the next query's arrive.
    placeholderData: (previous) => previous,
    staleTime: 1000,
  });
}

/**
 * We asked and did not get an answer we can trust.
 *
 * Deliberately NOT "absent": that word is a claim about the deployment ("no Pin
 * backend is configured here"), and an unreadable probe is no evidence for it.
 * `degraded` with no `fallback` renders as "Couldn't reach the backend just
 * now.", which is what actually happened, and keeps the badge on screen. The
 * one component that tells a wearer they may be reading someone else's data
 * must not disappear at the moment the BFF breaks.
 */
function unknownHealth(detail: string, reauthenticate?: true): HealthInfo {
  return {
    // Unknown, not false. Nothing branches on these two; `state` is the signal.
    cosmosConfigured: false,
    reachable: false,
    state: "degraded",
    detail,
    reauthenticate,
  };
}

/**
 * Which backend answered. <SourceBadge> renders this in the chrome of every
 * page. It is the only thing that tells a wearer their Pin's backend went quiet
 * and what they are looking at instead.
 *
 * Every failure mode here has to be handled explicitly, because the badge's
 * whole value is that it does not guess. Parsing a non-2xx body as a health
 * payload used to turn an expired session into "no Pin backend is configured
 * for this .Center", a false statement about the deployment, made by the one
 * control that exists to stop false statements.
 */
export function useBackendHealth() {
  return useQuery({
    queryKey: ["backend-health"],
    queryFn: async (): Promise<HealthInfo> => {
      let res: Response;
      try {
        res = await fetch("/api/health");
      } catch (error) {
        return unknownHealth(
          error instanceof Error ? error.message : "Your Pin could not be reached.",
        );
      }

      if (!res.ok) {
        // 401 is the routine one: middleware answers /api/* that way once the
        // browser authorization lapses in a tab left open. Its body is an error, not health.
        // Flagged as well as described, so the badge can say "sign in again"
        // rather than "your Pin couldn't be reached", the sentence alone was
        // never read by anything that chooses the words on screen.
        if (res.status === 401) {
          return unknownHealth(
            "Reconnect to Center to continue.",
            true,
          );
        }
        const problem = await res.json().catch(() => null);
        if (problem?.authUnavailable === true) {
          return { ...unknownHealth("Center is reconnecting. Try again in a moment."), authUnavailable: true };
        }
        return unknownHealth("Your Pin could not be reached.");
      }

      const parsed = healthInfoSchema.safeParse(await res.json().catch(() => null));
      return parsed.success
        ? parsed.data
        : unknownHealth("Your Pin returned an unreadable status.");
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/*
 * Account facts several panes read under one cache key each. One hook per key
 * keeps one fetch and one validated shape behind it: two query functions under
 * the same key would leave whichever ran last deciding what every reader sees.
 */

/** Settings → Devices, the settings index and Pin setup. */
export function useDeviceStatus({ retry = true }: { retry?: boolean } = {}) {
  return useQuery({
    queryKey: ["device-status"],
    queryFn: async () => {
      const response = await fetch("/api/devices/status", {
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`/api/devices/status → ${response.status}`);
      return parseDeviceStatusResponse(await response.json());
    },
    retry,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

/** Settings → Devices and Pin setup. */
export function usePairedPins() {
  return useQuery({
    queryKey: ["paired-pins"],
    queryFn: async () => {
      const response = await fetch("/api/devices/pair", { cache: "no-store" });
      if (!response.ok) throw new Error(`/api/devices/pair → ${response.status}`);
      return parseResponse(pairedPinsSchema, await response.json());
    },
    staleTime: 10_000,
  });
}

/** Settings → Passcode, Pin setup and provisioning. A 401 still says `set: null`. */
export function usePasscodeState() {
  return useQuery({
    queryKey: ["account-passcode"],
    queryFn: async () => {
      const response = await fetch("/api/account/passcode", { cache: "no-store" });
      if (!response.ok && response.status !== 401) {
        throw new Error(`passcode state returned ${response.status}`);
      }
      return parseResponse(passcodeViewSchema, await response.json());
    },
    staleTime: 10_000,
  });
}
