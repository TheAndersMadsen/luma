import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalPinReleaseManifestJson,
  createPinReleaseManifest,
  PIN_RELEASE_ARTIFACT_ROLES,
  PIN_RELEASE_PACKAGE_BY_ROLE,
} from "../pin/release.mjs";
import { runOnTerminal, terminalAvailable } from "./fixtures/terminal.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(root, "luma");
const require = createRequire(import.meta.url);
const { productionRealm } = require("../../cli/production-setup.js");
const { guidedProductionArguments } = require("../../cli/guided-production-setup.js");
const { runProductionOnboarding } = require("../../cli/onboard.js");

function fixture(t, { prefix = "luma-setup-" } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  return {
    temporary,
    env: {
      ...process.env,
      LUMA_CONFIG_DIR: path.join(temporary, "config"),
      LUMA_SECRETS_DIR: path.join(temporary, "secrets"),
      LUMA_ENV_FILE: path.join(temporary, "secrets", "runtime.env"),
      LUMA_DATA_DIR: path.join(temporary, "data"),
      LUMA_BUILD_DIR: path.join(temporary, "data", "build"),
      LUMA_STATE_DIR: path.join(temporary, "state"),
    },
  };
}

function invoke(env, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

// Production setup with Docker's answer replaced: `volumes` are the production
// database volumes Docker reports, and null means Docker cannot be asked.
function setupWithVolumes(env, volumes, ...args) {
  const program = `
    const { setupProduction } = require(${JSON.stringify(path.join(root, "platform/cli/production-setup.js"))});
    const volumes = ${JSON.stringify(volumes)};
    try {
      setupProduction(process.argv.slice(1), { productionDatabaseVolumes() {
        if (volumes === null) throw new Error("Docker could not list this server's volumes: permission denied");
        return volumes;
      } });
    } catch (error) {
      process.stderr.write(error.message);
      process.exit(1);
    }
  `;
  return spawnSync(process.execPath, ["-e", program, "--", ...args], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
}

// The merged production model Compose builds from the source application and
// the rendered operator overlay, or null where Docker Compose is unavailable.
// Only selected fields are asserted. The model interpolates fixture secrets.
function productionComposeModel(env) {
  const available = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  if (available.error?.code === "ENOENT" || available.status !== 0) return null;
  const result = spawnSync("docker", [
    "compose",
    "--project-directory", root,
    "--project-name", "luma",
    "--env-file", env.LUMA_ENV_FILE,
    "-f", path.join(root, "compose.yaml"),
    "-f", path.join(root, "platform/compose/production.yaml"),
    "-f", path.join(env.LUMA_CONFIG_DIR, "production", "operator.compose.yaml"),
    "config", "--format", "json",
  ], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function parseEnv(file) {
  return Object.fromEntries(
    fs.readFileSync(file, "utf8")
      .split(/\r?\n/u)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

// Scripted answers for guided setup, with no network: detection and DuckDNS
// go through the injected fixtures (`network`), never a real request.
function guidedIo(lines, network = {}) {
  const pending = [...lines];
  let output = "";
  const requests = [];
  const hidden = [];
  return {
    io: {
      readLine() {
        assert.ok(pending.length > 0, "guided setup requested an unexpected answer");
        return pending.shift();
      },
      readHiddenLine(prompt) {
        hidden.push(prompt);
        assert.ok(pending.length > 0, "guided setup requested an unexpected hidden answer");
        return pending.shift();
      },
      write(value) {
        output += value;
      },
      routeAddress: network.routeAddress ?? (() => { throw new Error("no route in tests"); }),
      fetchText(url) {
        requests.push(url);
        if (!network.fetchText) throw new Error("could not be reached (ENETUNREACH)");
        return network.fetchText(url);
      },
    },
    output: () => output,
    requests,
    hidden,
  };
}

// A server whose own address is what the internet sees, and a DuckDNS that
// accepts the token `duck-secret-token`.
function reachableNetwork({ address = "203.0.113.10", seen = address, duckdns = "OK\n203.0.113.10\nUPDATED" } = {}) {
  return {
    routeAddress: () => address,
    fetchText(url) {
      if (url === "https://api.ipify.org") return { status: 200, body: `${seen}\n` };
      if (url.startsWith("https://www.duckdns.org/update?")) {
        const query = new URL(url).searchParams;
        const accepted = query.get("token") === "duck-secret-token";
        return { status: 200, body: accepted ? duckdns : "KO" };
      }
      throw new Error(`unexpected request to ${url}`);
    },
  };
}

test("production onboarding composes the canonical safe sequence", () => {
  const calls = [];
  const output = [];
  runProductionOnboarding({
    setup: () => calls.push("setup"),
    doctor: () => calls.push("doctor"),
    dryRun: () => calls.push("dry-run"),
    deploy: () => calls.push("deploy"),
    verify: () => calls.push("verify"),
    values: () => ({ LUMA_PUBLIC_ORIGIN: "https://pin.example.test" }),
    readLine: () => "yes",
    write: (value) => output.push(value),
  });
  assert.deepEqual(calls, ["setup", "doctor", "dry-run", "deploy", "verify"]);
  assert.match(output.at(-2), /https:\/\/pin\.example\.test\/login\?next=%2Fsettings%2Fpin%2Fsetup/u);
});

test("production onboarding stops after the dry-run when deployment is declined", () => {
  const calls = [];
  assert.throws(() => runProductionOnboarding({
    setup: () => calls.push("setup"),
    doctor: () => calls.push("doctor"),
    dryRun: () => calls.push("dry-run"),
    deploy: () => calls.push("deploy"),
    verify: () => calls.push("verify"),
    readLine: () => "no",
    write: () => {},
  }), /You cancelled the deployment/u);
  assert.deepEqual(calls, ["setup", "doctor", "dry-run"]);
});

test("production onboarding reports a safe stage-specific recovery after every failure", () => {
  const stages = [
    {
      operation: "setup",
      expected: /stage 1\/5 \(configuration\)/u,
      state: /Nothing was deployed\. Configuration files that setup wrote before it stopped were kept/u,
      recovery: /\.\/luma setup production --guided/u,
    },
    {
      operation: "doctor",
      expected: /stage 2\/5 \(server checks\)/u,
      state: /Nothing was deployed\. Your configuration was kept/u,
      recovery: /\.\/luma doctor production/u,
    },
    {
      operation: "dryRun",
      expected: /stage 3\/5 \(deployment preview\)/u,
      state: /Nothing was deployed\. Your checked configuration was kept/u,
      recovery: /\.\/luma deploy production --dry-run/u,
    },
    {
      operation: "deploy",
      expected: /stage 4\/5 \(deployment\)/u,
      state: /server containers may have changed/iu,
      recovery: /\.\/luma verify production/u,
    },
    {
      operation: "verify",
      expected: /stage 5\/5 \(verification\)/u,
      state: /deployed server was left as it is/u,
      recovery: /\.\/luma verify production/u,
    },
  ];

  for (const failed of stages) {
    const runtime = {
      setup: () => {},
      doctor: () => {},
      dryRun: () => {},
      deploy: () => {},
      verify: () => {},
      values: () => ({ LUMA_PUBLIC_ORIGIN: "https://pin.example.test" }),
      readLine: () => "yes",
      write: () => {},
    };
    runtime[failed.operation] = () => {
      throw new Error("provider password=never-print-this ghp_abcdefghijklmnopqrstuvwxyz");
    };
    assert.throws(() => runProductionOnboarding(runtime), (error) => {
      assert.match(error.message, failed.expected);
      assert.match(error.message, failed.state);
      assert.match(error.message, failed.recovery);
      assert.match(error.message, /^What failed: provider password=\[redacted\]/mu);
      assert.match(error.message, /safe retry: \.\/luma onboard production/iu);
      assert.match(error.message, /No Pin was contacted or changed/u);
      assert.doesNotMatch(error.message, /never-print-this|ghp_/u);
      return true;
    });
  }
});

test("declining deployment explains exactly what the safe rerun preserves", () => {
  assert.throws(() => runProductionOnboarding({
    setup: () => {},
    doctor: () => {},
    dryRun: () => {},
    deploy: () => assert.fail("deploy must not run"),
    verify: () => assert.fail("verify must not run"),
    readLine: () => "no",
    write: () => {},
  }), (error) => {
    assert.match(error.message, /nothing was deployed/u);
    assert.match(error.message, /configuration was kept/u);
    assert.match(error.message, /safe retry: \.\/luma onboard production/iu);
    return true;
  });
});

test("production onboarding passes the Pin archive to setup and every retry names it", (t) => {
  const archive = "/releases/luma 0.3.4/luma-pin-2026-09-24.1.tar.gz";
  const calls = [];
  runProductionOnboarding({
    pinReleaseArchive: archive,
    setup: (args) => calls.push(args),
    doctor: () => {},
    dryRun: () => {},
    deploy: () => {},
    verify: () => {},
    values: () => ({ LUMA_PUBLIC_ORIGIN: "https://pin.example.test" }),
    readLine: () => "yes",
    write: () => {},
  });
  assert.deepEqual(calls, [["production", "--guided", "--pin-release-archive", archive]]);

  // Without an archive, a setup failure that asks for one names the release's
  // own archive in both commands instead of repeating the failing one.
  assert.throws(() => runProductionOnboarding({
    setup: () => { throw new Error("matching Pin release acquisition failed\nfix: Rerun setup with --pin-release-archive FILE"); },
    write: () => {},
  }), (error) => {
    assert.match(error.message, /^Recovery check: \.\/luma setup production --guided --pin-release-archive \.\.\/luma-pin-\*\.tar\.gz$/mu);
    assert.match(error.message, /^Safe retry: \.\/luma onboard production --pin-release-archive \.\.\/luma-pin-\*\.tar\.gz$/mu);
    return true;
  });

  const { env } = fixture(t);
  const given = invoke(env, "onboard", "production", "--pin-release-archive", archive);
  assert.equal(given.status, 1);
  assert.match(given.stderr, /setup production --guided requires an interactive terminal/u);
  assert.match(given.stderr, /^Recovery check: \.\/luma setup production --guided --pin-release-archive '\/releases\/luma 0\.3\.4\/luma-pin-2026-09-24\.1\.tar\.gz'$/mu);
  assert.match(given.stderr, /^Safe retry: \.\/luma onboard production --pin-release-archive '\/releases\/luma 0\.3\.4\/luma-pin-2026-09-24\.1\.tar\.gz'$/mu);
  for (const args of [["--pin-release-archive"], ["--pin-release-archive", "--confirm"], ["--profile", "pin"]]) {
    const usage = invoke(env, "onboard", "production", ...args);
    assert.equal(usage.status, 64, args.join(" "));
    assert.match(usage.stderr, /usage: \.\/luma onboard production \[--pin-release-archive FILE\]/u);
  }
  assert.equal(fs.existsSync(env.LUMA_CONFIG_DIR), false);
});

function seedPinRelease(env) {
  const root = path.join(env.LUMA_DATA_DIR, "pin-releases");
  const version = "2026-08-24.1";
  const versionCode = 202_608_241;
  const signerSha256 = "c".repeat(64);
  const byRole = new Map();
  const artifacts = PIN_RELEASE_ARTIFACT_ROLES.map((role) => {
    const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`signed-${role}`)]);
    byRole.set(role, bytes);
    return {
      role,
      path: `signed/${role}.apk`,
      name: `${role}.apk`,
      package: PIN_RELEASE_PACKAGE_BY_ROLE[role],
      versionName: version,
      versionCode,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      signerSha256,
    };
  });
  const manifest = createPinReleaseManifest({ version, receipts: { schemaVersion: 1, artifacts } });
  const document = canonicalPinReleaseManifestJson(manifest);
  const release = path.join(root, "releases", manifest.releaseId);
  fs.mkdirSync(release, { recursive: true, mode: 0o700 });
  for (const role of PIN_RELEASE_ARTIFACT_ROLES) {
    fs.writeFileSync(path.join(release, `${role}.apk`), byRole.get(role), { mode: 0o600 });
  }
  fs.writeFileSync(path.join(release, "manifest.json"), document, { mode: 0o600 });
  fs.writeFileSync(path.join(root, "current.json"), document, { mode: 0o600 });
  return { manifest, release };
}

test("generated production identity supports Center's direct password grant", () => {
  const password = "p".repeat(32);
  const realm = productionRealm({
    LUMA_PUBLIC_ORIGIN: "https://pin.example.test",
    LUMA_FIRST_OPERATOR_EMAIL: "owner@example.test",
    LUMA_FIRST_OPERATOR_ID: "11111111-1111-4111-8111-111111111111",
    KEYCLOAK_CLIENT_ID: "center",
    KEYCLOAK_CLIENT_SECRET: "s".repeat(32),
  }, password);
  assert.equal(realm.loginTheme, "luma");
  assert.equal(realm.clients[0].publicClient, false);
  assert.equal(realm.clients[0].directAccessGrantsEnabled, true);
  assert.deepEqual(realm.users[0].requiredActions, []);
  assert.deepEqual(realm.users[0].credentials, [{ type: "password", value: password, temporary: false }]);
  assert.match(fs.readFileSync(path.join(root, "center/src/server/auth.ts"), "utf8"), /grant_type: "password"/u);

  // Keycloak 26 requires first and last name by default and holds back an
  // account without them ("Account is not fully set up"), which a direct grant
  // can never finish. The first operator has neither, so neither is required.
  assert.equal(Object.hasOwn(realm.users[0], "firstName"), false);
  const providers = realm.components["org.keycloak.userprofile.UserProfileProvider"];
  assert.equal(providers.length, 1);
  assert.equal(providers[0].providerId, "declarative-user-profile");
  assert.equal(providers[0].config["kc.user.profile.config"].length, 1);
  const profile = JSON.parse(providers[0].config["kc.user.profile.config"][0]);
  const attribute = (name) => profile.attributes.find((candidate) => candidate.name === name);
  assert.deepEqual(profile.attributes.map(({ name }) => name), ["username", "email", "firstName", "lastName"]);
  for (const name of ["username", "firstName", "lastName"]) {
    assert.equal(Object.hasOwn(attribute(name), "required"), false, `${name} must be optional`);
  }
  assert.deepEqual(attribute("email").required, { roles: ["user"] });
  assert.deepEqual(attribute("email").validations, { email: {}, length: { max: 255 } });
  assert.deepEqual(attribute("username").validations, {
    length: { min: 3, max: 255 },
    "username-prohibited-characters": {},
    "up-username-not-idn-homograph": {},
  });
  // Keycloak gives an imported user only the roles it lists. Without the
  // default roles the account console, where Center sends the operator to
  // change their password, refuses them.
  assert.deepEqual(realm.users[0].realmRoles, ["default-roles-humane", "cosmos-operator"]);
  // Keycloak 26 puts `sub` in the access token only through `basic`, and
  // Cosmos rejects a Bearer without it.
  assert.ok(realm.clients[0].defaultClientScopes.includes("basic"));
});

test("guided setup without the Pin feature never asks for an archive and preserves that choice", () => {
  for (const current of [{}, { COMPOSE_PROFILES: "" }]) {
    const scripted = guidedIo([
      "center.example.test", "acme@example.test", "owner@example.test",
      current.COMPOSE_PROFILES === "" ? "" : "none", "", "", "yes",
    ]);
    const args = guidedProductionArguments(current, scripted.io, { pinReleaseStaged: false });
    assert.ok(args.includes("--no-profiles"));
    assert.ok(!args.includes("--public-ip"));
    assert.ok(!args.includes("--pin-release-archive"));
    assert.doesNotMatch(scripted.output(), /Path to this release's Pin archive/u);
    assert.match(scripted.output(), /No physical Pin is needed/u);
    for (let stage = 1; stage <= 8; stage += 1) {
      assert.ok(scripted.output().includes(`[${stage}/8] `));
    }
    assert.match(scripted.output(), /\[5\/8\] Pin feature is off; no Pin address or archive is needed/u);
    assert.doesNotMatch(scripted.output(), /\[[0-9]\/[0-79]\]/u);
  }
});

test("guided production setup collects one reviewed newcomer configuration", () => {
  const scripted = guidedIo([
    "center.example.test",
    "acme@example.test",
    "owner@example.test",
    "",
    "203.0.113.10",
    "", // no update source offered, none kept
    "", // automatic updates: on
    "yes",
  ]);
  const args = guidedProductionArguments({}, scripted.io);
  assert.deepEqual(args, [
    "--domain", "center.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
    "--public-ip", "203.0.113.10",
    "--profile", "pin",
    "--profile", "search",
    "--profile", "spotify",
    "--auto-updates", "on",
  ]);
  // Eight numbered stages: seven questions and the review, in order.
  for (const stage of ["[1/8]", "[2/8]", "[3/8]", "[4/8]", "[5/8]", "[6/8]", "[7/8]", "[8/8]"]) {
    assert.match(scripted.output(), new RegExp(`${stage.replace(/[/[\]]/gu, "\\$&")} `, "u"));
  }
  assert.match(scripted.output(), /\[1\/8\] Public Center domain \(blank or "duckdns" for a free DuckDNS name\)/u);
  // Without a saved or detected address the Pin prompt offers no default and says why.
  assert.match(scripted.output(),
    /Could not detect this server's public IPv4: the default route has no usable IPv4 address \(no route in tests\)\./u);
  assert.match(scripted.output(), /\[5\/8\] Server public IPv4 for the Pin: /u);
  assert.match(scripted.output(), /\[6\/8\] Where should this server check for updates\?: /u);
  assert.match(scripted.output(), /\[7\/8\] Install updates automatically at night\? \[Y\/n\]: /u);
  assert.match(scripted.output(), /\[8\/8\] Review/u);
  assert.match(scripted.output(), /does not deploy or change a Pin/u);
  assert.match(scripted.output(), /deployment remains a separate confirmed command/u);
});

test("guided production setup preserves current public values and requires confirmation", () => {
  const current = {
    LUMA_PUBLIC_DOMAIN: "center.current.test",
    LUMA_ACME_EMAIL: "acme@current.test",
    LUMA_FIRST_OPERATOR_EMAIL: "owner@current.test",
    LUMA_DEVICE_EDGE_IPV4: "198.51.100.22",
    COMPOSE_PROFILES: "pin,search,spotify",
  };
  const accepted = guidedIo(["", "", "", "", "", "", "", "y"]);
  assert.deepEqual(guidedProductionArguments(current, accepted.io), [
    "--domain", "center.current.test",
    "--acme-email", "acme@current.test",
    "--operator-email", "owner@current.test",
    "--public-ip", "198.51.100.22",
    "--profile", "pin",
    "--profile", "search",
    "--profile", "spotify",
    "--auto-updates", "on",
  ]);

  const cancelled = guidedIo(["", "", "", "", "", "", "", "no"]);
  assert.throws(
    () => guidedProductionArguments(current, cancelled.io),
    /cancelled; no configuration was written/u,
  );
});

test("guided setup accepts a domain typed with capitals and stores it in lowercase", () => {
  const scripted = guidedIo(["Center.Example.TEST", "acme@example.test", "owner@example.test", "none", "", "", "yes"]);
  assert.deepEqual(guidedProductionArguments({}, scripted.io), [
    "--domain", "center.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
    "--no-profiles",
    "--auto-updates", "on",
  ]);
  assert.doesNotMatch(scripted.output(), /Enter a public DNS name/u);
  assert.match(scripted.output(), /Center: https:\/\/center\.example\.test\n/u);
});

test("guided setup re-asks an example-domain certificate email instead of refusing it after the review", () => {
  const scripted = guidedIo([
    "center.example.test", "acme@example.com", "acme@mail.example.org", "acme@example.test",
    "owner@example.test", "none", "", "", "yes",
  ]);
  assert.deepEqual(guidedProductionArguments({}, scripted.io), [
    "--domain", "center.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
    "--no-profiles",
    "--auto-updates", "on",
  ]);
  const refusals = scripted.output().match(/Enter a real email address\. Let's Encrypt refuses example\.com, example\.net, and example\.org\./gu);
  assert.equal(refusals?.length, 2);
});

test("guided setup offers a free DuckDNS name and points it at the detected address", () => {
  const scripted = guidedIo([
    "", // blank domain: DuckDNS
    "My-Center", // subdomain, lowercased
    "", // accept the detected address for the record
    "duck-secret-token", // hidden token
    "acme@example.test",
    "owner@example.test",
    "", // default features, including pin
    "", // Pin address: the confirmed one
    "", // update source: none offered
    "", // automatic updates: on
    "yes",
  ], reachableNetwork());
  const args = guidedProductionArguments({}, scripted.io);
  assert.deepEqual(args, [
    "--domain", "my-center.duckdns.org",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
    "--public-ip", "203.0.113.10",
    "--profile", "pin",
    "--profile", "search",
    "--profile", "spotify",
    "--auto-updates", "on",
  ]);
  const output = scripted.output();
  assert.match(output, /sign in at https:\/\/www\.duckdns\.org/u);
  assert.match(output, /DuckDNS subdomain \(NAME in NAME\.duckdns\.org\): /u);
  assert.match(output, /Server public IPv4 for my-center\.duckdns\.org \[203\.0\.113\.10\]: /u);
  assert.match(output, /my-center\.duckdns\.org now points at 203\.0\.113\.10\./u);
  assert.match(output, /\[5\/8\] Server public IPv4 for the Pin \[203\.0\.113\.10\]: /u);
  assert.match(output, /Center: https:\/\/my-center\.duckdns\.org\n/u);
  // The token is typed hidden, sent once in the DuckDNS query, and never shown.
  assert.deepEqual(scripted.hidden, ["\n  DuckDNS token (not shown, not stored): "]);
  assert.doesNotMatch(output, /duck-secret-token/u);
  assert.deepEqual(scripted.requests, [
    "https://api.ipify.org",
    "https://www.duckdns.org/update?domains=my-center&token=duck-secret-token&ip=203.0.113.10&verbose=true",
  ]);
});

test("guided setup ends with the fix when DuckDNS refuses, and never repeats the token", () => {
  const refused = guidedIo(["duckdns", "-bad-", "my-center", "", "wrong-token-value"], reachableNetwork());
  assert.throws(() => guidedProductionArguments({}, refused.io), (error) => {
    assert.match(error.message,
      /DuckDNS refused to point my-center\.duckdns\.org at 203\.0\.113\.10: the token is wrong or my-center is not one of your DuckDNS domains\. Sign in at https:\/\/www\.duckdns\.org/u);
    assert.doesNotMatch(error.message, /wrong-token-value/u);
    return true;
  });
  assert.match(refused.output(), /Use letters, digits and hyphens only, such as my-center\./u);
  assert.doesNotMatch(refused.output(), /wrong-token-value/u);
  assert.equal(refused.requests.length, 2);

  const unreachable = guidedIo(["", "my-center", "203.0.113.10", "duck-secret-token"]);
  assert.throws(() => guidedProductionArguments({}, unreachable.io),
    /DuckDNS could not be reached \(ENETUNREACH\); check that this server can reach https:\/\/www\.duckdns\.org/u);
});

test("guided setup offers no Pin address when the route and the echo disagree or detection fails", () => {
  const nat = guidedIo(["c.test", "a@example.test", "o@example.test", "pin", "198.51.100.7", "", "", "yes"],
    reachableNetwork({ address: "10.0.0.5", seen: "203.0.113.10" }));
  assert.deepEqual(guidedProductionArguments({}, nat.io), [
    "--domain", "c.test",
    "--acme-email", "a@example.test",
    "--operator-email", "o@example.test",
    "--public-ip", "198.51.100.7",
    "--profile", "pin",
    "--auto-updates", "on",
  ]);
  assert.match(nat.output(),
    /Could not detect this server's public IPv4: this server's own address 10\.0\.0\.5 differs from the address the internet sees \(203\.0\.113\.10\), so it is probably behind NAT/u);
  assert.match(nat.output(), /\[5\/8\] Server public IPv4 for the Pin: /u);
  assert.deepEqual(nat.requests, ["https://api.ipify.org"]);

  const offline = guidedIo(["c.test", "a@example.test", "o@example.test", "pin", "198.51.100.7", "", "", "yes"],
    { routeAddress: () => "203.0.113.10" });
  guidedProductionArguments({}, offline.io);
  assert.match(offline.output(),
    /Could not detect this server's public IPv4: https:\/\/api\.ipify\.org could not be reached \(ENETUNREACH\)\./u);

  // A saved address is offered as before, without any detection.
  const saved = guidedIo(["c.test", "a@example.test", "o@example.test", "pin", "", "", "", "yes"], reachableNetwork());
  assert.ok(guidedProductionArguments({ LUMA_DEVICE_EDGE_IPV4: "198.51.100.22" }, saved.io).includes("198.51.100.22"));
  assert.deepEqual(saved.requests, []);
});

test("guided setup asks for the Pin archive when nothing is staged", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "luma-guided-archive-"));
  const archive = path.join(directory, "luma-pin-2026-09-24.1.tar.gz");
  fs.writeFileSync(archive, "signed pin archive\n");
  const scripted = guidedIo([
    "center.example.test",
    "acme@example.test",
    "owner@example.test",
    "",
    "203.0.113.10",
    archive,
    "",
    "",
    "yes",
  ]);
  const args = guidedProductionArguments({}, scripted.io, { pinReleaseStaged: false });
  assert.deepEqual(args, [
    "--domain", "center.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
    "--public-ip", "203.0.113.10",
    "--profile", "pin",
    "--profile", "search",
    "--profile", "spotify",
    "--pin-release-archive", archive,
    "--auto-updates", "on",
  ]);
  const output = scripted.output();
  for (const stage of ["[1/8]", "[2/8]", "[3/8]", "[4/8]", "[5/8]", "[6/8]", "[7/8]", "[8/8]"]) {
    assert.match(output, new RegExp(`${stage.replace(/[/[\]]/gu, "\\$&")} `, "u"));
  }
  assert.match(output, /\n  Path to this release's Pin archive/u);
  assert.match(output, /\[8\/8\] Review/u);
  assert.doesNotMatch(output, /\[[0-9]\/[0-79]\]/u);
  assert.match(output, new RegExp(`Pin release archive: ${archive.replaceAll(".", "\\.")}`, "u"));
  fs.rmSync(directory, { recursive: true, force: true });
});

test("guided setup continues without an archive and re-asks a missing path", () => {
  const without = guidedIo(["c.test", "a@example.test", "o@example.test", "none", "", "", "yes"]);
  assert.deepEqual(guidedProductionArguments({}, without.io, { pinReleaseStaged: false }), [
    "--domain", "c.test",
    "--acme-email", "a@example.test",
    "--operator-email", "o@example.test",
    "--no-profiles",
    "--auto-updates", "on",
  ]);
  assert.doesNotMatch(without.output(), /Pin release archive:/u);

  const reasked = guidedIo([
    "c.test", "a@example.test", "o@example.test", "pin", "203.0.113.10", "/nonexistent/luma-pin.tar.gz", "", "", "", "no",
  ]);
  assert.throws(
    () => guidedProductionArguments({}, reasked.io, { pinReleaseStaged: false }),
    /cancelled; no configuration was written/u,
  );
  assert.match(reasked.output(),
    /Enter the path to this release's luma-pin-\*\.tar\.gz file, or press Enter to continue without one\./u);
});

// Reading process.stdin.isTTY once made the terminal non-blocking, so every
// prompt the owner had not already typed ahead failed with EAGAIN.
test("guided setup waits at each prompt of a real terminal", { skip: !terminalAvailable && "needs python3 with pty" }, (t) => {
  const { env } = fixture(t);
  const run = runOnTerminal(process.execPath, [cli, "setup", "production", "--guided"], [
    "center.example.test",
    "acme@example.test",
    "owner@example.test",
    "search",
    "",
    "",
    "no",
  ], { cwd: root, env });
  assert.doesNotMatch(run.output, /EAGAIN/u);
  assert.match(run.output, /\[4\/8\] Features/u);
  assert.match(run.output, /Center: https:\/\/center\.example\.test/u);
  assert.match(run.output, /cancelled; no configuration was written/u);
  assert.equal(run.status, 1, run.output);
  assert.equal(fs.existsSync(env.LUMA_CONFIG_DIR), false);
});

test("guided setup refuses a noninteractive invocation before creating state", (t) => {
  const { env } = fixture(t);
  const result = invoke(env, "setup", "production", "--guided");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires an interactive terminal/u);
  assert.equal(fs.existsSync(env.LUMA_CONFIG_DIR), false);
  // The Pin archive of a release built on the maintainer's machine passes through.
  const archive = invoke(env, "setup", "production", "--guided", "--pin-release-archive", "/nonexistent/luma-pin.tar.gz");
  assert.equal(archive.status, 1);
  assert.match(archive.stderr, /requires an interactive terminal/u);
  for (const extra of [["--pin-release-archive"], ["--profile", "pin"]]) {
    assert.equal(invoke(env, "setup", "production", "--guided", ...extra).status, 64, extra.join(" "));
  }
  assert.equal(fs.existsSync(env.LUMA_CONFIG_DIR), false);
});

test("production commands before setup name the path they checked and setup as the next step", (t) => {
  const { env, temporary } = fixture(t);
  const setupNext = 'To set up this server, run ./luma setup production --domain HOST ' +
    '--acme-email EMAIL --operator-email EMAIL ... (README "Get Luma")\n';
  for (const args of [["doctor", "production"], ["deploy", "production", "--dry-run"], ["verify", "production"]]) {
    const result = invoke(env, ...args);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(
      result.stderr,
      `error: no production configuration at ${env.LUMA_ENV_FILE}, where this shell's LUMA_CONFIG_DIR, ` +
        'LUMA_SECRETS_DIR, LUMA_ENV_FILE, LUMA_DATA_DIR, LUMA_BUILD_DIR point; give them the values this server ' +
        `was set up with. ${setupNext}`,
      args.join(" "),
    );
  }
  assert.equal(fs.existsSync(env.LUMA_CONFIG_DIR), false);

  // A shell without the variables a server was set up with looks in the
  // defaults and says how to point it at the server's own directories.
  const shell = Object.fromEntries(Object.entries(env).filter(([name]) => !/^LUMA_/u.test(name)));
  const defaults = {
    ...shell,
    XDG_CONFIG_HOME: path.join(temporary, "xdg-config"),
    XDG_DATA_HOME: path.join(temporary, "xdg-data"),
  };
  const doctor = invoke(defaults, "doctor", "production");
  assert.equal(doctor.status, 1);
  assert.equal(
    doctor.stderr,
    `error: no production configuration at ${path.join(temporary, "xdg-config", "luma", "secrets", "runtime.env")}, ` +
      'the default location; if this server was set up with LUMA_CONFIG_DIR and LUMA_DATA_DIR, export the same ' +
      `values in this shell (README "Configuration"). ${setupNext}`,
  );
  const backup = invoke(defaults, "backup", "production");
  assert.equal(backup.status, 1);
  assert.match(backup.stderr, /^error: backup stopped: no production configuration at .+, the default location; /u);
  const status = invoke(defaults, "setup", "status");
  assert.match(status.stdout, /^FAIL nothing is set up yet\.\n {5}no Luma configuration at .+, the default location; /u);
  assert.deepEqual(fs.readdirSync(temporary), [], "nothing before setup creates configuration");
});

test("production setup outside the defaults prints the line that finds it again", (t) => {
  const { env } = fixture(t);
  const setup = invoke(
    env,
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
  );
  assert.equal(setup.status, 0, setup.stderr);
  const exported = /^ {2}export (.+)$/mu.exec(setup.stdout)?.[1];
  assert.ok(exported, setup.stdout);
  const variables = Object.fromEntries(exported.split(" ").map((entry) => entry.split("=")));
  const shell = Object.fromEntries(Object.entries(env).filter(([name]) => !/^LUMA_/u.test(name)));
  const status = invoke({ ...shell, ...variables }, "setup", "status");
  assert.equal(status.status, 0, status.stdout);
  assert.match(status.stdout, /^PASS production setup is ready\.$/mu);
  assert.match(setup.stdout, /^NEXT \.\/luma doctor production \(public images need no registry login; a private fork first runs \.\/luma registry login --username GITHUB_USER\)$/mu);
});

test("local doctor reports a misplaced build directory and writes nothing", (t) => {
  const { env, temporary } = fixture(t);
  const result = invoke(env, "doctor");
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /Docker Compose 2\.34\.0 or newer is required/u,
    "before init Compose is read through the owner's own Docker configuration");
  const misplaced = invoke({ ...env, LUMA_BUILD_DIR: path.join(temporary, "elsewhere") }, "doctor");
  assert.equal(misplaced.status, 1);
  assert.match(misplaced.stdout, /^FAIL LUMA_BUILD_DIR \(.+\) is not inside LUMA_DATA_DIR/mu);
  assert.match(misplaced.stdout, /^NEXT Unset LUMA_BUILD_DIR, or point it at a path inside LUMA_DATA_DIR\.$/mu);
  assert.doesNotMatch(misplaced.stderr, /\n\s+at /u, "no stack trace");
  assert.deepEqual(fs.readdirSync(temporary), [], "doctor creates nothing");
});

test("an unexpected CLI failure is one error line, not a stack trace", () => {
  const result = spawnSync(process.execPath, ["-e", `
    const { runTimedBoundary } = require(${JSON.stringify(path.join(root, "platform/cli/timing.js"))});
    runTimedBoundary(() => { throw new Error("refusing to modify an unmanaged directory: /example"); });
  `], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "error: refusing to modify an unmanaged directory: /example\n");
});

test("only a stack that can enroll a Pin warns about its empty DeviceUser CA", (t) => {
  const contributor = fixture(t);
  const quiet = invoke(contributor.env, "setup", "contributor");
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stderr, /DeviceUser CA/u);
  assert.doesNotMatch(quiet.stdout, /\[implemented\]/u);
  const local = fixture(t);
  const warned = invoke(local.env, "setup", "local");
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /DeviceUser CA is empty, so this local stack cannot enroll a Pin/u);
  assert.match(warned.stderr, /README\.md#for-developers/u);
});

test("local setup creates real external configuration and status derives from it", (t) => {
  const { env } = fixture(t);
  const setup = invoke(env, "setup", "local");
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /NEXT \.\/luma doctor/u);
  assert.equal(fs.statSync(env.LUMA_ENV_FILE).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(env.LUMA_STATE_DIR), false, "setup keeps no progress state");

  const status = invoke(env, "setup", "status", "--json");
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), {
    schemaVersion: 4,
    contract: { id: "operator-setup", version: "2.4.0", journey: "local" },
    state: "local-ready",
    mode: "local",
    ok: true,
    nextCommandId: "doctor.local",
    next: "./luma doctor",
    release: { operator: { version: "0.1.0-dev", revision: "source" }, pin: null },
  });

  fs.unlinkSync(env.LUMA_ENV_FILE);
  const changed = invoke(env, "setup", "status", "--json");
  assert.equal(changed.status, 1);
  assert.deepEqual(JSON.parse(changed.stdout), {
    schemaVersion: 4,
    contract: { id: "operator-setup", version: "2.4.0", journey: "production" },
    state: "uninitialized",
    mode: "uninitialized",
    ok: false,
    nextCommandId: null,
    next: "./luma setup contributor or ./luma setup local",
    release: { operator: { version: "0.1.0-dev", revision: "source" }, pin: null },
  });
});

