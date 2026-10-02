import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const preflight = path.join(root, "platform", "deploy", "vps", "preflight.sh");
const deploy = path.join(root, "platform", "deploy", "vps", "deploy.sh");
const verify = path.join(root, "platform", "deploy", "vps", "verify.sh");

function fixture(t, dockerScript) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-production-runtime-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const bin = path.join(temporary, "bin");
  const config = path.join(temporary, "config");
  const production = path.join(config, "production");
  const envFile = path.join(temporary, "runtime.env");
  fs.mkdirSync(bin, { mode: 0o700 });
  fs.mkdirSync(production, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(production, "operator.compose.yaml"), "services: {}\n", { mode: 0o600 });
  fs.writeFileSync(envFile, "LUMA_RELEASE_ID=test-release\n", { mode: 0o600 });
  for (const [name, contents] of [
    ["docker", dockerScript],
    ["ss", "#!/bin/sh\nprintf '%s\\n' 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:((nginx))'\n"],
    ["bun", "#!/bin/sh\nexit 0\n"],
    ["getent", "#!/bin/sh\nprintf '%s\\n' '203.0.113.10 STREAM pin.example.test'\n"],
  ]) {
    fs.writeFileSync(path.join(bin, name), contents, { mode: 0o700 });
  }
  return {
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      LUMA_CONFIG_DIR: config,
      LUMA_ENV_FILE: envFile,
      LUMA_RELEASE_ID: "test-release",
      LUMA_COMPOSE_APPLICATION: `oci://ghcr.io/example/luma/application@sha256:${"a".repeat(64)}`,
      LUMA_PUBLIC_ORIGIN: "https://pin.example.test",
      LUMA_PUBLIC_DOMAIN: "pin.example.test",
      COSMOS_OIDC_ISSUER: "https://pin.example.test/realms/humane",
      COMPOSE_PROFILES: "",
    },
  };
}

test("production preflight explains unresolved public DNS before deployment", (t) => {
  const { env } = fixture(t, `#!/bin/sh
case "$*" in
  *"compose version --short"*) printf '%s\n' 2.34.0; exit 0 ;;
  *"config --quiet"*) exit 0 ;;
esac
exit 0
`);
  fs.writeFileSync(path.join(env.PATH.split(":")[0], "getent"), "#!/bin/sh\nexit 2\n", { mode: 0o700 });
  const result = spawnSync("bash", [preflight], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /public DNS name pin\.example\.test does not resolve/u);
  assert.match(result.stderr, /A or AAAA record/u);
  assert.match(result.stderr, /\.\/luma doctor production/u);
});

