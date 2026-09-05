import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
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
const cli = path.join(root, "revival");
const require = createRequire(import.meta.url);
const { productionRealm } = require("../../cli/production-setup.js");
const { guidedProductionArguments } = require("../../cli/guided-production-setup.js");
const { runProductionOnboarding } = require("../../cli/onboard.js");

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-setup-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  return {
    temporary,
    env: {
      ...process.env,
      REVIVAL_CONFIG_DIR: path.join(temporary, "config"),
      REVIVAL_SECRETS_DIR: path.join(temporary, "secrets"),
      REVIVAL_ENV_FILE: path.join(temporary, "secrets", "runtime.env"),
      REVIVAL_DATA_DIR: path.join(temporary, "data"),
      REVIVAL_BUILD_DIR: path.join(temporary, "data", "build"),
      REVIVAL_STATE_DIR: path.join(temporary, "state"),
    },
  };
}

function invoke(env, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function renderProductionCompose(env) {
  const available = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  if (available.error?.code === "ENOENT" || available.status !== 0) return null;
  return spawnSync("docker", [
    "compose",
    "--project-directory", root,
    "--env-file", env.REVIVAL_ENV_FILE,
    "-f", path.join(root, "compose.yaml"),
    "-f", path.join(root, "platform/compose/production.yaml"),
    "-f", path.join(env.REVIVAL_CONFIG_DIR, "production", "operator.compose.yaml"),
    "config", "--quiet",
  ], { cwd: root, env, encoding: "utf8" });
}

function parseEnv(file) {
  return Object.fromEntries(
    fs.readFileSync(file, "utf8")
      .split(/\r?\n/u)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function guidedIo(lines) {
  const pending = [...lines];
  let output = "";
  return {
    io: {
      readLine() {
        assert.ok(pending.length > 0, "guided setup requested an unexpected answer");
        return pending.shift();
      },
      write(value) {
        output += value;
      },
    },
    output: () => output,
  };
}

test("production onboarding composes the canonical safe sequence", () => {
  const calls = [];
  const output = [];
  runProductionOnboarding({
    setup: () => calls.push("setup"),
    doctor: () => calls.push("doctor"),
    dryRun: () => calls.push("dry-run"),
    deploy: () => calls.push("deploy"),
    verify: () => calls.push("verify"),
    values: () => ({ REVIVAL_PUBLIC_ORIGIN: "https://pin.example.test" }),
    readLine: () => "yes",
    write: (value) => output.push(value),
  });
  assert.deepEqual(calls, ["setup", "doctor", "dry-run", "deploy", "verify"]);
  assert.match(output.at(-2), /https:\/\/pin\.example\.test\/login\?next=%2Fsettings%2Fpin%2Fsetup/u);
});

test("production onboarding stops after the dry-run when deployment is declined", () => {
  const calls = [];
  assert.throws(() => runProductionOnboarding({
    setup: () => calls.push("setup"),
    doctor: () => calls.push("doctor"),
    dryRun: () => calls.push("dry-run"),
    deploy: () => calls.push("deploy"),
    verify: () => calls.push("verify"),
    readLine: () => "no",
    write: () => {},
  }), /deployment cancelled/u);
  assert.deepEqual(calls, ["setup", "doctor", "dry-run"]);
});

test("production onboarding reports a safe stage-specific recovery after every failure", () => {
  const stages = [
    {
      operation: "setup",
      expected: /stage 1\/5 \(configuration\)/u,
      state: /production deployment was not started/iu,
      recovery: /\.\/revival setup production --guided/u,
    },
    {
      operation: "doctor",
      expected: /stage 2\/5 \(preflight\)/u,
      state: /production deployment was not started/iu,
      recovery: /\.\/revival doctor production/u,
    },
    {
      operation: "dryRun",
      expected: /stage 3\/5 \(safe deployment preview\)/u,
      state: /production deployment was not started/iu,
      recovery: /\.\/revival deploy production --dry-run/u,
    },
    {
      operation: "deploy",
      expected: /stage 4\/5 \(deployment\)/u,
      state: /server containers may have changed/iu,
      recovery: /\.\/revival verify production/u,
    },
    {
      operation: "verify",
      expected: /stage 5\/5 \(verification\)/u,
      state: /deployed server state was preserved/iu,
      recovery: /\.\/revival verify production/u,
    },
  ];

  for (const failed of stages) {
    const runtime = {
      setup: () => {},
      doctor: () => {},
      dryRun: () => {},
      deploy: () => {},
      verify: () => {},
      values: () => ({ REVIVAL_PUBLIC_ORIGIN: "https://pin.example.test" }),
      readLine: () => "yes",
      write: () => {},
    };
    runtime[failed.operation] = () => {
      throw new Error("provider password=never-print-this ghp_abcdefghijklmnopqrstuvwxyz");
    };
    assert.throws(() => runProductionOnboarding(runtime), (error) => {
      assert.match(error.message, failed.expected);
      assert.match(error.message, failed.state);
      assert.match(error.message, failed.recovery);
      assert.match(error.message, /safe retry: \.\/revival onboard production/iu);
      assert.match(error.message, /No Pin was contacted or changed/u);
      assert.doesNotMatch(error.message, /never-print-this|ghp_/u);
      return true;
    });
  }
});

test("declining deployment explains exactly what the safe rerun preserves", () => {
  assert.throws(() => runProductionOnboarding({
    setup: () => {},
    doctor: () => {},
    dryRun: () => {},
    deploy: () => assert.fail("deploy must not run"),
    verify: () => assert.fail("verify must not run"),
    readLine: () => "no",
    write: () => {},
  }), (error) => {
    assert.match(error.message, /deployment was not started/u);
    assert.match(error.message, /configuration was preserved/u);
    assert.match(error.message, /safe retry: \.\/revival onboard production/iu);
    return true;
  });
});

function seedPinRelease(env) {
  const root = path.join(env.REVIVAL_DATA_DIR, "pin-releases");
  const version = "2026-08-24.1";
  const versionCode = 202_608_241;
  const signerSha256 = "c".repeat(64);
  const byRole = new Map();
  const artifacts = PIN_RELEASE_ARTIFACT_ROLES.map((role) => {
    const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`signed-${role}`)]);
    byRole.set(role, bytes);
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
    fs.writeFileSync(path.join(release, `${role}.apk`), byRole.get(role), { mode: 0o600 });
  }
  fs.writeFileSync(path.join(release, "manifest.json"), document, { mode: 0o600 });
  fs.writeFileSync(path.join(root, "current.json"), document, { mode: 0o600 });
  return { manifest, release };
}

test("generated production identity supports Center's direct password grant", () => {
  const password = "p".repeat(32);
  const realm = productionRealm({
    REVIVAL_PUBLIC_ORIGIN: "https://pin.example.test",
    REVIVAL_FIRST_OPERATOR_EMAIL: "owner@example.test",
    REVIVAL_FIRST_OPERATOR_ID: "11111111-1111-4111-8111-111111111111",
    KEYCLOAK_CLIENT_ID: "center",
    KEYCLOAK_CLIENT_SECRET: "s".repeat(32),
  }, password);
  assert.equal(realm.loginTheme, "revival");
  assert.equal(realm.clients[0].publicClient, false);
  assert.equal(realm.clients[0].directAccessGrantsEnabled, true);
  assert.deepEqual(realm.users[0].requiredActions, []);
  assert.deepEqual(realm.users[0].credentials, [{ type: "password", value: password, temporary: false }]);
  assert.match(fs.readFileSync(path.join(root, "center/src/server/auth.ts"), "utf8"), /grant_type: "password"/u);
});

test("guided production setup collects one reviewed newcomer configuration", () => {
  const scripted = guidedIo([
    "center.example.test",
    "acme@example.test",
    "owner@example.test",
    "",
    "203.0.113.10",
    "yes",
  ]);
  const args = guidedProductionArguments({}, scripted.io);
  assert.deepEqual(args, [
    "--domain", "center.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
    "--public-ip", "203.0.113.10",
    "--profile", "pin",
    "--profile", "search",
    "--profile", "spotify",
  ]);
  assert.match(scripted.output(), /\[1\/5\] Public Center domain/u);
  assert.match(scripted.output(), /\[5\/5\] Review/u);
  assert.match(scripted.output(), /does not deploy or change a Pin/u);
  assert.match(scripted.output(), /deployment remains a separate confirmed command/u);
});

test("guided production setup preserves current public values and requires confirmation", () => {
  const current = {
    REVIVAL_PUBLIC_DOMAIN: "center.current.test",
    REVIVAL_ACME_EMAIL: "acme@current.test",
    REVIVAL_FIRST_OPERATOR_EMAIL: "owner@current.test",
    REVIVAL_DEVICE_EDGE_IPV4: "198.51.100.22",
    COMPOSE_PROFILES: "pin,search,spotify",
  };
  const accepted = guidedIo(["", "", "", "", "", "y"]);
  assert.deepEqual(guidedProductionArguments(current, accepted.io), [
    "--domain", "center.current.test",
    "--acme-email", "acme@current.test",
    "--operator-email", "owner@current.test",
    "--public-ip", "198.51.100.22",
    "--profile", "pin",
    "--profile", "search",
    "--profile", "spotify",
  ]);

  const cancelled = guidedIo(["", "", "", "", "", "no"]);
  assert.throws(
    () => guidedProductionArguments(current, cancelled.io),
    /cancelled; no configuration was written/u,
  );
});

test("guided setup refuses a noninteractive invocation before creating state", (t) => {
  const { env } = fixture(t);
  const result = invoke(env, "setup", "production", "--guided");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires an interactive terminal/u);
  assert.equal(fs.existsSync(env.REVIVAL_CONFIG_DIR), false);
});

