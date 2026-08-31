import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalPinReleaseManifestJson,
  createPinReleaseManifest,
  PIN_RELEASE_ARTIFACT_ROLES,
  PIN_RELEASE_PACKAGE_BY_ROLE,
} from "../pin/release.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const releaseTarget = "/var/lib/ai-pin-revival/pin-releases";

function seedPinRelease(environment) {
  const root = path.join(environment.REVIVAL_DATA_DIR, "pin-releases");
  const version = "2026-08-24.1";
  const versionCode = 202_608_241;
  const signerSha256 = "d".repeat(64);
  const bytesByRole = new Map();
  const artifacts = PIN_RELEASE_ARTIFACT_ROLES.map((role) => {
    const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`signed-${role}`)]);
    bytesByRole.set(role, bytes);
    return {
      role,
      path: `signed/${role}.apk`,
      name: `${role}.apk`,
      package: PIN_RELEASE_PACKAGE_BY_ROLE[role],
      versionName: version,
      versionCode,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      signerSha256,
    };
  });
  const manifest = createPinReleaseManifest({ version, receipts: { schemaVersion: 1, artifacts } });
  const document = canonicalPinReleaseManifestJson(manifest);
  const release = path.join(root, "releases", manifest.releaseId);
  fs.mkdirSync(release, { recursive: true, mode: 0o700 });
  for (const role of PIN_RELEASE_ARTIFACT_ROLES) {
    fs.writeFileSync(path.join(release, `${role}.apk`), bytesByRole.get(role), { mode: 0o600 });
  }
  fs.writeFileSync(path.join(release, "manifest.json"), document, { mode: 0o600 });
  fs.writeFileSync(path.join(root, "current.json"), document, { mode: 0o600 });
  return {
    schemaVersion: 1,
    archive: `ai-pin-revival-pin-${version}.tar.gz`,
    sha256: "a".repeat(64),
    size: 1,
    releaseId: manifest.releaseId,
    version,
    versionCode,
    signerSha256,
    manifestSha256: createHash("sha256").update(document).digest("hex"),
    receiptsSha256: "b".repeat(64),
  };
}

function copyOperatorFixture(temporary) {
  const operatorRoot = path.join(temporary, "operator");
  fs.mkdirSync(operatorRoot);
  for (const selected of ["revival", ".env.example", "contracts", "platform"]) {
    fs.cpSync(path.join(root, selected), path.join(operatorRoot, selected), { recursive: true });
  }
  fs.mkdirSync(path.join(operatorRoot, "cosmos"));
  fs.cpSync(path.join(root, "cosmos", "search"), path.join(operatorRoot, "cosmos", "search"), {
    recursive: true,
  });
  return operatorRoot;
}

