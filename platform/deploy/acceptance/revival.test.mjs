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
  conventionalAndroidSdk,
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
    environment.DOCKER_CONFIG,
  ]) {
    assert.equal(path.isAbsolute(directory), true);
    assert.equal(directory.startsWith(`${root}${path.sep}`), false);
  }
  assert.equal(cosmos.CARGO_TARGET_DIR, path.join(BUILD_DIR, "cosmos-target"));
  assert.equal(environment.ANDROID_HOME, "/opt/android-sdk");
  assert.equal(environment.ANDROID_SDK_ROOT, "/opt/android-sdk");
});

test("the conventional Android SDK is discovered without a source-local properties file", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-android-home-"));
  try {
    const macSdk = path.join(temporary, "Library", "Android", "sdk");
    fs.mkdirSync(macSdk, { recursive: true });
    assert.equal(conventionalAndroidSdk("darwin", temporary), macSdk);

    fs.rmSync(macSdk, { recursive: true });
    const linuxSdk = path.join(temporary, "Android", "Sdk");
    fs.mkdirSync(linuxSdk, { recursive: true });
    assert.equal(conventionalAndroidSdk("linux", temporary), linuxSdk);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
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

test("Pin release exposes one exact acquisition path without a ship mode", () => {
  const { temporary, env } = isolatedOperator();
  try {
    const releaseHelp = invoke(env, "pin", "release", "--help");
    assert.equal(releaseHelp.status, 0, releaseHelp.stderr);
    assert.match(releaseHelp.stdout, /Acquire publishes only this operator release.*exact signed archive/);
    assert.match(releaseHelp.stdout, /acquire/);
    assert.match(releaseHelp.stdout, /build/);
    assert.match(releaseHelp.stdout, /export/);
    assert.doesNotMatch(releaseHelp.stdout, /\bimport\b/);
    assert.doesNotMatch(releaseHelp.stdout, /ship/);
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
      assert.match(rejected.stderr, /release build/);
    }

    const help = invoke(env, "--help");
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Pin host operations \(no device mutation\)/);
    assert.match(help.stdout, /pin release acquire/);
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

test("Docker build frontends are digest-bound release inputs", () => {
  const expected =
    "# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e";
  for (const relative of [
    "cosmos/Dockerfile",
    "platform/containers/keycloak/Dockerfile",
    "platform/containers/pin-builder/Dockerfile",
  ]) {
    const firstLine = fs.readFileSync(path.join(root, relative), "utf8").split(/\r?\n/, 1)[0];
    assert.equal(firstLine, expected, `${relative} must bind the Dockerfile frontend by digest`);
  }
});

test("Cosmos bundles the pinned official Codex app server for both release architectures", () => {
  const dockerfile = fs.readFileSync(path.join(root, "cosmos/Dockerfile"), "utf8");
  assert.match(dockerfile, /@openai\/codex@0\.149\.1/);
  assert.match(dockerfile, /amd64\) package=codex-linux-x64; target=x86_64-unknown-linux-musl/);
  assert.match(dockerfile, /arm64\) package=codex-linux-arm64; target=aarch64-unknown-linux-musl/);
  assert.match(dockerfile, /COPY --from=codex --chown=65532:65532 \/opt\/codex \/opt\/codex/);
  const runtime = dockerfile.split(/ AS runtime\s/u, 2)[1];
  assert.doesNotMatch(runtime, /npm install|FROM node:/u);
});

test("production Compose is an image-only portable appliance with opt-in services", (context) => {
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
  const environment = {
    ...process.env,
    REVIVAL_RELEASE_ID: releaseId,
    REVIVAL_PUBLIC_DOMAIN: "pin.example.test",
    REVIVAL_PUBLIC_ORIGIN: "https://pin.example.test",
    REVIVAL_MUSIC_GATEWAY_ORIGIN: "https://pin.example.test",
    COSMOS_OIDC_ISSUER: "https://pin.example.test/realms/humane",
    COSMOS_DATABASE_URL: "postgresql://cosmos:placeholder@postgres/cosmos",
    COSMOS_PG_PASSWORD: "placeholder-postgres",
    COSMOS_EDGE_TOKEN: "placeholder-edge",
    COSMOS_ADMIN_TOKEN: "placeholder-admin",
    COSMOS_CENTER_PROJECTION_TOKEN: "placeholder-projection",
    COSMOS_RTC_PUBLIC_URL: "wss://pin.example.test/livekit",
    COSMOS_RTC_API_KEY: "placeholder-rtc-key",
    COSMOS_RTC_API_SECRET: "placeholder-rtc-secret",
    COSMOS_CAPTURE_UPLOAD_BASE_URL: "https://pin.example.test",
    COSMOS_CAPTURE_SHARE_BASE_URL: "https://pin.example.test",
    COSMOS_ONBOARDING_ENDPOINT: "https://onboarding.cosmos.humane.cloud",
    AUTH_SESSION_SECRET: "placeholder-session",
    COSMOS_SHARE_TOKEN_SECRET: "placeholder-share",
    KEYCLOAK_CLIENT_SECRET: "placeholder-keycloak",
    KEYCLOAK_ADMIN: "bootstrap-admin",
    KEYCLOAK_ADMIN_PASSWORD: "placeholder-keycloak-admin-password",
    GRAFANA_ADMIN_PASSWORD: "placeholder-grafana",
    SEARXNG_SECRET: "placeholder-search-secret",
    COSMOS_ENROLLMENT_PINCODE: "0000",
    COSMOS_ENROLLMENT_USER_ID: "operator-id",
    COSMOS_OPAQUE_SEED: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    COSMOS_AZURE_SPEECH_KEY: "placeholder-cosmos-speech-key",
    COSMOS_AZURE_SPEECH_REGION: "southeastasia",
    COSMOS_AZURE_SPEECH_VOICE: "da-DK-ChristelNeural",
    COSMOS_OPENROUTER_API_KEY: "placeholder-openrouter-key",
  };
  const render = (profiles = []) => {
    const profileArgs = profiles.flatMap((profile) => ["--profile", profile]);
    const result = spawnSync(
      "docker",
      [
        "compose",
        "-f",
        "compose.yaml",
        "-f",
        "platform/compose/production.yaml",
        ...profileArgs,
        "config",
        "--format",
        "json",
      ],
      { cwd: root, encoding: "utf8", env: environment },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  const core = render();
  assert.deepEqual(Object.keys(core.services).sort(), [
    "account",
    "ai-bus",
    "center",
    "contacts",
    "feature-flags",
    "keycloak",
    "livekit",
    "notable-events",
    "postgres",
    "traefik",
  ]);
  for (const [name, service] of Object.entries(core.services)) {
    assert.equal(service.build, undefined, name + " must run an image, never a source build");
    assert.ok(service.image, name + " must define an image");
  }
  assert.equal(
    core.services.center.image,
    "ghcr.io/theandersmadsen/ai-pin-revival/center:" + releaseId,
  );
  assert.equal(
    core.services["ai-bus"].image,
    "ghcr.io/theandersmadsen/ai-pin-revival/cosmos:" + releaseId,
  );
  assert.deepEqual(core.services.keycloak.command, ["start", "--optimized", "--import-realm"]);
  assert.equal(
    core.services.keycloak.image,
    "ghcr.io/theandersmadsen/ai-pin-revival/keycloak:" + releaseId,
  );
  assert.equal(
    core.services.keycloak.environment.KC_DB_URL,
    "jdbc:postgresql://postgres:5432/keycloak",
  );

  const published = Object.entries(core.services)
    .filter(([, service]) => service.ports?.length)
    .map(([name]) => name);
  assert.deepEqual(published, ["livekit", "traefik"]);
  assert.deepEqual(core.services.livekit.ports.map((port) => `${port.published}/${port.protocol}`).sort(),
    ["3478/udp", "7881/tcp", "7882/udp"]);
  assert.equal(core.services.livekit.user, "65532:65532");
  assert.equal(core.services["ai-bus"].depends_on.livekit.condition, "service_healthy");
  assert.equal(core.services["ai-bus"].environment.COSMOS_RTC_URL, "ws://livekit:7880");
  assert.equal(core.services["ai-bus"].environment.COSMOS_RTC_PUBLIC_URL, environment.COSMOS_RTC_PUBLIC_URL);
  assert.equal(core.services.center.environment.COSMOS_RTC_API_SECRET, undefined);
  assert.deepEqual(
    core.services.traefik.ports.map((port) => Number(port.published)).sort((left, right) => left - right),
    [80, 443],
  );
  assert.equal(
    core.services.traefik.volumes.some((mount) => mount.source === "/var/run/docker.sock"),
    false,
  );
  assert.deepEqual(core.services.traefik.command, ["--configFile=/etc/traefik/traefik.yml"]);
  assert.equal(core.services.center.environment.REVIVAL_ENVIRONMENT, "production");

  const aiBus = core.services["ai-bus"].environment;
  assert.equal(aiBus.COSMOS_OPENROUTER_API_KEY, "placeholder-openrouter-key");
  assert.equal(aiBus.COSMOS_AZURE_SPEECH_KEY, "placeholder-cosmos-speech-key");
  assert.equal(aiBus.COSMOS_AZURE_SPEECH_REGION, "southeastasia");
  assert.equal(aiBus.COSMOS_AZURE_SPEECH_VOICE, "da-DK-ChristelNeural");

  const full = render(["pin", "search", "spotify", "observability"]);
  assert.deepEqual(
    ["connectivity", "edge", "provisioning", "searxng", "spotify-adapter", "prometheus", "grafana"]
      .filter((name) => !full.services[name]),
    [],
  );
  for (const [name, service] of Object.entries(full.services)) {
    assert.equal(service.build, undefined, name + " must remain image-only under profiles");
    assert.equal(service.labels["dk.andersmadsen.ai-pin-revival.release"], releaseId, name);
    assert.equal(service.labels["org.opencontainers.image.revision"], releaseId, name);
    assert.equal(service.labels["dk.andersmadsen.ai-pin-revival.environment"], "production", name);
  }
  assert.equal(full.services.edge.networks["cosmos-internal"] !== undefined, true);
  assert.equal(full.services.searxng.ports, undefined);
  assert.deepEqual(Object.keys(full.services["spotify-adapter"].networks), ["pin-control"]);
  assert.equal(full.services.center.environment.REVIVAL_SPOTIFY_ADAPTER_URL, undefined);
  assert.equal(full.services.grafana.ports[0].host_ip, "127.0.0.1");
  assert.equal(full.services.grafana.networks["loopback-publish"] !== undefined, true);
  assert.equal(full.networks["loopback-publish"].driver_opts["com.docker.network.bridge.enable_ip_masquerade"], "false");
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
    COSMOS_RTC_API_KEY: "placeholder-rtc-key",
    COSMOS_RTC_API_SECRET: "placeholder-rtc-secret",
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
  assert.equal(Object.keys(disabled.services).length, 9);
  assert.equal(disabled.services.keycloak, undefined);
  assert.equal(disabled.services.center.environment.KEYCLOAK_BASE_URL, "");
  assert.equal(disabled.services.center.environment.KEYCLOAK_REALM, "humane");
  assert.equal(disabled.services.center.environment.REVIVAL_ENVIRONMENT, "development");
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
  assert.equal(Object.keys(enabled.services).length, 10);
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
