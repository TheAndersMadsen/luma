import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(root, "luma");
const require = createRequire(import.meta.url);

// production-setup.js reads the operator directories when it loads, so this
// file's production configuration is chosen before the first require.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-identity-realm-"));
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const env = {
  ...process.env,
  LUMA_CONFIG_DIR: path.join(temporary, "config"),
  LUMA_SECRETS_DIR: path.join(temporary, "secrets"),
  LUMA_ENV_FILE: path.join(temporary, "secrets", "runtime.env"),
  LUMA_DATA_DIR: path.join(temporary, "data"),
  LUMA_BUILD_DIR: path.join(temporary, "data", "build"),
  LUMA_STATE_DIR: path.join(temporary, "state"),
};
for (const name of ["LUMA_CONFIG_DIR", "LUMA_SECRETS_DIR", "LUMA_ENV_FILE", "LUMA_DATA_DIR", "LUMA_BUILD_DIR", "LUMA_STATE_DIR"]) {
  process.env[name] = env[name];
}
const production = path.join(env.LUMA_CONFIG_DIR, "production");

const {
  BRUTE_FORCE,
  SESSION_POLICY,
  CENTER_DEFAULT_SCOPES,
  checkCenterTokens,
  keycloakAdmin,
  planRealmReconcile,
  reconcileRealm,
  reconcileReport,
  userProfile,
} = require("../../cli/realm.js");

function invoke(...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
}

let setUp = false;
function setupProduction() {
  if (setUp) return;
  const result = invoke(
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
  );
  assert.equal(result.status, 0, result.stderr);
  setUp = true;
}

// Keycloak 26's defaults for a realm imported by an earlier Luma release: no
// `basic` scope on the client, both names required, no brute-force
// protection, "Forgot password" on without an SMTP server, and an imported
// owner without the realm's default roles.
function earlierRealmState() {
  const profile = userProfile();
  for (const attribute of profile.attributes) {
    if (attribute.name === "firstName" || attribute.name === "lastName") attribute.required = { roles: ["user"] };
  }
  const scopes = [...CENTER_DEFAULT_SCOPES, "address", "phone"].map((name, index) => ({ id: `scope-${index}`, name }));
  return {
    realm: {
      realm: "humane",
      resetPasswordAllowed: true,
      bruteForceProtected: false,
      permanentLockout: false,
      failureFactor: 30,
      waitIncrementSeconds: 60,
      maxFailureWaitSeconds: 900,
      maxDeltaTimeSeconds: 43200,
      quickLoginCheckMilliSeconds: 1000,
      minimumQuickLoginWaitSeconds: 60,
      smtpServer: {},
      defaultRole: { id: "role-1", name: "default-roles-humane", composite: true },
    },
    clients: [{ id: "client-1", clientId: "center" }],
    defaultScopes: scopes.filter((scope) => scope.name !== "basic" && CENTER_DEFAULT_SCOPES.includes(scope.name)),
    optionalScopes: scopes.filter((scope) => scope.name === "address" || scope.name === "phone"),
    scopes,
    profile,
    defaultRoleHolders: [],
    // Keycloak's default direct grant: it demands a code from any account
    // that carries an authenticator, which Center's form has no field for.
    flows: [{ id: "flow-direct", alias: "direct grant", topLevel: true }],
    executions: [
      { id: "exec-username", providerId: "direct-grant-validate-username", requirement: "REQUIRED" },
      { id: "exec-password", providerId: "direct-grant-validate-password", requirement: "REQUIRED" },
      { id: "exec-otp", providerId: "direct-grant-validate-otp", requirement: "CONDITIONAL" },
    ],
  };
}

