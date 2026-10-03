/*
 * Where the installer's primary action leads after a successful install.
 * Import-free on purpose: the server page reads `?from=` and picks the link
 * without pulling the WebUSB stack into the server bundle.
 */

/**
 * Where a successful install hands the wearer off to.
 *
 * The SPA sent them to its own `/setup/` root. In Center the equivalent
 * destination is the Pin console, which is where every configuration pane
 * (server, LLM, services, eSIM, flags, diagnostics) now lives. Overridable so
 * the route layer can retarget it without editing this reducer.
 */
export const DEFAULT_POST_INSTALL_LINK = Object.freeze({
  label: "Open Pin settings",
  href: "/settings/pin",
});

/**
 * Where a wearer who opened the installer from Guided setup goes next
 * (INFERRED: Luma's own setup journey). Guided setup links here with
 * `?from=setup`, so the next step is back in the journey, not the console.
 */
export const GUIDED_SETUP_POST_INSTALL_LINK = Object.freeze({
  label: "Continue Guided setup",
  href: "/settings/pin/setup",
});

/** The `from` value Guided setup puts on its installer link. */
export const INSTALL_FROM_GUIDED_SETUP = "setup";

export function postInstallLinkFor(from: string | null | undefined): {
  readonly label: string;
  readonly href: string;
} {
  return from === INSTALL_FROM_GUIDED_SETUP
    ? GUIDED_SETUP_POST_INSTALL_LINK
    : DEFAULT_POST_INSTALL_LINK;
}
