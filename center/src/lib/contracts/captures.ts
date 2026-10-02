import * as z from "zod/mini";
import { eventEnvelopeSchema } from "./events";
import { countSchema, epochSecondsSchema } from "./pagination";

/** capture_api::MemoryDto and notable_api::photo_record. Field names are compatibility identifiers. */
export const captureUploadStateSchema = z.enum([
  "pending",
  "complete",
  "failed_final",
]);
export type CaptureUploadState = z.infer<typeof captureUploadStateSchema>;
const memoryTypeSchema = z.enum(["PHOTO", "VIDEO", "FOODLOG", "NOTE"]);
const captureIndexFields = {
  uploadComplete: z.optional(z.boolean()),
  uploadState: z.optional(captureUploadStateSchema),
  thumbnailCount: z.optional(countSchema),
  frameCount: z.optional(countSchema),
  durationSec: z.optional(z.number()),
  favorite: z.optional(z.boolean()),
  tags: z.optional(z.array(z.string())),
  bestFrameIndex: z.optional(z.nullable(countSchema)),
  bestFrameMethod: z.optional(z.nullable(z.string())),
  bestFrameReason: z.optional(z.nullable(z.string())),
  visualSearchReady: z.optional(z.boolean()),
  sealed: z.optional(z.boolean()),
};
export const captureDataSchema = z.looseObject({
  ...captureIndexFields,
  thumbnail: z.object({ fileUUID: z.string(), accessToken: z.string() }),
  memoryType: z.optional(memoryTypeSchema),
});
export type CaptureData = z.infer<typeof captureDataSchema>;
export const captureRecordSchema = eventEnvelopeSchema(captureDataSchema);
export type CaptureRecord = z.infer<typeof captureRecordSchema>;
export const memoryDtoSchema = z.object({
  ...captureIndexFields,
  uuid: z.string(),
  id: z.int(),
  deviceLocalId: z.string(),
  type: memoryTypeSchema,
  userCreatedAt: z.nullable(epochSecondsSchema),
  createdAt: epochSecondsSchema,
  deleted: z.boolean(),
  uploadComplete: z.boolean(),
  thumbnailCount: countSchema,
  frameCount: countSchema,
  hasLocation: z.boolean(),
  burstCount: countSchema,
  visualSearchReady: z.boolean(),
  sealed: z.boolean(),
});
export type MemoryDto = z.infer<typeof memoryDtoSchema>;
/** The camera facts in humane.capture.ImageMetadata. */
export const captureCameraFrameSchema = z.object({
  width: countSchema,
  height: countSchema,
  horizonAngle: z.optional(z.number()),
  exposureTimeNs: z.optional(z.number()),
  iso: z.optional(z.number()),
  luminance: z.number(),
});
export type CaptureCameraFrame = z.infer<typeof captureCameraFrameSchema>;
export const captureDetailsSchema = z.object({
  gmtOffsetHours: z.number(),
  format: z.optional(z.string()),
  lutName: z.optional(z.string()),
  frames: z.array(captureCameraFrameSchema),
  hasLocation: z.boolean(),
});
export type CaptureDetails = z.infer<typeof captureDetailsSchema>;
/** One capture with the camera details the Pin sent: what the detail routes answer. */
export const captureDetailRecordSchema = z.extend(captureRecordSchema, {
  details: captureDetailsSchema,
});
export type CaptureDetailRecord = z.infer<typeof captureDetailRecordSchema>;
export const memoryDetailDtoSchema = z.extend(
  memoryDtoSchema,
  captureDetailsSchema.shape,
);
export type MemoryDetailDto = z.infer<typeof memoryDetailDtoSchema>;
export const captureFileSchema = z.object({
  fileId: z.string(),
  index: countSchema,
  kind: z.enum(["PHOTO", "VIDEO"]),
  contentType: z.string(),
  sizeBytes: z.optional(countSchema),
});
export type CaptureFile = z.infer<typeof captureFileSchema>;
export const captureFilesSchema = z.object({
  memoryUuid: z.string(),
  files: z.array(captureFileSchema),
});
export type CaptureFiles = z.infer<typeof captureFilesSchema>;
export const shareLinkSchema = z.object({
  url: z.string(),
  memoryUuid: z.string(),
  expiry: epochSecondsSchema,
});
export type ShareLink = z.infer<typeof shareLinkSchema>;
export const bestFrameResultSchema = z.object({
  frame: countSchema,
  method: z.string(),
  reason: z.string(),
});
export type BestFrameResult = z.infer<typeof bestFrameResultSchema>;
export const bulkDeletedSchema = z.object({
  deleted: z.array(z.string()),
  notFound: z.array(z.string()),
  failed: z.array(z.string()),
});
export type BulkDeleted = z.infer<typeof bulkDeletedSchema>;
export const bulkUpdatedSchema = z.object({ updated: countSchema });
const pendingFields = {
  deviceLocalId: z.string(),
  memoryType: z.enum(["UNSPECIFIED", "PHOTO", "VIDEO", "NOTE", "FOOD_LOG"]),
  delayReason: z.enum(["UNSPECIFIED", "POOR_NETWORK"]),
};
export const pendingCaptureSchema = z.object({
  ...pendingFields,
  declaredAt: z.string(),
});
export type PendingCapture = z.infer<typeof pendingCaptureSchema>;
export const pendingCaptureDtoSchema = z.object({
  ...pendingFields,
  declaredAt: epochSecondsSchema,
});
export const capturePageSchema = z.object({
  photos: z.array(captureRecordSchema),
  total: z.optional(countSchema),
  page: countSchema,
  last: z.boolean(),
});
