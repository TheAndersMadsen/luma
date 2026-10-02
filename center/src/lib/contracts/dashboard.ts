import * as z from "zod/mini";
import { captureRecordSchema } from "./captures";
import { partProvenanceSchema } from "./dataSource";
import { aiMicRecordSchema, healthRecordSchema, musicRecordSchema, phoneCallRecordSchema } from "./events";
import { noteRecordSchema } from "./notes";

export const dashboardContentSchema = z.object({
  photos: z.array(captureRecordSchema),
  notes: z.array(noteRecordSchema),
  aiSessions: z.array(aiMicRecordSchema),
  playTrackEvents: z.array(musicRecordSchema),
  phoneCalls: z.array(phoneCallRecordSchema),
  health: z.array(healthRecordSchema),
});
export type DashboardContent = z.infer<typeof dashboardContentSchema>;
/** Each dashboard card reports its own read, independently of the aggregate. */
export const dashboardProvenanceSchema = z.object({
  captures: partProvenanceSchema,
  notes: partProvenanceSchema,
  aiMic: partProvenanceSchema,
  music: partProvenanceSchema,
  calls: partProvenanceSchema,
});
export type DashboardProvenance = z.infer<typeof dashboardProvenanceSchema>;
export const dashboardBodySchema = z.extend(dashboardContentSchema, {
  provenance: dashboardProvenanceSchema,
});
export type DashboardBody = z.infer<typeof dashboardBodySchema>;
