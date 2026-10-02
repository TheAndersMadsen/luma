import { NextResponse } from "next/server";
import { CosmosHttpError } from "@/server/cosmos";

export const SIGN_IN_AGAIN = "Your session expired — sign in again.";

/**
 * The 401 every wearer route answers when the Keycloak grant behind the session
 * has expired (`SessionExpiredError`). Clients branch on `reauthenticate`, not
 * on the sentence; `fields` carries the route's own envelope (`ok`, `url`, …).
 */
export function sessionExpiredResponse(
  fields: Record<string, unknown> = {},
  headers?: HeadersInit,
): NextResponse {
  return NextResponse.json(
    { error: SIGN_IN_AGAIN, ...fields, reauthenticate: true },
    { status: 401, headers },
  );
}

/**
 * The HTTP status Cosmos refused a web-plane call with, or `undefined` for a
 * timeout, a Center-side fault, or anything else that is not Cosmos's answer.
 * Routes branch on this, never on the diagnostic message.
 */
export function cosmosStatus(error: unknown): number | undefined {
  return error instanceof CosmosHttpError ? error.status : undefined;
}
