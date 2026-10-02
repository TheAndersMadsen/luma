import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-backup-restore-"));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

const CONFIG = path.join(temporary, "config");
const SECRETS = path.join(CONFIG, "secrets");
const DATA = path.join(temporary, "data");
const ENV = path.join(SECRETS, "runtime.env");
const PRODUCTION = path.join(CONFIG, "production");
const PIN_RELEASES = path.join(DATA, "pin-releases");
// The CLI resolves its operator directories once, when it is loaded.
Object.assign(process.env, {
  LUMA_CONFIG_DIR: CONFIG,
  LUMA_SECRETS_DIR: SECRETS,
  LUMA_DATA_DIR: DATA,
  LUMA_BUILD_DIR: path.join(DATA, "build"),
  LUMA_ENV_FILE: ENV,
});
const require = createRequire(import.meta.url);
const {
  DATABASE_RESTORE_FILTER,
  backupCommand,
  backupProduction,
  restoreProduction,
} = require("../../cli/backup.js");
const { prepareManagedRoots } = require("../../cli/context.js");
const { interruptedRestoreProblems } = require("../../cli/production-setup.js");

const RELEASE = Object.freeze({
  version: "0.3.0",
  revision: "a".repeat(40),
  application: `oci://ghcr.io/example/luma/application@sha256:${"b".repeat(64)}`,
});
const POSTGRES_IMAGE = `postgres:16-alpine@sha256:${"c".repeat(64)}`;
const OPAQUE_SEED = crypto.randomBytes(32).toString("base64");
const DATABASE_PASSWORD = crypto.randomBytes(32).toString("hex");
const EDGE_KEY = `-----BEGIN PRIVATE KEY-----\n${crypto.randomBytes(48).toString("base64")}\n`;
const DUMP = [
  "SET default_transaction_read_only = off;",
  "CREATE ROLE cosmos;",
  "ALTER ROLE cosmos WITH SUPERUSER LOGIN PASSWORD 'SCRAM-SHA-256$4096:saved';",
  "CREATE DATABASE cosmos WITH TEMPLATE = template0;",
  "",
].join("\n");

function put(file, contents, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, contents, { mode });
  fs.chmodSync(file, mode);
}

function directory(selected, mode) {
  fs.mkdirSync(selected, { recursive: true, mode });
  fs.chmodSync(selected, mode);
}

function snapshot(selected) {
  const entries = {};
  const walk = (current, relative) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      const inner = relative ? `${relative}/${entry.name}` : entry.name;
      const mode = fs.lstatSync(file).mode & 0o777;
      if (entry.isDirectory()) {
        entries[inner] = { mode };
        walk(file, inner);
      } else {
        entries[inner] = { mode, contents: fs.readFileSync(file, "utf8") };
      }
    }
  };
  walk(selected, "");
  return entries;
}

function wipeHost() {
  for (const selected of [CONFIG, DATA, path.join(temporary, "volumes")]) {
    fs.rmSync(selected, { recursive: true, force: true });
  }
}

function volume(host, name, files) {
  const selected = path.join(temporary, "volumes", name);
  directory(selected, 0o755);
  for (const [relative, [contents, mode]] of Object.entries(files)) put(path.join(selected, relative), contents, mode);
  host.volumes.set(name, selected);
}

