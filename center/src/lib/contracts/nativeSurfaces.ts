import { exact, integer, record, UUID } from "./surfaces";

export const NATIVE_APPROVAL = "native-shared-speech-v3";
/** Persisted display-only approvals keep rendering cards but play no speech until reapproved. */
export const LEGACY_NATIVE_APPROVAL = "native-shared-display-v2";
export const NATIVE_DESCRIPTOR_BYTES = 1024;
export const NATIVE_PLATFORMS = { macos: "macOS", linux: "Linux", android: "Android", android_tv: "Android TV" } as const;
export type NativePlatform = keyof typeof NATIVE_PLATFORMS;
const NATIVE_CONSTRAINTS = ["actor_unknown", "occupancy_unknown", "render_unverified", "playback_unverified", "visible_foreground_only", "no_background_output"] as const;
export const NATIVE_SURFACE_POSTURE = {
  name: "Native device",
  approval: NATIVE_APPROVAL,
  manifest: {
    class: "native",
    capabilities: { input: ["text.public", "state.visibility"], output: { "visual.card": { maxClass: "shared_room", shared: true }, "audio.tts": { maxClass: "shared_room", shared: true } } },
    constraints: NATIVE_CONSTRAINTS,
    expression: { "visual.card": ["acknowledged", "degraded"], "audio.tts": ["acknowledged", "degraded"] },
    cognition: { declaredClass: 0, models: [] },
    authority: { mayOriginate: ["state.change", "user.request"], reflexive: [] },
  },
  trustLevel: 0,
  occupancy: "unknown",
  actorIdentity: "unknown",
  renderVerified: false,
  playbackVerified: false,
} as const;
export const LEGACY_NATIVE_SURFACE_POSTURE = {
  ...NATIVE_SURFACE_POSTURE,
  approval: LEGACY_NATIVE_APPROVAL,
  manifest: {
    class: "native",
    capabilities: { input: ["text.public", "state.visibility"], output: { "visual.card": { maxClass: "shared_room", shared: true } } },
    constraints: NATIVE_CONSTRAINTS,
    expression: { "visual.card": ["acknowledged", "degraded"] },
    cognition: { declaredClass: 0, models: [] },
    authority: { mayOriginate: ["state.change", "user.request"], reflexive: [] },
  },
} as const;

export interface NativeDescriptor {
  enrollmentId: string;
  publicKey: string;
  platform: NativePlatform;
  approval: typeof NATIVE_APPROVAL;
}
export interface NativeApprovalInput extends NativeDescriptor { expectedRevision: number }
export interface NativeSurface extends Readonly<Omit<typeof NATIVE_SURFACE_POSTURE, "approval" | "manifest">> {
  approval: typeof NATIVE_APPROVAL | typeof LEGACY_NATIVE_APPROVAL;
  manifest: typeof NATIVE_SURFACE_POSTURE.manifest | typeof LEGACY_NATIVE_SURFACE_POSTURE.manifest;
  /** Both known approvals render one shared card. */
  display: boolean;
  /** False for a display-only approval that must be reapproved before it can play spoken replies. */
  speech: boolean;
  surfaceId: string;
  enrollmentId: string;
  platform: NativePlatform;
  revision: number;
  publicKeyFingerprint: string;
  revoked: boolean;
}
const nonnilUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value)
  && value !== "00000000-0000-0000-0000-000000000000";
const platform = (value: unknown): value is NativePlatform => typeof value === "string" && Object.hasOwn(NATIVE_PLATFORMS, value);
function fields(input: Record<string, unknown>, names: string[]) {
  if (Object.keys(input).length !== names.length || names.some(name => !Object.hasOwn(input, name))) throw new Error("invalid_native_fields");
}
function publicKeyBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(value)) throw new Error("invalid_native_key");
  const raw = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  if (raw.length !== 65 || raw.charCodeAt(0) !== 4
    || btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") !== value) throw new Error("invalid_native_key");
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}
function descriptor(input: Record<string, unknown>): NativeDescriptor {
  if (!nonnilUuid(input.enrollmentId) || !platform(input.platform) || input.approval !== NATIVE_APPROVAL) throw new Error("invalid_native_descriptor");
  publicKeyBytes(input.publicKey);
  return { enrollmentId: input.enrollmentId.toLowerCase(), publicKey: input.publicKey as string, platform: input.platform, approval: NATIVE_APPROVAL };
}
export function parseNativeDescriptor(value: unknown): NativeDescriptor {
  const input = record(value);
  fields(input, ["enrollmentId", "publicKey", "platform", "approval"]);
  return descriptor(input);
}
export function parseNativeDescriptorText(text: string): NativeDescriptor {
  if (new TextEncoder().encode(text).byteLength > NATIVE_DESCRIPTOR_BYTES) throw new Error("native_descriptor_too_large");
  return parseNativeDescriptor(JSON.parse(text));
}
export function parseNativeApprovalInput(value: unknown): NativeApprovalInput {
  const input = record(value);
  fields(input, ["enrollmentId", "publicKey", "platform", "approval", "expectedRevision"]);
  if (!integer(input.expectedRevision) || input.expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error("invalid_native_revision");
  return { ...descriptor(input), expectedRevision: input.expectedRevision };
}
export function parseNativeRevokeInput(value: unknown): { expectedRevision: number } {
  const input = record(value);
  fields(input, ["expectedRevision"]);
  if (!integer(input.expectedRevision, 1) || input.expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error("invalid_native_revision");
  return { expectedRevision: input.expectedRevision };
}
export async function nativePublicKeyFingerprint(publicKey: string): Promise<string> {
  const bytes = publicKeyBytes(publicKey);
  // SEC1 shape alone does not prove that the point lies on P-256.
  await crypto.subtle.importKey("raw", bytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}
export function parseNativeSurface(value: unknown): NativeSurface {
  const native = record(value);
  const posture = [NATIVE_SURFACE_POSTURE, LEGACY_NATIVE_SURFACE_POSTURE]
    .find(candidate => Object.entries(candidate).every(([key, expected]) => exact(native[key], expected)));
  if (!posture) throw new Error("unsupported_native_posture");
  if (!nonnilUuid(native.surfaceId) || !nonnilUuid(native.enrollmentId) || !platform(native.platform)
    || !integer(native.revision, 1) || typeof native.revoked !== "boolean"
    || typeof native.publicKeyFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(native.publicKeyFingerprint)) throw new Error("invalid_native_surface");
  // Owner metadata only. Never pass through private keys, session tokens or account fields.
  return { ...posture, display: true, speech: posture === NATIVE_SURFACE_POSTURE, surfaceId: native.surfaceId.toLowerCase(), enrollmentId: native.enrollmentId.toLowerCase(),
    platform: native.platform, revision: native.revision, publicKeyFingerprint: native.publicKeyFingerprint, revoked: native.revoked };
}
export function parseNativeSurfaces(value: unknown): NativeSurface[] {
  const { native } = record(value);
  if (!Array.isArray(native) || native.length > 16) throw new Error("invalid_native_list");
  const rows = native.map(parseNativeSurface);
  if (rows.some(row => row.revoked) || new Set(rows.map(row => row.surfaceId)).size !== rows.length
    || new Set(rows.map(row => row.enrollmentId)).size !== rows.length) throw new Error("invalid_native_list");
  return rows;
}