test("production setup creates a complete portable operator installation and is idempotent", (t) => {
  const { env } = fixture(t);
  const args = [
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
    "--profile", "search",
    "--profile", "observability",
  ];
  const first = invoke(env, ...args);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Production configuration is ready for https:\/\/pin\.example\.test/u);

  const runtime = parseEnv(env.LUMA_ENV_FILE);
  assert.equal(runtime.LUMA_PUBLIC_ORIGIN, "https://pin.example.test");
  assert.equal(runtime.COSMOS_OIDC_ISSUER, "https://pin.example.test/realms/humane");
  assert.equal(runtime.COMPOSE_PROFILES, "observability,search");
  assert.equal(Object.hasOwn(runtime, "COSMOS_ENROLLMENT_PINCODE"), false, "the deployment holds no Pin passcode");
  assert.equal(runtime.LUMA_FIRST_OPERATOR_EMAIL, "owner@example.test");
  assert.equal(Object.hasOwn(runtime, "LUMA_FIRST_OPERATOR_PASSWORD"), false);

  const production = path.join(env.LUMA_CONFIG_DIR, "production");
  const operatorCompose = path.join(production, "operator.compose.yaml");
  const realmFile = path.join(production, "realm.json");
  const protectedFiles = [operatorCompose, path.join(production, "first-login.txt")];
  const containerFiles = [
    path.join(production, "traefik.yaml"),
    path.join(production, "traefik-dynamic.yaml"),
    path.join(production, "postgres-init.sql"),
    realmFile,
    path.join(production, "searxng-settings.yml"),
    path.join(production, "prometheus.yml"),
  ];
  for (const file of protectedFiles) {
    assert.ok(fs.statSync(file).size > 0, `${file} must be nonempty`);
    assert.equal(fs.statSync(file).mode & 0o077, 0, `${file} must be operator-only`);
  }
  for (const file of containerFiles) assert.equal(fs.statSync(file).mode & 0o777, 0o444, file);
  assert.equal(fs.statSync(production).mode & 0o777, 0o700);

  const realm = JSON.parse(fs.readFileSync(realmFile, "utf8"));
  assert.equal(realm.realm, "humane");
  assert.equal(realm.loginTheme, "luma");
  assert.equal(realm.users[0].id, runtime.LUMA_FIRST_OPERATOR_ID);
  assert.equal(realm.clients[0].directAccessGrantsEnabled, true);
  assert.deepEqual(realm.users[0].requiredActions, []);
  assert.equal(realm.users[0].credentials[0].temporary, false);
  assert.ok(realm.users[0].credentials[0].value.length >= 24);
  assert.deepEqual(realm.users[0].realmRoles, ["default-roles-humane", "cosmos-operator"]);
  const loginHandoff = fs.readFileSync(path.join(production, "first-login.txt"), "utf8");
  assert.match(
    loginHandoff,
    /^Guided setup: https:\/\/pin\.example\.test\/login\?next=%2Fsettings%2Fpin%2Fsetup$/m,
  );
  assert.match(loginHandoff, new RegExp(`^Initial password: ${realm.users[0].credentials[0].value}$`, "m"));
  assert.match(
    first.stdout,
    /After deployment: https:\/\/pin\.example\.test\/login\?next=%2Fsettings%2Fpin%2Fsetup/u,
  );
  assert.match(fs.readFileSync(path.join(root, "center/src/server/auth.ts"), "utf8"), /grant_type: "password"/u);
  assert.match(fs.readFileSync(path.join(production, "traefik-dynamic.yaml"), "utf8"), /pin\.example\.test/u);
  const operatorModel = fs.readFileSync(operatorCompose, "utf8");
  assert.doesNotMatch(operatorModel, /container-inputs|spotify-token|edge-server|pin-releases/u);
  assert.match(operatorModel, /searxng-settings|prometheus/u);
  assert.doesNotMatch(operatorModel, /center\.andersmadsen\.dk|\/home\/anders\/carry/u);
  assert.equal(fs.existsSync(path.join(production, "container-inputs")), false);
  assert.equal(fs.existsSync(path.join(env.LUMA_DATA_DIR, "pin-releases")), false);
  assert.equal(fs.existsSync(path.join(env.LUMA_SECRETS_DIR, "pki")), false);
  assert.equal(fs.existsSync(env.LUMA_STATE_DIR), false);

  const preserved = {
    realm: fs.readFileSync(realmFile, "utf8"),
  };
  fs.unlinkSync(path.join(production, "first-login.txt"));
  const rerun = invoke(env, "setup", "production");
  assert.equal(rerun.status, 0, rerun.stderr);
  const after = parseEnv(env.LUMA_ENV_FILE);
  assert.equal(Object.hasOwn(after, "LUMA_FIRST_OPERATOR_PASSWORD"), false);
  assert.equal(fs.readFileSync(realmFile, "utf8"), preserved.realm);
  assert.equal(fs.existsSync(path.join(production, "first-login.txt")), false);

  const status = invoke(env, "setup", "status", "--json");
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), {
    schemaVersion: 4,
    contract: { id: "operator-setup", version: "2.4.0", journey: "production" },
    state: "production-ready",
    mode: "production",
    ok: true,
    nextCommandId: "doctor.production",
    next: "./luma doctor production",
    release: { operator: { version: "0.1.0-dev", revision: "source" }, pin: null },
  });
});

