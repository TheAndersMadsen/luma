import { exact, integer, record, UUID } from "./surfaces";

/** The current profile. It is per platform, because what a device may be asked to do differs by what its operating system can honestly report. */
export const NATIVE_APPROVAL = "native-device-action-v4";
/** Persisted speech approvals keep rendering cards and speaking, and declare no action channel until the owner reapproves. */
export const LEGACY_NATIVE_SPEECH_APPROVAL = "native-shared-speech-v3";
/** Persisted display-only approvals keep rendering cards but play no speech until reapproved. */
export const LEGACY_NATIVE_APPROVAL = "native-shared-display-v2";
export const NATIVE_DESCRIPTOR_BYTES = 1024;
export const NATIVE_PLATFORMS = { macos: "macOS", linux: "Linux", android: "Android", android_tv: "Android TV" } as const;
export type NativePlatform = keyof typeof NATIVE_PLATFORMS;

/** The channels that change something about the world rather than showing or saying it. */
export const ACTION_CHANNELS = ["action.open", "action.route", "action.play", "action.run"] as const;
export type ActionChannel = typeof ACTION_CHANNELS[number];
export const CONFIRM_CHANNEL = "confirm.tap";

const BASE_CONSTRAINTS = ["actor_unknown", "occupancy_unknown", "render_unverified", "playback_unverified", "visible_foreground_only", "no_background_output"] as const;
const NATIVE_CONSTRAINTS = [...BASE_CONSTRAINTS, "effect_unverified"] as const;

export interface NativeManifest {
  class: "native";
  capabilities: { input: string[]; output: Record<string, Record<string, unknown>> };
  constraints: string[];
  expression: Record<string, string[]>;
  cognition: { declaredClass: 0; models: never[] };
  authority: { mayOriginate: string[]; reflexive: never[] };
}

const CARD = { maxClass: "shared_room", shared: true } as const;
const ACKNOWLEDGED = ["acknowledged", "degraded"];
const OPEN = { maxClass: "shared_room", shared: true, risk: "low", idempotent: true, reportBudgetMs: 10000 };

/**
 * The exact manifest Cosmos publishes for one platform. Every value here is
 * byte-compared against the record the runtime returns, so the set of
 * manifests an owner can approve stays closed and enumerated — this is the
 * projection of `surface_registry::native_manifest`.
 */
export function nativeManifest(platform: NativePlatform): NativeManifest {
  const output: Record<string, Record<string, unknown>> = { "visual.card": { ...CARD }, "audio.tts": { ...CARD } };
  const expression: Record<string, string[]> = { "visual.card": [...ACKNOWLEDGED], "audio.tts": [...ACKNOWLEDGED] };
  let input = ["text.public", "state.visibility", "action.report"];
  const constraints: string[] = [...NATIVE_CONSTRAINTS];
  if (platform === "macos" || platform === "linux") {
    input = ["text.public", "state.visibility", "context.screen", "action.report"];
    constraints.push("no_effect_isolation");
    output["action.open"] = { ...OPEN };
    expression["action.open"] = [...ACKNOWLEDGED];
    let attestation = ["foreground_tap"];
    if (platform === "macos") {
      output["action.run"] = { maxClass: "shared_room", shared: true, risk: "high", idempotent: false, reportBudgetMs: 900000 };
      expression["action.run"] = ["thinking", "acknowledged", "degraded"];
      attestation = ["foreground_tap", "device_owner_auth"];
    }
    output[CONFIRM_CHANNEL] = { ...CARD, attestation };
    expression[CONFIRM_CHANNEL] = ["confirming", "awaiting_permission"];
  } else if (platform === "android") {
    input = ["text.public", "state.visibility", "context.screen", "action.report"];
    constraints.push("foreground_or_assistant_session_only");
    output["action.open"] = { ...OPEN };
    output["action.route"] = { maxClass: "shared_room", shared: true, risk: "low", idempotent: true, reportBudgetMs: 20000 };
    output[CONFIRM_CHANNEL] = { ...CARD, attestation: ["foreground_tap"] };
    expression["action.open"] = [...ACKNOWLEDGED];
    expression["action.route"] = [...ACKNOWLEDGED];
    expression[CONFIRM_CHANNEL] = ["confirming", "awaiting_permission"];
  } else {
    // A television is bystander-perceivable by construction, so it is never a
    // ceremony venue and never holds a personal declaration.
    output["action.play"] = { maxClass: "shared_room", shared: true, risk: "low", idempotent: true, reportBudgetMs: 30000 };
    expression["action.play"] = [...ACKNOWLEDGED];
  }
  return {
    class: "native",
    capabilities: { input, output },
    constraints,
    expression,
    cognition: { declaredClass: 0, models: [] },
    authority: { mayOriginate: ["state.change", "user.request", "action.report"], reflexive: [] },
  };
}

const legacyDisplayManifest = (): NativeManifest => ({
  class: "native",
  capabilities: { input: ["text.public", "state.visibility"], output: { "visual.card": { ...CARD } } },
  constraints: [...BASE_CONSTRAINTS],
  expression: { "visual.card": [...ACKNOWLEDGED] },
  cognition: { declaredClass: 0, models: [] },
  authority: { mayOriginate: ["state.change", "user.request"], reflexive: [] },
});
const legacySpeechManifest = (): NativeManifest => {
  const manifest = legacyDisplayManifest();
  manifest.capabilities.output["audio.tts"] = { ...CARD };
  manifest.expression["audio.tts"] = [...ACKNOWLEDGED];
  return manifest;
};

