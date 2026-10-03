import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RELEASE_SIGNING_PUBLIC_KEY_PATH } from "../../distribution/release-proof.mjs";
import { cosignOrExplain, signChecksums, throwawayKeyPair } from "./release-signing-fixture.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const bootstrap = path.join(root, "bootstrap");
const cosign = cosignOrExplain("the installer's signature check with a throwaway key");

test("newcomer bootstrap is a valid standalone interactive Bash program", () => {
  const syntax = spawnSync("bash", ["-n", bootstrap], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const help = spawnSync("bash", [bootstrap, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /installs supported host tools/u);
  const mode = fs.statSync(bootstrap).mode & 0o777;
  assert.equal(mode, 0o755);
});

test("bootstrap keeps secrets transient and authenticates before executing a release", () => {
  const source = fs.readFileSync(bootstrap, "utf8");
  // The GitHub token is optional (the public release and images need none).
  // A private fork's token is read from the GitHub CLI or a mode-0600 file,
  // never prompted, and only reaches GitHub through github_auth_header, which
  // sends nothing without a token.
  assert.match(source, /gh auth token --hostname github\.com/u);
  assert.match(source, /\[\[ -n "\$GH_TOKEN" \]\] \|\| return 0/u);
  assert.match(source, /cosign.*verify-blob/su);
  assert.match(source, /operator archive did not match the signed \$RELEASE_CHECKSUMS/u);
  // Only the maintainer's key authenticates a release: no identity-based or
  // CI-only verification path remains.
  assert.doesNotMatch(source, /certificate-identity|certificate-oidc-issuer|github-workflow|release-cli\.yml/u);
  assert.match(source, /docker login ghcr\.io.*--password-stdin/u);
  assert.match(source, /\.\/luma onboard production/u);
  assert.doesNotMatch(source, /curl[^\n]*\|\s*(?:sudo\s+)?(?:ba)?sh/u);
  assert.doesNotMatch(source, /gh[pousr]_[A-Za-z0-9]{20,}/u);
});

function runSourcedBootstrap(command, args = [], env = process.env) {
  return spawnSync("bash", ["-c", `source "$1"; shift; ${command}`, "bootstrap-test", bootstrap, ...args], {
    encoding: "utf8",
    env,
  });
}

test("bootstrap creates every Luma data level private, including a level an older bootstrap left open", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-bootstrap-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const fresh = path.join(temporary, "home/.local/share/luma");
  const older = path.join(temporary, "older/luma");
  fs.mkdirSync(path.join(older, "operators"), { recursive: true, mode: 0o755 });
  fs.chmodSync(older, 0o755);

  for (const dataRoot of [fresh, older]) {
    const result = runSourcedBootstrap("umask 022; create_data_dirs \"$1\"", [dataRoot]);
    assert.equal(result.status, 0, result.stderr);
    // The operator's managed-root check refuses a data root other users can read.
    for (const directory of [dataRoot, path.join(dataRoot, "operators"), path.join(dataRoot, "build")]) {
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700, directory);
    }
  }
});

test("bootstrap logs Docker in to the configuration onboarding and deploys read", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-bootstrap-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "docker.log");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "docker"), `#!/bin/sh
{ printf 'DOCKER_CONFIG=%s\\n' "$DOCKER_CONFIG"; printf 'args=%s\\n' "$*"; printf 'stdin='; cat; printf '\\n'; } >> "$LUMA_TEST_DOCKER_LOG"
`, { mode: 0o755 });
  // \`sg docker -c COMMAND\` runs COMMAND through sh with the docker group.
  fs.writeFileSync(path.join(bin, "sg"), `#!/bin/sh
[ "$1" = docker ] && [ "$2" = -c ] || exit 97
exec /bin/sh -c "$3"
`, { mode: 0o755 });
  const buildDirectory = path.join(temporary, "data root/luma/build");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    LUMA_TEST_DOCKER_LOG: log,
  };

  for (const mode of ["direct", "group"]) {
    fs.rmSync(log, { force: true });
    // Bootstrap clears any inherited token on load. It holds only the one it asked for.
    const result = runSourcedBootstrap(
      "GH_TOKEN=fixture-registry-token; docker_login \"$1\" octocat \"$2\"", [mode, buildDirectory], env,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(log, "utf8"), [
      `DOCKER_CONFIG=${buildDirectory}`,
      "args=login ghcr.io --username octocat --password-stdin",
      "stdin=fixture-registry-token",
      "",
    ].join("\n"), mode);
  }
});

