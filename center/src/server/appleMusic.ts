import type { MusicAccountSummary } from "@/lib/contracts/music";
import { updateMusicAccountRecord } from "./musicAccounts";

export class AppleMusicError extends Error {
  readonly status: number;

  constructor(message: string, status = 503) {
    super(message);
    this.name = "AppleMusicError";
    this.status = status;
  }
}

export function appleDeveloperToken(): string {
  const token = process.env.APPLE_MUSIC_DEVELOPER_TOKEN?.trim() ?? "";
  if (!token || token.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) {
    throw new AppleMusicError("Apple Music is not configured by this Center operator.", 409);
  }
  return token;
}

/** `link` is the wearer's Apple Music account as Cosmos reports it, or null when Cosmos could not say. */
export function appleConnectionStatus(link: MusicAccountSummary["apple_music"] | null) {
  let configured = true;
  try { appleDeveloperToken(); } catch { configured = false; }
  if (!configured) return { configured: false, state: "not_configured" as const };
  if (!link) return { configured: true, state: "error" as const };
  return {
    configured: true,
    state: link.linked ? "connected_playback_runtime_required" as const : "not_connected" as const,
  };
}

export async function connectAppleMusic(subject: string, tokenValue: unknown, storefrontValue: unknown) {
  appleDeveloperToken();
  const token = typeof tokenValue === "string" ? tokenValue.trim() : "";
  const storefront = typeof storefrontValue === "string" ? storefrontValue.trim().toLowerCase() : "";
  if (!token || token.length > 16_384 || /\p{Cc}/u.test(token)) {
    throw new AppleMusicError("Apple Music returned an invalid user token.", 400);
  }
  if (storefront && !/^[a-z]{2}$/u.test(storefront)) {
    throw new AppleMusicError("Apple Music returned an invalid storefront.", 400);
  }
  await updateMusicAccountRecord(subject, (record) => ({
    ...record,
    apple_music: {
      music_user_token: token,
      ...(storefront ? { storefront } : {}),
      connected_at: new Date().toISOString(),
    },
  }));
}

export async function disconnectAppleMusic(subject: string) {
  await updateMusicAccountRecord(subject, (record) => {
    const { apple_music: _apple, ...rest } = record;
    return rest;
  });
}
