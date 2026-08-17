/*
 * Behavioural guards for `@/lib/pin-install`, the installer brain that mutates a
 * wearer's Ai Pin over ADB from the browser.
 *
 * This is the one area of Center where a bug uninstalls someone's packages. The
 * pipelines are pure and injectable — every device call goes through an
 * `internals` seam — so the dangerous decisions can be pinned without hardware,
 * and this file is where they are pinned: it is the only behavioural coverage
 * `src/lib/pin-install` has. These guards were written against the standalone
 * `pin/setup` Vite SPA the installer was ported from; the SPA is gone, its
 * vitest suite with it, so the properties live here now on `node --test`.
 *
 * What each group catches:
 *
 *   createInstallPlan     — a healthy legacy installer is RETAINED, never
 *                           reinstalled, and a mismatched-but-healthy installer
 *                           is never quietly promoted into the destructive
 *                           bootstrap-recovery path. Recovery itself demands a
 *                           second, explicit confirmation.
 *   runInstallOperation   — unsupported device state fails closed BEFORE any
 *                           download or device write; rollback is offered only
 *                           once the device has actually been mutated, so the
 *                           UI never invites a wearer to "roll back" a device
 *                           nothing was written to.
 *   runRemoveConflicts    — a package that survives its own uninstall is a
 *                           failure, not a warning; a wedged device times out
 *                           instead of hanging.
 *   runRollback/Uninstall — cleanup → restore → verify runs in that order, and
 *                           a verification failure fails the operation.
 *   deriveInstallController— the primary action is disabled unless the device
 *                           proved its credential-encrypted storage is
 *                           available; a failed inspection drops the trusted
 *                           release target rather than reusing a stale one.
 *   derivePrimaryCardView  — the lock warning and detected conflicts reach the
 *                           card the wearer actually reads.
 *
 * The fakes matter as much as the assertions. Every transport method that would
 * reach real hardware throws, so a call that escapes the injected internals
 * surfaces as a test failure rather than being silently absorbed.
 */

// Static, so the resolve hook is registered before the dynamic imports below:
// `src/` spells its imports the way a bundler resolves them (extensionless
// siblings, `@/lib/...` aliases, barrel directories) and Node does not.
import "./tsResolve.mjs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// The installer's public surface. The `?query` gives this test its own instance
// of the barrel; the modules it re-exports are reached by plain relative
// specifiers, so ops/state/presentation still share one graph — which is what
// makes `InstallPlanningError` here the same class `createInstallPlan` throws.
const {
  DEFAULT_POST_INSTALL_LINK,
  InstallPlanningError,
  LEGACY_MIGRATION_PROFILE,
  MANAGED_PACKAGES,
  createInitialInstallControllerState,
  createInstallPlan,
  deriveInstallControllerCommands,
  derivePrimaryCardViewModel,
  installControllerReducer,
  lockResolvedInstallTarget,
  runInstallOperation,
  runRemoveConflictsOperation,
  runRollbackOperation,
  runUninstallOperation,
} = await import("../src/lib/pin-install/index.ts?pin-install-ops-test");

// Neither of these is on the barrel: `releases/testFixtures.ts` is test-only,
// and `device.ts` is the deliberately-internal seam onto `@/lib/pin-device`.
// Both are imported without a query so they are the same instances the ops
// modules themselves see.
const { createResolvedInstallTargetFixture } = await import(
  "../src/lib/pin-install/releases/testFixtures.ts"
);
const { AdbDeviceStepTimeoutError } = await import("../src/lib/pin-install/device.ts");

/**
 * A device that answers identity questions and refuses everything else.
 *
 * The pipelines wrap whatever they are handed in `createTimedAdbSessionTransport`
 * and then only touch it through their injected internals, so every method here
 * that would talk to hardware is a tripwire.
 */
function createFakeTransport(name = "Fake Ai Pin") {
  const notImplemented = async () => {
    throw new Error("not implemented");
  };
  const connectionInfo = { serial: "serial-1", name };
  return {
    connectionInfo,
    async connect() {
      return connectionInfo;
    },
    async reconnect() {
      return connectionInfo;
    },
    async disconnect() {},
    shell: notImplemented,
    shellWithInput: notImplemented,
    pushFile: notImplemented,
    reboot: notImplemented,
    openPty: notImplemented,
    startCommandStream: notImplemented,
  };
}

/**
 * A recording stand-in. `calls` holds the argument list of every invocation, and
 * `implementation` is reassignable so a test can make one step reject or take
 * over mid-pipeline after the rest of the harness is already built.
 */
function spy(implementation = async () => undefined) {
  const fn = (...args) => {
    fn.calls.push(args);
    return fn.implementation(...args);
  };
  fn.calls = [];
  fn.implementation = implementation;
  return fn;
}

const lastEvent = (progress) => progress.calls.at(-1)?.[0];

function assertCompletedPhase(event, phase) {
  assert.equal(event.phase, phase);
  assert.equal(event.overallPercent, 100);
  assert.equal(event.phasePercent, 100);
}