test("bootstrap hands curl the GitHub token on stdin, never in its arguments", (t) => {
  const source = fs.readFileSync(bootstrap, "utf8");
  // Every curl that talks to GitHub reads the header from stdin. No line that
  // builds a curl argument list names the token.
  for (const line of source.split("\n").filter((entry) => /--header|curl /u.test(entry))) {
    assert.doesNotMatch(line, /GH_TOKEN/u, line);
  }

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-bootstrap-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "curl.log");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh
{ printf 'args=%s\\n' "$*"; printf 'stdin='; cat; } >> "$LUMA_TEST_CURL_LOG"
printf 200
`, { mode: 0o755 });
  const result = runSourcedBootstrap(
    'GH_TOKEN=fixture-api-token; github_api https://api.github.com/user "$1" "user access"',
    [path.join(temporary, "user.json")],
    { ...process.env, PATH: `${bin}:${process.env.PATH}`, LUMA_TEST_CURL_LOG: log },
  );
  assert.equal(result.status, 0, result.stderr);
  const recorded = fs.readFileSync(log, "utf8");
  assert.match(recorded, /^args=.*--header @- /mu);
  assert.doesNotMatch(recorded.split("stdin=")[0], /fixture-api-token/u);
  assert.match(recorded, /^stdin=Authorization: Bearer fixture-api-token$/mu);
});

test("bootstrap can be sourced for compatibility checks without starting setup", () => {
  const result = runSourcedBootstrap("printf ready");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ready");
});

test("bootstrap explains missing and unsupported host release information", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-bootstrap-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const oldUbuntu = path.join(temporary, "os-release");
  const currentUbuntu = path.join(temporary, "current-os-release");
  fs.writeFileSync(oldUbuntu, 'ID=ubuntu\nVERSION_ID="22.04"\n');
  fs.writeFileSync(currentUbuntu, 'ID=ubuntu\nVERSION_ID="24.04"\n');

  for (const [file, architecture, failure] of [
    [path.join(temporary, "missing"), "x86_64", /release information is missing/u],
    [oldUbuntu, "x86_64", /requires 64-bit Ubuntu 24\.04/u],
    [currentUbuntu, "riscv64", /supports only amd64\/x86_64 and arm64\/aarch64/u],
  ]) {
    const result = runSourcedBootstrap(
      'CURRENT_STAGE="Host compatibility"; CHANGE_STATE="Nothing was changed."; validate_supported_host "$1" "$2"',
      [file, architecture],
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Setup stopped · Host compatibility/u);
    assert.match(result.stderr, failure);
    assert.match(result.stderr, /Nothing was changed/u);
    // Any owner's Center serves this script, so the retry names no one host.
    assert.match(result.stderr, /Safe retry: Run the same install command again \(bash <\(curl -fsSL https:\/\/YOUR-CENTER\/install\.sh\)\)/u);
    assert.doesNotMatch(result.stderr, /andersmadsen/u);
  }
});

test("bootstrap waits for Ubuntu's package lock and names a failed root command", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-bootstrap-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "apt.log");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "sudo"), '#!/bin/sh\nexec "$@"\n', { mode: 0o700 });
  // A fresh server's unattended-upgrades holds the lock; apt-get exits 100.
  fs.writeFileSync(path.join(bin, "apt-get"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n[ "$3" = install ] && exit 100\nexit 0\n`, { mode: 0o700 });
  const result = runSourcedBootstrap(
    'trap unexpected_failure ERR; set -E; CURRENT_STAGE="Host and prerequisites"; ' +
      'apt_get update; apt_get install -y ca-certificates curl',
    [],
    { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  );
  assert.equal(result.status, 100);
  assert.equal(fs.readFileSync(log, "utf8"), [
    "-o DPkg::Lock::Timeout=300 update",
    "-o DPkg::Lock::Timeout=300 install -y ca-certificates curl",
    "",
  ].join("\n"));
  assert.match(result.stderr,
    /What failed: The command `apt-get -o DPkg::Lock::Timeout=300 install -y ca-certificates curl` stopped with exit status 100\./u);
  assert.equal(result.stderr.match(/Setup stopped/gu).length, 1);
  // Every apt-get call goes through the waiting wrapper.
  const source = fs.readFileSync(bootstrap, "utf8").split("# STAGES:")[1];
  assert.doesNotMatch(source, /as_root apt-get (?!-o DPkg::Lock::Timeout=300 "\$@")/u);
});

test("bootstrap has bounded capacity, privilege, Docker, and GitHub recovery checks", () => {
  const source = fs.readFileSync(bootstrap, "utf8");
  assert.match(source, /MINIMUM_AVAILABLE_KIB/u);
  assert.match(source, /sudo -v/u);
  assert.match(source, /incompatible Docker package/u);
  assert.match(source, /repository read access/u);
  assert.match(source, /package read access/u);
  assert.match(source, /CURRENT_STAGE/u);
  assert.match(source, /CHANGE_STATE/u);
  assert.match(source, /Safe retry/u);
});

/** GitHub's `releases/latest` answer, shaped like the real v0.3.4 one. */
function latestRelease(version, extraAssets = []) {
  const tag = `v${version}`;
  const names = [
    `luma-${version}.release.json`,
    `luma-operator-${version}-linux.tar.gz`,
    "luma-pin-2026-09-24.1.tar.gz",
    "SHA256SUMS",
    ...extraAssets,
  ];
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: names.map((name, index) => ({
      id: index + 1,
      name,
      size: 1024,
      url: `https://api.github.com/repos/TheAndersMadsen/luma/releases/assets/${index + 1}`,
      browser_download_url: `https://github.com/TheAndersMadsen/luma/releases/download/${tag}/${name}`,
    })),
  };
}

