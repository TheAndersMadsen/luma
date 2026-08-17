/*
 * The provenance seam every domain module answers through.
 *
 * Every domain function returns Center's own wire shape, so the UI never learns
 * which backend answered. When nothing is configured, or when Cosmos does not
 * answer, wearer-owned collections are empty and carry explicit absent/degraded
 * provenance. Runtime sample data is never substituted for a wearer's data.
 */

import { ChannelKeyUnavailableError } from "../channel";
import type { DataFallback, DataState } from "../headers";
import {
  CARRY_WEBAPI,
  ContractsUnavailableError,
  SessionExpiredError,
  webapiHeaders,
} from "../cosmos";

export type SourceName = "carry" | "fixtures";

export interface Sourced<T> {
  data: T;
  /** Legacy wire value, still emitted as an alias. Branch on `state`. */
  source: SourceName;
  /**
   * live     — carry answered and this is the wearer's own current data
   * absent   — carry is not configured here, so there is no counterpart at all
   * degraded — carry IS configured and did not answer; `data` is a stand-in
   */
  state: DataState;
  /** What is standing in. Runtime wearer-data fallbacks are always empty. */
  fallback?: DataFallback;
  /** Set when carry was configured but the call failed, so the UI can say so. */
  degraded?: string;
  /**
   * The one degraded cause the WEARER can fix, distinguished from the ones they
   * cannot.
   *
   * Without it every consumer of a `Sourced` had to read `degraded` prose to
   * tell "your Keycloak grant expired, sign in again" from "the backend is
   * down", so the routes answered 502 and the panes blamed a healthy Cosmos —
   * while api/settings/wifi answered the identical error with 401 +
   * reauthenticate. Set only by `failedGrpc`/`failedWebapi` below, and only for
   * `SessionExpiredError`.
   */
  reauthenticate?: true;
  /**
   * How many rows the backend says exist, when `data` is one capped page of
   * them.
   *
   * Cosmos clamps every list to 200 (`MAX_PAGE_SIZE` in capture_api.rs) and
   * Center asks for no page beyond the first, so a wearer past that number holds
   * more than any Center surface can show. The Spring envelope has always
   * carried the honest count beside the rows — deliberately, `StorePage.total`
   * is a separate store count and not `content.len()` — and every list here
   * dropped it on the way through. The counts and the "nothing matched" empty
   * states then read as facts about the wearer's data when they were facts about
   * the first page. This carries the number so a surface can qualify itself; My
   * Data has said "at least N — totals are counted up to that point and no
   * further" for exactly this reason for a long time.
   */
  total?: number;
}

/** carry answered. */
export function live<T>(data: T, degraded?: string): Sourced<T> {
  return { data, source: "carry", state: "live", degraded };
}

/**
 * carry is not configured in this deployment. Not a failure and not something a
 * retry can fix — there is simply no backend here.
 */
export function unconfigured<T>(data: T, fallback: DataFallback, degraded?: string): Sourced<T> {
  return { data, source: "fixtures", state: "absent", fallback, degraded };
}

/**
 * carry IS configured and did not answer.
 *
 * The caller receives an honest empty value plus `x-data-state: degraded` and
 * `x-data-fallback: empty`. We never make an outage look successful by serving
 * demo or recovered wearer data.
 */
export function failed<T>(data: T, degraded: string, fallback: DataFallback): Sourced<T> {
  return { data, source: "fixtures", state: "degraded", fallback, degraded };
}

/**
 * The wearer's session died behind their cookie.
 *
 * One sentence and one machine-readable flag for the whole seam, so a route can
 * answer 401 + `reauthenticate` instead of a 502 that accuses the backend. Same
 * words `describe()` uses, because the same condition must never read as two
 * different things on two panes.
 */
const SESSION_EXPIRED = "Your session expired — sign in again to reload this.";

export function expired<T>(data: T): Sourced<T> {
  return {
    data,
    source: "fixtures",
    state: "degraded",
    fallback: "empty",
    degraded: SESSION_EXPIRED,
    reauthenticate: true,
  };
}