/* ------------------------------------------------------------------ *
 * install: planning and the mutation pipeline
 * ------------------------------------------------------------------ */

const PACKAGE_BY_ROLE = Object.freeze({
  installer: MANAGED_PACKAGES.installer,
  hook: MANAGED_PACKAGES.hook,
  server: MANAGED_PACKAGES.server,
  injector: MANAGED_PACKAGES.injector,
});

const MANAGED_ROLES = ["installer", "hook", "server", "injector"];

/**
 * One healthy managed package as inspection reports it. The version names come
 * from `LEGACY_MIGRATION_PROFILE`, so the default inspection describes exactly
 * the legacy device the first canonical migration exists to serve.
 */
function packageSnapshot(role, target, overrides = {}) {
  const versionName = LEGACY_MIGRATION_PROFILE.versions[role];
  const packageName = PACKAGE_BY_ROLE[role];
  return {
    role,
    packageName,
    installed: true,
    healthy: true,
    versionName,
    signerIdentity: LEGACY_MIGRATION_PROFILE.signerIdentity,
    versionReadable: true,
    querySucceeded: true,
    rawOutput: `versionName=${versionName}`,
    targetVersion: target.version,
    versionComparison: "unreadable",
    // See the same defaults in verify/pin-install-domain.test.mjs: the legacy
    // device this describes runs every managed package from the path the system
    // injector owns, which is what makes an in-place update possible at all.
    appId: 1000,
    baseApkPath: `/data/app/${packageName}-injected/base.apk`,
    keepDataUpdateVerdict: "eligible",
    ...overrides,
  };
}

function createInspection(options = {}) {
  const target = options.target ?? createResolvedInstallTargetFixture();
  const packages = Object.fromEntries(
    MANAGED_ROLES.map((role) => [
      role,
      packageSnapshot(role, target, options.packageOverrides?.[role]),
    ]),
  );
  return {
    device: {
      manufacturer: "Humane",
      model: "Ai Pin",
      product: "mako",
      buildFingerprint: "humane/test",
      recognizedAiPin: true,
    },
    target,
    targetResolutionFailed: false,
    targetResolutionErrorMessage: null,
    helperPresentUnexpectedly: false,
    readiness: {
      packageQueryabilityOk: true,
      settleDelayMs: 0,
      packageResults: [],
      credentialState: { state: "unlocked", ceAvailableRaw: "1" },
    },
    packages,
    detectedConflicts: [],
    hasDetectedConflicts: false,
    actionState: {
      action: options.action ?? "Update",
      warnings: { newerThanTarget: false, unreadableVersion: true },
      reasons: [],
    },
    installActionsBlocked: false,
    installActionsBlockedReason: null,
  };
}

/** Every device-touching step of the install pipeline, stubbed and recorded. */
function createInternals(target, inspection) {
  return {
    downloadInstallTargetAssets: spy(async () => ({
      target,
      installerApk: new Blob(["installer"]),
      exploitApk: new Blob(["bootstrap"]),
      hookApk: new Blob(["hook"]),
      serverApk: new Blob(["server"]),
      injectorApk: new Blob(["injector"]),
    })),
    runPreinstallCleanupCommand: spy(async () => ({ success: true, message: "ok" })),
    cleanupManagedPackages: spy(),
    bootstrapFinalInstaller: spy(),
    installManagedPackages: spy(),
    disableConfiguredPackages: spy(async () => []),
    setHomeActivity: spy(),
    verifyInstalledManagedState: spy(async () => inspection),
  };
}