// One production server: configuration, secrets, the Pin release store, the
// stack's volumes as directories, and its Compose containers.
function productionHost() {
  wipeHost();
  prepareManagedRoots();
  directory(PRODUCTION, 0o700);
  put(path.join(PRODUCTION, "operator.compose.yaml"), "services: {}\n", 0o600);
  put(path.join(PRODUCTION, "realm.json"), "{\"realm\":\"humane\"}\n", 0o444);
  directory(path.join(PRODUCTION, "edge-root"), 0o700);
  put(path.join(PRODUCTION, "edge-root", "edge-ca.crt"), "-----BEGIN CERTIFICATE-----\n", 0o444);
  put(path.join(PRODUCTION, "edge-root", "edge-ca.key"), EDGE_KEY, 0o444);
  put(path.join(PRODUCTION, "traefik-extra.json"), "{\"http\":{}}\n", 0o644);
  directory(path.join(PRODUCTION, "traefik-extra-certs"), 0o755);
  put(path.join(PRODUCTION, "traefik-extra-certs", "owner.example.crt"), "owner certificate\n", 0o444);
  put(ENV, [
    "LUMA_CONFIG_VERSION=1",
    `LUMA_RELEASE_ID=${RELEASE.revision}`,
    `LUMA_COMPOSE_APPLICATION=${RELEASE.application}`,
    "LUMA_PUBLIC_DOMAIN=pin.example.test",
    `COSMOS_OPAQUE_SEED=${OPAQUE_SEED}`,
    `COSMOS_PG_PASSWORD=${DATABASE_PASSWORD}`,
    "",
  ].join("\n"), 0o600);
  directory(path.join(PIN_RELEASES, "releases", "r1"), 0o755);
  directory(path.join(PIN_RELEASES, "releases"), 0o755);
  directory(PIN_RELEASES, 0o755);
  put(path.join(PIN_RELEASES, "current.json"), "{\"releaseId\":\"r1\"}\n", 0o444);
  put(path.join(PIN_RELEASES, "releases", "r1", "server.apk"), "PK apk bytes\n", 0o444);

  const host = { volumes: new Map(), labels: new Map(), dump: DUMP, containers: [] };
  volume(host, "luma_cosmos-state", {
    "keys/device-user.key": ["cosmos key material\n", 0o600],
    "captures/1.jpg": ["jpeg bytes\n", 0o644],
  });
  volume(host, "luma_center-data", { "center.json": ["{}\n", 0o600] });
  volume(host, "luma_iroh-bridge-data", { "endpoint.key": ["iroh key\n", 0o600] });
  volume(host, "luma_cosmos-pgdata", { PG_VERSION: ["16\n", 0o600] });
  host.containers = [
    ["pg", "running", "postgres"],
    ["bus", "running", "ai-bus"],
    ["center", "running", "center"],
    ["edge", "running", "traefik"],
    ["search", "exited", "searxng"],
  ].map(([id, state, service]) => ({ id, state, service, project: "luma", release: RELEASE.revision }));
  return host;
}

// Docker as the backup and restore use it. Volumes are directories, and the
// volume copies run the host's tar, so contents and modes round-trip for real.
function fakeDocker(host) {
  const calls = [];
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const refused = (stderr) => ({ status: 1, stdout: "", stderr });
  const docker = (args, options = {}) => {
    calls.push({ args: [...args], env: options.env });
    const [command, subcommand] = args;
    if (command === "ps") {
      const project = args[args.indexOf("--filter") + 1].split("=").at(-1);
      return ok(host.containers.filter((entry) => entry.project === project)
        .map((entry) => `${entry.id}\t${entry.state}\t${entry.service}\t${entry.release}\n`).join(""));
    }
    if (command === "inspect") return ok(`${POSTGRES_IMAGE}\n`);
    if (command === "volume" && subcommand === "inspect") {
      return host.volumes.has(args.at(-1)) ? ok(`${args.at(-1)}\n`) : refused("no such volume");
    }
    if (command === "volume" && subcommand === "create") {
      const name = args.at(-1);
      volume(host, name, {});
      host.labels.set(name, args.filter((_, index) => args[index - 1] === "--label"));
      return ok(`${name}\n`);
    }
    if (command === "pause" || command === "unpause") {
      host.containers.find((entry) => entry.id === args[1]).state = command === "pause" ? "paused" : "running";
      return ok();
    }
    if (command === "exec" && args.includes("pg_dumpall")) {
      if (host.failDump) return refused("pg_dumpall: error: query failed: lock timeout\n");
      fs.writeSync(options.stdout, host.dump);
      return ok();
    }
    if (command === "exec" && args.includes("pg_isready")) return ok();
    if (command === "exec" && args.includes("sh")) {
      host.restoredDump = fs.readFileSync(options.stdin, "utf8");
      host.restoreScript = args.at(-1);
      return ok();
    }
    if (command === "run" && args.includes("--detach")) {
      host.restoreDatabase = { args: [...args], env: options.env };
      return ok("restore-container\n");
    }
    if (command === "run") {
      const [name] = args[args.indexOf("--volume") + 1].split(":");
      const selected = host.volumes.get(name);
      if (args[args.indexOf("--entrypoint") + 1] === "tar") {
        const packed = spawnSync("tar", ["-C", selected, "-cf", "-", "."], { stdio: ["ignore", options.stdout, "pipe"] });
        return { status: packed.status, stdout: "", stderr: String(packed.stderr) };
      }
      const script = args.at(-1);
      assert.match(script, /find \/volume -mindepth 1 -delete/u);
      for (const entry of fs.readdirSync(selected)) fs.rmSync(path.join(selected, entry), { recursive: true, force: true });
      if (script.includes("tar")) {
        const unpacked = spawnSync("tar", ["-C", selected, "-xpf", "-"], { stdio: [options.stdin, "ignore", "pipe"] });
        return { status: unpacked.status, stdout: "", stderr: String(unpacked.stderr) };
      }
      return ok();
    }
    if (["stop", "rm", "logs"].includes(command)) return ok();
    return refused(`unexpected docker ${args.join(" ")}`);
  };
  return { docker, calls };
}