test("production preflight hides Compose's resolver noise unless the application cannot be read", (t) => {
  const quiet = fixture(t, `#!/bin/sh
case "$*" in
  *"compose version --short"*) printf '%s\n' 2.34.0; exit 0 ;;
  *"config --quiet"*) echo 'level=info msg="fetch failed after status: 404 Not Found" host=ghcr.io' >&2; exit 0 ;;
  *"ps --status running --services traefik"*) printf '%s\\n' traefik; exit 0 ;;
esac
exit 0
`);
  const passed = spawnSync("bash", [preflight], { cwd: root, env: quiet.env, encoding: "utf8" });
  assert.equal(passed.status, 0, passed.stderr);
  assert.doesNotMatch(passed.stderr, /fetch failed/u);

  const denied = fixture(t, `#!/bin/sh
case "$*" in
  *"compose version --short"*) printf '%s\n' 2.34.0; exit 0 ;;
  *"config --quiet"*) echo 'failed to resolve oci://ghcr.io/example/luma/application: denied' >&2; exit 1 ;;
esac
exit 0
`);
  const failed = spawnSync("bash", [preflight], { cwd: root, env: denied.env, encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /failed to resolve oci:\/\/ghcr\.io/u);
  assert.match(failed.stderr, /\.\/luma registry login --username GITHUB_USER with a classic token that has read:packages/u);
});

test("production verification names the services that are not running", (t) => {
  const { env } = fixture(t, `#!/bin/sh
case "$*" in
  *"compose version --short"*) printf '%s\n' 2.34.0; exit 0 ;;
  *"ps --status running --services traefik"*) printf '%s\n' traefik; exit 0 ;;
  *"config --services"*) printf '%s\n' center keycloak traefik; exit 0 ;;
  *"ps --status running --services"*) printf '%s\n' center traefik; exit 0 ;;
esac
exit 0
`);
  const result = spawnSync("bash", [verify], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /these configured production services are not running:\n  keycloak\n/u);
  assert.match(result.stderr, /\.\/luma deploy production --confirm/u);
  assert.match(result.stderr, /docker compose -p luma logs --tail 100 SERVICE/u);
  assert.doesNotMatch(result.stderr, /^[-+]{3} /mu, "no raw diff");
});

test("production preflight reports occupied public ports without stopping their owner", (t) => {
  const { env } = fixture(t, `#!/bin/sh
case "$*" in
  *"compose version --short"*) printf '%s\n' 2.34.0; exit 0 ;;
  *"config --quiet"*) exit 0 ;;
  *"ps --status running --services traefik"*) exit 0 ;;
esac
exit 0
`);
  const result = spawnSync("bash", [preflight], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ports 80 or 443 are already in use/u);
  assert.match(result.stderr, /Nginx/u);
  assert.match(result.stderr, /will not stop it automatically/u);
});

test("production preflight permits an update when this project's Traefik already owns the ports", (t) => {
  const { env } = fixture(t, `#!/bin/sh
case "$*" in
  *"compose version --short"*) printf '%s\n' 2.34.0; exit 0 ;;
  *"config --quiet"*) exit 0 ;;
  *"ps --status running --services traefik"*) printf '%s\\n' traefik; exit 0 ;;
esac
exit 0
`);
  const result = spawnSync("bash", [preflight], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("production preflight refuses to start an empty stack beside this stack's data", (t) => {
  const { env } = fixture(t, `#!/bin/sh
case "$*" in
  *"compose version --short"*) printf '%s\n' 2.34.0; exit 0 ;;
  *"config --quiet"*) exit 0 ;;
  *"config --volumes"*) printf '%s\n%s\n%s\n' cosmos-state center-data grafana-data; exit 0 ;;
  *"volume ls --format"*) printf '%s\n' old-project_cosmos-state old-project_center-data monitoring_grafana-data; exit 0 ;;
esac
exit 0
`);
  const result = spawnSync("bash", [preflight], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /data volumes exist under another Compose project name/u);
  assert.doesNotMatch(result.stderr, /monitoring/u, "an unrelated stack's grafana-data is not this stack's data");
  for (const key of ["cosmos-state", "center-data"]) {
    assert.ok(result.stderr.includes(
      `docker volume create --label com.docker.compose.project=luma --label com.docker.compose.volume=${key} luma_${key}`,
    ), result.stderr);
    assert.ok(result.stderr.includes(
      `docker run --rm -v old-project_${key}:/from:ro -v luma_${key}:/to alpine cp -a /from/. /to/`,
    ), result.stderr);
  }
  // Docker has no `volume rename`. The advice must be runnable as printed.
  assert.doesNotMatch(result.stderr, /volume rename/u);
  assert.match(result.stderr, /--project-name/u);
});

test("production preflight refuses an extra Traefik network that does not exist or shadows Luma's services", (t) => {
  const { env } = fixture(t, `#!/bin/sh
printf '%s\\n' "$*" >> "$LUMA_TEST_DOCKER_LOG"
case "$*" in
  *"compose version --short"*) printf '%s\\n' 2.34.0; exit 0 ;;
  "network inspect owner-apps --format "*) printf '%s ' c-web c-api; exit 0 ;;
  "network inspect shared-net --format "*) printf '%s ' c-web c-auth; exit 0 ;;
  "network inspect owner-apps"|"network inspect shared-net") exit 0 ;;
  *"network inspect"*) exit 1 ;;
  "inspect c-web --format "*) printf '%s\\n' '/owner-web web 0123456789ab'; exit 0 ;;
  "inspect c-api --format "*) printf '%s\\n' '/owner-api api'; exit 0 ;;
  "inspect c-auth --format "*) printf '%s\\n' '/shared-auth keycloak'; exit 0 ;;
  *"ps --status running --services traefik"*) printf '%s\\n' traefik; exit 0 ;;
esac
exit 0
`);
  const dockerLog = path.join(path.dirname(env.LUMA_CONFIG_DIR), "docker.log");
  const run = (networks) => spawnSync("bash", [preflight], {
    cwd: root,
    env: { ...env, LUMA_TRAEFIK_EXTRA_NETWORKS: networks, LUMA_TEST_DOCKER_LOG: dockerLog },
    encoding: "utf8",
  });
  const missing = run("owner-apps,missing-net");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Docker network missing-net, which does not exist on this host/u);
  assert.match(missing.stderr, /\.\/luma config set LUMA_TRAEFIK_EXTRA_NETWORKS/u);

  const present = run("owner-apps");
  assert.equal(present.status, 0, present.stderr);
  const none = run("");
  assert.equal(none.status, 0, none.stderr);
  const inspected = fs.readFileSync(dockerLog, "utf8").split("\n")
    .filter((line) => line.startsWith("network inspect") && !line.includes("--format"));
  assert.deepEqual(inspected, [
    "network inspect owner-apps", "network inspect missing-net", "network inspect owner-apps",
  ]);

  // Docker's DNS would answer `keycloak` from shared-net, so Traefik would
  // send Luma's sign-in traffic to the other stack's container.
  fs.rmSync(dockerLog);
  const shadowed = run("owner-apps,shared-net");
  assert.equal(shadowed.status, 1);
  assert.match(shadowed.stderr, /Docker network shared-net has a container that answers to keycloak/u);
  assert.match(shadowed.stderr, /remove shared-net from LUMA_TRAEFIK_EXTRA_NETWORKS/u);
  const log = fs.readFileSync(dockerLog, "utf8");
  assert.ok(log.includes('inspect c-auth --format {{.Name}} {{with index .NetworkSettings.Networks "shared-net"}}'), log);
  assert.doesNotMatch(log, /^up /mu, "preflight starts nothing");

  // The guarded names are exactly the upstreams Luma's Traefik routes to.
  const routes = fs.readFileSync(path.join(root, "platform/edge/traefik/dynamic.yaml.tpl"), "utf8");
  const upstreams = [...routes.matchAll(/(?:url: https?:\/\/|address: )([a-z0-9-]+):\d+/gu)].map((match) => match[1]);
  const guarded = /^luma_upstreams=\(([^)]*)\)$/mu.exec(fs.readFileSync(preflight, "utf8"))?.[1].split(" ") ?? [];
  assert.deepEqual([...new Set(upstreams)].sort(), [...guarded].sort());
});

test("production preflight reports only this project's volumes once it owns them", (t) => {
  const { env } = fixture(t, `#!/bin/sh
case "$*" in
  *"compose version --short"*) printf '%s\n' 2.34.0; exit 0 ;;
  *"config --quiet"*) exit 0 ;;
  *"config --volumes"*) printf '%s\n' cosmos-state; exit 0 ;;
  *"volume ls --format"*) printf '%s\n%s\n' luma_cosmos-state old-project_cosmos-state; exit 0 ;;
  *"ps --status running --services traefik"*) printf '%s\\n' traefik; exit 0 ;;
esac
exit 0
`);
  const result = spawnSync("bash", [preflight], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /old-project|note:/u, "another project's volumes are not this deployment's concern");
});

test("production preflight lets a first install share the server with unrelated stacks", (t) => {
  // A monitoring stack's volumes end in the same common names as Luma's, but
  // it holds no Cosmos state or database, so it is not a previous Luma stack.
  const { env } = fixture(t, `#!/bin/sh
case "$*" in
  *"compose version --short"*) printf '%s\n' 2.34.0; exit 0 ;;
  *"config --quiet"*) exit 0 ;;
  *"config --volumes"*) printf '%s\n' cosmos-state cosmos-pgdata prometheus-data grafana-data; exit 0 ;;
  *"volume ls --format"*) printf '%s\n' monitoring_prometheus-data monitoring_grafana-data home.lab_grafana-data; exit 0 ;;
  *"ps --status running --services traefik"*) printf '%s\\n' traefik; exit 0 ;;
esac
exit 0
`);
  const result = spawnSync("bash", [preflight], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /monitoring|home\.lab/u);
});

// Compose's VolumeHash for a volume declared as `{}`: the SHA-256 of Go's JSON
// of the volume with the driver defaulted to "local". Checked against the label
// Compose 5.3 wrote on a real volume.
function composeVolumeHash(name) {
  return createHash("sha256").update(JSON.stringify({ name, driver: "local" })).digest("hex");
}

test("production preflight refuses a release that would make Compose recreate a data volume", (t) => {
  const recorded = {
    "luma_cosmos-pgdata": composeVolumeHash("luma_cosmos-pgdata"),
    "luma_center-data": "0".repeat(64),
  };
  const { env } = fixture(t, `#!/bin/sh
case "$*" in
  *"compose version --short"*) printf '%s\n' 2.34.0; exit 0 ;;
  *"config --quiet"*) exit 0 ;;
  *"config --volumes"*) printf '%s\n' cosmos-pgdata center-data grafana-data; exit 0 ;;
  *"config --format json"*) printf '%s' "$LUMA_TEST_CONFIG"; exit 0 ;;
  *"volume ls --format"*) printf '%s\n' luma_cosmos-pgdata luma_center-data; exit 0 ;;
  "volume inspect luma_cosmos-pgdata --format"*) printf '%s\n' ${recorded["luma_cosmos-pgdata"]}; exit 0 ;;
  "volume inspect luma_center-data --format"*) printf '%s\n' "$LUMA_TEST_CENTER_HASH"; exit 0 ;;
  *"ps --status running --services traefik"*) printf '%s\n' traefik; exit 0 ;;
esac
exit 0
`);
  // The fixture stubs node. This check runs the real one.
  fs.writeFileSync(path.join(env.PATH.split(":")[0], "bun"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o700 });
  const config = JSON.stringify({
    name: "luma",
    services: {},
    volumes: {
      "cosmos-pgdata": { name: "luma_cosmos-pgdata" },
      "center-data": { name: "luma_center-data" },
      "grafana-data": { name: "luma_grafana-data" },
      shared: { name: "owner-shared", external: true },
    },
  });
  const run = (centerHash) => spawnSync("bash", [preflight], {
    cwd: root,
    env: { ...env, LUMA_TEST_CONFIG: config, LUMA_TEST_CENTER_HASH: centerHash },
    encoding: "utf8",
  });

  const diverged = run(recorded["luma_center-data"]);
  assert.equal(diverged.status, 1);
  assert.match(diverged.stderr, /defines these data volumes differently[^\n]*\n {2}luma_center-data\n/u);
  assert.doesNotMatch(diverged.stderr, /luma_cosmos-pgdata|luma_grafana-data/u);
  assert.match(diverged.stderr, /would delete them and create them empty/u);
  assert.match(diverged.stderr, /\.\/luma backup production/u);

  // A matching hash, a volume Compose did not label, and one that does not
  // exist yet all deploy.
  for (const hash of [composeVolumeHash("luma_center-data"), ""]) {
    const unchanged = run(hash);
    assert.equal(unchanged.status, 0, unchanged.stderr);
  }
});

test("production data volumes keep one definition, so no release can make Compose recreate them", () => {
  // Changing a line here changes the hash Compose records on the volume, and
  // preflight would then refuse every existing server. Keep these `{}`.
  const production = fs.readFileSync(path.join(root, "platform/compose/production.yaml"), "utf8");
  assert.equal(/^volumes: !override\n((?: {2}.*\n?)+)/mu.exec(production)?.[1].trimEnd(), [
    "cosmos-state", "cosmos-pgdata", "center-data", "keycloak-data",
    "traefik-acme", "prometheus-data", "grafana-data", "iroh-bridge-data",
  ].map((name) => `  ${name}: {}`).join("\n"));
  const deployment = fs.readFileSync(deploy, "utf8");
  assert.ok(
    fs.readFileSync(preflight, "utf8").includes('driver: volume.driver || "local"'),
    "preflight computes Compose's volume hash",
  );
  assert.ok(deployment.indexOf('"$SCRIPT_DIR/preflight.sh"') < deployment.indexOf('"${up[@]}"'),
    "preflight's volume check runs before `up --yes`");
});

test("production preflight enforces the Compose OCI minimum", (t) => {
  const { env } = fixture(t, `#!/bin/sh
case "$*" in
  *"compose version --short"*) printf '%s\n' 2.33.9; exit 0 ;;
esac
exit 0
`);
  const result = spawnSync("bash", [preflight], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Compose 2\.34\.0 or newer is required; observed 2\.33\.9/u);
});

test("production verification rejects an unhealthy configured container", (t) => {
  const { env } = fixture(t, `#!/bin/sh
case "$*" in
  *"compose version --short"*) printf '%s\n' 2.34.0; exit 0 ;;
  *"config --quiet"*) exit 0 ;;
  *"ps --status running --services traefik"*) printf '%s\\n' traefik; exit 0 ;;
  *"config --services"*|*"ps --status running --services"*) printf '%s\\n' center traefik; exit 0 ;;
  *"ps --quiet"*) printf '%s\\n' container-center; exit 0 ;;
  *"inspect --format {{.State.Status}}"*) printf '%s\\n' running; exit 0 ;;
  *"inspect --format {{if .State.Health}}{{.State.Health.Status}}{{end}}"*) printf '%s\\n' unhealthy; exit 0 ;;
esac
exit 0
`);
  const result = spawnSync("bash", [verify], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /health=unhealthy/u);
  const source = fs.readFileSync(verify, "utf8");
  assert.match(source, /identity\.release !== expectedRelease/u);
  assert.match(source, /identity\.environment !== expectedEnvironment/u);
  assert.match(source, /expected the sign-in redirect/u);
  assert.match(source, /headers: \{ accept: 'text\/markdown' \}/u);
  assert.match(source, /missing\.status !== 404/u);
  assert.doesNotMatch(source, /publicPages/u);
  assert.doesNotMatch(source, /next-router-state-tree/u);
  assert.match(source, /\/openapi\.json/u);
  assert.match(source, /\/llms\.txt/u);
  assert.match(source, /manifest\.releaseId !== expectedPinRelease/u);
  assert.match(source, /createHash\('sha256'\)\.update\(bytes\)\.digest\('hex'\) !== expectedPinManifest/u);
  assert.doesNotMatch(source, /Object\.hasOwn\(identity, 'environment'\)/u);
  assert.match(source, /LUMA_DEVICE_EDGE_IPV4/u);
  assert.match(source, /-connect 127\.0\.0\.1:443 -servername api\.cosmos\.humane\.cloud/u);
  assert.doesNotMatch(source, /-connect "\$edge_ipv4:443"/u);
  assert.match(source, /dk\.andersmadsen\.luma\.release/u);
  assert.match(source, /org\.opencontainers\.image\.revision/u);
});

test("production verification rejects missing runtime release labels", (t) => {
  const { env } = fixture(t, `#!/bin/sh
case "$*" in
  *"compose version --short"*) printf '%s\n' 2.34.0; exit 0 ;;
  *"config --quiet"*) exit 0 ;;
  *"ps --status running --services traefik"*) printf '%s\n' traefik; exit 0 ;;
  *"config --services"*|*"ps --status running --services"*) printf '%s\n' center traefik; exit 0 ;;
  *"ps --quiet"*) printf '%s\n' container-center; exit 0 ;;
  *"inspect --format {{.State.Status}}"*) printf '%s\n' running; exit 0 ;;
  *"inspect --format {{if .State.Health}}{{.State.Health.Status}}{{end}}"*) printf '%s\n' healthy; exit 0 ;;
  *"inspect --format {{index .Config.Labels"*) printf '\n'; exit 0 ;;
esac
exit 0
`);
  const result = spawnSync("bash", [verify], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release\/environment labels missing\/missing\/missing/u);
});

test("production verification fails when Center's access tokens would carry no sub", (t) => {
  const { env } = fixture(t, `#!/bin/sh
case "$*" in
  *"compose version --short"*) printf '%s\n' 2.34.0; exit 0 ;;
  *"config --quiet"*) exit 0 ;;
  *"ps --status running --services traefik"*) printf '%s\n' traefik; exit 0 ;;
  *"config --services"*|*"ps --status running --services"*) printf '%s\n' center traefik; exit 0 ;;
  *"ps --quiet"*) printf '%s\n' container-center; exit 0 ;;
  *"inspect --format {{.State.Status}}"*) printf '%s\n' running; exit 0 ;;
  *"inspect --format {{if .State.Health}}{{.State.Health.Status}}{{end}}"*) printf '%s\n' healthy; exit 0 ;;
  *"dk.andersmadsen.luma.environment"*) printf '%s\n' production; exit 0 ;;
  *"inspect --format {{index .Config.Labels"*) printf '%s\n' test-release; exit 0 ;;
esac
exit 0
`);
  const bin = env.PATH.split(":")[0];
  fs.writeFileSync(path.join(bin, "bun"), `#!/bin/sh
printf '%s\\n' "$*" >> "${bin}/node.log"
case "$*" in
  *"realm.js check --project-name owner-stack"*)
    echo "error: identity realm check failed: the center client lacks the default scope basic, so its access tokens carry no sub" >&2
    exit 1 ;;
esac
exit 0
`, { mode: 0o700 });
  const result = spawnSync("bash", [verify, "--project-name", "owner-stack"], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /the center client lacks the default scope basic, so its access tokens carry no sub/u);
  const calls = fs.readFileSync(path.join(bin, "node.log"), "utf8").trim().split("\n");
  assert.match(calls.at(-1), /\/platform\/cli\/realm\.js check --project-name owner-stack$/u);
  assert.equal(calls.some((call) => call.startsWith("- ")), false, "public checks never ran");
});

// A healthy stack whose public checks run in the real Node, against `origin`.
function publicCheckFixture(t, origin) {
  const { env } = fixture(t, `#!/bin/sh
case "$*" in
  *"compose version --short"*) printf '%s\n' 2.34.0; exit 0 ;;
  *"config --quiet"*) exit 0 ;;
  *"ps --status running --services traefik"*) printf '%s\n' traefik; exit 0 ;;
  *"config --services"*|*"ps --status running --services"*) printf '%s\n' center traefik; exit 0 ;;
  *"ps --quiet"*) printf '%s\n' container-center; exit 0 ;;
  *"inspect --format {{.State.Status}}"*) printf '%s\n' running; exit 0 ;;
  *"inspect --format {{if .State.Health}}{{.State.Health.Status}}{{end}}"*) printf '%s\n' healthy; exit 0 ;;
  *"dk.andersmadsen.luma.environment"*) printf '%s\n' production; exit 0 ;;
  *"inspect --format {{index .Config.Labels"*) printf '%s\n' test-release; exit 0 ;;
esac
exit 0
`);
  // The realm check is out of scope here. The public checks (`node -`) run.
  fs.writeFileSync(path.join(env.PATH.split(":")[0], "bun"), `#!/bin/sh
[ "$1" = --no-env-file ] && shift
[ "$1" = - ] && exec ${JSON.stringify(process.execPath)} "$@"
exit 0
`, { mode: 0o700 });
  return { ...env, LUMA_PUBLIC_ORIGIN: origin, COSMOS_OIDC_ISSUER: `${origin}/realms/humane` };
}

test("production verification names why the public origin cannot be reached", (t) => {
  const env = publicCheckFixture(t, "https://center.luma-verify.invalid");
  const result = spawnSync("bash", [verify], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^fetch failed \((?:ENOTFOUND|EAI_AGAIN)[^)]*\)$/mu);
  assert.match(result.stderr, /center\.luma-verify\.invalid does not resolve from this server; point its DNS A record/u);
  assert.doesNotMatch(result.stderr, /waiting for/u, "a plain verify does not wait");
});

test("a confirmed deploy waits for the first public answer, then checks it", async (t) => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ release: "other-release", environment: "production" }));
  });
  const port = await new Promise((resolve) => {
    const probe = http.createServer().listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  t.after(() => server.close());
  const env = { ...publicCheckFixture(t, `http://127.0.0.1:${port}`), LUMA_DEPLOY_CONFIRMED: "1" };
  const child = spawn("bash", [verify], { cwd: root, env });
  let stderr = "";
  let answering = false;
  // Answer only once the first refusal is reported. A timer would let a slow
  // start (a busy machine) find the server already listening and never wait.
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (answering || !stderr.includes("waiting up to")) return;
    answering = true;
    server.listen(port, "127.0.0.1");
  });
  const status = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(status, 1, stderr);
  assert.match(stderr, new RegExp(`waiting up to 120s for http://127\\.0\\.0\\.1:${port} to answer \\(ECONNREFUSED`, "u"));
  assert.equal(stderr.match(/waiting up to/gu).length, 1, "one line per distinct cause");
  assert.match(stderr, /Center release mismatch: expected test-release, received other-release/u);
});

