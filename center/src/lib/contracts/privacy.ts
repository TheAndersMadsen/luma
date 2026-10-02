import * as z from "zod/mini";

// Authoritative Cosmos public_privacy::PrivacyDetails, SavedLocationView and
// DiagnosticSnapshot. This owner-only Luma view is INFERRED, not a stock RPC.
const timestamp = z.int().check(z.gte(0), z.lte(8_640_000_000_000_000));
const diagnosticLabel = z.string().check(z.regex(/^[a-z0-9_.-]{1,64}$/u));
export const privacyDetailsSchema = z.strictObject({
  lastLocationEnabled: z.boolean(),
  diagnosticsEnabled: z.boolean(),
  lastLocation: z.nullable(z.strictObject({
    latitude: z.number().check(z.gte(-90), z.lte(90)),
    longitude: z.number().check(z.gte(-180), z.lte(180)),
    humanReadable: z.string().check(z.maxLength(4096)),
    fullAddress: z.string().check(z.maxLength(4096)),
    staleStatus: z.enum(["fresh", "stale", "unknown"]),
    timestamp: z.nullable(timestamp),
  })),
  diagnostics: z.nullable(z.strictObject({
    route: diagnosticLabel,
    transport: diagnosticLabel,
    outcome: diagnosticLabel,
    elapsedMs: z.int().check(z.gte(0), z.lte(90_000)),
    recordedAt: timestamp,
  })),
});
export type PrivacyDetails = z.infer<typeof privacyDetailsSchema>;
