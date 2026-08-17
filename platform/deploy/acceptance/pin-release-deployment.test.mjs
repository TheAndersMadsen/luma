import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const production = readFileSync(
  path.join(root, "platform/compose/production.yaml"),
  "utf8",
);
const staging = readFileSync(
  path.join(root, "platform/deploy/vps/remote/staging-smoke.sh"),
  "utf8",
);
const canary = readFileSync(
  path.join(root, "platform/deploy/vps/remote/canary.sh"),
  "utf8",
);
const releaseTarget = "/var/lib/ai-pin-revival/pin-releases";

function composeEnvironment(dataDirectory) {
  return {
    ...process.env,
    REVIVAL_RELEASE_ID: "pin-release-deployment-contract",
    REVIVAL_DATA_DIR: dataDirectory,
    CARRY_DATABASE_URL: "postgresql://carry:placeholder@postgres/carry",
    CARRY_EDGE_TOKEN: "placeholder-edge",
    CARRY_ADMIN_TOKEN: "placeholder-admin",
    CARRY_CENTER_PROJECTION_TOKEN: "placeholder-projection",
    CARRY_CAPTURE_UPLOAD_BASE_URL: "https://uploads.example.test",
    CARRY_ONBOARDING_ENDPOINT: "https://onboarding.example.test",
    CARRY_ENROLLMENT_PINCODE: "0000",
    CARRY_ENROLLMENT_USER_ID: "U:pin-release-deployment-contract",
    CARRY_OPAQUE_SEED: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    AUTH_SESSION_SECRET: "placeholder-session",
    CARRY_SHARE_TOKEN_SECRET: "placeholder-share",
    KEYCLOAK_CLIENT_SECRET: "placeholder-keycloak",
    CARRY_KEYCLOAK_DB_PASSWORD: "placeholder-keycloak-db",
    CARRY_PG_PASSWORD: "placeholder-postgres",
    GRAFANA_ADMIN_PASSWORD: "placeholder-grafana",
    SEARXNG_SECRET: "placeholder-search-secret",
    REVIVAL_PIN_BRIDGE_OWNER_SUB: "owner-pin-release-deployment-contract",
    REVIVAL_PIN_BRIDGE_DEVICE_ID: "device-pin-release-deployment-contract",
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
    assert.deepEqual(mounts[0], {
      type: "bind",
      source: path.join(dataDirectory, "pin-releases"),
      target: releaseTarget,
      read_only: true,
      bind: {},
    });
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("isolated staging accounts for the release mount and checks the empty boundary", () => {
  assert.match(
    staging,
    /pin_release_volume="\$\{scope\}-pin-releases"/,
  );
  assert.match(
    staging,
    /--volume "\$pin_release_volume:\/var\/lib\/ai-pin-revival\/pin-releases:ro"/,
  );
  assert.match(staging, /assert_center_pin_release_mount/);
  assert.match(staging, /mount\.get\("RW"\) is not False/);
  assert.match(staging, /response\.status!==404/);
  assert.match(staging, /Pin release not found\./);
  assert.doesNotMatch(staging, /api\/pin\/releases\/current'[^\n]*(?:POST|PUT|PATCH|DELETE)/);

  const syntax = spawnSync("bash", ["-n", "platform/deploy/vps/remote/staging-smoke.sh"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(production, /REVIVAL_PIN_RELEASE_DIR: \/var\/lib\/ai-pin-revival\/pin-releases/);
});

test("production canary proves the read-only mount and bounded same-origin release API", () => {
  assert.match(canary, /REVIVAL_PIN_RELEASE_DIR/);
  assert.match(canary, /REVIVAL_PIN_SETUP_ORIGIN/);
  assert.match(canary, /mount\.get\("RW"\) is False/);
  assert.match(canary, /\/api\/pin\/releases\/current/);
  assert.match(canary, /--max-filesize 65536/);
  assert.match(canary, /Origin: https:\/\/center\.andersmadsen\.dk/);
  assert.match(canary, /get_status in \{"200","404"\}/);
  assert.match(canary, /Pin release not found\./);
  assert.doesNotMatch(
    canary,
    /api\/pin\/releases\/current[^\n]*(?:POST|PUT|PATCH|DELETE)/,
  );
});
