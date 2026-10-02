const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

export type ProviderInstallResponse =
  | { readonly kind: "ok" }
  | {
      readonly kind: "accepted";
      readonly packageNames: readonly string[];
      readonly replacementPackages: readonly string[];
    }
  | {
      readonly kind: "duplicates";
      readonly packageNames: readonly string[];
      readonly transactionToken: string;
    }
  | { readonly kind: "duplicate-batch"; readonly packageName: string }
  | {
      readonly kind: "update-not-eligible";
      readonly packageName: string;
      readonly uid: number;
    }
  | { readonly kind: "invalid"; readonly detail: string };

export interface SafeProviderInstallOperations {
  callInstall(): Promise<string>;
  retryInstall(transactionToken: string): Promise<string>;
  cancelInstall(transactionToken: string): Promise<void>;
  validateBeforeUninstall(packageNames: readonly string[]): Promise<void>;
  uninstallKeepData(packageName: string): Promise<void>;
  restoreForUser(packageName: string): Promise<void>;
}

export interface SafeProviderInstallOptions {
  readonly protectedPackageName: string;
  readonly expectedPackageNames?: readonly string[];
  readonly expectedInstalledPackageNames?: readonly string[];
  readonly expectedPackageCount?: number;
}

export interface SafeProviderInstallResult {
  readonly installedPackages: readonly string[];
  readonly updatedPackages: readonly string[];
}

function isSafeUniquePackageList(packageNames: readonly string[]): boolean {
  return (
    packageNames.length > 0 &&
    packageNames.every((packageName) => PACKAGE_NAME.test(packageName)) &&
    new Set(packageNames).size === packageNames.length
  );
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value))
  );
}

/** observed: parse only the exact Bundle message emitted by StagingProvider. */
export function extractExactProviderMessage(output: string): string | null {
  const bundle = output
    .trim()
    .match(/^Result: Bundle\[\{message=([^}\]]*)\}\]$/);
  return bundle?.[1]?.trim() ?? null;
}

export function parseProviderInstallResponse(
  output: string,
): ProviderInstallResponse {
  const message = extractExactProviderMessage(output);
  if (message === null) {
    return { kind: "invalid", detail: "missing exact provider Bundle message" };
  }
  if (message === "OK") {
    return { kind: "ok" };
  }

  const accepted = message.match(
    /^ACCEPTED_PACKAGES:([^;]+);REPLACEMENTS:(.*)$/,
  );
  if (accepted) {
    const packageNames = (accepted[1] ?? "").split(",");
    const replacementPackages = accepted[2] ? accepted[2].split(",") : [];
    if (
      isSafeUniquePackageList(packageNames) &&
      new Set(replacementPackages).size === replacementPackages.length &&
      replacementPackages.every(
        (packageName) =>
          PACKAGE_NAME.test(packageName) && packageNames.includes(packageName),
      )
    ) {
      return { kind: "accepted", packageNames, replacementPackages };
    }
    return { kind: "invalid", detail: "invalid accepted package list" };
  }

  const duplicates = message.match(
    /^DUPLICATE_TRANSACTION:([a-f0-9]{32});PACKAGES:(.+)$/,
  );
  if (duplicates) {
    const packageNames = (duplicates[2] ?? "").split(",");
    if (isSafeUniquePackageList(packageNames)) {
      return {
        kind: "duplicates",
        transactionToken: duplicates[1]!,
        packageNames,
      };
    }
    return { kind: "invalid", detail: "invalid duplicate transaction" };
  }

  const duplicateBatch = message.match(/^DUPLICATE_BATCH_PACKAGE:(.+)$/);
  if (duplicateBatch && PACKAGE_NAME.test(duplicateBatch[1] ?? "")) {
    return { kind: "duplicate-batch", packageName: duplicateBatch[1]! };
  }

  const ineligible = message.match(
    /^UPDATE_NOT_ELIGIBLE:([^:]+):uid=(-?\d+)$/,
  );
  if (ineligible) {
    const uid = Number(ineligible[2]);
    if (PACKAGE_NAME.test(ineligible[1] ?? "") && Number.isSafeInteger(uid)) {
      return {
        kind: "update-not-eligible",
        packageName: ineligible[1]!,
        uid,
      };
    }
  }

  return { kind: "invalid", detail: `unrecognized provider message: ${message}` };
}

function requireAcceptedPackages(
  response: ProviderInstallResponse,
  options: SafeProviderInstallOptions,
): readonly string[] {
  if (response.kind !== "accepted") {
    throw new Error(
      `Device Installer retry did not return an exact accepted package list (${response.kind}).`,
    );
  }
  if (
    options.expectedPackageNames &&
    !sameSet(response.packageNames, options.expectedPackageNames)
  ) {
    throw new Error("Device Installer accepted an unexpected package set.");
  }
  if (
    options.expectedPackageCount !== undefined &&
    response.packageNames.length !== options.expectedPackageCount
  ) {
    throw new Error("Device Installer accepted an unexpected package count.");
  }
  if (response.packageNames.includes(options.protectedPackageName)) {
    throw new Error(
      `Refusing to update protected installer ${options.protectedPackageName} through its own provider.`,
    );
  }
  return response.packageNames;
}

