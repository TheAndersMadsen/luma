/*
 * The newest published Luma release, fetched from GitHub (INFERRED: Luma's
 * own update discovery; stock Humane had no self-hosted cloud to update).
 *
 * `GET /api/version` advertises it as `latest` beside the deployment
 * identity, so a server that asks this Center — which is every server's
 * default update source — sees a release as soon as it is published, not
 * only after this Center has deployed it. The repository is
 * `LUMA_RELEASES_REPO` (default `TheAndersMadsen/luma`); `off` advertises
 * nothing, which is how a private deployment keeps its members on its own
 * pace. One fetch per ten minutes per process (a failed one is retried after
 * five minutes). The fetch has its own 5 s deadline, so a slow GitHub can
 * never hold the page; a failed lookup answers `latest: null` and the
 * identity still serves.
 */

import { logWarn } from "./log";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RELEASE_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/u;
const RELEASE_TAG = /^v\d{1,6}\.\d{1,6}\.\d{1,6}$/u;
const PIN_ARCHIVE = /^luma-pin-(\d{4}-\d{2}-\d{2}\.\d+)\.tar\.gz$/u;
const DEFAULT_REPOSITORY = "TheAndersMadsen/luma";
const DEADLINE_MS = 5_000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_RELEASE_NOTES_CHARS = 2000;
const SUCCESS_CACHE_MS = 10 * 60 * 1000;
const FAILED_CACHE_MS = 5 * 60 * 1000;

export interface AdvertisedRelease {
  readonly version: string;
  readonly tag: string | null;
  /** The Pin release shipped with that release; GitHub names it but not its version code. */
  readonly pin: { readonly version: string; readonly versionCode: null } | null;
  readonly notes: string | null;
  readonly publishedAt: string | null;
}

type Environment = Record<string, string | undefined>;

/** The GitHub repository this Center advertises releases from, or `null` for none. */
export function releasesRepository(environment: Environment = process.env): string | null {
  const configured = environment.LUMA_RELEASES_REPO;
  // Unset and empty both take the default: the Compose application always
  // defines the variable, so an older runtime.env must keep advertising.
  const trimmed = configured?.trim() || DEFAULT_REPOSITORY;
  if (trimmed.toLowerCase() === "off") return null;
  if (!REPOSITORY.test(trimmed)) {
    logWarn("[updates] LUMA_RELEASES_REPO is not owner/repo or off; advertising no latest release", "LUMA_RELEASES_REPO");
    return null;
  }
  return trimmed;
}

let cached: { repository: string; at: number; release: AdvertisedRelease | null } | null = null;

/** For tests only. */
export function resetUpstreamReleaseCache(): void {
  cached = null;
}

/** Release notes are plain text: control characters out, at most 2000 characters. */
function plainNotes(body: unknown): string | null {
  if (typeof body !== "string") return null;
  const text = body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").trim();
  return text ? text.slice(0, MAX_RELEASE_NOTES_CHARS) : null;
}

function advertised(document: unknown): AdvertisedRelease | null {
  if (typeof document !== "object" || document === null) return null;
  const record = document as Record<string, unknown>;
  const tag = typeof record.tag_name === "string" ? record.tag_name : "";
  const version = tag.startsWith("v") ? tag.slice(1) : "";
  if (!RELEASE_VERSION.test(version)) return null;
  const assets = Array.isArray(record.assets) ? record.assets : [];
  const pinArchive = assets
    .map((asset) =>
      typeof asset === "object" && asset !== null && typeof (asset as Record<string, unknown>).name === "string"
        ? PIN_ARCHIVE.exec((asset as Record<string, unknown>).name as string)
        : null,
    )
    .find((match) => match !== null);
  const pinVersion = pinArchive?.[1];
  const publishedAt =
    typeof record.published_at === "string" &&
    record.published_at.length <= 64 &&
    !Number.isNaN(Date.parse(record.published_at))
      ? record.published_at
      : null;
  return Object.freeze({
    version,
    tag: RELEASE_TAG.test(tag) ? tag : null,
    pin: pinVersion ? Object.freeze({ version: pinVersion, versionCode: null }) : null,
    notes: plainNotes(record.body),
    publishedAt,
  });
}

async function fetchLatestRelease(repository: string, fetchImpl: typeof fetch): Promise<AdvertisedRelease | null> {
  const url = `https://api.github.com/repos/${repository}/releases/latest`;
  try {
    const response = await fetchImpl(url, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(DEADLINE_MS),
      headers: { accept: "application/vnd.github+json", "user-agent": "luma-center" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (Number(response.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw new Error("answer too large");
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) throw new Error("answer too large");
    const release = advertised(JSON.parse(text));
    if (!release) throw new Error("answer names no release");
    return release;
  } catch (error) {
    logWarn("[updates] the GitHub release lookup failed; advertising no latest release",
      error instanceof Error ? error.name : error);
    return null;
  }
}

/** Ask GitHub what the newest published release is, from the cache when fresh. */
export async function upstreamLatest(options: {
  environment?: Environment;
  fetchImpl?: typeof fetch;
  now?: () => number;
} = {}): Promise<AdvertisedRelease | null> {
  const environment = options.environment ?? process.env;
  const now = options.now ?? Date.now;
  const repository = releasesRepository(environment);
  if (!repository) return null;
  if (
    cached &&
    cached.repository === repository &&
    now() - cached.at < (cached.release ? SUCCESS_CACHE_MS : FAILED_CACHE_MS)
  ) {
    return cached.release;
  }
  const release = await fetchLatestRelease(repository, options.fetchImpl ?? fetch);
  cached = { repository, at: now(), release };
  return release;
}