function runtime(host, extra = {}) {
  const { docker, calls } = fakeDocker(host);
  const lines = [];
  const deployed = [];
  return {
    calls,
    lines,
    deployed,
    options: {
      docker,
      release: () => RELEASE,
      now: new Date("2026-09-23T10:15:00.000Z"),
      write: (line) => lines.push(line),
      deploy: (args) => deployed.push(args),
      sleep: () => {},
      ...extra,
    },
  };
}

function backupOf(host, name) {
  const output = path.join(temporary, "backups", name);
  backupProduction({ output }, runtime(host).options);
  return output;
}

function index(calls, predicate) {
  const found = calls.findIndex(({ args }) => predicate(args));
  assert.notEqual(found, -1);
  return found;
}

test("backup freezes the stack for one private, checksummed copy and prints no secret", () => {
  const host = productionHost();
  const production = snapshot(PRODUCTION);
  const { calls, lines, options } = runtime(host);
  const output = path.join(temporary, "backups", "first");
  backupCommand(["production", "--output", output], options);

  // Every running service but PostgreSQL and Traefik, which also serves the
  // owner's other hostnames, is paused around the dump and the volume copies,
  // and resumed after. The stopped one is left alone.
  const paused = calls.filter(({ args }) => args[0] === "pause").map(({ args }) => args[1]);
  const resumed = calls.filter(({ args }) => args[0] === "unpause").map(({ args }) => args[1]);
  assert.deepEqual(paused.sort(), ["bus", "center"]);
  assert.deepEqual(resumed.sort(), ["bus", "center"]);
  const lastPause = calls.findLastIndex(({ args }) => args[0] === "pause");
  const dump = index(calls, (args) => args.includes("pg_dumpall"));
  const lastCopy = calls.findLastIndex(({ args }) => args[0] === "run" && args.includes("tar"));
  const firstResume = index(calls, (args) => args[0] === "unpause");
  assert.ok(lastPause < dump && dump < lastCopy && lastCopy < firstResume);
  assert.deepEqual(calls[dump].args, ["exec", "pg", "pg_dumpall", "--username=cosmos", "--lock-wait-timeout=60s"]);
  assert.ok(host.containers.every((entry) => entry.state !== "paused"));

  // A private directory: 0700 directories and 0600 files only.
  const copied = snapshot(output);
  assert.equal(fs.statSync(output).mode & 0o777, 0o700);
  for (const [entry, { mode, contents }] of Object.entries(copied)) {
    assert.equal(mode, contents === undefined ? 0o700 : 0o600, entry);
  }

  const manifest = JSON.parse(copied["manifest.json"].contents);
  assert.equal(manifest.kind, "luma-production-backup");
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.release, { version: "0.3.0", id: RELEASE.revision, application: RELEASE.application });
  assert.equal(manifest.deployedRelease, RELEASE.revision);
  assert.equal(manifest.postgresImage, POSTGRES_IMAGE);
  const listed = new Map(manifest.files.map((entry) => [entry.path, entry]));
  assert.deepEqual(new Set(listed.keys()), new Set(Object.keys(copied)
    .filter((entry) => entry !== "manifest.json" && copied[entry].contents !== undefined)));
  for (const [entry, { sha256, size }] of listed) {
    const bytes = fs.readFileSync(path.join(output, entry));
    assert.equal(sha256, crypto.createHash("sha256").update(bytes).digest("hex"), entry);
    assert.equal(size, bytes.length, entry);
  }
  assert.equal(copied["postgres.sql"].contents, DUMP);
  assert.equal(listed.get("runtime.env").mode, "0600");
  assert.equal(copied["runtime.env"].contents, fs.readFileSync(ENV, "utf8"));
  for (const [entry, { mode, contents }] of Object.entries(production)) {
    if (contents === undefined) {
      assert.ok(manifest.directories.some((item) => item.path === `production/${entry}` &&
        item.mode === `0${mode.toString(8)}`), entry);
    } else {
      assert.equal(listed.get(`production/${entry}`).mode, `0${mode.toString(8)}`, entry);
      assert.equal(copied[`production/${entry}`].contents, contents, entry);
    }
  }
  assert.ok(manifest.directories.some((item) => item.path === "production" && item.mode === "0700"));
  assert.equal(listed.get("pin-releases/releases/r1/server.apk").mode, "0444");
  for (const name of ["cosmos-state", "center-data", "iroh-bridge-data"]) assert.ok(listed.has(`volumes/${name}.tar`));
  assert.equal(listed.has("volumes/cosmos-pgdata.tar"), false);
  const members = spawnSync("tar", ["-tf", path.join(output, "volumes", "cosmos-state.tar")], { encoding: "utf8" });
  assert.match(members.stdout, /keys\/device-user\.key/u);

  const printed = lines.join("\n");
  for (const secret of [OPAQUE_SEED, DATABASE_PASSWORD, EDGE_KEY.split("\n")[1]]) assert.equal(printed.includes(secret), false);
  assert.match(printed, new RegExp(`Backed up Luma 0\\.3\\.0 \\(release ${RELEASE.revision}\\) to ${output}`, "u"));
  assert.match(printed, /Copy it off this server/u);
  // Without the server's own address the hint says where it goes. The public
  // domain may be behind a proxy that does not carry SSH.
  assert.match(printed, new RegExp(`scp -r '\\S+@<your-server>:${output}' \\.`, "u"));
  assert.equal(printed.includes("pin.example.test"), false);
  assert.match(printed, new RegExp(`\\./luma restore production --from ${output}`, "u"));
  assert.deepEqual(fs.readdirSync(path.dirname(output)).filter((entry) => entry.includes("partial")), []);
});

