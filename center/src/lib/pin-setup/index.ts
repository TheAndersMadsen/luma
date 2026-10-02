/**
 * The guided-setup model.
 *
 * Pure, framework-free, and server-importable: it turns facts somebody else
 * read, a USB session, a release manifest, a package inspection, the device's
 * `Settings.Global`, the pairing roster, into an ordered plan with an honest
 * status per step. `network` holds the one part that drives the device itself:
 * getting the Pin online and its clock right over the same USB session. The
 * React surface that drives both lives at `app/settings/pin/setup`.
 */

export * from "./steps";
export * from "./network";
export * from "./onboarding";
export {
  PIN_SETUP_JOURNEY,
  type GeneratedPinSetupStep,
} from "./generated/journey";