test("production Center mounts only the operator-local Pin release tree", (context) => {
  const available = spawnSync("docker", ["compose", "version"], {
    cwd: root,
    encoding: "utf8",
  });
  if (available.error?.code === "ENOENT") {
    context.skip("Docker Compose is unavailable");
    return;
  }
  assert.equal(available.status, 0, available.stderr);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-pin-release-deployment-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const operatorRoot = copyOperatorFixture(temporary);
  const operatorCli = path.join(operatorRoot, "revival");
  const environment = {
    ...process.env,
    REVIVAL_CONFIG_DIR: path.join(temporary, "config"),
    REVIVAL_SECRETS_DIR: path.join(temporary, "secrets"),
    REVIVAL_ENV_FILE: path.join(temporary, "secrets", "runtime.env"),
    REVIVAL_DATA_DIR: path.join(temporary, "data"),
    REVIVAL_BUILD_DIR: path.join(temporary, "data", "build"),
  };
  const setup = spawnSync(process.execPath, [
    operatorCli,
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
  ], { cwd: operatorRoot, env: environment, encoding: "utf8" });
  assert.equal(setup.status, 0, setup.stderr);
  const pin = seedPinRelease(environment);
  fs.writeFileSync(
    path.join(operatorRoot, "platform", "distribution", "version.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      version: "1.2.3",
      revision: "c".repeat(40),
      application: `oci://ghcr.io/example/project/application@sha256:${"d".repeat(64)}`,
      source: { repository: "example/project", tag: "v1.2.3" },
      pin,
    })}\n`,
  );
  const pinSetup = spawnSync(process.execPath, [
    operatorCli,
    "setup", "production",
    "--profile", "pin",
    "--profile", "search",
    "--profile", "spotify",
    "--profile", "observability",
    "--public-ip", "203.0.113.42",
  ], { cwd: operatorRoot, env: environment, encoding: "utf8" });
  assert.equal(pinSetup.status, 0, pinSetup.stderr);
  const operatorCompose = path.join(environment.REVIVAL_CONFIG_DIR, "production", "operator.compose.yaml");
  assert.match(
    fs.readFileSync(operatorCompose, "utf8"),
    /target: \/var\/lib\/ai-pin-revival\/pin-releases\n\s+read_only: true\n\s+bind: \{ create_host_path: false \}/,
  );
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--project-directory", root,
      "--env-file", environment.REVIVAL_ENV_FILE,
      "-f", path.join(root, "compose.yaml"),
      "-f", path.join(root, "platform/compose/production.yaml"),
      "-f", operatorCompose,
      "config",
      "--format", "json",
    ],
    { cwd: root, encoding: "utf8", env: environment },
  );
  assert.equal(result.status, 0, result.stderr);

  const center = JSON.parse(result.stdout).services.center;
  assert.equal(center.environment.REVIVAL_PIN_RELEASE_DIR, releaseTarget);
  assert.equal(center.environment.REVIVAL_PIN_SETUP_ORIGIN, "https://pin.example.test");
  assert.equal(center.environment.REVIVAL_PIN_RELEASE_EXPECTED_ID, pin.releaseId);
  assert.equal(center.environment.REVIVAL_PIN_RELEASE_EXPECTED_MANIFEST_SHA256, pin.manifestSha256);
  const mounts = center.volumes.filter((mount) => mount.target === releaseTarget);
  assert.equal(mounts.length, 1);
  const { bind, ...mount } = mounts[0];
  assert.deepEqual(mount, {
    type: "bind",
    source: path.join(environment.REVIVAL_DATA_DIR, "pin-releases"),
    target: releaseTarget,
    read_only: true,
  });
  assert.deepEqual(bind, bind?.create_host_path === false ? { create_host_path: false } : {});
  assert.equal(center.environment.REVIVAL_SPOTIFY_ADAPTER_URL, "http://spotify-adapter:18081");
  assert.equal(
    JSON.parse(result.stdout).services["spotify-adapter"].environment.REVIVAL_SPOTIFY_ADAPTER_BIND_ADDRESS,
    "0.0.0.0",
  );
  assert.deepEqual(Object.keys(JSON.parse(result.stdout).services["spotify-adapter"].networks), ["pin-control"]);

  const runtimeBeforeRejectedUpgrade = fs.readFileSync(environment.REVIVAL_ENV_FILE, "utf8");
  const olderPin = {
    ...pin,
    archive: "ai-pin-revival-pin-2026-08-23.1.tar.gz",
    releaseId: "e".repeat(64),
    version: "2026-08-23.1",
    versionCode: 202_608_231,
    manifestSha256: "f".repeat(64),
  };
  fs.writeFileSync(
    path.join(operatorRoot, "platform", "distribution", "version.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      version: "1.2.4",
      revision: "e".repeat(40),
      application: `oci://ghcr.io/example/project/application@sha256:${"f".repeat(64)}`,
      source: { repository: "example/project", tag: "v1.2.4" },
      pin: olderPin,
    })}\n`,
  );
  const rejectedUpgrade = spawnSync(process.execPath, [operatorCli, "setup", "production"], {
    cwd: operatorRoot,
    env: environment,
    encoding: "utf8",
  });
  assert.equal(rejectedUpgrade.status, 1);
  assert.match(rejectedUpgrade.stderr, /does not match operator release Pin/u);
  assert.equal(fs.readFileSync(environment.REVIVAL_ENV_FILE, "utf8"), runtimeBeforeRejectedUpgrade);
});