describe("createInstallPlan", () => {
  it("retains the healthy legacy installer and selects only runtime artifacts", () => {
    const target = createResolvedInstallTargetFixture();
    const plan = createInstallPlan({
      transport: createFakeTransport(),
      target,
      inspection: createInspection({ target }),
    });

    assert.equal(plan.kind, "legacy-in-place");
    assert.deepEqual(plan.assetRoles, ["hookApk", "serverApk", "injectorApk"]);
    assert.deepEqual(plan.packageRoles, ["hook", "server", "injector"]);
    assert.deepEqual(plan.expectedExistingPackageNames, [
      MANAGED_PACKAGES.hook,
      MANAGED_PACKAGES.server,
      MANAGED_PACKAGES.injector,
    ]);
    // The installer is the package that grants the privilege everything else is
    // installed with. Touching it is the one irreversible step, so a healthy one
    // is carried through untouched.
    assert.equal(plan.shouldCleanupManagedPackages, false);
    assert.equal(plan.shouldBootstrapInstaller, false);
    assert.equal(
      plan.retainedInstaller?.versionName,
      LEGACY_MIGRATION_PROFILE.versions.installer,
    );
  });

  it("never promotes a healthy installer mismatch into bootstrap recovery", () => {
    const target = createResolvedInstallTargetFixture();
    // Confirmation is granted here on purpose: an operator who has agreed to
    // recovery must still not get recovery for a device whose installer signer
    // is simply unrecognised. That is a blocked device, not a broken one.
    assert.throws(
      () =>
        createInstallPlan({
          transport: createFakeTransport(),
          target,
          inspection: createInspection({
            target,
            packageOverrides: { installer: { signerIdentity: "aaaaaaaa" } },
          }),
          bootstrapRecoveryConfirmed: true,
        }),
      (error) => error instanceof InstallPlanningError && error.code === "blocked",
    );
  });

  it("keeps canonical routine reinstalls on the installed provider", () => {
    const target = createResolvedInstallTargetFixture();
    const canonical = Object.fromEntries(
      MANAGED_ROLES.map((role) => [
        role,
        { versionName: target.version, versionComparison: "equal" },
      ]),
    );
    const plan = createInstallPlan({
      transport: createFakeTransport(),
      target,
      inspection: createInspection({
        target,
        action: "Reinstall",
        packageOverrides: canonical,
      }),
    });

    assert.equal(plan.kind, "routine-in-place");
    assert.deepEqual(plan.assetRoles, ["hookApk", "serverApk", "injectorApk"]);
    assert.equal(plan.shouldRunPreinstallCleanup, false);
    assert.equal(plan.shouldCleanupManagedPackages, false);
    assert.equal(plan.shouldBootstrapInstaller, false);
  });

  it("requires separate confirmation before a missing installer recovery plan", () => {
    const target = createResolvedInstallTargetFixture();
    const inspection = createInspection({
      target,
      packageOverrides: {
        installer: {
          installed: false,
          healthy: false,
          versionName: null,
          signerIdentity: null,
          versionReadable: false,
          querySucceeded: false,
          rawOutput: null,
          versionComparison: null,
        },
      },
    });

    assert.throws(
      () =>
        createInstallPlan({
          transport: createFakeTransport(),
          target,
          inspection,
        }),
      /separate explicit confirmation/,
    );

    const plan = createInstallPlan({
      transport: createFakeTransport(),
      target,
      inspection,
      bootstrapRecoveryConfirmed: true,
    });
    assert.equal(plan.kind, "bootstrap-recovery");
    assert.deepEqual(plan.assetRoles, [
      "installerApk",
      "exploitApk",
      "hookApk",
      "serverApk",
      "injectorApk",
    ]);
    assert.equal(plan.shouldCleanupManagedPackages, true);
    assert.equal(plan.shouldBootstrapInstaller, true);
  });
});

