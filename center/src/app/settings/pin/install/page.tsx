/*
 * /settings/pin/install, check for, install, update or recover Luma on an Ai Pin.
 *
 * A server component on purpose. It reads the session so the client never has
 * to guess who it is talking to: the device shell at /admin/pin/terminal is an
 * operator surface with full administrator control, and an entry point a
 * wearer can click only to be bounced back to "/" with no explanation is worse
 * than no entry point at all. The link is therefore offered only when the
 * operator claim is present, and the route itself is still gated twice,
 * `middleware.ts` and `src/app/admin/pin/layout.tsx`, regardless of what this
 * page renders.
 *
 * `currentSession()` reads cookies, which already opts this route out of static
 * rendering; `dynamic = "force-dynamic"` states it rather than relying on that
 * side effect.
 *
 * `?from=setup` (Guided setup's installer link) makes a successful install
 * lead back to Guided setup instead of the Pin console.
 */

import type { Metadata } from "next";
import { OPERATOR_PIN_SHELL_PATH } from "@/server/auth";
import { currentSession } from "@/server/operator";
import { postInstallLinkFor } from "@/lib/pin-install/app/postInstallLink";
import { InstallPane } from "./InstallPane";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Software & updates",
};

export default async function PinInstallPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  const [session, params] = await Promise.all([currentSession(), searchParams]);
  const terminalHref = session?.operator === true ? OPERATOR_PIN_SHELL_PATH : null;
  const from = typeof params.from === "string" ? params.from : null;

  return <InstallPane terminalHref={terminalHref} postInstallLink={postInstallLinkFor(from)} />;
}