test("local setup creates real external configuration and status derives from it", (t) => {
  const { env } = fixture(t);
  const setup = invoke(env, "setup", "local");
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /NEXT \.\/revival doctor/u);
  assert.equal(fs.statSync(env.REVIVAL_ENV_FILE).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(env.REVIVAL_STATE_DIR), false, "setup keeps no progress state");

  const status = invoke(env, "setup", "status", "--json");
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), {
    schemaVersion: 4,
    contract: { id: "operator-setup", version: "2.4.0", journey: "local" },
    state: "local-ready",
    mode: "local",
    ok: true,
    nextCommandId: "doctor.local",
    next: "./revival doctor",
    release: { operator: { version: "0.1.0-dev", revision: "source" }, pin: null },
  });

  fs.unlinkSync(env.REVIVAL_ENV_FILE);
  const changed = invoke(env, "setup", "status", "--json");
  assert.equal(changed.status, 1);
  assert.deepEqual(JSON.parse(changed.stdout), {
    schemaVersion: 4,
    contract: { id: "operator-setup", version: "2.4.0", journey: "production" },
    state: "uninitialized",
    mode: "uninitialized",
    ok: false,
    nextCommandId: null,
    next: "./revival setup local or ./revival onboard production",
    release: { operator: { version: "0.1.0-dev", revision: "source" }, pin: null },
  });
});