test("bootstrap tells a signed release from one built on the maintainer's machine", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-bootstrap-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const unsigned = path.join(temporary, "unsigned.json");
  const signed = path.join(temporary, "signed.json");
  const broken = path.join(temporary, "broken.json");
  fs.writeFileSync(unsigned, JSON.stringify(latestRelease("0.3.4")));
  fs.writeFileSync(signed, JSON.stringify(latestRelease("0.3.5", ["SHA256SUMS.sigstore.json"])));
  fs.writeFileSync(broken, JSON.stringify({ tag_name: "latest", draft: false, prerelease: false }));

  assert.equal(runSourcedBootstrap('release_identity "$1"', [unsigned]).stdout, "v0.3.4\t0.3.4\tunsigned\n");
  assert.equal(runSourcedBootstrap('release_identity "$1"', [signed]).stdout, "v0.3.5\t0.3.5\tsigned\n");
  const refused = runSourcedBootstrap('release_identity "$1"', [broken]);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
  assert.equal(refused.stderr, "", "no Node stack trace reaches the owner");

  // The unsigned release stops with where to go instead, not "retry".
  const message = runSourcedBootstrap('unsigned_release_message 0.3.4').stdout;
  assert.match(message, /^Luma 0\.3\.4 was published without the maintainer's signature over its checksums \(SHA256SUMS\.sigstore\.json\)/u);
  assert.match(message, /docs\/install\.md "Install the release" \(https:\/\/github\.com\/TheAndersMadsen\/luma\/blob\/main\/docs\/install\.md#2-install-the-release\)/u);
  assert.doesNotMatch(message, /retry/iu);
});

// The block bootstrap embeds. The script is served standalone by every Center,
// so it cannot read the committed file.
function embeddedPublicKey(source) {
  const block = /RELEASE_SIGNING_PUBLIC_KEY="\$\(cat <<'RELEASE_SIGNING_PUBLIC_KEY_PEM'\n([\s\S]*?)RELEASE_SIGNING_PUBLIC_KEY_PEM\n\)"/u.exec(source);
  assert.ok(block, "bootstrap embeds RELEASE_SIGNING_PUBLIC_KEY between its heredoc markers");
  return block[1];
}

test("bootstrap embeds exactly the committed release signing public key", () => {
  const embedded = embeddedPublicKey(fs.readFileSync(bootstrap, "utf8"));
  const committed = fs.readFileSync(RELEASE_SIGNING_PUBLIC_KEY_PATH, "utf8");
  assert.equal(embedded, committed, "bootstrap and platform/distribution/release-signing.pub differ; ./luma release keygen writes both");
  if (committed.length > 0) assert.match(committed, /^-----BEGIN PUBLIC KEY-----\n[\s\S]+-----END PUBLIC KEY-----\n$/u);
  // The served copy is the same script.
  const served = fs.readFileSync(path.join(root, "center/src/lib/pin-setup/generated/bootstrap.ts"), "utf8");
  assert.ok(served.includes(JSON.stringify(fs.readFileSync(bootstrap, "utf8")).slice(1, -1)),
    "center/src/lib/pin-setup/generated/bootstrap.ts is stale; run bun platform/setup/generate.mjs --write");
});

// macOS ships a BSD sha256sum without --check. The installer runs on Ubuntu,
// where GNU coreutils has it. A shim over shasum stands in for the test.
function gnuSha256sumPath(t) {
  const probe = spawnSync("sha256sum", ["--version"], { encoding: "utf8" });
  if (probe.status === 0 && /GNU coreutils/u.test(probe.stdout)) return process.env.PATH;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "luma-sha256sum-"));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, "sha256sum"), "#!/bin/sh\nexec shasum -a 256 \"$@\"\n", { mode: 0o755 });
  return `${bin}:${process.env.PATH}`;
}

test("bootstrap accepts only the maintainer's signature over the exact SHA256SUMS, and never the placeholder key", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-bootstrap-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const env = { ...process.env, PATH: gnuSha256sumPath(t) };
  const descriptor = path.join(temporary, "luma-1.2.3.release.json");
  fs.writeFileSync(descriptor, "{}\n");
  const checksums = path.join(temporary, "SHA256SUMS");
  const sums = `${createHash("sha256").update("{}\n").digest("hex")}  luma-1.2.3.release.json\n${"a".repeat(64)}  luma-operator-1.2.3-linux.tar.gz\n`;
  fs.writeFileSync(checksums, sums);

  // checksum_listed: the one listed row for a name, checked in place.
  const listed = runSourcedBootstrap('checksum_listed "$1" luma-1.2.3.release.json "$2" && printf listed', [checksums, temporary], env);
  assert.equal(listed.stdout, "listed", listed.stderr);
  assert.notEqual(runSourcedBootstrap('checksum_listed "$1" SHA256SUMS.sigstore.json "$2"', [checksums, temporary], env).status, 0, "an unlisted file");
  fs.writeFileSync(descriptor, "{ }\n");
  assert.notEqual(runSourcedBootstrap('checksum_listed "$1" luma-1.2.3.release.json "$2"', [checksums, temporary], env).status, 0, "changed bytes");
  fs.writeFileSync(descriptor, "{}\n");
  fs.appendFileSync(checksums, `${"b".repeat(64)}  luma-1.2.3.release.json\n`);
  assert.notEqual(runSourcedBootstrap('checksum_listed "$1" luma-1.2.3.release.json "$2"', [checksums, temporary], env).status, 0, "a name listed twice");
  fs.writeFileSync(checksums, sums);

  // The placeholder key authenticates nothing, before cosign is even consulted.
  const placeholder = runSourcedBootstrap(
    'CURRENT_STAGE="Authenticate the latest stable release"; BOOTSTRAP_TMP="$1"; RELEASE_VERSION=1.2.3; RELEASE_SIGNING_PUBLIC_KEY=""; ' +
      'verify_release_checksums /nonexistent/cosign "$2" "$3"',
    [temporary, checksums, path.join(temporary, "SHA256SUMS.sigstore.json")], env,
  );
  assert.equal(placeholder.status, 1);
  assert.match(placeholder.stderr, /This installer carries no release signing key yet, so it can authenticate no release\. The maintainer creates one with \.\/luma release keygen/u);

  if (!cosign) return;
  const key = throwawayKeyPair(cosign, path.join(temporary, "keys"));
  const other = throwawayKeyPair(cosign, path.join(temporary, "other"));
  const signature = path.join(temporary, "SHA256SUMS.sigstore.json");
  signChecksums(cosign, { privateKey: key.privateKey, checksums, signature });
  const verify = (publicKey, sums) => runSourcedBootstrap(
    'CURRENT_STAGE="Authenticate the latest stable release"; BOOTSTRAP_TMP="$1"; RELEASE_VERSION=1.2.3; RELEASE_SIGNING_PUBLIC_KEY="$(cat "$2")"; ' +
      'verify_release_checksums "$3" "$4" "$5" && printf verified',
    [temporary, publicKey, cosign, sums, signature], env,
  );
  const accepted = verify(key.publicKey, checksums);
  assert.equal(accepted.stdout, "verified", accepted.stderr);
  const foreign = verify(other.publicKey, checksums);
  assert.equal(foreign.status, 1);
  assert.match(foreign.stderr, /SHA256SUMS of Luma 1\.2\.3 is not signed by Luma's release signing key, so nothing from it was installed/u);
  fs.writeFileSync(path.join(temporary, "SHA256SUMS.changed"), `${sums}${"c".repeat(64)}  extra\n`);
  const changed = verify(key.publicKey, path.join(temporary, "SHA256SUMS.changed"));
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /is not signed by Luma's release signing key/u);
});

