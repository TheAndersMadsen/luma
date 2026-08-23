import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const deploy = readFileSync(path.join(root, "platform/deploy/vps/remote/deploy.sh"), "utf8");
const production = readFileSync(path.join(root, "platform/compose/production.yaml"), "utf8");
const cosmosServer = readFileSync(path.join(root, "cosmos/crates/cosmos/src/lib.rs"), "utf8");
const operations = readFileSync(path.join(root, "docs/operations.md"), "utf8");

function effectiveCompose(files) {
  const env = { ...process.env, REVIVAL_RELEASE_ID: "a".repeat(64) };
  for (const file of files) {
    const source = readFileSync(path.join(root, file), "utf8");
    for (const match of source.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):\?[^}]*\}/gu)) {
      env[match[1]] = match[1].endsWith("_DIR") ? "/tmp/ai-pin-revival-compose-probe" : "compose-probe";
    }
  }
  const rendered = spawnSync(
    "docker",
    ["compose", ...files.flatMap((file) => ["-f", file]), "config", "--format", "json"],
    { cwd: root, encoding: "utf8", env, maxBuffer: 32 * 1024 * 1024 },
  );
  assert.equal(rendered.status, 0, rendered.stderr);
  return JSON.parse(rendered.stdout);
}

function serviceBlock(source, name) {
  const start = source.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `Compose must declare ${name}`);
  const tail = source.slice(start + `\n  ${name}:\n`.length);
  const next = tail.search(/\n  [A-Za-z0-9_-]+:\n/u);
  return tail.slice(0, next === -1 ? tail.length : next);
}

test("production pins the documented single-writer state topology", () => {
  const center = serviceBlock(production, "center");
  assert.doesNotMatch(center, /^\s+deploy:/mu, "Center must not gain a replica deployment block");
  assert.doesNotMatch(center, /\breplicas\s*:/u, "Center must remain a single process");

  assert.match(deploy, /^exec 9>"\$LOCK_FILE"$/mu);
  assert.match(deploy, /^flock -n 9 \|\| fail "another deployment or backup holds the lock"$/mu);
  const stopCurrent = deploy.lastIndexOf('stop_project_containers "$PROJECT"');
  const stopLegacy = deploy.lastIndexOf('stop_project_containers "$LEGACY_PROJECT"');
  const candidate = deploy.lastIndexOf('"${COMPOSE[@]}" up -d --pull never --no-build --remove-orphans');
  assert.ok(stopCurrent >= 0 && stopLegacy > stopCurrent && candidate > stopLegacy,
    "both old projects must stop before the one candidate starts");

  assert.match(operations, /exactly one Center process and exactly\s+one process for each Cosmos workload identity/u);
  assert.match(operations, /PID-qualified\s+temporary files/u);
  assert.match(operations, /not a\s+multi-process consistency protocol/u);
  assert.match(operations, /Do not scale or replicate either writer/u);
});

test("durable channel-key dependencies are explicit before any serving listener", () => {
  for (const workload of ["ai-bus", "contacts", "notable-events"]) {
    assert.match(
      serviceBlock(production, workload),
      /COSMOS_DATABASE_URL: \$\{COSMOS_DATABASE_URL:\?set COSMOS_DATABASE_URL/u,
      `${workload} must require the protected PostgreSQL authority`,
    );
  }
  const model = effectiveCompose(["compose.yaml", "platform/compose/production.yaml"]);
  const stateGrants = Object.entries(model.services)
    .flatMap(([service, definition]) => (definition.volumes ?? [])
      .filter((volume) => volume.type === "volume" && volume.source === "cosmos-state")
      .map((volume) => [service, volume.target]));
  assert.deepEqual(stateGrants.sort(), [
    ["account", "/var/lib/carry"],
    ["ai-bus", "/var/lib/carry"],
    ["connectivity", "/var/lib/carry"],
    ["contacts", "/var/lib/carry"],
    ["feature-flags", "/var/lib/carry"],
    ["notable-events", "/var/lib/carry"],
    ["provisioning", "/var/lib/carry"],
  ]);

  const validation = cosmosServer.indexOf("validate_durable_key_configuration(&config)?;");
  const directory = cosmosServer.indexOf("KeyDirectory::configured_from(config.database_url.as_deref())");
  const bind = cosmosServer.indexOf("TcpListener::bind(config.grpc_bind)");
  assert.ok(validation >= 0 && directory > validation && bind > directory,
    "configuration, connection, and reconciliation must all precede listener bind");
  assert.equal(
    cosmosServer.match(/KeyDirectory::configured_from\(config\.database_url\.as_deref\(\)\)/gu)?.length,
    1,
    "one workload process must construct exactly one authoritative directory handle",
  );
  assert.doesNotMatch(cosmosServer, /KeyDirectory::configured\(\)\.await/u);

  assert.match(operations, /PostgreSQL is the sole channel-key authority in parity and production/u);
  assert.match(operations, /refuse startup before binding a\s+listener/u);
  assert.match(operations, /Development and test may use the explicit\s+memory-only shape/u);
});

test("the effective production model exposes only used resources and the four legacy storage ABIs", () => {
  const model = effectiveCompose(["compose.yaml", "platform/compose/production.yaml"]);
  assert.deepEqual(Object.keys(model.volumes ?? {}).sort(), [
    "cosmos-pgdata",
    "cosmos-state",
    "grafana-data",
    "prometheus-data",
  ]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(model.volumes).map(([name, volume]) => [name, volume.name])),
    {
      "cosmos-pgdata": "humane-carry-clone_carry-pgdata",
      "cosmos-state": "humane-carry-clone_carry-state",
      "grafana-data": "humane-carry-clone_grafana-data",
      "prometheus-data": "humane-carry-clone_prometheus-data",
    },
  );
  assert.ok(Object.values(model.volumes).every((volume) => volume.external === true));
  assert.deepEqual(Object.keys(model.networks ?? {}).sort(), [
    "cosmos-internal",
    "local-model",
    "loopback-publish",
    "provider-egress",
    "search-egress",
    "search-service",
    "spotify-control",
  ]);
  assert.equal(model.networks["local-model"].name, "humane-carry-clone_carry-local");
  assert.equal(model.networks["local-model"].external, true);

  for (const service of ["ai-bus", "contacts", "notable-events"]) {
    assert.equal(model.services[service].environment.COSMOS_DEFER_KEY_DIRECTORY_BOUNDS, "1");
  }

  const base = effectiveCompose(["compose.yaml"]);
  const development = effectiveCompose(["compose.yaml", "platform/compose/development.yaml"]);
  assert.deepEqual(Object.keys(base.volumes ?? {}).sort(), ["center-data", "cosmos-state"]);
  assert.deepEqual(Object.keys(base.networks ?? {}).sort(), ["cosmos-internal", "wearer-edge"]);
  assert.deepEqual(Object.keys(development.volumes ?? {}).sort(), [
    "center-data",
    "center-development-next",
    "cosmos-state",
  ]);
  assert.deepEqual(Object.keys(development.networks ?? {}).sort(), ["cosmos-internal", "wearer-edge"]);
});
