// Browser-facing projection of contracts/surface-registry.json. No owner/device IDs.
export const SURFACE_APPROVAL = "browser-shared-display-v1";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SURFACE_TOKEN = /^[0-9a-f]{64}$/;
export const BROWSER_SURFACE_POSTURE = {
  name: "Browser display",
  manifest: {
    class: "browser",
    capabilities: { input: ["state.visibility"], output: { "visual.card": { maxClass: "shared_room", shared: true } } },
    constraints: ["visible_page_only", "no_background_output"],
    expression: { "visual.card": ["acknowledged", "degraded"] },
    cognition: { declaredClass: 0, models: [] },
    authority: { mayOriginate: ["state.change"], reflexive: [] },
  },
  trustLevel: 0,
  occupancy: "unknown",
  renderVerified: false,
} as const;
export interface Surface extends Readonly<typeof BROWSER_SURFACE_POSTURE> {
  surfaceId: string;
  revision: number;
  revoked: boolean;
  visible: boolean;
  connected: boolean;
  available: boolean;
  sequence: number;
  connectionExpiresAt: number;
  leaseExpiresAt: number;
}
export interface SurfaceConnection { token: string; incarnation: string; expiresAt: number }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_shape");
  return value as Record<string, unknown>;
}
export function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function exact(value: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(value) && value.length === expected.length && expected.every((item, index) => exact(value[index], item));
  if (expected && typeof expected === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const fields = Object.entries(expected);
    return Object.keys(value).length === fields.length && fields.every(([key, item]) => exact((value as Record<string, unknown>)[key], item));
  }
  return value === expected;
}
export function parseSurface(value: unknown): Surface {
  const s = record(value);
  // UI claims depend on the fixed approved posture, not merely well-shaped IDs.
  if (!Object.entries(BROWSER_SURFACE_POSTURE).every(([key, expected]) => exact(s[key], expected))) throw new Error("unsupported_surface_posture");
  if (typeof s.surfaceId !== "string" || !UUID.test(s.surfaceId) || !integer(s.revision, 1)
    || !integer(s.sequence) || !integer(s.connectionExpiresAt) || !integer(s.leaseExpiresAt)
    || [s.revoked, s.visible, s.connected, s.available].some(v => typeof v !== "boolean")) throw new Error("invalid_surface");
  return { ...BROWSER_SURFACE_POSTURE, surfaceId: s.surfaceId, revision: s.revision, sequence: s.sequence,
    connectionExpiresAt: s.connectionExpiresAt, leaseExpiresAt: s.leaseExpiresAt,
    revoked: s.revoked as boolean, visible: s.visible as boolean,
    connected: s.connected as boolean, available: s.available as boolean };
}
export function parseConnection(value: unknown): SurfaceConnection {
  const c = record(value);
  if (typeof c.token !== "string" || !SURFACE_TOKEN.test(c.token)
    || typeof c.incarnation !== "string" || !UUID.test(c.incarnation) || !integer(c.expiresAt, 1)) throw new Error("invalid_connection");
  return { token: c.token, incarnation: c.incarnation, expiresAt: c.expiresAt };
}