test("bootstrap stops in one sentence when release metadata lacks an asset, before curl runs", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-bootstrap-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "curl.log");
  const metadata = path.join(temporary, "release.json");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh
printf 'args=%s\\n' "$*" >> "$LUMA_TEST_CURL_LOG"
exit 2
`, { mode: 0o755 });
  fs.writeFileSync(metadata, JSON.stringify(latestRelease("0.3.4")));

  const result = runSourcedBootstrap(
    'CURRENT_STAGE="Authenticate the latest stable release"; CHANGE_STATE="Nothing was changed."; ' +
      'RELEASE_METADATA="$1"; RELEASE_TAG=v0.3.4; RELEASE_VERSION=0.3.4; GH_TOKEN=fixture; ' +
      'download_release_asset SHA256SUMS.sigstore.json 65536 "$2"',
    [metadata, path.join(temporary, "SHA256SUMS.sigstore.json")],
    { ...process.env, PATH: `${bin}:${process.env.PATH}`, LUMA_TEST_CURL_LOG: log },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Setup stopped · Authenticate the latest stable release/u);
  assert.match(
    result.stderr,
    /What failed: GitHub's metadata for Luma 0\.3\.4 does not list SHA256SUMS\.sigstore\.json as one valid release file\./u,
  );
  assert.doesNotMatch(result.stderr, /Error:|at file:|curl:|--max-filesize/u);
  assert.equal(fs.existsSync(log), false, "curl never runs with empty arguments");
});

// GNU stat and a recording shred for the unattended-install tests: the
// installer targets Ubuntu, where both are coreutils, and the fake shred
// proves the wiring (which file, when) rather than the overwrite itself.
function unattendedToolPath(t, shredLog) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "luma-unattended-tools-"));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const probe = spawnSync("stat", ["--version"], { encoding: "utf8" });
  if (!(probe.status === 0 && /GNU coreutils/u.test(probe.stdout))) {
    fs.writeFileSync(path.join(bin, "stat"), `#!/bin/sh
case "$1" in
  --format=%a) shift; exec /usr/bin/stat -f %Lp "$@" ;;
  --format=%u) shift; exec /usr/bin/stat -f %u "$@" ;;
  --format=%s) shift; exec /usr/bin/stat -f %z "$@" ;;
esac
exec /usr/bin/stat "$@"
`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(bin, "shred"), `#!/bin/sh
for argument in "$@"; do case "$argument" in --*) ;; *) printf 'shred %s\\n' "$argument" >> "$LUMA_TEST_SHRED_LOG"; rm -f -- "$argument" ;; esac; done
`, { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH}`, LUMA_TEST_SHRED_LOG: shredLog };
}

function secretFile(directory, name, value, mode = 0o600) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, `${value}\n`, { mode });
  fs.chmodSync(file, mode);
  return file;
}

// A stand-in operator release: ./luma records each command's arguments and
// standard input, and fails at the command LUMA_TEST_FAIL_AT names.
function fakeOperator(directory, log) {
  const operator = path.join(directory, "operator");
  fs.mkdirSync(operator);
  fs.writeFileSync(path.join(operator, "luma"), `#!/bin/sh
{ printf 'args=%s\\n' "$*"; printf 'stdin='; cat; printf '\\n'; } >> "${log}"
[ "$*" != "\${LUMA_TEST_FAIL_AT:-}" ] || { echo "fixture: $* failed" >&2; exit 3; }
`, { mode: 0o755 });
  return operator;
}