describe("runInstallOperation", () => {
  it("migrates the exact legacy profile without cleanup or installer bootstrap", async () => {
    const target = createResolvedInstallTargetFixture();
    const inspection = createInspection({ target });
    const internals = createInternals(target, inspection);

    const result = await runInstallOperation(
      { transport: createFakeTransport(), target, inspection },
      internals,
    );

    assert.equal(result.success, true);

    const [downloadTarget, downloadOptions] =
      internals.downloadInstallTargetAssets.calls[0];
    assert.equal(downloadTarget, target);
    assert.deepEqual(downloadOptions.assetRoles, [
      "hookApk",
      "serverApk",
      "injectorApk",
    ]);

    // Nothing is removed, nothing is re-privileged, no launcher or vendor
    // package is touched: a legacy migration is additive.
    assert.equal(internals.cleanupManagedPackages.calls.length, 0);
    assert.equal(internals.bootstrapFinalInstaller.calls.length, 0);
    assert.equal(internals.disableConfiguredPackages.calls.length, 0);
    assert.equal(internals.setHomeActivity.calls.length, 0);

    const [, , installOptions] = internals.installManagedPackages.calls[0];
    assert.deepEqual(installOptions.roles, ["hook", "server", "injector"]);
    assert.deepEqual(installOptions.expectedExistingPackageNames, [
      MANAGED_PACKAGES.hook,
      MANAGED_PACKAGES.server,
      MANAGED_PACKAGES.injector,
    ]);

    const [, verifyTarget, policy] = internals.verifyInstalledManagedState.calls[0];
    assert.equal(verifyTarget, target);
    assert.equal(policy.mode, "in-place");
    assert.equal(
      policy.retainedInstaller?.versionName,
      LEGACY_MIGRATION_PROFILE.versions.installer,
    );
  });

  it("fails closed before downloads or device work for unsupported state", async () => {
    const target = createResolvedInstallTargetFixture();
    const inspection = createInspection({
      target,
      packageOverrides: { server: { versionName: "unknown-build" } },
    });
    const internals = createInternals(target, inspection);

    const result = await runInstallOperation(
      { transport: createFakeTransport(), target, inspection },
      internals,
    );

    assert.equal(result.success, false);
    // `failedPhase` is null because no phase ever started: planning refused.
    assert.equal(result.failedPhase, null);
    assert.equal(result.rollbackAvailable, false);
    assert.equal(internals.downloadInstallTargetAssets.calls.length, 0);
    assert.equal(internals.installManagedPackages.calls.length, 0);
  });

  it("does no work when bootstrap recovery has not been separately confirmed", async () => {
    const target = createResolvedInstallTargetFixture();
    const inspection = createInspection({
      target,
      packageOverrides: {
        installer: {
          installed: false,
          healthy: false,
          versionName: null,
          signerIdentity: null,
        },
      },
    });
    const internals = createInternals(target, inspection);

    const result = await runInstallOperation(
      { transport: createFakeTransport(), target, inspection },
      internals,
    );

    assert.match(result.error?.message ?? "", /separate explicit confirmation/);
    assert.equal(result.rollbackAvailable, false);
    assert.equal(internals.downloadInstallTargetAssets.calls.length, 0);
    assert.equal(internals.cleanupManagedPackages.calls.length, 0);
  });

  it("uses full bootstrap only for separately confirmed missing-installer recovery", async () => {
    const target = createResolvedInstallTargetFixture();
    const inspection = createInspection({
      target,
      packageOverrides: {
        installer: {
          installed: false,
          healthy: false,
          versionName: null,
          signerIdentity: null,
        },
      },
    });
    const internals = createInternals(target, inspection);

    const result = await runInstallOperation(
      {
        transport: createFakeTransport(),
        target,
        inspection,
        bootstrapRecoveryConfirmed: true,
      },
      internals,
    );

    assert.equal(result.success, true);
    assert.equal(internals.cleanupManagedPackages.calls.length, 1);
    assert.equal(internals.bootstrapFinalInstaller.calls.length, 1);

    const [, , installOptions] = internals.installManagedPackages.calls[0];
    assert.deepEqual(installOptions.roles, ["hook", "server", "injector"]);
    // Cleanup removed them first, so nothing may be expected to already exist:
    // an "expected existing" package here would let a survivor pass unnoticed.
    assert.deepEqual(installOptions.expectedExistingPackageNames, []);

    const [, , policy] = internals.verifyInstalledManagedState.calls[0];
    assert.equal(policy.mode, "bootstrap-recovery");
  });

  it("does not advertise rollback when asset preflight fails", async () => {
    const target = createResolvedInstallTargetFixture();
    const inspection = createInspection({ target });
    const internals = createInternals(target, inspection);
    internals.downloadInstallTargetAssets.implementation = async () => {
      throw new Error("digest mismatch");
    };

    const result = await runInstallOperation(
      { transport: createFakeTransport(), target, inspection },
      internals,
    );

    assert.equal(result.success, false);
    assert.equal(result.rollbackAvailable, false);
    assert.equal(internals.installManagedPackages.calls.length, 0);
  });

  /*
   * The order of the two phases, not just their outcomes.
   *
   * Bootstrap recovery is the destructive plan: it wipes the managed packages
   * and re-privileges the installer. Every asset it needs is downloaded and
   * digest-checked first, so a release the device cannot actually be given
   * costs the wearer nothing. That ordering is currently correct but was not
   * guarded anywhere — the asset-preflight case above runs a legacy migration,
   * whose plan has no cleanup at all, so it would keep passing if the phases
   * were swapped. This case uses the one plan that does destroy something.
   */
  it("verifies every asset before the destructive phase touches the device", async () => {
    const target = createResolvedInstallTargetFixture();
    const inspection = createInspection({
      target,
      packageOverrides: {
        installer: {
          installed: false,
          healthy: false,
          versionName: null,
          signerIdentity: null,
        },
      },
    });
    const internals = createInternals(target, inspection);
    internals.downloadInstallTargetAssets.implementation = async () => {
      throw new Error("digest mismatch");
    };

    const result = await runInstallOperation(
      {
        transport: createFakeTransport(),
        target,
        inspection,
        bootstrapRecoveryConfirmed: true,
      },
      internals,
    );

    assert.equal(result.success, false);
    // Nothing was removed and nothing was cleared, so there is nothing to roll
    // back: the device is exactly as the wearer handed it over.
    assert.equal(internals.runPreinstallCleanupCommand.calls.length, 0);
    assert.equal(internals.cleanupManagedPackages.calls.length, 0);
    assert.equal(result.rollbackAvailable, false);
  });

  it("does not advertise rollback when provider capability preflight fails", async () => {
    const target = createResolvedInstallTargetFixture();
    const inspection = createInspection({ target });
    const internals = createInternals(target, inspection);
    // Rejecting without ever calling `onMutationStart` is how the install
    // provider reports it refused before writing anything.
    internals.installManagedPackages.implementation = async () => {
      throw new Error("safe provider capability missing");
    };

    const result = await runInstallOperation(
      { transport: createFakeTransport(), target, inspection },
      internals,
    );

    assert.equal(result.success, false);
    assert.equal(result.failedPhase, "Install");
    assert.equal(result.rollbackAvailable, false);
  });

  it("marks mutation as started only when the in-place provider install begins", async () => {
    const target = createResolvedInstallTargetFixture();
    const inspection = createInspection({ target });
    const internals = createInternals(target, inspection);
    internals.installManagedPackages.implementation = async (
      _transport,
      _assets,
      options,
    ) => {
      options?.onMutationStart?.();
      throw new Error("provider retry failed");
    };

    const result = await runInstallOperation(
      { transport: createFakeTransport(), target, inspection },
      internals,
    );

    assert.equal(result.success, false);
    assert.equal(result.failedPhase, "Install");
    // The device was written to, so rollback is a real option — the mirror of
    // the two preflight cases above.
    assert.equal(result.rollbackAvailable, true);
  });
});

