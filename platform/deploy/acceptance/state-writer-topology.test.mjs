import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const deploy = readFileSync(path.join(root, "platform/deploy/vps/remote/deploy.sh"), "utf8");
const compose = readFileSync(path.join(root, "compose.yaml"), "utf8");
const production = readFileSync(path.join(root, "platform/compose/production.yaml"), "utf8");
const cosmosServer = readFileSync(path.join(root, "cosmos/crates/cosmos/src/lib.rs"), "utf8");
const operations = readFileSync(path.join(root, "docs/operations.md"), "utf8");

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
  assert.match(compose, /^  COSMOS_STATE_DIR: \/var\/lib\/cosmos$/mu);
  assert.match(serviceBlock(production, "ai-bus"), /- cosmos-state:\/var\/lib\/cosmos/u);

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
