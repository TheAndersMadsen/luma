/*
 * The device steps themselves: src/lib/pin-install/ops/shared.ts.
 *
 * Everything else under verify/ that touches the installer stops at the
 * `internals` seam. verify/pin-install-ops.test.mjs injects a stub for every
 * function in this module and asserts which ones the pipeline decided to call;
 * that pins the decisions and nothing about what the calls DO. This file is the
 * other half: the real functions, running against a fake Pin that answers shell
 * commands, because these are the calls that uninstall a wearer's packages and
 * then decide whether what came back is safe to leave on the device.
 *
 * The post-install assertions in `verifyInstalledManagedState` are the reason
 * the file exists. They run after the packages have already been written, so
 * each one is the last chance to notice that the Pin in front of the wearer is
 * not the Pin the install was planned for, a helper left behind with system
 * privileges, a package that answered the presence probe and then vanished, a
 * signer that changed underneath a package name, a runtime component still on
 * the previous version. There is one case per throw, and each is reached by
 * changing exactly one thing about an otherwise healthy device, so a guard that
 * stops firing cannot be masked by another guard firing first.
 *
 * The verification order is itself load-bearing and shows up in these cases: an
 * outright absent managed package trips the readiness assertion before the
 * missing-package assertion, so the missing-package case describes the only
 * device that reaches it, one whose answers disagree between two consecutive
 * queries.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  DEVICE_SIGNER_IDENTITY,
  OK,
  deviceShell,
  fakeDevice,
} from "./fixtures/fake-pin-device.mjs";

const QUERY = "?pin-install-shared-ops-test";

const {
  cleanupManagedPackages,
  disableConfiguredPackages,
  installManagedPackages,
  restoreConfiguredPackages,
  verifyInstalledManagedState,
  verifyUninstalledManagedState,
} = await import(`../src/lib/pin-install/ops/shared.ts${QUERY}`);

const { MANAGED_PACKAGES } = await import(
  `../src/lib/pin-install/domain/managedPackages.ts${QUERY}`
);

const { createResolvedInstallTargetFixture } = await import(
  `../src/lib/pin-install/releases/testFixtures.ts${QUERY}`
);

const FAILED = (stderr) => ({ stdout: "", stderr, exitCode: 1 });
const ABSENT = OK("");
const present = (packageName) => OK(`package:${packageName}\n`);
const dump = (version, signer = DEVICE_SIGNER_IDENTITY) =>
  OK(`versionName=${version}\nPackageSignatures{a signatures:[${signer}]}\n`);

/* ------------------------------------------------------------------ *
 * cleanupManagedPackages / verifyUninstalledManagedState
 * ------------------------------------------------------------------ */

describe("cleanupManagedPackages", () => {
  it("removes only the managed packages present, in dependency order", async () => {
    // The injector hooks the server, the server is loaded by the hook, and the
    // installer is what granted all three their privileges. Removing them in
    // any other order leaves a live component bound to something that is no
    // longer there, so the order is asserted rather than the set.
    const device = fakeDevice({
      "pm list packages com.penumbraos.hook.injector": present(
        MANAGED_PACKAGES.loader,
      ),
      "pm list packages com.penumbraos.server": present(MANAGED_PACKAGES.server),
      "pm list packages com.penumbraos.hook": ABSENT,
      "pm list packages com.penumbraos.systeminjector": present(
        MANAGED_PACKAGES.installer,
      ),
      "pm list packages com.penumbraos.systeminjector.exploit": ABSENT,
      "pm uninstall com.penumbraos.hook.injector": OK("Success\n"),
      "pm uninstall com.penumbraos.server": OK("Success\n"),
      "pm uninstall com.penumbraos.systeminjector": OK("Success\n"),
    });

    await cleanupManagedPackages(device);

    // A package that is not installed is never handed to `pm uninstall`: the
    // command would fail, and a failure here throws.
    assert.deepEqual(device.commands, [
      "pm list packages com.penumbraos.hook.injector",
      "pm uninstall com.penumbraos.hook.injector",
      "pm list packages com.penumbraos.server",
      "pm uninstall com.penumbraos.server",
      "pm list packages com.penumbraos.hook",
      "pm list packages com.penumbraos.systeminjector",
      "pm uninstall com.penumbraos.systeminjector",
      "pm list packages com.penumbraos.systeminjector.exploit",
    ]);
  });

  it("fails the cleanup when the device refuses an uninstall", async () => {
    // `pm uninstall` reports refusal in its exit code, not by throwing. Reading
    // that as success is how a rollback would report a clean device while a
    // system-privileged package is still installed on it.
    const device = fakeDevice({
      "pm list packages com.penumbraos.hook.injector": present(
        MANAGED_PACKAGES.loader,
      ),
      "pm uninstall com.penumbraos.hook.injector": FAILED(
        "Failure [DELETE_FAILED_INTERNAL_ERROR]",
      ),
    });

    await assert.rejects(
      cleanupManagedPackages(device),
      /DELETE_FAILED_INTERNAL_ERROR/,
    );
  });
});

