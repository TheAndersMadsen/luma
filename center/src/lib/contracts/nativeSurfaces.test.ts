// @vitest-environment node
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  NATIVE_APPROVAL,
  NATIVE_DESCRIPTOR_BYTES,
  nativeManifest,
  nativePosture,
  nativePublicKeyFingerprint,
  parseNativeApprovalInput,
  parseNativeDescriptor,
  parseNativeDescriptorText,
  parseNativeRevokeInput,
  parseNativeSurface,
  parseNativeSurfaces,
} from "./nativeSurfaces";

// SEC 2's P-256 generator, encoded as the uncompressed SEC1 public point.
// No private key or implementation-generated fingerprint is used as an oracle.
const GENERATOR_BYTES = Buffer.from(
  "04"
  + "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"
  + "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
  "hex",
);
const PUBLIC_KEY = GENERATOR_BYTES.toString("base64url");
const FINGERPRINT = createHash("sha256").update(GENERATOR_BYTES).digest("hex");
const ENROLLMENT_ID = "a11ce000-1111-4111-8111-111111111111";
const SURFACE_ID = "face0000-2222-4222-8222-222222222222";
const DESCRIPTOR = {
  enrollmentId: ENROLLMENT_ID,
  publicKey: PUBLIC_KEY,
  platform: "macos",
  approval: "native-device-action-v4",
};
const CARD = { maxClass: "shared_room", shared: true };
const ACKNOWLEDGED = ["acknowledged", "degraded"];
const BASE_CONSTRAINTS = ["actor_unknown", "occupancy_unknown", "render_unverified", "playback_unverified", "visible_foreground_only", "no_background_output"];
const ACTION_CONSTRAINTS = [...BASE_CONSTRAINTS, "effect_unverified"];
const OPEN = { maxClass: "shared_room", shared: true, risk: "low", idempotent: true, reportBudgetMs: 10000 };

/*
 * The four manifests Cosmos publishes, written out rather than derived, so a
 * drift in `surface_registry::native_manifest` fails here instead of quietly
 * making every approved installation unreadable. What a device may be asked to
 * do differs by what its operating system can honestly report.
 */