test("source checkout validates every pin option before rejecting unbound production setup", (t) => {
  const { env } = fixture(t);
  const common = [
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
    "--profile", "pin",
  ];
  const missing = invoke(env, ...common);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /pin profile requires --public-ip/u);
  assert.equal(fs.existsSync(env.LUMA_CONFIG_DIR), false, "invalid setup must not create partial state");

  const setup = invoke(env, ...common, "--public-ip", "203.0.113.42");
  assert.equal(setup.status, 1);
  assert.match(setup.stderr, /must run from an extracted operator release \(luma-operator-VERSION\/, README "Get Luma"\), not a source checkout/u);
  assert.equal(fs.existsSync(env.LUMA_CONFIG_DIR), false, "unbound release rejection must be read-only");
});

test("core setup omits optional state and --no-profiles clears active profiles", (t) => {
  const { env } = fixture(t);
  const common = [
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
  ];
  const core = invoke(env, ...common);
  assert.equal(core.status, 0, core.stderr);
  let runtime = parseEnv(env.LUMA_ENV_FILE);
  assert.equal(runtime.COMPOSE_PROFILES, "");
  assert.equal(runtime.GRAFANA_ADMIN_PASSWORD, "");
  assert.equal(runtime.SEARXNG_SECRET, "");
  assert.equal(runtime.COSMOS_OPAQUE_SEED, "");
  const production = path.join(env.LUMA_CONFIG_DIR, "production");
  for (const name of ["envoy.yaml", "spotify-token", "searxng-settings.yml", "prometheus.yml", "grafana"]) {
    assert.equal(fs.existsSync(path.join(production, name)), false, name);
  }

  const search = invoke(env, ...common, "--profile", "search");
  assert.equal(search.status, 0, search.stderr);
  assert.equal(parseEnv(env.LUMA_ENV_FILE).COMPOSE_PROFILES, "search");
  const cleared = invoke(env, "setup", "production", "--no-profiles");
  assert.equal(cleared.status, 0, cleared.stderr);
  runtime = parseEnv(env.LUMA_ENV_FILE);
  assert.equal(runtime.COMPOSE_PROFILES, "");
  assert.equal(runtime.COSMOS_SEARXNG_BASE_URL, "");
  assert.doesNotMatch(fs.readFileSync(path.join(production, "operator.compose.yaml"), "utf8"), /searxng/u);

  // One update command serves every server: without the pin profile the Pin
  // archive is not needed, and setup says it did not read it.
  const archive = invoke(env, "setup", "production", "--pin-release-archive", "/nonexistent/luma-pin.tar.gz");
  assert.equal(archive.status, 0, archive.stderr);
  assert.match(archive.stdout,
    /The pin profile is off, so --pin-release-archive was not needed and \/nonexistent\/luma-pin\.tar\.gz was not read\./u);

  const spotifyWithoutPin = invoke(env, "setup", "production", "--profile", "spotify");
  assert.equal(spotifyWithoutPin.status, 1);
  assert.match(spotifyWithoutPin.stderr, /spotify profile requires the pin profile/u);
});

