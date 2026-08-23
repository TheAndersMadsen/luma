import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const releaseTarget = "/var/lib/ai-pin-revival/pin-releases";

function composeEnvironment(dataDirectory) {
  return {
    ...process.env,
    REVIVAL_RELEASE_ID: "pin-release-deployment-contract",
    REVIVAL_DATA_DIR: dataDirectory,
    COSMOS_KID_SCOPE: "enforce",
    COSMOS_DATABASE_URL: "postgresql://cosmos:placeholder@postgres/cosmos",
    COSMOS_EDGE_TOKEN: "placeholder-edge",
    COSMOS_ADMIN_TOKEN: "placeholder-admin",
    COSMOS_CENTER_PROJECTION_TOKEN: "placeholder-projection",
    COSMOS_CAPTURE_UPLOAD_BASE_URL: "https://uploads.example.test",
    COSMOS_ONBOARDING_ENDPOINT: "https://onboarding.example.test",
    COSMOS_ENROLLMENT_PINCODE: "0000",
    COSMOS_ENROLLMENT_USER_ID: "U:pin-release-deployment-contract",
    COSMOS_OPAQUE_SEED: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    AUTH_SESSION_SECRET: "placeholder-session",
    COSMOS_SHARE_TOKEN_SECRET: "placeholder-share",
    KEYCLOAK_CLIENT_SECRET: "placeholder-keycloak",
    COSMOS_PG_PASSWORD: "placeholder-postgres",
    GRAFANA_ADMIN_PASSWORD: "placeholder-grafana",
    SEARXNG_SECRET: "placeholder-search-secret",
    REVIVAL_PIN_BRIDGE_OWNER_SUB: "owner-pin-release-deployment-contract",
    REVIVAL_PIN_BRIDGE_DEVICE_ID: "2c2a00010000abcd",
  };
}

test("production Center serves only the canonical external Pin release tree", (context) => {
  const available = spawnSync("docker", ["compose", "version"], {
    cwd: root,
    encoding: "utf8",
  });
  if (available.error?.code === "ENOENT") {
    context.skip("Docker Compose is unavailable");
    return;
  }
  assert.equal(available.status, 0, available.stderr);

  const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "revival-pin-release-data-"));
  try {
    const result = spawnSync(
      "docker",
      [
        "compose",
        "-f",
        "compose.yaml",
        "-f",
        "platform/compose/production.yaml",
        "config",
        "--format",
        "json",
      ],
      { cwd: root, encoding: "utf8", env: composeEnvironment(dataDirectory) },
    );
    assert.equal(result.status, 0, result.stderr);
    const center = JSON.parse(result.stdout).services.center;
    assert.equal(center.environment.REVIVAL_PIN_RELEASE_DIR, releaseTarget);
    assert.equal(
      center.environment.REVIVAL_PIN_SETUP_ORIGIN,
      "https://center.andersmadsen.dk",
    );
    const mounts = center.volumes.filter((mount) => mount.target === releaseTarget);
    assert.equal(mounts.length, 1);
    const { bind = {}, ...mount } = mounts[0];
    assert.deepEqual(mount, {
      type: "bind",
      source: path.join(dataDirectory, "pin-releases"),
      target: releaseTarget,
      read_only: true,
    });
    assert.ok(
      bind.create_host_path === undefined || bind.create_host_path === true,
      "the read-only source bind must retain Compose's create-host-path default",
    );
    assert.deepEqual(
      Object.keys(bind).filter((key) => key !== "create_host_path"),
      [],
      "the source bind has no additional behavior",
    );
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
