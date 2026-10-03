/*
 * Behavioural guards for `@/lib/pin-install`, the installer brain that mutates a
 * wearer's Ai Pin over ADB from the browser.
 *
 * This is the one area of Center where a bug uninstalls someone's packages. The
 * pipelines are pure and injectable, every device call goes through an
 * `internals` seam, so the dangerous decisions can be pinned without hardware,
 * and this file is where they are pinned: it is the only behavioural coverage
 * `src/lib/pin-install` has. These guards were written against the standalone
 * `pin/setup` Vite SPA the installer was ported from. The SPA is gone, its
 * vitest suite with it, so the properties live here now on `bun test`.
 *
 * What each group catches:
 *
 *   createInstallPlan, a healthy previous installer is RETAINED, never
 *                           reinstalled, and a mismatched-but-healthy installer
 *                           is never quietly promoted into the destructive
 *                           bootstrap-recovery path. Recovery itself demands a
 *                           second, explicit confirmation.
 *   runInstallOperation, unsupported device state fails closed BEFORE any
 *                           download or device write, and records whether any
 *                           device change actually started.
 *   runRemoveConflicts, a package that survives its own uninstall is a
 *                           failure, not a warning. The stock launcher goes
 *                           back on BEFORE the per-suite reboot commands, and
 *                           the op does not return until the Pin has finished
 *                           starting. A wedged device times out instead of
 *                           hanging.
 *   runRemovePackages, the confirmed-packages removal reuses the conflict
 *                           flow's survive-own-uninstall rule.
 *   runUninstall, deactivate → cleanup → restore → verify runs in that
 *                           order, an identity refusal degrades to a warning,
 *                           and a verification failure fails the operation.
 *   deriveInstallController, the primary action is disabled unless the device
 *                           proved its credential-encrypted storage is
 *                           available. A failed inspection drops the trusted
 *                           release target rather than reusing a stale one.
 *   derivePrimaryCardView, the lock warning and detected conflicts reach the
 *                           card the wearer actually reads.
 *
 * The fakes matter as much as the assertions. Every transport method that would
 * reach real hardware throws, so a call that escapes the injected internals
 * surfaces as a test failure rather than being silently absorbed.
 */

// Static, so the resolve hook is registered before the dynamic imports below:
// `src/` spells its imports the way a bundler resolves them (extensionless
// siblings, `@/lib/...` aliases, barrel directories) and Node does not.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  deviceShell,
  fakeDevice,
  packageDump,
} from "./fixtures/fake-pin-device.mjs";

// The installer's public surface. The `?query` gives this test its own instance
// of the barrel. The modules it re-exports are reached by plain relative
// specifiers, so ops/state/presentation still share one graph, which is what
// makes `InstallPlanningError` here the same class `createInstallPlan` throws.
const {
  DEFAULT_POST_INSTALL_LINK,
  InstallPlanningError,
  PIN_RELEASE_SIGNER_IDENTITY,
  MANAGED_PACKAGES,
  createInitialInstallControllerState,
  createInstallPlan,
  deriveInstallControllerCommands,
  derivePrimaryCardViewModel,
  installControllerReducer,
  inspectionIsFirstInstall,
  lockResolvedInstallTarget,
  runInstallOperation,
  runRemoveConflictsOperation,
  runRemovePackagesOperation,
  runUninstallOperation,
} = await import("../src/lib/pin-install/index.ts?pin-install-ops-test");

// Neither of these is on the barrel: `releases/testFixtures.ts` is test-only,
// and `device.ts` is the deliberately-internal seam onto `@/lib/pin-device`.
// Both are imported without a query so they are the same instances the ops
// modules themselves see.
const { createResolvedInstallTargetFixture } = await import(
  "../src/lib/pin-install/releases/testFixtures.ts"
);
const { AdbDeviceStepTimeoutError, waitForPackageManagerReady } = await import(
  "../src/lib/pin-install/device.ts"
);
const { PackageServiceNotReadyError } = await import(
  "../src/lib/pin-device/adb/systemInstaller.ts"
);
const { verifyInstalledManagedState } = await import(
  "../src/lib/pin-install/ops/shared.ts"
);
const { PREINSTALL_CLEANUP_COMMANDS } = await import(
  "../src/lib/pin-install/domain/knownPackageConflicts.ts"
);
const installControllerSource = await readFile(
  new URL(
    "../src/app/settings/pin/install/useInstallController.ts",
    import.meta.url,
  ),
  "utf8",
);

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
  loader: MANAGED_PACKAGES.loader,
});

const MANAGED_ROLES = ["installer", "hook", "server", "loader"];

const EXISTING_RELEASE_VERSION = "2026-04-28.0";

/** One healthy managed package from the previous published release. */
function packageSnapshot(role, target, overrides = {}) {
  const versionName = EXISTING_RELEASE_VERSION;
  const packageName = PACKAGE_BY_ROLE[role];
  return {
    role,
    packageName,
    installed: true,
    healthy: true,
    versionName,
    signerIdentity: PIN_RELEASE_SIGNER_IDENTITY,
    versionReadable: true,
    querySucceeded: true,
    rawOutput: `versionName=${versionName}`,
    targetVersion: target.version,
    versionComparison: "older",
    // See the same defaults in verify/pin-install-domain.test.mjs: the device
    // runs every managed package from the path the system
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
    helperPresentUnexpectedly: options.helperPresent ?? false,
    readiness: {
      packageQueryabilityOk: true,
      settleDelayMs: 0,
      packageResults: [],
      credentialState: { state: "unlocked", ceAvailableRaw: "1" },
    },
    packages,
    detectedConflicts: [],
    hasDetectedConflicts: false,
    unrecognizedPackages: [],
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
      bootstrapApk: new Blob(["bootstrap"]),
      hookApk: new Blob(["hook"]),
      serverApk: new Blob(["server"]),
      loaderApk: new Blob(["loader"]),
    })),
    inspectInstallStateAfterPackageManagerReady: spy(async () => inspection),
    waitForPackageManagerReady: spy(),
    assertPackageManagerReady: spy(),
    runPreinstallCleanupCommand: spy(async () => ({ success: true, message: "ok" })),
    cleanupManagedPackages: spy(),
    uninstallLeftoverHelper: spy(),
    bootstrapFinalInstaller: spy(),
    installManagedPackages: spy(),
    disableConfiguredPackages: spy(async () => []),
    setHomeActivity: spy(),
    verifyInstalledManagedState: spy(async () => inspection),
  };
}

