import { describe, expect, it } from "vitest";

import { centerOpenApi } from "./openapi";

describe("public OpenAPI description", () => {
  const specification = centerOpenApi({
    REVIVAL_PUBLIC_ORIGIN: "https://center.example.test",
    REVIVAL_RELEASE_ID: "release-123",
    REVIVAL_ENVIRONMENT: "production",
  });

  it("publishes a portable OpenAPI 3.1 document", () => {
    expect(specification.openapi).toBe("3.1.2");
    expect(specification.info.version).toBe("release-123");
    expect(specification.servers).toEqual([{ url: "https://center.example.test", description: "This Center deployment" }]);
  });

  it("uses unique operation IDs, descriptions, and typed successful responses", () => {
    const operations = Object.values(specification.paths).map((path) => path.get);
    const operationIds = operations.map((operation) => operation.operationId);
    expect(new Set(operationIds).size).toBe(operationIds.length);
    for (const operation of operations) {
      expect(operation.description.length).toBeGreaterThan(30);
      expect(operation.responses["200"].content["application/json"].schema.$ref).toMatch(/^#\/components\/schemas\//);
      expect(operation.responses["429"].headers["Retry-After"]).toBeDefined();
    }
  });

  it("fully types every object and the exact five Pin roles", () => {
    const schemas = specification.components.schemas;
    expect(schemas.DeploymentIdentity.additionalProperties).toBe(false);
    expect(schemas.PinReleaseManifest.properties.artifacts).toMatchObject({ minItems: 5, maxItems: 5 });
    expect(schemas.PinReleaseArtifact.properties.role.enum).toEqual([
      "installer", "bootstrap", "hook", "server", "hook-injector",
    ]);
  });
});
