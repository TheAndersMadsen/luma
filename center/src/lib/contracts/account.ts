import * as z from "zod/mini";
import { bodyProvenanceShape } from "./dataSource";
import { countSchema } from "./pagination";

/** Cosmos account_api::ProfileDto. The route normalizes unset names to null for its view. */
export const profileSchema = z.object({
  preferredName: z.string(),
  pronunciation: z.string(),
});
export type Profile = z.infer<typeof profileSchema>;
export const profileDtoSchema = z.extend(profileSchema, {
  hasSecureBioData: z.boolean(),
});
export type ProfileDto = z.infer<typeof profileDtoSchema>;
export const accountDetailsSchema = z.object({
  preferredName: z.nullable(z.string()),
  pronunciation: z.nullable(z.string()),
  hasSecureBioData: z.boolean(),
});
export type AccountDetails = z.infer<typeof accountDetailsSchema>;
/** GET /api/account/details: the profile plus the signed-in identity. */
export const accountDetailsViewSchema = z.extend(accountDetailsSchema, {
  firstName: z.nullable(z.string()),
  lastName: z.nullable(z.string()),
  username: z.nullable(z.string()),
  ...bodyProvenanceShape,
});
export type AccountDetailsView = z.infer<typeof accountDetailsViewSchema>;
/** Last reported status is optional. No report is distinct from an unreadable report. */
export const deviceAssignmentSchema = z.object({
  deviceId: z.string(),
  serialNumber: z.optional(z.string()),
  pairedAt: z.optional(z.string()),
  blocked: z.boolean(),
  blockedAt: z.optional(z.string()),
  statusUnreadable: z.optional(z.literal(true)),
  status: z.optional(
    z.object({
      reportedAt: z.string(),
      batteryPercent: countSchema,
      batteryCharging: z.boolean(),
      firmwareVersion: z.string(),
      osVersion: z.string(),
      wifiNetworks: z.array(
        z.object({
          ssid: z.string(),
          authorizationType: z.string(),
          connected: z.boolean(),
        }),
      ),
    }),
  ),
});
export type DeviceAssignment = z.infer<typeof deviceAssignmentSchema>;
export const devicesSchema = z.object({
  devices: z.array(deviceAssignmentSchema),
});
export const deviceBlockSchema = z.object({
  deviceId: z.string(),
  blocked: z.boolean(),
  blockedAt: z.optional(z.string()),
});
export type DeviceBlock = z.infer<typeof deviceBlockSchema>;
export const devicePairingSchema = z.object({
  deviceId: z.string(),
  paired: z.boolean(),
});
export type DevicePairing = z.infer<typeof devicePairingSchema>;
export const deviceUnpairingSchema = z.object({
  deviceId: z.string(),
  removed: z.boolean(),
});
export type DeviceUnpairing = z.infer<typeof deviceUnpairingSchema>;
const pairedPinSchema = z.object({
  deviceId: z.string(),
  /** Epoch seconds. */
  pairedAt: z.nullable(z.number()),
  /** Block mode: Cosmos refuses every call from this Pin, which locks it. */
  blocked: z.boolean(),
  blockedAt: z.nullable(z.string()),
});
export type PairedPin = z.infer<typeof pairedPinSchema>;
/** GET /api/devices/pair. */
export const pairedPinsSchema = z.object({
  devices: z.array(pairedPinSchema),
  /** Pins still in block mode after their pairing was removed. */
  unpairedBlocked: z.array(pairedPinSchema),
});
export type PairedPins = z.infer<typeof pairedPinsSchema>;
/** The response proves only whether a passcode is set. It never contains the code. */
export const passcodeStateSchema = z.object({ set: z.boolean() });
export type PasscodeState = z.infer<typeof passcodeStateSchema>;
/** GET /api/account/passcode: `set` is null when Cosmos did not answer. */
export const passcodeViewSchema = z.object({
  set: z.nullable(z.boolean()),
  ...bodyProvenanceShape,
});
export type PasscodeView = z.infer<typeof passcodeViewSchema>;