test("the copy hint reaches the server by its own public IPv4, not its proxied domain", () => {
  const host = productionHost();
  fs.appendFileSync(ENV, "LUMA_DEVICE_EDGE_IPV4=198.51.100.22\n");
  const { lines, options } = runtime(host);
  const output = path.join(temporary, "backups", "by-address");
  backupCommand(["production", "--output", output], options);
  const printed = lines.join("\n");
  assert.match(printed, new RegExp(`\\n  scp -r \\S+@198\\.51\\.100\\.22:${output} \\.\\n`, "u"));
  assert.equal(printed.includes("pin.example.test"), false);
});

test("a failed backup resumes the stack and leaves no partial backup", () => {
  const host = productionHost();
  host.failDump = true;
  const { calls, options } = runtime(host);
  const output = path.join(temporary, "backups", "failed");
  assert.throws(() => backupProduction({ output }, options), /the PostgreSQL dump failed: pg_dumpall: error: query failed/u);
  assert.deepEqual(
    calls.filter(({ args }) => args[0] === "unpause").map(({ args }) => args[1]).sort(),
    ["bus", "center"],
  );
  assert.ok(host.containers.every((entry) => entry.state !== "paused"));
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(fs.readdirSync(path.dirname(output)).filter((entry) => entry.startsWith(".failed")), []);
});

test("backup refuses a stopped database, a mixed release, another release's configuration, and a source-tree output", () => {
  let host = productionHost();
  host.containers.find((entry) => entry.service === "postgres").state = "exited";
  assert.throws(() => backupProduction({}, runtime(host).options), /PostgreSQL is not running/u);

  host = productionHost();
  host.containers.find((entry) => entry.service === "center").release = "d".repeat(40);
  assert.throws(() => backupProduction({}, runtime(host).options),
    /stack is not one Luma release \(found a{40}, d{40}\); finish \.\/luma deploy production --confirm/u);

  host = productionHost();
  host.containers.find((entry) => entry.service === "center").release = "";
  assert.throws(() => backupProduction({}, runtime(host).options), /not one Luma release \(found a{40}, unlabelled\)/u);

  // Configured by a third release's setup: only that release's operator
  // knows the configuration it holds.
  host = productionHost();
  put(ENV, fs.readFileSync(ENV, "utf8").replace(RELEASE.revision, "1".repeat(40)), 0o600);
  const other = { ...RELEASE, revision: "e".repeat(40) };
  assert.throws(() => backupProduction({}, runtime(host, { release: () => other }).options),
    /runs release a{40} but is configured for release 1{40}, and this operator is Luma 0\.3\.0 \(release e{40}\); run the backup from the folder of the release it is configured for/u);
  // With its version recorded, the configured release is named by its folder.
  put(ENV, `${fs.readFileSync(ENV, "utf8")}LUMA_RELEASE_VERSION=0.2.9\n`, 0o600);
  assert.throws(() => backupProduction({}, runtime(host, { release: () => other }).options),
    /configured for Luma 0\.2\.9 \(release 1{12}…, folder luma-operator-0\.2\.9\)/u);

  host = productionHost();
  const inside = path.join(root, "luma-backup-inside-source");
  const { calls, options } = runtime(host);
  assert.throws(() => backupProduction({ output: inside }, options), /outside the source tree/u);
  assert.equal(fs.existsSync(inside), false);
  assert.equal(calls.some(({ args }) => args[0] === "pause"), false);
});

