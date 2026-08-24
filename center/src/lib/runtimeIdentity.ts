export function centerRuntimeIdentity(
  environment: Record<string, string | undefined> = process.env,
) {
  return {
    product: "Ai Pin Revival Center",
    release:
      environment.REVIVAL_RELEASE_ID?.trim() ||
      environment.COSMOS_REVISION?.trim() ||
      "development",
    environment: environment.REVIVAL_ENVIRONMENT?.trim() || "development",
  };
}
