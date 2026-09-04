import { exact, integer, record, UUID } from "./surfaces";

export const PIN_APPROVAL = "pin-shared-speech-v1";
export const DEVICE_ID = /^[0-9a-f]{1,128}$/i;
// Owner-management projection only. This is not device authentication or model context.
export const PIN_SURFACE_POSTURE = {
  name: "Ai Pin",
  approval: PIN_APPROVAL,
  manifest: {
    class: "wearable",
    capabilities: { input: ["user.request"], output: { "audio.tts": { maxClass: "shared_room", shared: true } } },
    constraints: ["actor_unknown", "occupancy_unknown", "render_unverified", "playback_unverified", "no_verified_epoch_sequence"],
    expression: {},
    cognition: { declaredClass: 0, models: [] },
    authority: { mayOriginate: ["user.request"], reflexive: [] },
  },
  trustLevel: 0,
  occupancy: "unknown",
  actorIdentity: "unknown",
  renderVerified: false,
  playbackVerified: false,
} as const;
export interface PinSurface extends Readonly<typeof PIN_SURFACE_POSTURE> {
  surfaceId: string;
  deviceId: string;
  revision: number;
  revoked: boolean;
  currentPaired: boolean | null;
}
export function parsePinSurface(value: unknown, allowUnknownPairing = false): PinSurface {
  const pin = record(value);
  if (!Object.entries(PIN_SURFACE_POSTURE).every(([key, expected]) => exact(pin[key], expected))) throw new Error("unsupported_pin_posture");
  if (typeof pin.surfaceId !== "string" || !UUID.test(pin.surfaceId)
    || typeof pin.deviceId !== "string" || !DEVICE_ID.test(pin.deviceId) || pin.deviceId !== pin.deviceId.toLowerCase()
    || !integer(pin.revision, 1) || typeof pin.revoked !== "boolean"
    || typeof pin.currentPaired !== "boolean" && !(allowUnknownPairing && pin.currentPaired === null)) throw new Error("invalid_pin");
  return { ...PIN_SURFACE_POSTURE, surfaceId: pin.surfaceId, deviceId: pin.deviceId, revision: pin.revision, revoked: pin.revoked, currentPaired: pin.currentPaired };
}
export function parsePinSurfaces(value: unknown): PinSurface[] {
  const { pins } = record(value);
  if (!Array.isArray(pins) || pins.length > 16) throw new Error("invalid_pin_list");
  const parsed = pins.map(pin => parsePinSurface(pin, true));
  if (parsed.some(pin => pin.revoked) || new Set(parsed.map(pin => pin.surfaceId)).size !== parsed.length
    || new Set(parsed.map(pin => pin.deviceId)).size !== parsed.length) throw new Error("invalid_pin_list");
  return parsed;
}