test("restore checks the backup and the target, prints the plan, and changes nothing without --confirm", () => {
  const output = backupOf(productionHost(), "plan");
  wipeHost();
  const fresh = { volumes: new Map(), labels: new Map(), containers: [] };
  const { calls, lines, deployed, options } = runtime(fresh);
  assert.deepEqual(restoreProduction({ from: output }, options), { restored: false });
  assert.equal(fs.existsSync(CONFIG), false);
  assert.equal(fs.existsSync(DATA), false);
  assert.deepEqual(deployed, []);
  assert.ok(calls.every(({ args }) => args[0] === "ps" || (args[0] === "volume" && args[1] === "inspect")));
  const printed = lines.join("\n");
  assert.match(printed, /all \d+ files match their SHA-256 checksums/u);
  assert.match(printed, /Configuration: create /u);
  assert.match(printed, /Database: postgres\.sql into luma_cosmos-pgdata/u);
  assert.match(printed, /Nothing was changed/u);
  assert.match(printed, new RegExp(`\\./luma restore production --from ${output} --confirm`, "u"));
});

test("restore refuses a damaged or padded backup, another release, and a running or foreign stack", () => {
  const output = backupOf(productionHost(), "refusals");
  const fresh = () => ({ volumes: new Map(), labels: new Map(), containers: [] });
  const attempt = (from, host, extra) => () => restoreProduction({ from, confirm: true }, runtime(host, extra).options);

  const damaged = path.join(temporary, "backups", "damaged");
  fs.cpSync(output, damaged, { recursive: true });
  fs.appendFileSync(path.join(damaged, "production", "realm.json"), " ");
  wipeHost();
  assert.throws(attempt(damaged, fresh()), /production\/realm\.json does not match its SHA-256 checksum/u);

  const padded = path.join(temporary, "backups", "padded");
  fs.cpSync(output, padded, { recursive: true });
  fs.writeFileSync(path.join(padded, "production", "extra.yaml"), "x\n");
  assert.throws(attempt(padded, fresh()),
    /files its manifest does not list: production\/extra\.yaml; delete them from the backup folder, then rerun/u);
  assert.throws(attempt(path.join(temporary, "backups", "missing"), fresh()), /the backup does not exist: /u);
  const nested = path.join(PIN_RELEASES, "copied-backup");
  fs.cpSync(output, nested, { recursive: true });
  assert.throws(attempt(nested, fresh()), /the backup cannot be inside .*pin-releases, which the restore replaces/u);
  fs.rmSync(DATA, { recursive: true, force: true });

  const newer = { ...RELEASE, version: "0.4.0", revision: "f".repeat(40) };
  assert.throws(attempt(output, fresh(), { release: () => newer }),
    /the backup is Luma 0\.3\.0 .* restore it with the Luma 0\.3\.0 operator release/u);

  const running = fresh();
  running.containers = [{ id: "pg", state: "running", service: "postgres", project: "luma", release: RELEASE.revision }];
  assert.throws(attempt(output, running),
    /luma stack is running on this host; stop it first[\s\S]*docker stop \$\(docker ps --quiet --filter label=com\.docker\.compose\.project=luma\)/u);

  const foreign = fresh();
  foreign.containers = [{ id: "pg", state: "exited", service: "postgres", project: "luma", release: "0".repeat(40) }];
  assert.throws(attempt(output, foreign), /stopped luma stack of release 0{40}/u);

  prepareManagedRoots();
  put(ENV, `LUMA_RELEASE_ID=${"1".repeat(40)}\n`, 0o600);
  assert.throws(attempt(output, fresh()), /is configured for release 1{40}/u);
  assert.equal(fs.existsSync(PRODUCTION), false);
});

