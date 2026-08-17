/*
 * Behavioural guards for the installer brain, src/lib/pin-install/domain.
 *
 * These five modules decide what happens to a wearer's Ai Pin over ADB: which
 * managed packages get installed, which are left alone, and when the whole
 * mutation is refused. They run in the browser, on the device in front of the
 * wearer, so nothing on the server side can catch a wrong verdict afterwards —
 * and nothing else in verify/ exercises them. The cases below are the ones the
 * pin/setup SPA carried in its vitest suite before that app was deleted; they
 * are ported here so the properties keep being checked.
 *
 * What each group holds:
 *
 *   deriveInstallActionState — the primary action's verb. Install / Repair /
 *     Update / Reinstall is the entire promise made to whoever presses the
 *     button, so Repair has to win over every version verdict whenever a
 *     package is missing or unhealthy, the bootstrap helper is present, or
 *     readiness failed; and a package set with both older and newer members
 *     resolves to Update, never to Reinstall with a warning.
 *
 *   inspectInstallState — the same derivation, run against a device. It must
 *     keep reporting real device state when the release target could not be
 *     resolved while blocking every install action, and it must match known
 *     conflicting suites by wildcard so a family like `com.penumbraos.plugins.*`
 *     is seen rather than only its exact members.
 *
 *   parseInstallVersion / compareInstallVersions / classifyInstalledVersion —
 *     ordering. The date component outranks the increment, impossible dates do
 *     not parse, and an unreadable version classifies as "unreadable" instead
 *     of silently comparing equal — an install decision hangs off that value.
 *
 *   decideInstallMigration — the fail-closed gate in front of the mutation.
 *     Only an exactly recognised legacy or canonical package profile, on an
 *     unlocked and recognised Pin with no conflicts and a verified target, may
 *     proceed; every other shape is "blocked".
 *
 *   isRecognizedAiPin — exact manufacturer and model, with no case folding.
 */

// Registers the resolve hook that lets these `src/` modules reach their own
// extensionless siblings and `@/lib/…` aliases under Node's type stripping.
// Static, so it is evaluated before the dynamic imports below.
import "./tsResolve.mjs";
import assert from "node:assert/strict";
import test from "node:test";

// The fake Pin every `inspectInstallState` case below runs against. It is
// shared with verify/pin-install-shared-ops.test.mjs so both suites agree on
// what a healthy device answers; see the module header for how it works.
import { OK, deviceShell, fakeDevice, packageDump } from "./fixtures/fake-pin-device.mjs";

const QUERY = "?pin-install-domain-test";

const { deriveInstallActionState } = await import(
  `../src/lib/pin-install/domain/actionState.ts${QUERY}`
);
const { inspectInstallState } = await import(
  `../src/lib/pin-install/domain/inspection.ts${QUERY}`
);
const { classifyInstalledVersion, compareInstallVersions, parseInstallVersion } = await import(
  `../src/lib/pin-install/domain/versions.ts${QUERY}`
);
const { decideInstallMigration, LEGACY_MIGRATION_PROFILE } = await import(
  `../src/lib/pin-install/domain/migrationDecision.ts${QUERY}`
);
const { isRecognizedAiPin } = await import(
  `../src/lib/pin-install/domain/recognition.ts${QUERY}`
);
const {
  classifyKeepDataUpdate,
  isEligibleForKeepDataUpdate,
  isSafeRandomizedBaseApkPath,
  parseInstalledAppIdFromDumpsys,
  parseInstalledBaseApkPathFromDumpsys,
  parseInstalledCodePathFromDumpsys,
} = await import(`../src/lib/pin-install/domain/keepDataEligibility.ts${QUERY}`);
// The install card reads these; a package the installer cannot update in place
// has to be visible there too, not only inside the decision.
const {
  getManagedPackageStatusText,
  getManagedPackageStatusTone,
  hasProblematicManagedPackageState,
} = await import(`../src/lib/pin-install/presentation/managedPackages.ts${QUERY}`);
const { MANAGED_PACKAGES } = await import(
  `../src/lib/pin-install/domain/managedPackages.ts${QUERY}`
);
const { createResolvedInstallTargetFixture } = await import(
  `../src/lib/pin-install/releases/testFixtures.ts${QUERY}`
);

const MANAGED_ROLES = ["installer", "hook", "server", "injector"];
const IN_PLACE_ROLES = ["hook", "server", "injector"];

/* ── deriveInstallActionState ─────────────────────────────────────────────── */

/** One managed package as the action derivation sees it: current and healthy. */
function managedPackage(role, overrides = {}) {
  return {
    role,
    installed: true,
    healthy: true,
    versionComparison: "equal",
    ...overrides,
  };
}

/** The shape of a package that is not on the device at all. */
const ABSENT = { installed: false, healthy: false, versionComparison: null };

function actionStateInput(overrides = {}) {
  return {
    packages: {
      installer: managedPackage("installer"),
      hook: managedPackage("hook"),
      server: managedPackage("server"),
      injector: managedPackage("injector"),
    },
    helperPresentUnexpectedly: false,
    readinessOk: true,
    ...overrides,
  };
}

test("deriveInstallActionState offers Install when nothing is installed", () => {
  const state = deriveInstallActionState(
    actionStateInput({
      packages: Object.fromEntries(
        MANAGED_ROLES.map((role) => [role, managedPackage(role, ABSENT)]),
      ),
    }),
  );

  assert.equal(state.action, "Install");
});

test("deriveInstallActionState offers Repair for a partial install", () => {
  const state = deriveInstallActionState(
    actionStateInput({
      packages: {
        installer: managedPackage("installer"),
        hook: managedPackage("hook"),
        server: managedPackage("server", ABSENT),
        injector: managedPackage("injector"),
      },
    }),
  );

  assert.equal(state.action, "Repair");
});

// Readiness and the helper are device-level facts that no version comparison
// can excuse: a fully current package set is still a Repair when either fails.
test("deriveInstallActionState offers Repair when readiness fails despite matching versions", () => {
  const state = deriveInstallActionState(actionStateInput({ readinessOk: false }));

  assert.equal(state.action, "Repair");
});

test("deriveInstallActionState offers Repair when the bootstrap helper is present unexpectedly", () => {
  const state = deriveInstallActionState(
    actionStateInput({ helperPresentUnexpectedly: true }),
  );

  assert.equal(state.action, "Repair");
});