describe("createInstallPlan", () => {
  it("retains a healthy release installer and selects only runtime artifacts", () => {
    const target = createResolvedInstallTargetFixture();
    const plan = createInstallPlan({
      transport: createFakeTransport(),
      target,
      inspection: createInspection({ target }),
    });

    assert.equal(plan.kind, "routine-in-place");
    assert.deepEqual(plan.packageRoles, ["hook", "server", "loader"]);
    assert.deepEqual(plan.requiredAssetRoles, [
      "hookApk",
      "serverApk",
      "loaderApk",
    ]);
    assert.deepEqual(plan.expectedExistingPackageNames, [
      MANAGED_PACKAGES.hook,
      MANAGED_PACKAGES.server,
      MANAGED_PACKAGES.loader,
    ]);
    // The installer is the package that grants the privilege everything else is
    // installed with. Touching it is the one irreversible step, so a healthy one
    // is carried through untouched.
    assert.equal(plan.shouldCleanupManagedPackages, false);
    assert.equal(plan.shouldBootstrapInstaller, false);
    assert.equal(
      plan.retainedInstaller?.versionName,
      EXISTING_RELEASE_VERSION,
    );
  });

  it("never promotes a healthy installer mismatch into bootstrap recovery", () => {
    const target = createResolvedInstallTargetFixture();
    // Confirmation is granted here on purpose: an operator who has agreed to
    // recovery must still not get recovery for a device whose installer signer
    // is unrecognised WHILE other roles stay Luma-signed. A mixed set is a
    // blocked device, not a broken one.
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

  /*
   * The wholly foreign-signed baseline (every installed role carries Luma's
   * package IDs under another key, the CURRENT-generation PenumbraOS shape) is
   * the decision's one new route to recovery, and it holds the same separate
   * explicit confirmation as every other recovery plan.
   */
  it("routes a wholly foreign-signed healthy baseline through confirmed recovery", () => {
    const target = createResolvedInstallTargetFixture();
    const inspection = createInspection({
      target,
      packageOverrides: Object.fromEntries(
        MANAGED_ROLES.map((role) => [role, { signerIdentity: "aaaaaaaa" }]),
      ),
    });

    assert.throws(
      () =>
        createInstallPlan({
          transport: createFakeTransport(),
          target,
          inspection,
        }),
      (error) =>
        error instanceof InstallPlanningError &&
        error.code === "bootstrap-recovery-confirmation-required",
    );

    const plan = createInstallPlan({
      transport: createFakeTransport(),
      target,
      inspection,
      bootstrapRecoveryConfirmed: true,
    });
    assert.equal(plan.kind, "bootstrap-recovery");
    assert.equal(plan.shouldCleanupManagedPackages, true);
    assert.equal(plan.shouldBootstrapInstaller, true);
    assert.equal(plan.retainedInstaller, null);
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
    assert.equal(plan.shouldRunPreinstallCleanup, false);
    assert.equal(plan.shouldCleanupManagedPackages, false);
    assert.equal(plan.shouldBootstrapInstaller, false);
    assert.deepEqual(plan.requiredAssetRoles, [
      "hookApk",
      "serverApk",
      "loaderApk",
    ]);
  });

  it("omits the large Device Services APK when only the Compatibility Layer needs an update", () => {
    const target = createResolvedInstallTargetFixture();
    const plan = createInstallPlan({
      transport: createFakeTransport(),
      target,
      inspection: createInspection({
        target,
        packageOverrides: {
          server: {
            versionName: target.version,
            versionComparison: "equal",
          },
          loader: {
            versionName: target.version,
            versionComparison: "equal",
          },
        },
      }),
    });

    assert.deepEqual(plan.packageRoles, ["hook"]);
    assert.deepEqual(plan.requiredAssetRoles, ["hookApk"]);
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
    assert.equal(plan.shouldCleanupManagedPackages, true);
    assert.equal(plan.shouldBootstrapInstaller, true);
    assert.deepEqual(plan.requiredAssetRoles, [
      "installerApk",
      "bootstrapApk",
      "hookApk",
      "serverApk",
      "loaderApk",
    ]);
  });

  /*
   * A bootstrap that died partway leaves the Setup Helper installed. That alone
   * is not a dead end: a device with nothing else of Luma's reaches the same
   * recovery plan as a stock Pin (its cleanupManagedPackages uninstalls the
   * helper), and the wearer reads it as a first install.
   */
  it("sends a helper-only device to the recovery plan as a first install", () => {
    const target = createResolvedInstallTargetFixture();
    const inspection = createInspection({
      target,
      helperPresent: true,
      packageOverrides: Object.fromEntries(
        MANAGED_ROLES.map((role) => [
          role,
          {
            installed: false,
            healthy: false,
            versionName: null,
            signerIdentity: null,
            versionReadable: false,
            querySucceeded: false,
            rawOutput: null,
            versionComparison: null,
          },
        ]),
      ),
    });

    assert.equal(inspectionIsFirstInstall(inspection), true);

    const plan = createInstallPlan({
      transport: createFakeTransport(),
      target,
      inspection,
      bootstrapRecoveryConfirmed: true,
    });
    assert.equal(plan.kind, "bootstrap-recovery");
    assert.equal(plan.shouldCleanupManagedPackages, true);
    assert.equal(plan.shouldCleanupLeftoverHelper, true);
  });

  it("plans leftover Setup Helper cleanup beside a healthy installer", () => {
    const target = createResolvedInstallTargetFixture();
    const plan = createInstallPlan({
      transport: createFakeTransport(),
      target,
      inspection: createInspection({
        target,
        helperPresent: true,
      }),
    });

    // The installer is healthy, so the plan stays in place; only the helper
    // gains a dedicated removal step.
    assert.equal(plan.kind, "routine-in-place");
    assert.equal(plan.shouldCleanupLeftoverHelper, true);
    assert.equal(plan.shouldCleanupManagedPackages, false);
    assert.equal(plan.shouldBootstrapInstaller, false);
  });
});

describe("runInstallOperation", () => {
  it("migrates the exact previous profile without cleanup or installer bootstrap", async () => {
    const target = createResolvedInstallTargetFixture();
    const inspection = createInspection({ target });
    const internals = createInternals(target, inspection);

    const result = await runInstallOperation(
      { transport: createFakeTransport(), target, inspection },
      internals,
    );

    assert.equal(result.success, true);
    assert.equal(internals.waitForPackageManagerReady.calls.length, 1);
    assert.equal(internals.assertPackageManagerReady.calls.length, 1);
    assert.equal(
      internals.inspectInstallStateAfterPackageManagerReady.calls.length,
      1,
    );

    const [downloadTarget, downloadOptions] =
      internals.downloadInstallTargetAssets.calls[0];
    assert.equal(downloadTarget, target);
    assert.deepEqual(downloadOptions.assetRoles, [
      "hookApk",
      "serverApk",
      "loaderApk",
    ]);

    // Nothing is removed, nothing is re-privileged, no launcher or vendor
    // package is touched: an in-place update is additive.
    assert.equal(internals.cleanupManagedPackages.calls.length, 0);
    assert.equal(internals.bootstrapFinalInstaller.calls.length, 0);
    assert.equal(internals.disableConfiguredPackages.calls.length, 0);
    assert.equal(internals.setHomeActivity.calls.length, 0);

    const [, , installOptions] = internals.installManagedPackages.calls[0];
    assert.deepEqual(installOptions.roles, ["hook", "server", "loader"]);
    assert.deepEqual(installOptions.expectedExistingPackageNames, [
      MANAGED_PACKAGES.hook,
      MANAGED_PACKAGES.server,
      MANAGED_PACKAGES.loader,
    ]);

    const [, verifyTarget, policy] = internals.verifyInstalledManagedState.calls[0];
    assert.equal(verifyTarget, target);
    assert.equal(policy.mode, "in-place");
    assert.equal(
      policy.retainedInstaller?.versionName,
      EXISTING_RELEASE_VERSION,
    );
  });

  it("downloads only the APK selected by the fresh plan", async () => {
    const target = createResolvedInstallTargetFixture();
    const freshInspection = createInspection({
      target,
      packageOverrides: {
        server: {
          versionName: target.version,
          versionComparison: "equal",
        },
        loader: {
          versionName: target.version,
          versionComparison: "equal",
        },
      },
    });
    const internals = createInternals(target, freshInspection);

    const result = await runInstallOperation(
      {
        transport: createFakeTransport(),
        target,
        inspection: createInspection({ target }),
      },
      internals,
    );

    assert.equal(result.success, true);
    const [, downloadOptions] =
      internals.downloadInstallTargetAssets.calls[0];
    assert.deepEqual(downloadOptions.assetRoles, ["hookApk"]);
    assert.equal(downloadOptions.assetRoles.includes("serverApk"), false);
    const [, , installOptions] = internals.installManagedPackages.calls[0];
    assert.deepEqual(installOptions.roles, ["hook"]);
  });

  it("uses one bounded readiness gate through the real verifier", async () => {
    const target = createResolvedInstallTargetFixture();
    const inspection = createInspection({ target });
    const transport = fakeDevice(
      deviceShell({
        "dumpsys package com.penumbraos.systeminjector": packageDump(
          MANAGED_PACKAGES.installer,
          EXISTING_RELEASE_VERSION,
        ),
      }),
    );
    const internals = createInternals(target, inspection);
    internals.waitForPackageManagerReady.implementation =
      waitForPackageManagerReady;
    internals.verifyInstalledManagedState.implementation =
      verifyInstalledManagedState;

    const result = await runInstallOperation(
      { transport, target, inspection },
      internals,
    );

    assert.equal(result.success, true);
    assert.equal(internals.waitForPackageManagerReady.calls.length, 1);
    assert.equal(internals.assertPackageManagerReady.calls.length, 1);
    assert.equal(internals.verifyInstalledManagedState.calls.length, 1);
    assert.equal(
      transport.commands.filter(
        (command) => command === "cmd package path android",
      ).length,
      1,
    );
  });

  it("fails from fresh state before downloads or mutations for unsupported state", async () => {
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
    // The stale UI snapshot is ignored. The post-readiness inspection drives
    // planning and refuses before a large release asset is fetched.
    assert.equal(result.failedPhase, null);
    assert.equal(result.deviceChangesStarted, false);
    assert.equal(
      internals.inspectInstallStateAfterPackageManagerReady.calls.length,
      1,
    );
    assert.equal(internals.waitForPackageManagerReady.calls.length, 1);
    assert.equal(internals.downloadInstallTargetAssets.calls.length, 0);
    assert.equal(internals.assertPackageManagerReady.calls.length, 0);
    assert.equal(internals.installManagedPackages.calls.length, 0);
  });

  it("does no mutation when bootstrap recovery was not separately confirmed", async () => {
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
    assert.equal(result.deviceChangesStarted, false);
    assert.equal(internals.downloadInstallTargetAssets.calls.length, 0);
    assert.equal(internals.waitForPackageManagerReady.calls.length, 1);
    assert.equal(internals.assertPackageManagerReady.calls.length, 0);
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
    const [, downloadOptions] =
      internals.downloadInstallTargetAssets.calls[0];
    assert.deepEqual(downloadOptions.assetRoles, [
      "installerApk",
      "bootstrapApk",
      "hookApk",
      "serverApk",
      "loaderApk",
    ]);

    const [, , installOptions] = internals.installManagedPackages.calls[0];
    assert.deepEqual(installOptions.roles, ["hook", "server", "loader"]);
    // Cleanup removed them first, so nothing may be expected to already exist:
    // an "expected existing" package here would let a survivor pass unnoticed.
    assert.deepEqual(installOptions.expectedExistingPackageNames, []);

    const [, , policy] = internals.verifyInstalledManagedState.calls[0];
    assert.equal(policy.mode, "bootstrap-recovery");
  });

  it("uninstalls a leftover Setup Helper during an in-place install and fails the op when that fails", async () => {
    const target = createResolvedInstallTargetFixture();
    const inspection = createInspection({
      target,
      helperPresent: true,
    });
    const internals = createInternals(target, inspection);

    const result = await runInstallOperation(
      { transport: createFakeTransport(), target, inspection },
      internals,
    );

    // The healthy installer is retained; only the helper gains a removal step.
    assert.equal(result.success, true);
    assert.equal(internals.uninstallLeftoverHelper.calls.length, 1);
    assert.equal(internals.cleanupManagedPackages.calls.length, 0);
    assert.equal(internals.bootstrapFinalInstaller.calls.length, 0);

    const failingInternals = createInternals(target, inspection);
    failingInternals.uninstallLeftoverHelper.implementation = async () => {
      throw new Error("pm uninstall failed");
    };
    const failed = await runInstallOperation(
      { transport: createFakeTransport(), target, inspection },
      failingInternals,
    );

    // Not best-effort: a helper that survives cleanup would fail verification
    // with "still present after installation", so the op stops here.
    assert.equal(failed.success, false);
    assert.equal(failed.failedPhase, "Cleanup");
    assert.equal(failed.deviceChangesStarted, true);
    assert.equal(failingInternals.installManagedPackages.calls.length, 0);
  });

  it("keeps an in-place install additive when no helper is left behind", async () => {
    const target = createResolvedInstallTargetFixture();
    const inspection = createInspection({ target });
    const internals = createInternals(target, inspection);

    const result = await runInstallOperation(
      { transport: createFakeTransport(), target, inspection },
      internals,
    );

    assert.equal(result.success, true);
    assert.equal(internals.uninstallLeftoverHelper.calls.length, 0);
  });

  it("refreshes stale missing-package state after readiness before planning", async () => {
    const target = createResolvedInstallTargetFixture();
    const staleInspection = createInspection({
      target,
      packageOverrides: Object.fromEntries(
        MANAGED_ROLES.map((role) => [
          role,
          {
            installed: false,
            healthy: false,
            versionName: null,
            signerIdentity: null,
          },
        ]),
      ),
    });
    const events = [];
    let packageProbe = 0;
    const transport = createFakeTransport();
    transport.shell = async (command) => {
      const text = Array.isArray(command) ? command.join(" ") : command;
      if (text === "cmd package path android") {
        packageProbe += 1;
        if (packageProbe === 1) {
          events.push("package-unavailable");
          return {
            stdout: "",
            stderr: "cmd: Can't find service: package",
            exitCode: 20,
          };
        }
        events.push("package-ready");
        return {
          stdout: "package:/system/framework/framework-res.apk\n",
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`Unexpected shell command: ${text}`);
    };

    const refreshedInspection = createInspection({ target });
    const internals = createInternals(target, refreshedInspection);
    internals.downloadInstallTargetAssets.implementation = async () => {
      events.push("assets-verified");
      return {
        target,
        installerApk: new Blob(["installer"]),
        bootstrapApk: new Blob(["bootstrap"]),
        hookApk: new Blob(["hook"]),
        serverApk: new Blob(["server"]),
        loaderApk: new Blob(["loader"]),
      };
    };
    internals.inspectInstallStateAfterPackageManagerReady.implementation = async () => {
      events.push("fresh-post-ready-inspection");
      return refreshedInspection;
    };
    internals.waitForPackageManagerReady.implementation = async (device) => {
      await waitForPackageManagerReady(device, 1_000, 0, 0);
      events.push("package-manager-ready");
    };
    internals.assertPackageManagerReady.implementation = async () => {
      events.push("package-manager-still-ready");
    };
    internals.installManagedPackages.implementation = async () => {
      events.push("install-mutation");
    };

    const result = await runInstallOperation(
      {
        transport,
        target,
        inspection: staleInspection,
        bootstrapRecoveryConfirmed: true,
      },
      internals,
    );

    assert.equal(result.success, true);
    assert.deepEqual(events, [
      "package-unavailable",
      "package-ready",
      "package-manager-ready",
      "fresh-post-ready-inspection",
      "assets-verified",
      "package-manager-still-ready",
      "install-mutation",
    ]);
    assert.equal(packageProbe, 2);
    assert.equal(internals.waitForPackageManagerReady.calls.length, 1);
    assert.equal(internals.assertPackageManagerReady.calls.length, 1);
    assert.equal(
      internals.inspectInstallStateAfterPackageManagerReady.calls.length,
      1,
    );
    assert.equal(internals.runPreinstallCleanupCommand.calls.length, 0);
    assert.equal(internals.cleanupManagedPackages.calls.length, 0);
    assert.equal(internals.bootstrapFinalInstaller.calls.length, 0);
    assert.equal(internals.installManagedPackages.calls.length, 1);
    assert.equal(internals.verifyInstalledManagedState.calls.length, 1);
    const [, , verificationPolicy] = internals.verifyInstalledManagedState.calls[0];
    assert.equal(verificationPolicy.mode, "in-place");
  });

  it("records no device changes when asset verification fails", async () => {
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
    assert.equal(result.deviceChangesStarted, false);
    assert.equal(internals.assertPackageManagerReady.calls.length, 0);
    assert.equal(internals.installManagedPackages.calls.length, 0);
  });

  it("fails one-shot readiness without a second wait or mutation", async () => {
    const target = createResolvedInstallTargetFixture();
    const inspection = createInspection({ target });
    const internals = createInternals(target, inspection);
    internals.assertPackageManagerReady.implementation = async () => {
      throw new Error(
        "Android's package service became unavailable before install. " +
          "No package changes were started. Last response: cmd: Can't find service: package",
      );
    };

    const result = await runInstallOperation(
      { transport: createFakeTransport(), target, inspection },
      internals,
    );

    assert.equal(result.success, false);
    assert.equal(result.failedPhase, null);
    assert.equal(result.deviceChangesStarted, false);
    assert.equal(internals.waitForPackageManagerReady.calls.length, 1);
    assert.equal(internals.assertPackageManagerReady.calls.length, 1);
    assert.equal(internals.downloadInstallTargetAssets.calls.length, 1);
    assert.equal(internals.runPreinstallCleanupCommand.calls.length, 0);
    assert.equal(internals.cleanupManagedPackages.calls.length, 0);
    assert.equal(internals.bootstrapFinalInstaller.calls.length, 0);
    assert.equal(internals.installManagedPackages.calls.length, 0);
  });

  /*
   * The order of the two phases, not just their outcomes.
   *
   * Bootstrap recovery is the destructive plan: it wipes the managed packages
   * and re-privileges the installer. Every asset it needs is downloaded and
   * digest-checked first, so a release the device cannot actually be given
   * costs the wearer nothing. That ordering is currently correct but was not
   * guarded anywhere, the asset-preflight case above runs a previous migration,
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
    // Nothing was removed or cleared. The device is unchanged.
    assert.equal(internals.runPreinstallCleanupCommand.calls.length, 0);
    assert.equal(internals.cleanupManagedPackages.calls.length, 0);
    assert.equal(result.deviceChangesStarted, false);
  });

  it("records no device changes when provider capability preflight fails", async () => {
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
    assert.equal(result.deviceChangesStarted, false);
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
    assert.equal(result.deviceChangesStarted, true);
  });
});

/* ------------------------------------------------------------------ *
 * removeConflicts: taking known-hostile packages off the device
 * ------------------------------------------------------------------ */

function createConflict(overrides = {}) {
  return {
    id: "previous-suite",
    label: "Previous Suite",
    packageIds: ["one.pkg", "two.pkg"],
    installedPackageIds: ["one.pkg", "two.pkg"],
    warningCopy: "Previous suite may interfere.",
    cleanupCommands: [],
    ...overrides,
  };
}

const CONFLICT_DATA_CLEANUP = Object.freeze({
  argv: ["pm", "clear", "previous.data"],
  description: "Clear previous data",
});

const CONFLICT_REBOOT = Object.freeze({
  argv: ["reboot"],
  description: "Reboot device",
});

/** Recording stubs for every device-touching step of the conflict pipeline. */
function createRemoveConflictsInternals(calls) {
  return {
    async waitForPackageManagerReady() {
      calls.push("package-ready");
    },
    async uninstallPackage(_transport, packageId) {
      calls.push(`uninstall:${packageId}`);
    },
    async packageExists(_transport, packageId) {
      calls.push(`exists:${packageId}`);
      return false;
    },
    async runPreinstallCleanupCommand(_transport, command) {
      calls.push(`preinstall:${command.argv.join(" ")}`);
      return { success: true, message: "ok" };
    },
    async setHomeActivity() {
      calls.push("set-home");
    },
    async runCleanupCommand(_transport, command) {
      calls.push(`cleanup:${command.argv.join(" ")}`);
      return { success: true, message: "ok" };
    },
    async removeConflictFilePaths(_transport, paths) {
      calls.push(`rm:${paths.join(",")}`);
    },
    async waitForBootCompleted() {
      calls.push("boot-wait");
    },
  };
}

describe("runRemoveConflictsOperation", () => {
  it("removes packages, restores the stock launcher, reboots, and waits out the boot, in that order", async () => {
    const calls = [];
    const progress = spy();
    const installed = new Set(["one.pkg", "two.pkg"]);
    const internals = createRemoveConflictsInternals(calls);
    internals.uninstallPackage = async (_transport, packageId) => {
      calls.push(`uninstall:${packageId}`);
      installed.delete(packageId);
    };
    internals.packageExists = async (_transport, packageId) => {
      calls.push(`exists:${packageId}`);
      return installed.has(packageId);
    };
    internals.runCleanupCommand = async (_transport, command) => {
      calls.push(`cleanup:${command.argv.join(" ")}`);
      return { success: true, message: "ok" };
    };

    const result = await runRemoveConflictsOperation(
      {
        transport: createFakeTransport("Fake Device"),
        conflicts: [createConflict({ cleanupCommands: [CONFLICT_REBOOT] })],
        onProgress: progress,
      },
      internals,
    );

    // Each removal is confirmed against the device before the next one starts,
    // the stock launcher and system apps go back on BEFORE the reboot (an
    // interrupted run must never leave a launcherless Pin), and the op does not
    // return until the Pin has finished starting.
    assert.deepEqual(calls, [
      "package-ready",
      "uninstall:one.pkg",
      "exists:one.pkg",
      "uninstall:two.pkg",
      "exists:two.pkg",
      ...PREINSTALL_CLEANUP_COMMANDS.map(
        (command) => `preinstall:${command.argv.join(" ")}`,
      ),
      "set-home",
      "cleanup:reboot",
      "boot-wait",
      "package-ready",
    ]);
    assert.equal(result.success, true);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.removedPackageIds, ["one.pkg", "two.pkg"]);
    assertCompletedPhase(lastEvent(progress), "Cleanup");
  });

  it("removes a conflict suite's leftover files before its cleanup commands", async () => {
    const calls = [];
    const internals = createRemoveConflictsInternals(calls);

    const result = await runRemoveConflictsOperation(
      {
        transport: createFakeTransport("Fake Device"),
        conflicts: [
          createConflict({
            installedPackageIds: ["one.pkg"],
            cleanupFilePaths: ["/sdcard/penumbra", "/data/local/tmp/bin"],
          }),
        ],
      },
      internals,
    );

    assert.deepEqual(calls, [
      "package-ready",
      "uninstall:one.pkg",
      "exists:one.pkg",
      "rm:/sdcard/penumbra,/data/local/tmp/bin",
      ...PREINSTALL_CLEANUP_COMMANDS.map(
        (command) => `preinstall:${command.argv.join(" ")}`,
      ),
      "set-home",
      "boot-wait",
      "package-ready",
    ]);
    assert.equal(result.success, true);
  });  it("degrades a failed leftover-file removal to a warning", async () => {
    const internals = createRemoveConflictsInternals([]);
    internals.removeConflictFilePaths = async () => {
      throw new Error("rm failed");
    };

    const result = await runRemoveConflictsOperation(
      {
        transport: createFakeTransport("Fake Device"),
        conflicts: [
          createConflict({
            installedPackageIds: [],
            cleanupFilePaths: ["/sdcard/penumbra"],
          }),
        ],
      },
      internals,
    );

    // Leftover files are untidy, not unsafe: the removal continues.
    assert.equal(result.success, true);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, "conflict-file-cleanup-failed");
    assert.match(result.warnings[0].message, /rm failed/);
  });

  it("returns failure when a package is still present after uninstall", async () => {
    const internals = createRemoveConflictsInternals([]);
    internals.packageExists = async () => true;

    const result = await runRemoveConflictsOperation(
      {
        transport: createFakeTransport("Fake Device"),
        conflicts: [createConflict({ installedPackageIds: ["stuck.pkg"] })],
      },
      internals,
    );

    // A silent uninstall failure would leave the install path believing the
    // conflict is gone, so a surviving package fails the whole operation.
    assert.equal(result.success, false);
    assert.match(result.error?.message ?? "", /stuck\.pkg/);
  });

  it("continues with warnings when a cleanup command fails", async () => {
    const internals = createRemoveConflictsInternals([]);
    internals.runCleanupCommand = async () => ({
      success: false,
      message: "clear failed",
    });

    const result = await runRemoveConflictsOperation(
      {
        transport: createFakeTransport("Fake Device"),
        conflicts: [
          createConflict({
            installedPackageIds: [],
            cleanupCommands: [CONFLICT_DATA_CLEANUP],
          }),
        ],
      },
      internals,
    );

    // Leftover data is untidy, not unsafe: it degrades to a warning.
    assert.equal(result.success, true);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, "conflict-cleanup-command-failed");
    assert.match(result.warnings[0].message, /clear failed/);
  });

  it("returns failure when a device-side cleanup command times out", async () => {
    const internals = createRemoveConflictsInternals([]);
    internals.runCleanupCommand = async () => {
      throw new AdbDeviceStepTimeoutError("shell pm clear previous.data");
    };

    const result = await runRemoveConflictsOperation(
      {
        transport: createFakeTransport("Fake Device"),
        conflicts: [
          createConflict({
            installedPackageIds: [],
            cleanupCommands: [CONFLICT_DATA_CLEANUP],
          }),
        ],
      },
      internals,
    );

    // A wedged device is not a warning: the operation stops and says so.
    assert.equal(result.success, false);
    assert.ok(result.error instanceof AdbDeviceStepTimeoutError);
    assert.deepEqual(result.warnings, []);
  });

  it("does not mutate conflicts when package readiness times out", async () => {
    const mutations = [];
    const internals = createRemoveConflictsInternals([]);
    internals.waitForPackageManagerReady = async () => {
      throw new Error(
        "Timed out waiting for Android's package service. Wait for startup to finish, then retry.",
      );
    };
    internals.uninstallPackage = async () => {
      mutations.push("uninstall");
    };

    const result = await runRemoveConflictsOperation(
      {
        transport: createFakeTransport("Fake Device"),
        conflicts: [createConflict({ installedPackageIds: ["one.pkg"] })],
      },
      internals,
    );

    assert.equal(result.success, false);
    assert.match(result.error?.message ?? "", /wait for startup to finish/i);
    assert.deepEqual(mutations, []);
    assert.deepEqual(result.removedPackageIds, []);
  });
});

/* ------------------------------------------------------------------ *
 * removePackages: taking the wearer-confirmed unknown apps off
 * ------------------------------------------------------------------ */

describe("runRemovePackagesOperation", () => {
  it("removes exactly the confirmed package IDs and verifies each uninstall", async () => {
    const calls = [];
    const internals = createRemoveConflictsInternals(calls);

    const result = await runRemovePackagesOperation(
      {
        transport: createFakeTransport("Fake Device"),
        packageIds: ["side.app.one", "side.app.two"],
      },
      internals,
    );

    assert.deepEqual(calls, [
      "package-ready",
      "uninstall:side.app.one",
      "exists:side.app.one",
      "uninstall:side.app.two",
      "exists:side.app.two",
    ]);
    assert.equal(result.success, true);
    assert.deepEqual(result.removedPackageIds, ["side.app.one", "side.app.two"]);
    assert.deepEqual(result.warnings, []);
  });

  it("fails when a confirmed package survives its own uninstall", async () => {
    const internals = createRemoveConflictsInternals([]);
    internals.packageExists = async () => true;

    const result = await runRemovePackagesOperation(
      {
        transport: createFakeTransport("Fake Device"),
        packageIds: ["stuck.app"],
      },
      internals,
    );

    // The conflict flow's rule: a silent failure must not read as success.
    assert.equal(result.success, false);
    assert.match(result.error?.message ?? "", /stuck\.app/);
    assert.deepEqual(result.removedPackageIds, []);
  });
});

/* ------------------------------------------------------------------ *
 * uninstall: deactivating the server identity, removing the managed
 * runtime, and restoring stock packages
 * ------------------------------------------------------------------ */

function createUninstallInternals(calls) {
  return {
    async waitForPackageManagerReady() {
      calls.push("package-ready");
    },
    async deactivateCosmosIdentity() {
      calls.push("deactivate");
      return { ok: true, state: "deactivated", rollbackComplete: true, message: null };
    },
    async clearCosmosIdentity() {
      calls.push("clear");
      return { ok: true, state: "cleared", rollbackComplete: true, message: null };
    },
    async cleanupManagedPackages() {
      calls.push("cleanup");
    },
    async restoreConfiguredPackages() {
      calls.push("restore");
      return [];
    },
    async verifyUninstalledManagedState() {
      calls.push("verify");
    },
  };
}

describe("runUninstallOperation", () => {
  it("runs deactivate, cleanup, restore, and verify in order", async () => {
    const calls = [];
    const progress = spy();
    const internals = createUninstallInternals(calls);
    internals.restoreConfiguredPackages = async () => {
      calls.push("restore");
      return [
        {
          code: "restore-failed",
          packageName: "humane.ota",
          message: "enable failed",
        },
      ];
    };
    const result = await runUninstallOperation(
      { transport: createFakeTransport("Fake Device"), onProgress: progress },
      internals,
    );

    // Order is load-bearing: the identity provider lives in the server APK, so
    // it is deactivated BEFORE cleanup uninstalls that package, stock packages
    // go back on after the managed packages come off, and only then is the end
    // state verified.
    assert.deepEqual(calls, [
      "package-ready",
      "deactivate",
      "clear",
      "cleanup",
      "restore",
      "verify",
    ]);
    // A package that could not be re-enabled is reported, not fatal.
    assert.equal(result.success, true);
    assert.equal(result.warnings.length, 1);
    assertCompletedPhase(lastEvent(progress), "Verify");
  });

  it("degrades a Cosmos identity refusal to a warning and still uninstalls", async () => {
    const calls = [];
    const {
      CosmosIdentityRefusedError,
    } = await import("../src/lib/pin-device/cosmosIdentity.ts");
    const internals = createUninstallInternals(calls);
    internals.deactivateCosmosIdentity = async () => {
      calls.push("deactivate-refused");
      throw new CosmosIdentityRefusedError("The Pin refused the Cosmos identity change.");
    };

    const result = await runUninstallOperation(
      { transport: createFakeTransport("Fake Device") },
      internals,
    );

    // An unreachable or refusing provider must not strand Luma on the Pin:
    // the uninstall continues and reports what did not happen.
    assert.equal(result.success, true);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, "identity-deactivate-failed");
    assert.match(result.warnings[0].message, /refused/);
    assert.deepEqual(calls, [
      "package-ready",
      "deactivate-refused",
      "cleanup",
      "restore",
      "verify",
    ]);
  });

  it("warns when deactivation succeeded but the settings rollback did not complete", async () => {
    const internals = createUninstallInternals([]);
    internals.deactivateCosmosIdentity = async () => ({
      ok: true,
      state: "deactivated",
      rollbackComplete: false,
      message: null,
    });

    const result = await runUninstallOperation(
      { transport: createFakeTransport("Fake Device") },
      internals,
    );

    assert.equal(result.success, true);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, "identity-deactivate-failed");
    assert.match(result.warnings[0].message, /may need a repair/);
  });

  it("returns failure when verification fails", async () => {
    const internals = createUninstallInternals([]);
    internals.verifyUninstalledManagedState = async () => {
      throw new Error("package still present");
    };

    const result = await runUninstallOperation(
      { transport: createFakeTransport("Fake Device") },
      internals,
    );

    assert.equal(result.success, false);
    assert.match(result.error?.message ?? "", /package still present/);
  });

  it("returns failure when a device-side uninstall step times out", async () => {
    const internals = createUninstallInternals([]);
    internals.cleanupManagedPackages = async () => {
      throw new AdbDeviceStepTimeoutError("shell pm uninstall com.penumbraos.server");
    };

    const result = await runUninstallOperation(
      { transport: createFakeTransport("Fake Device") },
      internals,
    );

    assert.equal(result.success, false);
    assert.ok(result.error instanceof AdbDeviceStepTimeoutError);
    assert.match(result.error.message, /60000ms/);
  });

  it("does not mutate uninstall state when package readiness fails", async () => {
    const mutations = [];
    let readinessCalls = 0;
    const internals = createUninstallInternals([]);
    internals.waitForPackageManagerReady = async () => {
      readinessCalls += 1;
      throw new Error("Android package service is not ready");
    };
    internals.cleanupManagedPackages = async () => {
      mutations.push("cleanup");
    };
    internals.restoreConfiguredPackages = async () => {
      mutations.push("restore");
      return [];
    };
    internals.verifyUninstalledManagedState = async () => {
      mutations.push("verify");
    };

    const result = await runUninstallOperation(
      { transport: createFakeTransport("Fake Device") },
      internals,
    );

    assert.equal(result.success, false);
    assert.equal(readinessCalls, 1);
    assert.deepEqual(mutations, []);
  });
});