test("restore --confirm rebuilds a fresh host from the backup and then deploys it", () => {
  const source = productionHost();
  const production = snapshot(PRODUCTION);
  const pinReleases = snapshot(PIN_RELEASES);
  const environment = fs.readFileSync(ENV, "utf8");
  const volumes = Object.fromEntries(["luma_cosmos-state", "luma_center-data", "luma_iroh-bridge-data"]
    .map((name) => [name, snapshot(source.volumes.get(name))]));
  const output = backupOf(source, "fresh-host");
  wipeHost();

  const fresh = { volumes: new Map(), labels: new Map(), containers: [] };
  const { calls, deployed, lines, options } = runtime(fresh);
  assert.deepEqual(restoreProduction({ from: output, confirm: true }, options), { restored: true });

  assert.deepEqual(snapshot(PRODUCTION), production);
  assert.equal(fs.statSync(PRODUCTION).mode & 0o777, 0o700);
  assert.deepEqual(snapshot(PIN_RELEASES), pinReleases);
  assert.equal(fs.readFileSync(ENV, "utf8"), environment);
  assert.equal(fs.statSync(ENV).mode & 0o777, 0o600);
  for (const [name, contents] of Object.entries(volumes)) {
    assert.deepEqual(snapshot(fresh.volumes.get(name)), contents, name);
    const key = name.replace(/^luma_/u, "");
    assert.deepEqual(fresh.labels.get(name), ["com.docker.compose.project=luma", `com.docker.compose.volume=${key}`]);
  }
  assert.deepEqual(fresh.labels.get("luma_cosmos-pgdata"),
    ["com.docker.compose.project=luma", "com.docker.compose.volume=cosmos-pgdata"]);

  // A fresh cluster with only the bootstrap superuser receives the dump. Its
  // throwaway password reaches Docker only through the environment.
  const database = fresh.restoreDatabase;
  assert.ok(database.args.includes("POSTGRES_DB=postgres"));
  assert.ok(database.args.includes("POSTGRES_PASSWORD"));
  assert.equal(database.args.some((arg) => arg.startsWith("POSTGRES_PASSWORD=")), false);
  assert.match(database.env.POSTGRES_PASSWORD, /^[0-9a-f]{48}$/u);
  assert.ok(database.args.includes(`luma_cosmos-pgdata:/var/lib/postgresql/data`));
  assert.ok(database.args.includes(POSTGRES_IMAGE));
  assert.equal(fresh.restoredDump, DUMP);
  assert.match(fresh.restoreScript, /psql -X -q -v ON_ERROR_STOP=1/u);
  const started = index(calls, (args) => args[0] === "run" && args.includes("--detach"));
  const loaded = index(calls, (args) => args[0] === "exec" && args.includes("sh"));
  const stopped = index(calls, (args) => args[0] === "stop");
  const lastVolume = calls.findLastIndex(({ args }) => args[0] === "run" && args.at(-1).includes("tar"));
  assert.ok(lastVolume < started && started < loaded && loaded < stopped);
  assert.equal(calls.at(-1).args.join(" "), "rm --force luma-restore-postgres");
  assert.deepEqual(deployed, [["production", "--confirm"]]);
  assert.match(lines.at(-1), /Restored Luma 0\.3\.0 from /u);
});

test("restore --confirm over a stopped stack of the same release replaces what was there", () => {
  const host = productionHost();
  const production = snapshot(PRODUCTION);
  const state = snapshot(host.volumes.get("luma_cosmos-state"));
  const output = backupOf(host, "stopped-stack");
  put(path.join(PRODUCTION, "stale.yaml"), "stale\n", 0o600);
  put(path.join(host.volumes.get("luma_cosmos-state"), "captures", "later.jpg"), "later\n", 0o644);
  for (const container of host.containers) container.state = "exited";

  const { deployed, options } = runtime(host);
  restoreProduction({ from: output, confirm: true, projectName: "luma" }, options);
  assert.deepEqual(snapshot(PRODUCTION), production);
  assert.deepEqual(snapshot(host.volumes.get("luma_cosmos-state")), state);
  assert.deepEqual(fs.readdirSync(CONFIG).filter((entry) => entry.includes("restore") || entry.includes("replaced")), []);
  assert.deepEqual(deployed, [["production", "--confirm"]]);
});

// The next release's operator, as the update installs it beside the running one.
const NEWER = Object.freeze({
  version: "0.3.1",
  revision: "e".repeat(40),
  application: `oci://ghcr.io/example/luma/application@sha256:${"f".repeat(64)}`,
});

