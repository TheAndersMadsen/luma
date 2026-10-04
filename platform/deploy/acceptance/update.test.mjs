// `./luma update production` end to end, on a stand-in server: a real HTTP
// update source, a stand-in GitHub serving a release signed with a throwaway
// cosign key (verified by the real cosign), stand-in operator folders whose
// `luma` records every command, and the real status.json Center reads.
//
// Ways it could fail, each exercised below: the source is unreachable or says
// nothing newer. What the source advertises as `latest` and what it runs are
// different things, and the advertisement decides; a source with no
// advertisement is read as before. The install runs without consent. No token is saved. The
// signature is not the key packed in the running operator. A step of the
// update fails before the configuration moves (nothing to undo) or after it
// (--auto restores the backup with the release that made it, then deploys and
// verifies the old release). A rolled-back release is retried every night;
// an update runs from a folder that is not the server's operator. And a token
// or secret path leaks into status.json.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import {
  IMAGE_NAMES,
  IMAGE_PLATFORMS,
  canonicalJson,
  createReleaseDescriptor,
} from "../../distribution/release-descriptor.mjs";
import { cosignOrExplain, signChecksums, throwawayKeyPair } from "./release-signing-fixture.mjs";

const cosign = cosignOrExplain("update production's release signature check");
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "luma-update-")));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

const CONFIG = path.join(temporary, "config");
const SECRETS = path.join(CONFIG, "secrets");
const DATA = path.join(temporary, "data");
const ENV = path.join(SECRETS, "runtime.env");
const OPERATORS = path.join(DATA, "operators");
const LOG = path.join(DATA, "luma.log");
const TOKEN = "ghp_fixtureUpdateToken0123456789abcdef";
// The CLI resolves its operator directories once, when it is loaded.
Object.assign(process.env, {
  LUMA_CONFIG_DIR: CONFIG,
  LUMA_SECRETS_DIR: SECRETS,
  LUMA_DATA_DIR: DATA,
  LUMA_BUILD_DIR: path.join(DATA, "build"),
  LUMA_ENV_FILE: ENV,
});
const require = createRequire(import.meta.url);
const update = require("../../cli/update.js");

const OLD = Object.freeze({ version: "1.0.0", revision: "a".repeat(40), pin: "2026-09-01.1" });
const NEW = Object.freeze({ version: "1.1.0", revision: "b".repeat(40), pin: "2026-09-20.1" });
const NOTES = "Faster answers.\nNew Pin apps.";
const PUBLISHED_AT = "2026-09-29T02:00:00.000Z";
const keys = cosign ? throwawayKeyPair(cosign, path.join(temporary, "keys")) : null;
const otherKeys = cosign ? throwawayKeyPair(cosign, path.join(temporary, "other-keys")) : null;

function put(file, contents, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, contents, { mode });
  fs.chmodSync(file, mode);
}

// A stand-in operator: ./luma records "WHO ARGS" and does the one thing each
// step leaves behind that the updater reads: backup keeps runtime.env, setup
// moves it to this release, restore puts the backup's copy back. It fails at
// the command DATA/fail-at names.
function fakeOperator(directory, who, revision) {
  put(path.join(directory, "luma"), `#!/bin/sh
printf '%s %s\\n' "${who}" "$*" >> "$LUMA_DATA_DIR/luma.log"
if [ -f "$LUMA_DATA_DIR/fail-at" ] && [ "${who} $*" = "$(cat "$LUMA_DATA_DIR/fail-at")" ]; then
  echo "fixture: ${who} $* failed" >&2
  exit 3
fi
case "$1 $2" in
  "backup production") mkdir -p "$4" && cp "$LUMA_ENV_FILE" "$4/runtime.env" ;;
  "setup production")
    cp "$4" "$LUMA_DATA_DIR/setup-received-pin.tar.gz"
    sed "s/^LUMA_RELEASE_ID=.*/LUMA_RELEASE_ID=${revision}/" "$LUMA_ENV_FILE" > "$LUMA_ENV_FILE.next"
    cat "$LUMA_ENV_FILE.next" > "$LUMA_ENV_FILE" && rm -f "$LUMA_ENV_FILE.next" ;;
  "restore production") cat "$4/runtime.env" > "$LUMA_ENV_FILE" ;;
esac
`, 0o755);
  put(path.join(directory, "platform/distribution/version.json"), `${JSON.stringify({ version: who === "new" ? NEW.version : OLD.version })}\n`, 0o644);
  if (keys) put(path.join(directory, "platform/distribution/release-signing.pub"), fs.readFileSync(keys.publicKey), 0o644);
  return directory;
}