test("deriveInstallActionState offers Update when one package is older than the target", () => {
  const state = deriveInstallActionState(
    actionStateInput({
      packages: {
        installer: managedPackage("installer"),
        hook: managedPackage("hook", { versionComparison: "older" }),
        server: managedPackage("server"),
        injector: managedPackage("injector"),
      },
    }),
  );

  assert.equal(state.action, "Update");
  assert.equal(state.warnings.newerThanTarget, false);
});

test("deriveInstallActionState offers Update when one package version is unreadable", () => {
  const state = deriveInstallActionState(
    actionStateInput({
      packages: {
        installer: managedPackage("installer"),
        hook: managedPackage("hook", { versionComparison: "unreadable" }),
        server: managedPackage("server"),
        injector: managedPackage("injector"),
      },
    }),
  );

  assert.equal(state.action, "Update");
  assert.equal(state.warnings.unreadableVersion, true);
});

test("deriveInstallActionState offers Reinstall when every package is current", () => {
  const state = deriveInstallActionState(actionStateInput());

  assert.equal(state.action, "Reinstall");
  assert.equal(state.warnings.newerThanTarget, false);
});

test("deriveInstallActionState offers Reinstall with a warning when packages are newer and none are older", () => {
  const state = deriveInstallActionState(
    actionStateInput({
      packages: {
        installer: managedPackage("installer", { versionComparison: "newer" }),
        hook: managedPackage("hook"),
        server: managedPackage("server", { versionComparison: "newer" }),
        injector: managedPackage("injector"),
      },
    }),
  );

  assert.equal(state.action, "Reinstall");
  assert.equal(state.warnings.newerThanTarget, true);
});

/*
 * The mixed set is the one that matters. A device carrying one package behind
 * the target and another ahead of it needs the behind one moved forward, so
 * the verb is Update — Reinstall would describe the newer package accurately
 * and quietly leave the older one where it is. The newer package still raises
 * its warning; it just does not get to choose the action.
 */
test("deriveInstallActionState prefers Update over Reinstall when versions are mixed older and newer", () => {
  const state = deriveInstallActionState(
    actionStateInput({
      packages: {
        installer: managedPackage("installer", { versionComparison: "older" }),
        hook: managedPackage("hook", { versionComparison: "newer" }),
        server: managedPackage("server"),
        injector: managedPackage("injector"),
      },
    }),
  );

  assert.equal(state.action, "Update");
  assert.equal(state.warnings.newerThanTarget, true);
});

/* ── inspectInstallState ──────────────────────────────────────────────────── */

test("inspectInstallState derives Reinstall for a healthy current device", async () => {
  const result = await inspectInstallState(fakeDevice(deviceShell()), {
    target: createResolvedInstallTargetFixture(),
    readinessSettleDelayMs: 0,
  });

  assert.equal(result.device.recognizedAiPin, true);
  assert.equal(result.actionState.action, "Reinstall");
  assert.equal(result.installActionsBlocked, false);
  assert.equal(result.packages.server.versionComparison, "equal");
});

test("inspectInstallState derives Update when one package is older than the target", async () => {
  const result = await inspectInstallState(
    fakeDevice(
      deviceShell({
        "dumpsys package com.penumbraos.hook": packageDump(
          "com.penumbraos.hook",
          "2026-04-28.0",
        ),
      }),
    ),
    { target: createResolvedInstallTargetFixture(), readinessSettleDelayMs: 0 },
  );

  assert.equal(result.actionState.action, "Update");
  assert.equal(result.packages.hook.versionComparison, "older");
});

test("inspectInstallState derives Repair when the bootstrap helper is unexpectedly present", async () => {
  const result = await inspectInstallState(
    fakeDevice(
      deviceShell({
        "pm list packages com.penumbraos.systeminjector.exploit": OK(
          "package:com.penumbraos.systeminjector.exploit\n",
        ),
        "dumpsys package com.penumbraos.systeminjector.exploit": OK(
          "versionName=2026-04-29.0\n",
        ),
      }),
    ),
    { target: createResolvedInstallTargetFixture(), readinessSettleDelayMs: 0 },
  );

  assert.equal(result.helperPresentUnexpectedly, true);
  assert.equal(result.actionState.action, "Repair");
});

/*
 * A release target that could not be resolved is not a reason to go blind. The
 * inspection still reports what is on the device — that is the diagnostic the
 * operator needs most at that moment — while every install action is blocked,
 * and the blocking reason names the failure rather than a generic sentence.
 */
test("inspectInstallState blocks install actions when target resolution failed while still showing state", async () => {
  const result = await inspectInstallState(fakeDevice(deviceShell()), {
    target: null,
    targetResolutionError: new Error("Release service unreachable"),
    readinessSettleDelayMs: 0,
  });

  assert.equal(result.actionState.action, "Reinstall");
  assert.equal(result.installActionsBlocked, true);
  assert.match(result.installActionsBlockedReason, /Release service unreachable/);
});

/*
 * Conflicting suites are declared as patterns because their members are not a
 * fixed list — `com.penumbraos.plugins.*` names whatever the wearer happens to
 * have installed. Matching only literal package IDs would report a device as
 * clean while a whole conflicting runtime sits on it.
 */
test("inspectInstallState detects known conflicting package groups by wildcard package ID patterns", async () => {
  const result = await inspectInstallState(
    fakeDevice(
      deviceShell({
        "pm list packages": OK(
          [
            "package:com.penumbraos.server",
            "package:conflict.one",
            "package:conflict.two.alpha",
            "package:conflict.three",
          ].join("\n"),
        ),
      }),
    ),
    {
      target: createResolvedInstallTargetFixture(),
      readinessSettleDelayMs: 0,
      knownPackageConflicts: [
        {
          id: "legacy-suite",
          label: "Legacy Suite",
          packageIds: ["conflict.one", "conflict.two*"],
          cleanupCommands: [],
        },
        {
          id: "other-suite",
          label: "Other Suite",
          packageIds: ["conflict.three"],
          cleanupCommands: [{ argv: ["pm", "clear", "conflict.three"] }],
        },
      ],
    },
  );

  assert.equal(result.hasDetectedConflicts, true);
  assert.deepEqual(
    result.detectedConflicts.map((conflict) => ({
      id: conflict.id,
      installedPackageIds: conflict.installedPackageIds,
      cleanupCommands: conflict.cleanupCommands,
    })),
    [
      {
        id: "legacy-suite",
        installedPackageIds: ["conflict.one", "conflict.two.alpha"],
        cleanupCommands: [],
      },
      {
        id: "other-suite",
        installedPackageIds: ["conflict.three"],
        cleanupCommands: [{ argv: ["pm", "clear", "conflict.three"] }],
      },
    ],
  );
});