test("setup records where the server gets updates and whether it installs them, and Center receives both", (t) => {
  const { env } = fixture(t);
  const common = [
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
  ];
  // A new server installs updates at night. A source checkout names no update
  // source of its own and installs no timers.
  const first = invoke(env, ...common);
  assert.equal(first.status, 0, first.stderr);
  let runtime = parseEnv(env.LUMA_ENV_FILE);
  assert.equal(runtime.LUMA_UPDATE_SOURCE, "");
  assert.equal(runtime.LUMA_AUTO_UPDATES, "on");
  assert.match(first.stdout, /^This is a source checkout, so no update timers were installed\.$/mu);

  const chosen = invoke(env, "setup", "production", "--update-source", "https://updates.example.test/", "--auto-updates", "off");
  assert.equal(chosen.status, 0, chosen.stderr);
  runtime = parseEnv(env.LUMA_ENV_FILE);
  assert.equal(runtime.LUMA_UPDATE_SOURCE, "https://updates.example.test");
  assert.equal(runtime.LUMA_AUTO_UPDATES, "off");
  assert.match(chosen.stdout, /^Updates: this server asks https:\/\/updates\.example\.test for newer releases\.$/mu);
  // A rerun keeps both.
  assert.equal(invoke(env, "setup", "production").status, 0);
  runtime = parseEnv(env.LUMA_ENV_FILE);
  assert.equal(runtime.LUMA_UPDATE_SOURCE, "https://updates.example.test");
  assert.equal(runtime.LUMA_AUTO_UPDATES, "off");

  for (const [flag, value, message] of [
    ["--update-source", "https://updates.example.test/releases", /--update-source must be an https origin/u],
    ["--update-source", "http://updates.example.test", /--update-source must be an https origin/u],
    ["--auto-updates", "nightly", /--auto-updates must be on or off/u],
  ]) {
    const refused = invoke(env, "setup", "production", flag, value);
    assert.equal(refused.status, 1, `${flag} ${value}`);
    assert.match(refused.stderr, message);
  }
  assert.equal(parseEnv(env.LUMA_ENV_FILE).LUMA_UPDATE_SOURCE, "https://updates.example.test");

  // A server set up before automatic updates existed keeps updating by hand.
  fs.writeFileSync(env.LUMA_ENV_FILE,
    fs.readFileSync(env.LUMA_ENV_FILE, "utf8").replace(/^LUMA_AUTO_UPDATES=.*\n/mu, ""), { mode: 0o600 });
  assert.equal(invoke(env, "setup", "production").status, 0);
  assert.equal(parseEnv(env.LUMA_ENV_FILE).LUMA_AUTO_UPDATES, "off");

  assert.equal(invoke(env, "setup", "production", "--auto-updates", "on").status, 0);
  const model = productionComposeModel(env);
  if (model) {
    const center = model.services.center;
    assert.equal(center.environment.LUMA_UPDATE_SOURCE, "https://updates.example.test");
    assert.equal(center.environment.LUMA_AUTO_UPDATES, "on");
    assert.equal(center.environment.LUMA_UPDATE_STATUS_FILE, "/luma-updates/status.json");
    for (const name of ["LUMA_RELEASE_VERSION", "LUMA_RELEASE_TAG", "LUMA_PIN_RELEASE_VERSION",
      "LUMA_PIN_RELEASE_VERSION_CODE", "LUMA_RELEASE_NOTES", "LUMA_RELEASE_PUBLISHED_AT"]) {
      assert.ok(Object.hasOwn(center.environment, name), name);
    }
    const mount = center.volumes.find((volume) => volume.target === "/luma-updates");
    assert.equal(mount.source, path.join(env.LUMA_DATA_DIR, "updates"));
    assert.equal(mount.read_only, true);
  }
});