const UNATTENDED_SETTINGS = Object.freeze({
  LUMA_UNATTENDED: "1",
  LUMA_DOMAIN: "",
  LUMA_DUCKDNS_SUBDOMAIN: "mylumapin",
  LUMA_ACME_EMAIL: "certs@example.com",
  LUMA_OPERATOR_EMAIL: "owner@example.com",
  LUMA_PROFILES: "",
  LUMA_PUBLIC_IP: "",
});

test("bootstrap refuses to run unattended on a template placeholder or an unusable secret file, before anything changes", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-bootstrap-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const shredLog = path.join(temporary, "shred.log");
  const tools = unattendedToolPath(t, shredLog);
  const github = secretFile(temporary, "github-token", "fixture-github-token");
  const duckdns = secretFile(temporary, "duckdns-token", "fixture-duckdns-token");
  const inputs = (overrides) => runSourcedBootstrap("unattended_inputs", [], {
    ...process.env, ...tools, ...UNATTENDED_SETTINGS,
    LUMA_GITHUB_TOKEN_FILE: github, LUMA_DUCKDNS_TOKEN_FILE: duckdns, ...overrides,
  });

  // The whole program, not just the helper: a placeholder stops main at its
  // first stage with the standard stop block, on any host.
  const whole = spawnSync("bash", [bootstrap], {
    encoding: "utf8",
    env: { ...process.env, ...tools, ...UNATTENDED_SETTINGS, LUMA_DOMAIN: "REPLACE_ME_DOMAIN", LUMA_DUCKDNS_SUBDOMAIN: "" },
  });
  assert.equal(whole.status, 1);
  assert.match(whole.stderr, /Setup stopped · Unattended settings/u);
  assert.match(whole.stderr, /What failed: LUMA_DOMAIN still holds the template placeholder\. Fill every REPLACE_ME value in the cloud-init file/u);
  assert.match(whole.stderr, /State: Nothing was changed\./u);
  assert.match(whole.stderr, /Safe retry: Sign in as root and run the interactive install .*or run it unattended again with LUMA_UNATTENDED=1/u);

  const placeholderEmail = inputs({ LUMA_ACME_EMAIL: "REPLACE_ME_ACME_EMAIL" });
  assert.equal(placeholderEmail.status, 1);
  assert.match(placeholderEmail.stderr, /What failed: LUMA_ACME_EMAIL still holds the template placeholder/u);
  assert.equal(fs.existsSync(shredLog), false, "no secret file is touched before the settings are complete");

  const both = inputs({ LUMA_DOMAIN: "center.example.com" });
  assert.match(both.stderr, /Set either LUMA_DOMAIN or LUMA_DUCKDNS_SUBDOMAIN, not both\./u);
  const neither = inputs({ LUMA_DUCKDNS_SUBDOMAIN: "" });
  assert.match(neither.stderr, /LUMA_DOMAIN .* or LUMA_DUCKDNS_SUBDOMAIN .* is required\./u);
  // The GitHub token is optional: a public release and its public images need
  // none, so an unattended install with no token file is accepted and installs
  // anonymously.
  const noFile = inputs({ LUMA_GITHUB_TOKEN_FILE: "" });
  assert.equal(noFile.status, 0, noFile.stderr);
  assert.doesNotMatch(noFile.stderr, /The GitHub token is required/u);

  // An open or empty secret file is refused, and the token is never a setting.
  const open = secretFile(temporary, "open-token", "fixture-open-token", 0o644);
  const openResult = inputs({ LUMA_GITHUB_TOKEN_FILE: open });
  assert.equal(openResult.status, 1);
  assert.match(openResult.stderr, /must have mode 0600, not 644/u);
  assert.doesNotMatch(openResult.stderr, /fixture-open-token/u);
  assert.equal(fs.existsSync(open), true, "a refused file is left for the operator, and cloud-init's own shred removes it");
  const empty = secretFile(temporary, "empty-token", "");
  assert.match(inputs({ LUMA_GITHUB_TOKEN_FILE: empty }).stderr, /file .* is empty\./u);
  assert.equal(fs.existsSync(empty), false, "an empty file was still shredded");

  // A placeholder token is shredded and refused, without reaching GitHub.
  const placeholder = secretFile(temporary, "placeholder-token", "REPLACE_ME_GITHUB_TOKEN");
  const placeholderResult = inputs({ LUMA_GITHUB_TOKEN_FILE: placeholder });
  assert.equal(placeholderResult.status, 1);
  assert.match(placeholderResult.stderr, /The GitHub token file .* still holds the template placeholder/u);
  assert.equal(fs.existsSync(placeholder), false);
  assert.match(fs.readFileSync(shredLog, "utf8"), new RegExp(`shred ${placeholder.replaceAll(".", "\\.")}`, "u"));
});

