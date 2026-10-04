import { centerRuntimeIdentity } from "@/lib/runtimeIdentity";
import { PUBLIC_API_QUOTA, PUBLIC_API_WINDOW_SECONDS } from "@/lib/public-rate-limit";
import { PUBLIC_PROJECT_NAME, publicOrigin } from "@/lib/public-site";

const rateLimitHeaders = {
  "RateLimit-Policy": {
    description: "Anonymous public-read quota policy using the current IETF HTTPAPI structured-field format.",
    schema: { type: "string", example: `"public-read";q=${PUBLIC_API_QUOTA};w=${PUBLIC_API_WINDOW_SECONDS}` },
  },
  RateLimit: {
    description: "Remaining public-read quota and seconds until reset.",
    schema: { type: "string", example: '"public-read";r=119;t=60' },
  },
} as const;

const rateLimitedResponse = {
  description: "The anonymous public-read quota was exhausted.",
  headers: {
    ...rateLimitHeaders,
    "Retry-After": {
      description: "Seconds until this client should retry.",
      schema: { type: "integer", minimum: 1, example: 60 },
    },
  },
  content: {
    "application/problem+json": {
      schema: { $ref: "#/components/schemas/Problem" },
    },
  },
} as const;

export function centerOpenApi(
  environment: Record<string, string | undefined> = process.env,
) {
  const identity = centerRuntimeIdentity(environment);
  return {
    openapi: "3.1.2",
    info: {
      title: `${PUBLIC_PROJECT_NAME} public API`,
      version: identity.release,
      description:
        "Read-only discovery operations for identifying a self-hosted Center deployment and its currently imported signed Pin release. Wearer and operator APIs are intentionally outside this public contract.",
    },
    servers: [{ url: publicOrigin(environment), description: "This Center deployment" }],
    tags: [{ name: "Discovery", description: "Unauthenticated, read-only deployment discovery." }],
    paths: {
      "/api/version": {
        get: {
          tags: ["Discovery"],
          operationId: "getDeploymentVersion",
          summary: "Read the deployment identity",
          description:
            "Returns the product, immutable release identifier, explicit runtime environment, and the published release this Center runs: version, tag, the Pin release it offers, release notes, and publication time. It also returns `latest`, the newest release this Center advertises from its configured releases repository — what update checks compare against — or null when it advertises none. Use it after deployment to verify that the intended production release is live; other Luma Centers poll it as their update manifest. Release fields are null when this deployment did not set them.",
          responses: {
            "200": {
              description: "The deployment identity.",
              headers: rateLimitHeaders,
              content: { "application/json": { schema: { $ref: "#/components/schemas/DeploymentIdentity" } } },
            },
            "429": rateLimitedResponse,
          },
        },
      },
      "/api/pin/releases/current": {
        get: {
          tags: ["Discovery"],
          operationId: "getCurrentPinRelease",
          summary: "Read the current signed Pin release",
          description:
            "Returns the complete five-application manifest currently imported by the operator. A 404 means no current release exists; a 503 means the configured release store is unavailable or invalid.",
          responses: {
            "200": {
              description: "The current verified Pin release manifest.",
              headers: rateLimitHeaders,
              content: { "application/json": { schema: { $ref: "#/components/schemas/PinReleaseManifest" } } },
            },
            "404": {
              description: "No current Pin release is published.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/PinReleaseError" } } },
            },
            "429": rateLimitedResponse,
            "503": {
              description: "The Pin release store is unavailable or invalid.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/PinReleaseError" } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        DeploymentIdentity: {
          type: "object",
          additionalProperties: false,
          required: ["product", "release", "environment", "version", "tag", "pin", "notes", "publishedAt", "latest"],
          properties: {
            product: { type: "string", const: "Luma Center", description: "Product serving the response." },
            release: { type: "string", minLength: 1, maxLength: 128, description: "Immutable release identifier." },
            environment: { type: "string", enum: ["production", "development"], description: "Explicit runtime environment." },
            version: { type: ["string", "null"], maxLength: 32, examples: ["0.3.16"], description: "Published Luma release version (X.Y.Z)." },
            tag: { type: ["string", "null"], maxLength: 64, examples: ["v0.3.16"], description: "Release tag." },
            pin: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["version", "versionCode"],
                  properties: {
                    version: { type: "string", maxLength: 32, examples: ["2026-09-29.2"], description: "Pin release version this Center offers." },
                    versionCode: { type: ["integer", "null"], minimum: 0, description: "Android version code of that Pin release." },
                  },
                },
                { type: "null" },
              ],
              description: "The Pin release published with this Center, or null.",
            },
            notes: { type: ["string", "null"], maxLength: 2000, description: "Plain-text release notes." },
            publishedAt: { type: ["string", "null"], maxLength: 64, description: "When the release was published (ISO 8601)." },
            latest: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["version", "tag", "pin", "notes", "publishedAt"],
                  properties: {
                    version: { type: "string", maxLength: 32, examples: ["0.3.16"], description: "Newest published release version (X.Y.Z)." },
                    tag: { type: ["string", "null"], maxLength: 64, examples: ["v0.3.16"], description: "Tag of that release." },
                    pin: {
                      oneOf: [
                        {
                          type: "object",
                          additionalProperties: false,
                          required: ["version", "versionCode"],
                          properties: {
                            version: { type: "string", maxLength: 32, examples: ["2026-09-29.2"], description: "Pin release version published with that release." },
                            versionCode: { type: ["integer", "null"], minimum: 0, description: "Android version code of that Pin release, when known." },
                          },
                        },
                        { type: "null" },
                      ],
                      description: "The Pin release published with that release, or null.",
                    },
                    notes: { type: ["string", "null"], maxLength: 2000, description: "Plain-text release notes of that release." },
                    publishedAt: { type: ["string", "null"], maxLength: 64, description: "When that release was published (ISO 8601)." },
                  },
                },
                { type: "null" },
              ],
              description: "The newest release this Center advertises, or null when it advertises none.",
            },
          },
        },
        PinReleaseArtifact: {
          type: "object",
          additionalProperties: false,
          required: ["role", "url", "name", "package", "versionCode", "size", "sha256"],
          properties: {
            role: { type: "string", enum: ["installer", "bootstrap", "hook", "server", "hook-injector"] },
            url: { type: "string", format: "uri" },
            name: { type: "string", pattern: "^[a-z-]+\\.apk$" },
            package: { type: "string", minLength: 1 },
            versionCode: { type: "integer", minimum: 1 },
            size: { type: "integer", minimum: 1 },
            sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          },
        },
        PinReleaseManifest: {
          type: "object",
          additionalProperties: false,
          required: ["schemaVersion", "releaseId", "version", "artifacts"],
          properties: {
            schemaVersion: { type: "integer", const: 1 },
            releaseId: { type: "string", pattern: "^[0-9a-f]{64}$" },
            version: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}\\.\\d+$" },
            artifacts: {
              type: "array",
              minItems: 5,
              maxItems: 5,
              items: { $ref: "#/components/schemas/PinReleaseArtifact" },
            },
          },
        },
        PinReleaseError: {
          type: "object",
          additionalProperties: false,
          required: ["error"],
          properties: { error: { type: "string" }, reason: { type: "string" } },
        },
        Problem: {
          type: "object",
          additionalProperties: false,
          required: ["type", "title", "status", "detail"],
          properties: {
            type: { type: "string", format: "uri-reference" },
            title: { type: "string" },
            status: { type: "integer", const: 429 },
            detail: { type: "string" },
          },
        },
      },
    },
  } as const;
}
