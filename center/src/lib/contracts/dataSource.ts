import * as z from "zod/mini";
/** Empty reads, unavailable services, and unconfigured services are distinct. */
export const dataStateSchema = z.enum(["live", "absent", "degraded"]);
export type DataState = z.infer<typeof dataStateSchema>;
/** `fixtures` remains wire vocabulary. Runtime wearer fallbacks are empty. */
export const dataFallbackSchema = z.enum(["fixtures", "empty"]);
export type DataFallback = z.infer<typeof dataFallbackSchema>;
export const partProvenanceSchema = z.object({
  state: dataStateSchema,
  fallback: z.optional(dataFallbackSchema),
  degraded: z.optional(z.string()),
});
export type PartProvenance = z.infer<typeof partProvenanceSchema>;
/**
 * Provenance a pane reads from a response BODY, for routes that answer 200
 * with nulls when the backend did not: without it a failed read and a
 * genuinely empty value look the same.
 */
export const bodyProvenanceShape = {
  state: dataStateSchema,
  degraded: z.optional(z.string()),
  /** The read failed because the wearer's Keycloak grant expired. */
  reauthenticate: z.optional(z.literal(true)),
};
