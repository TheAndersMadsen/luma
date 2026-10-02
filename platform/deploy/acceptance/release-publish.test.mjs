import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { IMAGE_NAMES } from "../../distribution/release-descriptor.mjs";
import { RELEASE_SIGNATURE_NAME } from "../../distribution/release-proof.mjs";
import { cosignOrExplain, FIXTURE_PASSWORD, throwawayKeyPair } from "./release-signing-fixture.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "luma-release-publish-"));
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
// context.js resolves these when it loads, so they are set before require.
process.env.LUMA_DATA_DIR = dataDir;
process.env.LUMA_BUILD_DIR = path.join(dataDir, "build");
process.env.LUMA_SECRETS_DIR = path.join(dataDir, "secrets");
const require = createRequire(import.meta.url);
const release = require("../../cli/release.js");

// The maintainer's key pair for these tests: a throwaway one under the test's
// secrets directory, and a copy of its public key standing in for the
// committed platform/distribution/release-signing.pub and the bootstrap embed.
const cosign = cosignOrExplain("cosign signing in release publish (simulated by the fake runtime)");
const signingKeys = (() => {
  const checkout = path.join(dataDir, "checkout");
  fs.mkdirSync(checkout, { recursive: true });
  fs.copyFileSync(path.join(root, "bootstrap"), path.join(checkout, "bootstrap"));
  const keys = { privateKey: release.RELEASE_SIGNING.privateKey, publicKey: path.join(checkout, "release-signing.pub"), bootstrap: path.join(checkout, "bootstrap") };
  if (cosign) {
    const generated = throwawayKeyPair(cosign, path.dirname(keys.privateKey));
    assert.equal(generated.privateKey, keys.privateKey);
    fs.copyFileSync(generated.publicKey, keys.publicKey);
    const other = throwawayKeyPair(cosign, path.join(dataDir, "other-key"));
    keys.otherPublicKey = other.publicKey;
  } else {
    fs.mkdirSync(path.dirname(keys.privateKey), { recursive: true, mode: 0o700 });
    fs.writeFileSync(keys.privateKey, "simulated private key\n", { mode: 0o600 });
    fs.writeFileSync(keys.publicKey, "-----BEGIN PUBLIC KEY-----\nc2ltdWxhdGVk\n-----END PUBLIC KEY-----\n");
    fs.writeFileSync(path.join(dataDir, "other.pub"), "-----BEGIN PUBLIC KEY-----\nb3RoZXI=\n-----END PUBLIC KEY-----\n");
    keys.otherPublicKey = path.join(dataDir, "other.pub");
  }
  return Object.freeze(keys);
})();

