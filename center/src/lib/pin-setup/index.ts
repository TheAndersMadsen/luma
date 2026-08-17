/**
 * The guided-setup model.
 *
 * Pure, framework-free, and server-importable: it turns facts somebody else
 * read — a USB session, a release manifest, a package inspection, the device's
 * `Settings.Global`, the pairing roster — into an ordered plan with an honest
 * status per step. The React surface that drives it lives at
 * `app/settings/pin/setup`.
 */

export * from "./steps";
