/*
 * /settings/pin/setup, the guided path from a stock Ai Pin to a provisioned one.
 *
 * A server component for one reason, the same reason /settings/pin/install is:
 * one step of the ceremony (minting the device's attestation credential) is an
 * operator-only Settings pane, and whether this session may go there is
 * a server-side fact. A client component must not be the one deciding it, and
 * an entry point a wearer can click only to be bounced back to "/" with no
 * explanation is worse than no entry point at all, so the link is rendered
 * only when the operator claim is present. The provisioning page enforces the
 * same gate on the server.
 *
 * `currentSession()` reads cookies, which already opts this route out of static
 * rendering; `dynamic = "force-dynamic"` states it rather than relying on that
 * side effect.
 */

import type { Metadata } from "next";
import { currentSession } from "@/server/operator";
import SetupView from "./SetupView";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Guided setup",
};

export default async function PinSetupPage() {
  const session = await currentSession();
  const operator = session?.operator === true;

  return (
    <SetupView
      operator={operator}
      provisioningHref={operator ? "/settings/pin/provision" : null}
    />
  );
}
