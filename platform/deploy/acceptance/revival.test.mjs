import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(root, "revival");

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
    REVIVAL_BACKUP_DIR: path.join(temporary, "backups"),
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
    assert.ok(runtime.REVIVAL_ADMIN_TOKEN.length >= 32);
    assert.equal(Buffer.from(runtime.REVIVAL_OPAQUE_SEED, "base64").length, 32);
    assert.equal(client.secret, runtime.KEYCLOAK_CLIENT_SECRET);
    assert.equal(client.publicClient, false);
    assert.equal(client.implicitFlowEnabled, false);
    assert.equal(client.serviceAccountsEnabled, false);
    assert.equal(client.attributes["pkce.code.challenge.method"], "S256");
    assert.equal(client.redirectUris.some((uri) => uri.includes("*")), false);
    assert.deepEqual(realm.users, []);
    assert.ok(realm.roles.realm.some((role) => role.name === "carry-operator"));
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
      REVIVAL_BACKUP_DIR: path.join(temporary, "new-backups"),
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
      REVIVAL_BACKUP_DIR: path.join(temporary, "backups"),
      REVIVAL_ENV_FILE: path.join(temporary, "runtime.env"),
    };
    const outside = invoke(outsideEnv, "init");
    assert.notEqual(outside.status, 0);
    assert.match(outside.stderr, /REVIVAL_ENV_FILE must be inside REVIVAL_SECRETS_DIR/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("generated output is external and source checks leave no local residue", () => {
  // The CLI is an entry point over platform/cli modules; the redirection
  // mechanisms live in the modules, so the scan reads all of them.
  const source = [cli, ...fs.readdirSync(path.join(root, "platform", "cli"))
    .filter((name) => name.endsWith(".js")).sort()
    .map((name) => path.join(root, "platform", "cli", name))]
    .map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.match(source, /CARGO_TARGET_DIR:\s*path\.join\(BUILD_DIR, 'cosmos-target'\)/);
  assert.match(source, /GRADLE_USER_HOME:\s*path\.join\(BUILD_DIR, 'gradle-home'\)/);
  assert.match(source, /NPM_CONFIG_CACHE:\s*path\.join\(BUILD_DIR, 'npm-cache'\)/);
  // Fast checks keep disposable workspaces, content-addressed cache entries,
  // atomic publication staging, and concurrency leases under the external
  // build root. None of those names may fall back into the source checkout.
  assert.match(source, /fast-check-workspaces/u);
  assert.match(source, /fast-check-cache/u);
  assert.match(source, /\.publish-/u);
  assert.match(source, /fast-check-leases/u);
  assert.doesNotMatch(source, /generatedCleanupGuard/u);
  const pinBuilder = fs.readFileSync(
    path.join(root, "platform", "containers", "pin-builder", "entrypoint.sh"),
    "utf8",
  );
  assert.match(pinBuilder, /--project-cache-dir "\$\{REVIVAL_HELD_GRADLE_CONTRACTS:\?missing held contracts Gradle cache\}"/u);
  assert.match(pinBuilder, /--project-cache-dir "\$\{REVIVAL_HELD_GRADLE_INJECTOR:\?missing held injector Gradle cache\}"/u);
  // Every other redirection above is pinned by the mechanism that performs it;
  // Python's was pinned only by the __pycache__ symptom scan below, which is an
  // accident of ordering — it catches residue only when some earlier test in
  // the same run already imported an in-tree module, and this file happens to
  // sort late. Pin the cause as well. Without it the gate spawns interpreters
  // that write bytecode beside the source they import, and the NEXT run dies in
  // layout.sh reporting a repo-layout violation for output this run created:
  // a failure that blames the wrong layer, which is the shape this suite exists
  // to prevent.
  assert.match(source, /PYTHONDONTWRITEBYTECODE:\s*'1'/);
  for (const generated of ["node_modules", ".next", ".gradle", "target", "__pycache__"]) {
    const scan = spawnSync("find", [root, "-type", "d", "-name", generated, "-print"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(scan.status, 0, scan.stderr);
    assert.equal(scan.stdout.trim(), "", `${generated} must stay outside the source tree`);
  }
});

test("Cosmos convenience targets delegate to the root Revival CLI", () => {
  const makefile = fs.readFileSync(path.join(root, "cosmos", "Makefile"), "utf8");
  assert.match(makefile, /render:\n\tcd \.\. && \.\/revival doctor/);
  assert.match(
    makefile,
    /render-production:[\s\S]*\.\/revival deploy production --candidate-id "\$\(CANDIDATE_ID\)" --dry-run/,
  );
  assert.doesNotMatch(makefile, /cd \.\.\/\.\. && \.\/revival/);
});

test("Pin commands expose host-only build/publish and read-only planning without device mutation", () => {
  const { temporary, env } = isolatedOperator();
  try {
    const releaseHelp = invoke(env, "pin", "release", "--help");
    assert.equal(releaseHelp.status, 0, releaseHelp.stderr);
    assert.match(releaseHelp.stdout, /Pin release host contract \(read-only\)/);
    assert.match(releaseHelp.stdout, /inspect/);
    assert.match(releaseHelp.stdout, /verify/);
    assert.match(releaseHelp.stdout, /plan/);

    const buildHelp = invoke(env, "pin", "release", "build", "--help");
    assert.equal(buildHelp.status, 0, buildHelp.stderr);
    assert.match(buildHelp.stdout, /--version YYYY-MM-DD\.N --version-code INTEGER/);
    assert.match(buildHelp.stdout, /never runs ADB or mutates a device/);

    for (const operation of ["install", "flash", "reset", "provision"]) {
      const rejected = invoke(env, "pin", "release", operation);
      assert.equal(rejected.status, 64, `${operation}: ${rejected.stderr}`);
      assert.match(rejected.stderr, /build\|inspect\|verify\|plan/);
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

test("canonical and compatibility values cannot disagree", () => {
  const { temporary, env } = isolatedOperator();
  try {
    const initialized = invoke(env, "init");
    assert.equal(initialized.status, 0, initialized.stderr);
    const runtimeFile = path.join(env.REVIVAL_SECRETS_DIR, "runtime.env");
    let contents = fs.readFileSync(runtimeFile, "utf8");
    contents = setValue(contents, "COSMOS_ADMIN_TOKEN", "incompatible-admin-token-value-00000000");
    fs.writeFileSync(runtimeFile, contents, { mode: 0o600 });
    const result = invoke(env, "doctor");
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /REVIVAL_ADMIN_TOKEN and compatibility alias COSMOS_ADMIN_TOKEN must not disagree/,
    );
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
    contents = setValue(contents, "REVIVAL_ENROLLMENT_PINCODE", "1234");
    contents = setValue(contents, "REVIVAL_ENROLLMENT_USER_ID", "local-wearer");
    contents = setValue(contents, "REVIVAL_OPAQUE_SEED", "not-32-private-bytes");
    fs.writeFileSync(runtimeFile, contents, { mode: 0o600 });
    const result = invoke(env, "doctor");
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /REVIVAL_OPAQUE_SEED must decode from canonical base64 to exactly 32 private bytes/,
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

test("Spotify adapter configuration is all-or-none and device identity is bounded", () => {
  const { temporary, env } = isolatedOperator();
  try {
    const initialized = invoke(env, "init");
    assert.equal(initialized.status, 0, initialized.stderr);
    const runtimeFile = path.join(env.REVIVAL_SECRETS_DIR, "runtime.env");
    let contents = fs.readFileSync(runtimeFile, "utf8");
    contents = setValue(contents, "REVIVAL_SPOTIFY_ADAPTER_URL", "http://10.0.7.1:18081");
    fs.writeFileSync(runtimeFile, contents, { mode: 0o600 });

    const partial = invoke(env, "doctor");
    assert.notEqual(partial.status, 0);
    assert.match(
      `${partial.stdout}\n${partial.stderr}`,
      /REVIVAL_SPOTIFY_ADAPTER_URL, REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE, REVIVAL_PIN_BRIDGE_OWNER_SUB, and REVIVAL_PIN_BRIDGE_DEVICE_ID must be configured together/,
    );

    contents = setValue(contents, "REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE", "/run/secrets/spotify_adapter_token");
    contents = setValue(contents, "REVIVAL_PIN_BRIDGE_OWNER_SUB", "owner-subject");
    contents = setValue(contents, "REVIVAL_PIN_BRIDGE_DEVICE_ID", "x".repeat(257));
    fs.writeFileSync(runtimeFile, contents, { mode: 0o600 });

    const oversized = invoke(env, "doctor");
    assert.notEqual(oversized.status, 0);
    assert.match(
      `${oversized.stdout}\n${oversized.stderr}`,
      /REVIVAL_PIN_BRIDGE_DEVICE_ID must be a nonblank device identifier no longer than 256 UTF-8 bytes/,
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
        COSMOS_KID_SCOPE: "audit",
        COSMOS_DATABASE_URL: "postgresql://carry:placeholder@postgres/carry",
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
        COSMOS_KEYCLOAK_DB_PASSWORD: "placeholder-keycloak-db",
        COSMOS_PG_PASSWORD: "placeholder-postgres",
        GRAFANA_ADMIN_PASSWORD: "placeholder-grafana",
        SEARXNG_SECRET: "placeholder-search-secret",
        COSMOS_OPENROUTER_API_KEY: "placeholder-openrouter-key",
        COSMOS_INTERSTITIAL_BASE_URL: "http://cosmos-ollama:11434/v1",
        COSMOS_INTERSTITIAL_MODEL: "qwen2.5:3b-instruct",
        REVIVAL_PIN_BRIDGE_OWNER_SUB: "owner-compose-contract-test",
        REVIVAL_PIN_BRIDGE_DEVICE_ID: "device-compose-contract-test",
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
  assert.deepEqual(Object.keys(rendered.networks).sort(), [
    "cosmos-internal",
    "local-model",
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
    "spotify-control",
  ]);
  assert.deepEqual(Object.keys(rendered.services.keycloak.networks).sort(), [
    "cosmos-internal",
    "loopback-publish",
  ]);
  assert.deepEqual(
    Object.entries(rendered.services)
      .filter(([, service]) => service.networks?.["provider-egress"])
      .map(([name]) => name),
    ["ai-bus"],
  );
  assert.deepEqual(
    Object.entries(rendered.services)
      .filter(([, service]) => service.networks?.["local-model"])
      .map(([name]) => name),
    ["ai-bus"],
  );
  assert.equal(rendered.networks["local-model"].external, true);
  assert.equal(rendered.networks["local-model"].name, "humane-carry-clone_carry-local");
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
  assert.equal(rendered.services.center.environment.REVIVAL_PIN_BRIDGE_DEVICE_ID, "device-compose-contract-test");
  assert.equal(rendered.services.keycloak.profiles, undefined);
  assert.deepEqual(
    Object.fromEntries(Object.entries(rendered.volumes).map(([name, volume]) => [name, {
      external: volume.external,
      name: volume.name,
    }])),
    {
      "cosmos-pgdata": { external: true, name: "humane-carry-clone_carry-pgdata" },
      "cosmos-state": { external: true, name: "humane-carry-clone_carry-state" },
      "grafana-data": { external: true, name: "humane-carry-clone_grafana-data" },
      "prometheus-data": { external: true, name: "humane-carry-clone_prometheus-data" },
    },
  );
  const centerData = rendered.services.center.volumes.filter((volume) => volume.target === "/data");
  assert.deepEqual(centerData, [{
    type: "bind",
    source: "/home/anders/carry-center-data",
    target: "/data",
    bind: { create_host_path: false },
  }]);
  assert.ok(
    Object.values(rendered.services)
      .flatMap((service) => service.ports ?? [])
      .every((port) => port.host_ip === "127.0.0.1"),
  );
});

test("legacy carry-net guard applies only before the first canonical release", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ai-pin-revival-network-policy-"));
  try {
    const remoteRootPath = path.join(temporary, "ai-pin-revival");
    fs.mkdirSync(path.join(remoteRootPath, "releases"), { recursive: true });
    const remoteRoot = fs.realpathSync(remoteRootPath);
    const releases = path.join(remoteRoot, "releases");
    const release = path.join(releases, "a".repeat(64));
    const current = path.join(remoteRoot, "current");
    fs.mkdirSync(release, { recursive: true });
    const environment = {
      ...process.env,
      REVIVAL_REMOTE_ROOT: remoteRoot,
      REVIVAL_RELEASES_DIR: releases,
    };
    const common = path.join(root, "platform", "deploy", "vps", "remote", "common.sh");
    const command = `source "$1"; legacy_rollback_network_required "$2"`;

    const firstCutover = spawnSync("bash", ["-c", command, "policy-test", common, current], {
      cwd: root,
      encoding: "utf8",
      env: environment,
    });
    assert.equal(firstCutover.status, 0, firstCutover.stderr);

    fs.symlinkSync(release, current);
    const canonicalCurrent = spawnSync("bash", ["-c", command, "policy-test", common, current], {
      cwd: root,
      encoding: "utf8",
      env: environment,
    });
    assert.equal(canonicalCurrent.status, 1, canonicalCurrent.stderr);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
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
  };
  const render = (profileArguments, environment) => {
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
      { cwd: root, encoding: "utf8", env: environment },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  const disabled = render([], {
    ...baseEnvironment,
    REVIVAL_IDENTITY_ENABLED: "false",
    REVIVAL_LOCAL_OIDC_ISSUER: "",
    REVIVAL_LOCAL_OIDC_JWKS_URI: "",
    KEYCLOAK_BASE_URL: "",
  });
  assert.equal(Object.keys(disabled.services).length, 8);
  assert.equal(disabled.services.keycloak, undefined);
  assert.equal(disabled.services.center.environment.KEYCLOAK_BASE_URL, "");
  assert.equal(
    disabled.services.center.image,
    "ai-pin-revival/center-development:identity-contract-test",
  );

  const issuer = "http://localhost:8088/realms/humane";
  const jwks = "http://keycloak:8080/realms/humane/protocol/openid-connect/certs";
  const enabled = render(["--profile", "identity"], {
    ...baseEnvironment,
    REVIVAL_IDENTITY_ENABLED: "true",
    REVIVAL_LOCAL_OIDC_ISSUER: issuer,
    REVIVAL_LOCAL_OIDC_JWKS_URI: jwks,
    KEYCLOAK_BASE_URL: "http://keycloak:8080",
  });
  assert.equal(Object.keys(enabled.services).length, 9);
  assert.deepEqual(enabled.services.keycloak.profiles, ["identity"]);
  assert.equal(enabled.services.keycloak.ports[0].host_ip, "127.0.0.1");
  assert.equal(enabled.services.center.environment.KEYCLOAK_BASE_URL, "http://keycloak:8080");

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