/**
 * A failed gRPC call, with the expiry told apart from the outage.
 *
 * Every `catch` in the domain seam that degrades a workload call goes through
 * here. The bug this closes is not a missing typed error — it is that the typed
 * error existed and was flattened into prose the moment it reached `describe()`,
 * so the layer that could act on it (the route) never saw it.
 */
export function failedGrpc<T>(data: T, error: unknown): Sourced<T> {
  if (error instanceof SessionExpiredError) return expired(data);
  return failed(data, describe(error), "empty");
}

/** The REST half of the same rule; `describeWebapi` names the plane, not the wearer. */
export function failedWebapi<T>(data: T, error: unknown): Sourced<T> {
  if (error instanceof SessionExpiredError) return expired(data);
  return failed(data, describeWebapi(error), "empty");
}

/**
 * google.protobuf.Timestamp → ISO string, or "" when there is no timestamp.
 *
 * `creation_time` is an optional submessage and every layer beneath Center
 * treats its absence as genuine: the proto declares it optional, proto-loader
 * yields null, the Cosmos store columns are nullable and it orders such rows
 * NULLS LAST. Center was the only layer that invented a value — this returned
 * `new Date().toISOString()`, i.e. NOW — on the one surface whose whole job is
 * telling the wearer what was recorded and when.
 *
 * What that did: the row rendered with today's date and was counted in My Data's
 * "Today" tile, while `timestampMs` — the other reader of the same field, ten
 * lines down — scored it 0 and sorted it to the very bottom of the list. So the
 * wearer saw a today-stamped row at the end of a newest-first list, and a Today
 * counter that included an event which may be years old. Two helpers over one
 * field, disagreeing about the absent case, and both of them guessing.
 *
 * Empty string rather than null keeps `EventEnvelope.userCreatedAt` a string for
 * every consumer; `formatTimestamp` renders it as "Time unknown" and the Today
 * filter cannot count it, because an unparseable date compares false.
 */
export function tsToIso(ts: { seconds?: string | number; nanos?: number } | undefined): string {
  if (!ts?.seconds) return "";
  const ms = Number(ts.seconds) * 1000 + Math.floor((ts.nanos ?? 0) / 1e6);
  return new Date(ms).toISOString();
}

/* ---------------------------------------------------- webapi deletes ------ */

/**
 * What a delete actually did, in the backend's own word.
 *
 * Never inferred from a 2xx. The REST contract answers **200 for "there was
 * nothing of yours to delete" too**, so a status code cannot tell the two apart
 * and treating the happy code as done is precisely the silent lie this whole
 * path exists to stop. A privacy product may not say "deleted" on a guess.
 */
export interface Deleted {
  deleted: boolean;
}

/** No REST plane here at all, so nothing was — or could be — removed. */
export const WEBAPI_UNSET_FOR_DELETE =
  "CARRY_WEBAPI_BASE_URL is unset - there is no backend here to delete from, so nothing was deleted";

/**
 * The backend answered, and answered `false`: no row of this wearer's matched.
 *
 * Not an error and not a success. It is what a delete against recovered sample
 * data looks like, and what a second click after a first delete looks like.
 */
export const NOTHING_MATCHED =
  "carry found nothing to delete for this account - it may already be gone, or it was never stored here";

/**
 * `webapiGet`'s counterpart — the one delete verb the REST webapi speaks.
 *
 * Same base URL, same deadline, and the same wearer identity: without
 * `webapiHeaders` the clone resolves its demo principal, and a delete aimed at
 * the wrong partition either misses silently or lands where it was never this
 * caller's to land. The backend scopes every delete to the principal it
 * resolves, so identity here is a correctness property, not a nicety.
 *
 * The body is frozen by contract:
 *
 *   200 {"deleted": true}   a row existed for this principal and is gone
 *   200 {"deleted": false}  nothing matched for this principal
 *   500                     store outage ONLY — never "not found"
 *
 * So the boolean is returned rather than collapsed into thrown/not-thrown.
 * Anything else throws and the caller reports a failure — never a delete.
 */