/** Keycloak's admin REST surface, as far as the reconcile and reset use it. */
function fakeKeycloak(state = earlierRealmState()) {
  const calls = [];
  const users = [{
    id: "user-1", username: "owner@example.test", email: "owner@example.test", password: "old", locked: true, sessions: 2,
  }];
  return {
    state,
    calls,
    users,
    run(args, body) {
      calls.push({ args, body });
      const [verb, resource] = args;
      if (verb === "get" && resource === "realms/humane") return structuredClone(state.realm);
      if (verb === "get" && resource === "clients") return structuredClone(state.clients);
      if (verb === "get" && resource === "clients/client-1/default-client-scopes") return structuredClone(state.defaultScopes);
      if (verb === "get" && resource === "client-scopes") return structuredClone(state.scopes);
      if (verb === "get" && resource === "clients/client-1/optional-client-scopes") {
        return structuredClone(state.optionalScopes);
      }
      if (verb === "get" && resource === "users/profile") return structuredClone(state.profile);
      if (verb === "get" && resource === "users" && !args.includes("-q")) {
        return users.map(({ id, username }) => ({ id, username }));
      }
      if (verb === "get" && resource === "users") {
        const email = args[args.indexOf("-q") + 1].replace(/^email=/u, "");
        return users.filter((user) => user.email === email).map(({ id, email: address }) => ({ id, email: address }));
      }
      if (verb === "get" && resource === "roles/default-roles-humane/users") {
        return structuredClone(state.defaultRoleHolders);
      }
      if (verb === "get" && resource === "authentication/flows") return structuredClone(state.flows);
      const executions = /^authentication\/flows\/(.+)\/executions$/u.exec(resource);
      if (verb === "get" && executions) {
        return structuredClone(state.executions);
      }
      const execution = /^authentication\/flows\/(.+)\/executions\/(.+)$/u.exec(resource);
      if (verb === "update" && execution) {
        assert.equal(decodeURIComponent(execution[1]), "direct grant", "the execution is edited inside its flow");
        const found = state.executions.find((candidate) => candidate.id === execution[2]);
        assert.equal(found.providerId, "direct-grant-validate-otp", "only the direct grant's code step is edited");
        found.requirement = body.requirement;
        return null;
      }
      if (verb === "add-roles") {
        assert.equal(args[args.indexOf("--rolename") + 1], "default-roles-humane");
        const user = users.find((candidate) => candidate.id === args[args.indexOf("--uid") + 1]);
        state.defaultRoleHolders.push({ id: user.id, username: user.username });
        return null;
      }
      const optional = /^clients\/client-1\/optional-client-scopes\/(.+)$/u.exec(resource);
      if (verb === "delete" && optional) {
        state.optionalScopes = state.optionalScopes.filter((candidate) => candidate.id !== optional[1]);
        return null;
      }
      const scope = /^clients\/client-1\/default-client-scopes\/(.+)$/u.exec(resource);
      if (verb === "update" && scope) {
        // Keycloak keeps a scope that is already optional where it is.
        if (!state.optionalScopes.some((candidate) => candidate.id === scope[1])) {
          state.defaultScopes.push(state.scopes.find((candidate) => candidate.id === scope[1]));
        }
        return null;
      }
      if (verb === "update" && resource === "users/profile") {
        state.profile = structuredClone(body);
        return null;
      }
      if (verb === "update" && resource === "realms/humane") {
        Object.assign(state.realm, body);
        return null;
      }
      if (verb === "update" && resource === "users/user-1/reset-password") {
        users[0].password = body.value;
        assert.equal(body.temporary, false);
        return null;
      }
      if (verb === "delete" && resource === "attack-detection/brute-force/users/user-1") {
        users[0].locked = false;
        return null;
      }
      if (verb === "create" && resource === "users/user-1/logout") {
        users[0].sessions = 0;
        return null;
      }
      throw new Error(`unexpected Keycloak admin call: ${args.join(" ")}`);
    },
  };
}

