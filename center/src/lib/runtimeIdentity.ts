import { MAX_RELEASE_NOTES_CHARS } from "./contracts/updates";

type Environment = Record<string, string | undefined>;

function optional(value: string | undefined, max: number): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * The deployment identity `GET /api/version` serves. Other Centers poll it as
 * their update manifest, so it is bounded and holds nothing but what a
 * release publishes. The update source, auto-update setting and status file
 * stay out of it. Every optional field is `null` when its variable is unset.
 */
export function centerRuntimeIdentity(
  environment: Environment = process.env,
) {
  const pinVersion = optional(environment.LUMA_PIN_RELEASE_VERSION, 32);
  const pinVersionCode = Number.parseInt(environment.LUMA_PIN_RELEASE_VERSION_CODE?.trim() ?? "", 10);
  return {
    product: "Luma Center",
    release:
      environment.LUMA_RELEASE_ID?.trim() ||
      environment.COSMOS_REVISION?.trim() ||
      "development",
    environment: environment.LUMA_ENVIRONMENT?.trim() || "development",
    version: optional(environment.LUMA_RELEASE_VERSION, 32),
    tag: optional(environment.LUMA_RELEASE_TAG, 64),
    pin: pinVersion
      ? {
          version: pinVersion,
          versionCode: Number.isInteger(pinVersionCode) && pinVersionCode >= 0 ? pinVersionCode : null,
        }
      : null,
    notes: optional(environment.LUMA_RELEASE_NOTES, MAX_RELEASE_NOTES_CHARS),
    publishedAt: optional(environment.LUMA_RELEASE_PUBLISHED_AT, 64),
  };
}