describe("verifyUninstalledManagedState", () => {
  it("passes only when every managed package is gone", async () => {
    const device = fakeDevice({
      "pm list packages com.penumbraos.hook.injector": ABSENT,
      "pm list packages com.penumbraos.server": ABSENT,
      "pm list packages com.penumbraos.hook": ABSENT,
      "pm list packages com.penumbraos.systeminjector": ABSENT,
      "pm list packages com.penumbraos.systeminjector.exploit": ABSENT,
    });

    await verifyUninstalledManagedState(device);
  });

  it("names the package that survived the uninstall", async () => {
    // The bootstrap helper is the one that matters most here, it is the
    // component that exists to gain system privileges, and it is checked last,
    // so a check that stopped early would report a clean device.
    const device = fakeDevice({
      "pm list packages com.penumbraos.hook.injector": ABSENT,
      "pm list packages com.penumbraos.server": ABSENT,
      "pm list packages com.penumbraos.hook": ABSENT,
      "pm list packages com.penumbraos.systeminjector": ABSENT,
      "pm list packages com.penumbraos.systeminjector.exploit": present(
        MANAGED_PACKAGES.bootstrapHelper,
      ),
    });

    await assert.rejects(
      verifyUninstalledManagedState(device),
      /com\.penumbraos\.systeminjector\.exploit is still present/,
    );
  });
});

/* ------------------------------------------------------------------ *
 * disableConfiguredPackages / restoreConfiguredPackages
 * ------------------------------------------------------------------ */

const VENDOR_PACKAGES = ["vendor.one", "vendor.two"];