test("bootstrap runs the unattended install with explicit setup flags, the DuckDNS token on stdin, and shredded token files", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-bootstrap-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const shredLog = path.join(temporary, "shred.log");
  const tools = unattendedToolPath(t, shredLog);
  const commands = path.join(temporary, "luma.log");
  const operator = fakeOperator(temporary, commands);
  const run = (settings, extra = {}) => {
    fs.rmSync(commands, { force: true });
    fs.rmSync(shredLog, { force: true });
    const github = secretFile(temporary, "github-token", "fixture-github-token");
    const duckdns = secretFile(temporary, "duckdns-token", "fixture-duckdns-token");
    const result = runSourcedBootstrap(
      'trap unexpected_failure ERR; set -E; SAFE_RETRY="$UNATTENDED_SAFE_RETRY"; DOCKER_MODE=direct; OPERATOR_DIR="$1"; HOME="$2"; ' +
        // Plain statements, as main runs them: an && list would mute errexit inside the functions.
        'unattended_inputs; run_operator_unattended; printf "GH_TOKEN=%s" "$GH_TOKEN"',
      [operator, temporary],
      {
        ...process.env, ...tools, ...UNATTENDED_SETTINGS, XDG_CONFIG_HOME: path.join(temporary, ".config"),
        LUMA_GITHUB_TOKEN_FILE: github, LUMA_DUCKDNS_TOKEN_FILE: duckdns, ...settings, ...extra,
      },
    );
    return { result, github, duckdns };
  };

  // DuckDNS name, default profiles, and the public IPv4 detected by setup.
  const duck = run({});
  assert.equal(duck.result.status, 0, duck.result.stderr);
  assert.equal(fs.readFileSync(commands, "utf8"), [
    "args=setup production --acme-email certs@example.com --operator-email owner@example.com --duckdns-subdomain mylumapin --duckdns-token-stdin --profile pin --profile search --profile spotify --public-ip auto --update-source https://center.andersmadsen.dk --auto-updates on",
    // The token line ends in a newline, as a file's first line does. The fake echoes it.
    "stdin=fixture-duckdns-token", "",
    "args=doctor production", "stdin=",
    "args=deploy production --dry-run", "stdin=",
    "args=deploy production --confirm", "stdin=",
    "args=verify production", "stdin=",
    "",
  ].join("\n"));
  assert.match(duck.result.stdout, /Center: https:\/\/mylumapin\.duckdns\.org\/login\?next=%2Fsettings%2Fpin%2Fsetup/u);
  assert.match(duck.result.stdout, new RegExp(`First sign-in: show it once with cat ${temporary.replaceAll(".", "\\.")}/\\.config/luma/production/first-login\\.txt`, "u"));
  assert.doesNotMatch(duck.result.stdout, /fixture-duckdns-token/u);
  // Both files were shredded once read. The GitHub token stays in memory for the release stages.
  assert.equal(fs.existsSync(duck.github), false);
  assert.equal(fs.existsSync(duck.duckdns), false);
  assert.equal(fs.readFileSync(shredLog, "utf8"), `shred ${duck.github}\nshred ${duck.duckdns}\n`);
  assert.match(duck.result.stdout, /GH_TOKEN=fixture-github-token$/u);

  // An owned domain: --domain, no token on stdin, and the unread DuckDNS file shredded.
  const owned = run({ LUMA_DOMAIN: "center.example.com", LUMA_DUCKDNS_SUBDOMAIN: "", LUMA_PROFILES: "search", LUMA_PUBLIC_IP: "203.0.113.7" });
  assert.equal(owned.result.status, 0, owned.result.stderr);
  const ownedSetup = fs.readFileSync(commands, "utf8").split("\n")[0];
  assert.equal(ownedSetup, "args=setup production --acme-email certs@example.com --operator-email owner@example.com --domain center.example.com --profile search --update-source https://center.andersmadsen.dk --auto-updates on");
  assert.match(fs.readFileSync(commands, "utf8"), /args=setup production[^\n]*\nstdin=\n/u);
  assert.equal(fs.existsSync(owned.duckdns), false);
  assert.match(owned.result.stdout, /Center: https:\/\/center\.example\.com\//u);

  // No optional features at all, and a full DuckDNS name is accepted.
  const none = run({ LUMA_PROFILES: "none", LUMA_DUCKDNS_SUBDOMAIN: "mylumapin.duckdns.org" });
  assert.equal(none.result.status, 0, none.result.stderr);
  assert.match(fs.readFileSync(commands, "utf8"), /^args=setup production .*--duckdns-subdomain mylumapin --duckdns-token-stdin --no-profiles --update-source https:\/\/center\.andersmadsen\.dk --auto-updates on\n/u);

  // The owner's own update source and automatic updates turned off.
  const own = run({ LUMA_UPDATE_SOURCE: "https://updates.example.net", LUMA_AUTO_UPDATES: "off" });
  assert.equal(own.result.status, 0, own.result.stderr);
  assert.match(fs.readFileSync(commands, "utf8"), /^args=setup production .* --update-source https:\/\/updates\.example\.net --auto-updates off\n/u);
  const wrong = run({ LUMA_AUTO_UPDATES: "sometimes" });
  assert.equal(wrong.result.status, 1);
  assert.match(wrong.result.stderr, /What failed: LUMA_AUTO_UPDATES must be on or off\./u);

  // A failing step stops there, names its stage, and leaves the unattended Safe retry line.
  const failed = run({}, { LUMA_TEST_FAIL_AT: "deploy production --dry-run" });
  assert.equal(failed.result.status, 3);
  assert.match(failed.result.stderr, /Setup stopped · Prove the deployment plan \(deploy --dry-run\)/u);
  assert.match(failed.result.stderr, /State: Host tools, operator access, and the production configuration were preserved\. Production was not deployed\./u);
  assert.match(failed.result.stderr, /Safe retry: Sign in as root and run the interactive install/u);
  // One stop block, naming the command that failed as the owner would type it.
  assert.equal(failed.result.stderr.match(/Setup stopped/gu).length, 1, failed.result.stderr);
  assert.match(failed.result.stderr,
    /What failed: The command `\.\/luma deploy production --dry-run` stopped with exit status 3\. Its own error message is just above this block\./u);
  assert.doesNotMatch(fs.readFileSync(commands, "utf8"), /deploy production --confirm/u);
  assert.doesNotMatch(failed.result.stderr, /fixture-(?:github|duckdns)-token/u);
});

