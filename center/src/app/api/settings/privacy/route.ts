import { NextResponse } from "next/server";
import { sourceHeaders } from "@/server/headers";
import {
  getPrivacySettings,
  privacySettingValue,
  updatePrivacySetting,
  type PrivacySetting,
} from "@/server/domain/settings";

/**
 * Settings → Privacy toggles. The protocol work lives in
 * `@/server/domain/settings`; this route only maps each outcome onto its
 * stable HTTP body.
 *
 * Every path try/catches inside the domain module: no path 500s, and a failed
 * write reports `ok:false` rather than throwing, so a toggle can revert.
 *
 * WHAT THE FAILURE PATH USED TO SAY. It tagged an empty error result as
 * `x-data-source: fixtures` — the same value a route serving recovered Feb-2025
 * sample data uses — so "cosmos did not answer" and "here is someone else's
 * data" were indistinguishable on the wire, and the pane rendered both as
 * "Privacy settings are unavailable from this backend". Now: an unconfigured
 * backend is `absent`, a backend that did not answer is `degraded`, and
 * `x-data-fallback: empty` says there is nothing on screen instead. The same
 * three words come back in the JSON body, because the pane reads the body.
 */

export type { PrivacySetting };

const SESSION_EXPIRED_BODY = {
  error: "Your session expired — sign in again.",
  reauthenticate: true,
} as const;

export async function GET() {
  const read = await getPrivacySettings();
  if (read.kind === "absent") {
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
  if (read.kind === "expired") {
    // An expired Keycloak grant behind a still-valid Center cookie is the
    // wearer's problem, not the backend's — answer it the way every settings
    // pane does, or one expiry reads as two contradictory conditions.
    return NextResponse.json(SESSION_EXPIRED_BODY, { status: 401 });
  }
  if (read.kind === "degraded") {
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
  return NextResponse.json(
    { settings: read.value, state: "live" },
    { headers: sourceHeaders({ source: "cosmos", state: "live" }) },
  );
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
  const value = privacySettingValue(body.value);

  const write = await updatePrivacySetting(name, value);
  if (write.kind === "absent") {
    return NextResponse.json({ ok: false, status: null, unavailable: true, state: "absent" });
  }
  if (write.kind === "expired") {
    // A toggle that failed because the wearer needs to sign in again must say
    // so, or the pane reverts the switch and blames a backend that is fine.
    return NextResponse.json({ ok: false, status: null, ...SESSION_EXPIRED_BODY }, { status: 401 });
  }
  if (write.kind === "degraded") {
    // Report the failure to the client so an optimistic toggle can revert; never 500.
    return NextResponse.json({ ok: false, status: null, unavailable: true, state: "degraded" });
  }
  return NextResponse.json(write.value);
}