test("an earlier realm is brought onto Luma's policy once, and a second deploy changes nothing", () => {
  const keycloak = fakeKeycloak();
  const changed = reconcileRealm(keycloak, { clientId: "center" });
  assert.deepEqual(changed, [
    "added the basic default scope to the center client",
    "gave owner@example.test the realm's default roles, which the account console requires",
    "made firstName and lastName optional in the user profile",
    "let an account with a second factor sign in to Center (the direct grant no longer asks for a code, which its form has no field for)",
    "turned on brute-force protection (a temporary lockout after 10 failed sign-ins); " +
      "turned off Forgot password, which can only send an email and this realm has no SMTP server; " +
      "enabled persistent Center sign-in (ten-year sessions, fifteen-minute access tokens)",
  ]);
  assert.ok(keycloak.state.defaultScopes.some((scope) => scope.name === "basic"), "`basic` puts sub in the token");
  assert.deepEqual(keycloak.state.defaultRoleHolders.map((user) => user.id), ["user-1"]);
  for (const attribute of keycloak.state.profile.attributes) {
    if (attribute.name === "firstName" || attribute.name === "lastName") {
      assert.equal(Object.hasOwn(attribute, "required"), false, attribute.name);
    }
  }
  assert.deepEqual(
    keycloak.state.profile.attributes.find((attribute) => attribute.name === "email").required,
    { roles: ["user"] },
    "the email stays required",
  );
  for (const [name, value] of Object.entries(BRUTE_FORCE)) assert.equal(keycloak.state.realm[name], value, name);
  for (const [name, value] of Object.entries(SESSION_POLICY)) assert.equal(keycloak.state.realm[name], value, name);
  assert.equal(SESSION_POLICY.ssoSessionMaxLifespan, 10 * 365 * 86400);
  assert.equal(SESSION_POLICY.ssoSessionIdleTimeout, 10 * 365 * 86400);
  assert.equal(SESSION_POLICY.accessTokenLifespan, 900);
  assert.equal(keycloak.state.realm.permanentLockout, false, "a lockout must never be permanent");
  assert.equal(keycloak.state.realm.resetPasswordAllowed, false);
  assert.equal(
    keycloak.state.executions.find((execution) => execution.providerId === "direct-grant-validate-otp").requirement,
    "disabled",
    "an authenticator on the account must not lock Center out",
  );
  assert.equal(
    keycloak.state.executions.find((execution) => execution.providerId === "direct-grant-validate-password").requirement,
    "REQUIRED",
    "the password stays required",
  );
  // Only the changed realm fields are written.
  const realmWrite = keycloak.calls.find((call) => call.args[1] === "realms/humane" && call.args[0] === "update");
  assert.deepEqual(Object.keys(realmWrite.body).sort(), ["bruteForceProtected", "failureFactor", "resetPasswordAllowed", ...Object.keys(SESSION_POLICY)].sort());

  const writes = keycloak.calls.length;
  assert.deepEqual(reconcileRealm(keycloak, { clientId: "center" }), []);
  assert.ok(keycloak.calls.slice(writes).every((call) => call.args[0] === "get"), "a matching realm is only read");
});

test("Forgot password follows the realm's SMTP server", () => {
  const withSmtp = earlierRealmState();
  withSmtp.realm.resetPasswordAllowed = false;
  withSmtp.realm.smtpServer = { host: "smtp.example.test", from: "luma@example.test" };
  const settings = planRealmReconcile({ ...withSmtp, clientId: "center", client: withSmtp.clients[0] })
    .find((change) => change.args[1] === "realms/humane");
  assert.equal(settings.body.resetPasswordAllowed, true);
  assert.match(settings.summary, /turned on Forgot password because an SMTP server is configured/u);

  const missingScope = earlierRealmState();
  missingScope.scopes = missingScope.scopes.filter((scope) => scope.name !== "basic");
  assert.throws(
    () => planRealmReconcile({ ...missingScope, clientId: "center", client: missingScope.clients[0] }),
    /realm humane has no basic client scope to give the center client/u,
  );
});

test("a basic scope that is only optional becomes a default, and a second deploy agrees", () => {
  const state = earlierRealmState();
  const basic = state.scopes.find((scope) => scope.name === "basic");
  state.optionalScopes.push(basic);
  const keycloak = fakeKeycloak(state);
  const changed = reconcileRealm(keycloak, { clientId: "center" });
  assert.deepEqual(changed.slice(0, 2), [
    "removed basic from the center client's optional scopes",
    "added the basic default scope to the center client",
  ]);
  assert.ok(keycloak.state.defaultScopes.some((scope) => scope.name === "basic"));
  assert.ok(!keycloak.state.optionalScopes.some((scope) => scope.name === "basic"));
  assert.deepEqual(reconcileRealm(keycloak, { clientId: "center" }), []);
});

test("verification's check reads whether Center's tokens carry sub and changes nothing", () => {
  const keycloak = fakeKeycloak();
  assert.throws(() => checkCenterTokens(keycloak, { clientId: "center" }),
    /the center client lacks the default scope basic, so its access tokens carry no sub and Cosmos refuses them; run \.\/luma deploy production --confirm, which reconciles the realm/u);
  assert.ok(keycloak.calls.every((call) => call.args[0] === "get"), "the check only reads");
  assert.ok(!keycloak.state.defaultScopes.some((scope) => scope.name === "basic"));

  const withoutEmail = earlierRealmState();
  withoutEmail.defaultScopes = withoutEmail.defaultScopes.filter((scope) => scope.name !== "email");
  assert.throws(() => checkCenterTokens(fakeKeycloak(withoutEmail), { clientId: "center" }),
    /lacks the default scopes email, basic, so its access tokens carry no sub/u);

  reconcileRealm(keycloak, { clientId: "center" });
  checkCenterTokens(keycloak, { clientId: "center" });
  assert.throws(() => checkCenterTokens(keycloak, { clientId: "other" }), /realm humane has no other client/u);
});