/* ------------------------------------------------------------------ *
 * removeConflicts: taking known-hostile packages off the device
 * ------------------------------------------------------------------ */

function createConflict(overrides = {}) {
  return {
    id: "legacy-suite",
    label: "Legacy Suite",
    packageIds: ["one.pkg", "two.pkg"],
    installedPackageIds: ["one.pkg", "two.pkg"],
    warningCopy: "Legacy suite may interfere.",
    cleanupCommands: [],
    ...overrides,
  };
}

const LEGACY_DATA_CLEANUP = Object.freeze({
  argv: ["pm", "clear", "legacy.data"],
  description: "Clear legacy data",
});

describe("runRemoveConflictsOperation", () => {
  it("removes detected package IDs and runs group cleanup commands", async () => {
    const calls = [];
    const progress = spy();
    const installed = new Set(["one.pkg", "two.pkg"]);

    const result = await runRemoveConflictsOperation(
      {
        transport: createFakeTransport("Fake Device"),
        conflicts: [createConflict({ cleanupCommands: [LEGACY_DATA_CLEANUP] })],
        onProgress: progress,
      },
      {
        async uninstallPackage(_transport, packageId) {
          calls.push(`uninstall:${packageId}`);
          installed.delete(packageId);
        },
        async packageExists(_transport, packageId) {
          calls.push(`exists:${packageId}`);
          return installed.has(packageId);
        },
        async runCleanupCommand(_transport, command) {
          calls.push(`cleanup:${command.argv.join(" ")}`);
          return { success: true, message: "ok" };
        },
      },
    );

    // Each removal is confirmed against the device before the next one starts.
    assert.deepEqual(calls, [
      "uninstall:one.pkg",
      "exists:one.pkg",
      "uninstall:two.pkg",
      "exists:two.pkg",
      "cleanup:pm clear legacy.data",
    ]);
    assert.equal(result.success, true);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.removedPackageIds, ["one.pkg", "two.pkg"]);
    assertCompletedPhase(lastEvent(progress), "Cleanup");
  });

  it("returns failure when a package is still present after uninstall", async () => {
    const result = await runRemoveConflictsOperation(
      {
        transport: createFakeTransport("Fake Device"),
        conflicts: [createConflict({ installedPackageIds: ["stuck.pkg"] })],
      },
      {
        async uninstallPackage() {},
        async packageExists() {
          return true;
        },
        async runCleanupCommand() {
          return { success: true, message: "ok" };
        },
      },
    );

    // A silent uninstall failure would leave the install path believing the
    // conflict is gone, so a surviving package fails the whole operation.
    assert.equal(result.success, false);
    assert.match(result.error?.message ?? "", /stuck\.pkg/);
  });

  it("continues with warnings when a cleanup command fails", async () => {
    const result = await runRemoveConflictsOperation(
      {
        transport: createFakeTransport("Fake Device"),
        conflicts: [
          createConflict({
            installedPackageIds: [],
            cleanupCommands: [LEGACY_DATA_CLEANUP],
          }),
        ],
      },
      {
        async uninstallPackage() {},
        async packageExists() {
          return false;
        },
        async runCleanupCommand() {
          return { success: false, message: "clear failed" };
        },
      },
    );

    // Leftover data is untidy, not unsafe: it degrades to a warning.
    assert.equal(result.success, true);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, "conflict-cleanup-command-failed");
    assert.match(result.warnings[0].message, /clear failed/);
  });

  it("returns failure when a device-side cleanup command times out", async () => {
    const result = await runRemoveConflictsOperation(
      {
        transport: createFakeTransport("Fake Device"),
        conflicts: [
          createConflict({
            installedPackageIds: [],
            cleanupCommands: [LEGACY_DATA_CLEANUP],
          }),
        ],
      },
      {
        async uninstallPackage() {},
        async packageExists() {
          return false;
        },
        async runCleanupCommand() {
          throw new AdbDeviceStepTimeoutError("shell pm clear legacy.data");
        },
      },
    );

    // A wedged device is not a warning: the operation stops and says so.
    assert.equal(result.success, false);
    assert.ok(result.error instanceof AdbDeviceStepTimeoutError);
    assert.deepEqual(result.warnings, []);
  });
});

/* ------------------------------------------------------------------ *
 * rollback and uninstall: putting the device back
 * ------------------------------------------------------------------ */

