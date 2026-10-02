/*
 * The Memories dashboard aggregate, read whole from Cosmos
 * (`GET /capture/memories`, the recovered `getDashboardContent`), with the
 * provenance of each part carried in the body.
 */

import type { DashboardBody, DashboardContent, DashboardProvenance } from "@/lib/contracts/dashboard";
import { dashboardContentSchema } from "@/lib/contracts/dashboard";
import type { PartProvenance } from "@/lib/contracts/dataSource";
import { parseResponse } from "@/lib/contracts/parse";
import * as z from "zod/mini";
import { COSMOS_WEBAPI_ENABLED, webapiGet } from "../cosmos";
import { failedWebapi, live, unconfigured, type Sourced } from "./provenance";

/** The aggregate as Cosmos sends it: a slot it could not read is `null`. */
function readDashboard(value: unknown) {
  const raw = parseResponse(z.record(z.string(), z.unknown()), value);
  const shape = dashboardContentSchema.shape;
  function slot<T>(schema: z.ZodMiniType<T>, data: unknown): T | null {
    const result = schema.safeParse(data);
    return result.success ? result.data : null;
  }
  return {
    photos: slot(shape.photos, raw.photos),
    notes: slot(shape.notes, raw.notes),
    aiSessions: slot(shape.aiSessions, raw.aiSessions),
    playTrackEvents: slot(shape.playTrackEvents, raw.playTrackEvents),
    phoneCalls: slot(shape.phoneCalls, raw.phoneCalls),
    health: slot(shape.health, raw.health),
  };
}

/** Which slot each part of the provenance describes. */
const PARTS: Array<{ part: keyof DashboardProvenance; slot: keyof DashboardContent; label: string }> = [
  { part: "captures", slot: "photos", label: "captures" },
  { part: "notes", slot: "notes", label: "notes" },
  { part: "aiMic", slot: "aiSessions", label: "Ai Mic" },
  { part: "music", slot: "playTrackEvents", label: "music" },
  { part: "calls", slot: "phoneCalls", label: "calls" },
];

const EMPTY: DashboardContent = {
  photos: [],
  aiSessions: [],
  playTrackEvents: [],
  notes: [],
  phoneCalls: [],
  health: [],
};

const WEBAPI_UNSET =
  "COSMOS_WEBAPI_BASE_URL is unset - this Center cannot read the wearer's memories";

const SLOT_UNREAD = "Cosmos could not read this part just now";

/** Every part in the same state, for an answer that covered the whole body. */
function everyPart(part: PartProvenance): DashboardProvenance {
  return {
    captures: part,
    notes: part,
    aiMic: part,
    music: part,
    calls: part,
  };
}

export async function getDashboardContent(): Promise<Sourced<DashboardBody>> {
  if (!COSMOS_WEBAPI_ENABLED) {
    const result = unconfigured(EMPTY, "empty", WEBAPI_UNSET);
    return {
      ...result,
      data: {
        ...EMPTY,
        provenance: everyPart({
          state: result.state,
          fallback: "empty",
          degraded: WEBAPI_UNSET,
        }),
      },
    };
  }
  let aggregate: ReturnType<typeof readDashboard>;
  try {
    aggregate = readDashboard(await webapiGet("/capture/memories"));
  } catch (error) {
    const result = failedWebapi(EMPTY, error);
    return {
      ...result,
      data: {
        ...EMPTY,
        provenance: everyPart({
          state: result.state,
          fallback: result.fallback,
          degraded: result.degraded,
        }),
      },
    };
  }

  const provenance = everyPart({ state: "live" });
  const unread: string[] = [];
  for (const { part, slot, label } of PARTS) {
    if (aggregate[slot] === null || aggregate[slot] === undefined) {
      provenance[part] = {
        state: "degraded",
        fallback: "empty",
        degraded: SLOT_UNREAD,
      };
      unread.push(label);
    }
  }
  const data: DashboardBody = {
    photos: aggregate.photos ?? [],
    aiSessions: aggregate.aiSessions ?? [],
    playTrackEvents: aggregate.playTrackEvents ?? [],
    notes: aggregate.notes ?? [],
    phoneCalls: aggregate.phoneCalls ?? [],
    // The health tile is a fixed card. An unread reading has no card to name.
    health: aggregate.health ?? [],
    provenance,
  };
  if (unread.length === 0) return live(data);
  // The aggregate is only as true as its weakest part.
  return {
    ...live(data),
    state: "degraded",
    fallback: "empty",
    degraded: `${unread.join(", ")}: ${SLOT_UNREAD}`,
  };
}