const MANIFESTS: Record<string, unknown> = {
  macos: {
    class: "native",
    capabilities: {
      input: ["text.public", "state.visibility", "context.screen", "action.report"],
      output: {
        "visual.card": CARD, "audio.tts": CARD, "action.open": OPEN,
        "action.run": { maxClass: "shared_room", shared: true, risk: "high", idempotent: false, reportBudgetMs: 900000 },
        "confirm.tap": { ...CARD, attestation: ["foreground_tap", "device_owner_auth"] },
      },
    },
    constraints: [...ACTION_CONSTRAINTS, "no_effect_isolation"],
    expression: {
      "visual.card": ACKNOWLEDGED, "audio.tts": ACKNOWLEDGED, "action.open": ACKNOWLEDGED,
      "action.run": ["thinking", "acknowledged", "degraded"], "confirm.tap": ["confirming", "awaiting_permission"],
    },
    cognition: { declaredClass: 0, models: [] },
    authority: { mayOriginate: ["state.change", "user.request", "action.report"], reflexive: [] },
  },
  linux: {
    class: "native",
    capabilities: {
      input: ["text.public", "state.visibility", "context.screen", "action.report"],
      output: { "visual.card": CARD, "audio.tts": CARD, "action.open": OPEN, "confirm.tap": { ...CARD, attestation: ["foreground_tap"] } },
    },
    constraints: [...ACTION_CONSTRAINTS, "no_effect_isolation"],
    expression: {
      "visual.card": ACKNOWLEDGED, "audio.tts": ACKNOWLEDGED, "action.open": ACKNOWLEDGED,
      "confirm.tap": ["confirming", "awaiting_permission"],
    },
    cognition: { declaredClass: 0, models: [] },
    authority: { mayOriginate: ["state.change", "user.request", "action.report"], reflexive: [] },
  },
  android: {
    class: "native",
    capabilities: {
      input: ["text.public", "state.visibility", "context.screen", "action.report"],
      output: {
        "visual.card": CARD, "audio.tts": CARD, "action.open": OPEN,
        "action.route": { maxClass: "shared_room", shared: true, risk: "low", idempotent: true, reportBudgetMs: 20000 },
        "confirm.tap": { ...CARD, attestation: ["foreground_tap"] },
      },
    },
    constraints: [...ACTION_CONSTRAINTS, "foreground_or_assistant_session_only"],
    expression: {
      "visual.card": ACKNOWLEDGED, "audio.tts": ACKNOWLEDGED, "action.open": ACKNOWLEDGED,
      "action.route": ACKNOWLEDGED, "confirm.tap": ["confirming", "awaiting_permission"],
    },
    cognition: { declaredClass: 0, models: [] },
    authority: { mayOriginate: ["state.change", "user.request", "action.report"], reflexive: [] },
  },
  // A television is bystander-perceivable by construction: no ceremony venue,
  // no screen context and no command.
  android_tv: {
    class: "native",
    capabilities: {
      input: ["text.public", "state.visibility", "action.report"],
      output: {
        "visual.card": CARD, "audio.tts": CARD,
        "action.play": { maxClass: "shared_room", shared: true, risk: "low", idempotent: true, reportBudgetMs: 30000 },
      },
    },
    constraints: ACTION_CONSTRAINTS,
    expression: { "visual.card": ACKNOWLEDGED, "audio.tts": ACKNOWLEDGED, "action.play": ACKNOWLEDGED },
    cognition: { declaredClass: 0, models: [] },
    authority: { mayOriginate: ["state.change", "user.request", "action.report"], reflexive: [] },
  },
};
const POSTURE_FIELDS = {
  name: "Native device",
  trustLevel: 0,
  occupancy: "unknown",
  actorIdentity: "unknown",
  renderVerified: false,
  playbackVerified: false,
};
const APPROVED_POSTURE = { ...POSTURE_FIELDS, approval: "native-device-action-v4", manifest: MANIFESTS.macos };
const LEGACY_SPEECH_POSTURE = {
  ...POSTURE_FIELDS,
  approval: "native-shared-speech-v3",
  manifest: {
    class: "native",
    capabilities: { input: ["text.public", "state.visibility"], output: { "visual.card": CARD, "audio.tts": CARD } },
    constraints: BASE_CONSTRAINTS,
    expression: { "visual.card": ACKNOWLEDGED, "audio.tts": ACKNOWLEDGED },
    cognition: { declaredClass: 0, models: [] },
    authority: { mayOriginate: ["state.change", "user.request"], reflexive: [] },
  },
};
const LEGACY_POSTURE = {
  ...POSTURE_FIELDS,
  approval: "native-shared-display-v2",
  manifest: {
    class: "native",
    capabilities: { input: ["text.public", "state.visibility"], output: { "visual.card": CARD } },
    constraints: BASE_CONSTRAINTS,
    expression: { "visual.card": ACKNOWLEDGED },
    cognition: { declaredClass: 0, models: [] },
    authority: { mayOriginate: ["state.change", "user.request"], reflexive: [] },
  },
};
const SURFACE = {
  ...APPROVED_POSTURE,
  display: true,
  speech: true,
  actions: ["action.open", "action.run"],
  confirms: true,
  surfaceId: SURFACE_ID,
  enrollmentId: ENROLLMENT_ID,
  platform: "macos",
  revision: 1,
  publicKeyFingerprint: FINGERPRINT,
  revoked: false,
  connected: false,
  visible: false,
  privateDisplay: false,
};

it("accepts the four explicit native platforms and normalizes enrollment UUID case", () => {
  expect(NATIVE_APPROVAL).toBe("native-device-action-v4");
  for (const platform of ["macos", "linux", "android", "android_tv"]) {
    expect(parseNativeDescriptor({ ...DESCRIPTOR, enrollmentId: ENROLLMENT_ID.toUpperCase(), platform }))
      .toEqual({ ...DESCRIPTOR, platform });
  }
});