describe("runRollbackOperation", () => {
  it("returns success when cleanup, restore, and verify all succeed", async () => {
    const progress = spy();
    const result = await runRollbackOperation(
      { transport: createFakeTransport("Fake Device"), onProgress: progress },
      {
        async cleanupManagedPackages() {},
        async restoreConfiguredPackages() {
          return [];
        },
        async verifyUninstalledManagedState() {},
      },
    );

    assert.equal(result.success, true);
    assert.equal(result.error, null);
    assertCompletedPhase(lastEvent(progress), "Verify");
  });

  it("returns failure when cleanup or verification fails", async () => {
    const result = await runRollbackOperation(
      { transport: createFakeTransport("Fake Device") },
      {
        async cleanupManagedPackages() {
          throw new Error("cleanup failed");
        },
        async restoreConfiguredPackages() {
          return [];
        },
        async verifyUninstalledManagedState() {},
      },
    );

    assert.equal(result.success, false);
    assert.match(result.error?.message ?? "", /cleanup failed/);
  });

  it("returns failure when a device-side rollback step times out", async () => {
    const result = await runRollbackOperation(
      { transport: createFakeTransport("Fake Device") },
      {
        async cleanupManagedPackages() {},
        async restoreConfiguredPackages() {
          throw new AdbDeviceStepTimeoutError("shell pm enable --user 0 humane.ota");
        },
        async verifyUninstalledManagedState() {},
      },
    );

    assert.equal(result.success, false);
    assert.ok(result.error instanceof AdbDeviceStepTimeoutError);
    // The bound is part of the contract: the wearer is told how long the step
    // was given, not left with a bare "failed".
    assert.match(result.error.message, /60000ms/);
  });
});

describe("runUninstallOperation", () => {
  it("runs cleanup, restore, and verify in order", async () => {
    const calls = [];
    const progress = spy();
    const result = await runUninstallOperation(
      { transport: createFakeTransport("Fake Device"), onProgress: progress },
      {
        async cleanupManagedPackages() {
          calls.push("cleanup");
        },
        async restoreConfiguredPackages() {
          calls.push("restore");
          return [
            {
              code: "restore-failed",
              packageName: "humane.ota",
              message: "enable failed",
            },
          ];
        },
        async verifyUninstalledManagedState() {
          calls.push("verify");
        },
      },
    );

    // Order is load-bearing: managed packages come off before stock packages go
    // back on, and only then is the end state verified.
    assert.deepEqual(calls, ["cleanup", "restore", "verify"]);
    // A package that could not be re-enabled is reported, not fatal.
    assert.equal(result.success, true);
    assert.equal(result.warnings.length, 1);
    assertCompletedPhase(lastEvent(progress), "Verify");
  });

  it("returns failure when verification fails", async () => {
    const result = await runUninstallOperation(
      { transport: createFakeTransport("Fake Device") },
      {
        async cleanupManagedPackages() {},
        async restoreConfiguredPackages() {
          return [];
        },
        async verifyUninstalledManagedState() {
          throw new Error("package still present");
        },
      },
    );

    assert.equal(result.success, false);
    assert.match(result.error?.message ?? "", /package still present/);
  });

  it("returns failure when a device-side uninstall step times out", async () => {
    const result = await runUninstallOperation(
      { transport: createFakeTransport("Fake Device") },
      {
        async cleanupManagedPackages() {
          throw new AdbDeviceStepTimeoutError("shell pm uninstall com.penumbraos.server");
        },
        async restoreConfiguredPackages() {
          return [];
        },
        async verifyUninstalledManagedState() {},
      },
    );

    assert.equal(result.success, false);
    assert.ok(result.error instanceof AdbDeviceStepTimeoutError);
    assert.match(result.error.message, /60000ms/);
  });
});

/* ------------------------------------------------------------------ *
 * app/state and presentation: what the wearer is allowed to press
 * ------------------------------------------------------------------ */

const browserSupport = Object.freeze({
  supported: true,
  reasons: [],
  details: { secureContext: true, webUsb: true },
});

function controllerPackage(role, packageName, versionName) {
  return {
    role,
    packageName,
    installed: true,
    healthy: true,
    versionName,
    signerIdentity: "dd07f452",
    versionReadable: true,
    querySucceeded: true,
    rawOutput: `versionName=${versionName}`,
    targetVersion: versionName,
    versionComparison: "equal",
  };
}

/**
 * A device that is fully up to date and whose credential-encrypted storage state
 * is UNKNOWN — the interesting default, because "unknown" is the state the
 * commands must refuse on.
 */
