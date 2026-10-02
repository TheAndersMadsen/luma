// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { versionManifestSchema } from "@/lib/contracts/updates";
import { GET } from "./route";

/*
 * `GET /api/version` is public and other Centers poll it as their update
 * manifest: it must stay no-store, JSON, bounded, and free of anything the
 * server keeps to itself (its update source, settings, or secrets).
 */

const RELEASE_ENV = {
  LUMA_RELEASE_ID: "0123456789abcdef0123456789abcdef01234567",
  LUMA_ENVIRONMENT: "production",
  LUMA_RELEASE_VERSION: "0.3.16",
  LUMA_RELEASE_TAG: "v0.3.16",
  LUMA_PIN_RELEASE_VERSION: "2026-09-29.2",
  LUMA_PIN_RELEASE_VERSION_CODE: "2026092902",
  LUMA_RELEASE_NOTES: "Faster weather.\nCalmer banner.",
  LUMA_RELEASE_PUBLISHED_AT: "2026-09-29T18:00:00Z",
} as const;

const UNSET = [
  "LUMA_RELEASE_VERSION",
  "LUMA_RELEASE_TAG",
  "LUMA_PIN_RELEASE_VERSION",
  "LUMA_PIN_RELEASE_VERSION_CODE",
  "LUMA_RELEASE_NOTES",
  "LUMA_RELEASE_PUBLISHED_AT",
] as const;

function stub(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/version", () => {
  it("serves the release manifest as uncached JSON", async () => {
    stub(RELEASE_ENV);
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      product: "Luma Center",
      release: RELEASE_ENV.LUMA_RELEASE_ID,
      environment: "production",
      version: "0.3.16",
      tag: "v0.3.16",
      pin: { version: "2026-09-29.2", versionCode: 2026092902 },
      notes: "Faster weather.\nCalmer banner.",
      publishedAt: "2026-09-29T18:00:00Z",
    });
    expect(versionManifestSchema.safeParse(body).success).toBe(true);
  });

  it("answers null for every release field a deployment did not set", async () => {
    stub({ LUMA_RELEASE_ID: "abc", LUMA_ENVIRONMENT: "production" });
    for (const key of UNSET) vi.stubEnv(key, undefined);
    const body = await (await GET()).json();

    expect(body).toEqual({
      product: "Luma Center",
      release: "abc",
      environment: "production",
      version: null,
      tag: null,
      pin: null,
      notes: null,
      publishedAt: null,
    });
    expect(versionManifestSchema.safeParse(body).success).toBe(true);
  });

  it("bounds the notes and drops an unreadable Pin version code", async () => {
    stub({ ...RELEASE_ENV, LUMA_RELEASE_NOTES: "x".repeat(5000), LUMA_PIN_RELEASE_VERSION_CODE: "soon" });
    const body = await (await GET()).json();

    expect(body.notes).toHaveLength(2000);
    expect(body.pin).toEqual({ version: "2026-09-29.2", versionCode: null });
    expect(versionManifestSchema.safeParse(body).success).toBe(true);
  });

  it("never publishes the update source, update settings, or secrets", async () => {
    stub({
      ...RELEASE_ENV,
      LUMA_UPDATE_SOURCE: "https://private-source.example.test",
      LUMA_AUTO_UPDATES: "on",
      LUMA_UPDATE_STATUS_FILE: "/var/lib/luma/update-status.json",
      AUTH_SESSION_SECRET: "session-secret-value",
    });
    const text = await (await GET()).text();

    expect(text).not.toContain("private-source.example.test");
    expect(text).not.toContain("update-status.json");
    expect(text).not.toContain("session-secret-value");
    expect(text).not.toMatch(/autoUpdates|source/u);
  });
});