/** Everything about an approved installation that does not depend on its platform. */
export const NATIVE_SURFACE_POSTURE = {
  name: "Native device",
  trustLevel: 0,
  occupancy: "unknown",
  actorIdentity: "unknown",
  renderVerified: false,
  playbackVerified: false,
} as const;

export type NativeApproval = typeof NATIVE_APPROVAL | typeof LEGACY_NATIVE_SPEECH_APPROVAL | typeof LEGACY_NATIVE_APPROVAL;
export type NativeSurfacePosture = typeof NATIVE_SURFACE_POSTURE & { approval: NativeApproval; manifest: NativeManifest };

/** The whole posture Cosmos projects for one platform at the current profile; the shape a test or a review renders against. */
export const nativePosture = (platform: NativePlatform): NativeSurfacePosture =>
  ({ ...NATIVE_SURFACE_POSTURE, approval: NATIVE_APPROVAL, manifest: nativeManifest(platform) });
export const legacySpeechPosture = (): NativeSurfacePosture =>
  ({ ...NATIVE_SURFACE_POSTURE, approval: LEGACY_NATIVE_SPEECH_APPROVAL, manifest: legacySpeechManifest() });
export const legacyDisplayPosture = (): NativeSurfacePosture =>
  ({ ...NATIVE_SURFACE_POSTURE, approval: LEGACY_NATIVE_APPROVAL, manifest: legacyDisplayManifest() });

export interface NativeDescriptor {
  enrollmentId: string;
  publicKey: string;
  platform: NativePlatform;
  approval: typeof NATIVE_APPROVAL;
}
export interface NativeApprovalInput extends NativeDescriptor { expectedRevision: number }
export interface NativeSurface extends Readonly<typeof NATIVE_SURFACE_POSTURE> {
  approval: NativeApproval;
  manifest: NativeManifest;
  /** Every known approval renders one shared card. */
  display: boolean;
  /** False for a display-only approval that must be reapproved before it can play spoken replies. */
  speech: boolean;
  /**
   * The action channels this installation's approved manifest declares. An
   * operation absent from it is not a permission the owner can write, however
   * the Devices page is asked; an older approval declares none at all.
   */
  actions: ActionChannel[];
  /** Whether this installation can host a confirmation ceremony. A TV never can. */
  confirms: boolean;
  surfaceId: string;
  enrollmentId: string;
  platform: NativePlatform;
  revision: number;
  publicKeyFingerprint: string;
  revoked: boolean;
  /** Liveness at the time of the read, from the runtime's own connection state; never a claim by the installation. */
  connected: boolean;
  visible: boolean;
  /** The runtime currently holds a private display permission for this surface. */
  privateDisplay: boolean;
}
const nonnilUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value)
  && value !== "00000000-0000-0000-0000-000000000000";
const platform = (value: unknown): value is NativePlatform => typeof value === "string" && Object.hasOwn(NATIVE_PLATFORMS, value);
/** Presence flags are optional on the wire; a missing flag is false, anything but a boolean is rejected. */
function presence(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error("invalid_native_surface");
  return value;
}
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
  if (!platform(native.platform)) throw new Error("invalid_native_surface");
  // Binding to the record's OWN platform is what keeps the set closed: an
  // Android manifest on a Mac record is unknown, not "some known manifest".
  const posture = [nativePosture(native.platform), legacySpeechPosture(), legacyDisplayPosture()]
    .find(candidate => Object.entries(candidate).every(([key, expected]) => exact(native[key], expected)));
  if (!posture) throw new Error("unsupported_native_posture");
  if (!nonnilUuid(native.surfaceId) || !nonnilUuid(native.enrollmentId)
    || !integer(native.revision, 1) || typeof native.revoked !== "boolean"
    || typeof native.publicKeyFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(native.publicKeyFingerprint)) throw new Error("invalid_native_surface");
  const output = posture.manifest.capabilities.output;
  // Owner metadata only. Never pass through private keys, session tokens or account fields.
  return { ...posture, display: true, speech: "audio.tts" in output,
    actions: ACTION_CHANNELS.filter(channel => channel in output), confirms: CONFIRM_CHANNEL in output,
    surfaceId: native.surfaceId.toLowerCase(), enrollmentId: native.enrollmentId.toLowerCase(),
    platform: native.platform, revision: native.revision, publicKeyFingerprint: native.publicKeyFingerprint, revoked: native.revoked,
    connected: presence(native.connected), visible: presence(native.visible), privateDisplay: presence(native.privateDisplay) };
}
export function parseNativeSurfaces(value: unknown): NativeSurface[] {
  const { native } = record(value);
  if (!Array.isArray(native) || native.length > 16) throw new Error("invalid_native_list");
  const rows = native.map(parseNativeSurface);
  if (rows.some(row => row.revoked) || new Set(rows.map(row => row.surfaceId)).size !== rows.length
    || new Set(rows.map(row => row.enrollmentId)).size !== rows.length) throw new Error("invalid_native_list");
  return rows;
}