function createControllerInspection(overrides = {}) {
  const { credentialState, ...rest } = overrides;
  return {
    device: {
      manufacturer: "Humane",
      model: "Ai Pin",
      product: "mako",
      buildFingerprint: "humane/test",
      recognizedAiPin: true,
    },
    target: null,
    targetResolutionFailed: false,
    targetResolutionErrorMessage: null,
    helperPresentUnexpectedly: false,
    readiness: {
      packageQueryabilityOk: true,
      settleDelayMs: 0,
      packageResults: [],
      credentialState: credentialState ?? { state: "unknown", ceAvailableRaw: null },
    },
    packages: {
      installer: controllerPackage(
        "installer",
        "com.penumbraos.systeminjector",
        "2026-04-29.0",
      ),
      hook: controllerPackage("hook", "com.penumbraos.hook", "2026-04-29.1"),
      server: controllerPackage("server", "com.penumbraos.server", "2026-04-29.1"),
      injector: controllerPackage(
        "injector",
        "com.penumbraos.hook.injector",
        "2026-04-29.1",
      ),
    },
    detectedConflicts: [],
    hasDetectedConflicts: false,
    actionState: {
      action: "Reinstall",
      warnings: { newerThanTarget: false, unreadableVersion: false },
      reasons: ["All managed packages match the selected target."],
    },
    installActionsBlocked: false,
    installActionsBlockedReason: null,
    ...rest,
  };
}

function createControllerState(overrides = {}) {
  return {
    ...createInitialInstallControllerState(browserSupport),
    stage: "connected-idle",
    connection: { serial: "serial-1", name: "Fake Device" },
    inspection: createControllerInspection(),
    target: null,
    targetLock: null,
    isBusy: false,
    error: null,
    lastOperationResult: null,
    progressEntries: [],
    currentProgress: null,
    ...overrides,
  };
}

const LOCKED_DEVICE_COPY = `Device is locked. Unlock the device, then press "Start Over".`;

describe("deriveInstallControllerCommands", () => {
  it("disables the primary action when CE availability is not confirmed", () => {
    const commands = deriveInstallControllerCommands(
      createControllerState({
        inspection: createControllerInspection({
          credentialState: { state: "locked", ceAvailableRaw: null },
        }),
      }),
    );

    assert.equal(commands.primaryAction.disabled, true);
    assert.equal(commands.primaryAction.reason, LOCKED_DEVICE_COPY);
  });

  it("fails closed when CE availability is unknown", () => {
    // Not "locked" — simply unproven. Installing against a device whose CE
    // storage never came up writes packages that cannot read their own data, so
    // an unreadable answer is treated exactly like a refusal.
    const commands = deriveInstallControllerCommands(createControllerState());

    assert.equal(commands.primaryAction.disabled, true);
    assert.match(
      commands.primaryAction.reason ?? "",
      /could not confirm credential-encrypted storage/,
    );
  });

  it("shows remove-conflicts action when known conflicts are detected", () => {
    const commands = deriveInstallControllerCommands(
      createControllerState({
        inspection: createControllerInspection({
          detectedConflicts: [
            {
              id: "legacy-suite",
              label: "Legacy Suite",
              packageIds: ["conflict.one"],
              installedPackageIds: ["conflict.one"],
              warningCopy: "Legacy suite may interfere.",
              cleanupCommands: [],
            },
          ],
          hasDetectedConflicts: true,
        }),
      }),
    );

    assert.equal(commands.removeConflicts.visible, true);
    assert.equal(commands.removeConflicts.disabled, false);
    assert.equal(commands.removeConflicts.label, "Review and Remove Conflicts");
  });

  it("disables remove-conflicts action when device is disconnected", () => {
    const commands = deriveInstallControllerCommands(
      createControllerState({
        connection: null,
        inspection: createControllerInspection({
          detectedConflicts: [
            {
              id: "legacy-suite",
              label: "Legacy Suite",
              packageIds: ["conflict.one"],
              installedPackageIds: ["conflict.one"],
              warningCopy: "Legacy suite may interfere.",
              cleanupCommands: [],
            },
          ],
          hasDetectedConflicts: true,
        }),
      }),
    );

    // Still visible, so the wearer can see there is something to fix; disabled,
    // because there is nothing to run it against.
    assert.equal(commands.removeConflicts.visible, true);
    assert.equal(commands.removeConflicts.disabled, true);
    assert.match(commands.removeConflicts.reason ?? "", /Connect a device/);
  });

  it("shows recheck after successful conflict removal", () => {
    const commands = deriveInstallControllerCommands(
      createControllerState({
        stage: "result",
        lastOperationResult: {
          kind: "remove-conflicts",
          result: {
            success: true,
            warnings: [],
            error: null,
            removedPackageIds: ["conflict.one"],
          },
        },
      }),
    );

    assert.equal(commands.recheck.visible, true);
    assert.equal(commands.recheck.disabled, false);
  });

  /*
   * Not from the SPA suite: the SPA hardcoded its post-install handoff to
   * `/setup/`, which is the one thing about this module Center deliberately
   * changed. `/setup/` does not exist here — verify/public-assets.test.mjs holds
   * Center to shipping no ungated `/setup` — so the destination is a named
   * export with a Center route, overridable by the route layer. Pinned here so
   * the handoff cannot silently drift back to a 404.
   */
  it("hands a completed install off to a route Center actually serves", () => {
    assert.deepEqual({ ...DEFAULT_POST_INSTALL_LINK }, {
      label: "Open Pin settings",
      href: "/settings/pin",
    });

    const completed = createControllerState({
      stage: "result",
      lastOperationResult: {
        kind: "install",
        result: {
          success: true,
          warnings: [],
          inspection: null,
          error: null,
          failedPhase: null,
          rollbackAttempted: false,
          rollbackSucceeded: false,
          rollbackAvailable: false,
        },
      },
    });

    const commands = deriveInstallControllerCommands(completed);
    assert.equal(commands.goToCenter.visible, true);
    assert.equal(commands.goToCenter.href, DEFAULT_POST_INSTALL_LINK.href);
    assert.notEqual(commands.goToCenter.href, "/setup/");

    const retargeted = deriveInstallControllerCommands(completed, {
      postInstallLink: { label: "Open diagnostics", href: "/settings/pin/diagnostics" },
    });
    assert.equal(retargeted.goToCenter.label, "Open diagnostics");
    assert.equal(retargeted.goToCenter.href, "/settings/pin/diagnostics");
  });
});

