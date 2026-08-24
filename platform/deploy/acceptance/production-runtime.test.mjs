import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const preflight = path.join(root, "platform", "deploy", "vps", "preflight.sh");
const deploy = path.join(root, "platform", "deploy", "vps", "deploy.sh");
const verify = path.join(root, "platform", "deploy", "vps", "verify.sh");

function fixture(t, dockerScript) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-production-runtime-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const bin = path.join(temporary, "bin");
  const config = path.join(temporary, "config");
  const production = path.join(config, "production");
  const envFile = path.join(temporary, "runtime.env");
  fs.mkdirSync(bin, { mode: 0o700 });
  fs.mkdirSync(production, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(production, "operator.compose.yaml"), "services: {}\n", { mode: 0o600 });
  fs.writeFileSync(envFile, "REVIVAL_RELEASE_ID=test-release\n", { mode: 0o600 });
  for (const [name, contents] of [
    ["docker", dockerScript],
    ["ss", "#!/bin/sh\nprintf '%s\\n' 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:((nginx))'\n"],
    ["node", "#!/bin/sh\nexit 0\n"],
  ]) {
    fs.writeFileSync(path.join(bin, name), contents, { mode: 0o700 });
  }
  return {
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      REVIVAL_CONFIG_DIR: config,
      REVIVAL_ENV_FILE: envFile,
      REVIVAL_RELEASE_ID: "test-release",
      REVIVAL_COMPOSE_APPLICATION: `oci://ghcr.io/example/ai-pin-revival/application@sha256:${"a".repeat(64)}`,
      REVIVAL_PUBLIC_ORIGIN: "https://pin.example.test",
      REVIVAL_PUBLIC_DOMAIN: "pin.example.test",
      COSMOS_OIDC_ISSUER: "https://pin.example.test/realms/humane",
      COMPOSE_PROFILES: "",
    },
  };
}

