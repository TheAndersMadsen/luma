import { currentSession } from "@/server/operator";
import { AUTH_ENABLED } from "@/server/auth";
import { COSMOS_WEBAPI, surfaceOwnerHeaders, SessionExpiredError } from "@/server/cosmos";
import { boundedJson } from "@/server/boundedJson";
import { record } from "@/lib/contracts/surfaces";
import { parseNativeSurfaces } from "@/lib/contracts/nativeSurfaces";
import { parsePinSurfaces } from "@/lib/contracts/pinSurfaces";
import { activityRows, LEDGER_LIMIT, parseLedgerTurns, type ActivityRow } from "@/lib/contracts/activity";

export type Activity =
  | { state: "ready"; rows: ActivityRow[]; /** Some device list could not be read, so some devices are shown as removed. */ unnamed: boolean }
  | { state: "unavailable" }
  /** The wearer's session expired while reading; the page sends them back to sign in. */
  | { state: "expired" };

async function read(path: string, headers: Record<string, string>, bytes: number): Promise<unknown> {
  const signal = AbortSignal.timeout(8000);
  const response = await fetch(`${COSMOS_WEBAPI}${path}`, { headers, cache: "no-store", redirect: "error", signal: signal });
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(`upstream_${response.status}`); }
  return boundedJson(response.body, bytes, signal);
}

/** Kinds of approved surface by ID from the owner's three device lists; a list that cannot be read names nothing. */
async function surfaceKinds(headers: Record<string, string>): Promise<{ kinds: Map<string, string>; unnamed: boolean }> {
  const kinds = new Map<string, string>();
  const lists = await Promise.allSettled([
    read("/surface-api/v1/native", headers, 65536).then(value => { for (const row of parseNativeSurfaces(value)) kinds.set(row.surfaceId, row.platform); }),
    read("/surface-api/v1/surfaces", headers, 65536).then(value => {
      const { surfaces } = record(value);
      if (!Array.isArray(surfaces) || surfaces.length > 16) throw new Error("invalid_list");
      for (const row of surfaces) { const { surfaceId } = record(row); if (typeof surfaceId === "string") kinds.set(surfaceId.toLowerCase(), "browser"); }
    }),
    read("/surface-api/v1/pins", headers, 65536).then(value => { for (const row of parsePinSurfaces(value)) kinds.set(row.surfaceId.toLowerCase(), "pin"); }),
  ]);
  return { kinds, unnamed: lists.some(result => result.status === "rejected") };
}

/**
 * The owner's recent turns from the runtime ledger, newest first. The ledger
 * carries no request text or reply content, so neither does this.
 */
export async function readActivity(): Promise<Activity> {
  try {
    if (!AUTH_ENABLED || !await currentSession() || !COSMOS_WEBAPI) return { state: "unavailable" };
    const headers = await surfaceOwnerHeaders();
    const [ledger, { kinds, unnamed }] = await Promise.all([
      read(`/surface-api/v1/ledger?limit=${LEDGER_LIMIT}`, headers, 1048576).then(parseLedgerTurns),
      surfaceKinds(headers),
    ]);
    return { state: "ready", rows: activityRows(ledger, kinds), unnamed };
  } catch (error) {
    if (error instanceof SessionExpiredError) return { state: "expired" };
    // An unreachable Cosmos and a malformed ledger read the same: unknown, never invented.
    return { state: "unavailable" };
  }
}