test("verification runs the realm check after the services are healthy", () => {
  const source = fs.readFileSync(path.join(root, "platform", "deploy", "vps", "verify.sh"), "utf8");
  const healthy = source.indexOf('done < <(docker compose "${compose[@]}" ps --quiet)');
  const check = source.indexOf('bun --no-env-file "$ROOT/platform/cli/realm.js" check --project-name "$project_name"');
  const publicChecks = source.indexOf("bun --no-env-file - \"$LUMA_PUBLIC_ORIGIN\"");
  assert.ok(healthy >= 0 && check > healthy && publicChecks > check, "Keycloak is running before the check reads it");
});

test("./luma up reconciles the running development realm once Keycloak is healthy, before the other services", () => {
  const { upLocalStack } = require("../../cli/stack.js");
  const { operatorEnvironment } = require("../../cli/context.js");
  const keycloak = fakeKeycloak();
  const started = [];
  const lines = [];
  const connected = [];
  const values = { LUMA_IDENTITY_ENABLED: "true", KEYCLOAK_CLIENT_ID: "center" };
  const up = () => upLocalStack(["center"], {
    values: () => values,
    compose: (args) => started.push({ args, adminCalls: keycloak.calls.length }),
    keycloakAdmin: (options) => {
      connected.push(options);
      return keycloak;
    },
    write: (line) => lines.push(line),
  });
  up();
  // kcadm reaches the Keycloak on the Docker endpoint Compose started it on.
  assert.deepEqual(connected, [{ project: "luma", env: operatorEnvironment(values) }]);
  assert.deepEqual(started.map((entry) => entry.args), [
    ["up", "--detach", "--wait", "--wait-timeout", "120", "keycloak"],
    ["up", "--detach", "--remove-orphans", "center"],
  ]);
  assert.equal(started[0].adminCalls, 0, "Keycloak is up and healthy before the reconcile reads it");
  assert.ok(started[1].adminCalls > 0, "the realm is on policy before the other services start");
  assert.ok(lines.includes("Identity realm humane: added the basic default scope to the center client."), lines.join("\n"));
  assert.ok(keycloak.state.defaultScopes.some((scope) => scope.name === "basic"));

  lines.length = 0;
  up();
  assert.deepEqual(lines.slice(1), ["Identity realm humane already matches this release's policy."]);

  // Without local identity there is no realm to reconcile.
  started.length = 0;
  upLocalStack([], {
    values: () => ({ LUMA_IDENTITY_ENABLED: "false" }),
    compose: (args) => started.push({ args }),
    keycloakAdmin: () => assert.fail("no Keycloak without local identity"),
    write: () => {},
  });
  assert.deepEqual(started.map((entry) => entry.args), [["up", "--detach", "--remove-orphans"]]);
  assert.deepEqual(reconcileReport([]), ["Identity realm humane already matches this release's policy."]);
});