it("requires exactly the descriptor fields and rejects unsupported identity or approval claims", () => {
  for (const key of Object.keys(DESCRIPTOR)) {
    const missing: Record<string, unknown> = { ...DESCRIPTOR };
    delete missing[key];
    expect(() => parseNativeDescriptor(missing)).toThrow("invalid_native_fields");
  }
  for (const invalid of [null, [], "descriptor", 1, {},
    { ...DESCRIPTOR, expectedRevision: 0 }, { ...DESCRIPTOR, ownerId: "other" },
    { ...DESCRIPTOR, sessionToken: "hidden" }, { ...DESCRIPTOR, approval: "browser-shared-display-v2" },
    { ...DESCRIPTOR, enrollmentId: "00000000-0000-0000-0000-000000000000" },
    { ...DESCRIPTOR, enrollmentId: ` ${ENROLLMENT_ID}` }, { ...DESCRIPTOR, enrollmentId: "not-a-uuid" },
    ...["pin", "ios", "MacOS", "constructor", "__proto__", null].map(platform => ({ ...DESCRIPTOR, platform }))]) {
    expect(() => parseNativeDescriptor(invalid)).toThrow();
  }
});

it("bounds descriptor text by UTF-8 bytes and rejects malformed or non-object JSON", () => {
  expect(NATIVE_DESCRIPTOR_BYTES).toBe(1024);
  const json = JSON.stringify(DESCRIPTOR);
  const atLimit = " ".repeat(1024 - Buffer.byteLength(json, "utf8")) + json;
  expect(parseNativeDescriptorText(atLimit)).toEqual(DESCRIPTOR);
  expect(() => parseNativeDescriptorText(atLimit + " ")).toThrow("native_descriptor_too_large");
  const multibyte = JSON.stringify("é".repeat(512));
  expect(multibyte.length).toBeLessThan(1024);
  expect(() => parseNativeDescriptorText(multibyte)).toThrow("native_descriptor_too_large");
  for (const invalid of ["", "{", "null", "[]", '"descriptor"', json + json]) {
    expect(() => parseNativeDescriptorText(invalid)).toThrow();
  }
});

it("requires canonical unpadded base64url and exactly 65-byte uncompressed SEC1 keys", () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const lastIndex = alphabet.indexOf(PUBLIC_KEY.charAt(PUBLIC_KEY.length - 1));
  const noncanonical = PUBLIC_KEY.slice(0, -1) + alphabet.charAt(lastIndex + 1);
  // Changing unused trailing bits preserves decoded bytes, so length/decoding alone is insufficient.
  expect(Buffer.from(noncanonical, "base64url")).toEqual(GENERATOR_BYTES);
  const wrongPrefix = Buffer.from(GENERATOR_BYTES);
  wrongPrefix[0] = 2;
  const invalidKeys = [undefined, null, 4, "", PUBLIC_KEY + "=", PUBLIC_KEY + "==", noncanonical,
    " " + PUBLIC_KEY, PUBLIC_KEY + "\n", "+" + PUBLIC_KEY.slice(1), "/" + PUBLIC_KEY.slice(1),
    GENERATOR_BYTES.subarray(0, 64).toString("base64url"),
    Buffer.concat([GENERATOR_BYTES, Buffer.from([0])]).toString("base64url"),
    wrongPrefix.toString("base64url"),
    Buffer.concat([Buffer.from([2]), GENERATOR_BYTES.subarray(1, 33)]).toString("base64url")];
  for (const publicKey of invalidKeys) {
    expect(() => parseNativeDescriptor({ ...DESCRIPTOR, publicKey })).toThrow("invalid_native_key");
    expect(() => parseNativeApprovalInput({ ...DESCRIPTOR, publicKey, expectedRevision: 0 })).toThrow("invalid_native_key");
  }
});

