import assert from "node:assert/strict";
import test from "node:test";

import { describePlan } from "../pin/install.mjs";

function capturePlan(plan) {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    describePlan(plan, { version: "2026-08-24.1" });
  } finally {
    process.stdout.write = originalWrite;
  }
  return output;
}

function routinePlan(overrides = {}) {
  return {
    kind: "routine-in-place",
    packageRoles: ["hook"],
    expectedExistingPackageNames: ["com.penumbraos.hook"],
    requiredAssetRoles: ["hookApk"],
    retainedInstaller: {
      versionName: "2026-08-23.1",
      signerIdentity: "dd07f452",
    },
    verificationPolicy: { mode: "in-place" },
    shouldRunPreinstallCleanup: false,
    shouldCleanupManagedPackages: false,
    shouldBootstrapInstaller: false,
    shouldDisableConfiguredPackages: false,
    shouldSetHomeActivity: false,
    ...overrides,
  };
}

test("headless Pin plan renders the fresh plan's required APKs", () => {
  const output = capturePlan(routinePlan());

  assert.match(output, /packages\s+hook/);
  assert.match(output, /assets to load\s+hookApk/);
  assert.match(output, /load and re-verify 1 APK from the local store/);
  assert.doesNotMatch(output, /serverApk/);
});

test("headless Pin plan renders a no-op plan without crashing", () => {
  const output = capturePlan(
    routinePlan({ packageRoles: [], requiredAssetRoles: [] }),
  );

  assert.match(output, /packages\s+\(none; already at target\)/);
  assert.match(output, /assets to load\s+\(none\)/);
  assert.match(output, /load and re-verify 0 APKs from the local store/);
});