function hex(character) {
  return character.repeat(64);
}

// The five files of Luma 1.1.0 as `release publish` makes them, signed with
// `signingKey`.
function releaseFiles(signingKey) {
  const directory = fs.mkdtempSync(path.join(temporary, "release-"));
  const stage = fs.mkdtempSync(path.join(temporary, "stage-"));
  fakeOperator(path.join(stage, `luma-operator-${NEW.version}`), "new", NEW.revision);
  const operatorName = `luma-operator-${NEW.version}-linux.tar.gz`;
  const packed = spawnSync("tar", ["-czf", path.join(directory, operatorName), "-C", stage, `luma-operator-${NEW.version}`], {
    encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  assert.equal(packed.status, 0, packed.stderr);
  const pinName = `luma-pin-${NEW.pin}.tar.gz`;
  fs.writeFileSync(path.join(directory, pinName), crypto.randomBytes(4096));
  const sha256 = (name) => crypto.createHash("sha256").update(fs.readFileSync(path.join(directory, name))).digest("hex");
  const size = (name) => fs.statSync(path.join(directory, name)).size;
  const descriptor = createReleaseDescriptor({
    version: NEW.version,
    revision: NEW.revision,
    repository: "TheAndersMadsen/luma",
    tag: `v${NEW.version}`,
    application: {
      schemaVersion: 1,
      reference: `oci://ghcr.io/theandersmadsen/luma/application@sha256:${hex("c")}`,
      digest: `sha256:${hex("c")}`,
    },
    images: Object.fromEntries(IMAGE_NAMES.map((name, index) => [name, {
      schemaVersion: 2,
      name,
      reference: `ghcr.io/theandersmadsen/luma/${name}@sha256:${hex(String(index + 1))}`,
      digest: `sha256:${hex(String(index + 1))}`,
      platforms: IMAGE_PLATFORMS,
    }])),
    operator: { archive: operatorName, sha256: sha256(operatorName), size: size(operatorName) },
    pin: {
      schemaVersion: 1, archive: pinName, sha256: sha256(pinName), size: size(pinName), releaseId: hex("d"),
      version: NEW.pin, versionCode: 202609201, signerSha256: hex("e"), manifestSha256: hex("f"), receiptsSha256: hex("0"),
    },
    updateSource: "https://center.example.test",
    notes: NOTES,
    publishedAt: PUBLISHED_AT,
  });
  const descriptorName = `luma-${NEW.version}.release.json`;
  fs.writeFileSync(path.join(directory, descriptorName), `${canonicalJson(descriptor)}\n`);
  fs.writeFileSync(path.join(directory, "SHA256SUMS"),
    `${[operatorName, pinName, descriptorName].map((name) => `${sha256(name)}  ${name}`).sort().join("\n")}\n`);
  signChecksums(cosign, {
    privateKey: signingKey.privateKey,
    checksums: path.join(directory, "SHA256SUMS"),
    signature: path.join(directory, "SHA256SUMS.sigstore.json"),
  });
  return directory;
}

// GitHub's release API and its asset redirect to githubusercontent.com, for
// one release directory. Every other URL goes to the real network (the
// loopback update source).
// `token` is what every GitHub API request must carry: the saved token, or
// null when the server has none and downloads the public release anonymously.
function fakeGitHub(directory, { token = TOKEN } = {}) {
  const requests = [];
  const names = fs.readdirSync(directory).sort();
  const assets = names.map((name, index) => ({
    id: index + 1,
    name,
    size: fs.statSync(path.join(directory, name)).size,
    url: `https://api.github.com/repos/TheAndersMadsen/luma/releases/assets/${index + 1}`,
    browser_download_url: `https://github.com/TheAndersMadsen/luma/releases/download/v${NEW.version}/${name}`,
  }));
  const fetch = async (input, options = {}) => {
    const url = String(input);
    if (!/^https:\/\/(?:api\.github\.com|objects\.githubusercontent\.com)\//u.test(url)) return globalThis.fetch(input, options);
    requests.push(url);
    if (url.startsWith("https://api.github.com/")) {
      assert.equal(options.headers?.authorization, token ? `Bearer ${token}` : undefined,
        token ? "GitHub requests carry the saved token" : "a server with no saved token sends none");
    }
    if (url === `https://api.github.com/repos/TheAndersMadsen/luma/releases/tags/v${NEW.version}`) {
      return Response.json({ tag_name: `v${NEW.version}`, draft: false, prerelease: false, assets });
    }
    const asset = assets.find((entry) => entry.url === url);
    if (asset) return new Response(null, { status: 302, headers: { location: `https://objects.githubusercontent.com/asset/${asset.id}` } });
    const delivered = assets.find((entry) => url === `https://objects.githubusercontent.com/asset/${entry.id}`);
    if (delivered) return new Response(fs.readFileSync(path.join(directory, delivered.name)));
    return new Response("not found", { status: 404 });
  };
  return { fetch, requests };
}

// The update source: a Center's public /api/version.
let answer = null;
const source = http.createServer((request, response) => {
  if (request.url !== "/api/version" || answer === null) {
    response.writeHead(503).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
});
let SOURCE = "";
before(async () => {
  await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve));
  SOURCE = `http://127.0.0.1:${source.address().port}`;
});
after(() => source.close());

const releaseAnswer = (version = NEW.version) => ({
  version, tag: `v${version}`, pin: { version: NEW.pin, versionCode: 202609201 }, notes: NOTES, publishedAt: PUBLISHED_AT,
  releaseId: NEW.revision, environment: "production",
});

// A server running Luma 1.0.0 from operators/1.0.0, with automatic updates on
// and the token bootstrap saved.
function freshServer({ token = true } = {}) {
  for (const directory of [CONFIG, DATA]) fs.rmSync(directory, { recursive: true, force: true });
  for (const directory of [CONFIG, SECRETS, DATA, path.join(DATA, "build"), OPERATORS]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  const old = fakeOperator(path.join(OPERATORS, OLD.version), "old", OLD.revision);
  fs.symlinkSync(old, path.join(OPERATORS, "current"));
  put(ENV, [
    "LUMA_CONFIG_VERSION=1",
    `LUMA_RELEASE_ID=${OLD.revision}`,
    `LUMA_RELEASE_VERSION=${OLD.version}`,
    `LUMA_RELEASE_TAG=v${OLD.version}`,
    `LUMA_PIN_RELEASE_VERSION=${OLD.pin}`,
    "COMPOSE_PROFILES=pin,search",
    `LUMA_UPDATE_SOURCE=${SOURCE}`,
    "LUMA_AUTO_UPDATES=on",
    "",
  ].join("\n"));
  if (token) put(update.GITHUB_TOKEN_FILE, `${TOKEN}\n`);
  return old;
}

function runtime(overrides = {}) {
  const lines = [];
  return {
    lines,
    overrides: {
      root: path.join(OPERATORS, OLD.version),
      release: {
        version: OLD.version, revision: OLD.revision, source: { tag: `v${OLD.version}` },
        pin: { version: OLD.pin }, updateSource: null,
      },
      write: (line) => lines.push(line),
      provisionVerifier: async () => cosign,
      stopLuma: () => fs.appendFileSync(LOG, "docker stop luma\n"),
      interactive: () => false,
      ...overrides,
    },
  };
}

function status() {
  const text = fs.readFileSync(update.STATUS_FILE, "utf8");
  assert.doesNotMatch(text, new RegExp(`${TOKEN}|${SECRETS.replaceAll("/", "\\/")}|github-token`, "u"),
    "status.json carries no token and no secret path");
  assert.equal(fs.statSync(update.STATUS_FILE).mode & 0o777, 0o644);
  assert.equal(fs.statSync(update.UPDATES_DIR).mode & 0o777, 0o755);
  return JSON.parse(text);
}

function stopped(error) {
  const lines = [];
  update.reportStopped(error, (line) => lines.push(line));
  return lines.join("\n");
}

function log() {
  return fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trimEnd().split("\n") : [];
}

test("--check records the newest release for Center and says whether this server is up to date", async () => {
  freshServer();
  answer = releaseAnswer(OLD.version);
  const current = runtime();
  const result = await update.updateProduction({ check: true, auto: false }, current.overrides);
  assert.equal(result.updated, false);
  assert.deepEqual(current.lines, [`Luma ${OLD.version} is up to date (the newest release at ${SOURCE} is ${OLD.version}).`]);
  const recorded = status();
  assert.deepEqual(Object.keys(recorded), ["schemaVersion", "checkedAt", "source", "current", "latest", "autoUpdates", "lastUpdate"]);
  assert.equal(recorded.schemaVersion, 1);
  assert.ok(!Number.isNaN(Date.parse(recorded.checkedAt)));
  assert.equal(recorded.source, SOURCE);
  assert.deepEqual(recorded.current, { version: OLD.version, tag: `v${OLD.version}`, pinVersion: OLD.pin });
  assert.deepEqual(recorded.latest, {
    version: OLD.version, tag: `v${OLD.version}`, pinVersion: NEW.pin, notes: NOTES, publishedAt: PUBLISHED_AT,
  });
  assert.equal(recorded.autoUpdates, "on");
  assert.equal(recorded.lastUpdate, null);

  answer = releaseAnswer();
  const github = fakeGitHub(fs.mkdtempSync(path.join(temporary, "empty-")));
  const newer = runtime({ fetch: github.fetch });
  await update.updateProduction({ check: true, auto: false }, newer.overrides);
  assert.deepEqual(newer.lines, [`Luma ${NEW.version} is available (this server runs ${OLD.version}).`, NOTES]);
  assert.equal(status().latest.version, NEW.version);
  assert.deepEqual(github.requests, [], "a check downloads nothing");
  assert.deepEqual(log(), [], "a check runs no operator command");

  // A source that lacks fields reports them as null, never as guesses.
  answer = { version: NEW.version };
  await update.updateProduction({ check: true, auto: false }, runtime().overrides);
  assert.deepEqual(status().latest, { version: NEW.version, tag: null, pinVersion: null, notes: null, publishedAt: null });
});

test("a Center's latest advertisement decides, even while the source itself runs older", async () => {
  freshServer();
  // The source still runs OLD and says so in its identity fields, while it
  // advertises NEW as the newest published release.
  answer = {
    ...releaseAnswer(OLD.version),
    latest: {
      version: NEW.version, tag: `v${NEW.version}`, pin: { version: NEW.pin, versionCode: 202609201 },
      notes: NOTES, publishedAt: PUBLISHED_AT,
    },
  };
  const newer = runtime();
  const result = await update.updateProduction({ check: true, auto: false }, newer.overrides);
  assert.equal(result.updated, false);
  assert.deepEqual(newer.lines, [`Luma ${NEW.version} is available (this server runs ${OLD.version}).`, NOTES]);
  assert.equal(status().latest.version, NEW.version);
  assert.deepEqual(log(), [], "a check runs no operator command");

  // A source with no advertisement (an older Center) is read as before.
  answer = releaseAnswer(OLD.version);
  await update.updateProduction({ check: true, auto: false }, runtime().overrides);
  assert.deepEqual(status().latest, {
    version: OLD.version, tag: `v${OLD.version}`, pinVersion: NEW.pin, notes: NOTES, publishedAt: PUBLISHED_AT,
  });
});

test("an unreachable update source is recorded for Center and ends with the standard recovery lines", async () => {
  freshServer();
  answer = null;
  const error = await update.updateProduction({ check: true, auto: false }, runtime().overrides)
    .then(() => assert.fail("the check succeeded"), (failure) => failure);
  assert.ok(error instanceof update.UpdateStopped);
  const report = stopped(error);
  assert.match(report, /^Update stopped · Check for a newer release$/mu);
  assert.match(report, /What failed: .*\/api\/version answered HTTP 503/u);
  assert.match(report, /^ {2}State: Nothing was changed\. Center shows that the last check could not reach the update source\.$/mu);
  assert.match(report, /^ {2}Safe retry: \.\/luma update production --check/mu);
  assert.equal(status().latest, null);
});

test("an install needs a terminal that confirms it, or --auto", async () => {
  freshServer();
  answer = releaseAnswer();
  const error = await update.updateProduction({ check: false, auto: false }, runtime().overrides)
    .then(() => assert.fail("installed without consent"), (failure) => failure);
  assert.match(stopped(error), /What failed: installing an update needs a terminal that confirms it, or --auto/u);
  assert.match(stopped(error), /State: Nothing was changed\./u);
  assert.deepEqual(log(), []);
  assert.equal(fs.existsSync(path.join(OPERATORS, NEW.version)), false);

  // At a terminal, anything but yes changes nothing.
  const declined = await update.updateProduction({ check: false, auto: false }, runtime({
    interactive: () => true, readLine: () => "n",
  }).overrides).then(() => assert.fail("installed without consent"), (failure) => failure);
  assert.match(stopped(declined), /the update was not confirmed/u);
  assert.deepEqual(log(), []);
});

test("--auto without a saved token downloads the public release anonymously and installs it", { skip: !cosign }, async () => {
  freshServer({ token: false });
  answer = releaseAnswer();
  const github = fakeGitHub(releaseFiles(keys), { token: null });
  const result = await update.updateProduction({ check: false, auto: true }, runtime({ fetch: github.fetch }).overrides);
  assert.equal(result.updated, true);
  assert.ok(github.requests.length > 0, "the release was downloaded");
  assert.equal(fs.realpathSync(path.join(OPERATORS, "current")), path.join(OPERATORS, NEW.version));
  assert.equal(fs.existsSync(path.join(SECRETS, "github-token")), false, "no token is invented or saved");
});

test("an anonymous download that GitHub refuses points a private fork at registry login", async () => {
  freshServer({ token: false });
  answer = releaseAnswer();
  const github = fakeGitHub(fs.mkdtempSync(path.join(temporary, "empty-")), { token: null });
  const error = await update.updateProduction({ check: false, auto: true }, runtime({ fetch: github.fetch }).overrides)
    .then(() => assert.fail("installed a release GitHub did not serve"), (failure) => failure);
  const report = stopped(error);
  assert.match(report, /^Update stopped · Download and verify the release$/mu);
  assert.match(report, /State: Nothing was changed; the partial download was discarded\./u);
  assert.match(report, /Safe retry: \.\/luma update production \(a private fork first saves a token with \.\/luma registry login --username YOUR_GITHUB_USER\)/u);
});

test("a release not signed by the key in the running operator is refused before anything is unpacked", { skip: !cosign }, async () => {
  freshServer();
  answer = releaseAnswer();
  const github = fakeGitHub(releaseFiles(otherKeys));
  const current = runtime({ fetch: github.fetch });
  const error = await update.updateProduction({ check: false, auto: true }, current.overrides)
    .then(() => assert.fail("installed a release signed by another key"), (failure) => failure);
  const report = stopped(error);
  assert.match(report, /^Update stopped · Download and verify the release$/mu);
  assert.match(report, /What failed: Cosign rejected the release signature/u);
  assert.match(report, /State: Nothing was changed; the partial download was discarded\./u);
  assert.equal(fs.existsSync(path.join(OPERATORS, NEW.version)), false);
  assert.equal(fs.realpathSync(path.join(OPERATORS, "current")), path.join(OPERATORS, OLD.version));
  assert.deepEqual(log(), []);
  assert.deepEqual(fs.readdirSync(path.join(DATA, "update-downloads")), [], "the download is discarded");
  const recorded = status();
  assert.equal(recorded.lastUpdate.outcome, "failed");
  assert.equal(recorded.lastUpdate.from, OLD.version);
  assert.equal(recorded.lastUpdate.to, NEW.version);
  assert.match(recorded.lastUpdate.message, /^Download and verify the release: Cosign rejected/u);
});

test("--auto installs a newer signed release from its own folder and switches current only after setup", { skip: !cosign }, async () => {
  freshServer();
  answer = releaseAnswer();
  const release = releaseFiles(keys);
  const github = fakeGitHub(release);
  const current = runtime({ fetch: github.fetch });
  const result = await update.updateProduction({ check: false, auto: true }, current.overrides);
  assert.equal(result.updated, true);

  const folder = path.join(OPERATORS, NEW.version);
  const backup = /^new backup production --output (.+)$/u.exec(log()[0])?.[1];
  assert.match(backup, new RegExp(`^${DATA}/backups/luma-update-1\\.0\\.0-to-1\\.1\\.0-\\d{8}T\\d{6}Z$`, "u"));
  const pinArchive = /^new setup production --pin-release-archive (.+)$/u.exec(log()[1])?.[1];
  assert.deepEqual(log(), [
    `new backup production --output ${backup}`,
    `new setup production --pin-release-archive ${pinArchive}`,
    "new deploy production --dry-run",
    "new deploy production --confirm",
    "new verify production",
  ]);
  // Setup received the verified Pin archive, byte for byte.
  assert.deepEqual(fs.readFileSync(path.join(DATA, "setup-received-pin.tar.gz")),
    fs.readFileSync(path.join(release, `luma-pin-${NEW.pin}.tar.gz`)));
  assert.equal(fs.realpathSync(path.join(OPERATORS, "current")), folder);
  assert.equal(fs.existsSync(path.join(folder, "luma")), true);
  assert.deepEqual(fs.readdirSync(path.join(DATA, "update-downloads")), [], "the downloads are removed");
  assert.equal(fs.existsSync(path.join(DATA, "update.lock")), false);
  assert.match(current.lines.join("\n"), /Luma 1\.1\.0 is installed and passed production verification/u);
  assert.equal(current.lines.at(-1),
    `Pin apps ${NEW.pin} are ready: install them from Center → Settings → Advanced → Software & updates`);
  const recorded = status();
  assert.deepEqual(recorded.current, { version: NEW.version, tag: `v${NEW.version}`, pinVersion: NEW.pin });
  assert.equal(recorded.lastUpdate.outcome, "updated");
  assert.deepEqual(Object.keys(recorded.lastUpdate), ["startedAt", "finishedAt", "from", "to", "outcome", "message"]);
  assert.equal(recorded.lastUpdate.from, OLD.version);
  assert.equal(recorded.lastUpdate.to, NEW.version);
  // Every GitHub request stayed on GitHub's release API and asset hosts.
  assert.ok(github.requests.every((url) => /^https:\/\/(?:api\.github\.com\/repos\/TheAndersMadsen\/luma\/releases\/|objects\.githubusercontent\.com\/)/u.test(url)));

  // The folder that was current is not any more, so it refuses to update.
  const stale = await update.updateProduction({ check: true, auto: false }, runtime().overrides)
    .then(() => assert.fail("an old folder ran an update"), (failure) => failure);
  assert.match(stopped(stale), /^Update stopped · Check this operator folder$/mu);
  assert.match(stopped(stale), new RegExp(`Safe retry: ${OPERATORS}/current/luma update production`, "u"));
});

test("a step that fails before the configuration moves leaves the old release running and current unchanged", { skip: !cosign }, async () => {
  freshServer();
  answer = releaseAnswer();
  const stamp = new Date("2026-09-29T03:10:00.000Z");
  fs.writeFileSync(path.join(DATA, "fail-at"),
    `new backup production --output ${DATA}/backups/luma-update-1.0.0-to-1.1.0-20260929T031000Z`);
  const github = fakeGitHub(releaseFiles(keys));
  const error = await update.updateProduction({ check: false, auto: true }, runtime({
    fetch: github.fetch, now: () => stamp,
  }).overrides).then(() => assert.fail("the update succeeded"), (failure) => failure);
  const report = stopped(error);
  assert.match(report, /^Update stopped · Back up this server$/mu);
  assert.match(report, /State: This server still runs Luma 1\.0\.0 unchanged\. Luma 1\.1\.0 stays unpacked in /u);
  assert.doesNotMatch(log().join("\n"), /setup|deploy|restore|docker stop/u, "nothing to undo, so nothing is undone");
  assert.equal(fs.realpathSync(path.join(OPERATORS, "current")), path.join(OPERATORS, OLD.version));
  assert.match(fs.readFileSync(ENV, "utf8"), new RegExp(`^LUMA_RELEASE_ID=${OLD.revision}$`, "mu"));
  assert.equal(status().lastUpdate.outcome, "failed");
});

test("--auto puts the old release back when the new one fails verification, and does not retry it", { skip: !cosign }, async () => {
  freshServer();
  answer = releaseAnswer();
  fs.writeFileSync(path.join(DATA, "fail-at"), "new verify production");
  const github = fakeGitHub(releaseFiles(keys));
  const current = runtime({ fetch: github.fetch });
  const error = await update.updateProduction({ check: false, auto: true }, current.overrides)
    .then(() => assert.fail("a failed release stayed installed"), (failure) => failure);
  const backup = /^new backup production --output (.+)$/u.exec(log()[0])?.[1];
  assert.deepEqual(log().slice(2), [
    "new deploy production --dry-run",
    "new deploy production --confirm",
    "new verify production",
    // README "Back up and restore": stop Luma, restore with the release that
    // made the backup, then start the older release from its own folder.
    "docker stop luma",
    `new restore production --from ${backup} --confirm`,
    "old deploy production --confirm",
    "old verify production",
  ]);
  const report = stopped(error);
  assert.match(report, /^Update stopped · Verify the new release$/mu);
  assert.match(report, /Luma 1\.0\.0 was restored from the backup taken before the update and passed verification/u);
  assert.match(report, /State: This server runs Luma 1\.0\.0 again, as it was before the update\. Automatic updates do not retry Luma 1\.1\.0\./u);
  assert.match(report, /Safe retry: .*current\/luma update production at a terminal, once the cause is fixed/u);
  assert.equal(fs.realpathSync(path.join(OPERATORS, "current")), path.join(OPERATORS, OLD.version));
  assert.match(fs.readFileSync(ENV, "utf8"), new RegExp(`^LUMA_RELEASE_ID=${OLD.revision}$`, "mu"));
  const recorded = status();
  assert.equal(recorded.lastUpdate.outcome, "rolled-back");
  assert.deepEqual(recorded.current, { version: OLD.version, tag: `v${OLD.version}`, pinVersion: OLD.pin });

  // The next night skips the release that was rolled back.
  fs.rmSync(LOG);
  const night = runtime({ fetch: github.fetch });
  const requests = github.requests.length;
  const skipped = await update.updateProduction({ check: false, auto: true }, night.overrides);
  assert.equal(skipped.updated, false);
  assert.match(night.lines.at(-1), /Luma 1\.1\.0 was rolled back on .+, so it is not installed automatically again/u);
  assert.equal(github.requests.length, requests);
  assert.deepEqual(log(), []);
  assert.equal(status().lastUpdate.outcome, "rolled-back", "a check keeps the last update");
});

test("without --auto a failure after the configuration moved names the way forward and the way back", { skip: !cosign }, async () => {
  freshServer();
  answer = releaseAnswer();
  fs.writeFileSync(path.join(DATA, "fail-at"), "new deploy production --confirm");
  const github = fakeGitHub(releaseFiles(keys));
  const error = await update.updateProduction({ check: false, auto: false }, runtime({
    fetch: github.fetch, interactive: () => true, readLine: () => "yes",
  }).overrides).then(() => assert.fail("the update succeeded"), (failure) => failure);
  assert.doesNotMatch(log().join("\n"), /docker stop|restore/u, "only --auto rolls back by itself");
  const report = stopped(error);
  assert.match(report, /State: This server is configured for Luma 1\.1\.0 and may be partly deployed\. The backup from before the update is .+\.$/mu);
  assert.match(report, /Safe retry: fix the cause and run cd .+\/operators\/1\.1\.0 && \.\/luma deploy production --confirm; or go back to Luma 1\.0\.0: docker stop .+ restore production --from .+ --confirm; then cd .+\/operators\/1\.0\.0 && \.\/luma deploy production --confirm/u);
  assert.equal(fs.realpathSync(path.join(OPERATORS, "current")), path.join(OPERATORS, NEW.version),
    "current follows the configuration, which setup moved");
  assert.equal(status().lastUpdate.outcome, "failed");
});

test("the systemd units run the current operator nightly and check hourly, as this user", () => {
  const units = update.renderUpdateUnits({ user: "luma", home: "/home/luma" });
  assert.deepEqual(Object.keys(units), [
    "luma-update.service", "luma-update.timer", "luma-update-check.service", "luma-update-check.timer",
  ]);
  const service = units["luma-update.service"];
  assert.match(service, /^User=luma$/mu);
  assert.match(service, new RegExp(`^ExecStart="${OPERATORS}/current/luma" update production --auto$`, "mu"));
  for (const [name, value] of [["LUMA_CONFIG_DIR", CONFIG], ["LUMA_SECRETS_DIR", SECRETS], ["LUMA_DATA_DIR", DATA], ["LUMA_ENV_FILE", ENV]]) {
    assert.match(service, new RegExp(`^Environment="${name}=${value}"$`, "mu"), name);
  }
  assert.match(units["luma-update-check.service"], / update production --check$/mu);
  assert.match(units["luma-update.timer"], /^OnCalendar=\*-\*-\* 03:00:00\nRandomizedDelaySec=2h\nPersistent=true$/mu);
  assert.match(units["luma-update-check.timer"], /^OnCalendar=hourly$/mu);
  assert.match(units["luma-update-check.timer"], /^WantedBy=timers\.target$/mu);
});

test("setup installs the timers through the privileged step, removes the nightly one when off, and prints the commands without sudo", () => {
  freshServer();
  const release = { version: OLD.version, revision: OLD.revision };
  const system = path.join(temporary, "etc-systemd");
  fs.mkdirSync(system, { recursive: true });
  const scripts = [];
  const enabled = new Set();
  // A stand-in root: runs the script's install/rm lines against `system`.
  const runPrivileged = (script) => {
    scripts.push(script);
    for (const part of script.split(" && ")) {
      const install = /^install -m 0644 "(.+)" (.+)$/u.exec(part);
      if (install) fs.copyFileSync(install[1], install[2]);
      if (/^rm -f /u.test(part)) for (const file of part.split(" ").slice(2)) fs.rmSync(file, { force: true });
      if (/^systemctl enable --now /u.test(part)) for (const unit of part.split(" ").slice(3)) enabled.add(unit);
      if (/^systemctl disable --now /u.test(part)) enabled.delete(part.split(" ")[3]);
    }
    return true;
  };
  const common = {
    release: () => release, root: path.join(OPERATORS, OLD.version), hasSystemd: () => true,
    systemUnitsDir: system, runPrivileged, identity: { user: "luma", home: "/home/luma" },
    systemctl: ([, unit]) => (enabled.has(unit) ? "enabled" : "disabled"),
  };
  const on = update.configureAutomaticUpdates({ enabled: true }, common);
  assert.equal(on.state, "installed");
  assert.equal(on.message, "Automatic updates are on: this server installs newer releases between 03:00 and 05:00.");
  assert.deepEqual(fs.readdirSync(system).sort(), [
    "luma-update-check.service", "luma-update-check.timer", "luma-update.service", "luma-update.timer",
  ]);
  assert.match(scripts[0], /systemctl daemon-reload && systemctl enable --now luma-update-check\.timer luma-update\.timer$/u);
  // Nothing changed, so nothing privileged runs again.
  assert.equal(update.configureAutomaticUpdates({ enabled: true }, common).state, "unchanged");
  assert.equal(scripts.length, 1);

  const off = update.configureAutomaticUpdates({ enabled: false }, common);
  assert.equal(off.state, "installed");
  assert.equal(off.message, "Automatic updates are off.");
  assert.deepEqual(fs.readdirSync(system).sort(), ["luma-update-check.service", "luma-update-check.timer"],
    "the hourly check stays so Center's status stays fresh");
  assert.match(scripts[1], /systemctl disable --now luma-update\.timer/u);

  const manual = update.configureAutomaticUpdates({ enabled: true }, { ...common, runPrivileged: () => false });
  assert.equal(manual.state, "manual");
  assert.match(manual.message, /sudo was not available\. Run these once as root/u);
  assert.deepEqual(manual.commands.slice(-2), [
    "systemctl daemon-reload", "systemctl enable --now luma-update-check.timer luma-update.timer",
  ]);
  assert.ok(manual.commands[0].startsWith(`install -m 0644 "${CONFIG}/production/systemd/luma-update.service" `));

  // A source checkout and a release unpacked outside operators/ install none.
  assert.equal(update.configureAutomaticUpdates({ enabled: true }, { ...common, release: () => ({ revision: "source" }) }).state, "source");
  assert.equal(update.configureAutomaticUpdates({ enabled: true }, { ...common, root: temporary }).state, "not-installed");
  assert.equal(scripts.length, 2);
});

test("doctor reports the timers, warns when they disagree with the configuration, and names the last update", () => {
  freshServer();
  const timers = { "luma-update.timer": "enabled", "luma-update-check.timer": "enabled" };
  const systemctl = ([verb, unit]) => {
    if (verb === "is-enabled") return timers[unit] ?? "disabled";
    if (verb === "is-active") return timers[unit] === "enabled" ? "active" : "inactive";
    return timers[unit] === "enabled" ? "Tue 2026-09-30 03:41:07 UTC" : "n/a";
  };
  assert.deepEqual(update.automaticUpdatesReport({ LUMA_AUTO_UPDATES: "on" }, { hasSystemd: () => true, systemctl }), [
    "Automatic updates: on (luma-update.timer enabled, active, next Tue 2026-09-30 03:41:07 UTC; " +
      "luma-update-check.timer enabled, active, next Tue 2026-09-30 03:41:07 UTC)",
  ]);
  timers["luma-update.timer"] = "disabled";
  const drifted = update.automaticUpdatesReport({ LUMA_AUTO_UPDATES: "on" }, { hasSystemd: () => true, systemctl });
  assert.match(drifted[1], /^WARN the timers do not match LUMA_AUTO_UPDATES=on; run \.\/luma setup production --auto-updates on/u);
  assert.deepEqual(update.automaticUpdatesReport({ LUMA_AUTO_UPDATES: "off" }, { hasSystemd: () => false }), [
    "Automatic updates: off, and systemd is not running here; run ./luma update production yourself",
  ]);
});
