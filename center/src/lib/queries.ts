"use client";

import { useQuery } from "@tanstack/react-query";
import { mapCosmosNote, type CosmosNoteDto } from "./noteMapping";
import { normalizeActivityResponse, type ActivityMusic } from "./pin-device";
import type {
  AiMicRecord,
  CaptureRecord,
  DashboardContent,
  MusicRecord,
  MyDataOverviewEntry,
  NoteRecord,
  Page,
  PhoneCallRecord,
  TranslationRecord,
} from "./types";

/**
 * The provenance a route reports. See src/server/headers.ts — `state` is the
 * one to branch on; `source` is the legacy alias and carries five values from
 * two incompatible families, which is why it used to be blind-cast here.
 */
export type DataState = "live" | "absent" | "degraded";
export type DataFallback = "fixtures" | "empty";

export interface SourceInfo {
  source: "cosmos" | "fixtures" | "unconfigured" | "unreachable";
  /**
   * live     — the wearer's own current data
   * absent   — no counterpart in this backend; a retry cannot help
   * degraded — cosmos is configured and did not answer
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
   * nowhere in the body to put it — and because until something READ it, every
   * expiry still rendered as "your Pin couldn't be reached", which sends the
   * wearer nowhere and whoever is on call to a Cosmos that is answering fine.
   */
  reauthenticate?: true;
}

function readSource(value: string | null): SourceInfo["source"] {
  switch (value) {
    case "cosmos":
    case "fixtures":
    case "unconfigured":
    case "unreachable":
      return value;
    default:
      return "fixtures";
  }
}

/** Falls back to the legacy header for routes that have not moved over yet. */
function readState(value: string | null, source: SourceInfo["source"]): DataState {
  switch (value) {
    case "live":
    case "absent":
    case "degraded":
      return value;
    default:
      return source === "cosmos" ? "live" : source === "unreachable" ? "degraded" : "absent";
  }
}

function readFallback(value: string | null): DataFallback | undefined {
  return value === "fixtures" || value === "empty" ? value : undefined;
}

async function fetchJson<T>(url: string): Promise<{ data: T } & SourceInfo> {
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
  const source = readSource(res.headers.get("x-data-source"));
  return {
    data: (await res.json()) as T,
    source,
    state: readState(res.headers.get("x-data-state"), source),
    fallback: readFallback(res.headers.get("x-data-fallback")),
    degraded: res.headers.get("x-data-degraded") ?? undefined,
    reauthenticate: res.headers.get("x-data-reauthenticate") === "1" ? true : undefined,
  };
}

/**
 * Per-part provenance, carried in the /api/capture/memories BODY.
 *
 * Mirrors `PartProvenance` / `DashboardProvenance` in src/server/source.ts.
 * Declared again here rather than imported, because that module opens gRPC
 * clients and must never be pulled into a client bundle.
 */
export interface PartProvenance {
  state: DataState;
  fallback?: DataFallback;
  degraded?: string;
}

export interface DashboardProvenance {
  captures: PartProvenance;
  notes: PartProvenance;
  aiMic: PartProvenance;
  music: PartProvenance;
  calls: PartProvenance;
}

/**
 * The dashboard payload, with each part's own provenance beside it.
 *
 * The response-level state is the aggregate — the weakest of five parts served
 * by two independently failing backends. It answers "is anything on this screen
 * a stand-in", which is the right question for the chrome and the wrong one for
 * a single card: a page that renders ONE part must branch on that part, or a
 * music-RPC outage makes a healthy, genuinely empty capture list look like a
 * transport failure with a retry that cannot change anything.
 *
 * `provenance` is optional on the wire so an older BFF still parses.
 */
export type DashboardBody = DashboardContent & { provenance?: DashboardProvenance };

/*
 * There was a `narrowTo` here that pulled one part's provenance out of the
 * aggregate for the Captures view. It is gone with its only caller: that view
 * now reads `/api/capture/captures`, whose response-level provenance already
 * describes the one backend it asked. `data.provenance` remains on the wire for
 * the dashboard, which renders all five parts and needs a sentence per card.
 */

/**
 * Memories. The original polled this every 5s with a 1s stale time and no
 * refetch on focus — preserved here.
 *
 * Keeps the aggregate state: this view renders all five parts at once, so "any
 * one of these is a stand-in" is exactly what it needs. `data.provenance` is
 * there for a per-card sentence.
 */
/**
 * How many records the dashboard asks for, per part.
 *
 * The page renders fixed slots — `photos?.[0]`, `slice(0,1)`, `slice(0,2)`,
 * `slice(0,3)`, `phoneCalls?.[0]` — and this query used to pull the stock page
 * of 200 for all five, five hundred records every five seconds, to fill eight of
 * them. These are what the page consumes plus a small margin, so a deleted or
 * filtered row still leaves a slot filled. The BFF defaults to the stock page
 * when a count is absent, so no other caller changes.
 */
