// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { PIN_SURFACE_POSTURE, parsePairedPinDevices, parsePinSurface } from "./pinSurfaces";

it("the fixed Pin posture matches the canonical runtime approval contract", () => {
  const contract = JSON.parse(readFileSync(new URL("../../../../contracts/pin-surface.json", import.meta.url), "utf8"));
  expect(PIN_SURFACE_POSTURE).toEqual(Object.fromEntries(Object.keys(PIN_SURFACE_POSTURE).map(key => [key, contract.PinSurface[key]])));
});
it("requires every posture field and exact six dimensions, not inferred or elevated authority", () => {
  const pin = { ...PIN_SURFACE_POSTURE, surfaceId: "11111111-1111-1111-1111-111111111111", deviceId: "aabb", revision: 1, revoked: false, currentPaired: true };
  for (const key of Object.keys(PIN_SURFACE_POSTURE)) {
    const incomplete: Record<string, unknown> = { ...pin }; delete incomplete[key];
    expect(() => parsePinSurface(incomplete)).toThrow("unsupported_pin_posture");
  }
  expect(() => parsePinSurface({ ...pin, manifest: { ...pin.manifest, extraAuthority: true } })).toThrow("unsupported_pin_posture");
  expect(() => parsePinSurface({ ...pin, currentPaired: undefined })).toThrow("invalid_pin");
  expect(() => parsePinSurface({ ...pin, currentPaired: null })).toThrow("invalid_pin");
  expect(parsePinSurface({ ...pin, currentPaired: null }, true).currentPaired).toBeNull();
  expect(() => parsePinSurface({ ...pin, currentPaired: null, revoked: true })).toThrow("invalid_pin");
  expect(parsePinSurface({ ...pin, currentPaired: null, revoked: true }, true).currentPaired).toBeNull();
});
it("the pairing roster yields canonical device IDs only, and rejects anything it cannot canonicalize", () => {
  expect(parsePairedPinDevices({ devices: [{ deviceId: "AABB", pairedAt: 1 }, { deviceId: "aabb" }, { deviceId: "ccdd" }] })).toEqual(["aabb", "ccdd"]);
  expect(parsePairedPinDevices({ devices: [] })).toEqual([]);
  expect(() => parsePairedPinDevices({ devices: [{ deviceId: "not-hex" }] })).toThrow("invalid_device");
  expect(() => parsePairedPinDevices({ devices: [{ pairedAt: 1 }] })).toThrow("invalid_device");
  expect(() => parsePairedPinDevices({})).toThrow("invalid_roster");
  expect(() => parsePairedPinDevices({ devices: Array.from({ length: 257 }, () => ({ deviceId: "aabb" })) })).toThrow("invalid_roster");
});