describe("Center installer inspection scheduling", () => {
  it("streams progress without launching concurrent inspections", () => {
    assert.doesNotMatch(installControllerSource, /inspectionRefreshInFlight/);
    assert.doesNotMatch(
      installControllerSource,
      /operation-inspection-updated/,
    );
    assert.match(installControllerSource, /onProgress: progress\.onProgress/);
    assert.match(
      installControllerSource,
      /onProgress: installProgress\.onProgress/,
    );
  });

  it("does not reinspect after a package readiness failure", () => {
    assert.match(
      installControllerSource,
      /isPackageReadinessError\(result\.error\)/,
    );
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
 * is UNKNOWN, the interesting default, because "unknown" is the state the
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
      loader: controllerPackage(
        "loader",
        "com.penumbraos.hook.injector",
        "2026-04-29.1",
      ),
    },
    detectedConflicts: [],
    hasDetectedConflicts: false,
    unrecognizedPackages: [],
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

const LOCKED_DEVICE_COPY = "Your Pin is locked. Unlock it, then choose Check again.";

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
    // Not "locked", simply unproven. Installing against a device whose CE
    // storage never came up writes packages that cannot read their own data, so
    // an unreadable answer is treated exactly like a refusal.
    const commands = deriveInstallControllerCommands(createControllerState());

    assert.equal(commands.primaryAction.disabled, true);
    assert.match(
      commands.primaryAction.reason ?? "",
      /couldn’t confirm that your Pin is unlocked/,
    );
  });

  it("shows remove-conflicts action when known conflicts are detected", () => {
    const commands = deriveInstallControllerCommands(
      createControllerState({
        inspection: createControllerInspection({
          detectedConflicts: [
            {
              id: "previous-suite",
              label: "Previous Suite",
              packageIds: ["conflict.one"],
              installedPackageIds: ["conflict.one"],
              warningCopy: "Previous suite may interfere.",
              cleanupCommands: [],
            },
          ],
          hasDetectedConflicts: true,
        }),
      }),
    );

    assert.equal(commands.removeConflicts.visible, true);
    assert.equal(commands.removeConflicts.disabled, false);
    assert.equal(commands.removeConflicts.label, "Remove conflicting apps…");
  });

  it("disables remove-conflicts action when device is disconnected", () => {
    const commands = deriveInstallControllerCommands(
      createControllerState({
        connection: null,
        inspection: createControllerInspection({
          detectedConflicts: [
            {
              id: "previous-suite",
              label: "Previous Suite",
              packageIds: ["conflict.one"],
              installedPackageIds: ["conflict.one"],
              warningCopy: "Previous suite may interfere.",
              cleanupCommands: [],
            },
          ],
          hasDetectedConflicts: true,
        }),
      }),
    );

    // Still visible, so the wearer can see there is something to fix. Disabled,
    // because there is nothing to run it against.
    assert.equal(commands.removeConflicts.visible, true);
    assert.equal(commands.removeConflicts.disabled, true);
    assert.match(commands.removeConflicts.reason ?? "", /Connect a device/);
  });

  it("offers the unrecognized-apps removal only while unrecognized apps are detected", () => {
    const clean = deriveInstallControllerCommands(createControllerState());
    assert.equal(clean.removeUnrecognized.visible, false);

    const withUnrecognized = deriveInstallControllerCommands(
      createControllerState({
        inspection: createControllerInspection({
          unrecognizedPackages: ["com.example.sideapp"],
        }),
      }),
    );
    assert.equal(withUnrecognized.removeUnrecognized.visible, true);
    assert.equal(withUnrecognized.removeUnrecognized.disabled, false);
    assert.equal(withUnrecognized.removeUnrecognized.label, "Remove unrecognized apps…");
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
   * changed. `/setup/` does not exist here, verify/public-assets.test.mjs holds
   * Center to shipping no ungated `/setup`, so the destination is a named
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
          deviceChangesStarted: true,
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
  id: "previous-suite",
  label: "Previous Suite",
  packageIds: ["conflict.one", "conflict.two"],
  installedPackageIds: ["conflict.one"],
  warningCopy: "Previous suite may interfere.",
  cleanupCommands: [{ argv: ["pm", "clear", "conflict.one"], description: "Clear conflict data" }],
});

/** Commands as the card receives them: derivation itself is covered above. */
function createCommands() {
  return {
    connect: { visible: false, label: "Connect over USB", disabled: false, reason: null },
    primaryAction: { visible: true, label: "Reinstall", disabled: false, reason: null },
    installApkFile: { visible: true, label: "Install an APK file…", disabled: false, reason: null },
    uninstall: { visible: true, label: "Uninstall Luma…", disabled: false, reason: null },
    removeConflicts: {
      visible: true,
      label: "Remove conflicting apps…",
      disabled: false,
      reason: null,
    },
    removeUnrecognized: {
      visible: false,
      label: "Remove unrecognized apps…",
      disabled: false,
      reason: null,
    },
    recheck: { visible: false, label: "Check again", disabled: false, reason: null },
    startOver: { visible: true, label: "Disconnect", disabled: false, reason: null },
    goToCenter: { visible: false, ...DEFAULT_POST_INSTALL_LINK },
  };
}

describe("derivePrimaryCardViewModel", () => {
  it("says no changes were made when package readiness fails before mutation", () => {
    const viewModel = derivePrimaryCardViewModel(
      createControllerState({
        stage: "result",
        inspection: createControllerInspection({
          credentialState: { state: "unlocked", ceAvailableRaw: "1" },
        }),
        lastOperationResult: {
          kind: "install",
          result: {
            success: false,
            warnings: [],
            inspection: null,
            error: new PackageServiceNotReadyError(
              "Timed out waiting for Android's package service.",
            ),
            failedPhase: null,
            deviceChangesStarted: false,
          },
        },
      }),
      createCommands(),
    );

    assert.deepEqual(viewModel.notice, {
      tone: "warning",
      text: "No changes were made. Wait for Android to finish starting, then retry.",
    });
  });

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

    // The command is disabled either way. This is the sentence that tells the
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
    assert.equal(row.role, "Previous Suite");
    assert.equal(row.tone, "warning");
    assert.equal(row.category, "conflict");
    assert.equal(row.badge, "Warning");
    // Two packages are known to the group, one is actually on this device: the
    // row counts what is installed, not what the definition lists.
    assert.equal(row.value, "1 package");
  });

  it("surfaces the unrecognized-app advisory with its exact package list", () => {
    const viewModel = derivePrimaryCardViewModel(
      createControllerState({
        inspection: createControllerInspection({
          unrecognizedPackages: ["com.example.sideapp", "com.other.util"],
        }),
      }),
      createCommands(),
    );

    assert.deepEqual(viewModel.unrecognizedApps, {
      count: 2,
      packages: ["com.example.sideapp", "com.other.util"],
    });

    const clean = derivePrimaryCardViewModel(
      createControllerState(),
      createCommands(),
    );
    assert.equal(clean.unrecognizedApps, null);
  });
});