// The signing step through the installed cosign, or its stand-in when cosign
// is absent (announced once above): the stand-in accepts a signature made
// with the same key file it verifies against.
function runCosign(args) {
  if (cosign) {
    const result = spawnSync(cosign, args, {
      encoding: "utf8",
      env: { ...process.env, COSIGN_PASSWORD: FIXTURE_PASSWORD },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  }
  if (args[0] === "sign-blob") {
    fs.writeFileSync(after_(args, "--bundle"), `${JSON.stringify({ simulated: fs.readFileSync(after_(args, "--key"), "utf8") })}\n`);
    return { status: 0, stdout: "", stderr: "" };
  }
  const bundle = JSON.parse(fs.readFileSync(after_(args, "--bundle"), "utf8"));
  const accepted = bundle.simulated === "simulated private key\n" &&
    fs.readFileSync(after_(args, "--key"), "utf8") === fs.readFileSync(signingKeys.publicKey, "utf8");
  return accepted ? { status: 0, stdout: "Verified OK\n", stderr: "" } : { status: 1, stdout: "", stderr: "Error: invalid signature\n" };
}

const REVISION = "a".repeat(40);
const OTHER_REVISION = "b".repeat(40);
const TAG_OBJECT = "c".repeat(40);
const PREFIX = "ghcr.io/theandersmadsen/luma";
const coordinates = JSON.parse(fs.readFileSync(
  path.join(root, "platform/distribution/pin-release-coordinates.json"),
  "utf8",
));
const pinned = Object.freeze({
  schemaVersion: 1,
  archive: coordinates.signedReleaseSource.archive,
  sha256: coordinates.signedReleaseSource.sha256,
  size: coordinates.signedReleaseSource.size,
  releaseId: coordinates.signedReleaseSource.releaseId,
  version: coordinates.version,
  versionCode: coordinates.versionCode,
  signerSha256: coordinates.signedReleaseSource.signerSha256,
  manifestSha256: coordinates.signedReleaseSource.manifestSha256,
  receiptsSha256: coordinates.signedReleaseSource.receiptsSha256,
});

function digest(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function after_(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// A ghcr.io token whose granted repository scopes are `actions`.
function ghcrToken(actions, name = "theandersmadsen/luma") {
  const claims = Buffer.from(JSON.stringify({ access: [{ type: "repository", name, actions }] }))
    .toString("base64url");
  return `header.${claims}.signature`;
}

// Stubs git, Docker, gh, the Pin release commands, and the distribution scripts,
// recording every call in order. `failures[name]` fails that many push attempts.
function fakeRuntime({
  head = REVISION,
  status = "",
  tagType = "tag",
  tagCommit = head,
  failures = {},
  pushError = "ERROR: failed to push: write tcp: broken pipe",
  describe = () => pinned,
  published = [{ name: pinned.archive, size: pinned.size, digest: `sha256:${pinned.sha256}` }],
  viewError = null,
  downloadError = null,
  builderError = 'ERROR: no builder "luma-release" found\n',
  githubState = { ref: null, release: null },
  githubError = null,
  githubResponse = null,
  existingRefs = [],
  credential = "maintainer:fixture-pat",
  token = ghcrToken(["pull", "push"]),
  tokenStatus = 200,
  tokenError = null,
  signing = signingKeys,
} = {}) {
  const calls = [];
  const printed = [];
  const sleeps = [];
  const tokenRequests = [];
  const remaining = { ...failures };
  const concurrency = { local: 0, maxLocal: 0, pushes: 0, maxPushes: 0 };
  const local = async () => {
    concurrency.local += 1;
    concurrency.maxLocal = Math.max(concurrency.maxLocal, concurrency.local);
    await delay(5);
    concurrency.local -= 1;
  };
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const runtime = {
    calls,
    printed,
    sleeps,
    tokenRequests,
    concurrency,
    signing,
    print: (line) => printed.push(line),
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    ghcrCredential: () => credential,
    async fetch(url, options) {
      tokenRequests.push({ url, options });
      if (tokenError) throw tokenError;
      return { status: tokenStatus, json: async () => ({ token }) };
    },
    describePin: async (archive) => describe(archive),
    async spawn(command, args, options = {}) {
      calls.push({ command, args, options });
      if (command === "cosign") {
        assert.equal(options.cosign, true, "cosign alone receives COSIGN_PASSWORD and the terminal");
        assert.doesNotMatch(args.join(" "), /PASSWORD|fixture-release-key/u, "no password in cosign's arguments");
        return runCosign(args);
      }
      if (command === "git") {
        const key = args.slice(1).join(" ");
        if (key === "rev-parse --verify HEAD") return ok(`${head}\n`);
        if (key === "status --porcelain") return ok(status);
        if (key.startsWith("cat-file -t refs/tags/")) {
          return tagType ? ok(`${tagType}\n`) : { status: 128, stdout: "", stderr: "fatal: not a valid object" };
        }
        if (/^rev-parse --verify refs\/tags\/v.+\^\{commit\}$/u.test(key)) return ok(`${tagCommit}\n`);
        if (/^rev-parse --verify refs\/tags\/v.+$/u.test(key)) return ok(`${TAG_OBJECT}\n`);
        if (key === "show -s --format=%cI HEAD") return ok("2026-09-23T10:00:00+02:00\n");
      }
      if (command === "docker") {
        const key = args.join(" ");
        if (key === "compose version --short") return ok("2.39.1\n");
        if (key === "buildx inspect --bootstrap luma-release") {
          return { status: 1, stdout: "", stderr: builderError };
        }
        if (key.startsWith("buildx create ")) return ok();
        if (args[0] === "buildx" && args[1] === "imagetools" && args[2] === "inspect" &&
            !args.includes("--raw") && !args.includes("--format")) {
          return existingRefs.includes(args[3])
            ? ok()
            : { status: 1, stdout: "", stderr: "no such manifest\n" };
        }
        if (args[0] === "buildx" && args[1] === "build") {
          const name = after_(args, "--tag").replace(`${PREFIX}/`, "").replace(/:v.*$/u, "");
          if (args.includes("type=cacheonly")) {
            await local();
            return ok();
          }
          concurrency.pushes += 1;
          concurrency.maxPushes = Math.max(concurrency.maxPushes, concurrency.pushes);
          await delay(2);
          concurrency.pushes -= 1;
          if ((remaining[name] ?? 0) > 0) {
            remaining[name] -= 1;
            return { status: 1, stdout: "", stderr: `${pushError}\n` };
          }
          fs.writeFileSync(after_(args, "--metadata-file"), JSON.stringify({ "containerimage.digest": digest(name) }));
          return ok();
        }
        if (key.startsWith("buildx imagetools inspect --raw ")) {
          return ok(JSON.stringify({
            manifests: [
              { platform: { os: "linux", architecture: "amd64" } },
              { platform: { os: "linux", architecture: "arm64" } },
              { platform: { os: "unknown", architecture: "unknown" } },
            ],
          }));
        }
        if (args[0] === "compose" && args.includes("config")) return ok('{"services":{}}');
        if (args[0] === "compose" && args.includes("publish")) return ok();
        if (key.startsWith("buildx imagetools inspect ") && key.endsWith("--format {{json .Manifest}}")) {
          return ok(JSON.stringify({ digest: digest("application") }));
        }
      }
      if (command === "gh" && args[0] === "api" && args[1] === "graphql") {
        assert.equal(options.github, true, "the private repository lookup receives GH_TOKEN through the environment");
        assert.ok(args.includes("owner=TheAndersMadsen"));
        assert.ok(args.includes("name=luma"));
        const tag = args.find((arg) => arg.startsWith("tag="))?.slice(4);
        assert.ok(args.includes(`ref=refs/tags/${tag}`));
        if (githubError) return { status: 1, stdout: "", stderr: githubError };
        return ok(githubResponse ?? JSON.stringify({ data: { repository: githubState } }));
      }
      if (command === "gh" && args[0] === "release" && args[1] === "view") {
        assert.deepEqual(args.slice(2), [
          coordinates.signedReleaseSource.tag, "--repo", coordinates.signedReleaseSource.repository, "--json", "assets",
        ]);
        assert.equal(options.github, true, "only gh receives GH_TOKEN");
        if (viewError) return { status: 1, stdout: "", stderr: `${viewError}\n` };
        return ok(JSON.stringify({ assets: [{ name: "SHA256SUMS", size: 284 }, ...published] }));
      }
      if (command === "gh" && args[0] === "release" && args[1] === "download") {
        await local();
        if (downloadError) return { status: 1, stdout: "", stderr: `${downloadError}\n` };
        fs.writeFileSync(path.join(after_(args, "--dir"), after_(args, "--pattern")), "signed pin archive\n");
        return ok();
      }
      if (command === "bun") {
        const script = path.basename(args[0]);
        if (script === "publication-environment.mjs") {
          fs.writeFileSync(args[2], "LUMA_RELEASE_ID=placeholder\n");
          return ok();
        }
        if (script === "audit-compose-publication.mjs") {
          assert.equal(options.input, '{"services":{}}', "the audit reads the rendered Compose model");
          return ok("6 publishable services\n");
        }
        if (script === "build.mjs") {
          const output = after_(args, "--output");
          const version = after_(args, "--version");
          const pinArchive = after_(args, "--pin-archive");
          fs.mkdirSync(output, { recursive: true });
          const files = {
            [`luma-operator-${version}-linux.tar.gz`]: "operator archive\n",
            [`luma-${version}.release.json`]: "{}\n",
            [path.basename(pinArchive)]: fs.readFileSync(pinArchive),
          };
          const rows = Object.entries(files).map(([name, contents]) => {
            fs.writeFileSync(path.join(output, name), contents);
            return `${createHash("sha256").update(contents).digest("hex")}  ${name}`;
          }).sort();
          fs.writeFileSync(path.join(output, "SHA256SUMS"), `${rows.join("\n")}\n`);
          return ok();
        }
        if (script === "luma" && args.slice(1, 4).join(" ") === "pin release build") {
          await local();
          return ok();
        }
        if (script === "luma" && args.slice(1, 4).join(" ") === "pin release export") {
          fs.writeFileSync(after_(args, "--output"), "freshly signed pin archive\n");
          return ok();
        }
      }
      throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
    },
  };
  return runtime;
}

function options(version, extra = {}) {
  return { version, pinVersion: null, pinVersionCode: null, confirm: true, ...extra };
}

function kind(call) {
  const { command, args } = call;
  if (command === "docker" && args[1] === "build") {
    const name = after_(args, "--tag").replace(`${PREFIX}/`, "").replace(/:v.*$/u, "");
    return `${args.includes("type=cacheonly") ? "build" : "push"} ${name}`;
  }
  if (command === "docker" && args[0] === "buildx" && args[1] === "imagetools" &&
      !args.includes("--raw") && !args.includes("--format")) {
    return `probe ${args[3].replace(`${PREFIX}/`, "").split(":")[0]}`;
  }
  if (command === "docker" && args.includes("--raw")) return `inspect ${args.at(-1).replace(`${PREFIX}/`, "").replace(/@.*$/u, "")}`;
  if (command === "docker" && args[0] === "compose") return `compose ${args.includes("publish") ? "publish" : args.includes("config") ? "config" : "version"}`;
  if (command === "docker" && args.includes("{{json .Manifest}}")) return "inspect application";
  if (command === "gh") return args[0] === "api" ? "check GitHub" : args[1] === "view" ? "find pin" : "download pin";
  if (command === "bun") return path.basename(args[0]) === "luma" ? `pin ${args[3]}` : path.basename(args[0]);
  if (command === "cosign") return `cosign ${args[0]}`;
  return `${command} ${args[1] ?? args[0]}`;
}

function publication(version) {
  return release.publicationPaths(version);
}

test("release image build inputs cover exactly the descriptor's image set", () => {
  assert.deepEqual(Object.keys(release.IMAGES).sort(), [...IMAGE_NAMES].sort());
  for (const [name, image] of Object.entries(release.IMAGES)) {
    assert.ok(fs.statSync(path.join(root, image.context)).isDirectory(), `${name} build context`);
    assert.ok(fs.statSync(path.join(root, image.dockerfile)).isFile(), `${name} Dockerfile`);
  }
  assert.equal(release.ATTEMPTS, 5);
});

test("publish arguments are exact", () => {
  assert.deepEqual(release.parsePublishArguments(["--version", "1.2.3"]), {
    version: "1.2.3", pinVersion: null, pinVersionCode: null, notes: null, confirm: false,
  });
  assert.deepEqual(release.parsePublishArguments([
    "--version", "1.2.3-rc.1", "--pin-version", "2026-09-23.1", "--pin-version-code", "202609231", "--confirm",
  ]), { version: "1.2.3-rc.1", pinVersion: "2026-09-23.1", pinVersionCode: 202609231, notes: null, confirm: true });
  // Release notes come from a file or, with -, from standard input.
  assert.equal(release.parsePublishArguments(["--version", "1.2.3", "--notes", "-"]).notes, "-");
  assert.equal(release.parsePublishArguments(["--version", "1.2.3", "--notes", "notes.txt"]).notes, "notes.txt");
  for (const argv of [
    [],
    ["--version", "v1.2.3"],
    ["--version", "1.2.3", "--version", "1.2.4"],
    ["--version", "1.2.3", "--pin-version", "2026-09-23.1"],
    ["--version", "1.2.3", "--pin-version-code", "7"],
    ["--version", "1.2.3", "--pin-version", "2026-9-23", "--pin-version-code", "7"],
    ["--version", "1.2.3", "--pin-version", "2026-09-23.1", "--pin-version-code", "0"],
    ["--version", "1.2.3", "--confirm", "--confirm"],
    ["--version", "1.2.3", "--signing-env", "file"],
    ["--version", "1.2.3", "--notes"],
    ["--version", "1.2.3", "--notes", "a", "--notes", "b"],
  ]) {
    assert.throws(() => release.parsePublishArguments(argv), Error, argv.join(" "));
  }
});

test("publish refuses a dirty tree and a missing, lightweight, or moved tag before building anything", async () => {
  for (const [fixture, pattern] of [
    [{ status: " M README.md\n?? stray.txt" }, /working tree with 2 changed or untracked paths/u],
    [{ tagType: null }, /v1\.0\.1 is missing or is not an annotated tag/u],
    [{ tagType: "commit" }, /v1\.0\.1 is missing or is not an annotated tag/u],
    [{ tagCommit: OTHER_REVISION }, new RegExp(`v1\\.0\\.1 names ${OTHER_REVISION}, not the checked-out HEAD`, "u")],
  ]) {
    const runtime = fakeRuntime(fixture);
    await assert.rejects(release.publishRelease(options("1.0.1"), runtime), pattern);
    assert.deepEqual(runtime.calls.map((call) => call.command), runtime.calls.map(() => "git"));
  }
  assert.equal(fs.existsSync(publication("1.0.1").root), false);
});

test("without --confirm the command prints the plan and changes nothing", async () => {
  const runtime = fakeRuntime();
  assert.equal(await release.publishRelease(options("1.0.2", { confirm: false }), runtime), null);
  const plannedSteps = [
    "compose version", "find pin", "check GitHub",
    ...[...IMAGE_NAMES, "application"].map((name) => `probe ${name}`),
  ];
  assert.deepEqual(runtime.calls.filter((call) => call.command !== "git").map(kind), plannedSteps,
    "the plan checks the pinned Pin archive and that nothing is published yet");
  assert.equal(fs.existsSync(publication("1.0.2").root), false);
  assert.deepEqual(runtime.tokenRequests, [{
    url: "https://ghcr.io/token?service=ghcr.io&scope=repository:theandersmadsen/luma:pull,push",
    options: { headers: { authorization: `Basic ${Buffer.from("maintainer:fixture-pat").toString("base64")}` } },
  }], "the plan verifies the ghcr.io login can write the repository's package");
  const text = runtime.printed.join("\n");
  assert.match(text, /annotated tag v1\.0\.2/u);
  assert.match(text, /build center, center-iroh-bridge, cosmos, keycloak, spotify-adapter for linux\/amd64 \+ linux\/arm64/u);
  assert.match(text, new RegExp(`republish the pinned ${pinned.archive.replaceAll(".", "\\.")}`, "u"));
  assert.match(text, /Plan only: nothing was built, pushed, or published/u);
  assert.match(text, /The plan reads only this machine's receipts/u);
  assert.match(text, new RegExp(`signature    sign SHA256SUMS with ${signingKeys.privateKey.replaceAll(".", "\\.")}, verified with the committed \\S+release-signing\\.pub`, "u"));

  const building = fakeRuntime();
  await release.publishRelease(options("1.0.2", { confirm: false, pinVersion: "2026-09-24.1", pinVersionCode: 202609241 }), building);
  assert.match(building.printed.join("\n"),
    /build and sign 2026-09-24\.1 \(versionCode 202609241\) with the Pin signing key \S+\/pin\/signing\.env/u);
});

test("a confirmed publish builds in parallel, pushes one image at a time, then publishes and packs", async () => {
  const runtime = fakeRuntime();
  const result = await release.publishRelease(options("1.0.3"), runtime);
  const paths = publication("1.0.3");
  const steps = runtime.calls.filter((call) => call.command !== "git").map(kind);
  const localBuilds = [...IMAGE_NAMES.map((name) => `build ${name}`), "download pin"];
  assert.deepEqual(steps.slice(0, 11), [
    "compose version", "find pin", "check GitHub",
    ...[...IMAGE_NAMES, "application"].map((name) => `probe ${name}`),
    "docker inspect", "docker create",
  ]);
  assert.ok(runtime.calls.some((call) => call.args.join(" ") === "buildx inspect --bootstrap luma-release"),
    "the builder is booted once before the parallel builds");
  assert.deepEqual(steps.slice(11, 17).sort(), localBuilds.sort());
  assert.deepEqual(steps.slice(17), [
    ...IMAGE_NAMES.flatMap((name) => [`push ${name}`, `inspect ${name}`]),
    "publication-environment.mjs",
    "compose config",
    "audit-compose-publication.mjs",
    "compose publish",
    "inspect application",
    "build.mjs",
    "cosign sign-blob",
    "cosign verify-blob",
  ]);
  assert.equal(runtime.concurrency.maxLocal, 6, "the five image builds and the Pin step run together");
  assert.equal(runtime.concurrency.maxPushes, 1, "pushes never overlap");
  assert.deepEqual(runtime.sleeps, []);

  for (const call of runtime.calls.filter((entry) => entry.command === "docker" && entry.args[1] === "build")) {
    const name = after_(call.args, "--tag").replace(`${PREFIX}/`, "").replace(/:v.*$/u, "");
    assert.equal(after_(call.args, "--tag"), `${PREFIX}/${name}:v1.0.3`);
    assert.equal(after_(call.args, "--builder"), "luma-release");
    assert.equal(after_(call.args, "--platform"), "linux/amd64,linux/arm64");
    assert.ok(call.args.includes("--provenance=mode=max") && call.args.includes("--sbom=true") && call.args.includes("--pull"));
    assert.equal(after_(call.args, "--build-arg"), name === "center" ? `LUMA_RELEASE_ID=${REVISION}` : undefined);
    assert.equal(after_(call.args, "--build-context"),
      ["center", "cosmos"].includes(name) ? "wire_contracts=./contracts/wire" : undefined);
    assert.ok(call.args.includes(`org.opencontainers.image.revision=${REVISION}`));
    assert.doesNotMatch(call.args.join(" "), /SECRET|TOKEN|PASSWORD|PIN_SIGNING|KEYSTORE/u);
  }
  const download = runtime.calls.find((call) => kind(call) === "download pin");
  assert.equal(download.args[2], coordinates.signedReleaseSource.tag);
  assert.equal(after_(download.args, "--repo"), coordinates.signedReleaseSource.repository);
  assert.equal(after_(download.args, "--pattern"), pinned.archive);
  assert.equal(runtime.calls.some((call) => call.args.includes("pin") && call.args.includes("build")), false,
    "without --pin-version the pinned signed archive is republished, never rebuilt");
  const publish = runtime.calls.find((call) => call.command === "docker" && call.args.includes("publish"));
  assert.deepEqual(publish.args, [
    "compose", "--env-file", paths.environment,
    "-f", "compose.yaml", "-f", "platform/compose/production.yaml",
    "--profile", "*",
    "publish", "--yes", "--resolve-image-digests", `${PREFIX}/application:v1.0.3`,
  ]);
  const pack = runtime.calls.find((call) => call.command === "bun" && path.basename(call.args[0]) === "build.mjs");
  assert.deepEqual(pack.args.slice(1), [
    "--version", "1.0.3", "--revision", REVISION, "--repository", "TheAndersMadsen/luma", "--tag", "v1.0.3",
    "--receipts", paths.receipts, "--pin-archive", path.join(paths.pin, pinned.archive), "--output", paths.operator,
  ]);

  for (const name of IMAGE_NAMES) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(paths.receipts, `${name}.json`), "utf8")), {
      schemaVersion: 2,
      name,
      reference: `${PREFIX}/${name}@${digest(name)}`,
      digest: digest(name),
      platforms: ["linux/amd64", "linux/arm64"],
    });
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(paths.receipts, "application.json"), "utf8")), {
    schemaVersion: 1,
    reference: `oci://${PREFIX}/application@${digest("application")}`,
    digest: digest("application"),
  });
  assert.equal(fs.statSync(paths.root).mode & 0o777, 0o700);
  assert.deepEqual(result.artifacts.map((artifact) => artifact.name).sort(), [
    "luma-1.0.3.release.json", "luma-operator-1.0.3-linux.tar.gz", pinned.archive,
  ].sort());
  const text = runtime.printed.join("\n");
  assert.match(text, new RegExp(`Release v1\\.0\\.3 is ready in ${paths.operator.replaceAll(".", "\\.")}`, "u"));
  assert.match(text, /SHA256SUMS:\n[0-9a-f]{64} {2}\S+\n[0-9a-f]{64} {2}\S+\n[0-9a-f]{64} {2}\S+/u);
  assert.equal(fs.existsSync(paths.nextPinCoordinates), false);

  // The signature is the fifth release file: made with the private key,
  // verified against the committed public key, and never counted as a
  // checksummed artifact.
  const sign = runtime.calls.find((call) => kind(call) === "cosign sign-blob");
  assert.deepEqual(sign.args, [
    "sign-blob", "--yes", "--key", signingKeys.privateKey, "--use-signing-config=false", "--tlog-upload=false",
    "--bundle", path.join(paths.operator, RELEASE_SIGNATURE_NAME), path.join(paths.operator, "SHA256SUMS"),
  ]);
  const verify = runtime.calls.find((call) => kind(call) === "cosign verify-blob");
  assert.deepEqual(verify.args, [
    "verify-blob", "--key", signingKeys.publicKey, "--bundle", path.join(paths.operator, RELEASE_SIGNATURE_NAME),
    "--insecure-ignore-tlog", path.join(paths.operator, "SHA256SUMS"),
  ]);
  assert.ok(fs.statSync(path.join(paths.operator, RELEASE_SIGNATURE_NAME)).size > 0);
  assert.match(text, /\[5\/5\] Release signature\n  signing SHA256SUMS with \S+\n  SHA256SUMS\.sigstore\.json verified with \S+release-signing\.pub/u);
  assert.match(text, /SHA256SUMS\.sigstore\.json  \d+ bytes/u);
  assert.match(text, /Send the 5 files to the installer/u);
  assert.match(text, /To put it on GitHub: git push origin v1\.0\.3, then gh release create v1\.0\.3/u);
  if (cosign) {
    // The published signature verifies with the standalone verifier the
    // installer and pin release acquire use, and not under another key.
    const { verifyReleaseChecksums } = await import("../../distribution/release-proof.mjs");
    const options = {
      checksumsPath: path.join(paths.operator, "SHA256SUMS"),
      signaturePath: path.join(paths.operator, RELEASE_SIGNATURE_NAME),
      provisionVerifier: async () => cosign,
    };
    assert.ok((await verifyReleaseChecksums({ ...options, publicKeyPath: signingKeys.publicKey }))["luma-1.0.3.release.json"]);
    await assert.rejects(verifyReleaseChecksums({ ...options, publicKeyPath: signingKeys.otherPublicKey }), /Cosign rejected/u);
  }
});

