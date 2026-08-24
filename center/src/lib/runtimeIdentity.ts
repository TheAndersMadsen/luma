export function centerRuntimeIdentity(environment: NodeJS.ProcessEnv = process.env) {
  return {
    product: "Ai Pin Revival Center",
    release:
      environment.REVIVAL_RELEASE_ID?.trim() ||
      environment.COSMOS_REVISION?.trim() ||
      "development",
    environment: environment.REVIVAL_ENVIRONMENT?.trim() || "development",
  };
}
