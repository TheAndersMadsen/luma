import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(root, "revival");
const require = createRequire(import.meta.url);
const {
  BUILD_DIR,
  cosmosTestEnvironment,
  operatorEnvironment,
  testProcessEnvironment,
} = require("../../cli/context.js");
const { normalizedNpmInstallEnvironment } = require("../../cli/checks.js");

function isolatedOperator() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ai-pin-revival-config-"));
  const env = {
    ...process.env,
    REVIVAL_CONFIG_DIR: path.join(temporary, "config"),
    REVIVAL_SECRETS_DIR: path.join(temporary, "secrets"),
    REVIVAL_ENV_FILE: path.join(temporary, "secrets", "runtime.env"),
    REVIVAL_PRIVATE_DIR: path.join(temporary, "secrets"),
    REVIVAL_DATA_DIR: path.join(temporary, "data"),
    REVIVAL_BUILD_DIR: path.join(temporary, "data", "build"),
  };
  return { temporary, env };
}

function invoke(env, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

function parseEnv(contents) {
  return Object.fromEntries(
    contents
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function setValue(contents, key, value) {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  assert.match(contents, pattern, `missing ${key} fixture`);
  return contents.replace(pattern, `${key}=${value}`);
}

test("init creates a protected, wearer-free local identity realm tied to runtime", () => {
  const { temporary, env } = isolatedOperator();
  try {
    const result = invoke(env, "init");
    assert.equal(result.status, 0, result.stderr);

    const runtimeFile = path.join(env.REVIVAL_SECRETS_DIR, "runtime.env");
    const realmFile = path.join(env.REVIVAL_SECRETS_DIR, "identity", "realm.json");
    const runtime = parseEnv(fs.readFileSync(runtimeFile, "utf8"));
    const realm = JSON.parse(fs.readFileSync(realmFile, "utf8"));
    const client = realm.clients.find((candidate) => candidate.clientId === runtime.KEYCLOAK_CLIENT_ID);

    assert.equal(runtime.REVIVAL_RELEASE_ID, "local");
    assert.ok(runtime.KEYCLOAK_CLIENT_SECRET.length >= 32);
    assert.ok(runtime.KEYCLOAK_ADMIN.length >= 8);
    assert.ok(runtime.KEYCLOAK_ADMIN_PASSWORD.length >= 32);
    assert.ok(runtime.COSMOS_ADMIN_TOKEN.length >= 32);
    assert.match(runtime.SEARXNG_SECRET, /^[0-9a-f]{64}$/);
    assert.equal(Buffer.from(runtime.COSMOS_OPAQUE_SEED, "base64").length, 32);
    assert.equal(client.secret, runtime.KEYCLOAK_CLIENT_SECRET);
    assert.equal(client.publicClient, false);
    assert.equal(client.implicitFlowEnabled, false);
    assert.equal(client.serviceAccountsEnabled, false);
    assert.equal(client.attributes["pkce.code.challenge.method"], "S256");
    assert.equal(client.redirectUris.some((uri) => uri.includes("*")), false);
    assert.deepEqual(realm.users, []);
    assert.ok(realm.roles.realm.some((role) => role.name === "cosmos-operator"));
    assert.equal(fs.statSync(runtimeFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(realmFile).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("init refuses unmanaged existing roots and runtime files outside secrets", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ai-pin-revival-paths-"));
  try {
    const unmanaged = path.join(temporary, "unmanaged");
    fs.mkdirSync(unmanaged, { mode: 0o700 });
    const before = fs.statSync(unmanaged).mode & 0o777;
    const unmanagedEnv = {
      ...process.env,
      REVIVAL_CONFIG_DIR: unmanaged,
      REVIVAL_SECRETS_DIR: path.join(unmanaged, "secrets"),
      REVIVAL_ENV_FILE: path.join(unmanaged, "secrets", "runtime.env"),
      REVIVAL_PRIVATE_DIR: path.join(unmanaged, "secrets"),
      REVIVAL_DATA_DIR: path.join(temporary, "new-data"),
      REVIVAL_BUILD_DIR: path.join(temporary, "new-data", "build"),
    };
    const rejected = invoke(unmanagedEnv, "init");
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /not marked for Ai Pin Revival/);
    assert.equal(fs.statSync(unmanaged).mode & 0o777, before);

    const outsideEnv = {
      ...process.env,
      REVIVAL_CONFIG_DIR: path.join(temporary, "config"),
      REVIVAL_SECRETS_DIR: path.join(temporary, "secrets"),
      REVIVAL_PRIVATE_DIR: path.join(temporary, "secrets"),
      REVIVAL_DATA_DIR: path.join(temporary, "data"),
      REVIVAL_BUILD_DIR: path.join(temporary, "data", "build"),
      REVIVAL_ENV_FILE: path.join(temporary, "runtime.env"),
    };
    const outside = invoke(outsideEnv, "init");
    assert.notEqual(outside.status, 0);
    assert.match(outside.stderr, /REVIVAL_ENV_FILE must be inside REVIVAL_SECRETS_DIR/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("test environments configure compiler and package cache paths outside the repository", () => {
  const environment = testProcessEnvironment({
    ...process.env,
    ANDROID_HOME: "/opt/android-sdk",
    ANDROID_SDK_ROOT: "/opt/android-sdk",
  });
  const cosmos = cosmosTestEnvironment(environment);
  const npm = normalizedNpmInstallEnvironment(environment);
  for (const directory of [
    cosmos.CARGO_TARGET_DIR,
    environment.CARGO_HOME,
    environment.GRADLE_USER_HOME,
    npm.NPM_CONFIG_CACHE,
  ]) {
    assert.equal(path.isAbsolute(directory), true);
    assert.equal(directory.startsWith(`${root}${path.sep}`), false);
  }
  assert.equal(cosmos.CARGO_TARGET_DIR, path.join(BUILD_DIR, "cosmos-target"));
  assert.equal(environment.ANDROID_HOME, "/opt/android-sdk");
  assert.equal(environment.ANDROID_SDK_ROOT, "/opt/android-sdk");
});

test("Cosmos convenience targets delegate to the root Revival CLI", () => {
  const makefile = fs.readFileSync(path.join(root, "cosmos", "Makefile"), "utf8");
  assert.match(makefile, /render:\n\tcd \.\. && \.\/revival doctor/);
  assert.match(
    makefile,
    /render-production:[\s\S]*\.\/revival deploy production --dry-run/,
  );
  assert.doesNotMatch(makefile, /cd \.\.\/\.\. && \.\/revival/);
});

test("Pin release exposes only build and plan-by-default shipping", () => {
  const { temporary, env } = isolatedOperator();
  try {
    const releaseHelp = invoke(env, "pin", "release", "--help");
    assert.equal(releaseHelp.status, 0, releaseHelp.stderr);
    assert.match(releaseHelp.stdout, /Build writes the local release store/);
    assert.match(releaseHelp.stdout, /build/);
    assert.match(releaseHelp.stdout, /ship/);
    assert.doesNotMatch(releaseHelp.stdout, /\n  (?:inspect|verify|plan)\s/);

    const literalReleaseHelp = invoke(env, "pin", "release", "help");
    assert.equal(literalReleaseHelp.status, 0, literalReleaseHelp.stderr);
    assert.equal(literalReleaseHelp.stdout, releaseHelp.stdout);

    const buildHelp = invoke(env, "pin", "release", "build", "--help");
    assert.equal(buildHelp.status, 0, buildHelp.stderr);
    assert.match(buildHelp.stdout, /--version YYYY-MM-DD\.N --version-code INTEGER/);
    assert.match(buildHelp.stdout, /never runs ADB or mutates a device/);

    for (const operation of ["install", "flash", "reset", "provision"]) {
      const rejected = invoke(env, "pin", "release", operation);
      assert.equal(rejected.status, 64, `${operation}: ${rejected.stderr}`);
      assert.match(rejected.stderr, /build\|ship/);
    }

    const help = invoke(env, "--help");
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Pin host operations \(no device mutation\)/);
    assert.match(help.stdout, /pin release build --version/);
    assert.doesNotMatch(help.stdout, /pin (?:install|flash|reset|provision)/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("root CLI wires PKI, activation, and credential-free network tools", () => {
  const { temporary, env } = isolatedOperator();
  try {
    const initialized = invoke(env, "init");
    assert.equal(initialized.status, 0, initialized.stderr);

    const pki = invoke(env, "pki", "status", "--json");
    assert.equal(pki.status, 0, pki.stderr);
    assert.equal(JSON.parse(pki.stdout).valid, false);

    const activation = invoke(env, "pin", "activate");
    assert.equal(activation.status, 64);
    assert.match(activation.stderr, /--serial SERIAL/);

    const network = invoke(env, "pin", "network", "qr");
    assert.equal(network.status, 0, network.stderr);
    assert.match(network.stdout, /browser builds the QR locally/i);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("init writes only canonical Cosmos deployment settings", () => {
  const { temporary, env } = isolatedOperator();
  try {
    const initialized = invoke(env, "init");
    assert.equal(initialized.status, 0, initialized.stderr);
    const runtimeFile = path.join(env.REVIVAL_SECRETS_DIR, "runtime.env");
    const contents = fs.readFileSync(runtimeFile, "utf8");
    assert.match(contents, /^COSMOS_ADMIN_TOKEN=.+$/m);
    assert.match(contents, /^COSMOS_OPAQUE_SEED=.+$/m);
    assert.doesNotMatch(contents, /^(?:REVIVAL_(?:AUTH_MODE|EDGE_TOKEN|SHARE_TOKEN_SECRET|CENTER_PROJECTION_TOKEN|ADMIN_TOKEN|OPAQUE_SEED|REMOTE_TTS_ENABLED|ENROLLMENT_PINCODE|ENROLLMENT_USER_ID|DUC_CA_CERT|DUC_CA_KEY|OPERATOR_EMAILS)|AZURE_SPEECH_(?:KEY|REGION|VOICE))=/m);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("enrollment refuses a malformed or non-private OPAQUE seed", () => {
  const { temporary, env } = isolatedOperator();
  try {
    const initialized = invoke(env, "init");
    assert.equal(initialized.status, 0, initialized.stderr);
    const runtimeFile = path.join(env.REVIVAL_SECRETS_DIR, "runtime.env");
    let contents = fs.readFileSync(runtimeFile, "utf8");
    contents = setValue(contents, "COSMOS_ENROLLMENT_PINCODE", "1234");
    contents = setValue(contents, "COSMOS_ENROLLMENT_USER_ID", "local-wearer");
    contents = setValue(contents, "COSMOS_OPAQUE_SEED", "not-32-private-bytes");
    fs.writeFileSync(runtimeFile, contents, { mode: 0o600 });
    const result = invoke(env, "doctor");
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /COSMOS_OPAQUE_SEED must decode from canonical base64 to exactly 32 private bytes/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("every Compose volume-deletion flag form is blocked before runtime access", () => {
  const { temporary, env } = isolatedOperator();
  try {
    for (const argument of ["-v", "-v=true", "-tv", "--volumes", "--volumes=true"]) {
      const result = invoke(env, "down", argument);
      assert.equal(result.status, 64, `${argument}: ${result.stderr}`);
      assert.match(result.stderr, /volume deletion is intentionally unavailable/);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Spotify pairing is all-or-none and uses the Cosmos device-id grammar", () => {
  const { temporary, env } = isolatedOperator();
  try {
    const initialized = invoke(env, "init");
    assert.equal(initialized.status, 0, initialized.stderr);
    const runtimeFile = path.join(env.REVIVAL_SECRETS_DIR, "runtime.env");
    let contents = fs.readFileSync(runtimeFile, "utf8");
    contents = setValue(contents, "REVIVAL_PIN_BRIDGE_OWNER_SUB", '"   "');
    contents = setValue(contents, "REVIVAL_PIN_BRIDGE_DEVICE_ID", "2c2a00010000abcd");
    fs.writeFileSync(runtimeFile, contents, { mode: 0o600 });

    const partial = invoke(env, "doctor", "--json");
    assert.notEqual(partial.status, 0);
    assert.match(
      `${partial.stdout}\n${partial.stderr}`,
      /REVIVAL_PIN_BRIDGE_OWNER_SUB and REVIVAL_PIN_BRIDGE_DEVICE_ID must be configured together/,
    );

    contents = setValue(contents, "REVIVAL_PIN_BRIDGE_OWNER_SUB", '" owner-subject "');
    contents = setValue(contents, "REVIVAL_PIN_BRIDGE_DEVICE_ID", "2C2A00010000ABCD");
    fs.writeFileSync(runtimeFile, contents, { mode: 0o600 });
    const boundary = JSON.parse(invoke(env, "doctor", "--json").stdout);
    assert.equal(boundary.checks.find((check) => check.id === "configuration")?.status, "PASS");
    assert.equal(boundary.checks.find((check) => check.id === "spotify")?.status, "PASS");

    contents = setValue(contents, "REVIVAL_PIN_BRIDGE_DEVICE_ID", "device-1");
    fs.writeFileSync(runtimeFile, contents, { mode: 0o600 });
    const malformed = invoke(env, "doctor", "--json");
    assert.notEqual(malformed.status, 0);
    assert.match(
      `${malformed.stdout}\n${malformed.stderr}`,
      /REVIVAL_PIN_BRIDGE_DEVICE_ID must be the detected Pin device id in hexadecimal/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Docker build frontends are digest-bound release inputs", () => {
  const expected =
    "# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e";
  for (const relative of [
    "cosmos/Dockerfile",
    "platform/containers/pin-builder/Dockerfile",
  ]) {
    const firstLine = fs.readFileSync(path.join(root, relative), "utf8").split(/\r?\n/, 1)[0];
    assert.equal(firstLine, expected, `${relative} must bind the Dockerfile frontend by digest`);
  }
});

test("production Compose binds one release identity and keeps web services private", (context) => {
  const composeVersion = spawnSync("docker", ["compose", "version"], {
    cwd: root,
    encoding: "utf8",
  });
  if (composeVersion.error?.code === "ENOENT") {
    context.skip("Docker Compose is unavailable");
    return;
  }
  assert.equal(composeVersion.status, 0, composeVersion.stderr);

  const releaseId = "compose-contract-test";
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
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        REVIVAL_RELEASE_ID: releaseId,
        COSMOS_KID_SCOPE: "enforce",
        COSMOS_DATABASE_URL: "postgresql://cosmos:placeholder@postgres/cosmos",
        COSMOS_EDGE_TOKEN: "placeholder-edge",
        COSMOS_ADMIN_TOKEN: "placeholder-admin",
        COSMOS_CENTER_PROJECTION_TOKEN: "placeholder-projection",
        COSMOS_CAPTURE_UPLOAD_BASE_URL: "https://uploads.example.test",
        COSMOS_ONBOARDING_ENDPOINT: "https://onboarding.example.test",
        COSMOS_ENROLLMENT_PINCODE: "0000",
        COSMOS_ENROLLMENT_USER_ID: "U:compose-contract-test",
        COSMOS_OPAQUE_SEED: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        AUTH_SESSION_SECRET: "placeholder-session",
        COSMOS_SHARE_TOKEN_SECRET: "placeholder-share",
        KEYCLOAK_CLIENT_SECRET: "placeholder-keycloak",
        COSMOS_PG_PASSWORD: "placeholder-postgres",
        GRAFANA_ADMIN_PASSWORD: "placeholder-grafana",
        SEARXNG_SECRET: "placeholder-search-secret",
        COSMOS_AZURE_SPEECH_KEY: "placeholder-cosmos-speech-key",
        COSMOS_AZURE_SPEECH_REGION: "southeastasia",
        COSMOS_AZURE_SPEECH_VOICE: "da-DK-ChristelNeural",
        AZURE_SPEECH_KEY: "ignored-generic-speech-key",
        AZURE_SPEECH_REGION: "ignored-region",
        AZURE_SPEECH_VOICE: "ignored-voice",
        COSMOS_OPENROUTER_API_KEY: "placeholder-openrouter-key",
        COSMOS_INTERSTITIAL_BASE_URL: "http://cosmos-ollama:11434/v1",
        COSMOS_INTERSTITIAL_MODEL: "qwen2.5:3b-instruct",
        REVIVAL_PIN_BRIDGE_OWNER_SUB: "owner-compose-contract-test",
        REVIVAL_PIN_BRIDGE_DEVICE_ID: "2c2a00010000abcd",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);

  const rendered = JSON.parse(result.stdout);
  assert.equal(Object.keys(rendered.services).length, 15);
  assert.deepEqual(rendered.services.center.build.args, { REVIVAL_RELEASE_ID: releaseId });
  for (const [serviceName, service] of Object.entries(rendered.services)) {
    if (!service.build || serviceName === "center") continue;
    assert.deepEqual(service.build.args ?? {}, {}, `${serviceName} has an untracked build argument`);
  }
  for (const [serviceName, service] of Object.entries(rendered.services)) {
    if (!service.build) continue;
    const labels = service.build.labels;
    assert.equal(labels["dk.andersmadsen.ai-pin-revival.release"], releaseId);
    assert.equal(labels["org.opencontainers.image.revision"], releaseId);
    assert.equal(labels["dk.andersmadsen.ai-pin-revival.environment"], undefined);
    assert.equal(service.labels["dk.andersmadsen.ai-pin-revival.environment"], "production", serviceName);
  }
  assert.equal(rendered.services.center.build.args.REVIVAL_RELEASE_ID, releaseId);
  assert.equal(rendered.services.center.environment.REVIVAL_RELEASE_ID, releaseId);
  assert.equal(rendered.services.center.image, `ai-pin-revival/center:${releaseId}`);
  assert.equal(rendered.services["ai-bus"].image, `ai-pin-revival/cosmos:${releaseId}`);
  assert.equal(
    rendered.services.keycloak.environment.KC_DB_URL,
    "jdbc:postgresql://postgres:5432/keycloak",
  );
  assert.equal(
    rendered.services.connectivity.environment.COSMOS_OIDC_JWKS_URI,
    "http://keycloak:8080/realms/humane/protocol/openid-connect/certs",
  );
  assert.deepEqual(rendered.services.connectivity.depends_on.keycloak, {
    condition: "service_healthy",
    required: true,
  });
  assert.deepEqual(Object.keys(rendered.networks).sort(), [
    "cosmos-internal",
    "loopback-publish",
    "provider-egress",
    "search-egress",
    "search-service",
    "spotify-control",
  ]);
  // Docker silently drops host port publication for a container attached only
  // to internal networks, so every loopback-published service needs exactly one
  // non-internal attachment. `loopback-publish` disables IP masquerade, so it
  // grants publication without granting internet egress.
  assert.notEqual(rendered.networks["loopback-publish"].internal, true);
  assert.equal(
    rendered.networks["loopback-publish"].driver_opts[
      "com.docker.network.bridge.enable_ip_masquerade"
    ],
    "false",
  );
  assert.deepEqual(
    Object.entries(rendered.services)
      .filter(([, service]) => service.ports?.length)
      .map(([name]) => name)
      .sort(),
    ["ai-bus", "center", "connectivity", "edge", "grafana", "keycloak"],
  );
  for (const [name, service] of Object.entries(rendered.services)) {
    if (!service.ports?.length) continue;
    const attachments = Object.keys(service.networks ?? {});
    assert.ok(
      attachments.includes("loopback-publish") || attachments.includes("provider-egress"),
      `${name} publishes a port but has no non-internal network attachment`,
    );
  }
  assert.deepEqual(Object.keys(rendered.services.center.networks).sort(), [
    "cosmos-internal",
    "loopback-publish",
    "provider-egress",
    "spotify-control",
  ]);
  assert.deepEqual(Object.keys(rendered.services.keycloak.networks).sort(), [
    "cosmos-internal",
    "loopback-publish",
  ]);
  assert.deepEqual(
    Object.entries(rendered.services)
      .filter(([, service]) => service.networks?.["provider-egress"])
      .map(([name]) => name)
      .sort(),
    ["ai-bus", "center"],
  );
  assert.deepEqual(
    Object.entries(rendered.services)
      .filter(([, service]) => service.networks?.["search-service"])
      .map(([name]) => name)
      .sort(),
    ["ai-bus", "searxng"],
  );
  assert.deepEqual(
    Object.entries(rendered.services)
      .filter(([, service]) => service.networks?.["search-egress"])
      .map(([name]) => name),
    ["searxng"],
  );
  const providerKey = /^(?:AZURE_|COSMOS_AZURE_|COSMOS_LLM_|COSMOS_OPENROUTER_API_KEY$|COSMOS_INTERSTITIAL_|COSMOS_SERPAPI_KEY$|COSMOS_GOOGLE_MAPS_KEY$|COSMOS_PIRATE_WEATHER_KEY$|COSMOS_WOLFRAM_APP_ID$|COSMOS_PPLX_)/;
  assert.deepEqual(
    Object.entries(rendered.services)
      .filter(([, service]) => Object.keys(service.environment ?? {}).some((key) => providerKey.test(key)))
      .map(([name]) => name),
    ["ai-bus"],
  );
  assert.deepEqual(
    Object.entries(rendered.services)
      .filter(([, service]) => Object.hasOwn(service.environment ?? {}, "COSMOS_SEARXNG_BASE_URL"))
      .map(([name]) => name),
    ["ai-bus"],
  );
  assert.equal(rendered.services["ai-bus"].environment.COSMOS_SEARXNG_BASE_URL, "http://searxng:8080");
  assert.equal(
    rendered.services["ai-bus"].environment.COSMOS_OPENROUTER_API_KEY,
    "placeholder-openrouter-key",
  );
  assert.equal(
    rendered.services["ai-bus"].environment.COSMOS_INTERSTITIAL_BASE_URL,
    "http://cosmos-ollama:11434/v1",
  );
  assert.equal(
    rendered.services["ai-bus"].environment.COSMOS_INTERSTITIAL_MODEL,
    "qwen2.5:3b-instruct",
  );
  assert.equal(
    rendered.services["ai-bus"].environment.COSMOS_AZURE_SPEECH_KEY,
    "placeholder-cosmos-speech-key",
  );
  assert.equal(rendered.services["ai-bus"].environment.COSMOS_AZURE_SPEECH_REGION, "southeastasia");
  assert.equal(
    rendered.services["ai-bus"].environment.COSMOS_AZURE_SPEECH_VOICE,
    "da-DK-ChristelNeural",
  );
  for (const name of ["AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION", "AZURE_SPEECH_VOICE"]) {
    assert.equal(Object.hasOwn(rendered.services["ai-bus"].environment, name), false);
  }
  assert.deepEqual(rendered.services["ai-bus"].depends_on.searxng, {
    condition: "service_healthy",
    required: true,
  });

  const search = rendered.services.searxng;
  assert.equal(
    search.image,
    "searxng/searxng@sha256:f4c8e59de166ed71f6380c0847c312ca51f0d41996e31d0559163b6b09ecde52",
  );
  assert.equal(search.user, "977:977");
  assert.equal(search.read_only, true);
  assert.deepEqual(search.cap_drop, ["ALL"]);
  assert.deepEqual(search.security_opt, ["no-new-privileges:true"]);
  assert.equal(search.pids_limit, 128);
  assert.equal(search.mem_limit, "536870912");
  assert.equal(search.ports, undefined);
  assert.deepEqual(Object.keys(search.environment).sort(), ["FORCE_OWNERSHIP", "SEARXNG_SECRET"]);
  assert.equal(search.environment.SEARXNG_SECRET, "placeholder-search-secret");
  assert.deepEqual(
    Object.entries(rendered.services)
      .filter(([, service]) => Object.hasOwn(service.environment ?? {}, "SEARXNG_SECRET"))
      .map(([name]) => name),
    ["searxng"],
  );
  assert.equal(search.volumes.length, 1);
  assert.equal(search.volumes[0].target, "/etc/searxng/settings.yml");
  assert.equal(search.volumes[0].read_only, true);
  assert.match(search.volumes[0].source, /cosmos\/search\/settings\.yml$/);
  assert.deepEqual(search.healthcheck.test, [
    "CMD",
    "wget",
    "--quiet",
    "--tries=1",
    "--spider",
    "http://127.0.0.1:8080/healthz",
  ]);
  assert.deepEqual(rendered.services["spotify-adapter"].healthcheck.test, [
    "CMD",
    "node",
    "src/healthcheck.mjs",
  ]);
  for (const [serviceName, service] of Object.entries(rendered.services)) {
    assert.notEqual(service.privileged, true, `${serviceName} must not be privileged`);
    assert.ok(service.pids_limit > 0, `${serviceName} must have a PID ceiling`);
    assert.ok(Number(service.mem_limit) > 0, `${serviceName} must have a memory ceiling`);
    assert.deepEqual(service.logging, {
      driver: "json-file",
      options: { "max-file": "3", "max-size": "10m" },
    }, `${serviceName} must have bounded local logs`);
    if (!service.build) {
      assert.match(service.image, /@sha256:[0-9a-f]{64}$/, `${serviceName} must use a pinned image`);
    }
  }
  assert.equal(rendered.services.center.environment.REVIVAL_PIN_BRIDGE_OWNER_SUB, "owner-compose-contract-test");
  assert.equal(rendered.services.center.environment.REVIVAL_PIN_BRIDGE_DEVICE_ID, "2c2a00010000abcd");
  assert.equal(rendered.services.keycloak.profiles, undefined);
  assert.deepEqual(
    Object.fromEntries(Object.entries(rendered.volumes).map(([name, volume]) => [name, {
      name: volume.name,
    }])),
    {
      "center-data": { name: "ai-pin-revival_center-data" },
      "cosmos-pgdata": { name: "ai-pin-revival_cosmos-pgdata" },
      "cosmos-state": { name: "ai-pin-revival_cosmos-state" },
      "grafana-data": { name: "ai-pin-revival_grafana-data" },
      "prometheus-data": { name: "ai-pin-revival_prometheus-data" },
    },
  );
  const centerData = rendered.services.center.volumes.filter((volume) => volume.target === "/data");
  assert.deepEqual(centerData, [{
    type: "volume",
    source: "center-data",
    target: "/data",
    volume: {},
  }]);
  assert.ok(
    Object.values(rendered.services)
      .flatMap((service) => service.ports ?? [])
      .every((port) => port.host_ip === "127.0.0.1"),
  );
});

test("development identity profile controls Keycloak and OIDC wiring", (context) => {
  const composeVersion = spawnSync("docker", ["compose", "version"], {
    cwd: root,
    encoding: "utf8",
  });
  if (composeVersion.error?.code === "ENOENT") {
    context.skip("Docker Compose is unavailable");
    return;
  }
  assert.equal(composeVersion.status, 0, composeVersion.stderr);

  const baseEnvironment = {
    ...process.env,
    REVIVAL_RELEASE_ID: "identity-contract-test",
    REVIVAL_DATA_DIR: path.join(os.tmpdir(), "ai-pin-revival-identity-data"),
    REVIVAL_SECRETS_DIR: path.join(os.tmpdir(), "ai-pin-revival-identity-secrets"),
    REVIVAL_DEPLOYMENT_ENVIRONMENT: "development",
    COSMOS_AZURE_SPEECH_KEY: "development-cosmos-speech-key",
    COSMOS_AZURE_SPEECH_REGION: "northeurope",
    COSMOS_AZURE_SPEECH_VOICE: "en-GB-SoniaNeural",
    AZURE_SPEECH_KEY: "ignored-development-generic-key",
    AZURE_SPEECH_REGION: "ignored-development-region",
    AZURE_SPEECH_VOICE: "ignored-development-voice",
  };
  const render = (profileArguments, values) => {
    const result = spawnSync(
      "docker",
      [
        "compose",
        "-f",
        "compose.yaml",
        "-f",
        "platform/compose/development.yaml",
        ...profileArguments,
        "config",
        "--format",
        "json",
      ],
      { cwd: root, encoding: "utf8", env: operatorEnvironment(values) },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  const disabled = render([], {
    ...baseEnvironment,
    REVIVAL_IDENTITY_ENABLED: "false",
    KEYCLOAK_BASE_URL: "https://ignored.invalid",
    KEYCLOAK_REALM: "ignored",
  });
  assert.equal(Object.keys(disabled.services).length, 8);
  assert.equal(disabled.services.keycloak, undefined);
  assert.equal(disabled.services.center.environment.KEYCLOAK_BASE_URL, "");
  assert.equal(disabled.services.center.environment.KEYCLOAK_REALM, "humane");
  assert.equal(
    disabled.services.center.image,
    "ai-pin-revival/center-development:identity-contract-test",
  );
  assert.equal(
    disabled.services["ai-bus"].environment.COSMOS_AZURE_SPEECH_KEY,
    "development-cosmos-speech-key",
  );
  assert.equal(disabled.services["ai-bus"].environment.COSMOS_AZURE_SPEECH_REGION, "northeurope");
  assert.equal(
    disabled.services["ai-bus"].environment.COSMOS_AZURE_SPEECH_VOICE,
    "en-GB-SoniaNeural",
  );
  for (const name of ["AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION", "AZURE_SPEECH_VOICE"]) {
    assert.equal(Object.hasOwn(disabled.services["ai-bus"].environment, name), false);
  }

  const issuer = "http://localhost:8088/realms/humane";
  const jwks = "http://keycloak:8080/realms/humane/protocol/openid-connect/certs";
  const enabled = render(["--profile", "identity"], {
    ...baseEnvironment,
    REVIVAL_IDENTITY_ENABLED: "true",
    KEYCLOAK_BASE_URL: "https://ignored.invalid",
    KEYCLOAK_REALM: "ignored",
  });
  assert.equal(Object.keys(enabled.services).length, 9);
  assert.deepEqual(enabled.services.keycloak.profiles, ["identity"]);
  assert.equal(enabled.services.keycloak.ports[0].host_ip, "127.0.0.1");
  assert.equal(enabled.services.center.environment.KEYCLOAK_BASE_URL, "http://keycloak:8080");
  assert.equal(enabled.services.center.environment.KEYCLOAK_REALM, "humane");

  const oidcWorkloads = [
    "connectivity",
    "ai-bus",
    "account",
    "contacts",
    "feature-flags",
    "notable-events",
    "provisioning",
  ];
  for (const workload of oidcWorkloads) {
    assert.equal(enabled.services[workload].environment.COSMOS_OIDC_ISSUER, issuer, workload);
    assert.equal(enabled.services[workload].environment.COSMOS_OIDC_JWKS_URI, jwks, workload);
  }
  for (const workload of [...oidcWorkloads, "center"]) {
    assert.deepEqual(enabled.services[workload].depends_on.keycloak, {
      condition: "service_healthy",
      required: false,
    });
  }
});
