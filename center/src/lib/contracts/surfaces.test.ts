// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { BROWSER_SURFACE_POSTURE, parseSurface } from "./surfaces";

it("the validated browser posture matches the canonical Phase 2A contract", () => {
  const contract = JSON.parse(readFileSync(new URL("../../../../contracts/surface-registry.json", import.meta.url), "utf8"));
  expect(BROWSER_SURFACE_POSTURE).toEqual(Object.fromEntries(Object.keys(BROWSER_SURFACE_POSTURE).map(key => [key, contract.Surface[key]])));
});

it("missing or expanded manifest dimensions cannot be stripped into a trusted display", () => {
  const surface = { ...BROWSER_SURFACE_POSTURE, surfaceId: "11111111-1111-1111-1111-111111111111", revision: 1,
    sequence: 0, revoked: false, visible: false, connected: false, available: false, connectionExpiresAt: 0, leaseExpiresAt: 0 };
  for (const field of Object.keys(BROWSER_SURFACE_POSTURE)) {
    const incomplete: Record<string, unknown> = { ...surface };
    delete incomplete[field];
    expect(() => parseSurface(incomplete)).toThrow("unsupported_surface_posture");
  }
  expect(() => parseSurface({ ...surface, manifest: { ...surface.manifest, hiddenAuthority: true } })).toThrow("unsupported_surface_posture");
});
