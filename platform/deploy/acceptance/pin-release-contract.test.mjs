import assert from "node:assert/strict";
import {
  chmod,
  readFile,
  mkdtemp,
  mkdir,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

// The Center-consumer test below imports center/src/server/pin-releases.ts as
// real source — a re-implementation here would prove nothing about the module
// the BFF actually runs. Center is a bundler-resolved Next codebase, so its
// modules write extensionless relative imports (`from "./log"`), which Node's
// ES resolver does not follow. Without this hook the whole file dies at that
// one import with ERR_MODULE_NOT_FOUND naming a file that exists, i.e. a
// failure that blames the wrong layer. The hook is Center's own, deliberately
// shared rather than copied: one resolution policy for both test trees, so a
// future sibling import cannot pass in center/verify and fail here.
import "../../../center/verify/tsResolve.mjs";

import {
  PIN_RELEASE_ARTIFACT_ROLES,
  PIN_RELEASE_PACKAGE_BY_ROLE,
  PinReleaseContractError,
  canonicalPinReleaseManifestJson,
  createPinReleaseManifest,
  derivePinReleaseId,
  inspectPinReleaseArtifact,
  parseCanonicalPinReleaseManifestDocument,
  parsePinInstalledState,
  parsePinReleaseJson,
  parsePinReleaseReceiptBundle,
  planPinRelease,
  verifyPinReleaseBundle,
  verifyPinReleaseMetadata,
} from "../pin/release.mjs";

const SIGNER = "a".repeat(64);
const OTHER_SIGNER = "b".repeat(64);
const SERIAL = "1H4MPA3C180234";
const STEADY_ROLES = Object.freeze([
  "installer",
  "hook",
  "server",
  "hook-injector",
]);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "revival-pin-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = new Map();
  const metadataByBytes = new Map();

  const toolRunner = async ({ args, label }) => {
    const apkPath = resolve(args.at(-1));
    const record = metadata.get(apkPath) ?? metadataByBytes.get(await readFile(apkPath, "utf8"));
    if (!record) throw new Error(`test metadata missing for ${apkPath}`);
    if (label.includes("application-id")) return `${record.package}\n`;
    if (label.includes("version-name")) return `${record.versionName}\n`;
    if (label.includes("version-code")) return `${record.versionCode}\n`;
    if (label.includes("apksigner")) {
      return `Signer #1 certificate SHA-256 digest: ${record.signerSha256.toUpperCase()}\n`;
    }
    throw new Error(`unexpected Android tool invocation: ${label}`);
  };

  async function makeRelease(name, { version, versionCode, signer = SIGNER }) {
    const apkRoot = join(root, name);
    await mkdir(apkRoot, { recursive: true });
    for (const role of PIN_RELEASE_ARTIFACT_ROLES) {
      const apkPath = join(apkRoot, `${role}.apk`);
      const bytes = `signed-apk-fixture:${name}:${role}:${version}:${versionCode}\n`;
      await writeFile(apkPath, bytes);
      const record = {
        package: PIN_RELEASE_PACKAGE_BY_ROLE[role],
        versionName: version,
        versionCode,
        signerSha256: signer,
      };
      metadata.set(await realpath(apkPath), record);
      metadataByBytes.set(bytes, record);
    }
    const artifacts = [];
    for (const role of PIN_RELEASE_ARTIFACT_ROLES) {
      artifacts.push(await inspectPinReleaseArtifact({
        role,
        apkRoot,
        path: `${role}.apk`,
        expectedSigner: signer,
        toolRunner,
      }));
    }
    const receipts = parsePinReleaseReceiptBundle({ schemaVersion: 1, artifacts });
    const manifest = createPinReleaseManifest({ version, receipts });
    return { apkRoot, receipts, manifest };
  }

  async function makeLegacyRollback(name, metadataByRole) {
    const apkRoot = join(root, name);
    await mkdir(apkRoot, { recursive: true });
    for (const role of STEADY_ROLES) {
      const artifactMetadata = metadataByRole[role];
      assert.ok(artifactMetadata, `legacy fixture metadata missing for ${role}`);
      const apkPath = join(apkRoot, `${role}.apk`);
      const bytes = [
        "signed-legacy-apk-fixture",
        name,
        role,
        artifactMetadata.versionName,
        artifactMetadata.versionCode,
        "",
      ].join(":");
      await writeFile(apkPath, bytes);
      const record = {
        package: PIN_RELEASE_PACKAGE_BY_ROLE[role],
        versionName: artifactMetadata.versionName,
        versionCode: artifactMetadata.versionCode,
        signerSha256: artifactMetadata.signerSha256 ?? SIGNER,
      };
      metadata.set(await realpath(apkPath), record);
      metadataByBytes.set(bytes, record);
    }
    const artifacts = [];
    for (const role of STEADY_ROLES) {
      artifacts.push(await inspectPinReleaseArtifact({
        role,
        apkRoot,
        path: `${role}.apk`,
        expectedSigner: metadataByRole[role].signerSha256 ?? SIGNER,
        toolRunner,
      }));
    }
    return { apkRoot, artifacts };
  }

  return {
    root,
    metadata,
    metadataByBytes,
    toolRunner,
    makeRelease,
    makeLegacyRollback,
  };
}

