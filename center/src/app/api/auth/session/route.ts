import { cookies } from "next/headers";

import { AUTH_ENABLED, SESSION_COOKIE, verifySession } from "@/server/auth";

export const runtime = "nodejs";

/** The minimum browser-safe session shape needed to gate optional navigation. */
export async function GET() {
  const jar = await cookies();
  const session = AUTH_ENABLED
    ? await verifySession(jar.get(SESSION_COOKIE)?.value)
    : null;

  return Response.json(
    {
      authenticated: session !== null,
      operator: session?.operator === true,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
