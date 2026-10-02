import type { DataState } from "@/lib/contracts/dataSource";
import { COSMOS_ENABLED, COSMOS_ENDPOINT, COSMOS_WEBAPI, COSMOS_WEBAPI_ENABLED } from "@/server/cosmos";
import { getWebapiHealth } from "@/server/domain/captures";
import { getGrpcHealth } from "@/server/domain/events";
import { sourceHeaders } from "@/server/headers";
import { NextResponse } from "next/server";
import type { HealthInfo, PlaneHealth } from "@/lib/contracts/health";

/**
 * GET /api/health, is the cosmos backend configured, and is it actually
 * answering? The SourceBadge in the chrome of every page reads this.
 *
 * The case this exists for: Cosmos IS configured and does NOT answer. Collection
 * routes deliberately return an empty value with `state: "degraded"`. This
 * probe keeps the global badge consistent with those route-level results.
 *
 * It therefore has to probe BOTH planes. This used to ask one question,
 * `getMyDataOverview()`, a gRPC DeviceEventsHistoryService call, while every
 * capture and the Memories photo card come from the REST webapi: a different
 * process, a different port, different credentials (a wearer's webapi call
 * carries their Bearer, not COSMOS_EDGE_TOKEN). With gRPC up and the webapi
 * down the badge said "Live" while the capture plane was unavailable, which is
 * the exact partial failure the badge exists to report.
 *
 * The merged state is the worse of the two: degraded beats absent beats live.
 * Half-live is not live, some wearer data is unavailable.
 */

// The one endpoint whose job is honesty must never be answered from a build-time
// snapshot: it reads cookies through requestBearer(), which swallows the dynamic
// bailout, so say it out loud here.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [grpc, webapi] = await Promise.all([probeGrpc(), probeWebapi()]);
    const state = worse(grpc.state, webapi.state);
    const troubled = [grpc, webapi].filter((p) => p.state !== "live");

    return json({
      cosmosConfigured: grpc.configured || webapi.configured,
      // Only when EVERY configured half answered. Anything less and part of the
      // screen is a stand-in.
      reachable: state === "live",
      endpoint: grpc.endpoint ?? webapi.endpoint,
      state,
      fallback: state === "live" ? undefined : "empty",
      detail: troubled.length === 0 ? "cosmos answering" : troubled.map((p) => p.detail).join("; "),
      // Only when EVERY unhappy half is unhappy for that one reason: a real
      // outage next to an expired session is still an outage.
      reauthenticate:
        troubled.length > 0 && troubled.every((p) => p.reauthenticate) ? true : undefined,
      authUnavailable: troubled.some((p) => p.authUnavailable) ? true : undefined,
      planes: { grpc, webapi },
    });
  } catch (error) {
    // Both probes degrade internally, so reaching here means something
    // unexpected threw. Say so rather than 500-ing the one endpoint whose whole
    // job is reporting honestly, a health probe that throws is read by the
    // badge as "nothing to report", which is the one thing it must never say.
    const detail = error instanceof Error ? error.message : "cosmos unreachable";
    const unknown: PlaneHealth = { configured: false, state: "degraded", detail };
    return json({
      cosmosConfigured: COSMOS_ENABLED || COSMOS_WEBAPI_ENABLED,
      reachable: false,
      endpoint: COSMOS_ENDPOINT || COSMOS_WEBAPI || undefined,
      state: "degraded",
      fallback: "empty",
      detail,
      planes: { grpc: unknown, webapi: unknown },
    });
  }
}

/**
 * gRPC: my-data, contacts, account. Notes now use the authenticated REST projection.
 *
 * The probe is `getGrpcHealth()`, a single bounded QueryEvents. It used to be
 * `getMyDataOverview()`, four QueryEvents at a thousand results each, every one
 * of them decrypted server side, which made the endpoint whose entire job is
 * honesty the heaviest call in the system, run from the chrome of every page
 * once a minute, and put it first in line to exceed COSMOS_DEADLINE_MS and report
 * a healthy backend as unreachable.
 */
async function probeGrpc(): Promise<PlaneHealth> {
  if (!COSMOS_ENABLED) {
    return {
      configured: false,
      state: "absent",
      detail: "COSMOS_GRPC_ENDPOINT is unset - my-data is unavailable",
    };
  }
  try {
    const probe = await getGrpcHealth();
    return {
      configured: true,
      state: probe.state,
      endpoint: COSMOS_ENDPOINT || undefined,
      reauthenticate: probe.reauthenticate,
      authUnavailable: probe.authUnavailable,
      detail:
        probe.state === "live"
          ? "cosmos answering"
          : `my-data: ${probe.degraded ?? "cosmos did not answer"}`,
    };
  } catch (error) {
    return {
      configured: true,
      state: "degraded",
      endpoint: COSMOS_ENDPOINT || undefined,
      detail: `my-data: ${error instanceof Error ? error.message : "cosmos unreachable"}`,
    };
  }
}

/** REST webapi: notes, every capture, and the Memories photo card. */
async function probeWebapi(): Promise<PlaneHealth> {
  try {
    const probe = await getWebapiHealth();
    return {
      configured: COSMOS_WEBAPI_ENABLED,
      state: probe.state,
      endpoint: COSMOS_WEBAPI || undefined,
      reauthenticate: probe.reauthenticate,
      authUnavailable: probe.authUnavailable,
      detail:
        probe.state === "live"
          ? "cosmos webapi answering"
          : // Unconfigured already says so in its own words (WEBAPI_UNSET);
            // a failure needs naming, or "captures" is nowhere in the sentence.
            probe.state === "absent"
            ? (probe.degraded ?? "the REST webapi is not configured here")
            : `notes, captures and the Memories photo card: ${probe.degraded ?? "the webapi did not answer"}`,
    };
  } catch (error) {
    return {
      configured: COSMOS_WEBAPI_ENABLED,
      state: "degraded",
      endpoint: COSMOS_WEBAPI || undefined,
      detail: `notes, captures and the Memories photo card: ${
        error instanceof Error ? error.message : "the webapi is unreachable"
      }`,
    };
  }
}

function worse(a: DataState, b: DataState): DataState {
  if (a === "degraded" || b === "degraded") return "degraded";
  if (a === "absent" || b === "absent") return "absent";
  return "live";
}

function json(payload: HealthInfo) {
  return NextResponse.json(payload, {
    headers: sourceHeaders({
      state: payload.state,
      fallback: payload.fallback,
      degraded: payload.state === "live" ? undefined : payload.detail,
    }),
  });
}
