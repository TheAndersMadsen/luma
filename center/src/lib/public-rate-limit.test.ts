import { describe, expect, it } from "vitest";

import {
  PUBLIC_API_QUOTA,
  consumePublicApiQuota,
  publicRateLimitHeaders,
} from "./public-rate-limit";

describe("public API quota", () => {
  it("reports remaining quota, denies overflow, and resets the window", () => {
    const key = `test-${crypto.randomUUID()}`;
    const start = 1_000_000;
    let decision = consumePublicApiQuota(key, start);
    expect(decision).toMatchObject({ allowed: true, remaining: PUBLIC_API_QUOTA - 1, resetSeconds: 60 });

    for (let index = 1; index < PUBLIC_API_QUOTA; index += 1) {
      decision = consumePublicApiQuota(key, start + index);
    }
    expect(decision).toMatchObject({ allowed: true, remaining: 0 });
    expect(consumePublicApiQuota(key, start + 1_000)).toMatchObject({ allowed: false, remaining: 0 });
    expect(consumePublicApiQuota(key, start + 60_000)).toMatchObject({ allowed: true, remaining: PUBLIC_API_QUOTA - 1 });
  });

  it("uses the current structured RateLimit field shapes", () => {
    expect(publicRateLimitHeaders({ allowed: true, limit: 120, remaining: 119, resetSeconds: 60 })).toEqual({
      "ratelimit-policy": '"public-read";q=120;w=60',
      ratelimit: '"public-read";r=119;t=60',
    });
  });
});
