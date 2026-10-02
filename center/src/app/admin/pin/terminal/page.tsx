/*
 * /admin/pin/terminal, the Device Recovery Console for the attached Ai Pin.
 *
 * The route exists here, and not at /settings/pin/terminal where the standalone
 * Setup SPA kept it, because `isOperatorPath` in @/server/auth covers /admin and
 * nothing under /settings: full device control must not be a wearer affordance.
 * Two gates stand in front of it, middleware.ts, and the `requireOperatorSession`
 * call in app/admin/pin/layout.tsx, and verify/pin-terminal-gate.test.mjs fails
 * the build if either is loosened or if the shell reappears elsewhere.
 *
 * A Server Component that renders a client pane: `next/dynamic({ssr:false})`
 * cannot be called from a Server Component in Next 15, so the xterm import is
 * owned by TerminalPane.
 */

import type { Metadata } from "next";
import { TerminalPane } from "./TerminalPane";

/** The layout above already forces this. Stated here so the page stands alone. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Device Recovery Console",
  robots: { index: false, follow: false },
};

export default function PinTerminalPage() {
  return <TerminalPane />;
}