function describeInitialFailure(response: ProviderInstallResponse): Error {
  switch (response.kind) {
    case "ok":
      return new Error(
        "Device Installer returned OK without the exact accepted package list.",
      );
    case "duplicate-batch":
      return new Error(`Staged batch repeats ${response.packageName}.`);
    case "update-not-eligible":
      return new Error(
        `Provider refused keep-data update for ${response.packageName} (UID ${response.uid}).`,
      );
    case "invalid":
      return new Error(
        `Device Installer returned an invalid response; no package was uninstalled: ${response.detail}`,
      );
    default:
      return new Error(`Unexpected provider response: ${response.kind}.`);
  }
}

async function cancelAndThrow(
  operations: SafeProviderInstallOperations,
  token: string,
  error: unknown,
): Promise<never> {
  try {
    await operations.cancelInstall(token);
  } catch (cancelError) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Transaction cancellation also failed: ${
        cancelError instanceof Error ? cancelError.message : String(cancelError)
      }`,
      { cause: error },
    );
  }
  throw error;
}

async function restoreAndThrow(
  operations: SafeProviderInstallOperations,
  token: string,
  removedPackages: readonly string[],
  error: unknown,
): Promise<never> {
  const failures: string[] = [];
  try {
    await operations.cancelInstall(token);
  } catch (cancelError) {
    failures.push(
      `transaction cancellation: ${
        cancelError instanceof Error ? cancelError.message : String(cancelError)
      }`,
    );
  }
  for (const packageName of [...removedPackages].reverse()) {
    try {
      await operations.restoreForUser(packageName);
    } catch (restoreError) {
      failures.push(
        `${packageName}: ${
          restoreError instanceof Error
            ? restoreError.message
            : String(restoreError)
        }`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} User-0 restoration also failed: ${failures.join("; ")}`,
      { cause: error },
    );
  }
  throw error;
}

/**
 * implemented: execute one immutable keep-data retry at most. No uninstall is
 * issued until the complete duplicate response and Android-user state pass.
 */
export async function installWithSafeProviderUpdates(
  operations: SafeProviderInstallOperations,
  options: SafeProviderInstallOptions,
): Promise<SafeProviderInstallResult> {
  const initial = parseProviderInstallResponse(await operations.callInstall());
  if (initial.kind === "accepted") {
    const installedPackages = requireAcceptedPackages(initial, options);
    if ((options.expectedInstalledPackageNames?.length ?? 0) > 0) {
      throw new Error(
        "Provider accepted an install although inspected packages were still installed.",
      );
    }
    return {
      installedPackages: [...installedPackages],
      updatedPackages: [...initial.replacementPackages],
    };
  }
  if (initial.kind !== "duplicates") {
    throw describeInitialFailure(initial);
  }

  const token = initial.transactionToken;
  if (initial.packageNames.includes(options.protectedPackageName)) {
    return cancelAndThrow(
      operations,
      token,
      new Error(
        `Refusing to update protected installer ${options.protectedPackageName} through its own provider.`,
      ),
    );
  }
  if (
    options.expectedPackageNames &&
    !initial.packageNames.every((name) =>
      options.expectedPackageNames!.includes(name),
    )
  ) {
    return cancelAndThrow(
      operations,
      token,
      new Error("Provider reported a duplicate outside the staged package set."),
    );
  }
  if (
    options.expectedPackageCount !== undefined &&
    initial.packageNames.length > options.expectedPackageCount
  ) {
    return cancelAndThrow(
      operations,
      token,
      new Error("Provider reported more duplicate packages than staged APKs."),
    );
  }
  if (
    options.expectedInstalledPackageNames &&
    !sameSet(initial.packageNames, options.expectedInstalledPackageNames)
  ) {
    return cancelAndThrow(
      operations,
      token,
      new Error("Provider duplicate list does not match the inspected installed set."),
    );
  }

  try {
    await operations.validateBeforeUninstall(initial.packageNames);
  } catch (error) {
    return cancelAndThrow(operations, token, error);
  }

  const removedPackages: string[] = [];
  for (const packageName of initial.packageNames) {
    removedPackages.push(packageName);
    try {
      await operations.uninstallKeepData(packageName);
    } catch (error) {
      return restoreAndThrow(operations, token, removedPackages, error);
    }
  }

  let retry: ProviderInstallResponse;
  try {
    retry = parseProviderInstallResponse(await operations.retryInstall(token));
  } catch (error) {
    return restoreAndThrow(operations, token, removedPackages, error);
  }

  try {
    const installedPackages = requireAcceptedPackages(retry, options);
    if (
      retry.kind !== "accepted" ||
      !sameSet(retry.replacementPackages, initial.packageNames)
    ) {
      throw new Error(
        "Device Installer accepted response did not prove every approved replacement.",
      );
    }
    return {
      installedPackages: [...installedPackages],
      updatedPackages: [...initial.packageNames],
    };
  } catch (error) {
    return restoreAndThrow(operations, token, removedPackages, error);
  }
}