const DASHBOARD_LIMITS = "captures=4&notes=6&aiMic=3&music=4&calls=3";

export function useDashboard() {
  return useQuery({
    queryKey: ["memories-dashboard"],
    queryFn: () => fetchJson<DashboardBody>(`/api/capture/memories?${DASHBOARD_LIMITS}`),
    refetchInterval: 5000,
    staleTime: 1000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Provider identity for the stock notable-event cards lives in the Pin's
 * provider-neutral activity ledger. Failure is intentionally independent of
 * the Cosmos dashboard: old events still render with a generic music identity.
 */
export function useRemoteMusicActivity(limit = 20, enabled = true) {
  return useQuery({
    queryKey: ["remote-pin-music-activity", limit],
    queryFn: async () => {
      const response = await fetch(`/api/pin/remote/api/activity/music?limit=${limit}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Could not read provider details from the paired Pin.");
      return normalizeActivityResponse("music", await response.json()).items as ActivityMusic[];
    },
    refetchInterval: 5000,
    staleTime: 1000,
    retry: false,
    enabled,
  });
}

export function useNotes() {
  return useQuery({
    queryKey: ["notes"],
    // The BFF mirrors the stock page envelope verbatim; the dashboard's
    // NoteRecord view is derived client-side from the raw rows while keeping
    // the provenance envelope intact.
    queryFn: async () => {
      const page = await fetchJson<Page<CosmosNoteDto>>("/api/capture/notes");
      // `data` is overwritten with the mapped rows, which destroys the Spring
      // envelope it came in — including `totalElements`, the only number that
      // knows the wearer has more notes than this capped page holds. Keeping it
      // beside the rows is what lets /notes say "200 of 340" instead of stating
      // the page size as the wearer's note count, and lets the search say that
      // it only looked at those 200 before it claims nothing matched.
      return {
        ...page,
        data: page.data.content.map(mapCosmosNote),
        total: page.data.totalElements,
      };
    },
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
 * Captures alone, from the captures-only route.
 *
 * The state reported here is the CAPTURES leg's, not an aggregate's. Captures
 * and notes are read over the REST webapi; Ai Mic, music and calls travel over
 * separate gRPC workloads. Reading the aggregate meant a music QueryEvents
 * failure — or a webapi-only deployment — made a healthy backend that correctly
 * answered "you have no captures" render as "Couldn't reach the backend just
 * now." with a Try again that provably could not help; it also downloaded four
 * collections this view then discarded.
 *
 * `/api/capture/captures` answers with one leg, so the response's own
 * provenance IS the captures leg's and no narrowing is needed.
 * `state === "live" && !data.length` is true exactly when the captures backend
 * said the wearer has none.
 */
export function useCaptures() {
  return useQuery({
    queryKey: ["captures"],
    queryFn: async () => {
      const res = await fetchJson<{ photos?: CaptureRecord[]; total?: number }>(
        "/api/capture/captures",
      );
      // Same reason as useNotes: `total` is what the wearer HAS, `data.length`
      // is what one capped page holds, and only the first of those two is a fact
      // about their library.
      return { ...res, data: res.data.photos ?? [], total: res.data.total };
    },
    staleTime: 5000,
  });
}

/**
 * The four My Data counters.
 *
 * Foreground only. Each refetch is four QueryEvents on the BFF side, and every
 * event they return is decrypted server side to produce eight integers — a
 * hidden tab does not need that twelve times a minute. `refetchOnWindowFocus`
 * makes the tiles current the moment the tab is looked at again.
 */
export function useMyDataOverview() {
  return useQuery({
    queryKey: ["mydata-overview"],
    queryFn: () => fetchJson<MyDataOverviewEntry[]>("/api/notable-events/mydata/overview"),
    refetchInterval: 5000,
    refetchOnWindowFocus: "always",
    staleTime: 1000,
  });
}

type DomainRecord = {
  AI_MIC: AiMicRecord;
  MUSIC: MusicRecord;
  TRANSLATION: TranslationRecord;
  CALL: PhoneCallRecord;
};

/**
 * Foreground only, for the same reason as the overview above: one refetch is a
 * page of 200 events, each decrypted server side, and a hidden tab was pulling
 * that twelve times a minute per open domain. The overview and the notes list
 * already dropped `refetchIntervalInBackground`; this one kept it, which made
 * the cheaper surface the one that stopped polling and the most expensive one
 * the one that did not. `refetchOnWindowFocus` still makes the list current the
 * moment the tab is looked at again.
 */
export function useMyData<K extends keyof DomainRecord>(domain: K) {
  return useQuery({
    queryKey: ["mydata", domain],
    queryFn: async () => {
      const res = await fetchJson<Page<DomainRecord[K]>>(
        `/api/notable-events/mydata?domain=${domain}&size=200`,
      );
      return { ...res, data: res.data.content };
    },
    refetchInterval: 5000,
    refetchOnWindowFocus: "always",
    staleTime: 1000,
  });
}

/**
 * One half of the data plane. .Center reads two backends that fail
 * independently: gRPC workloads (my-data, contacts, account) and the REST
 * webapi (notes, every capture, and the Memories photo card).
 */
export interface PlaneHealth {
  configured: boolean;
  state: DataState;
  endpoint?: string;
  detail: string;
  /** This half is degraded only because the wearer's grant expired. */
  reauthenticate?: true;
}

export interface HealthInfo {
  cosmosConfigured: boolean;
  reachable: boolean;
  endpoint?: string;
  /** Legacy alias. Branch on `state`. */
  source: "cosmos" | "fixtures";
  /** The WORSE of the two planes: half-live is not live. */
  state: DataState;
  fallback?: DataFallback;
  detail: string;
  /**
   * Nothing here is broken; this wearer's session is. Set only when EVERY
   * unhappy half is unhappy for that reason — a real outage next to an expired
   * session is still an outage — and read by <SourceBadge>, which otherwise
   * paints a healthy deployment red and offers the wearer no way out.
   */
  reauthenticate?: true;
  /** Which half is which. Absent when the probe itself could not be read. */
  planes?: { grpc: PlaneHealth; webapi: PlaneHealth };
}

function readPlane(value: unknown): PlaneHealth | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Partial<PlaneHealth>;
  if (typeof p.detail !== "string") return null;
  return {
    configured: Boolean(p.configured),
    state: readState(p.state ?? null, p.configured ? "cosmos" : "fixtures"),
    endpoint: typeof p.endpoint === "string" ? p.endpoint : undefined,
    detail: p.detail,
    reauthenticate: p.reauthenticate === true ? true : undefined,
  };
}

function readPlanes(value: unknown): HealthInfo["planes"] {
  if (!value || typeof value !== "object") return undefined;
  const { grpc, webapi } = value as Record<string, unknown>;
  const one = readPlane(grpc);
  const two = readPlane(webapi);
  return one && two ? { grpc: one, webapi: two } : undefined;
}

/**
 * We asked and did not get an answer we can trust.
 *
 * Deliberately NOT "absent": that word is a claim about the deployment ("no Pin
 * backend is configured here"), and an unreadable probe is no evidence for it.
 * `degraded` with no `fallback` renders as "Couldn't reach the backend just
 * now." — which is what actually happened — and keeps the badge on screen. The
 * one component that tells a wearer they may be reading someone else's data
 * must not disappear at the moment the BFF breaks.
 */
function unknownHealth(detail: string, reauthenticate?: true): HealthInfo {
  return {
    // Unknown, not false. Nothing branches on these two; `state` is the signal.
    cosmosConfigured: false,
    reachable: false,
    source: "fixtures",
    state: "degraded",
    detail,
    reauthenticate,
  };
}

/**
 * Which backend answered. <SourceBadge> renders this in the chrome of every
 * page; it is the only thing that tells a wearer their Pin's backend went quiet
 * and what they are looking at instead.
 *
 * Every failure mode here has to be handled explicitly, because the badge's
 * whole value is that it does not guess. Parsing a non-2xx body as a health
 * payload used to turn an expired session into "no Pin backend is configured
 * for this .Center" — a false statement about the deployment, made by the one
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
        // 12h session lapses in a tab left open. Its body is an error, not health.
        // Flagged as well as described, so the badge can say "sign in again"
        // rather than "your Pin couldn't be reached" — the sentence alone was
        // never read by anything that chooses the words on screen.
        if (res.status === 401) {
          return unknownHealth(
            "Your session expired. Sign in again to see your data.",
            true,
          );
        }
        return unknownHealth("Your Pin could not be reached.");
      }

      let body: Partial<HealthInfo> | null;
      try {
        body = (await res.json()) as Partial<HealthInfo>;
      } catch {
        // An HTML error page from a proxy, say. Not a payload.
        body = null;
      }
      if (!body || typeof body !== "object") {
        return unknownHealth("Your Pin returned an unreadable status.");
      }

      const source = body.source === "cosmos" ? "cosmos" : "fixtures";
      return {
        cosmosConfigured: Boolean(body.cosmosConfigured),
        reachable: Boolean(body.reachable),
        endpoint: body.endpoint,
        source,
        state: readState(body.state ?? null, source),
        fallback: readFallback(body.fallback ?? null),
        detail: body.detail ?? "Pin status unknown",
        // /api/health computes this (app/api/health/route.ts) and dropping it
        // here is what left the signal with no consumer at all.
        reauthenticate: body.reauthenticate === true ? true : undefined,
        planes: readPlanes(body.planes),
      };
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