test("a confirmed publish refuses without the signing key or with the placeholder public key, before any build", async () => {
  const keygen = /create it with `\.\/luma release keygen`, commit the public key it writes \(platform\/distribution\/release-signing\.pub, bootstrap, and the projection from `bun platform\/setup\/generate\.mjs --write`\), then publish/u;
  const missing = fakeRuntime({ signing: { ...signingKeys, privateKey: path.join(dataDir, "absent", "cosign.key") } });
  await assert.rejects(release.publishRelease(options("1.2.1"), missing), (error) => {
    assert.match(error.message, /the release signing key \S+\/absent\/cosign\.key is missing on this machine; /u);
    assert.match(error.message, keygen);
    return true;
  });
  assert.equal(missing.calls.some((call) => /^(?:build|push|download|cosign) /u.test(kind(call))), false, "nothing is built");
  assert.equal(fs.existsSync(publication("1.2.1").root), false);
  const plan = missing.printed.join("\n");
  assert.match(plan, /signature    sign SHA256SUMS with \S+\/absent\/cosign\.key \(MISSING on this machine: the confirmed run will refuse; \.\/luma release keygen creates it\)/u);

  const placeholderPath = path.join(dataDir, "placeholder.pub");
  fs.writeFileSync(placeholderPath, "");
  const placeholder = fakeRuntime({ signing: { ...signingKeys, publicKey: placeholderPath } });
  await assert.rejects(release.publishRelease(options("1.2.1"), placeholder), (error) => {
    assert.match(error.message, /placeholder\.pub is the empty placeholder, so no installer could verify this release; /u);
    assert.match(error.message, keygen);
    return true;
  });
  assert.match(placeholder.printed.join("\n"), /placeholder\.pub is the empty PLACEHOLDER \(the confirmed run will refuse; \.\/luma release keygen writes it/u);

  // The committed placeholder itself is reported the same way by the real paths.
  const committed = fs.readFileSync(release.RELEASE_SIGNING.publicKey, "utf8");
  const real = fakeRuntime({ signing: { ...signingKeys, publicKey: release.RELEASE_SIGNING.publicKey } });
  assert.equal(await release.publishRelease(options("1.2.1", { confirm: false }), real), null);
  assert.match(real.printed.join("\n"), committed.length === 0
    ? /platform\/distribution\/release-signing\.pub is the empty PLACEHOLDER/u
    : /verified with the committed platform\/distribution\/release-signing\.pub/u);
});

test("a signature the committed public key cannot verify is discarded, never published", async () => {
  const foreign = fakeRuntime({ signing: { ...signingKeys, publicKey: signingKeys.otherPublicKey } });
  await assert.rejects(
    release.publishRelease(options("1.2.2"), foreign),
    /SHA256SUMS\.sigstore\.json does not verify against \S+ \(.*\); the committed public key is not this machine's \S+cosign\.key\. Commit the public key of the key that signs releases/u,
  );
  const paths = publication("1.2.2");
  assert.equal(fs.existsSync(path.join(paths.operator, RELEASE_SIGNATURE_NAME)), false, "the unverifiable signature is removed");
  assert.equal(fs.existsSync(path.join(paths.operator, "SHA256SUMS")), true, "the packed archive stays for the rerun");

  // The rerun with the right public key signs again and finishes.
  const corrected = fakeRuntime();
  await release.publishRelease(options("1.2.2"), corrected);
  assert.deepEqual(corrected.calls.filter((call) => call.command === "cosign").map(kind), ["cosign sign-blob", "cosign verify-blob"]);
  assert.ok(fs.statSync(path.join(paths.operator, RELEASE_SIGNATURE_NAME)).size > 0);
});

test("release keygen creates the key pair once and records the public key in the checkout", async (t) => {
  const checkout = fs.mkdtempSync(path.join(dataDir, "keygen-checkout-"));
  fs.copyFileSync(path.join(root, "bootstrap"), path.join(checkout, "bootstrap"));
  fs.writeFileSync(path.join(checkout, "release-signing.pub"), "");
  const secrets = path.join(process.env.LUMA_SECRETS_DIR, "keygen-release");
  const signing = { privateKey: path.join(secrets, "cosign.key"), publicKey: path.join(checkout, "release-signing.pub"), bootstrap: path.join(checkout, "bootstrap") };
  const runtime = fakeRuntime({ signing });
  if (!cosign) {
    // The stand-in writes what cosign generate-key-pair would.
    runtime.spawn = async (command, args, options) => {
      assert.deepEqual([command, args, options.cosign, options.cwd], ["cosign", ["generate-key-pair", "--output-key-prefix", "cosign"], true, secrets]);
      fs.writeFileSync(path.join(secrets, "cosign.key"), "simulated private key\n", { mode: 0o600 });
      fs.writeFileSync(path.join(secrets, "cosign.pub"), "-----BEGIN PUBLIC KEY-----\nc2ltdWxhdGVk\n-----END PUBLIC KEY-----\n");
      return { status: 0, stdout: "", stderr: "" };
    };
  } else {
    // Real cosign reads COSIGN_PASSWORD from the environment it is given.
    const previous = process.env.COSIGN_PASSWORD;
    process.env.COSIGN_PASSWORD = FIXTURE_PASSWORD;
    t.after(() => {
      if (previous === undefined) delete process.env.COSIGN_PASSWORD;
      else process.env.COSIGN_PASSWORD = previous;
    });
    runtime.spawn = async (command, args, options) => {
      assert.deepEqual([command, args, options.cosign], ["cosign", ["generate-key-pair", "--output-key-prefix", "cosign"], true]);
      const result = spawnSync(cosign, args, { cwd: options.cwd, encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    };
  }
  const created = await release.generateSigningKey(runtime);
  assert.deepEqual(created, { privateKey: signing.privateKey, publicKey: signing.publicKey });
  assert.equal(fs.statSync(signing.privateKey).mode & 0o777, 0o600);
  assert.equal(fs.statSync(secrets).mode & 0o777, 0o700);
  const publicKey = fs.readFileSync(signing.publicKey, "utf8");
  assert.match(publicKey, /^-----BEGIN PUBLIC KEY-----\n[\s\S]+-----END PUBLIC KEY-----\n$/u);
  const embedded = /RELEASE_SIGNING_PUBLIC_KEY="\$\(cat <<'RELEASE_SIGNING_PUBLIC_KEY_PEM'\n([\s\S]*?)RELEASE_SIGNING_PUBLIC_KEY_PEM\n\)"/u.exec(fs.readFileSync(signing.bootstrap, "utf8"));
  assert.equal(embedded?.[1], publicKey, "bootstrap embeds the new public key verbatim");
  assert.equal(spawnSync("bash", ["-n", signing.bootstrap]).status, 0, "the edited bootstrap still parses");
  const text = runtime.printed.join("\n");
  assert.doesNotMatch(text, /PRIVATE KEY|ENCRYPTED/u, "the private key is never printed");
  assert.match(text, /Private key: \S+cosign\.key \(mode 0600; back it up with the other secrets, never commit it\)/u);
  assert.match(text, /Next: run `bun platform\/setup\/generate\.mjs --write`[\s\S]*commit platform\/distribution\/release-signing\.pub, bootstrap, and center\/src\/lib\/pin-setup\/generated\/bootstrap\.ts/u);

  // A second run never replaces the key.
  await assert.rejects(release.generateSigningKey(fakeRuntime({ signing })), /cosign\.key already exists; a release signing key is made once/u);
  assert.equal(fs.readFileSync(signing.publicKey, "utf8"), publicKey);
});

test("failed pushes retry with bounded backoff, and a rerun resumes from the receipts", async () => {
  const flaky = fakeRuntime({ failures: { cosmos: 2 } });
  await release.publishRelease(options("1.0.4"), flaky);
  assert.deepEqual(flaky.sleeps, [release.RETRY_DELAY_MS, 2 * release.RETRY_DELAY_MS]);
  assert.equal(flaky.calls.filter((call) => kind(call) === "push cosmos").length, 3);
  assert.match(flaky.printed.join("\n"), /push cosmos failed \(attempt 1 of 5\): ERROR: failed to push: write tcp: broken pipe; retrying in 15s/u);

  const broken = fakeRuntime({ failures: { cosmos: Infinity } });
  await assert.rejects(release.publishRelease(options("1.0.5"), broken), /push cosmos failed after 5 attempts: ERROR: failed to push/u);
  assert.deepEqual(broken.sleeps, [1, 2, 3, 4].map((attempt) => attempt * release.RETRY_DELAY_MS));
  const paths = publication("1.0.5");
  assert.deepEqual(fs.readdirSync(paths.receipts).sort(), ["center-iroh-bridge.json", "center.json"]);
  assert.equal(broken.calls.some((call) => kind(call) === "compose publish" || kind(call) === "build.mjs"), false);

  const resumed = fakeRuntime();
  await release.publishRelease(options("1.0.5"), resumed);
  const steps = resumed.calls.filter((call) => call.command !== "git").map(kind);
  assert.deepEqual(steps.filter((step) => /^(?:build|push) /u.test(step)).sort(), [
    "build cosmos", "build keycloak", "build spotify-adapter", "push cosmos", "push keycloak", "push spotify-adapter",
  ]);
  assert.equal(steps.includes("download pin"), false, "the verified Pin archive is reused");
  assert.equal(steps.filter((step) => step === "compose publish").length, 1);
  assert.match(resumed.printed.join("\n"), /\(resuming\)/u);

  const finished = fakeRuntime();
  await release.publishRelease(options("1.0.5"), finished);
  assert.deepEqual(finished.calls.filter((call) => call.command !== "git").map(kind), ["compose version", "cosign verify-blob"],
    "a finished publication is only re-verified against the committed public key");
  assert.match(finished.printed.join("\n"), /already published oci:\/\//u);
  assert.match(finished.printed.join("\n"), /signature    SHA256SUMS\.sigstore\.json present/u);
});

test("an authorization failure stops at once with the login to fix", async () => {
  const runtime = fakeRuntime({ failures: { center: Infinity }, pushError: "ERROR: failed to push: 401 Unauthorized" });
  await assert.rejects(
    release.publishRelease(options("1.0.6"), runtime),
    /push center failed: ERROR: failed to push: 401 Unauthorized[\s\S]*\.\/luma registry login --username GITHUB_USER/u,
  );
  assert.deepEqual(runtime.sleeps, []);

  // An existing builder that cannot boot is reported, never recreated.
  const stuck = fakeRuntime({ builderError: "ERROR: failed to pull moby/buildkit: i/o timeout\n" });
  await assert.rejects(
    release.publishRelease(options("1.0.13"), stuck),
    /starting the luma-release buildx builder failed: ERROR: failed to pull moby\/buildkit: i\/o timeout/u,
  );
  assert.equal(stuck.calls.some((call) => kind(call) === "docker create" || kind(call).startsWith("build ")), false);
});

test("the login is verified to write packages before the plan, and a refused login stops at once", async () => {
  const missing = fakeRuntime({ credential: null });
  await assert.rejects(
    release.publishRelease(options("1.0.16", { confirm: false }), missing),
    /ghcr\.io has no login in Docker's configuration \(.*build\); run \.\/luma registry login --username GITHUB_USER with a token that can write packages/u,
  );
  assert.deepEqual(missing.calls.filter((call) => call.command !== "git").map(kind), ["compose version"],
    "the login is checked before any registry or build step");

  const readOnly = fakeRuntime({ token: ghcrToken(["pull"]) });
  await assert.rejects(
    release.publishRelease(options("1.0.16", { confirm: false }), readOnly),
    /the ghcr\.io login cannot write packages \(ghcr\.io granted it pull for theandersmadsen\/luma\)[\s\S]*registry login --username GITHUB_USER/u,
  );

  const rejected = fakeRuntime({ tokenStatus: 401 });
  await assert.rejects(
    release.publishRelease(options("1.0.16", { confirm: false }), rejected),
    /verifying the ghcr\.io login failed: ghcr\.io answered 401[\s\S]*registry login --username GITHUB_USER/u,
  );

  // An unverifiable login only warns. The pushes report their own failures.
  const unreachable = fakeRuntime({ tokenError: new Error("getaddrinfo gcr.io failed") });
  assert.equal(await release.publishRelease(options("1.0.16", { confirm: false }), unreachable), null);
  assert.match(unreachable.printed.join("\n"),
    /could not verify the ghcr\.io login \(getaddrinfo gcr\.io failed\); the first push stops at once when it cannot write/u);
});

test("a pushed annotated tag can publish once, including a draft created by the workflow", async () => {
  for (const [index, draft] of [null, { isDraft: true }].entries()) {
    const runtime = fakeRuntime({ githubState: { ref: { target: { oid: TAG_OBJECT } }, release: draft } });
    await release.publishRelease(options(`1.1.${index}`), runtime);
    assert.ok(runtime.calls.some((call) => kind(call) === "compose publish"));
    assert.equal(runtime.calls.some((call) => call.args.includes("ls-remote")), false,
      "the private repository is read with gh authentication, never an anonymous git request");
  }
});

test("changed tags, published releases and unknown GitHub state stop before any build or push", async () => {
  for (const confirm of [false, true]) {
    for (const [fixture, pattern] of [
      [{ githubState: { ref: { target: { oid: OTHER_REVISION } }, release: null } }, /GitHub tag v1\.0\.17 differs from the local annotated tag/u],
      [{ githubState: { ref: { target: { oid: REVISION } }, release: null } }, /differs from the local annotated tag/u],
      [{ githubState: { ref: { target: { oid: TAG_OBJECT } }, release: { isDraft: false } } }, /v1\.0\.17 is already published on GitHub/u],
      [{ githubError: "HTTP 401: Bad credentials" }, /checking GitHub release state failed/u],
      [{ githubError: "network timeout" }, /checking GitHub release state failed/u],
      [{ githubState: null }, /cannot verify GitHub release state/u],
      [{ githubState: {} }, /cannot verify GitHub release state/u],
      [{ githubState: { ref: {}, release: null } }, /cannot verify GitHub release state/u],
      [{ githubState: { ref: null, release: {} } }, /cannot verify GitHub release state/u],
      [{ githubResponse: "not json" }, /cannot verify GitHub release state/u],
      [{ githubResponse: JSON.stringify({ errors: [{ message: "unavailable" }], data: { repository: { ref: null, release: null } } }) }, /cannot verify GitHub release state/u],
    ]) {
      const runtime = fakeRuntime(fixture);
      await assert.rejects(release.publishRelease(options("1.0.17", { confirm }), runtime), pattern);
      assert.equal(runtime.calls.some((call) => /^(?:build|push|download) /u.test(kind(call))), false,
        "nothing is built, downloaded, or pushed");
    }
  }
});

test("image and application versions on ghcr.io are refused before anything is built", async () => {
  const pushed = fakeRuntime({ existingRefs: [`${PREFIX}/cosmos:v1.0.18`] });
  await assert.rejects(
    release.publishRelease(options("1.0.18", { confirm: true }), pushed),
    new RegExp(`${PREFIX.replaceAll(".", "\\.")}/cosmos:v1\\.0\\.18 already exist on ghcr\\.io[\\s\\S]*image tags are meant never to change`, "u"),
  );
  assert.equal(pushed.calls.some((call) => kind(call).startsWith("build ")), false, "no image is built");
  assert.equal(pushed.calls.some((call) => kind(call).startsWith("push ")), false, "no image is pushed");

  const application = fakeRuntime({ existingRefs: [`${PREFIX}/application:v1.0.19`] });
  await assert.rejects(
    release.publishRelease(options("1.0.19"), application),
    /application:v1\.0\.19 already exist on ghcr\.io/u,
  );
});

test("receipted pushes are this publication's own and are never refused as existing", async () => {
  const broken = fakeRuntime({ failures: { cosmos: Infinity } });
  await assert.rejects(release.publishRelease(options("1.0.20"), broken), /push cosmos failed after 5 attempts/u);
  assert.deepEqual(fs.readdirSync(publication("1.0.20").receipts).sort(), ["center-iroh-bridge.json", "center.json"]);

  // The receipted pushes exist on ghcr.io by now. The rerun resumes past them.
  const resumed = fakeRuntime({
    existingRefs: [`${PREFIX}/center:v1.0.20`, `${PREFIX}/center-iroh-bridge:v1.0.20`],
  });
  await release.publishRelease(options("1.0.20"), resumed);
  assert.match(resumed.printed.join("\n"), /\(resuming\)/u);
  assert.deepEqual(resumed.calls.filter((call) => kind(call).startsWith("probe ")).map(kind), [
    "probe cosmos", "probe keycloak", "probe spotify-adapter", "probe application",
  ], "receipted refs are not probed again");
});

test("a pinned Pin archive that its release does not carry fails before anything is built", async () => {
  const nothingBuilt = (runtime) => runtime.calls.every((call) => !/^(?:build|push|download|docker) /u.test(kind(call)));
  for (const [fixture, problem] of [
    [{ published: [] }, /TheAndersMadsen\/luma v\d\S* has no luma-pin-\S+ asset/u],
    [{ viewError: "release not found" }, /TheAndersMadsen\/luma has no GitHub release v\d/u],
    [{ published: [{ name: pinned.archive, size: pinned.size + 1 }] }, /asset of TheAndersMadsen\/luma v\S+ is not the pinned file/u],
    [{ published: [{ name: pinned.archive, size: pinned.size, digest: `sha256:${"e".repeat(64)}` }] }, /is not the pinned file/u],
  ]) {
    for (const confirm of [false, true]) {
      const runtime = fakeRuntime(fixture);
      await assert.rejects(release.publishRelease(options("1.0.10", { confirm }), runtime), (error) => {
        assert.match(error.message, /cannot republish the Pin release pinned in platform\/distribution\/pin-release-coordinates\.json/u);
        assert.match(error.message, problem);
        assert.match(error.message, /--pin-version YYYY-MM-DD\.N --pin-version-code INTEGER/u);
        return true;
      });
      assert.deepEqual(runtime.sleeps, []);
      assert.ok(nothingBuilt(runtime), runtime.calls.map(kind).join(", "));
    }
  }
  assert.equal(fs.existsSync(publication("1.0.10").root), false, "a refused plan leaves no publication directory");

  // An archive removed between the check and the download is still reported
  // with the fix, without retries.
  const vanished = fakeRuntime({ downloadError: "no assets match the file pattern" });
  await assert.rejects(
    release.publishRelease(options("1.0.14"), vanished),
    /download luma-pin-[^ ]+ failed: no assets match the file pattern[\s\S]*pin-release-coordinates\.json or build a new Pin release/u,
  );
  assert.deepEqual(vanished.sleeps, []);
  assert.equal(vanished.calls.some((call) => kind(call).startsWith("push ")), false, "nothing is pushed");

  // gh's own wording for a rejected token names only `gh auth login`.
  const badToken = fakeRuntime({
    viewError: "HTTP 401: Bad credentials (https://api.github.com/repos/o/r/releases/tags/v1)\n" +
      "Try authenticating with:  gh auth login -h github.com",
  });
  await assert.rejects(
    release.publishRelease(options("1.0.12"), badToken),
    /failed: HTTP 401: Bad credentials[\s\S]*gh auth status/u,
  );
  assert.deepEqual(badToken.sleeps, []);

  // Even a plan now asks gh, so a machine without it hears so at once instead
  // of after two and a half minutes of retries.
  const noGh = fakeRuntime({ viewError: "required local command is unavailable at a supported fixed path: gh" });
  await assert.rejects(
    release.publishRelease(options("1.0.15"), noGh),
    /unavailable at a supported fixed path: gh[\s\S]*install the command it names \(the GitHub CLI `gh`/u,
  );
  assert.deepEqual(noGh.sleeps, []);
});

test("a publication directory belongs to one revision and one Pin choice", async () => {
  await assert.rejects(
    release.publishRelease(options("1.0.5"), fakeRuntime({ head: OTHER_REVISION })),
    /holds a publication of another revision or Pin release/u,
  );
  await assert.rejects(
    release.publishRelease(options("1.0.5", { pinVersion: "2026-09-24.1", pinVersionCode: 202609241 }), fakeRuntime()),
    /holds a publication of another revision or Pin release/u,
  );
  fs.mkdirSync(publication("1.0.11").root, { recursive: true, mode: 0o700 });
  await assert.rejects(
    release.publishRelease(options("1.0.11"), fakeRuntime()),
    /v1\.0\.11 was not started by this command; move it aside/u,
  );
});

test("--pin-version builds and exports the signed Pin release through the existing pin commands", async () => {
  const built = {
    ...pinned,
    archive: "luma-pin-2026-09-24.1.tar.gz",
    version: "2026-09-24.1",
    versionCode: 202609241,
    sha256: "c".repeat(64),
  };
  const runtime = fakeRuntime({ describe: () => built });
  await release.publishRelease(options("1.0.7", { pinVersion: "2026-09-24.1", pinVersionCode: 202609241 }), runtime);
  const paths = publication("1.0.7");
  const pinCalls = runtime.calls.filter((call) => call.command === "bun" && path.basename(call.args[0]) === "luma");
  assert.deepEqual(pinCalls.map((call) => call.args), [
    [path.join(root, "luma"), "pin", "release", "build", "--version", "2026-09-24.1", "--version-code", "202609241"],
    [path.join(root, "luma"), "pin", "release", "export", "--output", path.join(paths.pin, built.archive)],
  ]);
  assert.equal(runtime.calls.some((call) => call.command === "gh" && call.args[0] === "release"), false);
  assert.equal(runtime.concurrency.maxLocal, 6, "the Pin build runs alongside the image builds");
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.nextPinCoordinates, "utf8")), {
    schemaVersion: 3,
    version: built.version,
    versionCode: built.versionCode,
    signedReleaseSource: {
      repository: "TheAndersMadsen/luma",
      tag: "v1.0.7",
      archive: built.archive,
      size: built.size,
      sha256: built.sha256,
      releaseId: built.releaseId,
      signerSha256: built.signerSha256,
      manifestSha256: built.manifestSha256,
      receiptsSha256: built.receiptsSha256,
    },
  });

  const mismatch = fakeRuntime({ describe: () => ({ ...built, archive: "luma-pin-2026-09-25.1.tar.gz", version: "2026-09-25.1" }) });
  await assert.rejects(
    release.publishRelease(options("1.0.8", { pinVersion: "2026-09-25.1", pinVersionCode: 202609251 }), mismatch),
    /does not match the requested Pin release 2026-09-25\.1 \(versionCode\)/u,
  );
  assert.deepEqual(fs.readdirSync(publication("1.0.8").pin), [], "a mismatched export is not kept");
  assert.equal(mismatch.calls.some((call) => kind(call).startsWith("push ")), false, "nothing is pushed");
});

test("a downloaded Pin archive that differs from its coordinates is refused and never kept", async () => {
  const runtime = fakeRuntime({ describe: () => ({ ...pinned, sha256: "d".repeat(64) }) });
  await assert.rejects(
    release.publishRelease(options("1.0.9"), runtime),
    /does not match the pinned Pin release coordinates \(sha256\)/u,
  );
  assert.deepEqual(fs.readdirSync(publication("1.0.9").pin), []);
  assert.equal(runtime.calls.some((call) => kind(call).startsWith("push ")), false);
});

test("the default runtime logs long steps, feeds stdin, and hands GH_TOKEN only to gh", async (t) => {
  const runtime = release.defaultRuntime();
  const log = path.join(dataDir, "runtime.log");
  const logged = await runtime.spawn("bun", ["-e", "console.log('to the log'); process.exit(3)"], { log });
  assert.equal(logged.status, 3);
  assert.equal(logged.stdout, "");
  assert.match(fs.readFileSync(log, "utf8"), /\n== \S+ bun -e [^\n]+\nto the log\n$/u);
  const piped = await runtime.spawn("bun", ["-e", "process.stdin.pipe(process.stdout)"], { input: "model" });
  assert.deepEqual([piped.status, piped.stdout], [0, "model"]);

  assert.equal(release.defaultRuntime().ghcrCredential(), null, "a configuration without a ghcr.io login reads as none");
  fs.mkdirSync(path.join(dataDir, "build"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "build", "config.json"), `${JSON.stringify({
    auths: { "ghcr.io": { auth: Buffer.from("user:secret").toString("base64") } },
  })}\n`);
  assert.equal(runtime.ghcrCredential(), "user:secret", "the login ./luma registry login wrote is read back");
  fs.rmSync(path.join(dataDir, "build", "config.json"));

  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "fixture-token";
  t.after(() => {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  });
  const probe = ["-e", "process.stdout.write(process.env.GH_TOKEN ?? 'absent')"];
  assert.equal((await runtime.spawn("bun", probe, { github: true })).stdout, "fixture-token");
  assert.equal((await runtime.spawn("bun", probe)).stdout, "absent");
});

test("the CLI registers release publish under the remote-mutation confirmation policy", () => {
  const contract = JSON.parse(fs.readFileSync(path.join(root, "contracts/operator-setup.json"), "utf8"));
  const command = contract.commands.find((entry) => entry.id === "release.publish");
  assert.deepEqual(command.tokens, ["release", "publish"]);
  assert.equal(command.effect, "remote-mutation");
  assert.equal(command.confirmationRequired, contract.mutationPolicies["remote-mutation"].confirmationRequired);
  assert.match(command.usage, /--confirm/u);

  const cli = path.join(root, "luma");
  const env = { ...process.env };
  const help = spawnSync(process.execPath, [cli, "release", "publish", "--help"], { cwd: root, env, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Without --confirm, checks the clean checkout and annotated vVERSION tag/u);
  const usage = spawnSync(process.execPath, [cli, "release", "publish", "--version", "latest"], { cwd: root, env, encoding: "utf8" });
  assert.equal(usage.status, 64);
  assert.match(usage.stderr, /usage: \.\/luma release publish --version X\.Y\.Z/u);

  // keygen is a local mutation of the secrets directory and the checkout.
  const keygen = contract.commands.find((entry) => entry.id === "release.keygen");
  assert.deepEqual(keygen.tokens, ["release", "keygen"]);
  assert.equal(keygen.effect, "local-mutation");
  assert.equal(keygen.confirmationRequired, false);
  assert.equal(keygen.usage, "luma release keygen");
  const keygenHelp = spawnSync(process.execPath, [cli, "release", "keygen", "--help"], { cwd: root, env, encoding: "utf8" });
  assert.equal(keygenHelp.status, 0, keygenHelp.stderr);
  assert.match(keygenHelp.stdout, /cosign generate-key-pair once into LUMA_SECRETS_DIR\/release\//u);
  assert.match(keygenHelp.stdout, /Never prints the private key/u);
  const keygenUsage = spawnSync(process.execPath, [cli, "release", "keygen", "--force"], { cwd: root, env, encoding: "utf8" });
  assert.equal(keygenUsage.status, 64);
  assert.match(keygenUsage.stderr, /release keygen takes no options/u);
  // No CI publication path remains beside the maintainer's machine.
  assert.equal(fs.existsSync(path.join(root, ".github/workflows/release-cli.yml")), false);
  assert.doesNotMatch(help.stdout, /LUMA_CI_RELEASE|tag workflow/u);

  // A refused Docker configuration directory is an error line, not a stack trace.
  const exposed = fs.mkdtempSync(path.join(dataDir, "exposed-"));
  fs.mkdirSync(path.join(exposed, "build"), { mode: 0o755 });
  fs.chmodSync(path.join(exposed, "build"), 0o755);
  const refused = spawnSync(process.execPath, [cli, "release", "publish", "--version", "1.2.3"], {
    cwd: root,
    env: { ...env, LUMA_DATA_DIR: exposed, LUMA_BUILD_DIR: path.join(exposed, "build") },
    encoding: "utf8",
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^error: operator directory must already have mode 0700: /u);
  assert.doesNotMatch(refused.stderr, /\n\s+at /u);
});

test("a failed step reports the line that failed, not an echoed command", () => {
  const { failureReason } = require("../../cli/release.js");
  const pinLog = [
    '#12 [android_sdk_native 6/6] RUN set -eux; curl --fail --location --silent --show-error "https://dl.google.com/ndk.zip"',
    "BUILD SUCCESSFUL in 16s",
    "install: setting permissions for '/state/release-output/server.apk': Operation not permitted",
    "pin-release-build: docker exited with status 1",
  ].join("\n");
  assert.equal(
    failureReason({ status: 1, stdout: pinLog, stderr: "" }),
    "install: setting permissions for '/state/release-output/server.apk': Operation not permitted",
  );
  assert.equal(
    failureReason({ status: 1, stdout: "step one\nERROR: failed to push: broken pipe\nnoise", stderr: "" }),
    "ERROR: failed to push: broken pipe",
  );
  assert.equal(failureReason({ status: 7, stdout: "", stderr: "" }), "exit status 7");
});

test("release notes from standard input travel into the operator archive and the GitHub release body", async () => {
  const notes = "Faster answers.\nPin apps unchanged.";
  const runtime = { ...fakeRuntime(), readStdin: () => `${notes}\r\n` };
  await release.publishRelease(options("1.0.30", { notes: "-" }), runtime);
  const paths = publication("1.0.30");
  const pack = runtime.calls.find((call) => call.command === "bun" && path.basename(call.args[0]) === "build.mjs");
  assert.equal(after_(pack.args, "--notes-file"), paths.notes);
  assert.equal(fs.readFileSync(paths.notes, "utf8"), notes, "plain text, trimmed, with Unix line breaks");
  assert.match(runtime.printed.join("\n"),
    new RegExp(`gh release create v1\\.0\\.30 --verify-tag --draft --title "Luma 1\\.0\\.30" --notes-file ${paths.notes.replaceAll(".", "\\.")} `, "u"));

  // Empty or oversized notes stop before anything is built.
  for (const [text, pattern] of [["  \n", /--notes names empty release notes/u], ["x".repeat(2001), /at most 2000 characters/u]]) {
    const refused = { ...fakeRuntime(), readStdin: () => text };
    await assert.rejects(release.publishRelease(options("1.0.31", { notes: "-" }), refused), pattern);
    assert.equal(refused.calls.some((call) => call.command === "docker" && call.args[1] === "build"), false);
  }
});
