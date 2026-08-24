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
      license: {
        name: "Repository license",
        identifier: "LicenseRef-Repository",
        url: "https://github.com/TheAndersMadsen/ai-pin-revival/blob/main/LICENSE",
      },
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
            "Returns the product, immutable release identifier, and explicit runtime environment served by this Center. Use it after deployment to verify that the intended production release is live.",
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
          required: ["product", "release", "environment"],
          properties: {
            product: { type: "string", const: "Ai Pin Revival Center", description: "Product serving the response." },
            release: { type: "string", minLength: 1, maxLength: 128, description: "Immutable release identifier." },
            environment: { type: "string", enum: ["production", "development"], description: "Explicit runtime environment." },
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