test("bootstrap keeps the interactive path interactive and refuses LUMA_UNATTENDED with --tools-only", () => {
  const source = fs.readFileSync(bootstrap, "utf8");
  // The reconnect hint belongs to the interactive --tools-only path only. The
  // unattended install runs as root (or with passwordless sudo through sg).
  assert.match(source, /if \$tools_only; then[\s\S]*Reconnect over SSH so this session picks up Docker group membership/u);
  const unattendedBody = source.slice(source.indexOf("run_operator_unattended() {"));
  assert.doesNotMatch(unattendedBody.slice(0, unattendedBody.indexOf("\n}\n")), /Reconnect over SSH/u);
  assert.match(source, /if \(\( EUID != 0 \)\) && \$UNATTENDED && ! sudo -n -v/u);
  assert.match(source, /^validate_supported_host \/etc\/os-release/mu);
  // Secrets never arrive as environment values or arguments: only file paths do.
  assert.doesNotMatch(source, /LUMA_GITHUB_TOKEN[^_]|LUMA_DUCKDNS_TOKEN[^_]/u);

  const piped = spawnSync("bash", [bootstrap], { encoding: "utf8", env: { ...process.env, LUMA_UNATTENDED: "" } });
  assert.equal(piped.status, 1);
  assert.match(piped.stderr, /bootstrap requires an interactive terminal \(LUMA_UNATTENDED=1 runs it without one\)/u);
  const tools = spawnSync("bash", [bootstrap, "--tools-only"], { encoding: "utf8", env: { ...process.env, LUMA_UNATTENDED: "1" } });
  assert.equal(tools.status, 1);
  assert.match(tools.stderr, /LUMA_UNATTENDED=1 installs everything; it does not combine with --tools-only\./u);
});

test("the cloud-init template is well-formed, names every unattended input, needs no GitHub token, and shreds the token file", () => {
  const template = fs.readFileSync(path.join(root, "platform/setup/cloud-init.yaml"), "utf8");
  const lines = template.split("\n");
  assert.equal(lines[0], "#cloud-config");
  assert.doesNotMatch(template, /\t/u, "YAML forbids tabs");
  assert.match(template, /^write_files:$/mu);
  assert.match(template, /^runcmd:$/mu);
  // The release and its images are public: the template writes, exports, and
  // shreds no GitHub token.
  assert.doesNotMatch(template, /github-token|GITHUB_TOKEN/u);
  for (const file of ["/etc/luma/install.env", "/etc/luma/duckdns-token"]) {
    const index = lines.indexOf(`  - path: ${file}`);
    assert.notEqual(index, -1, file);
    assert.deepEqual(lines.slice(index + 1, index + 4), ["    owner: root:root", '    permissions: "0600"', "    content: |"], file);
  }
  const placeholders = new Set(template.match(/REPLACE_ME_[A-Z_]+/gu));
  assert.deepEqual([...placeholders].sort(), [
    "REPLACE_ME_ACME_EMAIL", "REPLACE_ME_CENTER_HOST", "REPLACE_ME_DOMAIN",
    "REPLACE_ME_DUCKDNS_TOKEN", "REPLACE_ME_OPERATOR_EMAIL",
  ]);
  for (const setting of ["LUMA_DOMAIN=", "LUMA_DUCKDNS_SUBDOMAIN=", "LUMA_ACME_EMAIL=", "LUMA_OPERATOR_EMAIL=", "LUMA_PROFILES=pin,search,spotify", "LUMA_PUBLIC_IP=auto"]) {
    assert.match(template, new RegExp(`^      ${setting}`, "mu"), setting);
  }
  // The runcmd block is one shell program: it exports the unattended mode and
  // the DuckDNS token file path, fetches the installer over HTTPS only, logs,
  // and shreds the token file even when the installer stopped early.
  const start = lines.indexOf("runcmd:");
  assert.equal(lines[start + 1], "  - |");
  const script = lines.slice(start + 2).filter((line) => line !== "").map((line) => {
    assert.match(line, /^ {4}/u, `runcmd line is indented: ${line}`);
    return line.slice(4);
  }).join("\n");
  const syntax = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(script, /^export HOME=\/root$/mu);
  assert.match(script, /^export LUMA_UNATTENDED=1$/mu);
  assert.match(script, /^export LUMA_DUCKDNS_TOKEN_FILE=\/etc\/luma\/duckdns-token$/mu);
  assert.match(script, /curl --fail[^\n]*--proto '=https' --tlsv1\.2[^\n]*\n[^\n]*"\$INSTALLER_URL"/u);
  assert.match(script, /INSTALLER_URL="https:\/\/REPLACE_ME_CENTER_HOST\/install\.sh"/u);
  assert.match(script, /^ *bash \/root\/luma-install\.sh$/mu);
  assert.doesNotMatch(script, /curl[^\n]*\|\s*(?:sudo\s+)?(?:ba)?sh/u);
  assert.match(script, /\) >> \/var\/log\/luma-install\.log 2>&1$/mu);
  assert.match(script, /^shred --iterations=1 --zero --remove=unlink \/etc\/luma\/duckdns-token /mu);
  assert.match(script, /^exit "\$status"$/mu);
  // Center serves the template from its generated projection, kept in sync by the generator.
  const projection = fs.readFileSync(path.join(root, "center/src/lib/pin-setup/generated/cloud-init.ts"), "utf8");
  assert.equal(JSON.parse(projection.slice(projection.indexOf("= ") + 2, projection.lastIndexOf(";"))), template);
});