describe("installControllerReducer", () => {
  it("clears a previously trusted target when a forced inspection fails", () => {
    const target = createResolvedInstallTargetFixture();
    const nextState = installControllerReducer(
      createControllerState({
        target,
        targetLock: lockResolvedInstallTarget(target),
      }),
      {
        type: "inspection-failed",
        connection: { serial: "serial-1", name: "Fake Device" },
        error: "Release manifest unavailable.",
      },
    );

    // A target that was verified against a device state we no longer have is not
    // a target: keeping the lock would let the next action install against a
    // release the current device was never inspected for.
    assert.equal(nextState.inspection, null);
    assert.equal(nextState.target, null);
    assert.equal(nextState.targetLock, null);

    const commands = deriveInstallControllerCommands(nextState);
    assert.equal(commands.primaryAction.disabled, true);
    assert.equal(commands.installApkFile.disabled, true);
  });
});

const VIEW_MODEL_CONFLICT = Object.freeze({
  id: "legacy-suite",
  label: "Legacy Suite",
  packageIds: ["conflict.one", "conflict.two"],
  installedPackageIds: ["conflict.one"],
  warningCopy: "Legacy suite may interfere.",
  cleanupCommands: [{ argv: ["pm", "clear", "conflict.one"], description: "Clear conflict data" }],
});

/** Commands as the card receives them: derivation itself is covered above. */
function createCommands() {
  return {
    connect: { visible: false, label: "Connect Device", disabled: false, reason: null },
    primaryAction: { visible: true, label: "Reinstall", disabled: false, reason: null },
    installApkFile: { visible: true, label: "Install APK File", disabled: false, reason: null },
    rollback: {
      visible: false,
      label: "Rollback Install",
      disabled: false,
      reason: null,
      prominent: false,
    },
    uninstall: { visible: true, label: "Uninstall", disabled: false, reason: null },
    removeConflicts: {
      visible: true,
      label: "Review and Remove Conflicts",
      disabled: false,
      reason: null,
    },
    recheck: { visible: false, label: "Recheck", disabled: false, reason: null, prominent: false },
    startOver: { visible: true, label: "Start Over", disabled: false, reason: null },
    goToCenter: { visible: false, ...DEFAULT_POST_INSTALL_LINK },
  };
}

describe("derivePrimaryCardViewModel", () => {
  it("shows a lock warning when CE availability is not confirmed", () => {
    const viewModel = derivePrimaryCardViewModel(
      createControllerState({
        inspection: createControllerInspection({
          detectedConflicts: [VIEW_MODEL_CONFLICT],
          hasDetectedConflicts: true,
          credentialState: { state: "locked", ceAvailableRaw: null },
        }),
      }),
      createCommands(),
    );

    // The command is disabled either way; this is the sentence that tells the
    // wearer why, on the surface they are looking at.
    assert.deepEqual(viewModel.notice, {
      tone: "warning",
      text: LOCKED_DEVICE_COPY,
    });
  });

  it("surfaces detected conflicts inline with the package rows", () => {
    const viewModel = derivePrimaryCardViewModel(
      createControllerState({
        inspection: createControllerInspection({
          detectedConflicts: [VIEW_MODEL_CONFLICT],
          hasDetectedConflicts: true,
        }),
      }),
      createCommands(),
    );

    assert.equal(viewModel.conflictRows.length, 1);
    const [row] = viewModel.conflictRows;
    assert.equal(row.role, "Legacy Suite");
    assert.equal(row.tone, "warning");
    assert.equal(row.category, "conflict");
    assert.equal(row.badge, "Warning");
    // Two packages are known to the group, one is actually on this device: the
    // row counts what is installed, not what the definition lists.
    assert.equal(row.value, "1 package");
  });
});