describe("disableConfiguredPackages and restoreConfiguredPackages", () => {
  it("degrades a refused disable to a warning and keeps going", async () => {
    // Disabling a stock package is a preference, not a precondition: a Pin that
    // will not disable one of them is still a Pin the install can finish on. The
    // failure has to be reported, though, or the wearer gets a vendor app back
    // in their face with nothing to explain it.
    const device = fakeDevice({
      "pm disable-user --user 0 vendor.one": FAILED("Unknown package: vendor.one"),
      "pm disable-user --user 0 vendor.two": OK("new state: disabled-user\n"),
    });

    const warnings = await disableConfiguredPackages(device, VENDOR_PACKAGES);

    assert.deepEqual(warnings, [
      {
        code: "disable-failed",
        packageName: "vendor.one",
        message: "Unknown package: vendor.one",
      },
    ]);
    // The second package is still attempted after the first one failed.
    assert.equal(device.commands.length, 2);
  });

  it("degrades a refused restore to a warning and keeps going", async () => {
    // The mirror image, and the more consequential one: this runs during
    // rollback and uninstall, where the wearer is being handed their stock
    // device back. A package that could not be re-enabled must be named.
    const device = fakeDevice({
      "pm enable --user 0 vendor.one": OK("new state: enabled\n"),
      "pm enable --user 0 vendor.two": FAILED("Permission denial"),
    });

    const warnings = await restoreConfiguredPackages(device, VENDOR_PACKAGES);

    assert.deepEqual(warnings, [
      {
        code: "restore-failed",
        packageName: "vendor.two",
        message: "Permission denial",
      },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * installManagedPackages
 * ------------------------------------------------------------------ */

const target = createResolvedInstallTargetFixture();

describe("installManagedPackages", () => {
  it("refuses to start when a selected role's asset was never downloaded", async () => {
    // The asset map is built by the download phase from the plan's asset roles.
    // If those two ever disagree, the install must stop before it opens a
    // staging session, an install that starts and then discovers it has no
    // bytes for one package is a half-installed Pin.
    const device = fakeDevice({});
    const completed = [];

    await assert.rejects(
      installManagedPackages(
        device,
        { target, serverApk: new Blob(["server"]) },
        {
          roles: ["server", "loader"],
          onPackageCompleted: (info) => completed.push(info.packageName),
        },
      ),
      /Missing downloaded asset loaderApk/,
    );

    assert.deepEqual(device.commands, []);
    assert.deepEqual(completed, []);
  });

  it("does not touch the device when the plan selected no packages", async () => {
    // A plan can legitimately have nothing to install. Reaching the install
    // provider anyway would mean waking the installer package, and re-privileging
    // it, for a no-op.
    const device = fakeDevice({});
    const started = [];

    await installManagedPackages(
      device,
      { target },
      { roles: [], onPackageStart: (info) => started.push(info.packageName) },
    );

    assert.deepEqual(device.commands, []);
    assert.deepEqual(started, []);
  });
});

/* ------------------------------------------------------------------ *
 * verifyInstalledManagedState, one case per assertion
 * ------------------------------------------------------------------ */

/** The policy an in-place migration verifies against: the installer is kept. */
function inPlacePolicy(overrides = {}) {
  return {
    mode: "in-place",
    expectedSignerIdentity: DEVICE_SIGNER_IDENTITY,
    retainedInstaller: {
      versionName: target.version,
      signerIdentity: DEVICE_SIGNER_IDENTITY,
    },
    ...overrides,
  };
}

/** The policy a bootstrap recovery verifies against: the installer is replaced. */
function recoveryPolicy() {
  return {
    mode: "bootstrap-recovery",
    expectedSignerIdentity: DEVICE_SIGNER_IDENTITY,
    retainedInstaller: null,
  };
}

const verify = (handlers, policy) =>
  verifyInstalledManagedState(fakeDevice(handlers), target, policy);

describe("verifyInstalledManagedState", () => {
  it("uses bounded metadata polling without nesting a generic readiness gate", async () => {
    const device = fakeDevice(deviceShell());
    const inspection = await verifyInstalledManagedState(
      device,
      target,
      inPlacePolicy(),
    );

    assert.equal(inspection.helperPresentUnexpectedly, false);
    assert.equal(inspection.readiness.packageQueryabilityOk, true);
    assert.equal(inspection.packages.server.versionName, target.version);
    assert.equal(
      device.commands.filter((command) => command === "cmd package path android")
        .length,
      0,
    );
  });

  it("rejects a device the bootstrap helper is still installed on", async () => {
    // The helper is the component that gains system privileges in the first
    // place. Leaving it behind leaves that capability sitting on the wearer's
    // device long after the install that needed it finished.
    await assert.rejects(
      verify(
        deviceShell({
          "pm list packages com.penumbraos.systeminjector.exploit": present(
            MANAGED_PACKAGES.bootstrapHelper,
          ),
          "dumpsys package com.penumbraos.systeminjector.exploit": dump(
            target.version,
          ),
        }),
        inPlacePolicy(),
      ),
      /Setup Helper is still present after installation/,
    );
  });

  it("rejects a device whose package metadata stopped being readable", async () => {
    // `dumpsys` answering the wait and then failing is what a package manager
    // that is still settling looks like. Accepting it would mean verifying the
    // install against whatever the last readable answer happened to be.
    await assert.rejects(
      verify(
        deviceShell({
          "dumpsys package com.penumbraos.server": [
            dump(target.version),
            FAILED("Can't find service: package"),
          ],
        }),
        inPlacePolicy(),
      ),
      /Managed package readiness verification failed/,
    );
  });

  it("rejects a device that locked itself during the install", async () => {
    // Credential-encrypted storage going away mid-install means the packages
    // just installed cannot read their own data. The install is not finished. It
    // has to be reported as failed rather than confirmed against a locked Pin.
    await assert.rejects(
      verify(
        deviceShell({ "getprop sys.user.0.ce_available": OK("0\n") }),
        inPlacePolicy(),
      ),
      /became locked before install verification/,
    );
  });

  it("rejects a device that lost a managed package between two queries", async () => {
    // A package that is simply absent trips the readiness assertion above, since
    // an absent package is not a queryable one. The device that reaches THIS
    // assertion is the one that answers the presence probe, does not answer the
    // package read that follows, and answers the readiness probe after that,
    // a package being reaped while verification runs. The three scripted answers
    // are in that order.
    await assert.rejects(
      verify(
        deviceShell({
          "pm list packages com.penumbraos.hook.injector": [
            present(MANAGED_PACKAGES.loader),
            ABSENT,
            present(MANAGED_PACKAGES.loader),
          ],
        }),
        inPlacePolicy(),
      ),
      /One or more managed packages are missing after install/,
    );
  });

  it("rejects a package whose signer is not the one the install expected", async () => {
    // The package name is not the identity, the signer is. A hook signed by
    // someone else, under the name the installer grants privileges to, is the
    // whole attack this check exists for.
    await assert.rejects(
      verify(
        deviceShell({
          "dumpsys package com.penumbraos.hook": dump(target.version, "aaaaaaaa"),
        }),
        inPlacePolicy(),
      ),
      /signer identities changed/,
    );
  });

  it("rejects an in-place migration whose retained installer moved", async () => {
    // In-place means the installer already on the device was deliberately NOT
    // touched. If it is not byte-for-byte the identity the plan retained, then
    // something else installed over it while this operation was running.
    await assert.rejects(
      verify(
        deviceShell(),
        inPlacePolicy({
          retainedInstaller: {
            versionName: "cosmos-2026.08.07",
            signerIdentity: DEVICE_SIGNER_IDENTITY,
          },
        }),
      ),
      /retained installer identity changed during migration/,
    );

    // No retained identity at all is the same failure: an in-place migration
    // that cannot say which installer it kept has not verified anything.
    await assert.rejects(
      verify(deviceShell(), inPlacePolicy({ retainedInstaller: null })),
      /retained installer identity changed during migration/,
    );
  });

  it("rejects a recovery that left the installer on a different version", async () => {
    // Bootstrap recovery replaces the installer, so afterwards it must BE the
    // target. An older installer here means the bootstrap silently did not take,
    // and the next install would be planned against a device state that is not
    // the one reported.
    await assert.rejects(
      verify(
        deviceShell({
          "dumpsys package com.penumbraos.systeminjector": dump("2026-04-28.0"),
        }),
        recoveryPolicy(),
      ),
      /Recovered installer does not match the selected target/,
    );
  });

  it("rejects runtime packages left on the previous version", async () => {
    // The three runtime packages are versioned together and talk to each other
    // across process boundaries. One left behind is a mismatched pair, which is
    // exactly the state the atomic release model exists to prevent.
    await assert.rejects(
      verify(
        deviceShell({
          "dumpsys package com.penumbraos.hook": dump("2026-04-28.0"),
        }),
        recoveryPolicy(),
      ),
      /runtime packages do not match the selected target version/,
    );
  });
});

it("bounds the batch-install step by more than the waits it contains", async () => {
  const installer = await readFile(
    new URL("../src/lib/pin-device/adb/systemInstaller.ts", import.meta.url),
    "utf8",
  );
  const shared = await readFile(
    new URL("../src/lib/pin-install/ops/shared.ts", import.meta.url),
    "utf8",
  );

  // Installing the hook restarts system_server, so this step legitimately waits
  // for a soft reboot. Bounding it with the plain per-step timeout made the outer
  // bound SMALLER than the inner ones, so the step could not complete even when
  // everything worked, and the command then told the operator to re-run a
  // destructive install against a device that was already correct.
  assert.match(
    installer,
    /export const BATCH_INSTALL_TIMEOUT_MS =\n\s*SOFT_REBOOT_STABILIZATION_MS \+ 2 \* DEVICE_STEP_TIMEOUT_MS \+ AFTER_INSTALL_TIMEOUT_MS;/u,
    "the batch bound must be derived from its inner waits, not picked",
  );
  assert.match(shared, /^\s*BATCH_INSTALL_TIMEOUT_MS,$/mu);

  // The derivation must actually exceed every wait nested inside it.
  const value = (name) => {
    const match = installer.match(new RegExp(`export const ${name} = ([0-9_]+);`, "u"));
    assert.ok(match, `${name} must be a literal so this arithmetic is checkable`);
    return Number(match[1].replaceAll("_", ""));
  };
  const perStep = 60_000;
  const derived = value("SOFT_REBOOT_STABILIZATION_MS") + 2 * perStep + value("AFTER_INSTALL_TIMEOUT_MS");
  assert.ok(derived > value("AFTER_INSTALL_TIMEOUT_MS"), "the batch bound must exceed the per-package wait");
  assert.ok(derived > value("SOFT_REBOOT_STABILIZATION_MS") + 2 * perStep, "the batch bound must exceed the soft-reboot recovery");
});
