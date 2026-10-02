import * as z from "zod/mini";
/** Cosmos flag_overrides::FeatureDto (Luma-owned/INFERRED web contract). */
const fields = {
  name: z.string(),
  editable: z.boolean(),
  overridden: z.boolean(),
  label: z.string(),
  description: z.string(),
  category: z.string(),
  evidence: z.string(),
  delivery: z.string(),
  warning: z.optional(z.string()),
};
export const featureSchema = z.discriminatedUnion("type", [
  z.object({
    ...fields,
    type: z.literal("bool"),
    default: z.boolean(),
    effective: z.boolean(),
  }),
  z.object({
    ...fields,
    type: z.literal("int"),
    default: z.int(),
    effective: z.int(),
  }),
  z.object({
    ...fields,
    type: z.literal("float"),
    default: z.number(),
    effective: z.number(),
  }),
  z.object({
    ...fields,
    type: z.literal("text"),
    default: z.string(),
    effective: z.string(),
  }),
]);
export type Feature = z.infer<typeof featureSchema>;