test("a Center serves the installer with its own origin as the new server's update source", async (t) => {
  const committed = JSON.parse(fs.readFileSync(path.join(root, "platform/distribution/update-source.json"), "utf8")).origin;
  const source = fs.readFileSync(bootstrap, "utf8");
  // The raw copy names the committed default, on exactly one line.
  assert.deepEqual(source.split("\n").filter((line) => line.startsWith("LUMA_UPDATE_SOURCE_DEFAULT=")),
    [`LUMA_UPDATE_SOURCE_DEFAULT="${committed}"`]);
  const { LUMA_BOOTSTRAP, bootstrapForOrigin } = await import("../../../center/src/lib/pin-setup/generated/bootstrap.ts");
  assert.equal(LUMA_BOOTSTRAP, source);
  const served = bootstrapForOrigin("https://center.example.org");
  assert.equal(served, source.replace(`LUMA_UPDATE_SOURCE_DEFAULT="${committed}"`,
    'LUMA_UPDATE_SOURCE_DEFAULT="https://center.example.org"'));
  for (const origin of ["https://center.example.org/path", "javascript:alert(1)", 'https://a.example"; rm -rf /; "']) {
    assert.throws(() => bootstrapForOrigin(origin), /not a Center origin/u, origin);
  }

  // The served script, run as the installer runs: the unattended setup and
  // the interactive onboarding both offer the serving Center.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-bootstrap-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const script = path.join(temporary, "install.sh");
  fs.writeFileSync(script, served, { mode: 0o755 });
  const shredLog = path.join(temporary, "shred.log");
  const tools = unattendedToolPath(t, shredLog);
  const commands = path.join(temporary, "luma.log");
  const operator = fakeOperator(temporary, commands);
  const unattended = spawnSync("bash", ["-c",
    'source "$1"; trap unexpected_failure ERR; set -E; DOCKER_MODE=direct; OPERATOR_DIR="$2"; HOME="$3"; ' +
      'unattended_inputs; run_operator_unattended', "install-test", script, operator, temporary], {
    encoding: "utf8",
    env: {
      ...process.env, ...tools, ...UNATTENDED_SETTINGS, LUMA_DOMAIN: "center.example.com", LUMA_DUCKDNS_SUBDOMAIN: "",
      LUMA_PROFILES: "search", XDG_CONFIG_HOME: path.join(temporary, ".config"),
      LUMA_GITHUB_TOKEN_FILE: secretFile(temporary, "github-token", "fixture-github-token"),
      LUMA_DUCKDNS_TOKEN_FILE: secretFile(temporary, "duckdns-token", "fixture-duckdns-token"),
    },
  });
  assert.equal(unattended.status, 0, unattended.stderr);
  assert.match(fs.readFileSync(commands, "utf8"),
    /^args=setup production .* --update-source https:\/\/center\.example\.org --auto-updates on\n/u);
  fs.rmSync(commands);
  const interactive = spawnSync("bash", ["-c", 'source "$1"; run_operator direct "$2" </dev/null', "install-test", script, operator], {
    encoding: "utf8",
  });
  assert.equal(interactive.status, 0, interactive.stderr);
  assert.equal(fs.readFileSync(commands, "utf8").split("\n")[0],
    "args=onboard production --update-source https://center.example.org");
});

test("bootstrap keeps the token it holds for updates in one private file, never in an argument", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-bootstrap-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const secrets = path.join(temporary, "config/luma/secrets");
  const result = runSourcedBootstrap('umask 022; GH_TOKEN=fixture-update-token; save_github_token "$1"', [secrets]);
  assert.equal(result.status, 0, result.stderr);
  const file = path.join(secrets, "github-token");
  assert.equal(fs.readFileSync(file, "utf8"), "fixture-update-token\n");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  for (const directory of [secrets, path.dirname(secrets)]) assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(secrets), ["github-token"], "no partial file is left behind");
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-update-token/u);
  // Only the shell builtin printf ever sees the token.
  const source = fs.readFileSync(bootstrap, "utf8");
  const body = source.slice(source.indexOf("save_github_token() {"));
  assert.deepEqual(body.slice(0, body.indexOf("\n}\n")).split("\n").filter((line) => line.includes("GH_TOKEN")),
    ["  ( umask 077; printf '%s\\n' \"$GH_TOKEN\" > \"$partial\" )"]);
  assert.match(source, /^\s*save_github_token "\$\{XDG_CONFIG_HOME:-\$HOME\/\.config\}\/luma\/secrets"$/mu);
});