// Production setup with the network replaced: the default route's address,
// one echo answer, DuckDNS's answer, and the token read from stdin.
function setupWithNetwork(env, network, ...args) {
  const program = `
    const { setupProduction } = require(${JSON.stringify(path.join(root, "platform/cli/production-setup.js"))});
    const network = ${JSON.stringify(network)};
    const requests = [];
    try {
      setupProduction(process.argv.slice(1), {
        routeAddress() {
          if (!network.route) throw new Error("no default IPv4 route");
          return network.route;
        },
        fetchText(url) {
          requests.push(url);
          if (url === "https://api.ipify.org") return { status: 200, body: network.seen + "\\n" };
          const token = new URL(url).searchParams.get("token");
          return { status: 200, body: token === network.token ? "OK\\n" + network.seen + "\\nUPDATED" : "KO" };
        },
        secretFromStdin() { return network.typed; },
      });
    } catch (error) {
      process.stderr.write(error.message);
      process.exitCode = 1;
    } finally {
      process.stdout.write("\\nrequests " + JSON.stringify(requests));
    }
  `;
  return spawnSync(process.execPath, ["-e", program, "--", ...args], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
}

test("setup production takes a DuckDNS name and an auto-detected address without prompts", (t) => {
  const { env } = fixture(t);
  const common = ["--acme-email", "acme@example.test", "--operator-email", "owner@example.test"];
  const reachable = { route: "203.0.113.10", seen: "203.0.113.10", token: "duck-secret-token", typed: "duck-secret-token" };

  // Usage: the DuckDNS flags come together and replace --domain.
  for (const wrong of [
    ["--duckdns-subdomain", "my-center"],
    ["--duckdns-token-stdin"],
    ["--domain", "c.test", "--duckdns-subdomain", "my-center", "--duckdns-token-stdin"],
  ]) {
    const usage = invoke(env, "setup", "production", ...wrong, ...common);
    assert.equal(usage.status, 64, wrong.join(" "));
    assert.match(usage.stderr, /--duckdns-subdomain NAME --duckdns-token-stdin/u);
  }
  const label = invoke(env, "setup", "production", "--duckdns-subdomain", "my.center", "--duckdns-token-stdin", ...common);
  assert.equal(label.status, 1);
  assert.match(label.stderr, /--duckdns-subdomain must be one DNS label of letters, digits and hyphens/u);
  const address = invoke(env, "setup", "production", "--domain", "c.test", "--public-ip", "nope", ...common);
  assert.match(address.stderr, /--public-ip must be an IPv4 address or auto/u);
  assert.equal(fs.existsSync(env.LUMA_CONFIG_DIR), false, "no state before a valid command");

  // A failed detection stops before any write and names the fix.
  const nat = setupWithNetwork(env, { ...reachable, route: "10.0.0.5" }, "--domain", "c.test", "--public-ip", "auto", ...common);
  assert.equal(nat.status, 1);
  assert.match(nat.stderr, /could not detect this server's public IPv4: this server's own address 10\.0\.0\.5 differs from the address the internet sees \(203\.0\.113\.10\).*pass --public-ip IPV4 instead/u);
  assert.equal(fs.existsSync(env.LUMA_CONFIG_DIR), false);

  // A refused token stops before any write and never repeats it.
  const refused = setupWithNetwork(env, { ...reachable, typed: "wrong-token-value" },
    "--duckdns-subdomain", "My-Center", "--duckdns-token-stdin", ...common);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /DuckDNS refused to point my-center\.duckdns\.org at 203\.0\.113\.10/u);
  // stdout carries only the fixture's own request log.
  assert.doesNotMatch(refused.stderr, /wrong-token-value/u);
  assert.equal(fs.existsSync(env.LUMA_CONFIG_DIR), false);

  // The record is set once, from the detected address, and the name is the domain.
  const setup = setupWithNetwork(env, reachable, "--duckdns-subdomain", "My-Center", "--duckdns-token-stdin", ...common);
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /my-center\.duckdns\.org now points at 203\.0\.113\.10\./u);
  assert.match(setup.stdout, /requests \["https:\/\/api\.ipify\.org","https:\/\/www\.duckdns\.org\/update\?domains=my-center&token=duck-secret-token&ip=203\.0\.113\.10&verbose=true"\]/u);
  const runtime = parseEnv(env.LUMA_ENV_FILE);
  assert.equal(runtime.LUMA_PUBLIC_DOMAIN, "my-center.duckdns.org");
  assert.equal(runtime.LUMA_PUBLIC_ORIGIN, "https://my-center.duckdns.org");
  // Nothing on the server keeps the token.
  const written = [env.LUMA_ENV_FILE, path.join(env.LUMA_CONFIG_DIR, "production", "operator.compose.yaml")]
    .map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(written, /duck-secret-token/u);

  // A rerun without the DuckDNS flags keeps the name and makes no request.
  const rerun = setupWithNetwork(env, reachable, "--profile", "search");
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /requests \[\]/u);
  assert.equal(parseEnv(env.LUMA_ENV_FILE).LUMA_PUBLIC_DOMAIN, "my-center.duckdns.org");
});

test("production setup resumes from a first-login handoff written before the realm", (t) => {
  const { env } = fixture(t);
  const args = [
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
  ];
  const first = invoke(env, ...args);
  assert.equal(first.status, 0, first.stderr);
  const production = path.join(env.LUMA_CONFIG_DIR, "production");
  const realmFile = path.join(production, "realm.json");
  const password = JSON.parse(fs.readFileSync(realmFile, "utf8")).users[0].credentials[0].value;
  fs.unlinkSync(realmFile);

  const resumed = invoke(env, "setup", "production");
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(fs.readFileSync(realmFile, "utf8")).users[0].credentials[0].value, password);
});

test("setup corrects a mistyped domain or owner email until the first deploy", (t) => {
  const { env } = fixture(t);
  const setup = invoke(
    env,
    "setup", "production",
    "--domain", "centr.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "ownr@example.test",
  );
  assert.equal(setup.status, 0, setup.stderr);
  const production = path.join(env.LUMA_CONFIG_DIR, "production");
  const realmFile = path.join(production, "realm.json");
  const handoff = path.join(production, "first-login.txt");
  const before = JSON.parse(fs.readFileSync(realmFile, "utf8"));
  const password = before.users[0].credentials[0].value;

  const corrected = setupWithVolumes(env, [], "--domain", "center.example.test", "--operator-email", "owner@example.test");
  assert.equal(corrected.status, 0, corrected.stderr);
  const realm = JSON.parse(fs.readFileSync(realmFile, "utf8"));
  assert.deepEqual(realm.clients[0].webOrigins, ["https://center.example.test"]);
  assert.deepEqual(realm.clients[0].redirectUris, ["https://center.example.test/api/auth/callback/humane"]);
  assert.equal(realm.clients[0].attributes["post.logout.redirect.uris"], "https://center.example.test/login");
  assert.equal(realm.users[0].email, "owner@example.test");
  assert.equal(realm.users[0].username, "owner@example.test");
  assert.equal(realm.users[0].credentials[0].value, password, "the handed-off password stays valid");
  assert.equal(realm.users[0].id, before.users[0].id);
  assert.equal(realm.clients[0].secret, before.clients[0].secret);
  const login = fs.readFileSync(handoff, "utf8");
  assert.match(login, /^Center: https:\/\/center\.example\.test$/mu);
  assert.match(login, /^Operator: owner@example\.test$/mu);
  assert.match(login, new RegExp(`^Initial password: ${password}$`, "mu"));
  assert.equal(fs.statSync(handoff).mode & 0o777, 0o600);
  const runtime = parseEnv(env.LUMA_ENV_FILE);
  assert.equal(runtime.LUMA_PUBLIC_DOMAIN, "center.example.test");
  assert.equal(runtime.COSMOS_OIDC_ISSUER, "https://center.example.test/realms/humane");
  assert.equal(runtime.COSMOS_OPERATOR_EMAILS, "owner@example.test");
  const edge = fs.readFileSync(path.join(production, "traefik-dynamic.yaml"), "utf8");
  assert.match(edge, /center\.example\.test/u);
  assert.doesNotMatch(edge, /centr\.example\.test/u);

  // The same rerun is idempotent, and a consumed handoff is not recreated.
  fs.unlinkSync(handoff);
  const again = setupWithVolumes(env, [], "--domain", "center.example.test");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.existsSync(handoff), false);
});

test("a deployed server keeps its domain and owner email and names the way back", (t) => {
  const { env } = fixture(t);
  const setup = invoke(
    env,
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
  );
  assert.equal(setup.status, 0, setup.stderr);
  const realmFile = path.join(env.LUMA_CONFIG_DIR, "production", "realm.json");
  const before = { runtime: fs.readFileSync(env.LUMA_ENV_FILE, "utf8"), realm: fs.readFileSync(realmFile, "utf8") };
  const unchanged = () => {
    assert.equal(fs.readFileSync(env.LUMA_ENV_FILE, "utf8"), before.runtime);
    assert.equal(fs.readFileSync(realmFile, "utf8"), before.realm);
  };

  const deployed = setupWithVolumes(env, ["luma_cosmos-pgdata"], "--domain", "other.example.test");
  assert.equal(deployed.status, 1);
  assert.match(deployed.stderr, /the public domain \(pin\.example\.test → other\.example\.test\)/u);
  assert.match(deployed.stderr, /already been deployed \(Docker volume luma_cosmos-pgdata\)/u);
  assert.match(deployed.stderr, /rerun setup without --domain \(or with --domain pin\.example\.test\)/u);
  assert.doesNotMatch(deployed.stderr, /Migrate identity/u);
  unchanged();

  const unknown = setupWithVolumes(env, null, "--operator-email", "other@example.test");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /the owner email \(owner@example\.test → other@example\.test\)/u);
  assert.match(unknown.stderr, /Start Docker/u);
  unchanged();

  // The generated Keycloak client never changes. A runtime.env from another
  // setup is refused whatever Docker says.
  fs.writeFileSync(env.LUMA_ENV_FILE,
    before.runtime.replace(/^KEYCLOAK_CLIENT_SECRET=.*$/mu, `KEYCLOAK_CLIENT_SECRET=${"z".repeat(48)}`));
  const mixed = invoke(env, "setup", "production");
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /come from different setups; restore both from one backup/u);
  assert.equal(fs.readFileSync(realmFile, "utf8"), before.realm);
});

