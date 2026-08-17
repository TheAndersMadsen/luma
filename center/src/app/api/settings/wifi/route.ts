import { NextResponse } from "next/server";
import { CARRY_ENABLED, SessionExpiredError, call, Services } from "@/server/cosmos";
import { sourceHeaders } from "@/server/headers";

/**
 * GET /api/settings/wifi — the "Saved Wi-Fi Networks" list on Settings → My Ai Pin.
 *
 * Reads `WifiConfigService.ListSecureWifiConfigs`. On the wire that response is
 * `repeated humane.common.encryption.EncryptedData secure_wifi_configs`
 * (contracts/wire/humane/account.proto) — SEALED ENVELOPES, not `WifiConfig`
 * rows. `WifiConfig{ uuid, authorization_type, network_ssid, password, hidden }`
 * is the plaintext *inside* one, and Cosmos replays the stored response verbatim
 * (services/account.rs), so envelopes are what actually arrive here.
 *
 * This route used to read `c.ssid ?? c.networkSsid` off those envelopes —
 * structurally always undefined — map every entry to an empty SSID, drop them
 * all with a `.filter(ssid.length > 0)`, and answer `{networks: [], state:
 * "live"}`. A wearer with saved networks was told, with the full authority of a
 * live read, that they had none. The comment above it claimed the route accepted
 * either shape; it accepted neither.
 *
 * Center cannot open these and must not try: the envelopes are sealed under the
 * DEVICE's key, and Center's own channel key is unrelated (trying it is what
 * once made every device-created note look permanently encrypted). So the honest
 * answer is the one the notes surface already gives for sealed rows — the read
 * succeeded, here is how many there are, and this dashboard does not hold the
 * key. The Pin's own `/api/devices/status` report is where legible SSIDs come
 * from.
 *
 * Graceful degradation is mandatory: any gRPC error (UNIMPLEMENTED on a workload
 * that doesn't host WifiConfigService, UNAVAILABLE, deadline) collapses to an
 * empty list rather than a 500 — but to a DISTINGUISHABLE empty list. Three
 * states, three answers: `live` (here is your list, possibly empty, possibly
 * sealed), `absent` (no carry backend is configured), `degraded` (it is
 * configured and did not answer).
 */

export interface WifiNetwork {
  ssid: string;
  authorizationType?: string;
  hidden?: boolean;
}

/** `humane.common.encryption.EncryptedData`, as proto-loader surfaces it. */
interface SealedWifiConfig {
  encryptionInformation?: { kid?: Buffer | string };
  data?: Buffer | Uint8Array;
}

interface ListSecureWifiConfigsResponse {
  secureWifiConfigs?: SealedWifiConfig[];
}

export async function GET() {
  if (!CARRY_ENABLED) {
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

  try {
    const res = await call<Record<string, never>, ListSecureWifiConfigsResponse>(
      Services.wifi,
      "ListSecureWifiConfigs",
      {},
    );

    // Count the envelopes; never decode them. An entry with no payload is not a
    // saved network, it is a malformed row, and counting it would restate the
    // original bug in the other direction.
    const sealedCount = (res.secureWifiConfigs ?? []).filter(
      (config) => (config.data?.length ?? 0) > 0,
    ).length;

    // `live` either way: the backend answered, and it answered truthfully. The
    // note on the sealed arm is what stops "networks: []" being read as "you
    // have none" — the same wording the notes projection already uses.
    const degraded = sealedCount
      ? `${sealedCount} saved network(s) sealed under a key this dashboard does not hold`
      : undefined;
    return NextResponse.json(
      { networks: [] as WifiNetwork[], sealedCount, state: "live", degraded },
      { headers: sourceHeaders({ source: "carry", state: "live", degraded }) },
    );
  } catch (error) {
    // An expired grant is the wearer's problem to fix, not the backend's, so
    // say so and let the client re-authenticate. Swallowing it into the generic
    // "did not answer" below is what disguised a routine session expiry as an
    // unreachable service for as long as this route has existed.
    if (error instanceof SessionExpiredError) {
      return NextResponse.json(
        { error: "Your session expired — sign in again.", reauthenticate: true },
        { status: 401 },
      );
    }
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
}