export async function webapiDelete(path: string): Promise<boolean> {
  // Headers first, then the deadline — same reason as webapiGet: written the
  // other way round, the timeout is spent on the auth hop and a slow Keycloak is
  // reported to the wearer as a webapi that timed out.
  const headers = await webapiHeaders();
  const res = await fetch(`${CARRY_WEBAPI}${path}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(Number(process.env.CARRY_DEADLINE_MS ?? 8000)),
    cache: "no-store",
    headers,
  });
  // Same message stem webapiGet throws, so describeWebapi reads it the same way.
  if (!res.ok) throw new Error(`webapi ${path} -> ${res.status}`);

  const body = (await res.json().catch(() => null)) as { deleted?: unknown } | null;
  // A 200 carrying no `deleted` field is a backend that is not speaking this
  // contract. Report the outage rather than telling a wearer their data is gone.
  if (!body || typeof body.deleted !== "boolean") {
    throw new Error(`webapi ${path} -> 200 without a "deleted" field`);
  }
  return body.deleted;
}

/* ------------------------------------------------------- page bounds ------ */

/**
 * The stock page size the `.Center` client asked for, and the default for every
 * list here, so /api/capture/notes and /api/capture/captures still mirror the
 * original verbatim.
 *
 * It is a DEFAULT rather than a constant because the Memories dashboard renders
 * three note slots and one photo tile, and used to download two hundred of each
 * — every note decrypted server side on the way — every five seconds to fill
 * them. A caller that needs the whole page still asks for the whole page.
 */
export const STOCK_PAGE_SIZE = 200;

/**
 * Cosmos clamps a page to `MAX_PAGE_SIZE` (capture_api.rs) and rejects nothing,
 * so an out-of-range ask is silently reinterpreted. Bound it here too, where the
 * caller can still be told what it will get.
 */
export function boundedPageSize(size: number): number {
  if (!Number.isFinite(size)) return STOCK_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(size), 1), STOCK_PAGE_SIZE);
}

/* ------------------------------------------------------ descriptions ------ */

/** gRPC status codes worth naming, so a failure says what to fix. */
const GRPC_CODE: Record<number, string> = {
  12: "UNIMPLEMENTED — that service isn't registered on this workload",
  14: "UNAVAILABLE — workload not reachable",
  4: "DEADLINE_EXCEEDED",
  16: "UNAUTHENTICATED",
  7: "PERMISSION_DENIED",
};

export function describe(error: unknown): string {
  // Name the one failure a wearer can actually act on. Left to the generic
  // paths, an expired Keycloak grant reaches the workload as a call with no
  // identity and comes back as "UNAVAILABLE — workload not reachable:
  // authenticated edge principal required", which reads as a broken deployment
  // and is why this went unrecognised: the deployment was fine and the wearer
  // only needed to sign in again.
  //
  // The same sentence `failedGrpc`/`failedWebapi` use, from the same constant:
  // two wordings of one condition is how this seam got into trouble in the first
  // place, and `describe()` is still reachable from callers that build their own
  // result rather than going through those helpers.
  if (error instanceof SessionExpiredError) return SESSION_EXPIRED;
  // Two Center-side conditions that must never be dressed as a backend outage.
  // A missing channel key is a wearer/identity problem and a missing contracts
  // directory is a deployment problem in THIS process; both used to fall through
  // to "carry error: …", which sends every reader to look at a healthy Cosmos.
  if (error instanceof ChannelKeyUnavailableError || error instanceof ContractsUnavailableError) {
    return error.message;
  }
  if (error && typeof error === "object" && "code" in error) {
    const e = error as { code?: number; details?: string };
    const named = e.code !== undefined ? GRPC_CODE[e.code] : undefined;
    const detail = e.details && e.details.length > 0 ? `: ${e.details}` : "";
    return `carry ${named ?? `error ${e.code}`}${detail}`;
  }
  return error instanceof Error ? `carry error: ${error.message}` : "carry unreachable";
}

/**
 * The REST half fails differently — an HTTP status or an AbortSignal timeout,
 * never a gRPC code — so say webapi rather than passing it through `describe`,
 * which would label it "carry error" and hide which plane went quiet.
 */
export function describeWebapi(error: unknown): string {
  const e = error as { name?: string; message?: string } | null;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return "carry webapi timed out";
  }
  // webapiGet's own message already begins "webapi <path> -> <status>".
  const message = e?.message?.replace(/^webapi\s+/, "");
  return message ? `carry webapi error: ${message}` : "carry webapi unreachable";
}