function installedState(
  versionCode,
  {
    serial = SERIAL,
    complete = false,
    mode = "atomic",
    receipts = null,
    currentRelease = {
      releaseId: "c".repeat(64),
      version: "2026-08-09.0",
      versionCode,
      manifestSha256: "d".repeat(64),
    },
  } = {},
) {
  if (mode === "empty") {
    return {
      schemaVersion: 1,
      serial,
      mode,
      currentRelease: null,
      artifacts: [],
    };
  }
  const roles = complete ? PIN_RELEASE_ARTIFACT_ROLES : ["installer", "hook", "server", "hook-injector"];
  return {
    schemaVersion: 1,
    serial,
    mode,
    currentRelease,
    artifacts: roles.map((role) => ({
      role,
      package: PIN_RELEASE_PACKAGE_BY_ROLE[role],
      versionName:
        receipts?.artifacts.find((artifact) => artifact.role === role)?.versionName ??
        currentRelease?.version ??
        "2026-08-09.0",
      versionCode,
      sha256:
        receipts?.artifacts.find((artifact) => artifact.role === role)?.sha256 ??
        role.charCodeAt(0).toString(16).padStart(2, "0").repeat(32),
      signerSha256:
        receipts?.artifacts.find((artifact) => artifact.role === role)?.signerSha256 ??
        SIGNER,
    })),
  };
}

function legacyInstalledState(artifacts, { serial = SERIAL } = {}) {
  return {
    schemaVersion: 1,
    serial,
    mode: "legacy-mixed",
    currentRelease: null,
    artifacts: artifacts.map((artifact) => ({
      role: artifact.role,
      package: artifact.package,
      versionName: artifact.versionName,
      versionCode: artifact.versionCode,
      sha256: artifact.sha256,
      signerSha256: artifact.signerSha256,
    })),
  };
}

async function rejectsCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof PinReleaseContractError);
    assert.equal(error.code, code);
    return true;
  });
}

test("inspect, canonical manifest, verify, and plan form one host-only atomic contract", async (t) => {
  const f = await fixture(t);
  const release = await f.makeRelease("target", {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
  });

  assert.deepEqual(
    release.manifest.artifacts.map((artifact) => artifact.role),
    PIN_RELEASE_ARTIFACT_ROLES,
  );
  for (const artifact of release.manifest.artifacts) {
    assert.equal(
      artifact.url,
      `./${release.manifest.releaseId}/${artifact.role}.apk`,
    );
  }
  assert.match(canonicalPinReleaseManifestJson(release.manifest), /}\n$/);
  assert.equal(
    parseCanonicalPinReleaseManifestDocument(
      canonicalPinReleaseManifestJson(release.manifest),
    ).releaseId,
    release.manifest.releaseId,
  );
  assert.throws(
    () => parseCanonicalPinReleaseManifestDocument(
      JSON.stringify(release.manifest, null, 2),
    ),
    (error) =>
      error instanceof PinReleaseContractError &&
      error.code === "manifest-noncanonical",
  );
  assert.equal(
    derivePinReleaseId({
      version: release.manifest.version,
      artifacts: release.manifest.artifacts.map((artifact) => ({
        ...artifact,
        url: "https://ignored.invalid/a-different-location.apk",
      })),
    }),
    release.manifest.releaseId,
    "release identity excludes URLs",
  );

  const verified = await verifyPinReleaseBundle({
    ...release,
    expectedSigner: SIGNER,
    toolRunner: f.toolRunner,
  });
  assert.equal(verified.releaseId, release.manifest.releaseId);
  assert.equal(verified.versionCode, 202_608_091);
  assert.equal(verified.artifacts.length, 5);

  const plan = await planPinRelease({
    ...release,
    expectedSigner: SIGNER,
    toolRunner: f.toolRunner,
    serial: SERIAL,
    installedState: installedState(202_608_090),
  });
  assert.equal(plan.serial, SERIAL);
  assert.equal(plan.fromVersionCode, 202_608_090);
  assert.equal(plan.toVersionCode, 202_608_091);
  assert.deepEqual(plan.operations.map((operation) => operation.role), PIN_RELEASE_ARTIFACT_ROLES);
  assert.equal(plan.rollback, null);
});