test("the admin CLI runs inside the Keycloak container with its own credentials, never this host's", (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "luma-kcadm-"));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const log = path.join(bin, "docker.log");
  const docker = path.join(bin, "docker");
  fs.writeFileSync(docker, `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  ps) printf '%s\\n' keycloak-container ;;
  exec)
    stdin=$(cat)
    printf 'stdin:%s\\n' "$stdin" >> "${log}"
    case "$*" in
      *"get realms/humane"*) printf '%s' '{"realm":"humane"}' ;;
      *"get users"*) echo 'Logging into http://localhost:8080 as user admin of realm master' >&2; echo 'Invalid user credentials [invalid_grant]' >&2; exit 1 ;;
    esac ;;
esac
`, { mode: 0o700 });

  const admin = keycloakAdmin({ project: "luma", docker, env: { PATH: "/usr/bin:/bin" } });
  assert.deepEqual(admin.run(["get", "realms/humane"]), { realm: "humane" });
  admin.run(["update", "users/user-1/reset-password", "-r", "humane", "-f", "-"], { value: "a-new-password" });
  assert.throws(
    () => admin.run(["get", "users", "-r", "humane"]),
    /Keycloak admin get users failed: Invalid user credentials \[invalid_grant\]\. Keycloak refused the bootstrap admin/u,
  );

  const recorded = fs.readFileSync(log, "utf8");
  assert.match(recorded, /^ps --quiet --filter label=com\.docker\.compose\.project=luma --filter label=com\.docker\.compose\.service=keycloak --filter status=running$/mu);
  const exec = recorded.split("\n").find((line) => line.startsWith("exec "));
  assert.ok(exec.startsWith("exec -i keycloak-container bash -c "), exec);
  // The container expands its own bootstrap admin variables.
  assert.ok(exec.includes('KC_CLI_PASSWORD="$KC_BOOTSTRAP_ADMIN_PASSWORD"'), exec);
  assert.ok(exec.includes('--user "$KC_BOOTSTRAP_ADMIN_USERNAME"'), exec);
  assert.ok(exec.includes("--no-config"), exec);
  // A new password crosses on standard input only.
  assert.ok(!recorded.split("\n").some((line) => !line.startsWith("stdin:") && line.includes("a-new-password")));
  assert.ok(recorded.includes('stdin:{"value":"a-new-password"}'));

  fs.writeFileSync(docker, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.throws(
    () => keycloakAdmin({ project: "luma", docker, env: {} }),
    /Keycloak is not running in the luma Compose project; run \.\/luma deploy production --confirm first/u,
  );
});

test("both realm seeds carry the policy the reconcile enforces", () => {
  setupProduction();
  const { productionRealm } = require("../../cli/production-setup.js");
  const context = require("../../cli/context.js");
  assert.equal(typeof productionRealm, "function");
  const seeds = {
    production: productionRealm({
      LUMA_PUBLIC_ORIGIN: "https://pin.example.test",
      LUMA_FIRST_OPERATOR_EMAIL: "owner@example.test",
      LUMA_FIRST_OPERATOR_ID: "11111111-1111-4111-8111-111111111111",
      KEYCLOAK_CLIENT_SECRET: "s".repeat(32),
    }, "p".repeat(32)),
  };
  // The development realm file is written by init for the local stack.
  const init = invoke("init");
  assert.equal(init.status, 0, init.stderr);
  seeds.development = JSON.parse(fs.readFileSync(path.join(env.LUMA_SECRETS_DIR, "identity", "realm.json"), "utf8"));
  assert.equal(context.ENV_FILE, env.LUMA_ENV_FILE);

  for (const [name, realm] of Object.entries(seeds)) {
    const client = realm.clients[0];
    const state = {
      realm,
      clientId: client.clientId,
      client: { id: "client-1", clientId: client.clientId },
      defaultScopes: client.defaultClientScopes.map((scope) => ({ id: scope, name: scope })),
      scopes: [],
      profile: JSON.parse(realm.components["org.keycloak.userprofile.UserProfileProvider"][0].config["kc.user.profile.config"][0]),
    };
    assert.deepEqual(planRealmReconcile(state), [], `${name} seed needs no reconcile`);
    assert.equal(realm.resetPasswordAllowed, false, name);
  }
});

test("a lost password gets a new one-time password in the first-login file, never on the terminal", () => {
  setupProduction();
  const { resetFirstOperatorPassword } = require("../../cli/production-setup.js");
  const credentials = path.join(production, "first-login.txt");
  const realmFile = path.join(production, "realm.json");
  fs.unlinkSync(credentials);

  const plan = invoke("reset-password", "production");
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /replaces the password of owner@example\.test/u);
  assert.match(plan.stdout, /Nothing changed\. Run \.\/luma reset-password production --confirm/u);
  assert.equal(fs.existsSync(credentials), false, "a plan writes nothing");
  assert.equal(invoke("reset-password", "production", "--bogus").status, 64);
  assert.equal(invoke("reset-password", "staging", "--confirm").status, 64);

  const keycloak = fakeKeycloak();
  const result = resetFirstOperatorPassword({ admin: keycloak });
  const password = keycloak.users[0].password;
  assert.match(password, /^[A-Za-z0-9_-]{32}$/u);
  assert.equal(keycloak.users[0].locked, false, "a lockout is cleared");
  assert.equal(keycloak.users[0].sessions, 0, "every earlier sign-in ends");
  assert.equal(result.credentials, credentials);
  assert.equal(fs.statSync(credentials).mode & 0o777, 0o600);
  const handoff = fs.readFileSync(credentials, "utf8");
  assert.match(handoff, new RegExp(`^Initial password: ${password}$`, "mu"));
  assert.match(handoff, /^Operator: owner@example\.test$/mu);
  assert.equal(fs.statSync(realmFile).mode & 0o777, 0o444);
  assert.equal(JSON.parse(fs.readFileSync(realmFile, "utf8")).users[0].credentials[0].value, password);
  assert.ok(!JSON.stringify(result).includes(password), "the result never carries the password");

  // A later setup accepts the new handoff instead of refusing it.
  const rerun = invoke("setup", "production");
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(fs.readFileSync(credentials, "utf8"), new RegExp(`^Initial password: ${password}$`, "mu"));
});

