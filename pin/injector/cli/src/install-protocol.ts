/**
 * @module install-protocol
 *
 * Staging provider message protocol and safe update orchestration.
 *
 * The on-device StagingProvider (content://com.penumbraos.systeminjector/staging)
 * accepts APK uploads and triggers system-UID installation. This module parses
 * its exact wire protocol and implements the keep-data update handshake.
 *
 * ## Provider message protocol
 *
 * The provider returns messages in the format:
 *   Result: Bundle[{message=<payload>}]
 *
 * Recognized payloads:
 * - OK                    — simple success (no package details)
 * - ACCEPTED_PACKAGES:a,b;REPLACEMENTS:c — install committed with listed packages
 * - DUPLICATE_TRANSACTION:<token>;PACKAGES:a,b — packages already installed, retry
 *   with token after keep-data uninstalls
 * - DUPLICATE_BATCH_PACKAGE:<name> — batch contains an internal duplicate
 * - UPDATE_NOT_ELIGIBLE:<name>:uid=<n> — package not eligible for keep-data update
 *
 * ## Duplicate handling complexity
 *
 * When staged APKs include packages that are already installed, the provider
 * refuses to overwrite them directly. Instead it returns the complete duplicate
 * list plus an opaque one-use retry token. The token is bound to the exact
 * filenames, package names, staged digests, and replacement code paths — a
 * concurrent request cannot substitute different artifacts after the duplicate
 * response.
 *
 * The CLI then:
 * 1. Validates the complete provider response
 * 2. Verifies each update target is installed only for user 0
 * 3. Runs keep-data uninstalls (pm uninstall -k --user 0)
 * 4. Retries with the token (provider holds the same batch behind it)
 *
 * If anything fails between uninstall and retry, the CLI attempts to restore
 * every affected package for user 0 before propagating the error.
 *
 * ## Safety guarantees
 *
 * - The installer package itself is protected: the provider refuses to update
 *   it through its own running staging provider
 * - No uninstall occurs until the full duplicate list is parsed and validated
 * - At most one keep-data update pass is attempted (no retry loops)
 * - Failed uninstalls trigger idempotent restoration of all already-removed packages
 */

const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

export type ProviderInstallResponse =
  | { kind: "ok"; packageNames: string[] | null }
  | { kind: "accepted"; packageNames: string[]; replacementPackages: string[] }
  | { kind: "duplicates"; packageNames: string[]; transactionToken: string }
  | { kind: "duplicate-batch"; packageName: string }
  | { kind: "update-not-eligible"; packageName: string; uid: number }
  | { kind: "invalid"; detail: string };

export function extractProviderMessage(output: string): string | null {
  const match = output.trim().match(/^Result: Bundle\[\{message=([^}\]]*)\}\]$/);
  return match?.[1]?.trim() ?? null;
}

export function isSafePackageName(packageName: string): boolean {
  return PACKAGE_NAME.test(packageName);
}

