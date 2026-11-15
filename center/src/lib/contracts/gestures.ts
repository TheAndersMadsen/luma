import * as z from "zod/mini";

// INFERRED: browser-safe shapes of the Pin SDK's device-local API. The installed
// SDK owns allowed features/chords and validates every write again on the Pin.
const finger = z.enum(["thumb", "index", "middle", "ring", "pinky"]);
const featureId = z.string().check(z.regex(/^[a-z][a-z0-9_]{0,63}$/));
export const gestureConfigSchema = z.strictObject({
  schema_version: z.literal(1),
  mode: z.enum(["off", "observe", "active"]),
  bindings: z.array(z.strictObject({
    fingers: z.array(z.enum(["middle", "ring", "pinky"])).check(z.minLength(1), z.maxLength(3)),
    hold_ms: z.int().check(z.minimum(250), z.maximum(1500)),
    feature: featureId,
  })).check(z.maxLength(4)),
});

export const gestureSettingsSchema = z.strictObject({
  schema_version: z.literal(1),
  revision: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  valid: z.boolean(),
  config: gestureConfigSchema,
  catalog: z.array(z.strictObject({
    id: featureId, title: z.string().check(z.minLength(1), z.maxLength(100)), available: z.boolean(), note: z.string().check(z.maxLength(500)),
    trigger: z.enum(["fingers", "pinch_session"]),
  })).check(z.maxLength(32)),
});

export const gestureObservationSchema = z.strictObject({
  schema_version: z.literal(1), elapsed_ms: z.int().check(z.nonnegative()),
  status: z.enum(["off", "calibrating", "ready", "holding", "release", "cancelled", "suspended", "unavailable"]),
  reason: z.nullable(z.enum(["home_required", "hand_lost", "projection_unavailable", "stale_frame", "queue_overflow", "service_lost", "callback_failed", "subscription_failed", "subscription_unavailable", "invalid_config"])),
  eligible: z.boolean(), projectable: z.boolean(), fingers: z.array(finger).check(z.maxLength(5)),
  feature: z.nullable(featureId), hold_progress: z.number().check(z.minimum(0), z.maximum(1)),
  hand: z.nullable(z.enum(["left", "right"])),
  points: z.array(z.tuple([z.number().check(z.minimum(-10000), z.maximum(10000)), z.number().check(z.minimum(-10000), z.maximum(10000)), z.number().check(z.minimum(-10000), z.maximum(10000))])).check(z.maxLength(25)),
  revision: z.string().check(z.regex(/^(?:[a-f0-9]{64})?$/)),
  match: z.nullable(z.strictObject({ id: z.string().check(z.regex(/^[0-9a-f-]{36}:[0-9]{1,12}$/)), feature: featureId, outcome: z.enum(["observed", "launched", "failed"]) })),
}).check(z.refine((value) => (value.points.length === 0 && value.hand === null) || (value.points.length === 25 && value.hand !== null)));

export const gestureObservationResponseSchema = z.strictObject({ observation: z.nullable(gestureObservationSchema) });
export type GestureConfig = z.infer<typeof gestureConfigSchema>;
export type GestureSettings = z.infer<typeof gestureSettingsSchema>;
export type GestureObservation = z.infer<typeof gestureObservationSchema>;