test("host identity and canonical bytes are byte-exact with Center's independent consumer", async (t) => {
  const f = await fixture(t);
  const release = await f.makeRelease("center-contract", {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
  });
  const center = await import(
    "../../../center/src/server/pin-releases.ts?host-release-contract"
  );
  assert.deepEqual(center.PIN_RELEASE_ROLES, PIN_RELEASE_ARTIFACT_ROLES);
  assert.deepEqual(center.PIN_RELEASE_PACKAGE_BY_ROLE, PIN_RELEASE_PACKAGE_BY_ROLE);
  assert.equal(
    center.computePinReleaseId({
      schemaVersion: 1,
      version: release.manifest.version,
      artifacts: release.manifest.artifacts,
    }),
    release.manifest.releaseId,
  );
  assert.equal(
    center.serializePinReleaseManifest(release.manifest),
    canonicalPinReleaseManifestJson(release.manifest),
  );
});

test("verification rejects APK byte tampering after inspection", async (t) => {
  const f = await fixture(t);
  const release = await f.makeRelease("tamper", {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
  });
  const tamperedBytes = "tampered signed APK bytes\n";
  const serverPath = await realpath(join(release.apkRoot, "server.apk"));
  const serverMetadata = f.metadata.get(serverPath);
  await writeFile(serverPath, tamperedBytes);
  f.metadataByBytes.set(tamperedBytes, serverMetadata);
  await rejectsCode(
    () => verifyPinReleaseBundle({
      ...release,
      expectedSigner: SIGNER,
      toolRunner: f.toolRunner,
    }),
    "receipt-mismatch",
  );
});