test("production setup creates a complete portable operator installation and is idempotent", (t) => {
  const { env } = fixture(t);
  const args = [
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
    "--profile", "search",
    "--profile", "observability",
  ];
  const first = invoke(env, ...args);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Production configuration is ready for https:\/\/pin\.example\.test/u);

  const runtime = parseEnv(env.REVIVAL_ENV_FILE);
  assert.equal(runtime.REVIVAL_PUBLIC_ORIGIN, "https://pin.example.test");
  assert.equal(runtime.COSMOS_OIDC_ISSUER, "https://pin.example.test/realms/humane");
  assert.equal(runtime.COSMOS_RTC_URL, "ws://livekit:7880");
  assert.equal(runtime.COSMOS_RTC_PUBLIC_URL, "wss://pin.example.test/livekit");
  assert.ok(runtime.COSMOS_RTC_API_KEY.length >= 16);
  assert.ok(runtime.COSMOS_RTC_API_SECRET.length >= 32);
  assert.ok(!first.stdout.includes(runtime.COSMOS_RTC_API_SECRET));
  assert.equal(runtime.COMPOSE_PROFILES, "observability,search");
  assert.equal(runtime.COSMOS_ENROLLMENT_PINCODE, "");
  assert.equal(runtime.REVIVAL_FIRST_OPERATOR_EMAIL, "owner@example.test");
  assert.equal(Object.hasOwn(runtime, "REVIVAL_FIRST_OPERATOR_PASSWORD"), false);

  const production = path.join(env.REVIVAL_CONFIG_DIR, "production");
  const operatorCompose = path.join(production, "operator.compose.yaml");
  const realmFile = path.join(production, "realm.json");
  const protectedFiles = [operatorCompose, path.join(production, "first-login.txt")];
  const containerFiles = [
    path.join(production, "traefik.yaml"),
    path.join(production, "traefik-dynamic.yaml"),
    path.join(production, "livekit.json"),
    path.join(production, "postgres-init.sql"),
    realmFile,
    path.join(production, "searxng-settings.yml"),
    path.join(production, "prometheus.yml"),
  ];
  for (const file of protectedFiles) {
    assert.ok(fs.statSync(file).size > 0, `${file} must be nonempty`);
    assert.equal(fs.statSync(file).mode & 0o077, 0, `${file} must be operator-only`);
  }
  for (const file of containerFiles) assert.equal(fs.statSync(file).mode & 0o777, 0o444, file);
  assert.equal(fs.statSync(production).mode & 0o777, 0o700);

  const realm = JSON.parse(fs.readFileSync(realmFile, "utf8"));
  const roomConfig = JSON.parse(fs.readFileSync(path.join(production, "livekit.json"), "utf8"));
  assert.ok(roomConfig.keys[runtime.COSMOS_RTC_API_KEY] === runtime.COSMOS_RTC_API_SECRET);
  assert.equal(Object.keys(roomConfig.keys).length, 1);
  assert.equal(roomConfig.rtc.use_external_ip, true);
  assert.equal(roomConfig.rtc.advertise_internal_ip, true);
  assert.equal(roomConfig.rtc.require_ipv4, true);
  assert.equal(roomConfig.turn.tls_port, 0);
  assert.equal(roomConfig.room.max_participants, 17);
  assert.equal(realm.realm, "humane");
  assert.equal(realm.loginTheme, "revival");
  assert.equal(realm.users[0].id, runtime.REVIVAL_FIRST_OPERATOR_ID);
  assert.equal(realm.clients[0].directAccessGrantsEnabled, true);
  assert.deepEqual(realm.users[0].requiredActions, []);
  assert.equal(realm.users[0].credentials[0].temporary, false);
  assert.ok(realm.users[0].credentials[0].value.length >= 24);
  assert.deepEqual(realm.users[0].realmRoles, ["cosmos-operator"]);
  const loginHandoff = fs.readFileSync(path.join(production, "first-login.txt"), "utf8");
  assert.match(
    loginHandoff,
    /^Guided setup: https:\/\/pin\.example\.test\/login\?next=%2Fsettings%2Fpin%2Fsetup$/m,
  );
  assert.match(loginHandoff, new RegExp(`^Initial password: ${realm.users[0].credentials[0].value}$`, "m"));
  assert.match(
    first.stdout,
    /After deployment: https:\/\/pin\.example\.test\/login\?next=%2Fsettings%2Fpin%2Fsetup/u,
  );
  assert.match(fs.readFileSync(path.join(root, "center/src/server/auth.ts"), "utf8"), /grant_type: "password"/u);
  const dynamicConfig = fs.readFileSync(path.join(production, "traefik-dynamic.yaml"), "utf8");
  assert.match(dynamicConfig, /pin\.example\.test/u);
  const nativeRoute = dynamicConfig.split("    native-runtime-bootstrap:\n")[1]?.split("    center:\n")[0];
  assert.ok(nativeRoute, "production must expose only native proof and room bootstrap over HTTPS");
  assert.ok(nativeRoute.includes('rule: "Host(`pin.example.test`) && (Path(`/runtime-api/v1/native/challenge`) || Path(`/runtime-api/v1/native/open`) || Path(`/runtime-api/v1/native/room`))"'));
  assert.match(nativeRoute, /entryPoints: \[websecure\]/u);
  assert.match(nativeRoute, /service: ai-bus/u);
  assert.doesNotMatch(nativeRoute, /PathPrefix|surface-api|admin/u);
  const operatorModel = fs.readFileSync(operatorCompose, "utf8");
  assert.doesNotMatch(operatorModel, /container-inputs|spotify-token|edge-server|pin-releases/u);
  assert.match(operatorModel, /searxng-settings|prometheus/u);
  assert.doesNotMatch(operatorModel, /center\.andersmadsen\.dk|\/home\/anders\/carry/u);
  assert.equal(fs.existsSync(path.join(production, "container-inputs")), false);
  assert.equal(fs.existsSync(path.join(env.REVIVAL_DATA_DIR, "pin-releases")), false);
  assert.equal(fs.existsSync(path.join(env.REVIVAL_SECRETS_DIR, "pki")), false);
  assert.equal(fs.existsSync(path.join(env.REVIVAL_CONFIG_DIR, "pin-assets")), false);
  assert.equal(fs.existsSync(env.REVIVAL_STATE_DIR), false);

  const preserved = {
    realm: fs.readFileSync(realmFile, "utf8"),
  };
  fs.unlinkSync(path.join(production, "first-login.txt"));
  const rerun = invoke(env, "setup", "production");
  assert.equal(rerun.status, 0, rerun.stderr);
  const after = parseEnv(env.REVIVAL_ENV_FILE);
  assert.ok(after.COSMOS_RTC_API_KEY === runtime.COSMOS_RTC_API_KEY);
  assert.ok(after.COSMOS_RTC_API_SECRET === runtime.COSMOS_RTC_API_SECRET);
  assert.equal(Object.hasOwn(after, "REVIVAL_FIRST_OPERATOR_PASSWORD"), false);
  assert.equal(fs.readFileSync(realmFile, "utf8"), preserved.realm);
  assert.equal(fs.existsSync(path.join(production, "first-login.txt")), false);

  const status = invoke(env, "setup", "status", "--json");
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), {
    schemaVersion: 4,
    contract: { id: "operator-setup", version: "2.4.0", journey: "production" },
    state: "production-ready",
    mode: "production",
    ok: true,
    nextCommandId: "onboard.production",
    next: "./revival onboard production",
    release: { operator: { version: "0.1.0-dev", revision: "source" }, pin: null },
  });
});