test("the next release backs up the release the server runs before its setup, and restore gives that back undeployed", () => {
  const host = productionHost();
  const environment = fs.readFileSync(ENV, "utf8");
  const production = snapshot(PRODUCTION);
  const { lines, options } = runtime(host, { release: () => NEWER });
  const output = path.join(temporary, "backups", "before-setup");
  backupCommand(["production", "--output", output], options);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.release, { version: "0.3.1", id: NEWER.revision, application: NEWER.application });
  assert.equal(manifest.deployedRelease, RELEASE.revision);
  const printed = lines.join("\n");
  assert.match(printed, new RegExp(`Backed up the server running release ${RELEASE.revision} with Luma 0\\.3\\.1 ` +
    `\\(release ${NEWER.revision}\\) to ${output}`, "u"));
  assert.match(printed, /To restore it, run from the Luma 0\.3\.1 operator directory/u);
  assert.ok(host.containers.every((entry) => entry.state !== "paused"));

  // Restore keeps its one rule: only the operator release that made a backup
  // restores it.
  wipeHost();
  const fresh = () => ({ volumes: new Map(), labels: new Map(), containers: [] });
  assert.throws(() => restoreProduction({ from: output, confirm: true }, runtime(fresh()).options),
    /the backup is Luma 0\.3\.1 .* restore it with the Luma 0\.3\.1 operator release/u);
  assert.equal(fs.existsSync(CONFIG), false);

  const plan = runtime(fresh(), { release: () => NEWER });
  restoreProduction({ from: output }, plan.options);
  assert.match(plan.lines.join("\n"),
    new RegExp(`while the server ran release ${RELEASE.revision}; all \\d+ files match`, "u"));
  assert.match(plan.lines.join("\n"), new RegExp(`Then: nothing is deployed\\. The configuration is release ` +
    `${RELEASE.revision}, from before the Luma 0\\.3\\.1 setup ran, so that release's operator deploys it\\.`, "u"));

  // The server comes back as it ran, and that release's operator starts it.
  const restored = runtime(fresh(), { release: () => NEWER });
  assert.deepEqual(restoreProduction({ from: output, confirm: true }, restored.options), { restored: true });
  assert.equal(fs.readFileSync(ENV, "utf8"), environment);
  assert.deepEqual(snapshot(PRODUCTION), production);
  assert.deepEqual(restored.deployed, []);
  assert.match(restored.lines.join("\n"), new RegExp(`Nothing was deployed: the configuration is release ` +
    `${RELEASE.revision}[\\s\\S]*run from the folder of release ${RELEASE.revision}:\\n` +
    "  \\./luma deploy production --confirm$", "u"));
});

test("a rollback restore names the release to deploy from by its version and folder", () => {
  const host = productionHost();
  put(ENV, `${fs.readFileSync(ENV, "utf8")}LUMA_RELEASE_VERSION=0.3.0\n`, 0o600);
  const output = path.join(temporary, "backups", "named-rollback");
  backupProduction({ output }, runtime(host, { release: () => NEWER }).options);
  wipeHost();
  const fresh = () => ({ volumes: new Map(), labels: new Map(), containers: [] });
  const folder = "Luma 0\\.3\\.0 \\(release a{12}…, folder luma-operator-0\\.3\\.0\\)";
  const plan = runtime(fresh(), { release: () => NEWER });
  restoreProduction({ from: output }, plan.options);
  assert.match(plan.lines.join("\n"), new RegExp(`Then: nothing is deployed\\. The configuration is ${folder}`, "u"));
  const restored = runtime(fresh(), { release: () => NEWER });
  restoreProduction({ from: output, confirm: true }, restored.options);
  assert.match(restored.lines.join("\n"), new RegExp(`run from the folder of ${folder}:\\n  \\./luma deploy production --confirm$`, "u"));
  assert.doesNotMatch(restored.lines.join("\n"), /operator directory of release/u);
});

test("a copy an interrupted restore left behind stops the next restore before anything changes", () => {
  const host = productionHost();
  const output = backupOf(host, "interrupted");
  for (const container of host.containers) container.state = "exited";
  const production = snapshot(PRODUCTION);
  const environment = fs.readFileSync(ENV, "utf8");

  // Both renames happened: the restored tree is live and the copy is the old one.
  directory(`${PIN_RELEASES}.previous`, 0o755);
  assert.deepEqual(interruptedRestoreProblems(), [
    `an interrupted restore replaced ${PIN_RELEASES} but left the copy it replaced at ${PIN_RELEASES}.previous; ` +
      `delete that copy with rm -rf ${PIN_RELEASES}.previous, then rerun the restore (it stopped before the rest of the server)`,
  ]);
  for (const confirm of [false, true]) {
    const { calls, options } = runtime(host);
    assert.throws(() => restoreProduction({ from: output, confirm }, options), /interrupted restore replaced/u);
    assert.deepEqual(calls, [], "nothing was asked of Docker");
  }
  assert.deepEqual(snapshot(PRODUCTION), production, "the configuration was not replaced");
  assert.equal(fs.readFileSync(ENV, "utf8"), environment);

  // Only the first rename happened: the tree is missing and the copy is the real one.
  fs.rmSync(PIN_RELEASES, { recursive: true });
  assert.deepEqual(interruptedRestoreProblems(), [
    `an interrupted restore moved ${PIN_RELEASES} to ${PIN_RELEASES}.previous before putting the restored copy ` +
      `in place; move it back with mv ${PIN_RELEASES}.previous ${PIN_RELEASES}`,
  ]);
  fs.rmSync(`${PIN_RELEASES}.previous`, { recursive: true });
  assert.deepEqual(interruptedRestoreProblems(), []);
});