/** Parse the exact message protocol emitted by StagingProvider. */
export function parseProviderInstallResponse(output: string): ProviderInstallResponse {
  const message = extractProviderMessage(output);
  if (message === null) {
    return { kind: "invalid", detail: `missing provider message in: ${output}` };
  }

  if (message === "OK") return { kind: "ok", packageNames: null };

  const acceptedPackages = message.match(/^ACCEPTED_PACKAGES:([^;]+);REPLACEMENTS:(.*)$/);
  if (acceptedPackages) {
    const packageNames = acceptedPackages[1]!.split(",");
    const replacementPackages = acceptedPackages[2]
      ? acceptedPackages[2].split(",")
      : [];
    if (
      packageNames.length > 0 &&
      packageNames.every(isSafePackageName) &&
      new Set(packageNames).size === packageNames.length &&
      replacementPackages.every(isSafePackageName) &&
      new Set(replacementPackages).size === replacementPackages.length &&
      replacementPackages.every((name) => packageNames.includes(name))
    ) {
      return { kind: "accepted", packageNames, replacementPackages };
    }
    return { kind: "invalid", detail: `invalid successful package list: ${message}` };
  }

  const updateNotEligible = message.match(/^UPDATE_NOT_ELIGIBLE:([^:]+):uid=(-?\d+)$/);
  if (updateNotEligible) {
    const packageName = updateNotEligible[1] ?? "";
    const uid = Number(updateNotEligible[2]);
    if (isSafePackageName(packageName) && Number.isSafeInteger(uid)) {
      return { kind: "update-not-eligible", packageName, uid };
    }
    return { kind: "invalid", detail: `invalid ineligible update response: ${message}` };
  }

  const duplicateBatch = message.match(/^DUPLICATE_BATCH_PACKAGE:(.+)$/);
  if (duplicateBatch) {
    const packageName = duplicateBatch[1] ?? "";
    if (isSafePackageName(packageName)) {
      return { kind: "duplicate-batch", packageName };
    }
    return { kind: "invalid", detail: `invalid duplicate batch package: ${message}` };
  }

  const duplicateTransaction = message.match(
    /^DUPLICATE_TRANSACTION:([a-f0-9]{32});PACKAGES:(.+)$/
  );
  if (duplicateTransaction) {
    const transactionToken = duplicateTransaction[1]!;
    const packageNames = duplicateTransaction[2]!.split(",");
    if (
      packageNames.length > 0 &&
      packageNames.every(isSafePackageName) &&
      new Set(packageNames).size === packageNames.length
    ) {
      return { kind: "duplicates", packageNames, transactionToken };
    }
    return { kind: "invalid", detail: `invalid duplicate transaction: ${message}` };
  }

  return { kind: "invalid", detail: `unrecognized provider message: ${message}` };
}

export interface SafeUpdateOperations {
  callProvider(transactionToken?: string): Promise<string>;
  cancelProviderTransaction?(transactionToken: string): Promise<void>;
  uninstallKeepData(packageName: string): Promise<void>;
  restoreAfterFailedUpdate?(packageName: string): Promise<void>;
  validateBeforeUninstalls?(packageNames: readonly string[]): Promise<void>;
  onDuplicatesDetected?(packageNames: readonly string[]): void;
  onBeforeUninstall?(packageName: string): void;
  onBeforeRetry?(): void;
}

export interface SafeUpdateResult {
  updatedPackages: string[];
  installedPackages: string[];
}

function successfulPackages(response: ProviderInstallResponse): string[] {
  if (response.kind !== "accepted") {
    throw new Error(
      "System install provider did not return the exact accepted package list; " +
      "refusing to report install completion."
    );
  }
  return response.packageNames;
}