test("reset-password is registered in both CLIs and the operator contract", () => {
  const help = invoke("reset-password", "production", "--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: luma reset-password production \[--confirm\] \[--project-name NAME\]/u);
  assert.match(help.stdout, /It never prints the password\./u);
  assert.match(help.stdout, /Guide: README\.md#reset-a-lost-password/u);
  const operator = spawnSync(process.execPath, [path.join(root, "platform", "distribution", "operator-luma"), "--help"], {
    encoding: "utf8",
  });
  assert.match(operator.stdout, /\.\/luma reset-password production \[--confirm\]/u);
  assert.match(fs.readFileSync(path.join(root, "platform", "distribution", "operator-luma"), "utf8"),
    /command === 'reset-password'\) resetPasswordCommand\(args\)/u);
  const contract = JSON.parse(fs.readFileSync(path.join(root, "contracts", "operator-setup.json"), "utf8"));
  const command = contract.commands.find((entry) => entry.id === "reset-password.production");
  assert.equal(command.effect, "remote-mutation");
  assert.equal(command.confirmationRequired, true);
  // The operator archive carries the realm module production-setup.js requires.
  assert.match(fs.readFileSync(path.join(root, "platform", "distribution", "build.mjs"), "utf8"),
    /\["platform\/cli\/realm\.js", "platform\/cli\/realm\.js", 0o644\]/u);
});

test("a confirmed deploy reconciles the running realm before verification", (t) => {
  const deploy = path.join(root, "platform", "deploy", "vps", "deploy.sh");
  const source = fs.readFileSync(deploy, "utf8");
  const up = source.indexOf('docker compose "${compose[@]}" "${up[@]}"');
  const reconcile = source.indexOf('bun --no-env-file "$ROOT/platform/cli/realm.js" reconcile --project-name "$project_name"');
  const verification = source.indexOf('"$SCRIPT_DIR/verify.sh"');
  assert.ok(up >= 0 && reconcile > up && verification > reconcile, "reconcile runs after up --wait and before verify");

  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "luma-deploy-realm-"));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const config = path.join(bin, "config");
  fs.mkdirSync(path.join(config, "production"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(config, "production", "operator.compose.yaml"), "services: {}\n", { mode: 0o600 });
  fs.writeFileSync(path.join(bin, "runtime.env"), "LUMA_RELEASE_ID=test-release\n", { mode: 0o600 });
  for (const [name, contents] of [
    ["docker", "#!/bin/sh\ncase \"$*\" in *\"compose version --short\"*) echo 2.34.0 ;; *\"ps --status running --services traefik\"*) echo traefik ;; esac\nexit 0\n"],
    ["getent", "#!/bin/sh\nprintf '%s\\n' '203.0.113.10 STREAM pin.example.test'\n"],
    ["bun", "#!/bin/sh\nexit 0\n"],
  ]) fs.writeFileSync(path.join(bin, name), contents, { mode: 0o700 });
  const preview = spawnSync("bash", [deploy, "--dry-run", "--project-name", "owner-stack"], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      LUMA_ENV_FILE: path.join(bin, "runtime.env"),
      LUMA_CONFIG_DIR: config,
      LUMA_RELEASE_ID: "test-release",
      LUMA_COMPOSE_APPLICATION: `oci://ghcr.io/example/luma/application@sha256:${"a".repeat(64)}`,
      LUMA_PUBLIC_ORIGIN: "https://pin.example.test",
      LUMA_PUBLIC_DOMAIN: "pin.example.test",
      COSMOS_OIDC_ISSUER: "https://pin.example.test/realms/humane",
      COMPOSE_PROFILES: "",
    },
    encoding: "utf8",
  });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /^bun --no-env-file \S+\/platform\/cli\/realm\.js reconcile --project-name owner-stack$/mu);
});
