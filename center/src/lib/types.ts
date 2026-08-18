/*
 * Wire types recovered from the shipped API client's response mappers
 * (page-f172beb789cb5e88.js, Feb 2025). Field names are Humane's own.
 */

/** Every record shares this envelope. */
export interface EventEnvelope<T> {
  uuid: string;
  userCreatedAt: string;
  userLastModified?: string;
  data: T;
}

export interface CaptureData {
  thumbnail: { fileUUID: string; accessToken: string };
  /** From the clone's capture index; absent on recovered fixtures. */
  memoryType?: "PHOTO" | "VIDEO" | "FOODLOG" | "NOTE";
  uploadComplete?: boolean;
  thumbnailCount?: number;
  /** Number of frames in the stock burst (normally three for a photo). */
  frameCount?: number;
  /** Zero-based frame selected by Cosmos for Center's hero image. */
  bestFrameIndex?: number;
  /** Clone-owned selector provenance; Humane's original model is unknown. */
  bestFrameMethod?: "vision_v1" | "quality_v1" | "manual" | string;
  bestFrameReason?: string;
  /** True when the body is EncryptedData the server cannot open. */
  sealed?: boolean;
}
export type CaptureRecord = EventEnvelope<CaptureData>;

export interface AiMicData {
  eventData: { request: string; response: string };
}
export type AiMicRecord = EventEnvelope<AiMicData>;

export interface MusicData {
  eventData: {
    trackTitle: string;
    artistName: string;
    albumName: string;
    albumArtUuid: string;
    albumArtHexcode: string;
  };
}
export type MusicRecord = EventEnvelope<MusicData>;

export interface NoteData {
  note: {
    title: string | null;
    text: string;
    /** True when the backend returned a sealed blob we hold no key for. */
    sealed?: boolean;
  };
}
export type NoteRecord = EventEnvelope<NoteData>;

export interface PhoneCallData {
  eventData: { peers: Array<{ displayName: string; phoneNumber: string }> };
}
export type PhoneCallRecord = EventEnvelope<PhoneCallData>;

export interface HealthData {
  eventData: { eventData: Record<string, unknown> };
  eventType: { type: string };
}
export type HealthRecord = EventEnvelope<HealthData>;

export interface TranslationData {
  eventData: { sourceLanguage: string; targetLanguage: string };
}
export type TranslationRecord = EventEnvelope<TranslationData>;

/** GET /capture/memories — the Memories dashboard aggregate. */
export interface DashboardContent {
  photos: CaptureRecord[];
  aiSessions: AiMicRecord[];
  playTrackEvents: MusicRecord[];
  notes: NoteRecord[];
  phoneCalls: PhoneCallRecord[];
  health: HealthRecord[];
}

/** GET /notable-events/mydata/overview */
export interface MyDataOverviewEntry {
  key: string;
  label: string;
  today: number;
  total: number;
  href: string;
}

/** Spring-style pagination, as used by every list endpoint. */
export interface Page<T> {
  content: T[];
  number: number;
  size: number;
  totalElements: number;
  totalPages: number;
  last: boolean;
}
