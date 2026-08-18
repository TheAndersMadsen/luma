/*
 * The Memories dashboard aggregate: one body, five parts, per-part provenance.
 */

import type { DataFallback, DataState } from "../headers";
import type { AiMicRecord, DashboardContent } from "@/lib/types";
import { getCaptures } from "./captures";
import { getEvents } from "./events";
import { getNotes } from "./notes";
import { STOCK_PAGE_SIZE, type Sourced } from "./provenance";

/** One part's own provenance, carried in the body so a page can branch per card. */
export interface PartProvenance {
  state: DataState;
  fallback?: DataFallback;
  degraded?: string;
}

/**
 * Per-part provenance, keyed the way the payload is.
 *
 * The aggregate state answers "is anything on this screen not the wearer's own
 * data" — it cannot answer "did the captures backend work", because captures
 * come from the REST webapi and the other four come from gRPC workloads that
 * fail independently. A page that renders one part must branch on that part.
 */
export interface DashboardProvenance {
  captures: PartProvenance;
  notes: PartProvenance;
  aiMic: PartProvenance;
  music: PartProvenance;
  calls: PartProvenance;
}

/** The dashboard body, plus the provenance of each part inside it. */
export type DashboardBody = DashboardContent & { provenance: DashboardProvenance };

/**
 * How many rows each part of the aggregate fetches.
 *
 * The SHAPE of this response is stock and stays stock; only the volume is the
 * caller's business. The Memories dashboard renders fixed slots — one photo, one
 * Ai Mic row, two music rows, three notes, one call — and fetched five hundred
 * records every five seconds to fill eight of them, decrypting every note and
 * every event server side on the way. A caller that needs the full page (the
 * Captures grid, the Notes list) asks for it explicitly; everything else asks
 * for what it renders.
 */
export interface DashboardLimits {
  captures?: number;
  notes?: number;
  aiMic?: number;
  music?: number;
  calls?: number;
}

function provenanceOf(part: Sourced<unknown>): PartProvenance {
  return { state: part.state, fallback: part.fallback, degraded: part.degraded };
}

/** degraded beats absent beats live: the aggregate is only as true as its weakest part. */
function worstState(states: DataState[]): DataState {
  if (states.includes("degraded")) return "degraded";
  if (states.includes("absent")) return "absent";
  return "live";
}

export async function getDashboardContent(
  limits: DashboardLimits = {},
): Promise<Sourced<DashboardBody>> {
  const [captures, notes, aiMic, music, calls] = await Promise.all([
    getCaptures(limits.captures ?? STOCK_PAGE_SIZE),
    getNotes(limits.notes ?? STOCK_PAGE_SIZE),
    getEvents("AI_MIC", limits.aiMic ?? STOCK_PAGE_SIZE),
    getEvents("MUSIC", limits.music ?? STOCK_PAGE_SIZE),
    getEvents("CALL", limits.calls ?? STOCK_PAGE_SIZE),
  ]);

  const parts: Array<{ label: string; part: Sourced<unknown> }> = [
    { label: "captures", part: captures },
    { label: "notes", part: notes },
    { label: "Ai Mic", part: aiMic },
    { label: "music", part: music },
    { label: "calls", part: calls },
  ];

  /*
   * The aggregate is the WEAKEST part, captures included.
   *
   * It used to derive `anyCosmos` from the four gRPC parts only and treat
   * anything short of "degraded" as healthy, which produced two lies at once:
   * an unconfigured webapi rode inside a "live" aggregate — and a "live"
   * aggregate then dropped `fallback`, so /api/capture/memories asserted live
   * while its own REST plane was absent. Per-part provenance prevents that even
   * though the safe fallback is now always empty.
   */
  const state = worstState(parts.map((p) => p.part.state));
  const anyCosmos = parts.some((p) => p.part.source === "cosmos");

  // Runtime data is never replaced with fixtures. Any non-live part is empty.
  const fallback: DataFallback | undefined =
    state === "live" ? undefined : "empty";

  const data: DashboardBody = {
    photos: captures.data,
    notes: notes.data,
    aiSessions: aiMic.data as AiMicRecord[],
    playTrackEvents: music.data as DashboardContent["playTrackEvents"],
    phoneCalls: calls.data as DashboardContent["phoneCalls"],
    health: [],
    provenance: {
      captures: provenanceOf(captures),
      notes: provenanceOf(notes),
      aiMic: provenanceOf(aiMic),
      music: provenanceOf(music),
      calls: provenanceOf(calls),
    },
  };

  return {
    data,
    source: anyCosmos ? "cosmos" : "fixtures",
    state,
    fallback,
    degraded: summarizeParts(parts),
  };
}

/**
 * One sentence naming WHICH parts are not the wearer's own data.
 *
 * Failures name the first broken plane. Absent parts contain an explanation too,
 * so an empty result never means "none" when Center cannot reach its source.
 */
function summarizeParts(parts: Array<{ label: string; part: Sourced<unknown> }>): string | undefined {
  const broken = parts.filter((p) => p.part.state === "degraded");
  if (broken.length > 0) {
    const others = broken.length > 1 ? ` (and ${broken.length - 1} more)` : "";
    return `${broken[0].label}: ${broken[0].part.degraded ?? "cosmos did not answer"}${others}`;
  }

  // A live part can still have something to say — a sealed note, for instance.
  return parts.map((p) => p.part.degraded).find(Boolean);
}
