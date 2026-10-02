import * as z from "zod/mini";

export const countSchema = z.int().check(z.nonnegative());
/** A JavaScript date must be representable before any epoch-to-ISO mapping. */
export const epochSecondsSchema = z
  .number()
  .check(z.minimum(-8_640_000_000_000), z.maximum(8_640_000_000_000));

/** Cosmos web_api::Page. Preserve additive Spring pageable/sort metadata. */
export function springPageSchema<T extends z.ZodMiniType>(row: T) {
  return z.looseObject({
    content: z.array(row),
    number: countSchema,
    size: countSchema,
    totalElements: countSchema,
    totalPages: countSchema,
    last: z.boolean(),
    first: z.boolean(),
    numberOfElements: countSchema,
    empty: z.boolean(),
  });
}
export type SpringPage<T> = z.infer<
  ReturnType<typeof springPageSchema<z.ZodMiniType<T>>>
>;
export const deletedSchema = z.object({ deleted: z.boolean() });