test("production setup accepts configuration directories whose path has a space", (t) => {
  const { env } = fixture(t, { prefix: "luma setup " });
  const setup = invoke(
    env,
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
    "--profile", "search",
  );
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(invoke(env, "setup", "status", "--json").status, 0);
});

test("rerunning setup brings an earlier realm file onto Luma's current realm policy", (t) => {
  const { env } = fixture(t);
  const args = [
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
  ];
  const setup = invoke(env, ...args);
  assert.equal(setup.status, 0, setup.stderr);
  const realmFile = path.join(env.LUMA_CONFIG_DIR, "production", "realm.json");
  const current = fs.readFileSync(realmFile, "utf8");
  // The realm as a release before the user-profile, `basic` scope, and default
  // roles fix wrote it.
  const earlier = JSON.parse(current);
  delete earlier.components;
  earlier.clients[0].defaultClientScopes = earlier.clients[0].defaultClientScopes.filter((scope) => scope !== "basic");
  earlier.users[0].realmRoles = ["cosmos-operator"];
  fs.chmodSync(realmFile, 0o644);
  fs.writeFileSync(realmFile, `${JSON.stringify(earlier, null, 2)}\n`);
  fs.chmodSync(realmFile, 0o444);

  const rerun = invoke(env, ...args);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(fs.readFileSync(realmFile, "utf8"), current, "same inputs and password, current policy");
  assert.equal(fs.statSync(realmFile).mode & 0o777, 0o444);
});

test("source checkout cannot substitute a seeded local release for authenticated release closure", (t) => {
  const { env } = fixture(t);
  const core = invoke(
    env,
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
  );
  assert.equal(core.status, 0, core.stderr);
  const { manifest, release } = seedPinRelease(env);
  const server = manifest.artifacts.find((artifact) => artifact.role === "server");
  fs.writeFileSync(path.join(release, "server.apk"), Buffer.alloc(server.size, 0x78), { mode: 0o600 });
  const setup = invoke(env, "setup", "production", "--profile", "pin", "--public-ip", "203.0.113.42");
  assert.equal(setup.status, 1);
  assert.match(setup.stderr, /must run from an extracted operator release/u);
});

test("production readiness fails when a required generated artifact is missing", (t) => {
  const { env } = fixture(t);
  const setup = invoke(
    env,
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
  );
  assert.equal(setup.status, 0, setup.stderr);
  fs.unlinkSync(path.join(env.LUMA_CONFIG_DIR, "production", "traefik-dynamic.yaml"));

  const status = invoke(env, "setup", "status", "--json");
  assert.equal(status.status, 1);
  const report = JSON.parse(status.stdout);
  assert.equal(report.mode, "production");
  assert.equal(report.state, "production-invalid");
  assert.equal(report.ok, false);
  assert.match(report.problem, /traefik-dynamic\.yaml must be a nonempty regular file/u);

  const doctor = invoke(env, "doctor", "production");
  assert.equal(doctor.status, 1);
  assert.match(doctor.stderr, /production artifacts are not ready/u);
});

// Runs `deploy production` with deploy.sh replaced by a recorder, which captures
// the edge files and operator overlay deploy.sh would find on disk when it starts.
function deployWithRecordedScript(env, ...modes) {
  const production = path.join(env.LUMA_CONFIG_DIR, "production");
  const script = `
const fs = require("node:fs");
const path = require("node:path");
const context = require(${JSON.stringify(path.join(root, "platform/cli/context.js"))});
const calls = [];
context.run = (executable, args, options) => {
  calls.push({
    script: path.basename(args[0]),
    args: args.slice(1),
    confirmed: options.env.LUMA_DEPLOY_CONFIRMED === "1",
    extraNetworks: options.env.LUMA_TRAEFIK_EXTRA_NETWORKS ?? null,
    static: fs.readFileSync(${JSON.stringify(path.join(production, "traefik.yaml"))}, "utf8"),
    dynamic: fs.readFileSync(${JSON.stringify(path.join(production, "traefik-dynamic.yaml"))}, "utf8"),
    overlay: fs.readFileSync(${JSON.stringify(path.join(production, "operator.compose.yaml"))}, "utf8"),
  });
  return { status: 0 };
};
const { deployProduction } = require(${JSON.stringify(path.join(root, "platform/cli/production.js"))});
for (const mode of ${JSON.stringify(modes)}) deployProduction(["production", mode], { throwOnFailure: true });
process.stdout.write(JSON.stringify(calls));
`;
  return spawnSync(process.execPath, ["-e", script], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
}

// Runs doctor and deploy commands with deploy scripts replaced by a recorder
// and reports, per command, its exit code, message, and the scripts it reached.
function recordProductionCommands(env, commands) {
  const script = `
const path = require("node:path");
const context = require(${JSON.stringify(path.join(root, "platform/cli/context.js"))});
const invoked = [];
context.run = (executable, args) => {
  invoked.push(path.basename(args[0]));
  return { status: 0 };
};
const { deployProduction, productionDoctor } = require(${JSON.stringify(path.join(root, "platform/cli/production.js"))});
const results = [];
for (const [command, ...options] of ${JSON.stringify(commands)}) {
  const first = invoked.length;
  try {
    if (command === "doctor") productionDoctor(options, { throwOnFailure: true });
    else deployProduction(["production", ...options], { throwOnFailure: true });
    results.push({ exitCode: 0, message: "", invoked: invoked.slice(first) });
  } catch (error) {
    results.push({ exitCode: error.exitCode ?? 1, message: error.message, invoked: invoked.slice(first) });
  }
}
process.stdout.write(JSON.stringify(results));
`;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("an onboarding stop after a failed deployment script points at the error that script printed", (t) => {
  const { env } = productionInstallation(t);
  const script = `
const context = require(${JSON.stringify(path.join(root, "platform/cli/context.js"))});
context.run = () => ({ status: 1 });
const { productionDoctor } = require(${JSON.stringify(path.join(root, "platform/cli/production.js"))});
const { runProductionOnboarding } = require(${JSON.stringify(path.join(root, "platform/cli/onboard.js"))});
try {
  runProductionOnboarding({
    setup: () => {},
    doctor: () => productionDoctor([], { throwOnFailure: true }),
    write: () => {},
  });
} catch (error) {
  process.stdout.write(error.message);
}
`;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Onboarding stopped during stage 2\/5 \(server checks\)\.$/mu);
  assert.match(result.stdout,
    /^What failed: preflight\.sh stopped with exit status 1; the error printed above says why$/mu);
  assert.match(result.stdout, /^Recovery check: \.\/luma doctor production$/mu);
});

function productionInstallation(t) {
  const { env } = fixture(t);
  const setup = invoke(
    env,
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
  );
  assert.equal(setup.status, 0, setup.stderr);
  setRuntimeValues(env, {
    LUMA_COMPOSE_APPLICATION: `oci://ghcr.io/example/luma/application@sha256:${"a".repeat(64)}`,
  });
  return { env, production: path.join(env.LUMA_CONFIG_DIR, "production") };
}

function setRuntimeValues(env, updates) {
  let runtime = fs.readFileSync(env.LUMA_ENV_FILE, "utf8");
  for (const [name, value] of Object.entries(updates)) {
    const line = `${name}=${value}`;
    const existing = new RegExp(`^${name}=.*$`, "mu");
    runtime = existing.test(runtime)
      ? runtime.replace(existing, () => line)
      : `${runtime.replace(/\n*$/u, "\n")}${line}\n`;
  }
  fs.writeFileSync(env.LUMA_ENV_FILE, runtime);
}

const EXTRA_CERTIFICATES = ["owner/fullchain.pem", "owner/privkey.pem"];

function validTraefikExtra() {
  return {
    http: {
      routers: {
        "extra-owner-api": {
          entryPoints: ["websecure"],
          rule: "Host(`api.owner.example`) || Host(`grpc.owner.example`)",
          service: "extra-owner-api",
          priority: 200,
          tls: {},
        },
        "extra-owner-web": {
          entryPoints: ["websecure"],
          rule: "Host(`web.owner.example`)",
          service: "extra-owner-web",
          tls: { certResolver: "letsencrypt" },
        },
      },
      services: {
        "extra-owner-api": { loadBalancer: { servers: [{ url: "h2c://owner-api:9100" }] } },
        "extra-owner-web": {
          loadBalancer: { servers: [{ url: "http://owner-web:8080" }], passHostHeader: true },
        },
      },
    },
    tls: {
      certificates: [{
        certFile: "/etc/traefik/extra-certs/owner/fullchain.pem",
        keyFile: "/etc/traefik/extra-certs/owner/privkey.pem",
      }],
    },
  };
}

// Writes the owner's extra routes (mode 0644) and certificate tree (0755/0444)
// the way README tells an owner to.
function writeOwnerExtras(production, contents = validTraefikExtra(), mode = 0o644) {
  const certificates = path.join(production, "traefik-extra-certs");
  fs.mkdirSync(path.join(certificates, "owner"), { recursive: true });
  for (const directory of [certificates, path.join(certificates, "owner")]) fs.chmodSync(directory, 0o755);
  for (const name of EXTRA_CERTIFICATES) {
    const file = path.join(certificates, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, `fixture ${name}\n`);
    fs.chmodSync(file, 0o444);
  }
  const file = path.join(production, "traefik-extra.json");
  if (fs.existsSync(file)) fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`);
  fs.chmodSync(file, mode);
  return { file, certificates };
}

function fileIdentity(files) {
  return files.map((file) => {
    const stat = fs.lstatSync(file);
    return {
      file,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      mode: stat.mode,
      bytes: stat.isFile() ? fs.readFileSync(file, "base64") : null,
    };
  });
}

test("owner Traefik extras are mounted, and setup and deploy never write them", (t) => {
  const { env, production } = productionInstallation(t);
  const overlayFile = path.join(production, "operator.compose.yaml");
  const plain = fs.readFileSync(overlayFile, "utf8");
  assert.doesNotMatch(plain, /traefik_extra|extra-certs|^networks:/mu, "no owner files, no extra mounts");
  assert.doesNotMatch(
    fs.readFileSync(path.join(root, "platform/edge/traefik/dynamic.yaml.tpl"), "utf8"),
    /^\s+extra-/mu,
    "Luma's own routers and services never take the owner's extra- names",
  );

  const { file, certificates } = writeOwnerExtras(production);
  setRuntimeValues(env, { LUMA_TRAEFIK_EXTRA_NETWORKS: "owner-apps" });
  const owned = [
    file, certificates, path.join(certificates, "owner"),
    ...EXTRA_CERTIFICATES.map((name) => path.join(certificates, name)),
  ];
  const before = fileIdentity(owned);

  const result = deployWithRecordedScript(env, "--dry-run", "--confirm");
  assert.equal(result.status, 0, result.stderr);
  const [dryRun, confirmed] = JSON.parse(result.stdout);
  assert.equal(dryRun.overlay, plain, "a dry run changes nothing");
  assert.equal(confirmed.extraNetworks, "owner-apps", "preflight receives the network setting");
  const overlay = confirmed.overlay;
  for (const expected of [
    "      - { source: traefik_dynamic, target: /etc/traefik/dynamic/10-luma.yaml }\n" +
      "      - { source: traefik_extra, target: /etc/traefik/dynamic/20-extra.yaml }",
    `  traefik_extra: { file: ${JSON.stringify(file)} }`,
    [
      "    volumes:",
      "      - type: bind",
      `        source: ${JSON.stringify(certificates)}`,
      "        target: /etc/traefik/extra-certs",
      "        read_only: true",
      "        bind: { create_host_path: false }",
    ].join("\n"),
    '    networks:\n      public-edge: { gw_priority: 1 }\n      "owner-apps": {}',
    'networks:\n  "owner-apps": { name: "owner-apps", external: true }\n',
  ]) assert.ok(overlay.includes(expected), `${expected}\n---\n${overlay}`);

  const rerun = invoke(env, "setup", "production");
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(fs.readFileSync(overlayFile, "utf8"), overlay, "setup renders the same mounts as deploy");
  assert.deepEqual(fileIdentity(owned), before, "setup and deploy never write, chmod, or replace owner files");

  const model = productionComposeModel(env);
  if (model) {
    const traefik = model.services.traefik;
    assert.deepEqual(Object.keys(traefik.networks).sort(), ["cosmos-internal", "owner-apps", "public-edge"]);
    assert.equal(traefik.networks["public-edge"].gw_priority, 1);
    const { name, external } = model.networks["owner-apps"];
    assert.deepEqual({ name, external }, { name: "owner-apps", external: true });
    assert.deepEqual(
      traefik.secrets.map((secret) => secret.target).sort(),
      ["/etc/traefik/dynamic/10-luma.yaml", "/etc/traefik/dynamic/20-extra.yaml", "/etc/traefik/traefik.yml"],
    );
    assert.ok(traefik.volumes.some((volume) =>
      volume.type === "bind" && volume.source === certificates &&
      volume.target === "/etc/traefik/extra-certs" && volume.read_only === true));
    assert.equal(model.secrets.traefik_extra.file, file);
  }
});

test("doctor and deploy refuse an unsafe owner Traefik extra before rendering anything", (t) => {
  const { env, production } = productionInstallation(t);
  const commands = [["doctor"], ["deploy", "--dry-run"], ["deploy", "--confirm"]];
  const { file } = writeOwnerExtras(production);
  const accepted = recordProductionCommands(env, commands);
  assert.deepEqual(accepted.map((result) => [result.exitCode, result.invoked]), [
    [0, ["preflight.sh"]], [0, ["deploy.sh"]], [0, ["deploy.sh"]],
  ], JSON.stringify(accepted));

  const rendered = ["traefik.yaml", "traefik-dynamic.yaml", "operator.compose.yaml"]
    .map((name) => path.join(production, name));
  const edit = (change) => {
    const document = validTraefikExtra();
    change(document);
    return document;
  };
  const refusals = [
    ["invalid JSON", '{"http": {"routers": {}', "", /is not valid JSON/u],
    ["a router name without extra-", edit((document) => {
      document.http.routers["owner-api"] = document.http.routers["extra-owner-api"];
      delete document.http.routers["extra-owner-api"];
    }), "http.routers.owner-api", /must be named extra-/u],
    ["a Pin SNI host", edit((document) => {
      document.http.routers["extra-owner-api"].rule = "Host(`api.cosmos.humane.cloud`)";
    }), "http.routers.extra-owner-api.rule", /must not claim api\.cosmos\.humane\.cloud/u],
    ["the Luma domain", edit((document) => {
      document.http.routers["extra-owner-web"].rule = "Host(`web.owner.example`) || Host(`pin.example.test`)";
    }), "http.routers.extra-owner-web.rule", /must not claim pin\.example\.test/u],
    ["the plain-HTTP entry point", edit((document) => {
      document.http.routers["extra-owner-api"].entryPoints = ["web"];
    }), "http.routers.extra-owner-api.entryPoints", /must be exactly \["websecure"\]/u],
    ["an upstream path", edit((document) => {
      document.http.services["extra-owner-web"].loadBalancer.servers[0].url = "http://owner-web:8080/api";
    }), "http.services.extra-owner-web.loadBalancer.servers[0].url", /no path/u],
    ["a ws:// upstream", edit((document) => {
      document.http.services["extra-owner-api"].loadBalancer.servers[0].url = "ws://owner-api:9100";
    }), "http.services.extra-owner-api.loadBalancer.servers[0].url", /h2c:\/\//u],
    ["a Luma service upstream", edit((document) => {
      document.http.services["extra-owner-web"].loadBalancer.servers[0].url = "http://center:4000";
    }), "http.services.extra-owner-web.loadBalancer.servers[0].url",
    /must not target center, which is Luma's own service/u],
    ["a Go template", edit((document) => {
      document.http.routers["extra-owner-web"].rule = 'Host(`{{ env "OWNER_HOST" }}`)';
    }), "", /must not contain "\{\{"/u],
    ["a certificate outside extra-certs", edit((document) => {
      document.tls.certificates[0].certFile = "/etc/ssl/private/owner.pem";
    }), "tls.certificates[0].certFile", /must be a file under \/etc\/traefik\/extra-certs\//u],
    ["mode 0600", validTraefikExtra(), "", /must have mode 0644 or 0444/u, 0o600],
    // A copied router block left under its old name: JSON.parse keeps one,
    // Traefik refuses the file.
    ["a repeated key", JSON.stringify(validTraefikExtra(), null, 2).replace(
      '"routers": {',
      `"routers": {\n"extra-owner-api": ${JSON.stringify(validTraefikExtra().http.routers["extra-owner-api"])},`,
    ), "http.routers.extra-owner-api", /is repeated in its object/u],
    // Valid JSON that Traefik 3.6 refuses as a whole file (checked against
    // the pinned image): its YAML decoder has no `\/` escape, and it rejects
    // an empty section.
    ["a JSON escape", JSON.stringify(validTraefikExtra(), null, 2).replaceAll("/", "\\/"), "",
      /must not contain a backslash/u],
    ["an empty routers section", edit((document) => {
      document.http.routers = {};
    }), "http.routers", /must not be empty/u],
  ];
  for (const [label, contents, keyPath, expected, mode = 0o644] of refusals) {
    writeOwnerExtras(production, contents, mode);
    const before = rendered.map((name) => fs.readFileSync(name));
    const results = recordProductionCommands(env, commands);
    for (const [index, result] of results.entries()) {
      const command = commands[index].join(" ");
      assert.notEqual(result.exitCode, 0, `${label}: ${command} must fail`);
      assert.deepEqual(result.invoked, [], `${label}: ${command} must not reach a deploy script`);
      assert.match(result.message, /production artifacts are not ready/u, label);
      assert.ok(result.message.includes(`${file}: ${keyPath}${keyPath ? " " : ""}`), `${label}: ${result.message}`);
      assert.match(result.message, expected, label);
    }
    assert.deepEqual(rendered.map((name) => fs.readFileSync(name)), before, `${label}: rendered files are untouched`);
  }

  writeOwnerExtras(production, "not json");
  const doctor = invoke(env, "doctor", "production");
  assert.equal(doctor.status, 1);
  assert.ok(doctor.stderr.includes(`${file}: is not valid JSON`), doctor.stderr);
});

// Service keys of a Compose file's top-level `services:` block.
function composeServiceNames(file) {
  const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n");
  const start = lines.indexOf("services:");
  assert.ok(start >= 0, `${file} has a services block`);
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) break;
    const name = /^ {2}([a-z][a-z0-9-]*):/u.exec(line)?.[1];
    if (name) names.push(name);
  }
  return names;
}

test("owner extra routes cannot target Luma's own services", (t) => {
  const { env, production } = productionInstallation(t);
  const services = [...new Set([
    ...composeServiceNames("compose.yaml"),
    ...composeServiceNames("platform/compose/production.yaml"),
  ])].sort();
  assert.ok(services.includes("center") && services.includes("postgres"), services.join());
  const upstreams = [...services, "cosmos-edge", "luma-center-1", "Keycloak", "ai-bus."];
  const document = validTraefikExtra();
  for (const [index, host] of upstreams.entries()) {
    document.http.services[`extra-luma-${index}`] = { loadBalancer: { servers: [{ url: `http://${host}:8080` }] } };
  }
  const { file } = writeOwnerExtras(production, document);
  const [doctor] = recordProductionCommands(env, [["doctor"]]);
  assert.notEqual(doctor.exitCode, 0);
  assert.deepEqual(doctor.invoked, []);
  for (const [index, host] of upstreams.entries()) {
    assert.ok(doctor.message.includes(
      `${file}: http.services.extra-luma-${index}.loadBalancer.servers[0].url must not target ${host}, ` +
        "which is Luma's own service",
    ), `${host} must be refused:\n${doctor.message}`);
  }
  assert.doesNotMatch(doctor.message, /extra-owner-(?:api|web)\.loadBalancer/u, "the owner's own upstreams pass");
});

