/*
 * Settings → Features: the wearer's own choices for the stock Pin features
 * their Pins are served. Cosmos keeps them per account, as humane.center did
 * (the stock evidence is in cosmos `flag_overrides.rs`), and serves them to
 * that account's Pins at their next flag sync. Center holds none of it.
 *
 *   GET    /feature-flags/features          every feature the wearer may choose (Page<T>)
 *   PUT    /feature-flags/features/{name}   {value} → the feature as it now stands
 *   DELETE /feature-flags/features/{name}   {"deleted": bool}: back to the server's default
 *
 * The paths are Luma's (INFERRED): the recovered humane.center client kept the
 * `feature-flags` scope name, not this page's calls. Which features a wearer
 * may change is Cosmos's decision. Center renders the list it is given.
 */

import { featureSchema, type Feature } from "@/lib/contracts/features";
import { deletedSchema, springPageSchema } from "@/lib/contracts/pagination";
import { parseResponse } from "@/lib/contracts/parse";
import {
  COSMOS_WEBAPI,
  COSMOS_WEBAPI_ENABLED,
  SessionExpiredError,
  cosmosDeadlineSignal,
  webapiError,
  webapiGet,
  webapiHeaders,
} from "../cosmos";

export type FeaturesRead =
  | { kind: "live"; features: Feature[] }
  | { kind: "absent" }
  | { kind: "expired" }
  | { kind: "degraded" };

export type FeatureWrite =
  | { kind: "saved"; feature: Feature }
  | { kind: "restored"; deleted: boolean }
  /** Cosmos refused the value and said why, in a sentence the wearer can act on. */
  | { kind: "refused"; reason: string }
  /** Not a feature this wearer can change. */
  | { kind: "unknown" }
  | { kind: "absent" }
  | { kind: "expired" }
  | { kind: "degraded" };

/** A stock `flag_name`. Anything else never reaches Cosmos. */
const FEATURE_NAME = /^[a-z0-9_]{1,64}$/;

/** Cosmos's refusals are fixed sentences. This bounds what is relayed. */
const MAX_REASON_CHARS = 200;

export async function readFeatures(): Promise<FeaturesRead> {
  if (!COSMOS_WEBAPI_ENABLED) return { kind: "absent" };
  try {
    const page = parseResponse(
      springPageSchema(featureSchema),
      await webapiGet("/feature-flags/features"),
    );
    return { kind: "live", features: page.content };
  } catch (error) {
    return error instanceof SessionExpiredError
      ? { kind: "expired" }
      : { kind: "degraded" };
  }
}

/** Choose a value (PUT) or go back to the server's default (DELETE). */
export async function writeFeature(
  name: string,
  method: "PUT" | "DELETE",
  value?: boolean | number | string,
): Promise<FeatureWrite> {
  if (!FEATURE_NAME.test(name)) return { kind: "unknown" };
  if (!COSMOS_WEBAPI_ENABLED) return { kind: "absent" };
  const path = `/feature-flags/features/${encodeURIComponent(name)}`;
  try {
    // Headers first, deadline second (see `webapiGetWithHeaders`).
    const headers = await webapiHeaders();
    const response = await fetch(`${COSMOS_WEBAPI}${path}`, {
      method,
      headers:
        method === "PUT"
          ? { ...headers, "content-type": "application/json" }
          : headers,
      body: method === "PUT" ? JSON.stringify({ value }) : undefined,
      cache: "no-store",
      signal: cosmosDeadlineSignal(20_000),
    });
    if (response.status === 400) {
      const reason = (await response.text().catch(() => ""))
        .trim()
        .slice(0, MAX_REASON_CHARS);
      return {
        kind: "refused",
        reason: reason || "That value can’t be used for this feature.",
      };
    }
    if (response.status === 404) return { kind: "unknown" };
    if (!response.ok) throw webapiError(path, response.status, headers);
    const body: unknown = await response.json();
    if (method === "DELETE") {
      const { deleted } = parseResponse(deletedSchema, body);
      return { kind: "restored", deleted };
    }
    return { kind: "saved", feature: parseResponse(featureSchema, body) };
  } catch (error) {
    return error instanceof SessionExpiredError
      ? { kind: "expired" }
      : { kind: "degraded" };
  }
}
