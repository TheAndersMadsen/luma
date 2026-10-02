import type { ReactNode } from "react";

import { OPERATOR_PIN_PATH_PREFIX } from "@/server/auth";
import { requireOperatorSession } from "@/server/operator";

/*
 * The operator gate for every Pin device surface that talks to hardware with no
 * further authorization, today `/admin/pin/terminal`, an ADB `shell.pty` on the
 * Pin, with full administrator control of the device from a browser tab.
 *
 * It lives here, as a LAYOUT, on purpose: App Router runs a layout before every
 * page beneath it, so any route added under `/admin/pin/` inherits the check
 * without its author having to remember it. Adding the shell to a wearer path
 * instead, `/settings/pin/terminal`, the location it occupied while the Pin
 * console was a standalone SPA, would hand full device control to every signed-in
 * wearer, which is why `isOperatorPath` names that retired path too.
 *
 * `middleware.ts` already refuses this prefix for non-operators. This is the
 * second, in-render gate. See `@/server/operator`.
 */

/** The gate reads the session cookie per request. Never prerender or cache this subtree. */
export const dynamic = "force-dynamic";

export default async function AdminPinLayout({ children }: { children: ReactNode }) {
  await requireOperatorSession(OPERATOR_PIN_PATH_PREFIX);
  return <>{children}</>;
}