it("cryptographically validates the P-256 point and fingerprints its raw SEC1 bytes", async () => {
  expect(GENERATOR_BYTES.byteLength).toBe(65);
  expect(PUBLIC_KEY).toHaveLength(87);
  expect(await nativePublicKeyFingerprint(PUBLIC_KEY)).toBe(FINGERPRINT);
  expect(FINGERPRINT).not.toBe(createHash("sha256").update(PUBLIC_KEY, "utf8").digest("hex"));
  for (const coordinateByte of [0, 255]) {
    const offCurve = Buffer.alloc(65, coordinateByte);
    offCurve[0] = 4;
    const publicKey = offCurve.toString("base64url");
    // Shape parsing is deliberately separate from the asynchronous point check.
    expect(parseNativeDescriptor({ ...DESCRIPTOR, publicKey }).publicKey).toBe(publicKey);
    await expect(nativePublicKeyFingerprint(publicKey)).rejects.toThrow();
  }
  await expect(nativePublicKeyFingerprint(PUBLIC_KEY + "=")).rejects.toThrow("invalid_native_key");
});

it("requires exact revision-bound mutation inputs and preserves room for the next revision", () => {
  for (const expectedRevision of [0, 1, Number.MAX_SAFE_INTEGER - 1]) {
    expect(parseNativeApprovalInput({ ...DESCRIPTOR, expectedRevision })).toEqual({ ...DESCRIPTOR, expectedRevision });
  }
  for (const expectedRevision of [1, Number.MAX_SAFE_INTEGER - 1]) {
    expect(parseNativeRevokeInput({ expectedRevision })).toEqual({ expectedRevision });
  }
  const invalidRevisions = [undefined, null, "1", -1, 1.5, NaN, Infinity,
    Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1];
  for (const expectedRevision of invalidRevisions) {
    expect(() => parseNativeApprovalInput({ ...DESCRIPTOR, expectedRevision })).toThrow("invalid_native_revision");
    expect(() => parseNativeRevokeInput({ expectedRevision })).toThrow("invalid_native_revision");
  }
  expect(() => parseNativeRevokeInput({ expectedRevision: 0 })).toThrow("invalid_native_revision");
  for (const invalid of [DESCRIPTOR, { ...DESCRIPTOR, expectedRevision: 0, grant: "hidden" },
    { ...DESCRIPTOR, expectedRevision: 0, publicKeyFingerprint: FINGERPRINT }]) {
    expect(() => parseNativeApprovalInput(invalid)).toThrow("invalid_native_fields");
  }
  for (const invalid of [null, [], {}, { expectedRevision: 1, enrollmentId: ENROLLMENT_ID },
    { expectedRevision: 1, revokeAll: true }]) {
    expect(() => parseNativeRevokeInput(invalid)).toThrow();
  }
});

it("matches Cosmos per platform: exactly the channels that platform declares, and no other manifest is a known posture", () => {
  for (const [platform, manifest] of Object.entries(MANIFESTS)) {
    expect(nativeManifest(platform as "macos")).toEqual(manifest);
    expect(nativePosture(platform as "macos")).toEqual({ ...POSTURE_FIELDS, approval: NATIVE_APPROVAL, manifest });
  }
  // Only macOS may be asked to run a task, and only a device that is not a
  // television may host a confirmation ceremony.
  const surface = (platform: string) => parseNativeSurface({ ...SURFACE, platform, manifest: MANIFESTS[platform] });
  expect(surface("macos").actions).toEqual(["action.open", "action.run"]);
  expect(surface("linux").actions).toEqual(["action.open"]);
  expect(surface("android").actions).toEqual(["action.open", "action.route"]);
  expect(surface("android_tv").actions).toEqual(["action.play"]);
  expect(surface("android_tv").confirms).toBe(false);
  for (const platform of ["macos", "linux", "android"]) expect(surface(platform).confirms).toBe(true);
  // A manifest is bound to the record's OWN platform: an Android manifest on a
  // Mac record is unknown, not "some known manifest".
  expect(() => parseNativeSurface({ ...SURFACE, platform: "macos", manifest: MANIFESTS.android })).toThrow("unsupported_native_posture");
  expect(() => parseNativeSurface({ ...SURFACE, platform: "android_tv", manifest: MANIFESTS.macos })).toThrow("unsupported_native_posture");
});