test("a backup after the next release's setup restores onto the stopped stack and deploys that release", () => {
  const host = productionHost();
  put(ENV, fs.readFileSync(ENV, "utf8")
    .replace(RELEASE.revision, NEWER.revision).replace(RELEASE.application, NEWER.application), 0o600);
  const output = path.join(temporary, "backups", "after-setup");
  backupProduction({ output }, runtime(host, { release: () => NEWER }).options);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.release.id, NEWER.revision);
  assert.equal(manifest.deployedRelease, RELEASE.revision);

  // The deploy stopped half way, so the stopped stack holds both releases.
  for (const container of host.containers) container.state = "exited";
  host.containers.find((entry) => entry.service === "center").release = NEWER.revision;
  const { deployed, lines, options } = runtime(host, { release: () => NEWER });
  assert.deepEqual(restoreProduction({ from: output, confirm: true }, options), { restored: true });
  assert.match(lines.join("\n"), /Then: \.\/luma deploy production --confirm/u);
  assert.deepEqual(deployed, [["production", "--confirm"]]);
  assert.match(lines.at(-1), /Restored Luma 0\.3\.1 from /u);
});

test("a backup in another release's format names the operator release that restores it", () => {
  const output = backupOf(productionHost(), "format-1");
  const file = path.join(output, "manifest.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), schemaVersion: 1 }));
  wipeHost();
  const fresh = { volumes: new Map(), labels: new Map(), containers: [] };
  assert.throws(() => restoreProduction({ from: output }, runtime(fresh).options),
    /manifest\.json is a backup made by Luma 0\.3\.0; restore it with that operator release/u);
});

test("a restore whose deployment stops says the data is back and how to finish", () => {
  const host = productionHost();
  const output = backupOf(host, "deploy-stops");
  for (const container of host.containers) container.state = "exited";
  const { options } = runtime(host, { deploy: () => { throw new Error("deploy.sh exited with status 1"); } });
  assert.throws(() => restoreProduction({ from: output, confirm: true }, options), (error) => {
    assert.equal(error.restored, true);
    assert.match(error.message, /the backup is restored, but the deployment stopped: deploy\.sh exited with status 1/u);
    assert.match(error.message, /run: \.\/luma deploy production --confirm$/u);
    return true;
  });
});

test("the database restore skips only the bootstrap superuser's CREATE ROLE", () => {
  const dump = [
    "CREATE ROLE cosmos;",
    "ALTER ROLE cosmos WITH SUPERUSER;",
    "COPY public.notes (id, body) FROM stdin;",
    "1\tCREATE ROLE cosmos;",
    "CREATE ROLE cosmos;",
    "\\.",
    "",
  ].join("\n");
  const filtered = spawnSync("awk", [DATABASE_RESTORE_FILTER], { input: dump, encoding: "utf8" });
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.equal(filtered.stdout, dump.split("\n").slice(1).join("\n"));
});

test("backup and restore are registered in both CLIs and the operator contract", () => {
  const cli = (...args) => spawnSync(process.execPath, [path.join(root, "luma"), ...args], { cwd: root, encoding: "utf8" });
  const backupHelp = cli("backup", "production", "--help");
  assert.equal(backupHelp.status, 0, backupHelp.stderr);
  assert.match(backupHelp.stdout, /Usage: luma backup production \[--output DIR\] \[--project-name NAME\]/u);
  assert.match(backupHelp.stdout, /Guide: README\.md#back-up-and-restore/u);
  const restoreHelp = cli("restore", "production", "--help");
  assert.equal(restoreHelp.status, 0, restoreHelp.stderr);
  assert.match(restoreHelp.stdout, /Usage: luma restore production --from DIR \[--confirm\]/u);
  assert.match(restoreHelp.stdout, /requires the command’s documented confirmation/u);
  assert.equal(cli("backup", "production", "--bogus").status, 64);
  assert.equal(cli("restore", "production").status, 64);

  const operator = spawnSync(process.execPath, [path.join(root, "platform", "distribution", "operator-luma"), "--help"], {
    encoding: "utf8",
  });
  assert.equal(operator.status, 0, operator.stderr);
  assert.match(operator.stdout, /\.\/luma backup production/u);
  assert.match(operator.stdout, /\.\/luma restore production --from DIR/u);

  const contract = JSON.parse(fs.readFileSync(path.join(root, "contracts", "operator-setup.json"), "utf8"));
  const commands = new Map(contract.commands.map((entry) => [entry.id, entry]));
  assert.equal(commands.get("backup.production").confirmationRequired, false);
  assert.equal(commands.get("restore.production").effect, "remote-mutation");
  assert.equal(commands.get("restore.production").confirmationRequired, true);
});
