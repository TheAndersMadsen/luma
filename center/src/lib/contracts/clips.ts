import * as z from "zod/mini";

// INFERRED: an explicit browser handoff, not OCR or a stock cloud message.
const text = (limit: number) => z.string().check(z.refine((value) => !value.includes("\0") && Array.from(value).length <= limit));
export const clipIdSchema = z.string().check(z.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
export const clipWriteSchema = z.strictObject({
  title: text(256).check(z.refine((value) => !!value.trim())),
  publisher: text(100),
  url: text(2048).check(z.refine((value) => {
    try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password && !/\s/u.test(value) && new TextEncoder().encode(value).length <= 2048; }
    catch { return false; }
  })),
  selection: text(12000),
});
export const clipArticleSchema = z.strictObject({ id: clipIdSchema, ...clipWriteSchema.shape });
export const clipSnapshotSchema = z.strictObject({
  article: clipArticleSchema,
  phase: z.enum(["ready", "requested", "saved", "failed", "unconfirmed"]),
  expires_at_ms: z.int().check(z.nonnegative()),
  requested_at_ms: z.nullable(z.int().check(z.nonnegative())),
});
export const clipResponseSchema = z.strictObject({ clip: z.nullable(clipSnapshotSchema) });
export type ClipWrite = z.infer<typeof clipWriteSchema>;
export type ClipArticle = z.infer<typeof clipArticleSchema>;
export type ClipSnapshot = z.infer<typeof clipSnapshotSchema>;