it("keeps the fixed posture at shared text input, one shared visual card and one spoken reply with no inferred actor or autonomy", () => {
  expect(parseNativeSurface(SURFACE)).toEqual(SURFACE);
  // Earlier approvals still render and speak, and declare no action channel
  // until the owner approves the installation again.
  const { display: _display, speech: _speech, actions: _actions, confirms: _confirms, ...withoutOutputs } = SURFACE;
  const speechOnly = { ...withoutOutputs, ...LEGACY_SPEECH_POSTURE };
  expect(parseNativeSurface(speechOnly)).toEqual({ ...speechOnly, display: true, speech: true, actions: [], confirms: false });
  const legacy = { ...withoutOutputs, ...LEGACY_POSTURE };
  expect(parseNativeSurface(legacy)).toEqual({ ...legacy, display: true, speech: false, actions: [], confirms: false });
  expect(() => parseNativeSurface({ ...legacy, manifest: APPROVED_POSTURE.manifest })).toThrow("unsupported_native_posture");
  expect(() => parseNativeSurface({ ...SURFACE, approval: LEGACY_POSTURE.approval })).toThrow("unsupported_native_posture");
  for (const key of Object.keys(APPROVED_POSTURE)) {
    const incomplete: Record<string, unknown> = { ...SURFACE };
    delete incomplete[key];
    expect(() => parseNativeSurface(incomplete)).toThrow("unsupported_native_posture");
  }
  const manifest = APPROVED_POSTURE.manifest as { capabilities: { input: string[]; output: Record<string, unknown> }; constraints: string[]; expression: Record<string, unknown>; authority: { mayOriginate: string[]; reflexive: string[] } };
  for (const changed of [
    { ...manifest, hiddenAuthority: true },
    { ...manifest, capabilities: { ...manifest.capabilities, input: [...manifest.capabilities.input, "audio.capture"] } },
    { ...manifest, capabilities: { ...manifest.capabilities, output: { ...manifest.capabilities.output, "audio.tts": { maxClass: "private" } } } },
    // A raised action ceiling is a posture claim, not a permission: only the
    // owner's own private-display grant lifts what an action may carry.
    { ...manifest, capabilities: { ...manifest.capabilities, output: { ...manifest.capabilities.output, "action.run": { ...OPEN, maxClass: "private" } } } },
    { ...manifest, capabilities: { ...manifest.capabilities, output: { ...manifest.capabilities.output, "action.play": OPEN } } },
    { ...manifest, capabilities: { ...manifest.capabilities, output: { "visual.card": { maxClass: "private", shared: false } } } },
    { ...manifest, constraints: manifest.constraints.slice(1) },
    { ...manifest, constraints: manifest.constraints.filter(name => name !== "no_effect_isolation") },
    { ...manifest, expression: { ...manifest.expression, success: true } },
    { ...manifest, cognition: { declaredClass: 1, models: [] } },
    { ...manifest, cognition: { declaredClass: 0, models: ["local-model"] } },
    { ...manifest, authority: { ...manifest.authority, mayOriginate: ["user.request", "action.completed"] } },
    { ...manifest, authority: { ...manifest.authority, reflexive: ["message.send"] } },
    { ...manifest, authority: { ...manifest.authority, grants: ["hidden"] } },
  ]) {
    expect(() => parseNativeSurface({ ...SURFACE, manifest: changed })).toThrow("unsupported_native_posture");
  }
  for (const changed of [{ trustLevel: 1 }, { occupancy: "alone" }, { actorIdentity: "verified" },
    { renderVerified: true }, { playbackVerified: true }, { approval: "native-private-v1" }]) {
    expect(() => parseNativeSurface({ ...SURFACE, ...changed })).toThrow("unsupported_native_posture");
  }
});

