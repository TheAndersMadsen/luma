import * as z from "zod/mini";
import { musicProviderSchema } from "./music";
import { countSchema } from "./pagination";

/** Recovered event envelope. A stock event with no creation time uses an empty string. */
export function eventEnvelopeSchema<T extends z.ZodMiniType>(data: T) {
  return z.looseObject({
    uuid: z.string(),
    userCreatedAt: z.string(),
    userLastModified: z.optional(z.string()),
    data,
  });
}
export type EventEnvelope<T> = z.infer<
  ReturnType<typeof eventEnvelopeSchema<z.ZodMiniType<T>>>
>;
export const eventVoteSchema = z.enum(["up", "down"]);
export type EventVote = z.infer<typeof eventVoteSchema>;
export const callDirectionSchema = z.enum(["incoming", "outgoing"]);
export type CallDirection = z.infer<typeof callDirectionSchema>;
export const callOutcomeSchema = z.enum([
  "answered",
  "missed",
  "unanswered",
  "filtered",
]);
export type CallOutcome = z.infer<typeof callOutcomeSchema>;

// NotableEvent.data is a stock Struct, so fields may be absent even on an open
// event. Validate any supplied field. Never invent missing speech or track data.
const eventFlags = {
  eventType: z.optional(z.string()),
  sealed: z.optional(z.boolean()),
};
export const aiMicDataSchema = z.looseObject({
  ...eventFlags,
  eventData: z.looseObject({
    request: z.optional(z.string()),
    response: z.optional(z.string()),
  }),
  vote: z.optional(z.nullable(eventVoteSchema)),
  typedInCenter: z.optional(z.boolean()),
});
export type AiMicData = z.infer<typeof aiMicDataSchema>;
export const aiMicRecordSchema = eventEnvelopeSchema(aiMicDataSchema);
export type AiMicRecord = z.infer<typeof aiMicRecordSchema>;
export const musicDataSchema = z.looseObject({
  ...eventFlags,
  eventData: z.looseObject({
    trackTitle: z.optional(z.string()),
    artistName: z.optional(z.string()),
    albumName: z.optional(z.string()),
    albumArtUuid: z.optional(z.string()),
    albumArtHexcode: z.optional(z.string()),
    trackID: z.optional(z.string()),
    sourceService: z.optional(z.string()),
    provider: z.optional(z.nullable(musicProviderSchema)),
  }),
});
export type MusicData = z.infer<typeof musicDataSchema>;
export const musicRecordSchema = eventEnvelopeSchema(musicDataSchema);
export type MusicRecord = z.infer<typeof musicRecordSchema>;
export const phoneCallDataSchema = z.looseObject({
  ...eventFlags,
  eventData: z.looseObject({
    peers: z.optional(
      z.array(z.object({ displayName: z.string(), phoneNumber: z.string() })),
    ),
    conversationId: z.optional(z.string()),
    direction: z.optional(callDirectionSchema),
    outcome: z.optional(callOutcomeSchema),
    durationSeconds: z.optional(z.number()),
    eventIds: z.optional(z.array(z.string())),
  }),
});
export type PhoneCallData = z.infer<typeof phoneCallDataSchema>;
export const phoneCallRecordSchema = eventEnvelopeSchema(phoneCallDataSchema);
export type PhoneCallRecord = z.infer<typeof phoneCallRecordSchema>;
export const translationDataSchema = z.looseObject({
  ...eventFlags,
  eventData: z.looseObject({
    sourceLanguage: z.optional(z.string()),
    targetLanguage: z.optional(z.string()),
  }),
});
export type TranslationData = z.infer<typeof translationDataSchema>;
export const translationRecordSchema = eventEnvelopeSchema(
  translationDataSchema,
);
export type TranslationRecord = z.infer<typeof translationRecordSchema>;
export const healthDataSchema = z.looseObject({
  sealed: z.optional(z.boolean()),
  eventData: z.object({ eventData: z.record(z.string(), z.unknown()) }),
  eventType: z.object({ type: z.string() }),
});
export type HealthData = z.infer<typeof healthDataSchema>;
export const healthRecordSchema = eventEnvelopeSchema(healthDataSchema);
export type HealthRecord = z.infer<typeof healthRecordSchema>;
const eventSchemas = {
  AI_MIC: aiMicRecordSchema,
  MUSIC: musicRecordSchema,
  CALL: phoneCallRecordSchema,
  TRANSLATION: translationRecordSchema,
};
export type DomainRecord = {
  [K in keyof typeof eventSchemas]: z.infer<(typeof eventSchemas)[K]>;
};
export const domainRecordSchemas: {
  [K in keyof DomainRecord]: z.ZodMiniType<DomainRecord[K]>;
} = eventSchemas;
/** Non-CAPTURE spellings are INFERRED. Cosmos notable_api owns their mapping. */
export type MyDataDomain = keyof DomainRecord | "FOOD";
export const myDataOverviewEntrySchema = z.object({
  key: z.string(),
  label: z.string(),
  today: countSchema,
  total: countSchema,
  href: z.string(),
});
export type MyDataOverviewEntry = z.infer<typeof myDataOverviewEntrySchema>;
export const cosmosOverviewSchema = z.object({
  todayStart: z.string(),
  domains: z.array(
    z.object({ domain: z.string(), today: countSchema, total: countSchema }),
  ),
});
export const eventVoteResultSchema = z.object({ vote: eventVoteSchema });
