import { NextResponse } from "next/server";
import { CARRY_ENABLED, SessionExpiredError, call, Services } from "@/server/cosmos";
import { sourceHeaders } from "@/server/headers";

/**
 * Settings → Privacy toggles, backed by `PublicPrivacyService`.
 *
 *   GET  → GetSettings   (PrivacySettingInfo{ name, status, value }[])
 *   POST → UpdateSettings (PrivacySetting{ name, value }[] → SettingStateResponse[])
 *
 * `GetSettingsRequest.names` is a repeated string; an empty list asks for every
 * setting the backend knows. Each `PrivacySettingInfo` carries a `name` and a
 * string `value` (the stock Pin uses "on"/"off"); the human label is derived from the
 * name on the client. Labels/manager metadata live on `PrivacySettingConfiguration`
 * (GetConfiguration), a separate RPC we deliberately do not fan out to here.
 *
 * Every path try/catches: no path 500s, and a failed write reports `ok:false`
 * rather than throwing, so a toggle can revert.
 *
 * WHAT THE FAILURE PATH USED TO SAY. It tagged an empty error result as
 * `x-data-source: fixtures` — the same value a route serving recovered Feb-2025
 * sample data uses — so "carry did not answer" and "here is someone else's
 * data" were indistinguishable on the wire, and the pane rendered both as
 * "Privacy settings are unavailable from this backend". Now: an unconfigured
 * backend is `absent`, a backend that did not answer is `degraded`, and
 * `x-data-fallback: empty` says there is nothing on screen instead. The same
 * three words come back in the JSON body, because the pane reads the body.
 */

export interface PrivacySetting {
  name: string;
  value: string;
  status?: string;
}

interface GetSettingsResponse {
  settings?: Array<{ name?: string; value?: string; status?: string }>;
}

export async function GET() {
  if (!CARRY_ENABLED) {
    // Not a failure and not retryable: nothing is configured to answer.
    const degraded = "This Center is not connected to Pin services.";
    return NextResponse.json(
      { settings: [], unavailable: true, state: "absent", degraded },
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
    const res = await call<{ names: string[] }, GetSettingsResponse>(
      Services.privacy,
      "GetSettings",
      { names: [] },
    );

    const settings: PrivacySetting[] = (res.settings ?? [])
      .map((s) => ({
        name: (s.name ?? "").trim(),
        value: s.value ?? "",
        status: s.status,
      }))
      .filter((s) => s.name.length > 0);

    return NextResponse.json(
      { settings, state: "live" },
      { headers: sourceHeaders({ source: "carry", state: "live" }) },
    );
  } catch (error) {
    // An expired Keycloak grant behind a still-valid Center cookie is the
    // wearer's problem, not the backend's. A bare catch here reported it as
    // "PublicPrivacyService.GetSettings did not answer" — a claim that the
    // backend is down — while api/settings/wifi answered the IDENTICAL error
    // with 401 + reauthenticate. One expiry, two contradictory explanations on
    // two panes. Same arm, same answer.
    if (error instanceof SessionExpiredError) {
      return NextResponse.json(
        { error: "Your session expired — sign in again.", reauthenticate: true },
        { status: 401 },
      );
    }
    // Honest degraded state — never a 500, and never dressed as an absence.
    const degraded = "PublicPrivacyService.GetSettings did not answer.";
    return NextResponse.json(
      { settings: [], unavailable: true, state: "degraded", degraded },
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

interface UpdateSettingsResponse {
  results?: Array<{ name?: string; status?: string }>;
}

export async function POST(req: Request) {
  let body: { name?: string; value?: unknown };
  try {
    body = (await req.json()) as { name?: string; value?: unknown };
  } catch {
    body = {};
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ ok: false, error: "missing setting name" }, { status: 400 });
  }
  // The stock key-upload predicate joins configuration and settings by exact
  // string equality.  Its observed values are "on"/"off", so persisting the
  // browser's raw booleans as "true"/"false" silently disables every matching
  // key-manager gate even though the toggle looks enabled in Center.
  const value =
    typeof body.value === "boolean"
      ? body.value
        ? "on"
        : "off"
      : String(body.value ?? "");

  if (!CARRY_ENABLED) {
    return NextResponse.json({ ok: false, status: null, unavailable: true, state: "absent" });
  }

  try {
    const res = await call<{ settings: Array<{ name: string; value: string }> }, UpdateSettingsResponse>(
      Services.privacy,
      "UpdateSettings",
      { settings: [{ name, value }] },
    );

    const result = (res.results ?? [])[0];
    const status = result?.status ?? null;
    const ok = status === "SETTING_SUCCESS" || status === "SETTING_UPDATED";
    return NextResponse.json({ ok, status });
  } catch (error) {
    // Same expiry, same answer as the read above: a toggle that failed because
    // the wearer needs to sign in again must say so, or the pane reverts the
    // switch and blames a backend that is fine.
    if (error instanceof SessionExpiredError) {
      return NextResponse.json(
        { ok: false, status: null, error: "Your session expired — sign in again.", reauthenticate: true },
        { status: 401 },
      );
    }
    // Report the failure to the client so an optimistic toggle can revert; never 500.
    return NextResponse.json({ ok: false, status: null, unavailable: true, state: "degraded" });
  }
}