/* ── versions ─────────────────────────────────────────────────────────────── */

test("parseInstallVersion parses a valid install version", () => {
  assert.deepEqual(parseInstallVersion("2026-04-29.3"), {
    raw: "2026-04-29.3",
    year: 2026,
    month: 4,
    day: 29,
    increment: 3,
    dateKey: 20260429,
  });
});

// Every rejected shape here would otherwise become a version that compares
// against the target and decides an install.
test("parseInstallVersion rejects invalid values", () => {
  assert.equal(parseInstallVersion(undefined), null);
  assert.equal(parseInstallVersion(""), null);
  assert.equal(parseInstallVersion("2026-04-29"), null, "missing increment");
  assert.equal(parseInstallVersion("2026-02-30.1"), null, "impossible calendar date");
  assert.equal(parseInstallVersion("v2026-04-29.1"), null, "leading noise");
});

test("compareInstallVersions compares by date before increment", () => {
  assert.equal(compareInstallVersions("2026-04-28.9", "2026-04-29.0"), -1);
  assert.equal(compareInstallVersions("2026-04-29.2", "2026-04-29.1"), 1);
  assert.equal(compareInstallVersions("2026-04-29.1", "2026-04-29.1"), 0);
});

test("compareInstallVersions returns null for unreadable versions", () => {
  assert.equal(compareInstallVersions("bad", "2026-04-29.1"), null);
  assert.equal(compareInstallVersions("2026-04-29.1", "bad"), null);
});

test("classifyInstalledVersion classifies version comparisons", () => {
  assert.equal(classifyInstalledVersion("2026-04-28.0", "2026-04-29.0"), "older");
  assert.equal(classifyInstalledVersion("2026-04-29.0", "2026-04-29.0"), "equal");
  assert.equal(classifyInstalledVersion("2026-04-30.0", "2026-04-29.9"), "newer");
  assert.equal(classifyInstalledVersion("invalid", "2026-04-29.0"), "unreadable");
});

/* ── decideInstallMigration ───────────────────────────────────────────────── */

const PACKAGE_BY_ROLE = {
  installer: MANAGED_PACKAGES.installer,
  hook: MANAGED_PACKAGES.hook,
  server: MANAGED_PACKAGES.server,
  injector: MANAGED_PACKAGES.injector,
};

/*
 * A package as the migration gate sees it, at the legacy baseline.
 *
 * The version names are read from LEGACY_MIGRATION_PROFILE rather than written
 * out here: the profile is the device description this decision exists to
 * recognise, and a copy in the test would only prove the copy matched itself.
 */
function snapshot(role, target, overrides = {}) {
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
    // The baseline device runs every managed package from the path the system
    // injector owns, under the system app id. This is not decoration: the
    // installer on the Pin refuses a keep-data update for any other artifact,
    // so a fixture without it describes a device that cannot be updated at all.
    appId: 1000,
    baseApkPath: `/data/app/${packageName}-injected/base.apk`,
    keepDataUpdateVerdict: "eligible",
    ...overrides,
  };
}

/** An inspection result of the shape `decideInstallMigration` consumes. */
function inspection(options = {}) {
  const target = options.target ?? createResolvedInstallTargetFixture();
  const packages = Object.fromEntries(
    MANAGED_ROLES.map((role) => [
      role,
      snapshot(role, target, options.packageOverrides?.[role]),
    ]),
  );

  return {
    device: {
      manufacturer: "Humane",
      model: "Ai Pin",
      product: "mako",
      buildFingerprint: "humane/test",
      recognizedAiPin: options.recognized ?? true,
    },
    target,
    targetResolutionFailed: false,
    targetResolutionErrorMessage: null,
    helperPresentUnexpectedly: options.helperPresent ?? false,
    readiness: {
      packageQueryabilityOk: true,
      settleDelayMs: 0,
      packageResults: [],
      credentialState: {
        state: options.credentialState ?? "unlocked",
        ceAvailableRaw: "1",
      },
    },
    packages,
    detectedConflicts: options.conflicts
      ? [
          {
            id: "conflict",
            label: "Conflict",
            packageIds: ["other.pin.runtime"],
            installedPackageIds: ["other.pin.runtime"],
            warningCopy: null,
            cleanupCommands: [],
          },
        ]
      : [],
    hasDetectedConflicts: options.conflicts ?? false,
    actionState: {
      action: options.action ?? "Update",
      warnings: { newerThanTarget: false, unreadableVersion: true },
      reasons: [],
    },
    installActionsBlocked: false,
    installActionsBlockedReason: null,
  };
}

/*
 * The legacy profile describes one real device — the operator-owned Pin the
 * first canonical migration was written for — by versionName and signer. Being
 * able to recognise it is the whole point of the profile: the installer that is
 * already there is what grants the install, so it is retained by identity
 * rather than replaced.
 */
test("decideInstallMigration recognizes the exact observed legacy profile and retains its installer", () => {
  const target = createResolvedInstallTargetFixture();
  const result = decideInstallMigration({ target, inspection: inspection({ target }) });

  assert.equal(result.kind, "legacy-in-place");
  assert.deepEqual(result.rolesToInstall, IN_PLACE_ROLES);
  assert.deepEqual(result.retainedInstaller, {
    packageName: MANAGED_PACKAGES.installer,
    versionName: "carry-2026.08.07",
    signerIdentity: "dd07f452",
  });
});

