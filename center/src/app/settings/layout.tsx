"use client";

import { usePathname } from "next/navigation";
import { SettingsFrame } from "./SettingsFrame";
import { resolveSettingsPane } from "./settingsRegistry";

/**
 * Settings chrome, a master/detail layout.
 *
 * Observed structure: the left nav is the master. Each pane is its own
 * `<div role="article">` with a `<header>` titled by the pane name
 * (e.g. "Details") plus a "Go back to settings" control that returns to the
 * settings menu, not the app root. The subtitle is the consumer-facing area
 * that owns the pane, so technical routes remain findable without exposing
 * reconstruction provenance or transport details.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const pane = resolveSettingsPane(pathname);
  const backHref = pathname === "/settings" ? "/" : "/settings";
  const backLabel = pathname === "/settings" ? "Back to Center" : "Go back to settings";

  return (
    <SettingsFrame
      title={pane.title}
      group={pane.group}
      backHref={backHref}
      backLabel={backLabel}
      overview={pathname === "/settings"}
    >
      {children}
    </SettingsFrame>
  );
}