test("extra Traefik networks render as external networks and Luma's own networks are refused", (t) => {
  const { env, production } = productionInstallation(t);
  setRuntimeValues(env, { LUMA_TRAEFIK_EXTRA_NETWORKS: "owner-apps,owner.net_2" });
  const result = deployWithRecordedScript(env, "--confirm");
  assert.equal(result.status, 0, result.stderr);
  const [confirmed] = JSON.parse(result.stdout);
  assert.ok(confirmed.overlay.includes(
    '    networks:\n      public-edge: { gw_priority: 1 }\n      "owner-apps": {}\n      "owner.net_2": {}\n',
  ), confirmed.overlay);
  assert.ok(confirmed.overlay.endsWith([
    "networks:",
    '  "owner-apps": { name: "owner-apps", external: true }',
    '  "owner.net_2": { name: "owner.net_2", external: true }',
    "",
  ].join("\n")), confirmed.overlay);
  assert.doesNotMatch(confirmed.overlay, /traefik_extra|extra-certs/u, "networks alone mount no owner files");
  const model = productionComposeModel(env);
  if (model) {
    assert.deepEqual(
      Object.keys(model.services.traefik.networks).sort(),
      ["cosmos-internal", "owner-apps", "owner.net_2", "public-edge"],
    );
    const { name, external } = model.networks["owner.net_2"];
    assert.deepEqual({ name, external }, { name: "owner.net_2", external: true });
  }

  const productionModel = fs.readFileSync(path.join(root, "platform/compose/production.yaml"), "utf8");
  const lumaNetworks = [...(/^networks: !override\n((?: {2}.*\n?)+)/mu.exec(productionModel)?.[1] ?? "")
    .matchAll(/^ {2}([A-Za-z0-9._-]+):/gmu)].map((match) => match[1]);
  assert.ok(lumaNetworks.includes("cosmos-internal") && lumaNetworks.includes("public-edge"), lumaNetworks.join());
  const refused = [
    ...lumaNetworks, "host", "none", "bridge", "default", "luma_public-edge",
    "owner apps", "owner-apps,owner-apps", "owner-apps,", "-owner",
  ];
  const script = `
const { renderOperatorConfig } = require(${JSON.stringify(path.join(root, "platform/cli/production-setup.js"))});
const values = { LUMA_ACME_EMAIL: "acme@example.test", LUMA_PUBLIC_DOMAIN: "pin.example.test", COMPOSE_PROFILES: "" };
const messages = [];
for (const networks of ${JSON.stringify(refused)}) {
  try {
    renderOperatorConfig({ ...values, LUMA_TRAEFIK_EXTRA_NETWORKS: networks }, null);
    messages.push("");
  } catch (error) { messages.push(error.message); }
}
process.stdout.write(JSON.stringify(messages));
`;
  const overlayBefore = fs.readFileSync(path.join(production, "operator.compose.yaml"), "utf8");
  const rendered = spawnSync(process.execPath, ["-e", script], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
  assert.equal(rendered.status, 0, rendered.stderr);
  for (const [index, message] of JSON.parse(rendered.stdout).entries()) {
    assert.match(message, /^LUMA_TRAEFIK_EXTRA_NETWORKS /u, `${refused[index]} must be refused`);
  }
  assert.equal(
    fs.readFileSync(path.join(production, "operator.compose.yaml"), "utf8"), overlayBefore,
    "a refused network list renders nothing",
  );

  setRuntimeValues(env, { LUMA_TRAEFIK_EXTRA_NETWORKS: "cosmos-internal" });
  const results = recordProductionCommands(env, [["doctor"], ["deploy", "--confirm"]]);
  for (const outcome of results) {
    assert.equal(outcome.exitCode, 1);
    assert.deepEqual(outcome.invoked, []);
    assert.match(outcome.message, /LUMA_TRAEFIK_EXTRA_NETWORKS cannot name cosmos-internal/u);
  }
});

test("confirmed deploy re-renders an older installation's edge and its mounts from the release", (t) => {
  const { env } = fixture(t);
  const setup = invoke(
    env,
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
  );
  assert.equal(setup.status, 0, setup.stderr);
  const runtime = fs.readFileSync(env.LUMA_ENV_FILE, "utf8");
  assert.match(runtime, /^LUMA_COMPOSE_APPLICATION=/mu);
  fs.writeFileSync(env.LUMA_ENV_FILE, runtime.replace(
    /^LUMA_COMPOSE_APPLICATION=.*$/mu,
    `LUMA_COMPOSE_APPLICATION=oci://ghcr.io/example/luma/application@sha256:${"a".repeat(64)}`,
  ));

  // The edge an older release rendered: a public capture read router and no
  // entry-point middleware stripping internal identity headers.
  const production = path.join(env.LUMA_CONFIG_DIR, "production");
  const staticFile = path.join(production, "traefik.yaml");
  const dynamicFile = path.join(production, "traefik-dynamic.yaml");
  const oldStatic = 'entryPoints:\n  web:\n    address: ":80"\n  websecure:\n    address: ":443"\n';
  const oldDynamic = [
    "http:",
    "  routers:",
    "    capture:",
    "      entryPoints: [websecure]",
    '      rule: "Host(`pin.example.test`) && PathPrefix(`/capture/`)"',
    "      service: ai-bus",
    "",
  ].join("\n");
  for (const [file, contents] of [[staticFile, oldStatic], [dynamicFile, oldDynamic]]) {
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, contents);
    fs.chmodSync(file, 0o444);
  }
  // The overlay an older release wrote: Traefik without its dynamic-file mount.
  const overlayFile = path.join(production, "operator.compose.yaml");
  const currentOverlay = fs.readFileSync(overlayFile, "utf8");
  const oldOverlay = currentOverlay
    .replace(/^ {6}- \{ source: traefik_dynamic, target: \/etc\/traefik\/dynamic\/10-luma\.yaml \}\n/mu, "");
  assert.notEqual(oldOverlay, currentOverlay);
  fs.writeFileSync(overlayFile, oldOverlay);

  const result = deployWithRecordedScript(env, "--dry-run", "--confirm");
  assert.equal(result.status, 0, result.stderr);
  const [dryRun, confirmed] = JSON.parse(result.stdout);
  assert.deepEqual([dryRun.script, dryRun.args, dryRun.confirmed], ["deploy.sh", ["--dry-run"], false]);
  assert.equal(dryRun.static, oldStatic, "a dry run changes nothing");
  assert.equal(dryRun.dynamic, oldDynamic, "a dry run changes nothing");
  assert.equal(dryRun.overlay, oldOverlay, "a dry run changes nothing");

  const template = (name) => fs.readFileSync(path.join(root, "platform/edge/traefik", name), "utf8");
  assert.deepEqual([confirmed.script, confirmed.args, confirmed.confirmed], ["deploy.sh", [], true]);
  assert.equal(confirmed.static, template("traefik.yaml.tpl").replaceAll("@@ACME_EMAIL@@", "acme@example.test"));
  assert.equal(
    confirmed.dynamic,
    template("dynamic.yaml.tpl").replaceAll("@@PUBLIC_DOMAIN@@", "pin.example.test"),
  );
  assert.doesNotMatch(confirmed.dynamic, /PathPrefix\(`\/capture/u);
  assert.match(confirmed.static, /middlewares: \[strip-internal-identity@file\]/u);
  // One provider directory loads Luma's routes and the owner's extra routes.
  assert.match(confirmed.static, /^ {4}directory: \/etc\/traefik\/dynamic$/mu);
  assert.doesNotMatch(confirmed.static, /filename:/u);
  for (const file of [staticFile, dynamicFile]) assert.equal(fs.statSync(file).mode & 0o777, 0o444, file);
  assert.equal(confirmed.overlay, currentOverlay, "deploy writes the mounts this release's setup writes");
  assert.equal(fs.statSync(overlayFile).mode & 0o777, 0o600);
});

test("the shared renderer adds Envoy and its mounts for the pin profile and refuses a missing input", (t) => {
  const { env } = fixture(t);
  const production = path.join(env.LUMA_CONFIG_DIR, "production");
  const envoy = path.join(production, "envoy.yaml");
  const overlay = path.join(production, "operator.compose.yaml");
  const token = "t".repeat(48);
  const binding = { releaseId: "a".repeat(64), manifestSha256: "b".repeat(64) };
  const script = `
const fs = require("node:fs");
const { renderOperatorConfig } = require(${JSON.stringify(path.join(root, "platform/cli/production-setup.js"))});
const values = {
  LUMA_ACME_EMAIL: "acme@example.test",
  LUMA_PUBLIC_DOMAIN: "pin.example.test",
  COSMOS_EDGE_TOKEN: ${JSON.stringify(token)},
  COMPOSE_PROFILES: "search",
};
renderOperatorConfig(values, null);
const withoutPin = fs.existsSync(${JSON.stringify(envoy)});
const overlayWithoutPin = fs.readFileSync(${JSON.stringify(overlay)}, "utf8");
renderOperatorConfig({ ...values, COMPOSE_PROFILES: "search,pin" }, ${JSON.stringify(binding)});
let unbound = "";
try { renderOperatorConfig({ ...values, COMPOSE_PROFILES: "pin" }, null); } catch (error) { unbound = error.message; }
let refusal = "";
try { renderOperatorConfig({ ...values, LUMA_PUBLIC_DOMAIN: "" }, null); } catch (error) { refusal = error.message; }
process.stdout.write(JSON.stringify({ withoutPin, overlayWithoutPin, unbound, refusal }));
`;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const { withoutPin, overlayWithoutPin, unbound, refusal } = JSON.parse(result.stdout);
  assert.equal(withoutPin, false);
  assert.match(overlayWithoutPin, /- \{ source: traefik_dynamic, target: \/etc\/traefik\/dynamic\/10-luma\.yaml \}/u);
  assert.match(overlayWithoutPin, /searxng_settings/u);
  assert.doesNotMatch(overlayWithoutPin, /envoy_config/u);
  assert.equal(
    fs.readFileSync(envoy, "utf8"),
    fs.readFileSync(path.join(root, "platform/edge/envoy/envoy.yaml.tpl"), "utf8")
      .replaceAll("@@EDGE_TOKEN@@", token)
      .replaceAll("@@CERT_DIR@@", "/etc/cosmos-edge/certs"),
  );
  assert.equal(fs.statSync(envoy).mode & 0o777, 0o444);
  const withPin = fs.readFileSync(overlay, "utf8");
  assert.match(withPin, /- \{ source: envoy_config, target: \/etc\/cosmos-edge\/envoy\.yaml \}/u);
  // Compose ignores a file secret's mode outside Swarm and warns on every
  // command; the host files' own 0444 mode is what the containers see.
  assert.doesNotMatch(withPin, /\bmode:/u);
  assert.doesNotMatch(overlayWithoutPin, /\bmode:/u);
  assert.equal(withPin.includes(`envoy_config: { file: ${JSON.stringify(envoy)} }`), true);
  assert.equal(withPin.includes(`LUMA_PIN_RELEASE_EXPECTED_ID: ${JSON.stringify(binding.releaseId)}`), true);
  assert.equal(fs.statSync(overlay).mode & 0o777, 0o600);
  assert.match(unbound, /the pin profile requires an expected release binding/u);
  assert.match(refusal, /template value for @@PUBLIC_DOMAIN@@ is empty/u);
});

test("the edge renderer inserts values literally and refuses values a quoted scalar cannot hold", (t) => {
  const { env } = fixture(t);
  const production = path.join(env.LUMA_CONFIG_DIR, "production");
  // Valid for setup and runtime validation, and full of String.replace patterns.
  const email = "o$'wner$&$`@example.test";
  const script = `
const { renderOperatorConfig, validProductionEmail } = require(${JSON.stringify(path.join(root, "platform/cli/production-setup.js"))});
const values = {
  LUMA_ACME_EMAIL: ${JSON.stringify(email)},
  LUMA_PUBLIC_DOMAIN: "pin.example.test",
  COSMOS_EDGE_TOKEN: "t".repeat(48),
  COMPOSE_PROFILES: "pin",
};
const binding = { releaseId: "a".repeat(64), manifestSha256: "b".repeat(64) };
const accepted = validProductionEmail(values.LUMA_ACME_EMAIL);
renderOperatorConfig(values, binding);
const refusals = [];
for (const token of ['t'.repeat(40) + '"', 't'.repeat(40) + '\\\\', 't'.repeat(40) + '\\t']) {
  try { renderOperatorConfig({ ...values, COSMOS_EDGE_TOKEN: token }, binding); } catch (error) { refusals.push(error.message); }
}
process.stdout.write(JSON.stringify({ accepted, refusals }));
`;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const { accepted, refusals } = JSON.parse(result.stdout);
  assert.equal(accepted, true);
  assert.equal(
    fs.readFileSync(path.join(production, "traefik.yaml"), "utf8"),
    fs.readFileSync(path.join(root, "platform/edge/traefik/traefik.yaml.tpl"), "utf8").split("@@ACME_EMAIL@@").join(email),
  );
  assert.equal(refusals.length, 3, JSON.stringify(refusals));
  for (const refusal of refusals) assert.match(refusal, /template value for @@EDGE_TOKEN@@ cannot be quoted safely/u);
  assert.match(fs.readFileSync(path.join(production, "envoy.yaml"), "utf8"), /value: "t{48}"/u);
});

test("setup status keeps incomplete production setup on its resumable path", (t) => {
  const { env } = fixture(t);
  fs.mkdirSync(path.dirname(env.LUMA_ENV_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(env.LUMA_ENV_FILE, "LUMA_PUBLIC_DOMAIN=pin.example.test\n", { mode: 0o600 });

  let status = invoke(env, "setup", "status", "--json");
  assert.equal(status.status, 1);
  let report = JSON.parse(status.stdout);
  assert.equal(report.mode, "production");
  assert.equal(report.state, "production-invalid");
  assert.equal(report.ok, false);
  assert.equal(report.next, "./luma setup production --pin-release-archive ../luma-pin-*.tar.gz (from the newest luma-operator folder)");

  fs.unlinkSync(env.LUMA_ENV_FILE);
  const production = path.join(env.LUMA_CONFIG_DIR, "production");
  fs.mkdirSync(production, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(production, "realm.json"), "{}\n", { mode: 0o444 });

  status = invoke(env, "setup", "status", "--json");
  assert.equal(status.status, 1);
  report = JSON.parse(status.stdout);
  assert.equal(report.mode, "production");
  assert.equal(report.nextCommandId, "setup.production");
});

test("unsupported setup commands fail without creating operator state", (t) => {
  const { env } = fixture(t);
  const result = invoke(env, "setup", "import");
  assert.equal(result.status, 64);
  assert.match(result.stderr, /usage: \.\/luma setup local\|contributor\|pin/u);
  assert.equal(fs.existsSync(env.LUMA_CONFIG_DIR), false);
});
