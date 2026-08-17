import { PinDeviceProvider } from "./PinDeviceProvider";
import { PinServiceLostBanner } from "./_lib/PaneShell";

/**
 * The Pin console shell.
 *
 * It renders no chrome of its own: `settings/layout.tsx` above it already
 * supplies the master/detail frame, the back button, the pane title/subtitle
 * and the nav, so these panes are Center panes rather than a second app.
 *
 * What this layout exists for is lifetime. App Router keeps a layout mounted
 * across navigations between its children, so the WebUSB/ADB session held by
 * `PinDeviceProvider` survives moving from Connect to Install to eSIM to
 * Diagnostics. The standalone SPA needed a bespoke provider at its router root
 * for exactly this; here it is just where the layout already is.
 */
export default function PinConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <PinDeviceProvider>
      {/*
        Lifetime is also why the "this Pin's server stopped answering" banner
        belongs here. The condition is a property of the SESSION this layout
        owns, not of any one pane, and leaving each pane to notice it meant nine
        of the thirteen never did — they went on rendering cached device settings
        as if the Pin were still listening. Rendered once, above whichever pane
        is mounted, it cannot be forgotten by the next pane somebody adds.
      */}
      <PinServiceLostBanner />
      {children}
    </PinDeviceProvider>
  );
}