test("private snapshot defeats file and parent-directory ABA replacement", async (t) => {
  const f = await fixture(t);

  async function exercise(name, swapParent) {
    const apkRoot = join(f.root, name);
    const heldRoot = join(f.root, `${name}-held`);
    const apkPath = join(apkRoot, "installer.apk");
    const untrusted = "untrusted-original-apk\n";
    const trusted = "temporarily-substituted-trusted-apk\n";
    await mkdir(apkRoot);
    await writeFile(apkPath, untrusted);
    let swapped = false;
    let restored = false;
    const inspectedPaths = new Set();
    const toolRunner = async ({ args, label }) => {
      const inspectedPath = args.at(-1);
      inspectedPaths.add(inspectedPath);
      if (!swapped) {
        swapped = true;
        if (swapParent) {
          await rename(apkRoot, heldRoot);
          await mkdir(apkRoot);
          await writeFile(apkPath, trusted);
        } else {
          await writeFile(apkPath, trusted);
        }
      }
      const inspectedBytes = await readFile(inspectedPath, "utf8");
      const seesTrustedSubstitution = inspectedBytes === trusted;
      let output;
      if (label.includes("application-id")) {
        output = seesTrustedSubstitution
          ? `${PIN_RELEASE_PACKAGE_BY_ROLE.installer}\n`
          : "invalid.untrusted.package\n";
      } else if (label.includes("version-name")) {
        output = "2026-08-09.1\n";
      } else if (label.includes("version-code")) {
        output = "202608091\n";
      } else {
        output = `Signer #1 certificate SHA-256 digest: ${seesTrustedSubstitution ? SIGNER : OTHER_SIGNER}\n`;
        if (swapParent) {
          await rm(apkRoot, { recursive: true, force: true });
          await rename(heldRoot, apkRoot);
        } else {
          await writeFile(apkPath, untrusted);
        }
        restored = true;
      }
      return output;
    };

    await rejectsCode(
      () => inspectPinReleaseArtifact({
        role: "installer",
        apkRoot,
        path: "installer.apk",
        expectedSigner: SIGNER,
        toolRunner,
      }),
      "package-mismatch",
    );
    assert.equal(restored, true);
    assert.equal(await readFile(apkPath, "utf8"), untrusted);
    assert.equal(inspectedPaths.size, 4, "each Android tool receives its own held snapshot fd");
    for (const inspectedPath of inspectedPaths) {
      assert.match(inspectedPath, /^\/dev\/fd\/[0-9]+$/);
      assert.notEqual(inspectedPath, await realpath(apkPath));
    }
  }

  await exercise("file-aba", false);
  await exercise("parent-aba", true);

  const snapshotRoot = join(f.root, "snapshot-aba");
  const snapshotSource = join(snapshotRoot, "installer.apk");
  const untrusted = "snapshot-A-untrusted\n";
  await mkdir(snapshotRoot);
  await writeFile(snapshotSource, untrusted);
  let namedSnapshotExposed = false;
  const snapshotAttackRunner = async ({ args, label }) => {
    if (label.includes("application-id")) {
      const candidates = (await readdir(tmpdir(), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("ai-pin-release-inspect-"))
        .map((entry) => join(tmpdir(), entry.name, "artifact.apk"));
      for (const candidate of candidates) {
        try {
          if (await readFile(candidate, "utf8") === untrusted) {
            namedSnapshotExposed = true;
            break;
          }
        } catch {
          // A concurrently cleaned inspection directory is not this fixture.
        }
      }
    }
    const inspectedBytes = await readFile(args.at(-1), "utf8");
    assert.equal(inspectedBytes, untrusted, "held descriptors retain the original snapshot bytes");
    let output;
    if (label.includes("application-id")) {
      output = "invalid.snapshot.package\n";
    } else if (label.includes("version-name")) {
      output = "2026-08-09.1\n";
    } else if (label.includes("version-code")) {
      output = "202608091\n";
    } else {
      output = `Signer #1 certificate SHA-256 digest: ${OTHER_SIGNER}\n`;
    }
    return output;
  };
  await rejectsCode(
    () => inspectPinReleaseArtifact({
      role: "installer",
      apkRoot: snapshotRoot,
      path: "installer.apk",
      expectedSigner: SIGNER,
      toolRunner: snapshotAttackRunner,
    }),
    "package-mismatch",
  );
  assert.equal(
    namedSnapshotExposed,
    false,
    "the private snapshot name is removed before any Android tool invocation",
  );
});

test("default Android tool adapter exposes only an inherited private snapshot fd", async (t) => {
  const f = await fixture(t);
  const release = await f.makeRelease("default-tool-fd", {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
  });
  const role = "installer";
  const expectedBytes = await readFile(join(release.apkRoot, `${role}.apk`), "utf8");
  const fakeTool = join(f.root, "fake-android-tool.mjs");
  await writeFile(fakeTool, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const artifactPath = args.at(-1);
if (artifactPath !== "/dev/fd/3") process.exit(41);
if (readFileSync(artifactPath, "utf8") !== ${JSON.stringify(expectedBytes)}) process.exit(42);
if (args[0] === "manifest" && args[1] === "application-id") console.log(${JSON.stringify(PIN_RELEASE_PACKAGE_BY_ROLE[role])});
else if (args[0] === "manifest" && args[1] === "version-name") console.log("2026-08-09.1");
else if (args[0] === "manifest" && args[1] === "version-code") console.log("202608091");
else if (args[0] === "verify") console.log("Signer #1 certificate SHA-256 digest: ${SIGNER}");
else process.exit(43);
`);
  await chmod(fakeTool, 0o755);

  const receipt = await inspectPinReleaseArtifact({
    role,
    apkRoot: release.apkRoot,
    path: `${role}.apk`,
    expectedSigner: SIGNER,
    apkanalyzer: fakeTool,
    apksigner: fakeTool,
  });
  assert.equal(receipt.package, PIN_RELEASE_PACKAGE_BY_ROLE[role]);
  assert.equal(receipt.versionName, "2026-08-09.1");
  assert.equal(receipt.versionCode, 202_608_091);
});

test("filesystem symlinks, multiple signers, and ambiguous Android metadata fail closed", async (t) => {
  const f = await fixture(t);
  const apkRoot = join(f.root, "adapter-negatives");
  await mkdir(apkRoot);
  await writeFile(join(apkRoot, "real.apk"), "regular bytes\n");
  await symlink("real.apk", join(apkRoot, "installer.apk"));
  await rejectsCode(
    () => inspectPinReleaseArtifact({
      role: "installer",
      apkRoot,
      path: "installer.apk",
      expectedSigner: SIGNER,
      toolRunner: f.toolRunner,
    }),
    "unsafe-path",
  );

  await rm(join(apkRoot, "installer.apk"));
  await writeFile(join(apkRoot, "installer.apk"), "regular bytes\n");
  const ambiguousRunner = async ({ label }) => {
    if (label.includes("application-id")) {
      return `${PIN_RELEASE_PACKAGE_BY_ROLE.installer}\nsecond.value\n`;
    }
    if (label.includes("version-name")) return "2026-08-09.1\n";
    if (label.includes("version-code")) return "202608091\n";
    return `Signer #1 certificate SHA-256 digest: ${SIGNER}\n`;
  };
  await rejectsCode(
    () => inspectPinReleaseArtifact({
      role: "installer",
      apkRoot,
      path: "installer.apk",
      expectedSigner: SIGNER,
      toolRunner: ambiguousRunner,
    }),
    "android-metadata-invalid",
  );

  const multiSignerRunner = async ({ label }) => {
    if (label.includes("application-id")) return `${PIN_RELEASE_PACKAGE_BY_ROLE.installer}\n`;
    if (label.includes("version-name")) return "2026-08-09.1\n";
    if (label.includes("version-code")) return "202608091\n";
    return (
      `Signer #1 certificate SHA-256 digest: ${SIGNER}\n` +
      `Signer #2 certificate SHA-256 digest: ${OTHER_SIGNER}\n`
    );
  };
  await rejectsCode(
    () => inspectPinReleaseArtifact({
      role: "installer",
      apkRoot,
      path: "installer.apk",
      expectedSigner: SIGNER,
      toolRunner: multiSignerRunner,
    }),
    "android-signature-invalid",
  );
});

test("configured and live signer fingerprints both fail closed", async (t) => {
  const f = await fixture(t);
  const release = await f.makeRelease("signer", {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
  });
  await rejectsCode(
    () => verifyPinReleaseBundle({
      ...release,
      expectedSigner: OTHER_SIGNER,
      toolRunner: f.toolRunner,
    }),
    "signer-mismatch",
  );

  const serverPath = await realpath(join(release.apkRoot, "server.apk"));
  f.metadata.get(serverPath).signerSha256 = OTHER_SIGNER;
  await rejectsCode(
    () => verifyPinReleaseBundle({
      ...release,
      expectedSigner: SIGNER,
      toolRunner: f.toolRunner,
    }),
    "signer-mismatch",
  );
});

test("plan requires exact serial and a versionCode above every installed package", async (t) => {
  const f = await fixture(t);
  const release = await f.makeRelease("monotonic", {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
  });
  const options = {
    ...release,
    expectedSigner: SIGNER,
    toolRunner: f.toolRunner,
    serial: SERIAL,
  };
  await rejectsCode(
    () => planPinRelease({ ...options, installedState: installedState(202_608_091) }),
    "version-regression",
  );
  await rejectsCode(
    () => planPinRelease({
      ...options,
      installedState: installedState(202_608_090, { serial: "DIFFERENT123" }),
    }),
    "serial-mismatch",
  );

});

test("partial, duplicate-role, and path-escape receipt bundles are rejected", async (t) => {
  const f = await fixture(t);
  const release = await f.makeRelease("shape", {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
  });
  const partial = structuredClone(release.receipts);
  partial.artifacts.pop();
  assert.throws(
    () => parsePinReleaseReceiptBundle(partial),
    (error) => error instanceof PinReleaseContractError && error.code === "partial-bundle",
  );

  const duplicate = structuredClone(release.receipts);
  duplicate.artifacts[4] = { ...duplicate.artifacts[0] };
  assert.throws(
    () => parsePinReleaseReceiptBundle(duplicate),
    (error) => error instanceof PinReleaseContractError && error.code === "duplicate-role",
  );

  const escaped = structuredClone(release.receipts);
  escaped.artifacts[0].path = "../installer.apk";
  assert.throws(
    () => parsePinReleaseReceiptBundle(escaped),
    (error) => error instanceof PinReleaseContractError && error.code === "unsafe-path",
  );
});

test("history rejects releaseId equivocation and both version dimensions regressions", async (t) => {
  const f = await fixture(t);
  const release = await f.makeRelease("history", {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
  });
  await rejectsCode(
    async () => verifyPinReleaseMetadata({
      manifest: release.manifest,
      receipts: release.receipts,
      expectedSigner: SIGNER,
      history: {
        schemaVersion: 1,
        releases: [{
          releaseId: release.manifest.releaseId,
          version: release.manifest.version,
          versionCode: release.manifest.artifacts[0].versionCode,
          manifestSha256: "0".repeat(64),
        }],
      },
    }),
    "release-equivocation",
  );

  const first = verifyPinReleaseMetadata({
    manifest: release.manifest,
    receipts: release.receipts,
    expectedSigner: SIGNER,
  });
  await rejectsCode(
    async () => verifyPinReleaseMetadata({
      manifest: release.manifest,
      receipts: release.receipts,
      expectedSigner: SIGNER,
      history: {
        schemaVersion: 1,
        releases: [{
          ...first.historyEntry,
          version: "2026-08-09.0",
          versionCode: 202_608_090,
        }],
      },
    }),
    "release-equivocation",
  );
  const older = await f.makeRelease("older", {
    version: "2026-08-09.0",
    versionCode: 202_608_090,
  });
  await rejectsCode(
    async () => verifyPinReleaseMetadata({
      manifest: older.manifest,
      receipts: older.receipts,
      expectedSigner: SIGNER,
      history: { schemaVersion: 1, releases: [first.historyEntry] },
    }),
    "version-regression",
  );
});

test("rollback descriptor is complete, byte-verified, signer-bound, and serial-bound", async (t) => {
  const f = await fixture(t);
  const target = await f.makeRelease("upgrade", {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
  });
  const previous = await f.makeRelease("rollback", {
    version: "2026-08-09.0",
    versionCode: 202_608_090,
  });
  const rollbackBundle = {
    schemaVersion: 1,
    kind: "atomic",
    serial: SERIAL,
    manifest: previous.manifest,
    receipts: previous.receipts,
  };
  const previousIdentity = verifyPinReleaseMetadata({
    manifest: previous.manifest,
    receipts: previous.receipts,
    expectedSigner: SIGNER,
  }).historyEntry;
  const plan = await planPinRelease({
    ...target,
    expectedSigner: SIGNER,
    toolRunner: f.toolRunner,
    serial: SERIAL,
    installedState: installedState(202_608_090, {
      currentRelease: previousIdentity,
      receipts: previous.receipts,
    }),
    rollbackBundle,
    rollbackRoot: previous.apkRoot,
  });
  assert.equal(plan.rollback.kind, "atomic");
  assert.equal(plan.rollback.releaseId, previous.manifest.releaseId);
  assert.equal(plan.rollback.versionCode, 202_608_090);
  assert.equal(plan.rollback.artifacts.length, 5);

  await rejectsCode(
    () => planPinRelease({
      ...target,
      expectedSigner: SIGNER,
      toolRunner: f.toolRunner,
      serial: SERIAL,
      installedState: installedState(202_608_090, {
        currentRelease: previousIdentity,
        receipts: previous.receipts,
      }),
      rollbackBundle: { ...rollbackBundle, serial: "WRONG123" },
      rollbackRoot: previous.apkRoot,
    }),
    "serial-mismatch",
  );

  const completeAtomicState = installedState(202_608_090, {
    complete: true,
    currentRelease: previousIdentity,
    receipts: previous.receipts,
  });
  await rejectsCode(
    () => planPinRelease({
      ...target,
      expectedSigner: SIGNER,
      toolRunner: f.toolRunner,
      serial: SERIAL,
      installedState: {
        ...completeAtomicState,
        artifacts: completeAtomicState.artifacts.map((artifact) =>
          artifact.role === "bootstrap"
            ? { ...artifact, sha256: OTHER_SIGNER }
            : artifact,
        ),
      },
      rollbackBundle,
      rollbackRoot: previous.apkRoot,
    }),
    "rollback-invalid",
  );

  const wrongLineage = await f.makeRelease("wrong-lineage-rollback", {
    version: "2026-08-08.9",
    versionCode: 202_608_090,
  });
  await rejectsCode(
    () => planPinRelease({
      ...target,
      expectedSigner: SIGNER,
      toolRunner: f.toolRunner,
      serial: SERIAL,
      installedState: installedState(202_608_090, {
        currentRelease: previousIdentity,
        receipts: previous.receipts,
      }),
      rollbackBundle: {
        schemaVersion: 1,
        kind: "atomic",
        serial: SERIAL,
        manifest: wrongLineage.manifest,
        receipts: wrongLineage.receipts,
      },
      rollbackRoot: wrongLineage.apkRoot,
    }),
    "rollback-invalid",
  );

  const future = await f.makeRelease("future-rollback", {
    version: "2099-01-01.1",
    versionCode: 202_608_090,
  });
  const futureIdentity = verifyPinReleaseMetadata({
    manifest: future.manifest,
    receipts: future.receipts,
    expectedSigner: SIGNER,
  }).historyEntry;
  await rejectsCode(
    () => planPinRelease({
      ...target,
      expectedSigner: SIGNER,
      toolRunner: f.toolRunner,
      serial: SERIAL,
      installedState: installedState(202_608_090, {
        currentRelease: futureIdentity,
        receipts: future.receipts,
      }),
      rollbackBundle: {
        schemaVersion: 1,
        kind: "atomic",
        serial: SERIAL,
        manifest: future.manifest,
        receipts: future.receipts,
      },
      rollbackRoot: future.apkRoot,
    }),
    "version-regression",
  );
});

test("legacy mixed migration preserves the real first-migration rollback identities", async (t) => {
  const f = await fixture(t);
  const target = await f.makeRelease("legacy-upgrade", {
    version: "2026-08-09.1",
    versionCode: 2_026_080_901,
  });
  const legacy = await f.makeLegacyRollback("legacy-rollback", {
    installer: { versionName: "2026-08-07.0", versionCode: 20_260_807 },
    hook: { versionName: "2026-08-07.0", versionCode: 20_260_807 },
    server: { versionName: "2026-08-08.2", versionCode: 2_026_080_802 },
    "hook-injector": { versionName: "2026-08-07.0", versionCode: 20_260_807 },
  });
  const state = legacyInstalledState(legacy.artifacts);
  const rollbackBundle = {
    schemaVersion: 1,
    kind: "legacy-mixed",
    serial: SERIAL,
    artifacts: legacy.artifacts,
  };
  const options = {
    ...target,
    expectedSigner: SIGNER,
    toolRunner: f.toolRunner,
    serial: SERIAL,
    installedState: state,
    rollbackBundle,
    rollbackRoot: legacy.apkRoot,
  };

  const plan = await planPinRelease(options);
  assert.equal(plan.fromVersionCode, 2_026_080_802);
  assert.equal(plan.toVersionCode, 2_026_080_901);
  assert.equal(plan.rollback.kind, "legacy-mixed");
  assert.deepEqual(
    plan.rollback.artifacts.map(({ role, versionName, versionCode }) => ({
      role,
      versionName,
      versionCode,
    })),
    [
      { role: "installer", versionName: "2026-08-07.0", versionCode: 20_260_807 },
      { role: "hook", versionName: "2026-08-07.0", versionCode: 20_260_807 },
      { role: "server", versionName: "2026-08-08.2", versionCode: 2_026_080_802 },
      { role: "hook-injector", versionName: "2026-08-07.0", versionCode: 20_260_807 },
    ],
  );

  await rejectsCode(
    () => planPinRelease({ ...options, rollbackBundle: undefined }),
    "rollback-invalid",
  );
  await rejectsCode(
    () => planPinRelease({
      ...options,
      rollbackBundle: { ...rollbackBundle, serial: "WRONG123" },
    }),
    "serial-mismatch",
  );
  await rejectsCode(
    () => planPinRelease({
      ...options,
      rollbackBundle: {
        ...rollbackBundle,
        artifacts: rollbackBundle.artifacts.slice(0, 3),
      },
    }),
    "partial-bundle",
  );

  for (const [field, value] of [
    ["versionName", "2026-08-07.1"],
    ["versionCode", 20_260_808],
    ["sha256", OTHER_SIGNER],
    ["signerSha256", OTHER_SIGNER],
  ]) {
    await rejectsCode(
      () => planPinRelease({
        ...options,
        rollbackBundle: {
          ...rollbackBundle,
          artifacts: rollbackBundle.artifacts.map((artifact) =>
            artifact.role === "installer" ? { ...artifact, [field]: value } : artifact,
          ),
        },
      }),
      "rollback-invalid",
    );
  }

  await rejectsCode(
    () => planPinRelease({
      ...options,
      installedState: {
        ...state,
        artifacts: state.artifacts.map((artifact) =>
          artifact.role === "server"
            ? { ...artifact, signerSha256: OTHER_SIGNER }
            : artifact,
        ),
      },
    }),
    "signer-mismatch",
  );

  const staleTarget = await f.makeRelease("legacy-stale-version", {
    version: "2026-08-08.1",
    versionCode: 2_026_080_902,
  });
  await rejectsCode(
    () => planPinRelease({ ...options, ...staleTarget }),
    "version-regression",
  );

  assert.throws(
    () => parsePinInstalledState({
      ...state,
      mode: "atomic",
      currentRelease: {
        releaseId: "c".repeat(64),
        version: "2026-08-08.2",
        versionCode: 2_026_080_802,
        manifestSha256: "d".repeat(64),
      },
    }),
    (error) =>
      error instanceof PinReleaseContractError &&
      error.code === "installed-state-invalid",
  );
  assert.throws(
    () => parsePinInstalledState({ ...state, artifacts: state.artifacts.slice(0, 3) }),
    (error) =>
      error instanceof PinReleaseContractError &&
      error.code === "installed-state-invalid",
  );

  const serverPath = join(legacy.apkRoot, "server.apk");
  const tamperedBytes = "tampered-after-legacy-inspection";
  await writeFile(serverPath, tamperedBytes);
  f.metadataByBytes.set(tamperedBytes, {
    package: PIN_RELEASE_PACKAGE_BY_ROLE.server,
    versionName: "2026-08-08.2",
    versionCode: 2_026_080_802,
    signerSha256: SIGNER,
  });
  await rejectsCode(
    () => planPinRelease(options),
    "receipt-mismatch",
  );
});

test("strict JSON rejects duplicate keys and the shared schema freezes Setup v1 fields", async () => {
  assert.throws(
    () => parsePinReleaseJson('{"schemaVersion":1,"schemaVersion":1}'),
    (error) => error instanceof PinReleaseContractError && error.code === "duplicate-json-key",
  );
  const schema = JSON.parse(
    await readFile(new URL("../../../contracts/pin-releases.schema.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(
    schema.$defs.setupManifest.required,
    ["schemaVersion", "releaseId", "version", "artifacts"],
  );
  assert.deepEqual(
    schema.$defs.setupArtifact.required,
    ["role", "url", "name", "package", "versionCode", "size", "sha256"],
  );
  assert.equal(schema.$defs.setupManifest.additionalProperties, false);
  assert.equal(schema.$defs.setupArtifact.additionalProperties, false);
  assert.deepEqual(
    schema.$defs.installedState.required,
    ["schemaVersion", "serial", "mode", "currentRelease", "artifacts"],
  );
  assert.deepEqual(
    schema.$defs.installedArtifact.required,
    ["role", "package", "versionName", "versionCode", "sha256", "signerSha256"],
  );
  assert.deepEqual(
    schema.$defs.rollbackBundle.oneOf.map((entry) => entry.$ref),
    ["#/$defs/atomicRollbackBundle", "#/$defs/legacyRollbackBundle"],
  );
  assert.deepEqual(
    schema.$defs.rollbackPlan.oneOf.map((entry) => entry.$ref),
    ["#/$defs/atomicRollbackPlan", "#/$defs/legacyRollbackPlan"],
  );
});

test("host release module exposes no device mutation command surface", async () => {
  const source = await readFile(new URL("../pin/release.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\badb\b|\bfastboot\b|\bflash(?:ing)?\b|factory[- ]reset/i);
  assert.match(source, /apkanalyzer/);
  assert.match(source, /apksigner/);
});
