import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(root, "revival");

function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-config-"));
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

function invoke(env, args, input) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env, input, encoding: "utf8" });
}

function setValue(contents, name, value) {
  return contents.replace(new RegExp(`^${name}=.*$`, "m"), `${name}=${value}`);
}

function validateProduction(env, envFile = env.REVIVAL_ENV_FILE) {
  return spawnSync(
    process.execPath,
    [
      "-e",
      "require('./platform/cli/context').validateRuntime({ production: true, envFile: process.argv[1] })",
      envFile,
    ],
    { cwd: root, env, encoding: "utf8" },
  );
}

test("config uses the contract, redacts secrets, and writes atomically at 0600", () => {
  const { temporary, env } = fixture();
  try {
    assert.equal(invoke(env, ["init"]).status, 0);
    const rejected = invoke(env, ["config", "set", "AUTH_SESSION_SECRET", "argv-secret"]);
    assert.equal(rejected.status, 64);
    assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}`, /argv-secret/);

    const changed = invoke(env, ["config", "set", "AUTH_SESSION_SECRET", "--stdin"], "stdin-secret-value");
    assert.equal(changed.status, 0, changed.stderr);
    assert.doesNotMatch(changed.stdout, /stdin-secret-value/);
    const secret = invoke(env, ["config", "get", "AUTH_SESSION_SECRET", "--json"]);
    assert.deepEqual(JSON.parse(secret.stdout), {
      name: "AUTH_SESSION_SECRET",
      sensitivity: "secret",
      state: "set",
    });

    const port = invoke(env, ["config", "set", "REVIVAL_CENTER_PORT", "4321"]);
    assert.equal(port.status, 0, port.stderr);
    assert.equal(fs.statSync(env.REVIVAL_ENV_FILE).mode & 0o777, 0o600);
    assert.match(invoke(env, ["config", "get", "REVIVAL_CENTER_PORT"]).stdout, /4321/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("config list prints metadata only and templates omit secret settings", () => {
  const { temporary, env } = fixture();
  try {
    const list = invoke(env, ["config", "list", "--json"]);
    assert.equal(list.status, 0, list.stderr);
    const settings = JSON.parse(list.stdout).settings;
    assert.ok(settings.some((setting) => setting.name === "COSMOS_AZURE_SPEECH_KEY"));
    assert.ok(settings.every((setting) => !Object.hasOwn(setting, "value")));
    const byName = new Map(settings.map((setting) => [setting.name, setting]));
    for (const name of ["COSMOS_CAPTURE_UPLOAD_BASE_URL", "COSMOS_ONBOARDING_ENDPOINT"]) {
      assert.equal(byName.get(name)?.sensitivity, "operational");
    }
    for (const name of ["COSMOS_DATABASE_URL", "COSMOS_PG_PASSWORD", "GRAFANA_ADMIN_PASSWORD"]) {
      assert.equal(byName.get(name)?.sensitivity, "secret");
    }

    const template = invoke(env, ["config", "template", "--group", "provider"]);
    assert.equal(template.status, 0, template.stderr);
    assert.match(template.stdout, /COSMOS_AZURE_SPEECH_REGION=/);
    assert.doesNotMatch(template.stdout, /^COSMOS_AZURE_SPEECH_KEY=/m);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("the root config contract represents Compose inputs in runtime.env", () => {
  const compose = ["compose.yaml", "platform/compose/production.yaml"]
    .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
    .join("\n");
  const required = [...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?[^}]+\}/g)]
    .map((match) => match[1]);
  const example = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  const exampleNames = new Set(
    [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]),
  );
  const contract = JSON.parse(
    fs.readFileSync(path.join(root, "contracts/operator-setup.json"), "utf8"),
  );
  const contractNames = new Set(contract.settings.map((setting) => setting.name));

  assert.deepEqual([...new Set(required.filter((name) => !exampleNames.has(name)))], []);
  assert.deepEqual([...new Set(required.filter((name) => !contractNames.has(name)))], []);
  assert.deepEqual(
    contract.settings
      .filter((setting) => !exampleNames.has(setting.name) || setting.home !== "runtime.env")
      .map((setting) => setting.name),
    [],
  );
});

test("core production validation rejects malformed endpoints, database URLs, and core passwords", () => {
  const { temporary, env } = fixture();
  try {
    const setup = invoke(env, [
      "setup", "production",
      "--domain", "pin.example.test",
      "--acme-email", "acme@example.test",
      "--operator-email", "owner@example.test",
    ]);
    assert.equal(setup.status, 0, setup.stderr);
    let valid = fs.readFileSync(env.REVIVAL_ENV_FILE, "utf8");
    valid = setValue(valid, "COSMOS_CAPTURE_UPLOAD_BASE_URL", "https://uploads.example.test");
    valid = setValue(valid, "COSMOS_ONBOARDING_ENDPOINT", "https://onboarding.example.test/v1/onboard");
    fs.writeFileSync(env.REVIVAL_ENV_FILE, valid);
    assert.equal(validateProduction(env).status, 0);

    const databaseUrl = /^COSMOS_DATABASE_URL=(.*)$/m.exec(valid)[1];

    for (const [name, value, message] of [
      ["COSMOS_CAPTURE_UPLOAD_BASE_URL", "https://uploads.example.test/capture", /public HTTPS origin/],
      ["COSMOS_CAPTURE_UPLOAD_BASE_URL", "http://uploads.example.test", /public HTTPS origin/],
      ["COSMOS_DATABASE_URL", "mysql://cosmos:password@database/cosmos", /PostgreSQL URL/],
      ["COSMOS_DATABASE_URL", "postgresql://cosmos@database/cosmos", /PostgreSQL URL/],
      ["COSMOS_DATABASE_URL", "postgresql://cosmos:short@postgres/cosmos", /PostgreSQL URL/],
      ["COSMOS_DATABASE_URL", `${databaseUrl}?host=evil.example`, /PostgreSQL URL/],
      ["COSMOS_DATABASE_URL", databaseUrl.replace(/\/cosmos$/, "/cosmos//"), /PostgreSQL URL/],
      ["COSMOS_DATABASE_URL", databaseUrl.replace("cosmos:", "other:"), /PostgreSQL URL/],
      ["COSMOS_DATABASE_URL", databaseUrl.replace(/(?<=postgresql:\/\/cosmos:)[^@]+/, "b".repeat(64)), /PostgreSQL URL/],
      ["COSMOS_DATABASE_URL", databaseUrl.replace("@postgres:5432/", "@postgres:6543/"), /PostgreSQL URL/],
      ["COSMOS_DATABASE_URL", `postgresql://cosmos:${"a".repeat(32)}$DB_PASSWORD@db.example.test/cosmos`, /PostgreSQL URL/],
      ["COSMOS_DATABASE_URL", `postgresql://cosmos:${"a".repeat(32)}\\escape@db.example.test/cosmos`, /PostgreSQL URL/],
      ["COSMOS_DATABASE_URL", `${databaseUrl} # compose comment`, /PostgreSQL URL/],
      ["COSMOS_DATABASE_URL", `"${databaseUrl}"`, /PostgreSQL URL/],
      ["COSMOS_PG_PASSWORD", "too-short", /at least 32 characters/],
      ["COSMOS_PG_PASSWORD", `${"a".repeat(32)} # compose comment`, /using only letters/],
      ["COSMOS_PG_PASSWORD", "${A_VERY_LONG_INTERPOLATED_DATABASE_PASSWORD}", /using only letters/],
    ]) {
      fs.writeFileSync(env.REVIVAL_ENV_FILE, setValue(valid, name, value));
      const rejected = invoke(env, ["doctor", "production"]);
      assert.notEqual(rejected.status, 0, `${name} unexpectedly passed`);
      assert.match(rejected.stderr, message);
    }

    for (const acceptedOnboardingEndpoint of [
      "https://onboarding.example.test",
      "https://onboarding.example.test/v1/onboard",
      "https://onboarding.example.test/v1/onboard?source=pin&mode=guided",
    ]) {
      fs.writeFileSync(
        env.REVIVAL_ENV_FILE,
        setValue(valid, "COSMOS_ONBOARDING_ENDPOINT", acceptedOnboardingEndpoint),
      );
      const accepted = validateProduction(env);
      assert.equal(accepted.status, 0, accepted.stderr);
    }

    for (const acceptedDatabaseUrl of [
      databaseUrl.replace("@postgres:5432/", "@postgres/"),
      `postgresql://cosmos:${"%41".repeat(32)}@db.example.test:5432/cosmos`,
    ]) {
      fs.writeFileSync(env.REVIVAL_ENV_FILE, setValue(valid, "COSMOS_DATABASE_URL", acceptedDatabaseUrl));
      const accepted = validateProduction(env);
      assert.equal(accepted.status, 0, accepted.stderr);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("production commands validate the exact env file and reject duplicate env flags", () => {
  const { temporary, env } = fixture();
  try {
    const setup = invoke(env, [
      "setup", "production",
      "--domain", "pin.example.test",
      "--acme-email", "acme@example.test",
      "--operator-email", "owner@example.test",
    ]);
    assert.equal(setup.status, 0, setup.stderr);
    let primary = fs.readFileSync(env.REVIVAL_ENV_FILE, "utf8");
    primary = setValue(primary, "COSMOS_CAPTURE_UPLOAD_BASE_URL", "https://uploads.example.test");
    fs.writeFileSync(env.REVIVAL_ENV_FILE, primary);

    const alternate = path.join(env.REVIVAL_SECRETS_DIR, "alternate.env");
    fs.writeFileSync(
      alternate,
      setValue(primary, "COSMOS_CAPTURE_UPLOAD_BASE_URL", "https://127.0.0.1"),
      { mode: 0o600 },
    );
    const bypass = invoke(env, ["doctor", "production", "--env-file", alternate]);
    assert.notEqual(bypass.status, 0);
    assert.match(bypass.stderr, /COSMOS_CAPTURE_UPLOAD_BASE_URL must be a valid public HTTPS origin/);

    for (const args of [
      ["doctor", "production", "--env-file"],
      ["doctor", "production", "--env-file", env.REVIVAL_ENV_FILE, "--env-file", alternate],
      ["deploy", "production", "--dry-run", "--env-file", env.REVIVAL_ENV_FILE, "--env-file", alternate],
    ]) {
      assert.equal(invoke(env, args).status, 64, args.join(" "));
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("config check delegates conditional TTS and Spotify pairing validation to the runtime contract", () => {
  const { temporary, env } = fixture();
  try {
    assert.equal(invoke(env, ["init"]).status, 0);
    let runtime = fs.readFileSync(env.REVIVAL_ENV_FILE, "utf8");
    runtime = setValue(runtime, "COSMOS_REMOTE_TTS_ENABLED", "true");
    fs.writeFileSync(env.REVIVAL_ENV_FILE, runtime);

    const result = invoke(env, ["config", "check", "--json"]);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    const failures = report.checks.filter((check) => check.status === "FAIL");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].id, "runtime-contract");
    assert.match(failures[0].message, /COSMOS_AZURE_SPEECH_KEY/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("config check recognizes production and validates its generated artifacts", () => {
  const { temporary, env } = fixture();
  try {
    const setup = invoke(env, [
      "setup", "production",
      "--domain", "pin.example.test",
      "--acme-email", "acme@example.test",
      "--operator-email", "owner@example.test",
    ]);
    assert.equal(setup.status, 0, setup.stderr);

    const ready = invoke(env, ["config", "check", "--json"]);
    assert.equal(ready.status, 0, ready.stderr);
    const report = JSON.parse(ready.stdout);
    assert.equal(report.ok, true);
    assert.equal(
      report.checks.find((check) => check.id === "production-artifacts")?.status,
      "PASS",
    );
    assert.match(
      report.checks.find((check) => check.id === "runtime-contract")?.message ?? "",
      /production configuration contract/u,
    );

    fs.unlinkSync(path.join(env.REVIVAL_CONFIG_DIR, "production", "traefik.yaml"));
    const incomplete = invoke(env, ["config", "check", "--json"]);
    assert.equal(incomplete.status, 1);
    const failed = JSON.parse(incomplete.stdout);
    assert.equal(
      failed.checks.find((check) => check.id === "production-artifacts")?.status,
      "FAIL",
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("init derives the database URL from a dotenv-decoded safe quoted password", () => {
  const { temporary, env } = fixture();
  try {
    assert.equal(invoke(env, ["init"]).status, 0);
    const password = "manual_database_password_0123456789";
    let runtime = fs.readFileSync(env.REVIVAL_ENV_FILE, "utf8");
    runtime = setValue(runtime, "COSMOS_PG_PASSWORD", `"${password}"`);
    runtime = setValue(runtime, "COSMOS_DATABASE_URL", "");
    fs.writeFileSync(env.REVIVAL_ENV_FILE, runtime);

    const initialized = invoke(env, ["init"]);
    assert.equal(initialized.status, 0, initialized.stderr);
    const updated = fs.readFileSync(env.REVIVAL_ENV_FILE, "utf8");
    assert.match(updated, new RegExp(
      `^COSMOS_DATABASE_URL=postgresql://cosmos:${encodeURIComponent(password)}@postgres:5432/cosmos$`,
      "m",
    ));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("room credentials cannot drift from the mounted server configuration", () => {
  const { temporary, env } = fixture();
  try {
    const setup = invoke(env, ["setup", "production", "--domain", "pin.example.test",
      "--acme-email", "acme@example.test", "--operator-email", "owner@example.test"]);
    assert.equal(setup.status, 0, setup.stderr);
    const changed = invoke(env, ["config", "set", "COSMOS_RTC_API_SECRET", "--stdin"], "rotated-room-secret-0123456789abcdef");
    assert.equal(changed.status, 0, changed.stderr);
    const check = invoke(env, ["config", "check", "--json"]);
    assert.notEqual(check.status, 0);
    assert.match(check.stdout + check.stderr, /LiveKit configuration does not match runtime.env/u);
    assert.doesNotMatch(check.stdout + check.stderr, /rotated-room-secret/u);
    const repaired = invoke(env, ["setup", "production"]);
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.equal(invoke(env, ["config", "check", "--json"]).status, 0);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("a fresh root config can satisfy production Compose through the CLI", (context) => {
  const compose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  if (compose.error?.code === "ENOENT") {
    context.skip("Docker Compose is unavailable");
    return;
  }
  assert.equal(compose.status, 0, compose.stderr);

  const { temporary, env } = fixture();
  try {
    const setup = invoke(env, [
      "setup", "production",
      "--domain", "pin.example.test",
      "--acme-email", "acme@example.test",
      "--operator-email", "owner@example.test",
    ]);
    assert.equal(setup.status, 0, setup.stderr);
    const configured = spawnSync("docker", [
      "compose",
      "--project-directory", root,
      "--env-file", env.REVIVAL_ENV_FILE,
      "-f", path.join(root, "compose.yaml"),
      "-f", path.join(root, "platform/compose/production.yaml"),
      "-f", path.join(env.REVIVAL_CONFIG_DIR, "production", "operator.compose.yaml"),
      "config", "--quiet",
    ], { cwd: root, env, encoding: "utf8" });
    assert.equal(configured.status, 0, configured.stderr);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