it("reads the runtime's presence flags and treats a missing flag as false, never as a claim", () => {
  const { connected: _connected, visible: _visible, privateDisplay: _privateDisplay, ...bare } = SURFACE;
  expect(parseNativeSurface(bare)).toEqual(SURFACE);
  expect(parseNativeSurface({ ...bare, connected: true, visible: true, privateDisplay: true }))
    .toEqual({ ...SURFACE, connected: true, visible: true, privateDisplay: true });
  expect(parseNativeSurface({ ...bare, connected: true })).toEqual({ ...SURFACE, connected: true });
  for (const key of ["connected", "visible", "privateDisplay"]) {
    for (const value of [null, 1, "true", "false", {}]) {
      expect(() => parseNativeSurface({ ...bare, [key]: value })).toThrow("invalid_native_surface");
    }
  }
  expect(parseNativeSurfaces({ native: [{ ...bare, connected: true, visible: false, privateDisplay: true }] }))
    .toEqual([{ ...SURFACE, connected: true, privateDisplay: true }]);
});

it("validates response identities and safe revisions while allowing a terminal safe revision", () => {
  expect(parseNativeSurface({ ...SURFACE, surfaceId: SURFACE_ID.toUpperCase(), enrollmentId: ENROLLMENT_ID.toUpperCase(),
    revision: Number.MAX_SAFE_INTEGER })).toEqual({ ...SURFACE, revision: Number.MAX_SAFE_INTEGER });
  expect(parseNativeSurface({ ...SURFACE, revoked: true }).revoked).toBe(true);
  for (const key of ["surfaceId", "enrollmentId", "platform", "revision", "publicKeyFingerprint", "revoked"]) {
    const missing: Record<string, unknown> = { ...SURFACE };
    delete missing[key];
    expect(() => parseNativeSurface(missing)).toThrow("invalid_native_surface");
  }
  for (const changed of [{ surfaceId: "00000000-0000-0000-0000-000000000000" },
    { enrollmentId: "00000000-0000-0000-0000-000000000000" }, { surfaceId: "invalid" },
    { platform: "pin" }, { revision: 0 }, { revision: -1 }, { revision: 1.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 }, { revision: Infinity }, { revision: "1" },
    { revoked: 0 }, { revoked: "false" }, { publicKeyFingerprint: FINGERPRINT.toUpperCase() },
    { publicKeyFingerprint: FINGERPRINT.slice(1) }, { publicKeyFingerprint: FINGERPRINT + "0" },
    { publicKeyFingerprint: "g".repeat(64) }]) {
    expect(() => parseNativeSurface({ ...SURFACE, ...changed })).toThrow("invalid_native_surface");
  }
});

it("projects owner-facing metadata without retaining keys, sessions, credentials, or account extras", () => {
  const untrusted = { ...SURFACE, publicKey: PUBLIC_KEY, privateKey: "secret-private-key", secret: "hidden",
    sessionToken: "secret-session-token", session: { token: "nested-secret" }, ownerId: "other-owner",
    accountId: "other-account", credentials: { password: "hidden-password" } };
  expect(parseNativeSurface(untrusted)).toEqual(SURFACE);
  expect(parseNativeSurfaces({ native: [untrusted], ownerId: "outer-owner", sessionToken: "outer-token" })).toEqual([SURFACE]);
});

it("accepts at most sixteen active surfaces and rejects revoked or duplicate normalized identities", () => {
  const rows = Array.from({ length: 16 }, (_, index) => ({ ...SURFACE,
    surfaceId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    enrollmentId: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` }));
  expect(parseNativeSurfaces({ native: [] })).toEqual([]);
  expect(parseNativeSurfaces({ native: rows })).toEqual(rows);
  for (const native of [null, {}, [...rows, { ...SURFACE }], [{ ...SURFACE, revoked: true }],
    [SURFACE, { ...SURFACE, surfaceId: rows[0].surfaceId }],
    [SURFACE, { ...SURFACE, enrollmentId: rows[0].enrollmentId }],
    [SURFACE, { ...SURFACE, surfaceId: SURFACE_ID.toUpperCase(), enrollmentId: rows[0].enrollmentId }],
    [SURFACE, { ...SURFACE, surfaceId: rows[0].surfaceId, enrollmentId: ENROLLMENT_ID.toUpperCase() }]]) {
    expect(() => parseNativeSurfaces({ native })).toThrow("invalid_native_list");
  }
  for (const invalid of [null, [], {}, { surfaces: rows }, { native: [null] }]) {
    expect(() => parseNativeSurfaces(invalid)).toThrow();
  }
});