test("confirmed deployment runs public verification before reporting success", () => {
  const source = fs.readFileSync(deploy, "utf8");
  const up = source.indexOf('docker compose "${compose[@]}" "${up[@]}"');
  const pinActivation = source.indexOf('acquire-release.mjs" --activate --json');
  const verification = source.indexOf('"$SCRIPT_DIR/verify.sh"');
  const success = source.indexOf("passed production verification");
  assert.ok(
    up >= 0 && pinActivation > up && verification > pinActivation && success > verification,
    "new services must become ready before activation and one combined verification",
  );
  assert.equal(source.lastIndexOf('"$SCRIPT_DIR/verify.sh"'), verification);
  assert.doesNotMatch(source, /deployment .* is healthy/u);
  assert.match(source, /-f "\$application"[\s\S]*-f "\$operator_compose"/u);
  assert.doesNotMatch(source, /ROOT\/compose\.yaml|platform\/compose\/production\.yaml/u);
  assert.match(source, /up --yes --detach --wait --wait-timeout/u);
  assert.doesNotMatch(source, /printf ['"]?y|echo ['"]?y/u);
  assert.match(source, /LUMA_DEPLOY_CONFIRMED/u);
  const dryRunExit = source.indexOf("exit 0", source.indexOf("if ((dry_run))"));
  assert.ok(dryRunExit >= 0 && dryRunExit < up, "dry-run must exit before deployment and verification");
});

test("confirmed deploy passes Compose --yes without printing interpolation secrets", (t) => {
  const { env } = fixture(t, `#!/bin/sh
printf '%s\n' "$*" >> "$LUMA_TEST_DOCKER_LOG"
case "$*" in
  *"compose version --short"*) printf '%s\n' 2.34.0 ;;
  *"config --quiet"*) ;;
  *"ps --status running --services traefik"*) printf '%s\n' traefik ;;
  *"config --services"*) printf '%s\n' center ;;
  *"ps --status running --services"*) printf '%s\n' center ;;
esac
exit 0
`);
  const dockerLog = path.join(path.dirname(env.LUMA_CONFIG_DIR), "docker.log");
  const deploymentEnv = {
    ...env,
    LUMA_DEPLOY_CONFIRMED: "1",
    LUMA_TEST_DOCKER_LOG: dockerLog,
    TEST_PLAINTEXT_INTERPOLATION_SECRET: "must-not-appear",
  };
  const result = spawnSync("bash", [deploy], {
    cwd: root,
    env: deploymentEnv,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(dockerLog, "utf8"), /up --yes --detach --wait/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /must-not-appear/u);

  const unconfirmed = spawnSync("bash", [deploy], {
    cwd: root,
    env: { ...deploymentEnv, LUMA_DEPLOY_CONFIRMED: "" },
    encoding: "utf8",
  });
  assert.equal(unconfirmed.status, 1);
  assert.match(unconfirmed.stderr, /requires luma deploy production --confirm/u);
});

test("deploy recreates the edge services so the re-rendered edge configuration is loaded", (t) => {
  const { env } = fixture(t, `#!/bin/sh
printf '%s\n' "$*" >> "$LUMA_TEST_DOCKER_LOG"
case "$*" in
  *"compose version --short"*) printf '%s\n' 2.34.0 ;;
  *"ps --status running --services traefik"*) printf '%s\n' traefik ;;
  *"config --services"*) printf '%s\n' center ;;
  *"ps --status running --services"*) printf '%s\n' center ;;
esac
exit 0
`);
  const dockerLog = path.join(path.dirname(env.LUMA_CONFIG_DIR), "docker.log");
  // The pin profile's verification checks the Pin edge certificate over SNI;
  // this stub serves the configured edge certificate and its chain.
  fs.writeFileSync(path.join(env.PATH.split(":")[0], "openssl"), `#!/bin/sh
case "$1" in
  s_client) printf '%s\\n' '-----BEGIN CERTIFICATE-----' 'edge' '-----END CERTIFICATE-----' ;;
  x509) case "$*" in *-fingerprint*) printf '%s\\n' 'sha256 Fingerprint=00:11' ;; esac ;;
esac
exit 0
`, { mode: 0o700 });
  const upCommands = () => fs.readFileSync(dockerLog, "utf8").split("\n")
    .map((line) => line.replace(/^compose .* -f \S+ -f \S+ /u, ""))
    .filter((command) => command.startsWith("up ") || command === "ps");
  const allUp = "up --yes --detach --wait --wait-timeout 180 --pull always --remove-orphans";
  const edgeUp = "up --yes --detach --wait --wait-timeout 180 --no-deps --force-recreate";

  for (const [profiles, services] of [["", "traefik"], ["search,pin", "traefik edge"]]) {
    fs.rmSync(dockerLog, { force: true });
    const result = spawnSync("bash", [deploy], {
      cwd: root,
      env: {
        ...env,
        COMPOSE_PROFILES: profiles,
        LUMA_DEPLOY_CONFIRMED: "1",
        LUMA_TEST_DOCKER_LOG: dockerLog,
        ...(profiles.includes("pin") ? { LUMA_DEVICE_EDGE_IPV4: "198.51.100.22" } : {}),
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      /^Verified healthy services.*, plus the configured Pin certificate chain\.$/mu.test(result.stdout),
      profiles.includes("pin"),
      result.stdout,
    );
    assert.deepEqual(upCommands(), [allUp, `${edgeUp} ${services}`, "ps"], profiles);

    fs.rmSync(dockerLog, { force: true });
    const preview = spawnSync("bash", [deploy, "--dry-run"], {
      cwd: root,
      env: { ...env, COMPOSE_PROFILES: profiles, LUMA_TEST_DOCKER_LOG: dockerLog },
      encoding: "utf8",
    });
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /^Nothing was changed\. \.\/luma deploy production --confirm will:$/mu);
    assert.match(preview.stdout, new RegExp(`^  3\\. Recreate the edge containers \\(${services}\\): every hostname Traefik serves pauses briefly\\.$`, "mu"));
    assert.equal(/Switch Center to this release's staged Pin apps/u.test(preview.stdout), profiles.includes("pin"), profiles);
    assert.match(preview.stdout, /\. Run the checks of \.\/luma verify production\.$/mu);
    const printed = preview.stdout.split("\n").filter((line) => line.startsWith("docker compose "));
    assert.equal(printed.length, 2, preview.stdout);
    assert.ok(printed[0].endsWith(allUp), printed[0]);
    assert.ok(printed[1].endsWith(`${edgeUp} ${services}`), printed[1]);
    assert.deepEqual(upCommands(), [], "a dry run starts nothing");
  }
});

test("the containerized iroh bridge is nonroot, persistent, and Pin-independent for health", () => {
  const dockerfile = fs.readFileSync(
    path.join(root, "platform/containers/center-iroh-bridge/Dockerfile"),
    "utf8",
  );
  assert.match(dockerfile, /^USER 65532:65532$/mu);
  assert.match(dockerfile, /^VOLUME \["\/var\/lib\/center-iroh-bridge"\]$/mu);
  assert.match(dockerfile, /HEALTHCHECK[^\n]*[\s\S]*http:\/\/127\.0\.0\.1:18080\/__health/u);

  const compose = fs.readFileSync(
    path.join(root, "platform/compose/production.yaml"),
    "utf8",
  );
  assert.match(
    compose,
    /test: \[CMD, curl, [^\n]*http:\/\/127\.0\.0\.1:18080\/__health\]/u,
  );
  assert.doesNotMatch(
    compose,
    /wget[^\n]*http:\/\/127\.0\.0\.1:18080\/__health/u,
  );

  const bridge = fs.readFileSync(path.join(root, "pin/bridge/src/main.rs"), "utf8");
  assert.match(
    bridge,
    /let connected = state\s*\.connection\s*\.try_lock\(\)/u,
  );
  assert.doesNotMatch(bridge, /using an ephemeral key/u);
  assert.doesNotMatch(bridge, /#\[arg\(long, short\)\]\s*ticket:/u);
});
