export const PUBLIC_API_QUOTA = 120;
export const PUBLIC_API_WINDOW_SECONDS = 60;
const MAX_TRACKED_CLIENTS = 2_048;

interface Bucket {
  readonly startedAt: number;
  readonly used: number;
}

export interface PublicRateLimit {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetSeconds: number;
}

const buckets = new Map<string, Bucket>();

/** A bounded per-process quota for the two anonymous discovery API calls. */
export function consumePublicApiQuota(key: string, now = Date.now()): PublicRateLimit {
  const windowMs = PUBLIC_API_WINDOW_SECONDS * 1_000;
  const existing = buckets.get(key);
  const bucket = !existing || now - existing.startedAt >= windowMs
    ? { startedAt: now, used: 0 }
    : existing;
  const allowed = bucket.used < PUBLIC_API_QUOTA;
  const used = allowed ? bucket.used + 1 : bucket.used;
  buckets.set(key, { startedAt: bucket.startedAt, used });

  if (buckets.size > MAX_TRACKED_CLIENTS) {
    for (const [client, candidate] of buckets) {
      if (now - candidate.startedAt >= windowMs) buckets.delete(client);
    }
    while (buckets.size > MAX_TRACKED_CLIENTS) {
      const oldest = buckets.keys().next();
      if (oldest.done) break;
      buckets.delete(oldest.value);
    }
  }

  return {
    allowed,
    limit: PUBLIC_API_QUOTA,
    remaining: Math.max(0, PUBLIC_API_QUOTA - used),
    resetSeconds: Math.max(1, Math.ceil((bucket.startedAt + windowMs - now) / 1_000)),
  };
}

export function publicRateLimitHeaders(limit: PublicRateLimit): Record<string, string> {
  return {
    "ratelimit-policy": `"public-read";q=${limit.limit};w=${PUBLIC_API_WINDOW_SECONDS}`,
    "ratelimit": `"public-read";r=${limit.remaining};t=${limit.resetSeconds}`,
  };
}
