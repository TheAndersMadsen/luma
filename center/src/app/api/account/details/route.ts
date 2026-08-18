import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { sourceHeaders } from "@/server/headers";
import { getAccountDetails, type AccountDetails, type Sourced } from "@/server/source";
import { SESSION_COOKIE, verifySession } from "@/server/auth";

export const runtime = "nodejs";

/**
 * GET /api/account/details — Settings → Details.
 *
 * The account gRPC service only holds preferred name + pronunciation; the
 * wearer's identity (email, name) lives in Keycloak and rides in the signed
 * session cookie. Merge it in so the page shows the real account instead of an
 * honest-absent placeholder for the person who is signed in. Names are only
 * split from a genuine `name` claim — never fabricated.
 *
 * `state` rides in the BODY as well as the headers, because the pane reads the
 * body. Preferred name, pronunciation and the sealed-bio flag are the only
 * fields the cosmos RPC serves; when it does not answer this route still returns
 * 200 with nulls in their place, so without the state the pane could not tell a
 * failed call from an account that genuinely holds no values, and rendered a
 * dead account workload as "not set".
 *
 * WHAT IS NOT HERE ANY MORE. This route used to hand the signed-in wearer's own
 * login address to the pane as `emails: [{ masked: email, isDefault: true }]`.
 * Its only consumer was the Multi-factor authentication section, so the pane
 * asserted an enrolled — and default — email second factor that this deployment
 * does not have and never read: no MFA lookup exists anywhere in the BFF. The
 * value was not masked either, despite the field it fed.
 *
 * The MFA section went with it, and this comment used to claim it had stayed and
 * "says so like the OTP one does" — a section that does not exist, compared to
 * another that does not exist either. Both factors lived in Keycloak's own
 * account console and have no counterpart in this BFF, so the pane shows nothing
 * about them rather than an inert control the wearer cannot operate; the same
 * reasoning is recorded beside `getAccountDetails()` in src/server/source.ts.
 * Whoever adds a Keycloak account-write path here should add the section back
 * with it — and not before.
 */
export async function GET() {
  // getAccountDetails degrades internally; the guard is so no path here can 500.
  let account: Sourced<AccountDetails | null>;
  try {
    account = await getAccountDetails();
  } catch (error) {
    account = {
      data: null,
      source: "fixtures",
      state: "degraded",
      fallback: "empty",
      degraded: error instanceof Error ? error.message : "GetUserPersonalDetails did not answer.",
    };
  }

  // The signed session is independent of the account RPC — read it defensively
  // so a cookie problem degrades the identity half rather than 500ing the route.
  let email: string | null = null;
  let name: string | null = null;
  try {
    const jar = await cookies();
    const session = await verifySession(jar.get(SESSION_COOKIE)?.value);
    email = session?.email?.trim() || null;
    name = session?.name?.trim() || null;
  } catch {
    email = null;
    name = null;
  }

  const base = account.data ?? { preferredName: null, pronunciation: null, hasSecureBioData: false };

  let firstName: string | null = null;
  let lastName: string | null = null;
  // Only derive first/last from a real, human name — not from the email that
  // Keycloak returns as the fallback `name` claim.
  if (name && name !== email && name.includes(" ")) {
    const parts = name.split(/\s+/);
    firstName = parts[0];
    lastName = parts.slice(1).join(" ");
  }

  const data = {
    ...base,
    firstName,
    lastName,
    username: email,
    state: account.state,
    degraded: account.degraded,
    // The pane renders nulls for every cosmos-served field when the call fails.
    // "Not set" and "your session expired" look identical there, and only one of
    // them is something the wearer can do anything about.
    reauthenticate: account.reauthenticate,
  };

  return NextResponse.json(data, { headers: sourceHeaders(account) });
}
