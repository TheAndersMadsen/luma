// Unit tests for the host doctor. No device, no network, no subprocess: every
// test drives the pure `evaluate(probes)` decision layer with injected probe
// results, so a "healthy host" and a "nothing installed" host are both
// reproducible on any machine.
//
// Host expectations come from the exact toolchain contract and root Rust pin.
//
// Run: node --test platform/containers/pin-builder/doctor.test.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ANDROID_RUST_TARGET,
  CHECK_STATUS,
  GATED_BUILD_ASSETS,
  REQUIRED_SIGNING_KEYS,
  STOCK_EVIDENCE_RELATIVE_PATH,
  abbreviateHome,
  compareVersions,
  evaluate,
  nextStepLine,
  parseAdbDevices,
  parseCliArgs,
  parseCommandVersion,
  parseEnvKeyNames,
  parseGatedAssetPins,
  parseJavaVersion,
  parseNdkRevision,
  parseDockerBuildxPlatforms,
  parsePinBuilderDockerfileContract,
  parsePinBuilderToolchainContract,
  parsePinGradleToolchainConsumers,
  parseRequirementsFromToolchain,
  parseRustToolchainContract,
  parseRustToolchainToml,
  parseSdkDir,
  pinBuilderToolchainMismatches,
  renderHuman,
  renderJson,
  resolveGatedAssets,
  resolveSigningEnvPath,
  usage,
} from "./doctor.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../pin");
const PRODUCT_ROOT = resolve(REPO_ROOT, "..");

// A value that must never survive from a probe into any rendered output.
// Synthetic: it is not a credential and never touches disk.
const FAKE_SECRET = "not-a-real-password-9f3c1a";

// A synthetic home directory. The username inside it is what MINOR C is about:
// it must never appear in a report the tool invites users to paste publicly.
const FAKE_HOME_USER = "fixture-operator";
const FAKE_HOME = `${String.fromCodePoint(47)}Users/${FAKE_HOME_USER}`;
const POSIX_HOME_ROOT = ["", "home"].join("/");

// Sixty-four hex characters, unrelated to any real artifact — these fixtures
// assert digest COMPARISON, not any particular published digest.
const FIXTURE_DIGEST = "a".repeat(64);
const WRONG_DIGEST = "b".repeat(64);

function realPinGradleFiles() {
  const files = {};
  const visit = (absolute, releasePath) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || [".gradle", ".kotlin", "build", "target"].includes(entry.name)) {
        continue;
      }
      const child = join(absolute, entry.name);
      const childPath = `${releasePath}/${entry.name}`;
      if (entry.isDirectory()) visit(child, childPath);
      else if (entry.isFile() && entry.name === "build.gradle.kts") {
        files[childPath] = readFileSync(child, "utf8");
      }
    }
  };
  visit(REPO_ROOT, "pin");
  return files;
}

/** A gated-asset probe entry in the state the doctor should call healthy. */
function healthyGatedAssets(overrides = {}) {
  return GATED_BUILD_ASSETS.map((spec) => ({
    id: spec.id,
    path: spec.fallbackPath,
    pathSource: "runtime/android/build.gradle.kts:45",
    exists: true,
    sizeBytes: spec.observedBytes,
    expectedSha256: FIXTURE_DIGEST,
    expectedSha256Ref: "runtime/android/build.gradle.kts:47",
    actualSha256: FIXTURE_DIGEST,
    ...(overrides[spec.id] ?? {}),
  }));
}

// All fixture version strings are synthetic placeholders chosen only so the
// comparisons under test are unambiguous. They are not claims about any real
// released toolchain.
function healthyProbes(overrides = {}) {
  return {
    repoRoot: "/fixture/repo",
    requirements: {
      jdkMajor: 17,
      androidSdkApi: 34,
      ndkLabel: "r28c",
      ndkMajor: 28,
      nodeMinimum: "20.19.0",
      sourceRef: "platform/containers/pin-builder/toolchain.json",
    },
    rustToolchain: {
      expectedVersion: "1.91.1",
      rootVersion: "1.91.1",
    },
    builderToolchain: { mismatches: [] },
    node: { version: "22.0.0" },
    containerBuilder: {
      available: true,
      version: "29.0.0-fixture",
      contractFilesPresent: true,
      suppliesHostToolchain: false,
      requiredPlatform: "linux/amd64",
      platformsDetermined: true,
      platforms: ["linux/amd64", "linux/arm64"],
      amd64Runtime: { safe: true, detail: "native fixture" },
    },
    java: { present: true, version: "17.0.0", major: 17 },
    androidSdk: {
      path: "/fixture/sdk",
      source: "local.properties sdk.dir",
      exists: true,
      platforms: ["android-34"],
      buildTools: ["35.0.0"],
    },
    adb: {
      present: true,
      path: "/fixture/sdk/platform-tools/adb",
      version: "Android Debug Bridge version 1.0.41",
      command: "/fixture/sdk/platform-tools/adb",
    },
    ndk: {
      path: "/fixture/sdk/ndk/28.0.0",
      source: "Android SDK ndk/ directory",
      revision: "28.0.0",
      candidates: ["28.0.0"],
    },
    rustc: { present: true, version: "rustc 1.91.1 (fixture)" },
    cargo: { present: true, version: "cargo 1.91.1 (fixture)" },
    rustTarget: { determined: true, installed: true, source: "rustup" },
    cargoNdk: { present: true, version: "cargo-ndk 4.1.2", expectedVersion: "4.1.2" },
    protoc: { present: true, version: "libprotoc 0.0.0-fixture" },
    stockEvidence: { exists: true, path: STOCK_EVIDENCE_RELATIVE_PATH },
    gatedAssets: healthyGatedAssets(),
    signingEnv: {
      exists: true,
      path: "secrets/pin-signing.env",
      keys: [...REQUIRED_SIGNING_KEYS],
      mode: 0o600,
    },
    // A healthy host for a RELEASE has the four variables exported, not merely
    // written to the file. The two facts are reported separately on purpose.
    signingEnvironment: { exported: [...REQUIRED_SIGNING_KEYS], fileComplete: true },
    // Baseline is the state this doctor must tolerate: no Pin attached.
    devices: { adbAvailable: true, counts: { ready: 0, unauthorized: 0, other: 0 } },
    ...overrides,
  };
}

