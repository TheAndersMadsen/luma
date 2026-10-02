import type { ZodMiniType } from "zod/mini";

/** Never put rejected payloads or schema diagnostics in wearer-facing errors. */
export class InvalidResponseError extends Error {
  constructor() {
    super("The service returned an unreadable response. Try again shortly.");
    this.name = "InvalidResponseError";
  }
}

export function parseResponse<T>(schema: ZodMiniType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new InvalidResponseError();
  return result.data;
}