test("production preflight reports occupied public ports without stopping their owner", (t) => {
  const { env } = fixture(t, `#!/bin/sh
case "$*" in
  *"compose version --short"*) printf '%s\n' 2.34.0; exit 0 ;;
  *"config --quiet"*) exit 0 ;;
  *"ps --status running --services traefik"*) exit 0 ;;
esac
exit 0
`);
  const result = spawnSync("/usr/bin/bash", [preflight], { cwd: root, env, encoding: "utf8" });
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
  const result = spawnSync("/usr/bin/bash", [preflight], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("production preflight enforces the Compose OCI minimum", (t) => {
  const { env } = fixture(t, `#!/bin/sh
case "$*" in
  *"compose version --short"*) printf '%s\n' 2.33.9; exit 0 ;;
esac
exit 0
`);
  const result = spawnSync("/usr/bin/bash", [preflight], { cwd: root, env, encoding: "utf8" });
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
  const result = spawnSync("/usr/bin/bash", [verify], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /health=unhealthy/u);
  const source = fs.readFileSync(verify, "utf8");
  assert.match(source, /identity\.release !== expectedRelease/u);
  assert.match(source, /identity\.environment !== expectedEnvironment/u);
  assert.match(source, /publicPages = \['\/', '\/about', '\/contact', '\/privacy', '\/developers'\]/u);
  assert.match(source, /headers: \{ accept: 'text\/markdown' \}/u);
  assert.match(source, /\/openapi\.json/u);
  assert.match(source, /\/llms\.txt/u);
  assert.match(source, /missing\.status !== 404/u);
  assert.match(source, /pinRelease\.status !== 200 && pinRelease\.status !== 404/u);
  assert.doesNotMatch(source, /Object\.hasOwn\(identity, 'environment'\)/u);
  assert.match(source, /REVIVAL_DEVICE_EDGE_IPV4/u);
  assert.match(source, /-connect 127\.0\.0\.1:443 -servername api\.cosmos\.humane\.cloud/u);
  assert.doesNotMatch(source, /-connect "\$edge_ipv4:443"/u);
  assert.match(source, /dk\.andersmadsen\.ai-pin-revival\.release/u);
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
  const result = spawnSync("/usr/bin/bash", [verify], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release\/environment labels missing\/missing\/missing/u);
});

test("confirmed deployment runs public verification before reporting success", () => {
  const source = fs.readFileSync(deploy, "utf8");
  const up = source.indexOf('docker compose "${compose[@]}" "${up[@]}"');
  const verification = source.indexOf('"$SCRIPT_DIR/verify.sh"');
  const success = source.indexOf("passed production verification");
  assert.ok(up >= 0 && verification > up && success > verification);
  assert.doesNotMatch(source, /deployment .* is healthy/u);
  assert.match(source, /-f "\$application"[\s\S]*-f "\$operator_compose"/u);
  assert.doesNotMatch(source, /ROOT\/compose\.yaml|platform\/compose\/production\.yaml/u);
  assert.match(source, /up --yes --detach --wait --wait-timeout/u);
  assert.doesNotMatch(source, /printf ['"]?y|echo ['"]?y/u);
  assert.match(source, /REVIVAL_DEPLOY_CONFIRMED/u);
  const dryRunExit = source.indexOf("exit 0", source.indexOf("if ((dry_run))"));
  assert.ok(dryRunExit >= 0 && dryRunExit < up, "dry-run must exit before deployment and verification");
});

test("confirmed deploy passes Compose --yes without printing interpolation secrets", (t) => {
  const { env } = fixture(t, `#!/bin/sh
printf '%s\n' "$*" >> "$REVIVAL_TEST_DOCKER_LOG"
case "$*" in
  *"compose version --short"*) printf '%s\n' 2.34.0 ;;
  *"config --quiet"*) ;;
  *"ps --status running --services traefik"*) printf '%s\n' traefik ;;
  *"config --services"*) printf '%s\n' center ;;
  *"ps --status running --services"*) printf '%s\n' center ;;
esac
exit 0
`);
  const dockerLog = path.join(path.dirname(env.REVIVAL_CONFIG_DIR), "docker.log");
  const deploymentEnv = {
    ...env,
    REVIVAL_DEPLOY_CONFIRMED: "1",
    REVIVAL_TEST_DOCKER_LOG: dockerLog,
    TEST_PLAINTEXT_INTERPOLATION_SECRET: "must-not-appear",
  };
  const result = spawnSync("/usr/bin/bash", [deploy], {
    cwd: root,
    env: deploymentEnv,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(dockerLog, "utf8"), /up --yes --detach --wait/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /must-not-appear/u);

  const unconfirmed = spawnSync("/usr/bin/bash", [deploy], {
    cwd: root,
    env: { ...deploymentEnv, REVIVAL_DEPLOY_CONFIRMED: "" },
    encoding: "utf8",
  });
  assert.equal(unconfirmed.status, 1);
  assert.match(unconfirmed.stderr, /requires revival deploy production --confirm/u);
});

test("the containerized iroh bridge is nonroot, persistent, and Pin-independent for health", () => {
  const dockerfile = fs.readFileSync(
    path.join(root, "platform/containers/center-iroh-bridge/Dockerfile"),
    "utf8",
  );
  assert.match(dockerfile, /^USER 65532:65532$/mu);
  assert.match(dockerfile, /^VOLUME \["\/var\/lib\/center-iroh-bridge"\]$/mu);
  assert.match(dockerfile, /HEALTHCHECK[^\n]*[\s\S]*http:\/\/127\.0\.0\.1:18080\/__status/u);

  const bridge = fs.readFileSync(path.join(root, "pin/bridge/src/main.rs"), "utf8");
  assert.match(bridge, /stream\s*\.try_lock\(\)/u);
  assert.doesNotMatch(bridge, /using an ephemeral key/u);
  assert.doesNotMatch(bridge, /#\[arg\(long, short\)\]\s*ticket:/u);
});