test("decideInstallMigration resumes only the bounded legacy roles that are not canonical yet", () => {
  const target = createResolvedInstallTargetFixture();
  const result = decideInstallMigration({
    target,
    inspection: inspection({
      target,
      packageOverrides: {
        hook: { versionName: target.version, versionComparison: "equal" },
        injector: {
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
    }),
  });

  assert.equal(result.kind, "legacy-in-place");
  assert.deepEqual(result.rolesToInstall, ["server", "injector"]);
});

test("decideInstallMigration refreshes only runtime packages for a healthy canonical reinstall", () => {
  const target = createResolvedInstallTargetFixture();
  const packageOverrides = Object.fromEntries(
    MANAGED_ROLES.map((role) => [
      role,
      { versionName: target.version, versionComparison: "equal" },
    ]),
  );
  const result = decideInstallMigration({
    target,
    inspection: inspection({ target, action: "Reinstall", packageOverrides }),
  });

  assert.equal(result.kind, "routine-in-place");
  assert.deepEqual(result.rolesToInstall, IN_PLACE_ROLES);
  assert.equal(result.retainedInstaller?.versionName, target.version);
});

test("decideInstallMigration retains an older healthy canonical installer during a routine update", () => {
  const target = createResolvedInstallTargetFixture();
  const previousVersion = "2026-04-28.0";
  const packageOverrides = Object.fromEntries(
    MANAGED_ROLES.map((role) => [
      role,
      { versionName: previousVersion, versionComparison: "older" },
    ]),
  );
  const result = decideInstallMigration({
    target,
    inspection: inspection({ target, action: "Update", packageOverrides }),
  });

  assert.equal(result.kind, "routine-in-place");
  assert.deepEqual(result.rolesToInstall, IN_PLACE_ROLES);
  assert.equal(result.retainedInstaller?.versionName, previousVersion);
});

/*
 * The next four are the fail-closed edge. Each one takes the profile the gate
 * does recognise and changes a single fact about one role — the package it
 * claims to be, who signed it, what version it reports, whether it is healthy —
 * and each must end the install rather than proceed on the rest of the match.
 */
test("decideInstallMigration blocks an unexpected package identity for any role", () => {
  const target = createResolvedInstallTargetFixture();
  for (const role of MANAGED_ROLES) {
    const result = decideInstallMigration({
      target,
      inspection: inspection({
        target,
        packageOverrides: { [role]: { packageName: `unexpected.${role}.package` } },
      }),
    });
    assert.equal(result.kind, "blocked", `unexpected ${role} package identity`);
  }
});

test("decideInstallMigration blocks a missing or mismatched signer for any role", () => {
  const target = createResolvedInstallTargetFixture();
  for (const role of MANAGED_ROLES) {
    const result = decideInstallMigration({
      target,
      inspection: inspection({
        target,
        packageOverrides: { [role]: { signerIdentity: null } },
      }),
    });
    assert.equal(result.kind, "blocked", `missing ${role} signer`);
  }
});

test("decideInstallMigration blocks an unsupported version baseline for any role", () => {
  const target = createResolvedInstallTargetFixture();
  for (const role of MANAGED_ROLES) {
    const result = decideInstallMigration({
      target,
      inspection: inspection({
        target,
        packageOverrides: { [role]: { versionName: "unexpected" } },
      }),
    });
    assert.equal(result.kind, "blocked", `unsupported ${role} version baseline`);
  }
});

test("decideInstallMigration blocks an unhealthy legacy runtime package", () => {
  const target = createResolvedInstallTargetFixture();
  for (const role of IN_PLACE_ROLES) {
    const result = decideInstallMigration({
      target,
      inspection: inspection({
        target,
        packageOverrides: { [role]: { healthy: false } },
      }),
    });
    assert.equal(result.kind, "blocked", `unhealthy legacy ${role} runtime`);
  }
});

/*
 * A missing or unhealthy installer is the one absence that is recoverable: the
 * runtime packages around it still match a supported baseline, so the decision
 * is bootstrap recovery rather than a block. It stays that way only while the
 * rest of the profile is recognised.
 */
test("decideInstallMigration routes only missing or unhealthy supported installers to recovery", () => {
  const target = createResolvedInstallTargetFixture();
  const installers = [
    { installed: false, healthy: false, versionName: null, signerIdentity: null },
    { installed: true, healthy: false },
  ];

  for (const installer of installers) {
    const result = decideInstallMigration({
      target,
      inspection: inspection({ target, packageOverrides: { installer } }),
    });
    assert.equal(
      result.kind,
      "bootstrap-recovery",
      `installer ${JSON.stringify(installer)}`,
    );
  }
});

/*
 * Everything outside the device itself that has to hold before any package is
 * touched. A target the inspection did not actually look at, an unverified
 * manifest, a locked Pin whose credential-encrypted storage is unavailable, a
 * conflicting runtime, the bootstrap helper left behind, or a device that is
 * not an Ai Pin: each one alone ends the install.
 */
test("decideInstallMigration blocks stale, unverified, locked, conflicting, and unsupported targets", () => {
  const target = createResolvedInstallTargetFixture();
  const staleTarget = createResolvedInstallTargetFixture({ releaseId: "c".repeat(64) });
  const unverifiedTarget = { ...target, manifestVerified: false };

  const cases = [
    ["a target the inspection never saw", { target, inspection: inspection({ target: staleTarget }) }],
    [
      "an unverified manifest",
      { target: unverifiedTarget, inspection: inspection({ target: unverifiedTarget }) },
    ],
    ["a locked Pin", { target, inspection: inspection({ target, credentialState: "locked" }) }],
    ["a conflicting runtime", { target, inspection: inspection({ target, conflicts: true }) }],
    [
      "the bootstrap helper left behind",
      { target, inspection: inspection({ target, helperPresent: true }) },
    ],
    ["an unrecognised device", { target, inspection: inspection({ target, recognized: false }) }],
  ];

  for (const [description, options] of cases) {
    assert.equal(decideInstallMigration(options).kind, "blocked", description);
  }
});

/* ── keep-data update eligibility ─────────────────────────────────────────── */

/*
 * The in-place paths do not update anything themselves. They ask the installer
 * already on the Pin to keep each package's data across the update, and that
 * installer only does so for packages it owns — which it decides from the APK
 * path, not the package name:
 *
 *   pin/injector/installer/src/main/kotlin/com/penumbraos/systeminjector/StagingSafety.kt:30-33
 *     uid % PER_USER_RANGE == SYSTEM_SHARED_USER_ID &&
 *     sourceDir == "/data/app/$packageName-injected/base.apk"
 *
 * On 2026-08-10 that cost a real install. hook and injector were at their
 * `-injected` paths; com.penumbraos.server had been updated separately and was
 * at an Android-randomized path. All four packages reported healthy, the
 * decision planned an in-place keep-data update of all three runtime packages,
 * and the provider answered UPDATE_NOT_ELIGIBLE — after 200+ MiB of APKs had
 * been pushed to the device. The batch is all-or-nothing, so one package
 * decided the whole install.
 *
 * These guards hold the decision to that rule, and hold it to the ONE state the
 * provider's narrow failed-update-continuity hatch exists to admit.
 */

const INJECTED_SERVER_PATH = `/data/app/${MANAGED_PACKAGES.server}-injected/base.apk`;
/* The shape Android gives a package it installed itself, as seen on the Pin. */
const RANDOMIZED_SERVER_PATH =
  `/data/app/~~VjYu5htQ0k7cJ2rF1xAbcw==/${MANAGED_PACKAGES.server}-7WySQfMv3nR0pLzKdE9xTA==/base.apk`;

test("inspectInstallState reads the running APK path and app id out of the package dump", async () => {
  const target = createResolvedInstallTargetFixture();
  const result = await inspectInstallState(
    fakeDevice(
      deviceShell({
        // The same dump the device gives, with the one field that differs on a
        // package something else updated: its code path.
        "dumpsys package com.penumbraos.server": OK(
          [
            `Package [${MANAGED_PACKAGES.server}] (1a2b3c4):`,
            "    userId=1000",
            `    pkg=Package{5d6e7f8 ${MANAGED_PACKAGES.server}}`,
            "    codePath=/data/app/~~VjYu5htQ0k7cJ2rF1xAbcw==/com.penumbraos.server-7WySQfMv3nR0pLzKdE9xTA==",
            // Behind the target, so this is a package the installer would be
            // asked to update — not one whose bytes could still match a staged
            // APK, which is the only randomized-path state the provider's
            // continuity hatch can admit.
            "    versionName=2026-04-28.0",
            "    PackageSignatures{a signatures:[dd07f452]}",
            "",
          ].join("\n"),
        ),
      }),
    ),
    { target, readinessSettleDelayMs: 0 },
  );

  assert.equal(result.packages.hook.appId, 1000);
  assert.equal(
    result.packages.hook.baseApkPath,
    `/data/app/${MANAGED_PACKAGES.hook}-injected/base.apk`,
  );
  assert.equal(result.packages.hook.keepDataUpdateVerdict, "eligible");

  assert.equal(result.packages.server.appId, 1000);
  assert.equal(result.packages.server.baseApkPath, RANDOMIZED_SERVER_PATH);
  // Healthy and at the right version, and still not updatable in place.
  assert.equal(result.packages.server.healthy, true);
  assert.equal(result.packages.server.keepDataUpdateVerdict, "foreign-artifact");
});

/*
 * These packages run under the `android.uid.system` shared user, so their dump
 * states the app id twice — once in the Package record and once in the shared
 * user record at the end. Repeating the SAME value is not ambiguity, and
 * treating it as ambiguity would answer "unreadable" for every managed package
 * on a real Pin, which fails every install closed for no reason. Genuinely
 * disagreeing values still answer null.
 */
test("the dump parsers tolerate a repeated app id and refuse a contradictory one", () => {
  const sharedUidDump = [
    `Package [${MANAGED_PACKAGES.server}] (1a2b3c4):`,
    "    userId=1000",
    `    codePath=/data/app/${MANAGED_PACKAGES.server}-injected`,
    "    versionName=2026-04-29.1",
    "Shared users:",
    "  SharedUser [android.uid.system] (9f8e7d6):",
    "    userId=1000",
  ].join("\r\n");

  assert.equal(parseInstalledAppIdFromDumpsys(sharedUidDump), 1000);
  assert.equal(parseInstalledBaseApkPathFromDumpsys(sharedUidDump), INJECTED_SERVER_PATH);

  const contradictory = `    userId=1000\n    userId=10123\n    codePath=/data/app/a\n`;
  assert.equal(parseInstalledAppIdFromDumpsys(contradictory), null);
  assert.equal(parseInstalledAppIdFromDumpsys(""), null);
  assert.equal(parseInstalledBaseApkPathFromDumpsys("versionName=2026-04-29.1"), null);
});

/*
 * The code-path side of the same property, which the app-id test above does not
 * reach. This is not symmetry for its own sake: a package that shipped in the
 * system image and was later updated is printed TWICE by `dumpsys package` —
 * once under `Packages:` at its update path and once under `Hidden system
 * packages:` at its /system path — and the two codePaths disagree. Answering
 * the first one would let the reader pick whichever record dumpsys happened to
 * print first and call the result proof of ownership. Disagreement is not
 * knowledge, so it answers null, which the decision refuses closed.
 */
test("the code-path parser refuses a dump that reports two different code paths", () => {
  const updatedSystemPackage = [
    "Packages:",
    `  Package [${MANAGED_PACKAGES.server}] (1a2b3c4):`,
    "    userId=1000",
    `    codePath=/data/app/${MANAGED_PACKAGES.server}-injected`,
    "    versionName=2026-04-29.1",
    "Hidden system packages:",
    `  Package [${MANAGED_PACKAGES.server}] (7e6d5c4):`,
    "    userId=1000",
    `    codePath=/system/priv-app/${MANAGED_PACKAGES.server}`,
  ].join("\n");

  assert.equal(parseInstalledCodePathFromDumpsys(updatedSystemPackage), null);
  assert.equal(parseInstalledBaseApkPathFromDumpsys(updatedSystemPackage), null);

  // The same value printed twice is still one answer — the shared-uid case the
  // test above pins for the app id, held here for the code path too.
  const repeated = [
    `    codePath=/data/app/${MANAGED_PACKAGES.server}-injected`,
    `    codePath=/data/app/${MANAGED_PACKAGES.server}-injected`,
  ].join("\n");
  assert.equal(parseInstalledBaseApkPathFromDumpsys(repeated), INJECTED_SERVER_PATH);
});

/*
 * Both parsers read a whole line or nothing. `dumpsys package` is a field-per-
 * line format and the injector CLI that runs against this Pin anchors the same
 * way (pin/injector/cli/src/adb.ts:302-309, `/^\s+codePath=(\S+)\s*$/`). Without
 * the anchors the readers would harvest `codePath=`/`userId=` out of the middle
 * of any line that happened to contain the text — a flag list, a nested
 * `Package{...}` render, a truncated record — and hand the decision a value that
 * was never a field. That is how a foreign artifact gets read as owned.
 */
test("the dump parsers read a whole line or nothing", () => {
  const midLineOnly = [
    `  pkg=Package{5d6e7f8 ${MANAGED_PACKAGES.server} codePath=/data/app/decoy userId=10123}`,
    "  flags=[ SYSTEM HAS_CODE ] userId=999",
  ].join("\n");
  assert.equal(parseInstalledCodePathFromDumpsys(midLineOnly), null);
  assert.equal(parseInstalledBaseApkPathFromDumpsys(midLineOnly), null);
  assert.equal(parseInstalledAppIdFromDumpsys(midLineOnly), null);

  // A real field plus the same decoys: the field is the answer, and the decoys
  // neither override it nor make it ambiguous.
  const fieldPlusDecoys = [
    `  Package [${MANAGED_PACKAGES.server}] (1a2b3c4):`,
    "    userId=1000",
    `    pkg=Package{5d6e7f8 ${MANAGED_PACKAGES.server} codePath=/data/app/decoy userId=10123}`,
    `    codePath=/data/app/${MANAGED_PACKAGES.server}-injected`,
  ].join("\n");
  assert.equal(parseInstalledBaseApkPathFromDumpsys(fieldPlusDecoys), INJECTED_SERVER_PATH);
  assert.equal(parseInstalledAppIdFromDumpsys(fieldPlusDecoys), 1000);
});

test("isEligibleForKeepDataUpdate mirrors the staging provider's own rule", () => {
  const packageName = MANAGED_PACKAGES.server;
  const eligible = (appId, baseApkPath) =>
    isEligibleForKeepDataUpdate({ packageName, appId, baseApkPath });

  assert.equal(eligible(1000, INJECTED_SERVER_PATH), true);
  // StagingSafety.kt compares `uid % PER_USER_RANGE`, so the same system app id
  // under a secondary Android user is the same answer.
  assert.equal(eligible(101_000, INJECTED_SERVER_PATH), true);
  assert.equal(eligible(10_123, INJECTED_SERVER_PATH), false);
  /*
   * The range itself, not just the remainder. 11000 is a uid in Android's
   * FIRST user, and an ordinary app there — it is only the system app id if the
   * range is wrong. Every other uid in this table divides the same way under a
   * too-small PER_USER_RANGE, so without this line the constant is free.
   */
  assert.equal(eligible(11_000, INJECTED_SERVER_PATH), false);
  assert.equal(eligible(200_999, INJECTED_SERVER_PATH), false);
  assert.equal(eligible(1000, RANDOMIZED_SERVER_PATH), false);
  assert.equal(eligible(1000, `/data/app/${packageName}-injected/split_a.apk`), false);
  assert.equal(eligible(1000, null), false);
  assert.equal(eligible(null, INJECTED_SERVER_PATH), false);

  assert.equal(isSafeRandomizedBaseApkPath(packageName, RANDOMIZED_SERVER_PATH), true);
  assert.equal(isSafeRandomizedBaseApkPath(packageName, INJECTED_SERVER_PATH), false);
  assert.equal(
    isSafeRandomizedBaseApkPath(packageName, `/data/app/${packageName}-1/base.apk`),
    false,
  );
  /*
   * StagingSafety.kt:89 builds each randomized segment from `[A-Za-z0-9_-]`,
   * which is exactly Android's base64url alphabet and admits no separator. A
   * looser token would let a path with extra directories, or a traversal, wear
   * the shape the continuity hatch trusts — and this predicate's only job is to
   * decide whether the decision keeps quiet about a path.
   */
  assert.equal(
    isSafeRandomizedBaseApkPath(
      packageName,
      `/data/app/~~VjYu5htQ0k7cJ2rF1xAbcw==/elsewhere/${packageName}-7WySQfMv3nR0pLzKdE9xTA==/base.apk`,
    ),
    false,
  );
  assert.equal(
    isSafeRandomizedBaseApkPath(
      packageName,
      `/data/app/~~a.b/${packageName}-7WySQfMv3nR0pLzKdE9xTA==/base.apk`,
    ),
    false,
  );
});

/*
 * The continuity hatch is the one place this module says "not my call", so what
 * it passes through has to be exactly what the provider's own hatch could admit
 * and nothing wider. FailedUpdateContinuityPolicy.hasRequiredProvenance
 * (StagingSafety.kt:48-60) requires uid == SYSTEM_UID before it looks at the
 * path at all. Dropping that leaves a hatch that admits an ordinary
 * user-installed app id sitting at a randomized path — which the provider
 * refuses, so the install would still die on the device with the APKs already
 * pushed, and the gate would have said nothing.
 */
test("the continuity hatch passes through only a system app id", () => {
  const packageName = MANAGED_PACKAGES.server;
  const version = "2026-04-29.1";
  const classify = (appId, baseApkPath, versionName = version) =>
    classifyKeepDataUpdate({
      packageName,
      appId,
      baseApkPath,
      versionName,
      targetVersion: version,
    });

  // The hatch's own shape, under the system app id: not decidable here, so not
  // refused here.
  assert.equal(classify(1000, RANDOMIZED_SERVER_PATH), "may-continue");
  // The same path and the same version under an ordinary app id is not the
  // hatch; it is the refusal the provider will answer.
  assert.equal(classify(10_123, RANDOMIZED_SERVER_PATH), "foreign-artifact");
  // A version behind the target cannot have matching bytes, so the hatch cannot
  // apply however the path is shaped.
  assert.equal(classify(1000, RANDOMIZED_SERVER_PATH, "2026-04-28.0"), "foreign-artifact");
  // A path that is neither owned nor hatch-shaped stays a refusal.
  assert.equal(classify(1000, "/data/app/com.penumbraos.server-2/base.apk"), "foreign-artifact");

  assert.equal(classify(1000, INJECTED_SERVER_PATH), "eligible");
  assert.equal(classify(null, INJECTED_SERVER_PATH), "unreadable");
  assert.equal(classify(1000, null), "unreadable");
});

/*
 * The app id has to be READ, not assumed. Every other dump in this file reports
 * 1000, so a capture chain that ignored the dump and returned the system app id
 * would satisfy all of them while removing the entire uid half of the staging
 * provider's rule. Here the path is the one the injector owns and the ONLY
 * disqualifying fact is the app id, so nothing but a real read can produce the
 * refusal.
 */
test("inspectInstallState reads a non-system app id off the dump rather than assuming one", async () => {
  const target = createResolvedInstallTargetFixture();
  const result = await inspectInstallState(
    fakeDevice(
      deviceShell({
        [`dumpsys package ${MANAGED_PACKAGES.server}`]: OK(
          [
            `Package [${MANAGED_PACKAGES.server}] (1a2b3c4):`,
            // Reinstalled by something that did not run as the system user, so
            // the package kept the injector's code path but not its app id.
            "    userId=10234",
            `    pkg=Package{5d6e7f8 ${MANAGED_PACKAGES.server}}`,
            `    codePath=/data/app/${MANAGED_PACKAGES.server}-injected`,
            `    versionName=${target.version}`,
            "    PackageSignatures{a signatures:[dd07f452]}",
            "",
          ].join("\n"),
        ),
      }),
    ),
    { target, readinessSettleDelayMs: 0 },
  );

  assert.equal(result.packages.server.appId, 10_234);
  assert.equal(result.packages.server.baseApkPath, INJECTED_SERVER_PATH);
  assert.equal(result.packages.server.keepDataUpdateVerdict, "foreign-artifact");
  // The sibling read from the ordinary fixture dump still reads the system app
  // id, so this is a read of two different dumps, not a constant either way.
  assert.equal(result.packages.hook.appId, 1000);
  assert.equal(result.packages.hook.keepDataUpdateVerdict, "eligible");
});

/*
 * And the app id has to reach the decision. Same inspection as the owned-path
 * case the gate lets through, with one integer changed.
 */
test("decideInstallMigration refuses an injector-owned path under a foreign app id", () => {
  const target = createResolvedInstallTargetFixture();
  const packageOverrides = Object.fromEntries(
    MANAGED_ROLES.map((role) => [
      role,
      { versionName: target.version, versionComparison: "equal" },
    ]),
  );
  packageOverrides.server = {
    ...packageOverrides.server,
    baseApkPath: INJECTED_SERVER_PATH,
    appId: 10_234,
    keepDataUpdateVerdict: "foreign-artifact",
  };

  const result = decideInstallMigration({
    target,
    inspection: inspection({ target, action: "Reinstall", packageOverrides }),
  });

  assert.equal(result.kind, "blocked");
  assert.deepEqual(result.rolesToInstall, []);
  assert.match(result.reason, /app id 10234/u);
  assert.match(result.reason, new RegExp(MANAGED_PACKAGES.server.replace(/\./gu, "\\.")));
});

/*
 * One fact changes between these two decisions: where the server's APK is. The
 * versions, the signer, the health and the target are identical, and that is
 * the point — every other input said "in-place update" on the day this failed.
 */
test("decideInstallMigration plans an in-place update only while the injector owns the APK", () => {
  const target = createResolvedInstallTargetFixture();

  const owned = decideInstallMigration({
    target,
    inspection: inspection({
      target,
      packageOverrides: { server: { baseApkPath: INJECTED_SERVER_PATH } },
    }),
  });
  assert.equal(owned.kind, "legacy-in-place");
  assert.ok(owned.rolesToInstall.includes("server"));

  const foreign = decideInstallMigration({
    target,
    inspection: inspection({
      target,
      packageOverrides: { server: { baseApkPath: RANDOMIZED_SERVER_PATH } },
    }),
  });
  assert.equal(foreign.kind, "blocked");
  assert.deepEqual(foreign.rolesToInstall, []);
  assert.match(foreign.reason, /com\.penumbraos\.server/);
  assert.ok(
    foreign.reason.includes(RANDOMIZED_SERVER_PATH),
    `the refusal must show where the APK actually is: ${foreign.reason}`,
  );
  assert.ok(
    foreign.reason.includes(INJECTED_SERVER_PATH),
    `the refusal must show where it would have to be: ${foreign.reason}`,
  );
});

/*
 * The state the device was actually in. Two of the three runtime packages were
 * at their `-injected` paths and one was not, which is precisely the shape that
 * survives every other check in this file.
 */
test("decideInstallMigration refuses the mixed profile that failed on hardware", () => {
  const target = createResolvedInstallTargetFixture();
  const result = decideInstallMigration({
    target,
    inspection: inspection({
      target,
      packageOverrides: { server: { baseApkPath: RANDOMIZED_SERVER_PATH } },
    }),
  });

  assert.equal(result.kind, "blocked");
  assert.deepEqual(result.rolesToInstall, []);
  // The two packages that WERE owned must not be named: reporting them as the
  // problem would send the operator after the wrong package.
  assert.doesNotMatch(result.reason, /com\.penumbraos\.hook/);
  assert.match(result.reason, /com\.penumbraos\.server/);
});

test("decideInstallMigration refuses a package whose APK path the device never reported", () => {
  const target = createResolvedInstallTargetFixture();
  const result = decideInstallMigration({
    target,
    inspection: inspection({
      target,
      packageOverrides: {
        server: { baseApkPath: null, appId: null, keepDataUpdateVerdict: "unreadable" },
      },
    }),
  });

  assert.equal(result.kind, "blocked");
  assert.match(result.reason, /com\.penumbraos\.server/);
  assert.match(result.reason, /did not report/);
});

/*
 * The provider examines the packages of the batch it was handed, and only those
 * that are still installed (StagingProvider.kt:548-585). A package that is
 * already at the target version is not in the batch, so its path is not the
 * installer's question and must not become this decision's answer.
 */
test("decideInstallMigration checks the APK path only for packages it is about to install", () => {
  const target = createResolvedInstallTargetFixture();
  const result = decideInstallMigration({
    target,
    inspection: inspection({
      target,
      packageOverrides: {
        server: {
          versionName: target.version,
          versionComparison: "equal",
          baseApkPath: `/data/app/${MANAGED_PACKAGES.server}-1/base.apk`,
          keepDataUpdateVerdict: "foreign-artifact",
        },
      },
    }),
  });

  assert.equal(result.kind, "legacy-in-place");
  assert.deepEqual(result.rolesToInstall, ["hook", "injector"]);
});

/*
 * The provider keeps one door open for a randomized path: an interrupted but
 * already-approved update, where the artifact still on disk is byte-identical
 * to the one being staged (FailedUpdateContinuityPolicy, StagingSafety.kt:41-101).
 * Three of its conditions live in the provider's own storage and cannot be read
 * over ADB, so this decision cannot say yes to it — but it must not say no,
 * either. A safe-shaped randomized path on a package already reporting the
 * target version is the only client-visible form that state can take.
 */
test("decideInstallMigration leaves the provider's failed-update continuity door open", () => {
  const target = createResolvedInstallTargetFixture();
  const packageOverrides = Object.fromEntries(
    MANAGED_ROLES.map((role) => [
      role,
      { versionName: target.version, versionComparison: "equal" },
    ]),
  );
  packageOverrides.server = {
    ...packageOverrides.server,
    baseApkPath: RANDOMIZED_SERVER_PATH,
    keepDataUpdateVerdict: "may-continue",
  };

  const result = decideInstallMigration({
    target,
    // Reinstall, so the server is in the batch rather than filtered out of it.
    inspection: inspection({ target, action: "Reinstall", packageOverrides }),
  });

  assert.equal(result.kind, "routine-in-place");
  assert.deepEqual(result.rolesToInstall, IN_PLACE_ROLES);
});

/*
 * The canonical path asks the same installer for the same favour, so it is held
 * to the same rule. A Reinstall is the case that matters here: it puts every
 * runtime package in the batch regardless of version, so a foreign artifact
 * cannot be filtered out of the way.
 */
test("decideInstallMigration refuses a foreign APK path on the canonical reinstall path too", () => {
  const target = createResolvedInstallTargetFixture();
  const packageOverrides = Object.fromEntries(
    MANAGED_ROLES.map((role) => [
      role,
      { versionName: target.version, versionComparison: "equal" },
    ]),
  );
  packageOverrides.server = {
    ...packageOverrides.server,
    // Not the randomized shape the continuity hatch can admit: a plain foreign
    // path, which the provider refuses outright.
    baseApkPath: `/data/app/${MANAGED_PACKAGES.server}-1/base.apk`,
    keepDataUpdateVerdict: "foreign-artifact",
  };

  const result = decideInstallMigration({
    target,
    inspection: inspection({ target, action: "Reinstall", packageOverrides }),
  });

  assert.equal(result.kind, "blocked");
  assert.deepEqual(result.rolesToInstall, []);
  assert.match(result.reason, /com\.penumbraos\.server/);
});

/*
 * Recovery is the path that CAN move a package off a foreign path: it
 * uninstalls the managed packages first, so the provider sees no installed
 * package to refuse an update for. Blocking it would leave a device in this
 * state with no route forward at all.
 */
test("decideInstallMigration still routes a foreign APK path to recovery when the installer is unhealthy", () => {
  const target = createResolvedInstallTargetFixture();
  const result = decideInstallMigration({
    target,
    inspection: inspection({
      target,
      packageOverrides: {
        installer: { healthy: false },
        server: { baseApkPath: RANDOMIZED_SERVER_PATH },
      },
    }),
  });

  assert.equal(result.kind, "bootstrap-recovery");
  assert.deepEqual(result.rolesToInstall, IN_PLACE_ROLES);
});

test("a package the installer cannot update in place never reads as up to date", () => {
  const target = createResolvedInstallTargetFixture();
  const foreign = snapshot("server", target, {
    versionName: target.version,
    versionComparison: "equal",
    baseApkPath: RANDOMIZED_SERVER_PATH,
    keepDataUpdateVerdict: "foreign-artifact",
  });

  assert.equal(getManagedPackageStatusText(foreign), "Update Blocked");
  assert.equal(hasProblematicManagedPackageState(foreign), true);
  assert.equal(getManagedPackageStatusTone(foreign), "warning");

  const unreadable = snapshot("server", target, {
    versionName: target.version,
    versionComparison: "equal",
    baseApkPath: null,
    appId: null,
    keepDataUpdateVerdict: "unreadable",
  });
  assert.equal(getManagedPackageStatusText(unreadable), "APK Path Unreadable");
  assert.equal(hasProblematicManagedPackageState(unreadable), true);

  // And the owned package is still allowed to say it is fine.
  const owned = snapshot("server", target, {
    versionName: target.version,
    versionComparison: "equal",
  });
  assert.equal(getManagedPackageStatusText(owned), "Up to Date");
  assert.equal(hasProblematicManagedPackageState(owned), false);
});

/* ── recognition ──────────────────────────────────────────────────────────── */

/*
 * Exact match, no case folding and no defaulting. Everything downstream — the
 * migration gate above included — treats a recognised device as one it may
 * write system packages to, so a loose match here is a loose match everywhere.
 */
test("isRecognizedAiPin requires exact manufacturer and model matches", () => {
  assert.equal(isRecognizedAiPin({ manufacturer: "Humane", model: "Ai Pin" }), true);
  assert.equal(isRecognizedAiPin({ manufacturer: "humane", model: "Ai Pin" }), false);
  assert.equal(isRecognizedAiPin({ manufacturer: "Humane", model: "Ai pin" }), false);
  assert.equal(isRecognizedAiPin({ manufacturer: undefined, model: "Ai Pin" }), false);
});

test("decideInstallMigration resumes a device left mid-migration by an interrupted install", () => {
  // The state this Pin was actually in: hook and injector updated to a PREVIOUS
  // published release, the server gone, the installer still legacy. An install
  // that pushes 200 MiB per role and restarts system_server has a real window in
  // which to be interrupted, so this is an ordinary outcome, not an exotic one.
  // Admitting only "the legacy version or the exact target" left such a device
  // permanently blocked by the rule meant to protect it.
  const target = createResolvedInstallTargetFixture();
  const result = decideInstallMigration({
    target,
    inspection: inspection({
      target,
      packageOverrides: {
        // Older than the fixture target (2026-04-29.1) on purpose: a genuinely
        // newer installed role is a downgrade, not a resumable migration, and is
        // covered by its own case below.
        hook: { versionName: "2026-04-28.1", versionComparison: "older" },
        injector: { versionName: "2026-04-28.1", versionComparison: "older" },
        server: {
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
    }),
  });

  assert.equal(result.kind, "legacy-in-place");
  assert.deepEqual(result.rolesToInstall, IN_PLACE_ROLES);
});

test("decideInstallMigration still refuses a package of unknown provenance", () => {
  // The rule protects against a package this installer did not put there. A
  // version that does not parse as a release version is exactly that, and it must
  // still refuse — widening the rule for the interrupted-install case must not
  // widen it into "anything goes".
  const target = createResolvedInstallTargetFixture();
  const result = decideInstallMigration({
    target,
    inspection: inspection({
      target,
      packageOverrides: {
        hook: { versionName: "someone-elses-build", versionComparison: null },
      },
    }),
  });

  assert.equal(result.kind, "blocked");
  assert.match(result.reason, /does not match its exact migration baseline/u);
});

test("decideInstallMigration refuses to silently downgrade a newer installed role", () => {
  // Newer-than-target is not a resumable mid-migration state, it is a downgrade,
  // and keep-data downgrades are how a device ends up running code older than its
  // own stored data expects.
  const target = createResolvedInstallTargetFixture();
  const result = decideInstallMigration({
    target,
    inspection: inspection({
      target,
      packageOverrides: {
        hook: { versionName: "2099-01-01.9", versionComparison: "newer" },
      },
    }),
  });

  assert.equal(result.kind, "blocked");
  assert.match(result.reason, /does not match its exact migration baseline/u);
});
