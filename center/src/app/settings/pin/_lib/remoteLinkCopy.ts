import type { PinRemoteUnpaired } from "../PinDeviceProvider";

/*
 * What the Pin console says while Center's remote link has no Pin this wearer
 * may reach. Each sentence names the one thing that changes it: Guided setup's
 * "Turn on remote access" over USB for a link with no Pin (or a released one),
 * and USB for a server whose link is not this wearer's or not set up.
 */
const CONSOLE: Readonly<Record<PinRemoteUnpaired, string>> = {
  pin_not_paired:
    "Remote access isn’t on for your Pin yet. Connect it over USB and choose Turn on remote access in Guided setup.",
  pin_binding_invalid:
    "Remote access still points at a Pin that is no longer paired. Connect your Pin over USB and choose Turn on remote access in Guided setup.",
  wrong_owner: "Center’s remote link belongs to a Pin on another account. Connect your Pin over USB.",
  bridge_not_configured: "Remote Pin access is not set up on this server. Connect your Pin over USB.",
  bridge_misconfigured:
    "Remote Pin access is misconfigured on this server. Connect your Pin over USB until it is fixed.",
};

/** Guided setup already is the place to connect over USB, so it says less. */
const SETUP: Readonly<Record<PinRemoteUnpaired, string>> = {
  ...CONSOLE,
  pin_not_paired: "Remote access isn’t on for a Pin yet. Connect yours over USB to set it up.",
  pin_binding_invalid:
    "Remote access still points at a Pin that is no longer paired. Connect your Pin over USB to turn it on for this one.",
};

export function remoteLinkMessage(reason: PinRemoteUnpaired, where: "console" | "setup"): string {
  return (where === "setup" ? SETUP : CONSOLE)[reason];
}