function checkById(result, id) {
  const found = result.checks.find((check) => check.id === id);
  assert.ok(found, `expected a check with id ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

test("healthy host with no device passes every required check", () => {
  const result = evaluate(healthyProbes());
  assert.equal(result.ok, true);
  assert.equal(result.counts.fail, 0);
  assert.deepEqual(result.blocking, []);
  for (const check of result.checks) {
    assert.notEqual(check.status, CHECK_STATUS.FAIL, `${check.id} should not fail on a healthy host`);
  }
});

test("evaluate reports every check rather than stopping at the first miss", () => {
  const result = evaluate(
    healthyProbes({
      protoc: { present: false, version: null },
      cargoNdk: { present: false, version: null },
      rustc: { present: false, version: null },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.counts.fail, 3);
  assert.deepEqual([...result.blocking].sort(), ["cargo_ndk", "protoc", "rustc"]);
});

test("missing stock evidence is a loud non-blocking warning", () => {
  const result = evaluate(
    healthyProbes({
      stockEvidence: { exists: false, path: STOCK_EVIDENCE_RELATIVE_PATH },
    }),
  );
  const check = checkById(result, "stock_decompile_evidence");
  assert.equal(check.status, CHECK_STATUS.WARN);
  assert.match(check.detail, /SKIP loudly/);
  assert.match(check.fix, /tier-a-registry\.test\.mjs/);
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// A missing REQUIRED tool must flip ok to false — one test per tool, so a
// regression names the tool it broke.
// ---------------------------------------------------------------------------

for (const [label, id, overrides] of [
  ["protoc", "protoc", { protoc: { present: false, version: null } }],
  ["cargo-ndk", "cargo_ndk", { cargoNdk: { present: false, version: null } }],
  ["rustc", "rustc", { rustc: { present: false, version: null } }],
  ["cargo", "cargo", { cargo: { present: false, version: null } }],
  ["the JDK", "jdk", { java: { present: false, version: null, major: null } }],
  [
    "the aarch64-linux-android target",
    "rust_target_android",
    { rustTarget: { determined: true, installed: false, source: "rustup" } },
  ],
  [
    "the Android SDK",
    "android_sdk",
    { androidSdk: { path: null, source: null, exists: false, platforms: [], buildTools: [] } },
  ],
  ["adb / platform-tools", "android_platform_tools", { adb: { present: false, path: null, version: null, command: null } }],
  ["the NDK", "android_ndk", { ndk: { path: null, source: null, revision: null, candidates: [] } }],
]) {
  test(`missing ${label} is a required failure and makes ok false`, () => {
    const result = evaluate(healthyProbes(overrides));
    const check = checkById(result, id);
    assert.equal(check.status, CHECK_STATUS.FAIL);
    assert.equal(check.required, true);
    assert.ok(check.fix.length > 0, "a failing check must contain an actionable fix");
    assert.equal(result.ok, false);
    assert.ok(result.blocking.includes(id));
  });
}

test("the pinned container makes host SDK, NDK, JDK, Rust, and protoc optional", () => {
  const result = evaluate(healthyProbes({
    containerBuilder: {
      available: true,
      version: "29.0.0-fixture",
      contractFilesPresent: true,
      suppliesHostToolchain: true,
      requiredPlatform: "linux/amd64",
      platformsDetermined: true,
      platforms: ["linux/amd64"],
      amd64Runtime: { safe: true, detail: "native fixture" },
    },
    java: { present: false, version: null, major: null },
    androidSdk: { path: null, source: null, exists: false, platforms: [], buildTools: [] },
    adb: { present: false, path: null, version: null, command: null },
    ndk: { path: null, source: null, revision: null, candidates: [] },
    rustc: { present: false, version: null },
    cargo: { present: false, version: null },
    rustTarget: { determined: true, installed: false, source: "rustup" },
    cargoNdk: { present: false, version: null },
    protoc: { present: false, version: null },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.buildPath, "pinned-container");
  for (const id of ["jdk", "android_sdk", "android_platform_tools", "android_ndk", "rustc", "cargo", "rust_target_android", "cargo_ndk", "protoc"]) {
    const check = checkById(result, id);
    assert.equal(check.status, CHECK_STATUS.WARN, id);
    assert.equal(check.required, false, id);
  }
});

test("the pinned container requires the host-native Buildx platform", () => {
  const unsupported = evaluate(healthyProbes({
    containerBuilder: {
      ...healthyProbes().containerBuilder,
      requiredPlatform: "linux/arm64",
      platforms: ["linux/amd64"],
    },
  }));
  assert.equal(checkById(unsupported, "container_builder").status, CHECK_STATUS.FAIL);
  assert.match(checkById(unsupported, "container_builder").detail, /linux\/arm64/u);

  const nativeArm = evaluate(healthyProbes({
    containerBuilder: {
      ...healthyProbes().containerBuilder,
      requiredPlatform: "linux/arm64",
      platforms: ["linux/arm64"],
      amd64Runtime: { safe: false, detail: "irrelevant on a native ARM build" },
    },
  }));
  assert.equal(checkById(nativeArm, "container_builder").status, CHECK_STATUS.PASS);

  const unknown = evaluate(healthyProbes({
    containerBuilder: {
      ...healthyProbes().containerBuilder,
      platformsDetermined: false,
      platforms: [],
    },
  }));
  assert.equal(checkById(unknown, "container_builder").status, CHECK_STATUS.FAIL);
  assert.deepEqual(
    parseDockerBuildxPlatforms("Name: fixture\nPlatforms: linux/arm64, linux/amd64*, linux/amd64/v2\n"),
    ["linux/arm64", "linux/amd64", "linux/amd64/v2"],
  );
});

test("known-bad ARM QEMU is a required failure before an expensive Pin consumer", () => {
  const result = evaluate(healthyProbes({
    containerBuilder: {
      ...healthyProbes().containerBuilder,
      amd64Runtime: {
        safe: false,
        detail: "registered qemu-x86_64 8.2.2 is in the known-bad 8.x line",
        guidance: "Use a native hosted linux/amd64 runner; do not alter binfmt.",
      },
    },
  }));
  const check = checkById(result, "container_builder");
  assert.equal(check.status, CHECK_STATUS.FAIL);
  assert.equal(check.required, true);
  assert.match(check.detail, /known-bad 8\.x/u);
  assert.match(check.fix, /native hosted linux\/amd64.*do not alter binfmt/u);
});

test("a Node runtime below the contracted minimum is a required failure", () => {
  const result = evaluate(healthyProbes({ node: { version: "18.20.0" } }));
  const check = checkById(result, "node");
  assert.equal(check.status, CHECK_STATUS.FAIL);
  assert.equal(result.ok, false);
  assert.match(check.fix, /20\.19\.0/);
});

test("an Android SDK path that does not exist is a required failure", () => {
  const result = evaluate(
    healthyProbes({
      androidSdk: {
        path: "/fixture/missing-sdk",
        source: "ANDROID_HOME",
        exists: false,
        platforms: [],
        buildTools: [],
      },
    }),
  );
  assert.equal(checkById(result, "android_sdk").status, CHECK_STATUS.FAIL);
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// A missing device must NEVER fail — the doctor's whole premise.
// ---------------------------------------------------------------------------

test("no attached Pin does not make ok false", () => {
  const result = evaluate(
    healthyProbes({ devices: { adbAvailable: true, counts: { ready: 0, unauthorized: 0, other: 0 } } }),
  );
  const check = checkById(result, "pin_device");
  assert.equal(check.status, CHECK_STATUS.WARN);
  assert.equal(check.required, false);
  assert.equal(result.ok, true);
});

test("an unavailable adb leaves the device check informational, never failing", () => {
  const result = evaluate(
    healthyProbes({
      adb: { present: false, path: null, version: null, command: null },
      devices: { adbAvailable: false, counts: { ready: 0, unauthorized: 0, other: 0 } },
    }),
  );
  const device = checkById(result, "pin_device");
  assert.equal(device.status, CHECK_STATUS.WARN);
  assert.equal(device.required, false);
  // adb itself is still a required host tool, so ok is false for THAT reason,
  // never because of the device check.
  assert.deepEqual(result.blocking, ["android_platform_tools"]);
});

test("an attached Pin is reported by count and never by serial", () => {
  const result = evaluate(
    healthyProbes({ devices: { adbAvailable: true, counts: { ready: 1, unauthorized: 0, other: 0 } } }),
  );
  const check = checkById(result, "pin_device");
  assert.equal(check.status, CHECK_STATUS.PASS);
  assert.equal(result.ok, true);
  assert.match(check.detail, /1 device/);
  assert.doesNotMatch(check.detail, /[0-9a-f]{8,}/i);
});

test("an unauthorized device is a warning, not a failure", () => {
  const result = evaluate(
    healthyProbes({ devices: { adbAvailable: true, counts: { ready: 0, unauthorized: 1, other: 0 } } }),
  );
  assert.equal(checkById(result, "pin_device").status, CHECK_STATUS.WARN);
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// NDK drift is a warning, not a blocker.
// ---------------------------------------------------------------------------

test("an NDK whose major differs from the contracted one is a warn, not a fail", () => {
  const result = evaluate(
    healthyProbes({
      ndk: {
        path: "/fixture/sdk/ndk/26.3.11579264",
        source: "Android SDK ndk/ directory",
        revision: "26.3.11579264",
        candidates: ["26.3.11579264"],
      },
    }),
  );
  const check = checkById(result, "android_ndk");
  assert.equal(check.status, CHECK_STATUS.WARN);
  assert.equal(check.required, false);
  assert.equal(result.ok, true);
  assert.match(check.detail, /26\.3\.11579264/);
  assert.match(check.detail, /r28c/);
  assert.match(check.fix, /not a blocker/);
});

test("a matching NDK major passes and cites the contracted label", () => {
  const check = checkById(evaluate(healthyProbes()), "android_ndk");
  assert.equal(check.status, CHECK_STATUS.PASS);
  assert.match(check.detail, /r28c/);
});

test("an NDK with no readable revision degrades to a warn rather than a false verdict", () => {
  const result = evaluate(
    healthyProbes({
      ndk: {
        path: "/fixture/custom-ndk",
        source: "ANDROID_NDK_ROOT",
        revision: null,
        candidates: [],
      },
    }),
  );
  assert.equal(checkById(result, "android_ndk").status, CHECK_STATUS.WARN);
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Unreadable requirements must degrade honestly, never invent a version.
// ---------------------------------------------------------------------------

test("unreadable toolchain requirements degrade version comparisons to warns without failing", () => {
  const result = evaluate(healthyProbes({ requirements: null }));
  assert.equal(result.ok, true);
  assert.equal(result.requirementsSource, null);
  assert.equal(checkById(result, "node").status, CHECK_STATUS.WARN);
  assert.equal(checkById(result, "android_ndk").status, CHECK_STATUS.WARN);
  // Tool presence is still judged, because it needs no documented version.
  assert.equal(checkById(result, "protoc").status, CHECK_STATUS.PASS);
});

test("missing tools still fail when the contracted requirements are unreadable", () => {
  const result = evaluate(
    healthyProbes({ requirements: null, protoc: { present: false, version: null } }),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.blocking, ["protoc"]);
});

// ---------------------------------------------------------------------------
// Signing env: presence and KEY NAMES only.
// ---------------------------------------------------------------------------

test("a complete signing env file passes and lists only variable names", () => {
  const check = checkById(evaluate(healthyProbes()), "signing_env");
  assert.equal(check.status, CHECK_STATUS.PASS);
  for (const name of REQUIRED_SIGNING_KEYS) assert.match(check.detail, new RegExp(name));
});

test("an absent signing env file is a warn and keeps ok true", () => {
  const result = evaluate(
    healthyProbes({ signingEnv: { exists: false, path: "secrets/pin-signing.env", keys: [], mode: null } }),
  );
  const check = checkById(result, "signing_env");
  assert.equal(check.status, CHECK_STATUS.WARN);
  assert.equal(check.required, false);
  assert.equal(result.ok, true);
});

test("a partial signing env file is a required failure", () => {
  const result = evaluate(
    healthyProbes({
      signingEnv: {
        exists: true,
        path: "secrets/pin-signing.env",
        keys: ["PIN_SIGNING_STORE_FILE", "PIN_SIGNING_KEY_ALIAS"],
        mode: 0o600,
      },
    }),
  );
  const check = checkById(result, "signing_env");
  assert.equal(check.status, CHECK_STATUS.FAIL);
  assert.equal(check.required, true);
  assert.equal(result.ok, false);
  assert.match(check.detail, /PARTIAL/);
  assert.match(check.fix, /configuration time/);
});

test("a world-readable signing env file is a warn about mode, not a failure", () => {
  const result = evaluate(
    healthyProbes({
      signingEnv: {
        exists: true,
        path: "secrets/pin-signing.env",
        keys: [...REQUIRED_SIGNING_KEYS],
        mode: 0o644,
      },
    }),
  );
  const check = checkById(result, "signing_env");
  assert.equal(check.status, CHECK_STATUS.WARN);
  assert.equal(result.ok, true);
  assert.match(check.fix, /chmod 600/);
});

// ---------------------------------------------------------------------------
// Signing ENVIRONMENT — distinct from the file. The file is what step 2 writes;
// the environment is what step 3 and Gradle actually read.
// ---------------------------------------------------------------------------

test("the canonical builder needs no signing exports in the ambient shell", () => {
  const result = evaluate(
    healthyProbes({ signingEnvironment: { exported: [], fileComplete: true } }),
  );
  const file = checkById(result, "signing_env");
  const exported = checkById(result, "signing_env_exported");

  // The protected file is authoritative; the root builder mounts it itself.
  assert.equal(file.status, CHECK_STATUS.PASS);
  assert.equal(exported.status, CHECK_STATUS.PASS);
  assert.equal(result.ok, true);
  assert.match(exported.detail, /read-only signing\.env mount/);
});

test("an exported signing environment warns and lists only recognized variable names", () => {
  const check = checkById(evaluate(healthyProbes()), "signing_env_exported");
  assert.equal(check.status, CHECK_STATUS.WARN);
  for (const name of REQUIRED_SIGNING_KEYS) assert.match(check.detail, new RegExp(name));
});

test("a PARTIAL ambient signing environment is non-authoritative and removable", () => {
  const result = evaluate(
    healthyProbes({
      signingEnvironment: { exported: ["PIN_SIGNING_STORE_FILE"], fileComplete: true },
    }),
  );
  const check = checkById(result, "signing_env_exported");
  assert.equal(check.status, CHECK_STATUS.WARN);
  assert.equal(check.required, false);
  assert.equal(result.ok, true);
  assert.ok(!result.blocking.includes("signing_env_exported"));
  assert.match(check.fix, /unset PIN_SIGNING_STORE_FILE/);
});

test("an empty environment remains correct even when the external file is absent", () => {
  const result = evaluate(
    healthyProbes({
      signingEnv: { exists: false, path: "secrets/pin-signing.env", keys: [], mode: null },
      signingEnvironment: { exported: [], fileComplete: false },
    }),
  );
  const check = checkById(result, "signing_env_exported");
  assert.equal(check.status, CHECK_STATUS.PASS);
  assert.equal(result.ok, true);
  assert.match(check.detail, /No signing values are exported/);
});

test("a poisoned exported list cannot leak into rendered output", () => {
  // Mirrors the file-side containment test: a regression that let a VALUE into
  // the name list still cannot reach output, because the check intersects with
  // REQUIRED_SIGNING_KEYS.
  const result = evaluate(
    healthyProbes({
      signingEnvironment: {
        exported: [...REQUIRED_SIGNING_KEYS, FAKE_SECRET],
        fileComplete: true,
      },
    }),
  );
  assert.equal(checkById(result, "signing_env_exported").status, CHECK_STATUS.WARN);
  assert.ok(!renderHuman(result, { verbose: true }).includes(FAKE_SECRET));
  assert.ok(!JSON.stringify(renderJson(result)).includes(FAKE_SECRET));
});

// ---------------------------------------------------------------------------
// Gated native build inputs — the prerequisite no script can install for you.
// ---------------------------------------------------------------------------

test("every gated asset has its own check, and all pass when present and pinned", () => {
  const result = evaluate(healthyProbes());
  for (const spec of GATED_BUILD_ASSETS) {
    const check = checkById(result, spec.id);
    assert.equal(check.status, CHECK_STATUS.PASS, `${spec.id} should pass when present`);
    assert.match(check.detail, /SHA-256 matches/);
  }
  assert.equal(result.ok, true);
});

for (const spec of GATED_BUILD_ASSETS) {
  test(`an absent ${spec.fallbackPath} is a required failure with an actionable fix`, () => {
    const result = evaluate(
      healthyProbes({
        gatedAssets: healthyGatedAssets({
          [spec.id]: { exists: false, sizeBytes: null, actualSha256: null },
        }),
      }),
    );
    const check = checkById(result, spec.id);
    assert.equal(check.status, CHECK_STATUS.FAIL);
    assert.equal(check.required, true);
    assert.equal(result.ok, false);
    assert.ok(result.blocking.includes(spec.id));

    // "Actionable" is asserted, not assumed: it must say the absence is
    // deliberate, name the file, and say what to do about it.
    assert.match(check.detail, new RegExp(spec.fallbackPath.replace(/[/.]/g, "\\$&")));
    assert.match(check.detail, /ABSENT/);
    assert.match(check.detail, /expected in canonical source/);
    assert.match(check.detail, /runtime\/android\/build\.gradle\.kts/);
    assert.match(check.fix, /Not fetchable by any script here/);
    assert.ok(check.fix.length > 200, "the fix must explain how to obtain the file, not just name it");
  });

  test(`a wrong ${spec.fallbackPath} fails on the digest rather than passing on presence`, () => {
    const result = evaluate(
      healthyProbes({
        gatedAssets: healthyGatedAssets({
          [spec.id]: { actualSha256: WRONG_DIGEST },
        }),
      }),
    );
    const check = checkById(result, spec.id);
    assert.equal(check.status, CHECK_STATUS.FAIL);
    assert.equal(check.required, true);
    assert.match(check.detail, new RegExp(WRONG_DIGEST));
    assert.match(check.detail, new RegExp(FIXTURE_DIGEST));
  });
}

test("the TFLite fix requires an external authorized asset without prescribing extraction", () => {
  const result = evaluate(
    healthyProbes({
      gatedAssets: healthyGatedAssets({
        gated_asset_tflite_runtime: { exists: false, sizeBytes: null, actualSha256: null },
      }),
    }),
  );
  const fix = checkById(result, "gated_asset_tflite_runtime").fix;
  assert.match(fix, /REVIVAL_TFLITE_RUNTIME_BINARY/);
  assert.match(fix, /external private-assets/);
  assert.match(fix, /does not distribute or prescribe extraction/);
});

test("a re-pinned asset passes on its digest when its size differs from the observation", () => {
  // The observed byte count and the Gradle digest are allowed to disagree:
  // re-pinning the TFLite runtime to a source build changes both, and only the
  // gradle digest gates the build. The verdict must follow the digest, and the
  // prior observation must be surfaced rather than turned into a failure.
  const spec = GATED_BUILD_ASSETS[0];
  const result = evaluate(
    healthyProbes({
      gatedAssets: healthyGatedAssets({
        [spec.id]: { sizeBytes: spec.observedBytes + 4096 },
      }),
    }),
  );
  const check = checkById(result, spec.id);
  assert.equal(check.status, CHECK_STATUS.PASS);
  assert.equal(result.ok, true);
  assert.match(check.detail, new RegExp(spec.observedBytesRef.replace(/[/.]/g, "\\$&")));
});

test("an unreadable present asset says so rather than reporting a digest mismatch", () => {
  const result = evaluate(
    healthyProbes({
      gatedAssets: healthyGatedAssets({
        gated_asset_tflite_runtime: { actualSha256: null },
      }),
    }),
  );
  const check = checkById(result, "gated_asset_tflite_runtime");
  assert.equal(check.status, CHECK_STATUS.FAIL);
  assert.match(check.detail, /unreadable file/);
});

test("a present asset with no readable pin is a warn, not a false pass or a false fail", () => {
  const result = evaluate(
    healthyProbes({
      gatedAssets: healthyGatedAssets({
        gated_asset_tflite_runtime: {
          expectedSha256: null,
          expectedSha256Ref: null,
          actualSha256: null,
        },
      }),
    }),
  );
  const check = checkById(result, "gated_asset_tflite_runtime");
  assert.equal(check.status, CHECK_STATUS.WARN);
  assert.equal(result.ok, true);
  assert.match(check.fix, /shasum -a 256/);
});

test("un-probed gated assets degrade to warns rather than inventing a verdict", () => {
  const result = evaluate(healthyProbes({ gatedAssets: [] }));
  for (const spec of GATED_BUILD_ASSETS) {
    const check = checkById(result, spec.id);
    assert.equal(check.status, CHECK_STATUS.WARN);
    assert.equal(check.required, false);
  }
  assert.equal(result.ok, true);
});

// The probe layer, against a real filesystem. Everything else in this file
// drives the pure decision layer, which cannot reach the one decision inside
// the probe: WHEN to hash. A synthetic repo root is used — no temp file here is
// a real artifact, and nothing outside the temp directory is touched.
test("resolveGatedAssets hashes on presence, not on a prior observed size", () => {
  const root = mkdtempSync(join(tmpdir(), "revival-pin-doctor-"));
  try {
    // Deliberately NOT `observedBytes` long: a re-pinned asset is a smaller
    // or larger file whose digest is what the build actually gates on.
    const body = Buffer.from("synthetic gated asset fixture, not a real binary\n");
    const digest = createHash("sha256").update(body).digest("hex");

    const gradle = [
      `val tfliteRuntimeSha256 = "${digest}"`,
    ].join("\n");

    mkdirSync(join(root, "runtime", "android"), { recursive: true });
    writeFileSync(join(root, "runtime", "android", "build.gradle.kts"), gradle);
    for (const spec of GATED_BUILD_ASSETS) {
      const target = join(root, spec.fallbackPath.replace(/^~\//, ""));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }

    const assets = resolveGatedAssets(root, root);
    assert.equal(assets.length, GATED_BUILD_ASSETS.length);
    for (const asset of assets) {
      const spec = GATED_BUILD_ASSETS.find((entry) => entry.id === asset.id);
      assert.equal(asset.exists, true);
      assert.notEqual(asset.sizeBytes, spec.observedBytes, "fixture must not match the observed size");
      assert.equal(asset.expectedSha256, digest);
      assert.equal(asset.actualSha256, digest, "the digest must be computed despite the size");
    }
    // And the verdict that follows from it.
    for (const check of evaluate({ gatedAssets: assets }).checks) {
      if (check.id.startsWith("gated_asset_")) assert.equal(check.status, CHECK_STATUS.PASS);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveGatedAssets reports a clean checkout as absent without throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "revival-pin-doctor-"));
  try {
    // A checkout with the build file but no external private assets — the
    // fresh-source state this gate is about.
    const gradle = readFileSync(resolve(REPO_ROOT, "runtime/android/build.gradle.kts"), "utf8");
    mkdirSync(join(root, "runtime", "android"), { recursive: true });
    writeFileSync(join(root, "runtime", "android", "build.gradle.kts"), gradle);

    const assets = resolveGatedAssets(root, join(root, "operator-home"));
    for (const asset of assets) {
      assert.equal(asset.exists, false);
      assert.equal(asset.sizeBytes, null);
      assert.equal(asset.actualSha256, null);
      assert.match(asset.expectedSha256, /^[0-9a-f]{64}$/, "the pin is still readable");
    }
    const result = evaluate({ gatedAssets: assets });
    for (const spec of GATED_BUILD_ASSETS) {
      assert.ok(result.blocking.includes(spec.id), `${spec.id} must block a fresh clone`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveGatedAssets follows the configured private-assets directory", () => {
  const root = mkdtempSync(join(tmpdir(), "revival-pin-doctor-"));
  try {
    const config = join(root, "operator-config");
    const body = Buffer.from("configured private asset fixture\n");
    const digest = createHash("sha256").update(body).digest("hex");
    mkdirSync(join(root, "runtime", "android"), { recursive: true });
    writeFileSync(join(root, "runtime", "android", "build.gradle.kts"), [
      `val tfliteRuntimeSha256 = "${digest}"`,
    ].join("\n"));
    for (const spec of GATED_BUILD_ASSETS) {
      const suffix = spec.fallbackPath.replace("~/.config/ai-pin-revival/pin-assets/", "");
      const target = join(config, "pin-assets", suffix);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }

    const assets = resolveGatedAssets(root, join(root, "unused-home"), {
      REVIVAL_CONFIG_DIR: config,
    });
    assert.ok(assets.every((asset) => asset.exists && asset.actualSha256 === digest));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseGatedAssetPins reads digests while paths remain external defaults", () => {
  const gradle = readFileSync(resolve(REPO_ROOT, "runtime/android/build.gradle.kts"), "utf8");
  const pins = parseGatedAssetPins(gradle);
  for (const spec of GATED_BUILD_ASSETS) {
    const pin = pins[spec.id];
    assert.ok(pin, `runtime/android/build.gradle.kts no longer pins ${spec.id}`);
    assert.equal(pin.path, null, `${spec.id} must not encode an in-tree fallback path`);
    assert.match(pin.sha256, /^[0-9a-f]{64}$/);
    assert.match(pin.sha256Ref, /^runtime\/android\/build\.gradle\.kts:\d+$/);
    assert.equal(pin.pathRef, null);
  }
});

test("parseGatedAssetPins degrades to an empty map on unparseable input", () => {
  assert.deepEqual(parseGatedAssetPins(""), {});
  assert.deepEqual(parseGatedAssetPins(null), {});
  assert.deepEqual(parseGatedAssetPins("plugins { id(\"com.android.application\") }\n"), {});
  // A comment mentioning the directory must not be mistaken for a pin.
  assert.deepEqual(parseGatedAssetPins("// see release-assets/tflite-2.11.0-stock/\n"), {});
});

// ---------------------------------------------------------------------------
// Host identity. The report invites pasting; it must not contain the OS username.
// ---------------------------------------------------------------------------

function probesUnderHome() {
  return healthyProbes({
    androidSdk: {
      path: `${FAKE_HOME}/Library/Android/sdk`,
      source: "local.properties sdk.dir",
      exists: true,
      platforms: ["android-34"],
      buildTools: ["35.0.0"],
    },
    adb: {
      present: true,
      path: `${FAKE_HOME}/Library/Android/sdk/platform-tools/adb`,
      version: "Android Debug Bridge version 1.0.41",
      command: `${FAKE_HOME}/Library/Android/sdk/platform-tools/adb`,
    },
    ndk: {
      path: `${FAKE_HOME}/Library/Android/sdk/ndk/28.0.0`,
      source: "Android SDK ndk/ directory",
      revision: "28.0.0",
      candidates: ["28.0.0"],
    },
  });
}

test("renderHuman abbreviates the home directory so no OS username is printed", () => {
  const text = renderHuman(evaluate(probesUnderHome()), { verbose: true, home: FAKE_HOME });
  assert.ok(!text.includes(FAKE_HOME_USER), "the human report leaked the OS username");
  assert.ok(!text.includes(FAKE_HOME), "the human report leaked the home directory");
  // Abbreviated, not deleted: the path must still be readable.
  assert.match(text, /~\/Library\/Android\/sdk/);
  assert.match(text, /~\/Library\/Android\/sdk\/platform-tools\/adb/);
});

test("renderJson applies the same abbreviation as the human report", () => {
  const json = JSON.stringify(renderJson(evaluate(probesUnderHome()), { home: FAKE_HOME }));
  assert.ok(!json.includes(FAKE_HOME_USER), "the json report leaked the OS username");
  assert.ok(json.includes("~/Library/Android/sdk"));
});

test("abbreviation survives a failing report, where paths appear in fix text too", () => {
  const probes = probesUnderHome();
  const text = renderHuman(
    evaluate({
      ...probes,
      androidSdk: { ...probes.androidSdk, exists: false },
    }),
    { verbose: true, home: FAKE_HOME },
  );
  assert.ok(!text.includes(FAKE_HOME_USER));
  assert.match(text, /~\/Library\/Android\/sdk/);
});

test("abbreviateHome respects path boundaries and refuses to rewrite a root home", () => {
  assert.equal(abbreviateHome(`${FAKE_HOME}/sdk`, FAKE_HOME), "~/sdk");
  assert.equal(abbreviateHome(FAKE_HOME, FAKE_HOME), "~");
  assert.equal(abbreviateHome(`${FAKE_HOME}/a and ${FAKE_HOME}/b`, FAKE_HOME), "~/a and ~/b");
  // A trailing separator on the home value must not defeat the match.
  assert.equal(abbreviateHome(`${FAKE_HOME}/sdk`, `${FAKE_HOME}/`), "~/sdk");
  // A sibling directory that merely starts with the home path is left alone.
  assert.equal(abbreviateHome(`${FAKE_HOME}-backup/sdk`, FAKE_HOME), `${FAKE_HOME}-backup/sdk`);
  // Degenerate homes would rewrite the whole report; they are ignored.
  assert.equal(abbreviateHome("/opt/android/sdk", "/"), "/opt/android/sdk");
  assert.equal(abbreviateHome("/opt/android/sdk", ""), "/opt/android/sdk");
  assert.equal(abbreviateHome("/opt/android/sdk", null), "/opt/android/sdk");
  // Regex metacharacters in a home path are matched literally, not as a pattern.
  assert.equal(abbreviateHome(`${POSIX_HOME_ROOT}/a+b/sdk`, `${POSIX_HOME_ROOT}/a+b`), "~/sdk");
  assert.equal(
    abbreviateHome(`${POSIX_HOME_ROOT}/axxb/sdk`, `${POSIX_HOME_ROOT}/a+b`),
    `${POSIX_HOME_ROOT}/axxb/sdk`,
  );
});

// ---------------------------------------------------------------------------
// Secret containment. Two independent layers are asserted: the parser never
// captures a value, and the renderer only prints names drawn from a constant.
// ---------------------------------------------------------------------------

test("parseEnvKeyNames returns names only and captures no value", () => {
  const text = [
    "# comment",
    `export PIN_SIGNING_STORE_FILE=/fixture/keys/example.keystore`,
    `export PIN_SIGNING_STORE_PASSWORD=${FAKE_SECRET}`,
    `export PIN_SIGNING_KEY_ALIAS=example-alias`,
    `PIN_SIGNING_KEY_PASSWORD='${FAKE_SECRET}'`,
    "",
  ].join("\n");
  const keys = parseEnvKeyNames(text);
  assert.deepEqual(keys, [...REQUIRED_SIGNING_KEYS]);
  assert.ok(!JSON.stringify(keys).includes(FAKE_SECRET));
  assert.ok(!JSON.stringify(keys).includes("example.keystore"));
});

test("signing env resolution follows the external root contract, never the Pin source", () => {
  assert.equal(
    resolveSigningEnvPath(
      { REVIVAL_CONFIG_DIR: "/operator/config" },
      `${POSIX_HOME_ROOT}/operator`,
    ),
    "/operator/config/secrets/pin/signing.env",
  );
  assert.equal(
    resolveSigningEnvPath(
      { REVIVAL_SECRETS_DIR: "/operator/secrets" },
      `${POSIX_HOME_ROOT}/operator`,
    ),
    "/operator/secrets/pin/signing.env",
  );
});

test("a signing env value never reaches evaluate output or either renderer", () => {
  const text = [
    `export PIN_SIGNING_STORE_FILE=/fixture/keys/example.keystore`,
    `export PIN_SIGNING_STORE_PASSWORD=${FAKE_SECRET}`,
    `export PIN_SIGNING_KEY_ALIAS=example-alias`,
    `export PIN_SIGNING_KEY_PASSWORD=${FAKE_SECRET}`,
  ].join("\n");
  const probes = healthyProbes({
    signingEnv: {
      exists: true,
      path: "secrets/pin-signing.env",
      keys: parseEnvKeyNames(text),
      mode: 0o600,
    },
  });
  const result = evaluate(probes);
  const human = renderHuman(result, { verbose: true });
  const json = JSON.stringify(renderJson(result));

  assert.ok(!JSON.stringify(result).includes(FAKE_SECRET), "evaluate output leaked a secret value");
  assert.ok(!human.includes(FAKE_SECRET), "human render leaked a secret value");
  assert.ok(!json.includes(FAKE_SECRET), "json render leaked a secret value");
  assert.ok(!human.includes("example-alias"), "human render leaked an alias value");
  assert.ok(!human.includes("example.keystore"), "human render leaked a keystore path value");
});

test("a poisoned key list cannot leak into rendered output", () => {
  // Simulates a parser regression that let a VALUE into the key list. The
  // renderer intersects with REQUIRED_SIGNING_KEYS, so the value still cannot
  // reach output.
  const probes = healthyProbes({
    signingEnv: {
      exists: true,
      path: "secrets/pin-signing.env",
      keys: [...REQUIRED_SIGNING_KEYS, FAKE_SECRET],
      mode: 0o600,
    },
  });
  const result = evaluate(probes);
  assert.ok(!renderHuman(result, { verbose: true }).includes(FAKE_SECRET));
  assert.ok(!JSON.stringify(renderJson(result)).includes(FAKE_SECRET));
  assert.ok(!JSON.stringify(result).includes(FAKE_SECRET));
});

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

test("the real toolchain contract provides every host requirement", () => {
  const source = readFileSync(
    resolve(PRODUCT_ROOT, "platform/containers/pin-builder/toolchain.json"),
    "utf8",
  );
  const requirements = parseRequirementsFromToolchain(source);
  assert.deepEqual({ ...requirements }, {
    jdkMajor: 17,
    androidSdkApi: 34,
    ndkLabel: "r28c",
    ndkMajor: 28,
    nodeMinimum: "22.14.0",
    sourceRef: "platform/containers/pin-builder/toolchain.json",
  });
});

test("host requirement parsing fails closed for malformed or incomplete contracts", () => {
  assert.equal(parseRequirementsFromToolchain("not json"), null);
  assert.equal(parseRequirementsFromToolchain("{}"), null);
  assert.equal(parseRequirementsFromToolchain(""), null);
  assert.equal(parseRequirementsFromToolchain(null), null);
});

test("Rust command banners and both canonical pins require one exact version", () => {
  assert.equal(parseCommandVersion("rustc 1.91.1 (fixture 2025-11-07)"), "1.91.1");
  assert.equal(parseCommandVersion("cargo 1.91.1 (fixture)"), "1.91.1");
  assert.equal(parseCommandVersion("99.88.77\nrustc 1.91.1 (fixture)", "rustc"), "1.91.1");
  assert.equal(parseCommandVersion("rustc 1.91.1\nrustc 1.91.1", "rustc"), null);
  assert.equal(parseCommandVersion("stable"), null);
  assert.equal(
    parseRustToolchainToml([
      "[toolchain]",
      'channel = "1.91.1"',
      'profile = "minimal"',
    ].join("\n")),
    "1.91.1",
  );
  assert.equal(parseRustToolchainToml('[toolchain]\nchannel = "stable"\n'), null);
  assert.equal(
    parseRustToolchainToml('[other]\nchannel = "9.9.9"\n[toolchain]\nchannel = "1.91.1"\n'),
    "1.91.1",
    "only the toolchain section owns the selected channel",
  );
  assert.equal(
    parseRustToolchainToml('[toolchain]\nchannel = "1.91.1"\nchannel = "1.91.0"\n'),
    null,
    "duplicate channels are ambiguous",
  );
  assert.equal(
    parseRustToolchainToml('[toolchain]\nchannel = "1.91.1"\n[toolchain]\nchannel = "1.91.1"\n'),
    null,
    "duplicate toolchain sections are ambiguous",
  );
  assert.equal(
    parseRustToolchainContract(JSON.stringify({
      toolchain: { rust: { version: "1.91.1" } },
    })),
    "1.91.1",
  );
  assert.equal(parseRustToolchainContract("{not json"), null);
});

test("every exact Pin Docker surface is locked to toolchain.json", () => {
  const contractText = readFileSync(
    join(PRODUCT_ROOT, "platform/containers/pin-builder/toolchain.json"),
    "utf8",
  );
  const dockerText = readFileSync(
    join(PRODUCT_ROOT, "platform/containers/pin-builder/Dockerfile"),
    "utf8",
  );
  const gradleFiles = realPinGradleFiles();
  const expected = parsePinBuilderToolchainContract(contractText);
  const actual = parsePinBuilderDockerfileContract(dockerText, gradleFiles);
  assert.deepEqual(pinBuilderToolchainMismatches(expected, actual), []);

  const changed = (value) => `${value}-drift`;
  const replace = (source, needle, replacement) => {
    assert.ok(source.includes(needle), `missing mutation surface: ${needle}`);
    return source.replace(needle, replacement);
  };
  const mutations = [
    ["platform", (text) => replace(text, 'test "${BUILDARCH}" = "${TARGETARCH}";', "true;")],
    ["JDK image", (text) => replace(text, `FROM ${expected.jdkImage} AS jdk_runtime`, `FROM ${changed(expected.jdkImage)} AS jdk_runtime`)],
    ["Node image", (text) => replace(text, `FROM ${expected.nodeImage} AS node_runtime`, `FROM ${changed(expected.nodeImage)} AS node_runtime`)],
    ["Rust image", (text) => replace(text, `FROM ${expected.rustImage}`, `FROM ${changed(expected.rustImage)}`)],
    ["Rust version", (text) => replace(text, `--toolchain ${expected.rustVersion};`, `--toolchain 1.91.0;`)],
    ["command-line SHA", (text) => replace(text, `ARG ANDROID_COMMAND_LINE_TOOLS_SHA256=${expected.commandLineToolsSha256}`, `ARG ANDROID_COMMAND_LINE_TOOLS_SHA256=${"0".repeat(64)}`)],
    ["Android platform", (text) => replace(text, `ARG ANDROID_PLATFORM_VERSION=${expected.androidPlatform}`, "ARG ANDROID_PLATFORM_VERSION=1")],
    ["Android NDK archive SHA-256", (text) => replace(text, `ARG ANDROID_NDK_ARCHIVE_SHA256=${expected.androidNdkArchiveSha256}`, `ARG ANDROID_NDK_ARCHIVE_SHA256=${"0".repeat(64)}`)],
    ["Android Rust target", (text) => replace(text, `rustup target add ${expected.androidRustTarget}`, "rustup target add x86_64-linux-android")],
    ["cargo-ndk archive URL", (text) => replace(text, `ARG CARGO_NDK_ARCHIVE_URL=${expected.cargoNdkArchiveUrl}`, "ARG CARGO_NDK_ARCHIVE_URL=https://github.com/bbqsrc/cargo-ndk/releases/download/v0.0.1/drift.tgz")],
    ["ARM64 cargo-ndk archive URL", (text) => replace(text, `ARG CARGO_NDK_ARM64_ARCHIVE_URL=${expected.cargoNdkArm64ArchiveUrl}`, "ARG CARGO_NDK_ARM64_ARCHIVE_URL=https://github.com/bbqsrc/cargo-ndk/releases/download/v0.0.1/drift.tgz")],
    ["Rust target copy", (text) => replace(text, "COPY --from=rust_target_native /usr/local/rustup/ /usr/local/rustup/", "COPY --from=rust_target_native /usr/local/rustup/ /opt/rustup/")],
    ["cargo-ndk binary consumer", (text) => replace(text, "COPY --from=rust_target_native /opt/cargo-ndk/bin/ /usr/local/cargo/bin/", "COPY --from=rust_target_native /opt/cargo-ndk/bin/ /usr/local/bin/")],
  ];
  for (const [label, mutate] of mutations) {
    const mismatches = pinBuilderToolchainMismatches(
      expected,
      parsePinBuilderDockerfileContract(mutate(dockerText), gradleFiles),
    );
    assert.ok(mismatches.length > 0, `${label} drift passed comparison`);
    const result = evaluate(healthyProbes({ builderToolchain: { mismatches } }));
    assert.equal(
      checkById(result, "builder_toolchain_contract").status,
      CHECK_STATUS.FAIL,
      `${label} drift passed doctor`,
    );
  }

  const gradleMutations = [
    ["compileSdk consumer", "pin/runtime/android/build.gradle.kts", "compileSdk = 34", "compileSdk = 33"],
    ["duplicate compileSdk consumer", "pin/runtime/android/build.gradle.kts", "compileSdk = 34", "compileSdk = 34\n    compileSdk = 34"],
    ["build-tools environment consumer", "pin/build.gradle.kts", 'System.getenv("AI_PIN_ANDROID_BUILD_TOOLS_VERSION")', 'System.getenv("AI_PIN_ANDROID_BUILD_TOOLS_VERSION_DRIFT")'],
    ["Rust ABI consumer", "pin/runtime/android/build.gradle.kts", 'val rustAbi = "arm64-v8a"', 'val rustAbi = "x86_64"'],
    ["Rust target consumer", "pin/runtime/android/build.gradle.kts", 'val rustTarget = "aarch64-linux-android"', 'val rustTarget = "x86_64-linux-android"'],
    ["cargo-ndk command consumer", "pin/runtime/android/build.gradle.kts", '"cargo", "ndk", "-P", "31", "-t", rustAbi,', '"cargo", "build", "-P", "31", "-t", rustAbi,'],
    ["Rust target output consumer", "pin/runtime/android/build.gradle.kts", 'target/$rustTarget/release/$rustExecutableName', 'target/release/$rustExecutableName'],
  ];
  for (const [label, path, needle, replacement] of gradleMutations) {
    const mutated = { ...gradleFiles, [path]: replace(gradleFiles[path], needle, replacement) };
    assert.equal(parsePinGradleToolchainConsumers(mutated)?.cargoNdkConsumerValid === true &&
      parsePinGradleToolchainConsumers(mutated)?.androidPlatform === expected.androidPlatform &&
      parsePinGradleToolchainConsumers(mutated)?.buildToolsConsumersValid === true &&
      parsePinGradleToolchainConsumers(mutated)?.androidRustTarget === expected.androidRustTarget &&
      parsePinGradleToolchainConsumers(mutated)?.rustAbi === "arm64-v8a", false, `${label} mutation passed pure parser`);
    const mismatches = pinBuilderToolchainMismatches(
      expected,
      parsePinBuilderDockerfileContract(dockerText, mutated),
    );
    assert.ok(mismatches.length > 0, `${label} drift passed doctor contract`);
  }
});

test("the root Rust pin must equal the builder contract even when Docker supplies host tools", () => {
  const result = evaluate(healthyProbes({
    containerBuilder: {
      available: true,
      version: "fixture",
      contractFilesPresent: true,
      suppliesHostToolchain: true,
      requiredPlatform: "linux/amd64",
      platformsDetermined: true,
      platforms: ["linux/amd64"],
      amd64Runtime: { safe: true, detail: "native fixture" },
    },
    rustToolchain: { expectedVersion: "1.91.1", rootVersion: "1.91.0" },
  }));
  const contract = checkById(result, "rust_toolchain_contract");
  assert.equal(contract.status, CHECK_STATUS.FAIL);
  assert.equal(contract.required, true);
  assert.equal(result.ok, false);
});

test("host Rust and Cargo are compared to the exact operational version", () => {
  const result = evaluate(healthyProbes({
    rustc: { present: true, version: "rustc 1.91.0 (fixture)" },
    cargo: { present: true, version: "cargo 1.92.0 (fixture)" },
  }));
  assert.equal(checkById(result, "rustc").status, CHECK_STATUS.FAIL);
  assert.equal(checkById(result, "cargo").status, CHECK_STATUS.FAIL);

  const missing = evaluate(healthyProbes({ rustc: { present: false, version: null } }));
  assert.match(checkById(missing, "rustc").fix, /1\.91\.1/u);
  assert.doesNotMatch(checkById(missing, "rustc").fix, /no toolchain file|stable is/u);
});

test("host cargo-ndk is compared to the exact builder contract", () => {
  assert.equal(checkById(evaluate(healthyProbes()), "cargo_ndk").status, CHECK_STATUS.PASS);
  for (const version of ["cargo-ndk 4.1.1", "cargo-ndk 4.1.2\ncargo-ndk 4.1.2", "wrapper 4.1.2"]) {
    const result = evaluate(healthyProbes({
      cargoNdk: { present: true, version, expectedVersion: "4.1.2" },
    }));
    assert.equal(checkById(result, "cargo_ndk").status, CHECK_STATUS.FAIL, version);
  }
});

test("host requirement parsing reads explicit contract values", () => {
  const requirements = parseRequirementsFromToolchain(JSON.stringify({
    toolchain: {
      jdk: { version: "21.0.7+6" },
      android: { platform: "35", ndkRelease: "r30a" },
      node: { version: "24.1.0" },
    },
  }));
  assert.deepEqual(
    { ...requirements },
    {
      jdkMajor: 21,
      androidSdkApi: 35,
      ndkLabel: "r30a",
      ndkMajor: 30,
      nodeMinimum: "24.1.0",
      sourceRef: "platform/containers/pin-builder/toolchain.json",
    },
  );
});

test("parseJavaVersion handles modern and legacy banners", () => {
  assert.deepEqual(parseJavaVersion('openjdk version "21.0.11" 2026-04-21 LTS'), {
    version: "21.0.11",
    major: 21,
  });
  assert.deepEqual(parseJavaVersion('java version "1.8.0_392"'), { version: "1.8.0_392", major: 8 });
  assert.deepEqual(parseJavaVersion([
    "Picked up JAVA_TOOL_OPTIONS: synthetic",
    'openjdk version "17.0.14" 2025-01-21 LTS',
    "OpenJDK Runtime Environment (build 17.0.14+7-LTS)",
  ].join("\n")), { version: "17.0.14", major: 17 });
  assert.equal(parseJavaVersion('wrapper 99.88.77\nnot a Java banner'), null);
  assert.equal(parseJavaVersion('java version "17.0.14"\nopenjdk version "17.0.14"'), null);
  assert.equal(parseJavaVersion("command not found"), null);
  assert.equal(parseJavaVersion(null), null);
});

test("compareVersions orders dotted numeric versions", () => {
  assert.equal(compareVersions("22.0.0", "20.19.0"), 1);
  assert.equal(compareVersions("20.18.9", "20.19.0"), -1);
  assert.equal(compareVersions("20.19.0", "20.19.0"), 0);
  assert.equal(compareVersions("22", "22.0.0"), 0);
  assert.equal(compareVersions("26.3.11579264", "28.0.0"), -1);
});

test("parseAdbDevices counts states and retains no serial", () => {
  const output = [
    "List of devices attached",
    "FIXTURESERIAL1\tdevice",
    "FIXTURESERIAL2\tunauthorized",
    "FIXTURESERIAL3\toffline",
    "",
  ].join("\n");
  const counts = parseAdbDevices(output);
  assert.deepEqual(counts, { ready: 1, unauthorized: 1, other: 1 });
  assert.ok(!JSON.stringify(counts).includes("FIXTURESERIAL"));
  assert.deepEqual(parseAdbDevices("List of devices attached\n\n"), {
    ready: 0,
    unauthorized: 0,
    other: 0,
  });
});

test("parseSdkDir reads sdk.dir and undoes property escaping", () => {
  assert.equal(parseSdkDir("sdk.dir=/opt/android/sdk\n"), "/opt/android/sdk");
  assert.equal(parseSdkDir("# comment\nsdk.dir = /opt/sdk\n"), "/opt/sdk");
  assert.equal(parseSdkDir("sdk.dir=C\\:\\\\Android\\\\sdk\n"), "C:\\Android\\sdk");
  assert.equal(parseSdkDir("ndk.dir=/opt/ndk\n"), null);
  assert.equal(parseSdkDir(null), null);
});

test("parseNdkRevision reads Pkg.Revision from source.properties", () => {
  assert.equal(
    parseNdkRevision("Pkg.Desc = Android NDK\nPkg.Revision = 26.3.11579264\n"),
    "26.3.11579264",
  );
  assert.equal(parseNdkRevision("Pkg.Desc = Android NDK\n"), null);
  assert.equal(parseNdkRevision(null), null);
});

// ---------------------------------------------------------------------------
// Report shape and CLI surface
// ---------------------------------------------------------------------------

test("every check has a unique id and carries a fix whenever it is not passing", () => {
  const result = evaluate(
    healthyProbes({
      protoc: { present: false, version: null },
      signingEnv: { exists: false, path: "secrets/pin-signing.env", keys: [], mode: null },
    }),
  );
  const ids = result.checks.map((check) => check.id);
  assert.equal(new Set(ids).size, ids.length, "check ids must be unique");
  assert.ok(ids.includes("pin_device"));
  assert.ok(ids.includes(`rust_target_android`));
  for (const check of result.checks) {
    assert.ok(typeof check.title === "string" && check.title.length > 0);
    assert.ok([CHECK_STATUS.PASS, CHECK_STATUS.WARN, CHECK_STATUS.FAIL].includes(check.status));
    assert.equal(typeof check.required, "boolean");
    assert.ok(typeof check.detail === "string" && check.detail.length > 0);
    if (check.status !== CHECK_STATUS.PASS) {
      assert.ok(check.fix.length > 0, `${check.id} must offer an actionable fix`);
    }
  }
});

test("the aarch64 target check names the exact rustup command", () => {
  const result = evaluate(
    healthyProbes({ rustTarget: { determined: true, installed: false, source: "rustup" } }),
  );
  assert.match(
    checkById(result, "rust_target_android").fix,
    new RegExp(`rustup target add ${ANDROID_RUST_TARGET} --toolchain 1\\.91\\.1`),
  );
});

test("an undeterminable rust target list is a warn, not a fail", () => {
  const result = evaluate(
    healthyProbes({ rustTarget: { determined: false, installed: false, source: null } }),
  );
  assert.equal(checkById(result, "rust_target_android").status, CHECK_STATUS.WARN);
  assert.equal(result.ok, true);
});

test("renderHuman groups by status and ends with a next step", () => {
  const text = renderHuman(evaluate(healthyProbes({ protoc: { present: false, version: null } })));
  assert.match(text, /^Ai Pin Revival host doctor/);
  assert.match(text, /\nFAIL \(1\)\n/);
  assert.match(text, /\nPASS \(\d+\)\n/);
  assert.match(text, /Summary: \d+ pass, \d+ warn, \d+ fail/);
  assert.ok(text.trimEnd().split("\n").pop().startsWith("Next step:"));
});

test("nextStepLine names the blocking checks when a required check fails", () => {
  const failing = nextStepLine(evaluate(healthyProbes({ protoc: { present: false, version: null } })));
  assert.match(failing, /protoc/);
  const healthy = nextStepLine(evaluate(healthyProbes()));
  assert.match(healthy, /host prerequisites satisfied/);
  assert.match(healthy, /platform\/containers\/pin-builder\/\*\.test\.mjs/);
  assert.ok(!healthy.includes("fix the blocking"));
});

test("renderJson mirrors evaluate and exposes no probe internals", () => {
  const result = evaluate(healthyProbes());
  const json = renderJson(result);
  assert.equal(json.tool, "revival-pin-doctor");
  assert.equal(json.ok, true);
  assert.equal(
    json.requirements_source,
    "platform/containers/pin-builder/toolchain.json",
  );
  assert.equal(json.checks.length, result.checks.length);
  assert.deepEqual(Object.keys(json.checks[0]).sort(), [
    "detail",
    "fix",
    "id",
    "required",
    "status",
    "title",
  ]);
  assert.ok(!Object.keys(json).includes("probes"));
});

test("parseCliArgs accepts the documented flags and rejects anything else", () => {
  assert.deepEqual(parseCliArgs([]), { json: false, verbose: false, help: false });
  assert.deepEqual(parseCliArgs(["--json", "--verbose"]), { json: true, verbose: true, help: false });
  assert.deepEqual(parseCliArgs(["-v"]), { json: false, verbose: true, help: false });
  assert.deepEqual(parseCliArgs(["--help"]), { json: false, verbose: false, help: true });
  assert.throws(() => parseCliArgs(["--serial", "X"]), /unrecognized argument/);
  assert.throws(() => parseCliArgs(["--force"]), /unrecognized argument/);
});

test("usage documents the exit-code contract", () => {
  const text = usage();
  assert.match(text, /--json/);
  assert.match(text, /--verbose/);
  assert.match(text, /Exit 0 when all required checks pass/);
});

test("evaluate tolerates an empty probe object without throwing", () => {
  const result = evaluate({});
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.checks.map((check) => check.id),
    [
      "node",
      "container_builder",
      "builder_toolchain_contract",
      "jdk",
      "android_sdk",
      "android_platform_tools",
      "android_ndk",
      "rust_toolchain_contract",
      "rustc",
      "cargo",
      "rust_target_android",
      "cargo_ndk",
      "protoc",
      "stock_decompile_evidence",
      ...GATED_BUILD_ASSETS.map((asset) => asset.id),
      "signing_env",
      "signing_env_exported",
      "pin_device",
    ],
    "every required contract check must remain present by identity",
  );
  assert.ok(result.blocking.length > 0);
});
