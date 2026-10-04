// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The public version route. It serves this deployment's identity plus the
 * release it advertises as newest. The ways it can fail, written before the
 * tests:
 *
 * 1. GitHub is unreachable or answers an error: `latest` is null and the
 *    identity still serves, with the same status and headers.
 * 2. A failure is cached, so one bad minute cannot turn every page load into
 *    a GitHub call.
 * 3. The answer names a tag that is not a release: no latest.
 * 4. The advertised release carries a Pin archive: its version is advertised
 *    without a version code, which GitHub does not name.
 * 5. `LUMA_RELEASES_REPO` is off or not owner/repo: nothing is advertised
 *    and GitHub is never called.
 */

import { GET } from "./route";
import { releasesRepository, resetUpstreamReleaseCache } from "@/server/upstream-releases";

const RELEASE = {
  tag_name: "v0.3.35",
  published_at: "2026-10-04T12:00:00Z",
  body: "MCP tool servers.\n",
  assets: [
    { name: "luma-operator-0.3.35-linux.tar.gz" },
    { name: "luma-pin-2026-09-30.3.tar.gz" },
    { name: "SHA256SUMS" },
  ],
};

function github(answer: unknown, init: ResponseInit = {}) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    typeof answer === "string" ? new Response(answer, init) : Response.json(answer, init),
  );
}

const IDENTITY = {
  LUMA_RELEASE_ID: "abc123",
  LUMA_ENVIRONMENT: "production",
  LUMA_RELEASE_VERSION: "0.3.34",
  LUMA_RELEASE_TAG: "v0.3.34",
};

beforeEach(() => {
  resetUpstreamReleaseCache();
  for (const name of ["LUMA_RELEASES_REPO", ...Object.keys(IDENTITY)]) delete process.env[name];
  Object.assign(process.env, IDENTITY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of ["LUMA_RELEASES_REPO", ...Object.keys(IDENTITY)]) delete process.env[name];
});

describe("GET /api/version", () => {
  it("serves the deployment identity and the advertised release", async () => {
    const fetchImpl = github(RELEASE);
    vi.stubGlobal("fetch", fetchImpl);

    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      product: "Luma Center",
      release: "abc123",
      environment: "production",
      version: "0.3.34",
      tag: "v0.3.34",
      pin: null,
      notes: null,
      publishedAt: null,
      latest: {
        version: "0.3.35",
        tag: "v0.3.35",
        pin: { version: "2026-09-30.3", versionCode: null },
        notes: "MCP tool servers.",
        publishedAt: "2026-10-04T12:00:00Z",
      },
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/TheAndersMadsen/luma/releases/latest");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect((init?.headers as Record<string, string>).accept).toBe("application/vnd.github+json");
  });

  it("serves latest: null when GitHub fails, and caches the failure briefly", async () => {
    const fetchImpl = github("nope", { status: 500 });
    vi.stubGlobal("fetch", fetchImpl);
    expect((await (await GET()).json()).latest).toBeNull();
    expect((await (await GET()).json()).latest).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("serves latest: null when the answer names no release", async () => {
    vi.stubGlobal("fetch", github({ tag_name: "v0.3.35-rc1", assets: [] }));
    expect((await (await GET()).json()).latest).toBeNull();
  });

  it("advertises nothing when LUMA_RELEASES_REPO is off, and never fetches", async () => {
    process.env.LUMA_RELEASES_REPO = "off";
    const fetchImpl = github(RELEASE);
    vi.stubGlobal("fetch", fetchImpl);
    expect((await (await GET()).json()).latest).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(releasesRepository({ LUMA_RELEASES_REPO: "off" })).toBeNull();
    expect(releasesRepository({})).toBe("TheAndersMadsen/luma");
    expect(releasesRepository({ LUMA_RELEASES_REPO: "" })).toBe("TheAndersMadsen/luma");
    expect(releasesRepository({ LUMA_RELEASES_REPO: "someone/fork" })).toBe("someone/fork");
    expect(releasesRepository({ LUMA_RELEASES_REPO: "not a repo" })).toBeNull();
  });
});
