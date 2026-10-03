import { originFromHeaders } from "@/server/auth";
import { mcpGate, mcpProxy } from "../../proxy";

const SERVICES_PATH = "/settings/account/services";
/** The shape Cosmos gives a sign-in's `state` (base64url). */
const PENDING_STATE = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_CODE_LENGTH = 4096;

/*
 * A tool server's sign-in provider sends the owner's browser here when it is
 * done. This is a top-level navigation, so every outcome is a redirect to the
 * Services page, never JSON: the Tool servers card reads `?mcp=` and says how
 * the sign-in ended. Cosmos holds the sign-in's secrets and exchanges the code;
 * this route only hands it the `state` and `code` from the address.
 */
export async function GET(request: Request) {
  const incoming = new URL(request.url);
  const origin = originFromHeaders(request.headers) ?? incoming.origin;
  // No same-origin check: the provider's redirect is cross-site by nature. The
  // single-use `state` Cosmos issued to this owner is what ties it to them.
  const refused = await mcpGate();
  if (refused) {
    if (refused.status !== 401) return refused;
    // Center's sign-in lapsed while the owner was at the provider. Cosmos
    // drops the unfinished sign-in on its own after a few minutes.
    const login = new URL("/login", origin);
    login.searchParams.set("next", `${SERVICES_PATH}?mcp=sign-in-failed`);
    return Response.redirect(login, 303);
  }
  const state = incoming.searchParams.get("state") ?? "";
  const code = incoming.searchParams.get("code") ?? "";
  let signedIn = false;
  if (PENDING_STATE.test(state)) {
    // A provider that refused sends `error` and no code. Cosmos is still told,
    // with an empty code, so the pending sign-in is dropped at once.
    const response = await mcpProxy("POST", "/oauth/finish", {
      state,
      code: code.length <= MAX_CODE_LENGTH ? code : "",
    });
    signedIn = response.ok;
    await response.body?.cancel().catch(() => undefined);
  }
  const destination = new URL(SERVICES_PATH, origin);
  destination.searchParams.set("mcp", signedIn ? "signed-in" : "sign-in-failed");
  return Response.redirect(destination, 303);
}
