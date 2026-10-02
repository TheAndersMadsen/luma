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

/**
 * The caller's network address as the edge reports it. Cloudflare's header
 * first, then the first forwarded hop Traefik records.
 */
export function requestClientAddress(headers: Headers): string {
  // Traefik does not trust incoming X-Forwarded-* from the internet, so these
  // two name the peer that actually connected to it.
  const peer = headers.get("x-real-ip")?.trim() ||
    headers.get("x-forwarded-for")?.split(",").pop()?.trim() ||
    "";
  // Cloudflare's header is only believable when the peer is the local tunnel
  // (a private or loopback address). :443 is also reachable directly for the
  // Pin edge, and a direct caller could otherwise pick any address it likes.
  const cloudflare = headers.get("cf-connecting-ip")?.trim();
  if (cloudflare && peer && isPrivateAddress(peer)) return cloudflare;
  return peer || "unidentified";
}

/** Loopback, RFC 1918, link-local and IPv6 unique-local addresses. */
export function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^::ffff:/u, "");
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/u.exec(value);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return value === "::1" || /^f[cd][0-9a-f]{0,2}:/u.test(value) || /^fe[89ab][0-9a-f]?:/u.test(value);
}
