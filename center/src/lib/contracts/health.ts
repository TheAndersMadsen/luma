import * as z from "zod/mini";
import { dataFallbackSchema, dataStateSchema } from "./dataSource";

const authFlags = {
  reauthenticate: z.optional(z.literal(true)),
  authUnavailable: z.optional(z.literal(true)),
};
/** REST and gRPC can fail independently. An expired grant is not a service outage. */
export const planeHealthSchema = z.object({
  configured: z.boolean(),
  state: dataStateSchema,
  endpoint: z.optional(z.string()),
  detail: z.string(),
  ...authFlags,
});
export type PlaneHealth = z.infer<typeof planeHealthSchema>;
export const healthInfoSchema = z.object({
  cosmosConfigured: z.boolean(),
  reachable: z.boolean(),
  endpoint: z.optional(z.string()),
  state: dataStateSchema,
  fallback: z.optional(dataFallbackSchema),
  detail: z.string(),
  ...authFlags,
  planes: z.optional(
    z.object({ grpc: planeHealthSchema, webapi: planeHealthSchema }),
  ),
});
export type HealthInfo = z.infer<typeof healthInfoSchema>;