test("source checkout validates every pin option before rejecting unbound production setup", (t) => {
  const { env } = fixture(t);
  const common = [
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
    "--profile", "pin",
  ];
  const missing = invoke(env, ...common);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /pin profile requires --public-ip/u);
  assert.equal(fs.existsSync(env.REVIVAL_CONFIG_DIR), false, "invalid setup must not create partial state");

  const setup = invoke(env, ...common, "--public-ip", "203.0.113.42");
  assert.equal(setup.status, 1);
  assert.match(setup.stderr, /requires a published schema-v2 operator release bound to one exact Pin archive/u);
  assert.equal(fs.existsSync(env.REVIVAL_CONFIG_DIR), false, "unbound release rejection must be read-only");
});

test("core setup omits optional state and --no-profiles clears active profiles", (t) => {
  const { env } = fixture(t);
  const common = [
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
  ];
  const core = invoke(env, ...common);
  assert.equal(core.status, 0, core.stderr);
  let runtime = parseEnv(env.REVIVAL_ENV_FILE);
  assert.equal(runtime.COMPOSE_PROFILES, "");
  assert.equal(runtime.GRAFANA_ADMIN_PASSWORD, "");
  assert.equal(runtime.SEARXNG_SECRET, "");
  assert.equal(runtime.COSMOS_OPAQUE_SEED, "");
  const production = path.join(env.REVIVAL_CONFIG_DIR, "production");
  for (const name of ["envoy.yaml", "spotify-token", "searxng-settings.yml", "prometheus.yml", "grafana"]) {
    assert.equal(fs.existsSync(path.join(production, name)), false, name);
  }

  const search = invoke(env, ...common, "--profile", "search");
  assert.equal(search.status, 0, search.stderr);
  assert.equal(parseEnv(env.REVIVAL_ENV_FILE).COMPOSE_PROFILES, "search");
  const cleared = invoke(env, "setup", "production", "--no-profiles");
  assert.equal(cleared.status, 0, cleared.stderr);
  runtime = parseEnv(env.REVIVAL_ENV_FILE);
  assert.equal(runtime.COMPOSE_PROFILES, "");
  assert.equal(runtime.COSMOS_SEARXNG_BASE_URL, "");
  assert.doesNotMatch(fs.readFileSync(path.join(production, "operator.compose.yaml"), "utf8"), /searxng/u);

  const spotifyWithoutPin = invoke(env, "setup", "production", "--profile", "spotify");
  assert.equal(spotifyWithoutPin.status, 1);
  assert.match(spotifyWithoutPin.stderr, /spotify profile requires the pin profile/u);
});

