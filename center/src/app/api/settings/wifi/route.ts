import { NextResponse } from "next/server";
import { sourceHeaders } from "@/server/headers";
import { getSealedWifiSummary } from "@/server/domain/settings";

/**
 * GET /api/settings/wifi — the "Saved Wi-Fi Networks" list on Settings → My Ai
 * Pin. The protocol work — and the story of the sealed envelopes this list is
 * actually made of — lives in `@/server/domain/settings`
 * (`getSealedWifiSummary`); this route only maps each outcome onto its stable
 * HTTP body.
 *
 * Graceful degradation is mandatory: any gRPC error (UNIMPLEMENTED on a workload
 * that doesn't host WifiConfigService, UNAVAILABLE, deadline) collapses to an
 * empty list rather than a 500 — but to a DISTINGUISHABLE empty list. Three
 * states, three answers: `live` (here is your list, possibly empty, possibly
 * sealed), `absent` (no carry backend is configured), `degraded` (it is
 * configured and did not answer). The fourth outcome — the wearer's own expired
 * grant (a `SessionExpiredError` inside the domain read) — answers 401 +
 * `reauthenticate`, because only they can fix it.
 */

export interface WifiNetwork {
  ssid: string;
  authorizationType?: string;
  hidden?: boolean;
}

export async function GET() {
  const read = await getSealedWifiSummary();
  if (read.kind === "absent") {
    const degraded = "This Center is not connected to Pin services.";
    return NextResponse.json(
      { networks: [], sealedCount: 0, unavailable: true, state: "absent", degraded },
      {
        headers: sourceHeaders({
          source: "unconfigured",
          state: "absent",
          fallback: "empty",
          degraded,
        }),
      },
    );
  }
  if (read.kind === "expired") {
    // An expired grant is the wearer's problem to fix, not the backend's, so
    // say so and let the client re-authenticate. Swallowing it into the generic
    // "did not answer" arm is what disguised a routine session expiry as an
    // unreachable service for as long as this route has existed.
    return NextResponse.json(
      { error: "Your session expired — sign in again.", reauthenticate: true },
      { status: 401 },
    );
  }
  if (read.kind === "degraded") {
    const degraded = "WifiConfigService.ListSecureWifiConfigs did not answer.";
    return NextResponse.json(
      { networks: [], sealedCount: 0, unavailable: true, state: "degraded", degraded },
      {
        headers: sourceHeaders({
          source: "unreachable",
          state: "degraded",
          fallback: "empty",
          degraded,
        }),
      },
    );
  }

  // `live` either way: the backend answered, and it answered truthfully. The
  // note on the sealed arm is what stops "networks: []" being read as "you
  // have none" — the same wording the notes projection already uses.
  const { sealedCount } = read.value;
  const degraded = sealedCount
    ? `${sealedCount} saved network(s) sealed under a key this dashboard does not hold`
    : undefined;
  return NextResponse.json(
    { networks: [] as WifiNetwork[], sealedCount, state: "live", degraded },
    { headers: sourceHeaders({ source: "carry", state: "live", degraded }) },
  );
}
