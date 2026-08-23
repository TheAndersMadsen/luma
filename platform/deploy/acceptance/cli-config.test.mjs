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

test("config inventory prints metadata only and templates omit secret settings", () => {
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

test("the root config contract represents every required production Compose input", () => {
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
    assert.equal(invoke(env, ["init"]).status, 0);
    for (const [name, value, secret] of [
      ["COSMOS_CAPTURE_UPLOAD_BASE_URL", "https://uploads.example.test", false],
      ["COSMOS_ENROLLMENT_PINCODE", "0000", true],
      ["COSMOS_ENROLLMENT_USER_ID", "U:production-config-test", false],
      ["REVIVAL_PIN_BRIDGE_OWNER_SUB", "owner-production-config-test", false],
      ["REVIVAL_PIN_BRIDGE_DEVICE_ID", "device-production-config-test", false],
    ]) {
      const result = secret
        ? invoke(env, ["config", "set", name, "--stdin"], value)
        : invoke(env, ["config", "set", name, value]);
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    }

    const doctor = invoke(env, ["doctor", "production"]);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.match(doctor.stdout, /Compose configuration is valid/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