test("production setup resumes from a first-login handoff written before the realm", (t) => {
  const { env } = fixture(t);
  const args = [
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
  ];
  const first = invoke(env, ...args);
  assert.equal(first.status, 0, first.stderr);
  const production = path.join(env.REVIVAL_CONFIG_DIR, "production");
  const realmFile = path.join(production, "realm.json");
  const password = JSON.parse(fs.readFileSync(realmFile, "utf8")).users[0].credentials[0].value;
  fs.unlinkSync(realmFile);

  const resumed = invoke(env, "setup", "production");
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(fs.readFileSync(realmFile, "utf8")).users[0].credentials[0].value, password);
});

test("production identity bootstrap refuses changed immutable inputs", (t) => {
  const { env } = fixture(t);
  const setup = invoke(
    env,
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
  );
  assert.equal(setup.status, 0, setup.stderr);
  const before = fs.readFileSync(env.REVIVAL_ENV_FILE, "utf8");
  const changed = invoke(env, "setup", "production", "--domain", "other.example.test");
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /identity bootstrap is immutable/u);
  assert.equal(fs.readFileSync(env.REVIVAL_ENV_FILE, "utf8"), before);
});

test("source checkout cannot substitute an empty store for descriptor-bound release closure", (t) => {
  const { env } = fixture(t);
  const setup = invoke(
    env,
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
    "--profile", "pin",
    "--public-ip", "203.0.113.42",
  );
  assert.equal(setup.status, 1);
  assert.match(setup.stderr, /requires a published schema-v2 operator release/u);
  assert.equal(fs.existsSync(env.REVIVAL_CONFIG_DIR), false);
});