async function restoreAndThrow(
  operations: SafeUpdateOperations,
  packageNames: readonly string[],
  originalError: unknown,
  transactionToken: string
): Promise<never> {
  const restorationFailures: string[] = [];
  try {
    await operations.cancelProviderTransaction?.(transactionToken);
  } catch (error) {
    restorationFailures.push(
      `provider transaction cleanup: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  for (const packageName of [...packageNames].reverse()) {
    try {
      await operations.restoreAfterFailedUpdate?.(packageName);
    } catch (error) {
      restorationFailures.push(
        `${packageName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (restorationFailures.length > 0) {
    const originalMessage =
      originalError instanceof Error ? originalError.message : String(originalError);
    throw new Error(
      `${originalMessage} User-0 restoration also failed: ${restorationFailures.join("; ")}`,
      { cause: originalError }
    );
  }
  throw originalError;
}

async function cancelAndThrow(
  operations: SafeUpdateOperations,
  transactionToken: string,
  originalError: unknown
): Promise<never> {
  try {
    await operations.cancelProviderTransaction?.(transactionToken);
  } catch (cancelError) {
    const originalMessage =
      originalError instanceof Error ? originalError.message : String(originalError);
    throw new Error(
      `${originalMessage} Provider transaction cleanup also failed: ` +
        `${cancelError instanceof Error ? cancelError.message : String(cancelError)}`,
      { cause: originalError }
    );
  }
  throw originalError;
}

function initialResponseError(response: ProviderInstallResponse): Error {
  if (response.kind === "duplicate-batch") {
    return new Error(`Batch contains duplicate package: ${response.packageName}`);
  }
  if (response.kind === "invalid") {
    return new Error(
      `System install provider returned an invalid response; refusing to uninstall anything: ${response.detail}`
    );
  }
  if (response.kind === "update-not-eligible") {
    return new Error(
      `Refusing to keep-data update ${response.packageName}: installed UID ${response.uid} ` +
      `or code path is not injector-managed. No installed package was changed.`
    );
  }
  return new Error(`Unexpected initial provider response: ${response.kind}`);
}

function retryResponseError(response: ProviderInstallResponse): Error {
  if (response.kind === "ok") {
    return new Error(
      "System install retry did not return the exact accepted package list; " +
      "no further uninstalls will be attempted."
    );
  }
  if (response.kind === "duplicates") {
    return new Error(
      `System install retry still reports installed package(s): ${response.packageNames.join(", ")}. ` +
      `No further uninstalls will be attempted.`
    );
  }
  if (response.kind === "duplicate-batch") {
    return new Error(
      `System install retry reports a duplicate package in the batch: ${response.packageName}. ` +
      `No further uninstalls will be attempted.`
    );
  }
  if (response.kind === "update-not-eligible") {
    return new Error(
      `System install retry reports ${response.packageName} is not eligible for a keep-data update ` +
      `(UID ${response.uid}); no further package changes will be attempted.`
    );
  }
  if (response.kind === "invalid") {
    return new Error(
      `System install retry returned an invalid response; no further uninstalls will be attempted: ${response.detail}`
    );
  }
  return new Error(`Unexpected successful retry response handling`);
}

/**
 * Run the provider handshake, applying at most one keep-data update pass.
 * No uninstall occurs until the full duplicate list has been parsed and checked
 * for the protected installer package.
 */
export async function installWithSafeUpdates(
  operations: SafeUpdateOperations,
  protectedPackage: string
): Promise<SafeUpdateResult> {
  const initialResponse = parseProviderInstallResponse(await operations.callProvider());
  if (initialResponse.kind === "accepted") {
    return {
      updatedPackages: [...initialResponse.replacementPackages],
      installedPackages: successfulPackages(initialResponse),
    };
  }
  if (initialResponse.kind === "ok") {
    throw new Error(
      "System install provider did not return the exact accepted package list; " +
      "refusing to report install completion."
    );
  }
  if (initialResponse.kind !== "duplicates") throw initialResponseError(initialResponse);

  if (initialResponse.packageNames.includes(protectedPackage)) {
    return cancelAndThrow(
      operations,
      initialResponse.transactionToken,
      new Error(
        `Refusing to update ${protectedPackage} through its own running provider. ` +
        `Self-update requires bootstrap through the explicit recovery procedure; it cannot use ` +
        `the running install provider. ` +
        `No installed package was changed.`
      )
    );
  }

  try {
    await operations.validateBeforeUninstalls?.(initialResponse.packageNames);
  } catch (error) {
    return cancelAndThrow(operations, initialResponse.transactionToken, error);
  }
  operations.onDuplicatesDetected?.(initialResponse.packageNames);
  const uninstalledPackages: string[] = [];
  for (const packageName of initialResponse.packageNames) {
    operations.onBeforeUninstall?.(packageName);
    // The uninstall command can mutate successfully and then fail during host-side
    // verification, so include the current package in idempotent restoration up front.
    uninstalledPackages.push(packageName);
    try {
      await operations.uninstallKeepData(packageName);
    } catch (error) {
      return restoreAndThrow(
        operations,
        uninstalledPackages,
        error,
        initialResponse.transactionToken
      );
    }
  }

  operations.onBeforeRetry?.();
  let retryResponse: ProviderInstallResponse;
  try {
    retryResponse = parseProviderInstallResponse(
      await operations.callProvider(initialResponse.transactionToken)
    );
  } catch (error) {
    return restoreAndThrow(
      operations,
      uninstalledPackages,
      error,
      initialResponse.transactionToken
    );
  }
  if (retryResponse.kind !== "accepted") {
    return restoreAndThrow(
      operations,
      uninstalledPackages,
      retryResponseError(retryResponse),
      initialResponse.transactionToken
    );
  }
  const installedPackages = successfulPackages(retryResponse);
  if (!initialResponse.packageNames.every((name) => installedPackages.includes(name))) {
    return restoreAndThrow(
      operations,
      uninstalledPackages,
      new Error("Accepted package list omitted an approved update target"),
      initialResponse.transactionToken
    );
  }

  return {
    updatedPackages: [
      ...new Set([...initialResponse.packageNames, ...retryResponse.replacementPackages]),
    ],
    installedPackages,
  };
}
