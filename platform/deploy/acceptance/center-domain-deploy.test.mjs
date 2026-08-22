import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const helper = path.join(root, "platform/deploy/vps/remote/domain.py");
const commonLibrary = path.join(root, "platform/deploy/vps/remote/common.sh");
const domainLibrary = path.join(root, "platform/deploy/vps/remote/domain.sh");
const template = path.join(
  root,
  "platform/edge/nginx/ai-pin-revival-center.conf.template",
);
const streamTemplate = path.join(
  root,
  "platform/edge/nginx/ai-pin-revival-device-edge.stream.conf.template",
);
const deviceStream = "/etc/nginx/streams-enabled/ai-pin-revival-device-edge.conf";
const canonicalOrigin = "https://center.andersmadsen.dk";
const legacyOrigin = "https://carry.andersmadsen.dk";
const canonicalAvailable = "/etc/nginx/sites-available/ai-pin-revival-center";
const canonicalEnabled = "/etc/nginx/sites-enabled/ai-pin-revival-center";

function temporaryDirectory(context, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function sha256(filename) {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function runHelper(arguments_, { fails = false } = {}) {
  const result = spawnSync("python3", [helper, ...arguments_], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  if (fails) {
    assert.notEqual(
      result.status,
      0,
      `domain helper unexpectedly accepted: ${arguments_.join(" ")}`,
    );
  } else {
    assert.equal(
      result.status,
      0,
      `domain helper failed: ${arguments_.join(" ")}\n${result.stderr}`,
    );
  }
  return result;
}

function runDomainShell(source, environment = {}) {
  const result = spawnSync("bash", ["-c", source, "domain-fixture", domainLibrary, commonLibrary], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
  assert.equal(result.error, undefined);
  return result;
}

function assertSource(source, pattern, message) {
  assert.ok(pattern.test(source), message);
}

function expandedNginxSection(filename, certificate, privateKey) {
  return `# configuration file ${filename}:
server {
    listen 443 ssl http2;
    server_name carry.andersmadsen.dk;
    ssl_certificate ${certificate};
    ssl_certificate_key ${privateKey};
}
`;
}

function discoveryFixture(filename, legacyEnabledPath = "/etc/nginx/sites-enabled/cosmos") {
  writeJson(filename, {
    schemaVersion: 1,
    kind: "center-public-edge",
    legacyEnabledPath,
    certificatePath: "/etc/letsencrypt/live/andersmadsen.dk/fullchain.pem",
    privateKeyPath: "/etc/letsencrypt/live/andersmadsen.dk/privkey.pem",
  });
}

function rooted(filesystemRoot, absolutePath) {
  return path.join(filesystemRoot, absolutePath.slice(1));
}

function pathObjectExists(filename) {
  try {
    fs.lstatSync(filename);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function preparedNginxFixture(context, name) {
  const work = temporaryDirectory(context, name);
  const filesystemRoot = path.join(work, "root");
  const record = path.join(work, "record");
  const discovery = path.join(work, "discovery.json");
  const legacyAvailable = rooted(
    filesystemRoot,
    "/etc/nginx/sites-available/legacy-cosmos",
  );
  const legacyEnabled = rooted(filesystemRoot, "/etc/nginx/sites-enabled/cosmos");
  fs.mkdirSync(path.dirname(legacyAvailable), { recursive: true });
  fs.mkdirSync(path.dirname(legacyEnabled), { recursive: true });
  fs.writeFileSync(legacyAvailable, "# prior Cosmos vhost\n", { mode: 0o640 });
  fs.symlinkSync("../sites-available/legacy-cosmos", legacyEnabled);
  discoveryFixture(discovery);
  runHelper([
    "nginx-snapshot",
    "--record", record,
    "--discovery", discovery,
    "--filesystem-root", filesystemRoot,
  ]);
  runHelper([
    "nginx-render",
    "--record", record,
    "--template", template,
    "--stream-template", streamTemplate,
    "--discovery", discovery,
    "--center-port", "14000",
    "--keycloak-port", "8088",
    "--filesystem-root", filesystemRoot,
  ]);
  return {
    filesystemRoot,
    record,
    legacyAvailable,
    legacyEnabled,
    canonicalAvailable: rooted(filesystemRoot, canonicalAvailable),
    canonicalEnabled: rooted(filesystemRoot, canonicalEnabled),
    deviceStream: rooted(filesystemRoot, deviceStream),
    rendered: path.join(record, "domain-cutover/nginx/rendered.conf"),
    streamRendered: path.join(record, "domain-cutover/nginx/stream.conf"),
  };
}

// A record written before the device edge existed: three snapshot objects, no
// stream fields in DESIRED.json, and a rendered vhost that binds the public :443.
// This is what deploy.sh and rollback.sh hand the CURRENT helper when they roll
// back across this change, so it has to keep working — and it has to release the
// public :443 on the way, because the vhost it restores wants that port back.
function legacyRecordFrom(newRecord, work) {
  const source = path.join(newRecord, "domain-cutover/nginx");
  const record = path.join(work, "legacy-record");
  const directory = path.join(record, "domain-cutover/nginx");
  fs.mkdirSync(directory, { recursive: true });
  for (const name of ["canonicalAvailable.before", "legacyEnabled.before"]) {
    const from = path.join(source, name);
    if (!pathObjectExists(from)) continue;
    // The preserved copies may themselves be symlinks; following one here would
    // resolve it against the record directory and copy the wrong object.
    if (fs.lstatSync(from).isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(from), path.join(directory, name));
    } else {
      fs.copyFileSync(from, path.join(directory, name));
    }
  }
  fs.symlinkSync(canonicalAvailable, path.join(directory, "canonicalEnabled.before"));
  const snapshot = readJson(path.join(source, "SNAPSHOT.json"));
  delete snapshot.objects.deviceStream;
  writeJson(path.join(directory, "SNAPSHOT.json"), snapshot);
  // What the pre-change release rendered: a vhost that owns the public :443.
  fs.writeFileSync(
    path.join(directory, "rendered.conf"),
    "server {\n    listen 443 ssl http2;\n    listen [::]:443 ssl http2;\n"
      + "    server_name center.andersmadsen.dk carry.andersmadsen.dk;\n}\n",
    { mode: 0o600 },
  );
  const desired = readJson(path.join(source, "DESIRED.json"));
  delete desired.streamRenderedSha256;
  delete desired.streamEnabledPath;
  desired.renderedSha256 = sha256(path.join(directory, "rendered.conf"));
  writeJson(path.join(directory, "DESIRED.json"), desired);
  return record;
}

function cloudflaredConfig({ center = null, catchalls = 1, catchallFirst = false } = {}) {
  const rules = [
    ["carry.andersmadsen.dk", "http://localhost:80"],
    ["aipin.andersmadsen.dk", "http://localhost:18080"],
    ...Array.from({ length: 9 }, (_, index) => [
      `service-${index + 2}.andersmadsen.dk`,
      `http://localhost:${18100 + index}`,
    ]),
  ];
  const explicit = rules.map(([hostname, service], index) => [
    `  # preserved explicit rule ${index}`,
    `  - hostname: ${hostname}`,
    `    service: ${service}`,
    ...(index === 3 ? ["    originRequest:", "      connectTimeout: 10s"] : []),
  ].join("\n"));
  if (center !== null) {
    explicit.push([
      "  - hostname: center.andersmadsen.dk",
      `    service: ${center}`,
    ].join("\n"));
  }
  const fallback = Array.from(
    { length: catchalls },
    () => "  - service: http_status:404",
  );
  const ingress = catchallFirst ? [...fallback, ...explicit] : [...explicit, ...fallback];
  return [
    "tunnel: 11111111-2222-3333-4444-555555555555",
    "credentials-file: /home/anders/.cloudflared/11111111-2222-3333-4444-555555555555.json",
    "",
    "ingress:",
    ...ingress,
    "",
  ].join("\n");
}

function preparedCloudflaredFixture(context, name, config = cloudflaredConfig()) {
  const work = temporaryDirectory(context, name);
  const filesystemRoot = path.join(work, "root");
  const record = path.join(work, "record");
  const live = rooted(filesystemRoot, "/home/anders/.cloudflared/config.yml");
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.writeFileSync(live, config, { mode: 0o640 });
  runHelper([
    "cloudflared-prepare",
    "--record", record,
    "--filesystem-root", filesystemRoot,
  ]);
  return { work, filesystemRoot, record, live, config };
}

// implemented: this fixture proves the fail-closed discovery behavior of the
// independently authored deployment helper; it is not a claim about Humane's
// private infrastructure.
test("[implemented] discovery accepts exactly one enabled legacy Cosmos TLS vhost", (context) => {
  const work = temporaryDirectory(context, "center-domain-discovery");
  const input = path.join(work, "nginx-expanded.conf");
  const output = path.join(work, "discovery.json");
  fs.writeFileSync(
    input,
    [
      expandedNginxSection(
        "/etc/nginx/sites-enabled/cosmos",
        "/etc/letsencrypt/live/andersmadsen.dk/fullchain.pem",
        "/etc/letsencrypt/live/andersmadsen.dk/privkey.pem",
      ),
      "# configuration file /etc/nginx/sites-enabled/unrelated:\nserver { server_name unrelated.example; }\n",
    ].join(""),
  );

  runHelper(["discover-nginx", "--input", input, "--output", output]);

  assert.deepEqual(readJson(output), {
    schemaVersion: 1,
    kind: "center-public-edge",
    legacyEnabledPath: "/etc/nginx/sites-enabled/cosmos",
    certificatePath: "/etc/letsencrypt/live/andersmadsen.dk/fullchain.pem",
    privateKeyPath: "/etc/letsencrypt/live/andersmadsen.dk/privkey.pem",
  });
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
});

test("[implemented] discovery rejects ambiguous legacy Cosmos TLS ownership", (context) => {
  const work = temporaryDirectory(context, "center-domain-ambiguous");
  const input = path.join(work, "nginx-expanded.conf");
  const output = path.join(work, "discovery.json");
  fs.writeFileSync(
    input,
    [
      expandedNginxSection(
        "/etc/nginx/sites-enabled/cosmos-a",
        "/etc/letsencrypt/live/a/fullchain.pem",
        "/etc/letsencrypt/live/a/privkey.pem",
      ),
      expandedNginxSection(
        "/etc/nginx/sites-enabled/cosmos-b",
        "/etc/letsencrypt/live/b/fullchain.pem",
        "/etc/letsencrypt/live/b/privkey.pem",
      ),
    ].join(""),
  );

  const result = runHelper(
    ["discover-nginx", "--input", input, "--output", output],
    { fails: true },
  );
  assert.match(result.stderr, /expected one enabled Cosmos TLS vhost, found 2/);
  assert.equal(fs.existsSync(output), false);
});

test("[implemented] later deployments reuse the authoritative edge discovery", (context) => {
  const work = temporaryDirectory(context, "center-domain-reuse");
  const previous = path.join(work, "previous.json");
  const output = path.join(work, "selected.json");
  discoveryFixture(previous, canonicalEnabled);

  const result = runDomainShell(String.raw`
set -euo pipefail
source "$2"
source "$1"
domain_select_public_edge "$OUTPUT" "$PREVIOUS"
`, { PREVIOUS: previous, OUTPUT: output });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readJson(output), readJson(previous));
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
});

test("[implemented] strict render and Nginx file transaction resume and restore exactly", (context) => {
  const work = temporaryDirectory(context, "center-domain-nginx-transaction");
  const filesystemRoot = path.join(work, "root");
  const record = path.join(work, "record");
  const discovery = path.join(work, "discovery.json");
  const legacyAvailable = rooted(
    filesystemRoot,
    "/etc/nginx/sites-available/legacy-cosmos",
  );
  const legacyEnabled = rooted(filesystemRoot, "/etc/nginx/sites-enabled/cosmos");
  fs.mkdirSync(path.dirname(legacyAvailable), { recursive: true });
  fs.mkdirSync(path.dirname(legacyEnabled), { recursive: true });
  fs.writeFileSync(legacyAvailable, "# prior Cosmos vhost\n", { mode: 0o640 });
  fs.symlinkSync("../sites-available/legacy-cosmos", legacyEnabled);
  discoveryFixture(discovery);

  runHelper([
    "nginx-snapshot",
    "--record", record,
    "--discovery", discovery,
    "--filesystem-root", filesystemRoot,
  ]);
  const snapshot = readJson(
    path.join(record, "domain-cutover/nginx/SNAPSHOT.json"),
  );
  assert.equal(snapshot.objects.canonicalAvailable.type, "absent");
  assert.equal(snapshot.objects.canonicalEnabled.type, "absent");
  assert.equal(snapshot.objects.legacyEnabled.type, "symlink");
  assert.equal(
    snapshot.objects.legacyEnabled.target,
    "../sites-available/legacy-cosmos",
  );

  const tamperedTemplate = path.join(work, "tampered.conf.template");
  fs.writeFileSync(
    tamperedTemplate,
    fs.readFileSync(template, "utf8").replace(
      "@@REVIVAL_CENTER_PORT@@",
      "@@REVIVAL_CENTER_PORT@@ @@REVIVAL_CENTER_PORT@@",
    ),
  );
  const tokenFailure = runHelper([
    "nginx-render",
    "--record", record,
    "--template", tamperedTemplate,
    "--stream-template", streamTemplate,
    "--discovery", discovery,
    "--center-port", "14000",
    "--keycloak-port", "8088",
    "--filesystem-root", filesystemRoot,
  ], { fails: true });
  assert.match(tokenFailure.stderr, /template token count differs: REVIVAL_CENTER_PORT/);

  const unresolvedTemplate = path.join(work, "unresolved.conf.template");
  fs.writeFileSync(
    unresolvedTemplate,
    `${fs.readFileSync(template, "utf8")}\n# \${UNRESOLVED}\n`,
  );
  const unresolvedFailure = runHelper([
    "nginx-render",
    "--record", record,
    "--template", unresolvedTemplate,
    "--stream-template", streamTemplate,
    "--discovery", discovery,
    "--center-port", "14000",
    "--keycloak-port", "8088",
    "--filesystem-root", filesystemRoot,
  ], { fails: true });
  assert.match(unresolvedFailure.stderr, /retained an unresolved token/);

  runHelper([
    "nginx-render",
    "--record", record,
    "--template", template,
    "--stream-template", streamTemplate,
    "--discovery", discovery,
    "--center-port", "14000",
    "--keycloak-port", "8088",
    "--filesystem-root", filesystemRoot,
  ]);
  const rendered = fs.readFileSync(
    path.join(record, "domain-cutover/nginx/rendered.conf"),
    "utf8",
  );
  assert.doesNotMatch(rendered, /@@[A-Z0-9_]+@@|\$\{/);
  assert.match(rendered, /127\.0\.0\.1:14000/);
  assert.match(rendered, /127\.0\.0\.1:8088/);
  assert.equal((rendered.match(/fullchain\.pem/g) ?? []).length, 2);
  assert.equal((rendered.match(/privkey\.pem/g) ?? []).length, 2);

  const install = [
    "nginx-install-files",
    "--record", record,
    "--filesystem-root", filesystemRoot,
  ];
  runHelper(install);
  assert.equal(
    fs.readFileSync(rooted(filesystemRoot, canonicalAvailable), "utf8"),
    rendered,
  );
  assert.equal(
    fs.readlinkSync(rooted(filesystemRoot, canonicalEnabled)),
    canonicalAvailable,
  );
  assert.equal(pathObjectExists(legacyEnabled), false);

  const missingMarker = runHelper([
    "nginx-verify-desired",
    "--record", record,
    "--filesystem-root", filesystemRoot,
    "--require-marker",
  ], { fails: true });
  assert.match(missingMarker.stderr, /INSTALLED\.json|installation marker|No such file/);

  // Re-entering after files were installed but before the durable marker is
  // intentionally safe and converges on the same exact state.
  runHelper(install);
  runHelper([
    "nginx-mark-installed",
    "--record", record,
    "--filesystem-root", filesystemRoot,
  ]);
  runHelper([
    "nginx-verify-desired",
    "--record", record,
    "--filesystem-root", filesystemRoot,
    "--require-marker",
  ]);

  fs.appendFileSync(rooted(filesystemRoot, canonicalAvailable), "# drift\n");
  const liveTamper = runHelper([
    "nginx-verify-desired",
    "--record", record,
    "--filesystem-root", filesystemRoot,
    "--require-marker",
  ], { fails: true });
  assert.match(liveTamper.stderr, /live Center Nginx configuration differs from desired/);

  const unsafeRestore = runHelper([
    "nginx-restore-files",
    "--record", record,
    "--filesystem-root", filesystemRoot,
  ], { fails: true });
  assert.match(unsafeRestore.stderr, /differs from every captured, desired/);

  // Return to the exact desired state; rollback may then restore the snapshot.
  fs.copyFileSync(
    path.join(record, "domain-cutover/nginx/rendered.conf"),
    rooted(filesystemRoot, canonicalAvailable),
  );
  fs.chmodSync(rooted(filesystemRoot, canonicalAvailable), 0o644);

  runHelper([
    "nginx-restore-files",
    "--record", record,
    "--filesystem-root", filesystemRoot,
  ]);
  runHelper([
    "nginx-verify-before",
    "--record", record,
    "--filesystem-root", filesystemRoot,
  ]);
  assert.equal(pathObjectExists(rooted(filesystemRoot, canonicalAvailable)), false);
  assert.equal(pathObjectExists(rooted(filesystemRoot, canonicalEnabled)), false);
  assert.equal(fs.lstatSync(legacyEnabled).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(legacyEnabled), "../sites-available/legacy-cosmos");
  assert.equal(fs.readFileSync(legacyAvailable, "utf8"), "# prior Cosmos vhost\n");
  assert.equal(fs.statSync(legacyAvailable).mode & 0o777, 0o640);
});

test("[implemented] Nginx install rejects a live preimage changed after snapshot", (context) => {
  const fixture = preparedNginxFixture(context, "center-domain-nginx-preimage-drift");
  const competingAvailable = rooted(
    fixture.filesystemRoot,
    "/etc/nginx/sites-available/competing-center-owner",
  );
  fs.writeFileSync(competingAvailable, "# concurrent operator state\n", { mode: 0o640 });
  fs.unlinkSync(fixture.legacyEnabled);
  fs.symlinkSync("../sites-available/competing-center-owner", fixture.legacyEnabled);

  const result = runHelper([
    "nginx-install-files",
    "--record", fixture.record,
    "--filesystem-root", fixture.filesystemRoot,
  ], { fails: true });

  assert.match(result.stderr, /differs from both its captured preimage/);
  assert.equal(pathObjectExists(fixture.canonicalAvailable), false);
  assert.equal(pathObjectExists(fixture.canonicalEnabled), false);
  assert.equal(
    fs.readlinkSync(fixture.legacyEnabled),
    "../sites-available/competing-center-owner",
  );
});

test("[implemented] Nginx install resumes only exact ordered partial states", (context) => {
  for (const partial of ["available", "enabled"]) {
    const fixture = preparedNginxFixture(
      context,
      `center-domain-nginx-partial-${partial}`,
    );
    fs.copyFileSync(fixture.rendered, fixture.canonicalAvailable);
    fs.chmodSync(fixture.canonicalAvailable, 0o644);
    if (partial === "enabled") {
      fs.symlinkSync(canonicalAvailable, fixture.canonicalEnabled);
    }

    runHelper([
      "nginx-install-files",
      "--record", fixture.record,
      "--filesystem-root", fixture.filesystemRoot,
    ]);

    assert.equal(fs.readFileSync(fixture.canonicalAvailable, "utf8"), fs.readFileSync(fixture.rendered, "utf8"));
    assert.equal(fs.readlinkSync(fixture.canonicalEnabled), canonicalAvailable);
    assert.equal(pathObjectExists(fixture.legacyEnabled), false);
  }
});

test("[implemented] Nginx restore resumes an exact reverse partial state", (context) => {
  const fixture = preparedNginxFixture(context, "center-domain-nginx-restore-partial");
  fs.copyFileSync(fixture.rendered, fixture.canonicalAvailable);
  fs.chmodSync(fixture.canonicalAvailable, 0o644);
  fs.unlinkSync(fixture.legacyEnabled);

  runHelper([
    "nginx-restore-files",
    "--record", fixture.record,
    "--filesystem-root", fixture.filesystemRoot,
  ]);
  runHelper([
    "nginx-verify-before",
    "--record", fixture.record,
    "--filesystem-root", fixture.filesystemRoot,
  ]);

  assert.equal(pathObjectExists(fixture.canonicalAvailable), false);
  assert.equal(pathObjectExists(fixture.canonicalEnabled), false);
  assert.equal(
    fs.readlinkSync(fixture.legacyEnabled),
    "../sites-available/legacy-cosmos",
  );
});

test("[implemented] the public :443 stream is installed last and released first", (context) => {
  // Nginx binds a given address:port exactly once across its http and stream
  // contexts, so while the Center vhost still claims the public :443 the stream
  // file makes the master fail to bind — every vhost on the host, not just this
  // project. The ordering below is what guarantees no crash-observable on-disk
  // state has both owners: the stream is the LAST write of the install and the
  // FIRST removal of the restore.
  const fixture = preparedNginxFixture(context, "center-domain-nginx-stream-order");
  runHelper([
    "nginx-install-files",
    "--record", fixture.record,
    "--filesystem-root", fixture.filesystemRoot,
  ]);
  assert.equal(pathObjectExists(fixture.deviceStream), true);
  assert.equal(sha256(fixture.deviceStream), sha256(fixture.streamRendered));
  assert.match(fs.readFileSync(fixture.deviceStream, "utf8"), /^[ \t]*ssl_preread[ \t]+on;$/m);
  assert.doesNotMatch(fs.readFileSync(fixture.canonicalAvailable, "utf8"), /(?:^|[{;])[ \t]*listen[ \t]+(?:\[::\]:)?443\b/m);

  // Losing the last write is the only partial state the install may resume into,
  // and it must resume into the desired one rather than declare itself finished.
  fs.unlinkSync(fixture.deviceStream);
  runHelper([
    "nginx-verify-desired",
    "--record", fixture.record,
    "--filesystem-root", fixture.filesystemRoot,
  ], { fails: true });
  runHelper([
    "nginx-install-files",
    "--record", fixture.record,
    "--filesystem-root", fixture.filesystemRoot,
  ]);
  assert.equal(pathObjectExists(fixture.deviceStream), true);

  runHelper([
    "nginx-restore-files",
    "--record", fixture.record,
    "--filesystem-root", fixture.filesystemRoot,
  ]);
  assert.equal(pathObjectExists(fixture.deviceStream), false);
  runHelper([
    "nginx-verify-before",
    "--record", fixture.record,
    "--filesystem-root", fixture.filesystemRoot,
  ]);
});

test("[implemented] a record that predates the device edge releases the public :443", (context) => {
  const fixture = preparedNginxFixture(context, "center-domain-nginx-legacy-record");
  runHelper([
    "nginx-install-files",
    "--record", fixture.record,
    "--filesystem-root", fixture.filesystemRoot,
  ]);
  assert.equal(pathObjectExists(fixture.deviceStream), true);
  const legacyRecord = legacyRecordFrom(fixture.record, path.dirname(fixture.record));

  // Reapplying an old record over the live new topology is not a resumable phase
  // of that record's transaction, and refusing it must cost nothing: the stream
  // still owns :443 afterwards rather than the port being left with no owner.
  runHelper([
    "nginx-install-files",
    "--record", legacyRecord,
    "--filesystem-root", fixture.filesystemRoot,
  ], { fails: true });
  assert.equal(pathObjectExists(fixture.deviceStream), true);

  runHelper([
    "nginx-restore-files",
    "--record", fixture.record,
    "--filesystem-root", fixture.filesystemRoot,
  ]);
  runHelper([
    "nginx-install-files",
    "--record", legacyRecord,
    "--filesystem-root", fixture.filesystemRoot,
  ]);
  // The old record's vhost binds the public :443 again, so the stream must be
  // gone; leaving it is the bind failure this whole ordering exists to prevent.
  assert.equal(pathObjectExists(fixture.deviceStream), false);
  assert.match(
    fs.readFileSync(fixture.canonicalAvailable, "utf8"),
    /(?:^|[{;])[ \t]*listen[ \t]+443\b/m,
  );
  runHelper([
    "nginx-mark-installed",
    "--record", legacyRecord,
    "--filesystem-root", fixture.filesystemRoot,
  ]);
  runHelper([
    "nginx-verify-desired",
    "--record", legacyRecord,
    "--filesystem-root", fixture.filesystemRoot,
    "--require-marker",
  ]);

  // And the same record must refuse to verify while the stream is back beside it.
  fs.mkdirSync(path.dirname(fixture.deviceStream), { recursive: true });
  fs.copyFileSync(fixture.streamRendered, fixture.deviceStream);
  const collision = runHelper([
    "nginx-verify-desired",
    "--record", legacyRecord,
    "--filesystem-root", fixture.filesystemRoot,
    "--require-marker",
  ], { fails: true });
  assert.match(collision.stderr, /device edge stream is installed beside a deployment record that predates it/);
});

test("[implemented] the public :443 owner check refuses what nginx -t reports as OK", (context) => {
  // `nginx -t` answers "syntax is ok" for a configuration whose http and stream
  // contexts both bind 0.0.0.0:443 and the master only fails when it tries to
  // bind — which is how the previous attempt at this port took the site down.
  // This check reads the expanded configuration instead, between nginx -t and
  // the reload, so the failure costs a deploy step rather than the host.
  const work = temporaryDirectory(context, "center-domain-443-owner");
  const vhost443 = "server {\n    listen 443 ssl http2;\n    server_name center.andersmadsen.dk;\n}\n";
  const vhostLoopback = "server {\n    listen 127.0.0.1:8444 ssl http2;\n    server_name center.andersmadsen.dk;\n}\n";
  const streamBody = "server {\n    listen 443;\n    ssl_preread on;\n    proxy_pass $ai_pin_revival_443_backend;\n}\n";
  const dump = (sections) => {
    const filename = path.join(work, `expanded-${Object.keys(sections).length}-${Math.random()}.txt`);
    fs.writeFileSync(
      filename,
      Object.entries(sections)
        .map(([name, body]) => `# configuration file ${name}:\n${body}`)
        .join("\n"),
    );
    return filename;
  };
  const check = (sections, options) => runHelper(
    ["nginx-assert-443-owner", "--input", dump(sections)],
    options,
  );

  check({ [canonicalEnabled]: vhost443 });
  check({ [canonicalEnabled]: vhostLoopback, [deviceStream]: streamBody });
  assert.match(
    check({ [canonicalEnabled]: vhost443, [deviceStream]: streamBody }, { fails: true }).stderr,
    /more than one owner/,
  );
  assert.match(
    check({ [canonicalEnabled]: vhostLoopback }, { fails: true }).stderr,
    /no file in the expanded Nginx configuration binds the public :443/,
  );
  assert.match(
    check({
      [canonicalEnabled]: vhostLoopback,
      [deviceStream]: streamBody.replace("ssl_preread on;", "ssl_certificate /etc/ssl/x.crt;"),
    }, { fails: true }).stderr,
    /without ssl_preread/,
  );
  /*
   * The half-applied state, which is neither "two owners" nor "no owner": the
   * device edge stream file is INSTALLED but has stopped binding :443 — rendered
   * with its server block truncated, or commented out by hand during an
   * incident — while the Center vhost still holds the port. Exactly one file
   * owns :443, so the collision and the orphan checks above are both satisfied,
   * `nginx -t` is happy, and nginx reloads cleanly. The device plane is dead
   * anyway: every clone gateway now resolves to a vhost that terminates TLS
   * itself, so the Pin's client certificate never reaches Envoy and mTLS ends at
   * the wrong hop with no request ever logged.
   *
   * This is the branch the ordered-write transaction exists to make survivable,
   * and it was the one branch of this check with no test: neutering it left both
   * center-domain suites green.
   */
  for (const [name, brokenStream] of [
    ["commented out", "# server {\n#     listen 443;\n#     ssl_preread on;\n# }\n"],
    ["truncated before its server block", "upstream ai_pin_revival_device_edge {\n    server 127.0.0.1:18443 max_fails=0;\n}\n"],
    ["moved off the public bind", "server {\n    listen 127.0.0.1:9443;\n    ssl_preread on;\n}\n"],
  ]) {
    const stderr = check({ [canonicalEnabled]: vhost443, [deviceStream]: brokenStream }, { fails: true }).stderr;
    assert.match(
      stderr,
      /the device edge stream is installed but .+ owns the public :443/,
      `a device edge stream ${name} must not leave the Center vhost owning :443`,
    );
    // Name the file that took the port. "Something else owns it" is not
    // actionable at 03:00 on a host with a dozen vhosts.
    assert.ok(stderr.includes(canonicalEnabled), `the refusal must name the file that owns :443: ${stderr}`);
  }

  // Formatting must not be able to hide an owner, and a commented-out listen
  // must not be able to invent one.
  assert.match(
    check({
      [canonicalEnabled]: "server { listen 443 ssl; }\n",
      [deviceStream]: streamBody,
    }, { fails: true }).stderr,
    /more than one owner/,
  );
  assert.match(
    check({
      [canonicalEnabled]: "server {\n    # listen 443 ssl default_server;\n    listen 80;\n}\n",
    }, { fails: true }).stderr,
    /no file in the expanded Nginx configuration binds the public :443/,
  );
});

test("[implemented] Cloudflared route transaction preserves all prior bytes and restores exactly", (context) => {
  const fixture = preparedCloudflaredFixture(context, "center-domain-cloudflared");
  const directory = path.join(fixture.record, "domain-cutover/cloudflared");
  const before = fs.readFileSync(path.join(directory, "before.yml"), "utf8");
  const desired = fs.readFileSync(path.join(directory, "desired.yml"), "utf8");
  const journal = readJson(path.join(directory, "JOURNAL.json"));
  const stanza = [
    "  - hostname: center.andersmadsen.dk",
    "    service: http://localhost:80",
    "",
  ].join("\n");

  assert.equal(before, fixture.config);
  assert.equal(desired.replace(stanza, ""), before);
  assert.equal(
    desired.indexOf(stanza) + stanza.length,
    desired.indexOf("  - service: http_status:404"),
  );
  assert.equal(journal.configPath, "/home/anders/.cloudflared/config.yml");
  assert.equal(journal.beforeRoute, "catchall");
  assert.equal(journal.before.mode, 0o640);
  assert.equal(journal.before.uid, fs.statSync(fixture.live).uid);
  assert.equal(journal.before.gid, fs.statSync(fixture.live).gid);
  assert.equal(journal.before.sha256, sha256(path.join(directory, "before.yml")));
  assert.equal(journal.desired.sha256, sha256(path.join(directory, "desired.yml")));
  assert.equal(fs.readFileSync(fixture.live, "utf8"), before);

  const install = [
    "cloudflared-install",
    "--record", fixture.record,
    "--filesystem-root", fixture.filesystemRoot,
  ];
  runHelper(install);
  assert.equal(fs.readFileSync(fixture.live, "utf8"), desired);
  assert.equal(fs.statSync(fixture.live).mode & 0o777, 0o640);

  // Desired-on-disk but not yet validated/activated is the only partial phase;
  // reentry is an exact no-op and can safely repeat validation in domain.sh.
  runHelper(install);
  runHelper([
    "cloudflared-mark",
    "--record", fixture.record,
    "--filesystem-root", fixture.filesystemRoot,
    "--state", "desired",
  ]);
  runHelper([
    "cloudflared-verify",
    "--record", fixture.record,
    "--filesystem-root", fixture.filesystemRoot,
    "--state", "desired",
    "--require-marker",
  ]);

  runHelper([
    "cloudflared-restore",
    "--record", fixture.record,
    "--filesystem-root", fixture.filesystemRoot,
  ]);
  runHelper([
    "cloudflared-restore",
    "--record", fixture.record,
    "--filesystem-root", fixture.filesystemRoot,
  ]);
  runHelper([
    "cloudflared-mark",
    "--record", fixture.record,
    "--filesystem-root", fixture.filesystemRoot,
    "--state", "before",
  ]);
  runHelper([
    "cloudflared-verify",
    "--record", fixture.record,
    "--filesystem-root", fixture.filesystemRoot,
    "--state", "before",
    "--require-marker",
  ]);
  assert.equal(fs.readFileSync(fixture.live, "utf8"), before);
  assert.equal(fs.statSync(fixture.live).mode & 0o777, 0o640);

  fs.appendFileSync(fixture.live, "# concurrent operator drift\n");
  const drift = runHelper(install, { fails: true });
  assert.match(drift.stderr, /matches neither exact transaction state/);
  assert.match(fs.readFileSync(fixture.live, "utf8"), /concurrent operator drift/);
});

test("[implemented] Cloudflared preparation rejects ambiguous routing and accepts exact redeploy", (context) => {
  const invalid = [
    ["missing catch-all", cloudflaredConfig({ catchalls: 0 }), /expected one exact Cloudflared catch-all, found 0/],
    ["ambiguous catch-all", cloudflaredConfig({ catchalls: 2 }), /expected one exact Cloudflared catch-all, found 2/],
    ["non-final catch-all", cloudflaredConfig({ catchallFirst: true }), /catch-all is not the final ingress rule/],
    ["conflicting Center", cloudflaredConfig({ center: "http://localhost:9999" }), /conflicting Center rule/],
    [
      "duplicate Center",
      cloudflaredConfig({ center: "http://localhost:80" }).replace(
        "  - service: http_status:404",
        "  - hostname: center.andersmadsen.dk\n    service: http://localhost:80\n  - service: http_status:404",
      ),
      /duplicate Center rules/,
    ],
    [
      "wildcard Center",
      cloudflaredConfig().replace(
        "  - service: http_status:404",
        "  - hostname: '*.andersmadsen.dk'\n    service: http://localhost:9999\n  - service: http_status:404",
      ),
      /wildcard conflicting with Center/,
    ],
  ];
  for (const [name, config, pattern] of invalid) {
    const work = temporaryDirectory(context, `center-domain-cloudflared-${name.replaceAll(" ", "-")}`);
    const filesystemRoot = path.join(work, "root");
    const live = rooted(filesystemRoot, "/home/anders/.cloudflared/config.yml");
    fs.mkdirSync(path.dirname(live), { recursive: true });
    fs.writeFileSync(live, config, { mode: 0o640 });
    const result = runHelper([
      "cloudflared-prepare",
      "--record", path.join(work, "record"),
      "--filesystem-root", filesystemRoot,
    ], { fails: true });
    assert.match(result.stderr, pattern, name);
  }

  const redeploy = preparedCloudflaredFixture(
    context,
    "center-domain-cloudflared-redeploy",
    cloudflaredConfig({ center: "http://localhost:80" }),
  );
  const directory = path.join(redeploy.record, "domain-cutover/cloudflared");
  assert.equal(readJson(path.join(directory, "JOURNAL.json")).beforeRoute, "center");
  assert.equal(
    fs.readFileSync(path.join(directory, "before.yml"), "utf8"),
    fs.readFileSync(path.join(directory, "desired.yml"), "utf8"),
  );
  runHelper([
    "cloudflared-install",
    "--record", redeploy.record,
    "--filesystem-root", redeploy.filesystemRoot,
  ]);
  runHelper([
    "cloudflared-restore",
    "--record", redeploy.record,
    "--filesystem-root", redeploy.filesystemRoot,
  ]);
  assert.equal(fs.readFileSync(redeploy.live, "utf8"), redeploy.config);
});

test("[implemented] Cloudflared CLI validation and rule selection are bounded and fail closed", (context) => {
  const work = temporaryDirectory(context, "center-domain-cloudflared-cli");
  const binary = path.join(work, "cloudflared");
  const config = path.join(work, "config.yml");
  fs.writeFileSync(config, cloudflaredConfig(), { mode: 0o600 });
  fs.writeFileSync(binary, `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == tunnel && "$2" == --config && "$3" == "$CLOUDFLARED_FAKE_CONFIG" && "$4" == ingress ]]
if [[ "$5" == validate ]]; then
  [[ "\${CLOUDFLARED_FAIL_VALIDATE:-0}" == 0 ]]
  exit
fi
[[ "$5" == rule && -n "\${6:-}" ]]
[[ "\${CLOUDFLARED_FAIL_RULE:-0}" == 0 ]] || exit 9
if [[ "$6" == https://center.andersmadsen.dk/ && "\${CLOUDFLARED_ROUTE:-desired}" == desired ]]; then
  printf 'Matched rule #11\\n  hostname: center.andersmadsen.dk\\n  service: %s\\n' "\${CLOUDFLARED_SERVICE:-http://localhost:80}"
elif [[ "$6" == https://center.andersmadsen.dk/ ]]; then
  printf 'Matched rule #11\\n  service: http_status:404\\n'
else
  printf 'Matched rule #12\\n  service: http_status:404\\n'
fi
`, { mode: 0o700 });
  const source = String.raw`
set -euo pipefail
source "$1"
DOMAIN_CLOUDFLARED_BIN="$CLOUDFLARED_FAKE_BIN"
DOMAIN_CLOUDFLARED_CONFIG="$CLOUDFLARED_FAKE_CONFIG"
stat() { wc -c <"$3" | tr -d ' '; }
domain_cloudflared_validate_state "$CLOUDFLARED_EXPECTED_STATE"
`;
  const base = {
    CLOUDFLARED_FAKE_BIN: binary,
    CLOUDFLARED_FAKE_CONFIG: config,
    CLOUDFLARED_EXPECTED_STATE: "desired",
  };
  assert.equal(runDomainShell(source, base).status, 0);
  assert.equal(runDomainShell(source, { ...base, CLOUDFLARED_ROUTE: "before", CLOUDFLARED_EXPECTED_STATE: "before" }).status, 0);

  const validationFailure = runDomainShell(source, { ...base, CLOUDFLARED_FAIL_VALIDATE: "1" });
  assert.notEqual(validationFailure.status, 0);
  assert.match(validationFailure.stderr, /bounded Cloudflared ingress command failed: validate/);

  const ruleFailure = runDomainShell(source, { ...base, CLOUDFLARED_FAIL_RULE: "1" });
  assert.notEqual(ruleFailure.status, 0);
  assert.match(ruleFailure.stderr, /bounded Cloudflared ingress command failed: rule/);

  const wrongService = runDomainShell(source, { ...base, CLOUDFLARED_SERVICE: "http://localhost:9999" });
  assert.notEqual(wrongService.status, 0);
  assert.match(wrongService.stderr, /selected an unexpected route/);
});

test("[implemented] Keycloak client migration is exact, secret-free, and backup-bound", (context) => {
  const work = temporaryDirectory(context, "center-domain-keycloak");
  const record = path.join(work, "record");
  const beforePath = path.join(work, "before-live.json");
  const backupManifest = path.join(work, "backup-manifest.json");
  const before = {
    id: "8db44a9c-bd6d-4b44-83b7-4c7ab0a5d441",
    clientId: "center",
    name: "Old Center",
    enabled: true,
    protocol: "openid-connect",
    publicClient: false,
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    serviceAccountsEnabled: false,
    rootUrl: legacyOrigin,
    baseUrl: legacyOrigin,
    adminUrl: legacyOrigin,
    redirectUris: ["*", `${legacyOrigin}/api/auth/callback/humane`],
    webOrigins: ["+", legacyOrigin],
    attributes: {
      "pkce.code.challenge.method": "plain",
      "post.logout.redirect.uris": "*",
      "unrelated.setting": "preserved",
    },
    protocolMappers: [{ id: "mapper-1", name: "preserved mapper" }],
    secret: "must-not-enter-the-journal",
    registrationAccessToken: "must-also-be-removed",
  };
  writeJson(beforePath, before);
  writeJson(backupManifest, {
    schemaVersion: 1,
    kind: "deployment-backup",
    releaseId: "a".repeat(64),
  });

  const prepare = [
    "client-prepare",
    "--before", beforePath,
    "--record", record,
    "--backup-manifest", backupManifest,
  ];
  runHelper(prepare);

  const directory = path.join(record, "domain-cutover/keycloak");
  const storedBefore = readJson(path.join(directory, "before.json"));
  const desired = readJson(path.join(directory, "desired.json"));
  const journal = readJson(path.join(directory, "JOURNAL.json"));
  assert.equal("secret" in storedBefore, false);
  assert.equal("registrationAccessToken" in storedBefore, false);
  assert.equal("secret" in desired, false);
  assert.equal("registrationAccessToken" in desired, false);
  assert.equal(desired.rootUrl, canonicalOrigin);
  assert.equal(desired.baseUrl, canonicalOrigin);
  assert.equal(desired.adminUrl, canonicalOrigin);
  assert.deepEqual(desired.redirectUris, [
    `${canonicalOrigin}/api/auth/callback/humane`,
  ]);
  assert.deepEqual(desired.webOrigins, [canonicalOrigin]);
  assert.equal(desired.attributes["pkce.code.challenge.method"], "S256");
  assert.equal(
    desired.attributes["post.logout.redirect.uris"],
    `${canonicalOrigin}/login`,
  );
  assert.equal(desired.attributes["unrelated.setting"], "preserved");
  assert.deepEqual(desired.protocolMappers, before.protocolMappers);
  const browserSurface = JSON.stringify({
    rootUrl: desired.rootUrl,
    baseUrl: desired.baseUrl,
    adminUrl: desired.adminUrl,
    redirectUris: desired.redirectUris,
    webOrigins: desired.webOrigins,
    logout: desired.attributes["post.logout.redirect.uris"],
  });
  assert.doesNotMatch(browserSurface, /\*|"\+"|cosmos\.andersmadsen\.dk/);
  assert.equal(journal.backupManifest, fs.realpathSync(backupManifest));
  assert.equal(journal.backupManifestSha256, sha256(backupManifest));
  assert.equal(journal.beforeSha256, sha256(path.join(directory, "before.json")));
  assert.equal(journal.desiredSha256, sha256(path.join(directory, "desired.json")));

  // The same preimage and backup binding is a resumable no-op.
  runHelper(prepare);

  const actualDesired = path.join(work, "actual-desired.json");
  writeJson(actualDesired, {
    ...desired,
    secret: "live-only-secret",
    registrationAccessToken: "live-only-registration-token",
  });
  runHelper([
    "client-verify",
    "--record", record,
    "--which", "desired",
    "--actual", actualDesired,
  ]);
  runHelper(["client-mark", "--record", record, "--state", "applied"]);
  runHelper([
    "client-check-marker",
    "--record", record,
    "--state", "applied",
  ]);

  const conflictingBefore = path.join(work, "conflicting-before.json");
  writeJson(conflictingBefore, { ...before, protocolMappers: [] });
  const conflict = runHelper([
    "client-prepare",
    "--before", conflictingBefore,
    "--record", record,
    "--backup-manifest", backupManifest,
  ], { fails: true });
  assert.match(conflict.stderr, /journal conflicts with the requested state/);

  writeJson(backupManifest, {
    schemaVersion: 1,
    kind: "deployment-backup",
    releaseId: "b".repeat(64),
  });
  const tamper = runHelper([
    "client-check-marker",
    "--record", record,
    "--state", "applied",
  ], { fails: true });
  assert.match(tamper.stderr, /backup binding drift/);
});

test("[implemented] DNS readiness uses public system answers and certificate-valid exact-host HTTPS", () => {
  const success = runDomainShell(String.raw`
set -euo pipefail
source "$1"
getent() {
  [[ "$1" == ahosts && "$2" == center.andersmadsen.dk ]]
  printf '%s\n' '1.1.1.1 STREAM center.andersmadsen.dk' '2606:4700:4700::1111 STREAM center.andersmadsen.dk'
}
curl() {
  local argument last="" joined=" "
  for argument in "$@"; do joined+="$argument "; last="$argument"; done
  [[ "$joined" == " --disable "* ]]
  [[ "$joined" == *" --noproxy * "* ]]
  [[ "$joined" == *" --proto =https "* ]]
  [[ "$joined" == *" --tlsv1.2 "* ]]
  [[ "$joined" == *" --max-redirs 0 "* ]]
  [[ "$joined" == *" --head "* ]]
  [[ "$last" == https://center.andersmadsen.dk/ ]]
  printf 204
}
domain_assert_dns_ready center.andersmadsen.dk
`);
  assert.equal(success.status, 0, success.stderr);

  const failures = [
    {
      name: "missing required command",
      pattern: /required DNS readiness command is unavailable: curl/,
      source: String.raw`
set -euo pipefail; source "$1"
getent() { :; }
curl() { :; }
command() {
  [[ "$1" == -v && "$2" == curl ]] && return 1
  builtin command "$@"
}
domain_assert_dns_ready center.andersmadsen.dk
`,
    },
    {
      name: "missing resolver answer",
      pattern: /does not resolve through the configured system resolver/,
      source: String.raw`
set -euo pipefail; source "$1"
getent() { return 2; }
curl() { return 99; }
domain_assert_dns_ready center.andersmadsen.dk
`,
    },
    {
      name: "private resolver answer",
      pattern: /contains no exclusively public address set/,
      source: String.raw`
set -euo pipefail; source "$1"
getent() { printf '%s\n' '127.0.0.1 STREAM center.andersmadsen.dk'; }
curl() { return 99; }
domain_assert_dns_ready center.andersmadsen.dk
`,
    },
    {
      name: "invalid certificate or HTTPS path",
      pattern: /not reachable with a certificate-valid HTTPS handshake/,
      source: String.raw`
set -euo pipefail; source "$1"
getent() { printf '%s\n' '1.1.1.1 STREAM center.andersmadsen.dk'; }
curl() { return 60; }
domain_assert_dns_ready center.andersmadsen.dk
`,
    },
    {
      name: "no HTTP response after TLS",
      pattern: /HTTPS readiness returned no valid HTTP response/,
      source: String.raw`
set -euo pipefail; source "$1"
getent() { printf '%s\n' '1.1.1.1 STREAM center.andersmadsen.dk'; }
curl() { printf 000; }
domain_assert_dns_ready center.andersmadsen.dk
`,
    },
    {
      name: "unreviewed host",
      pattern: /unreviewed public Center DNS hostname/,
      source: String.raw`
set -euo pipefail; source "$1"
domain_assert_dns_ready attacker.example
`,
    },
  ];
  for (const fixture of failures) {
    const result = runDomainShell(fixture.source);
    assert.notEqual(result.status, 0, `${fixture.name} was unexpectedly accepted`);
    assert.match(result.stderr, fixture.pattern);
  }
});

test("[implemented] deployment entrypoints bind the Center domain transaction", () => {
  const scripts = Object.fromEntries(
    ["preflight", "deploy", "rollback", "canary", "drift"].map((name) => [
      name,
      fs.readFileSync(path.join(root, `platform/deploy/vps/remote/${name}.sh`), "utf8"),
    ]),
  );
  for (const [name, source] of Object.entries(scripts)) {
    const commonLoad = /^source "\$\{REVIVAL_HELD_COMMON:-.*\/common\.sh\}"$/m;
    const domainLoad = /^source "\$\{REVIVAL_HELD_DOMAIN:-.*\/domain\.sh\}"$/m;
    assertSource(source, commonLoad, `${name} must load held common helpers`);
    assertSource(source, domainLoad, `${name} must load the held domain transaction`);
    assert.ok(
      source.search(commonLoad) < source.search(domainLoad),
      `${name} must load common.sh before domain.sh`,
    );
    assert.equal(
      [...source.matchAll(/^\s*source .*$/gm)].length,
      2,
      `${name} must not add a direct or unheld common/domain fallback`,
    );
  }

  assertSource(scripts.preflight, /domain_select_public_edge\b/, "preflight must select the live or recorded edge");
  assertSource(scripts.preflight, /domain_assert_public_tls\b/, "preflight must validate public TLS");
  assertSource(
    scripts.preflight,
    /domain_assert_dns_ready\s+center\.andersmadsen\.dk\b/,
    "preflight must prove Center DNS and public TLS readiness",
  );

  for (const call of [
    "domain_select_public_edge",
    "domain_assert_public_tls",
    "domain_nginx_install",
    "domain_nginx_verify_desired",
    "domain_keycloak_snapshot_before",
    "domain_keycloak_bind_backup",
    "domain_keycloak_apply",
    "domain_keycloak_restore",
  ]) {
    assertSource(scripts.deploy, new RegExp(`\\b${call}\\b`), `deploy must call ${call}`);
  }

  for (const call of [
    "domain_nginx_restore",
    "domain_nginx_reapply",
    "domain_keycloak_restore",
    "domain_keycloak_apply",
  ]) {
    assertSource(scripts.rollback, new RegExp(`\\b${call}\\b`), `rollback must call ${call}`);
  }

  for (const name of ["canary", "drift"]) {
    assertSource(scripts[name], /domain_nginx_verify_desired\b/, `${name} must verify Center Nginx`);
    assertSource(scripts[name], /domain_keycloak_verify_desired\b/, `${name} must verify Center identity`);
  }

  assertSource(scripts.canary, /center_base=https:\/\/center\.andersmadsen\.dk/, "public canary must use Center");
  assertSource(scripts.canary, /https:\/\/carry\.andersmadsen\.dk/, "public canary must retain Carry redirect coverage");
  assertSource(scripts.canary, /307/, "legacy redirect must preserve the request method");
  assertSource(scripts.canary, /[Ll]ocation/, "legacy redirect must verify Location");
});