test("source checkout cannot substitute a seeded local release for authenticated release closure", (t) => {
  const { env } = fixture(t);
  const core = invoke(
    env,
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
  );
  assert.equal(core.status, 0, core.stderr);
  const { manifest, release } = seedPinRelease(env);
  const server = manifest.artifacts.find((artifact) => artifact.role === "server");
  fs.writeFileSync(path.join(release, "server.apk"), Buffer.alloc(server.size, 0x78), { mode: 0o600 });
  const setup = invoke(env, "setup", "production", "--profile", "pin", "--public-ip", "203.0.113.42");
  assert.equal(setup.status, 1);
  assert.match(setup.stderr, /requires a published schema-v2 operator release/u);
});

test("production readiness fails when a required generated artifact is missing", (t) => {
  const { env } = fixture(t);
  const setup = invoke(
    env,
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
  );
  assert.equal(setup.status, 0, setup.stderr);
  fs.unlinkSync(path.join(env.REVIVAL_CONFIG_DIR, "production", "traefik-dynamic.yaml"));

  const status = invoke(env, "setup", "status", "--json");
  assert.equal(status.status, 1);
  const report = JSON.parse(status.stdout);
  assert.equal(report.mode, "production");
  assert.equal(report.state, "production-invalid");
  assert.equal(report.ok, false);
  assert.match(report.problem, /traefik-dynamic\.yaml must be a nonempty regular file/u);

  const doctor = invoke(env, "doctor", "production");
  assert.equal(doctor.status, 1);
  assert.match(doctor.stderr, /production artifacts are not ready/u);
});

test("setup status keeps incomplete production setup on its resumable path", (t) => {
  const { env } = fixture(t);
  fs.mkdirSync(path.dirname(env.REVIVAL_ENV_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(env.REVIVAL_ENV_FILE, "REVIVAL_PUBLIC_DOMAIN=pin.example.test\n", { mode: 0o600 });

  let status = invoke(env, "setup", "status", "--json");
  assert.equal(status.status, 1);
  let report = JSON.parse(status.stdout);
  assert.equal(report.mode, "production");
  assert.equal(report.state, "production-invalid");
  assert.equal(report.ok, false);
  assert.equal(report.next, "./revival onboard production");

  fs.unlinkSync(env.REVIVAL_ENV_FILE);
  const production = path.join(env.REVIVAL_CONFIG_DIR, "production");
  fs.mkdirSync(production, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(production, "realm.json"), "{}\n", { mode: 0o444 });

  status = invoke(env, "setup", "status", "--json");
  assert.equal(status.status, 1);
  report = JSON.parse(status.stdout);
  assert.equal(report.mode, "production");
  assert.equal(report.next, "./revival onboard production");
});

test("unsupported setup commands fail without creating operator state", (t) => {
  const { env } = fixture(t);
  const result = invoke(env, "setup", "import");
  assert.equal(result.status, 64);
  assert.match(result.stderr, /usage: \.\/revival setup local\|contributor\|pin/u);
  assert.equal(fs.existsSync(env.REVIVAL_CONFIG_DIR), false);
});
