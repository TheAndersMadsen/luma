import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createReproducibleTar } from "../../archive-tar.mjs";
import { createV2SignedApkFixture } from "./fixtures/signed-apk.mjs";
import { buildOperatorBundle, OPERATOR_SOURCES } from "../../distribution/build.mjs";
import { IMAGE_NAMES, IMAGE_PLATFORMS } from "../../distribution/release-descriptor.mjs";
import {
  canonicalPinReleaseManifestJson,
  createPinReleaseManifest,
  PIN_RELEASE_ARTIFACT_ROLES,
  PIN_RELEASE_PACKAGE_BY_ROLE,
} from "../pin/release.mjs";

const root = path.resolve(import.meta.dirname, "../../..");

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function integerConstant(relativePath, name) {
  const matches = [...source(relativePath).matchAll(
    new RegExp(
      `\\bconst(?:\\s+val)?\\s+${name}(?:\\s*:[^=;]+)?\\s*=\\s*([0-9][0-9_]*)\\s*;?`,
      "gu",
    ),
  )];
  assert.equal(matches.length, 1, `${relativePath} must declare exactly one ${name}`);
  return Number(matches[0][1].replaceAll("_", ""));
}

function rustDurationConstant(relativePath, name) {
  const matches = [...source(relativePath).matchAll(
    new RegExp(
      `\\bconst\\s+${name}\\s*:\\s*Duration\\s*=\\s*Duration::from_secs\\(([0-9][0-9_]*)\\)\\s*;`,
      "gu",
    ),
  )];
  assert.equal(matches.length, 1, `${relativePath} must declare exactly one ${name}`);
  return Number(matches[0][1].replaceAll("_", "")) * 1_000;
}

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-distribution-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const receipts = path.join(temporary, "receipts");
  const output = path.join(temporary, "output");
  fs.mkdirSync(receipts);
  fs.mkdirSync(output);
  IMAGE_NAMES.forEach((name, index) => {
    const imageDigest = digest(String(index + 1));
    fs.writeFileSync(path.join(receipts, `${name}.json`), `${JSON.stringify({
      schemaVersion: 2,
      name,
      reference: `ghcr.io/theandersmadsen/luma/${name}@${imageDigest}`,
      digest: imageDigest,
      platforms: IMAGE_PLATFORMS,
    })}\n`);
  });
  const applicationDigest = digest("a");
  fs.writeFileSync(path.join(receipts, "application.json"), `${JSON.stringify({
    schemaVersion: 1,
    reference: `oci://ghcr.io/theandersmadsen/luma/application@${applicationDigest}`,
    digest: applicationDigest,
  })}\n`);
  const pinVersion = "2026-08-31.2";
  const pinVersionCode = 202_608_312;
  const pinDirectoryName = `luma-pin-${pinVersion}`;
  const pinDirectory = path.join(temporary, pinDirectoryName);
  fs.mkdirSync(pinDirectory);
  const signed = createV2SignedApkFixture({ directory: path.join(temporary, "pin-signing") });
  const pinReceipts = {
    schemaVersion: 1,
    artifacts: PIN_RELEASE_ARTIFACT_ROLES.map((role) => {
      const bytes = signed.bytes;
      fs.writeFileSync(path.join(pinDirectory, `${role}.apk`), bytes);
      return {
        role,
        path: `${role}.apk`,
        name: `${role}.apk`,
        package: PIN_RELEASE_PACKAGE_BY_ROLE[role],
        versionName: pinVersion,
        versionCode: pinVersionCode,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        signerSha256: signed.signerSha256,
      };
    }),
  };
  const pinManifest = createPinReleaseManifest({ version: pinVersion, receipts: pinReceipts });
  fs.writeFileSync(path.join(pinDirectory, "manifest.json"), canonicalPinReleaseManifestJson(pinManifest));
  fs.writeFileSync(path.join(pinDirectory, "receipts.json"), `${JSON.stringify(pinReceipts)}\n`);
  const pinArchive = path.join(temporary, `${pinDirectoryName}.tar.gz`);
  const packed = spawnSync("/usr/bin/tar", ["-czf", pinArchive, "-C", temporary, pinDirectoryName], {
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr);
  return {
    temporary, receipts, output, applicationDigest, pinArchive, pinManifest,
    pinVersion, pinVersionCode, signerSha256: signed.signerSha256,
  };
}

// The bundle is packed only from a clean checkout of the named revision, so
// build tests pack a committed copy of the current operator sources.
function committedSource(t) {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "luma-operator-source-"));
  t.after(() => fs.rmSync(checkout, { recursive: true, force: true }));
  for (const source of OPERATOR_SOURCES) {
    fs.cpSync(path.join(root, source), path.join(checkout, source), { recursive: true });
  }
  const git = (...args) => {
    const result = spawnSync("git", [
      "-c", "user.name=Luma test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args,
    ], {
      cwd: checkout,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet");
  git("add", "--all");
  git("commit", "--quiet", "--message", "operator sources");
  return { checkout, revision: git("rev-parse", "HEAD") };
}

test("release archives are byte-reproducible with the supported host tar", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "luma-archive-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const archives = [];

  for (const [name, seconds] of [["first", 10], ["second", 20]]) {
    const parent = path.join(temporary, name);
    const directory = path.join(parent, "release");
    fs.mkdirSync(path.join(directory, "nested"), { recursive: true });
    fs.writeFileSync(path.join(directory, "nested", "artifact"), "same bytes\n");
    fs.utimesSync(path.join(directory, "nested", "artifact"), seconds, seconds);
    const archive = path.join(temporary, `${name}.tar.gz`);
    await createReproducibleTar({ parent, directory: "release", archive });
    archives.push(fs.readFileSync(archive));
  }

  assert.deepEqual(archives[0], archives[1]);
});

test("music playback deadlines preserve the cross-language nested budget", () => {
  const layers = [
    [
      "Pin provider request",
      rustDurationConstant("pin/runtime/core/src/api/music.rs", "REQUEST_TIMEOUT"),
    ],
    ["Iroh bridge", rustDurationConstant("pin/bridge/src/main.rs", "REQUEST_TIMEOUT")],
    [
      "adapter music egress",
      integerConstant("center/adapters/spotify/src/adapter.mjs", "MUSIC_EGRESS_TIMEOUT_MS"),
    ],
    [
      "Center playback resolution",
      integerConstant(
        "center/src/app/api/music-gateway/playback/route.ts",
        "MUSIC_PLAYBACK_RESOLUTION_TIMEOUT_MS",
      ),
    ],
    [
      "Pin music gateway playback",
      rustDurationConstant("pin/runtime/core/src/spotify/mod.rs", "MUSIC_GATEWAY_PLAYBACK_TIMEOUT"),
    ],
    [
      "Android playback read",
      integerConstant(
        "pin/runtime/android/src/main/kotlin/com/penumbraos/server/SpotifyBridgeService.kt",
        "PLAYBACK_READ_TIMEOUT_MS",
      ),
    ],
  ];
  const deadlines = layers.map(([, milliseconds]) => milliseconds);
  const minimumMargins = [5_000, 5_000, 5_000, 10_000, 10_000];

  assert.deepEqual(deadlines, [25_000, 30_000, 35_000, 40_000, 50_000, 60_000]);
  for (let index = 1; index < deadlines.length; index += 1) {
    const [innerName] = layers[index - 1];
    const [outerName] = layers[index];
    assert.ok(deadlines[index] > deadlines[index - 1], `${outerName} must exceed ${innerName}`);
    assert.ok(
      deadlines[index] - deadlines[index - 1] >= minimumMargins[index - 1],
      `${outerName} must retain at least ${minimumMargins[index - 1]}ms above ${innerName}`,
    );
  }
});

test("agentic deadlines preserve the signed Pin to Cosmos delivery margin", () => {
  const hookDeadline = integerConstant(
    "pin/hook/module/src/main/kotlin/com/penumbraos/hook/AgenticSessionDeadlineHooks.kt",
    "AGENTIC_SESSION_TIMEOUT_MS",
  );
  const cosmosRunBudget = rustDurationConstant(
    "cosmos/crates/cosmos/src/assistant/runtime.rs",
    "FOREGROUND_BUDGET",
  );
  const cosmosModelStep = rustDurationConstant(
    "cosmos/crates/cosmos/src/assistant/runtime.rs",
    "MODEL_STEP_LIMIT",
  );
  const envoy = source("platform/edge/envoy/envoy.yaml.tpl");
  const route = envoy.match(
    /match: \{ prefix: "\/humane\.aibus\." \}\s+route: \{ cluster: cosmos_ai_bus, timeout: ([0-9]+)s \}/u,
  );
  assert.ok(route, "Envoy must have one explicit Ai Bus route timeout");
  const edgeDeadline = Number(route[1]) * 1_000;

  assert.equal(cosmosModelStep, 20_000);
  assert.equal(cosmosRunBudget, 70_000);
  assert.equal(edgeDeadline, 85_000);
  assert.equal(hookDeadline, 90_000);
  assert.ok(cosmosModelStep < cosmosRunBudget);
  assert.ok(cosmosRunBudget < edgeDeadline);
  assert.ok(edgeDeadline < hookDeadline);
});

test("the operator trace waits through the complete signed Pin session", () => {
  const hookDeadline = integerConstant(
    "pin/hook/module/src/main/kotlin/com/penumbraos/hook/AgenticSessionDeadlineHooks.kt",
    "AGENTIC_SESSION_TIMEOUT_MS",
  );
  const http = source("cosmos/crates/cosmos/src/http/mod.rs");
  assert.match(
    http,
    /const DEMO_CHAT_TIMEOUT: Duration = crate::assistant::runtime::PIN_SESSION_LIMIT;/u,
  );

  const evaluator = source("platform/deploy/vps/assistant-eval.mjs");
  const traceTimeout = evaluator.match(
    /"--max-time",\s*"([0-9]+)",\s*"--header",\s*"content-type: application\/json"/u,
  );
  assert.ok(traceTimeout, "the operator evaluator must declare one trace timeout");
  assert.ok(
    Number(traceTimeout[1]) * 1_000 > hookDeadline,
    "the evaluator client must outlive the Pin session deadline",
  );
});

test("operator docs keep the general control timeout separate from playback", () => {
  const example = source("center/.env.example");
  assert.match(example, /^# General Spotify control-route timeout\./mu);
  assert.match(example, /^# LUMA_SPOTIFY_ADAPTER_TIMEOUT_MS=10000$/mu);

  const services = source("docs/services.md");
  assert.match(
    services,
    /`LUMA_SPOTIFY_ADAPTER_TIMEOUT_MS` remains the general control-route timeout\s+and defaults to 10 seconds\./u,
  );
  assert.match(
    services,
    /The YouTube Music Pin-egress playback path uses a\s+separate route-specific ladder: 25 seconds for the Pin provider request, 30 for\s+Iroh, 35 for adapter egress, 40 for Center resolution, 50 for the Pin music\s+gateway, and a 60-second Android read-idle timeout\./u,
  );
  assert.match(
    services,
    /The Android value limits how\s+long a response-body read may stay idle; it is not a strict total request\s+deadline\./u,
  );
});

test("the public README uses approachable device compatibility terminology", () => {
  const readme = source("README.md");

  assert.doesNotMatch(readme, /\bjailbreak\b/iu);
  assert.doesNotMatch(readme, /\bCVE-[0-9]{4}-[0-9]{4,}\b/iu);
  assert.doesNotMatch(readme, /\bkernel(?:-level)?\s+exploit\b/iu);
  assert.doesNotMatch(readme, /\bGhostLock\b/u);
  assert.doesNotMatch(readme, /Messages and Music received the deepest app inspection/u);

  const architecture = source("docs/architecture.md");
  assert.match(
    architecture,
    /current browser session, exact connected serial, and reviewed plan/u,
  );
  assert.match(
    architecture,
    /sanitized, non-identifying digest of the local device-backup\s+review/u,
  );
  assert.match(architecture, /encrypted\s+userdata was not used/u);
  assert.match(architecture, /auditable repository authority/u);
});

test("the packaged operator guide finishes the physical Pin setup journey", () => {
  const guide = source("platform/distribution/OPERATOR-README.txt");

  assert.match(guide, /Return to Guided setup after activation\./u);
  assert.match(guide, /factory-reset Pin\s+needs one re-entry of the same four-digit passcode over USB/u);
  assert.match(guide, /microphone, speaker, and gesture response/u);
});

test("the operator launcher requires its pinned Bun runtime", (t) => {
  const launcher = path.join(root, "platform", "distribution", "operator-luma");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "luma-bun-version-"));
  const preload = path.join(directory, "version.cjs");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const version of ["1.3.0", "1.4.3"]) {
    fs.writeFileSync(preload, `Object.defineProperty(process, "versions", { value: { ...process.versions, bun: ${JSON.stringify(version)} } });\n`);
    const result = spawnSync(process.execPath, ["-r", preload, launcher, "--help"], { encoding: "utf8" });
    assert.equal(result.status, 126, version);
    assert.match(result.stderr, /requires Bun 1\.4\.2/u);
  }
});

// The tag workflow and `./luma release publish` are covered by release-publish.test.mjs.
test("release inputs pin the signed Pin archive and harden every image build", () => {
  const pinCoordinates = JSON.parse(fs.readFileSync(
    path.join(root, "platform/distribution/pin-release-coordinates.json"),
    "utf8",
  ));
  // Exact coordinates of the signed Pin bundle, built for Luma 0.3.28 and
  // republished unchanged since; 0.3.30 is the release that now hosts it. Future
  // server releases must preserve this verified bundle.
  assert.deepEqual(pinCoordinates, {
    "schemaVersion": 3,
    "version": "2026-09-30.3",
    "versionCode": 202609303,
    "signedReleaseSource": {
      "repository": "TheAndersMadsen/luma",
      "tag": "v0.3.30",
      "archive": "luma-pin-2026-09-30.3.tar.gz",
      "size": 22815615,
      "sha256": "f4eed1446fd31502d70b052f881da6481111396bc4573dd5fa84c1c879141ae7",
      "releaseId": "c7dd62678984a838178f61dc8f1fbf0bf6d5baefaf40937d6717d3275fdc38dc",
      "signerSha256": "d8a64e1c3a1afdc340c4b86feaacb88e2d81d66972afbd58e743b7c5b8d1cbdb",
      "manifestSha256": "9d258cffca5a7595f36cfaf7c0193c4a3b5afcb9a61072175ba91189374d9a68",
      "receiptsSha256": "066e4743b5f4b887241555b8e08c127ff96cd7b09cf1fa7bf4dbe181e41da80d"
    }
  });

  const keycloakDockerfile = fs.readFileSync(
    path.join(root, "platform/containers/keycloak/Dockerfile"),
    "utf8",
  );
  assert.match(keycloakDockerfile, /COPY --chown=keycloak:keycloak .*themes\/luma \/opt\/keycloak\/themes\/luma/u);
  assert.equal(
    fs.readFileSync(
      path.join(root, "platform/containers/keycloak/themes/luma/login/theme.properties"),
      "utf8",
    ),
    "parent=keycloak\nstyles=css/login.css css/luma.css\n",
  );

  const production = fs.readFileSync(path.join(root, "platform/compose/production.yaml"), "utf8");
  assert.match(production, /traefik:v3\.6\.25@sha256:[0-9a-f]{64}/u);
  assert.doesNotMatch(production, /^\s+build:/mu);
  assert.match(fs.readFileSync(path.join(root, "platform/compose/development.yaml"), "utf8"), /^\s+build:/mu);

  for (const dockerfile of [
    "cosmos/Dockerfile",
    "platform/containers/center-iroh-bridge/Dockerfile",
  ]) {
    const rustImage = fs.readFileSync(path.join(root, dockerfile), "utf8");
    assert.match(
      rustImage,
      /^FROM --platform=\$BUILDPLATFORM rust:1\.91\.1-bookworm@sha256:[0-9a-f]{64} AS build$/mu,
      `${dockerfile} must compile Rust on the native build platform`,
    );
    assert.match(rustImage, /^ARG BUILDARCH$/mu, dockerfile);
    assert.match(rustImage, /^ARG TARGETARCH$/mu, dockerfile);
    assert.match(rustImage, /x86_64-unknown-linux-gnu/u, dockerfile);
    assert.match(rustImage, /aarch64-unknown-linux-gnu/u, dockerfile);
    assert.match(rustImage, /gcc-x86-64-linux-gnu/u, dockerfile);
    assert.match(rustImage, /gcc-aarch64-linux-gnu/u, dockerfile);
    const cacheMounts = [...rustImage.matchAll(/--mount=type=cache,([^ \\\n]+)/gu)];
    assert.ok(cacheMounts.length > 0, `${dockerfile} must use BuildKit caches`);
    for (const [, options] of cacheMounts) {
      assert.match(options, /id=[^,]*\$\{TARGETARCH\}/u, `${dockerfile} cache must be architecture-scoped`);
    }
  }
});

test("operator release is lean, versioned, and bound to exact OCI digests", async (t) => {
  const {
    temporary, receipts, output, applicationDigest, pinArchive, pinManifest, pinVersion, pinVersionCode,
    signerSha256,
  } = fixture(t);
  const version = "1.2.3";
  const { checkout, revision } = committedSource(t);
  // The publisher's plain-text notes and publication time travel with the
  // release, beside the committed default update source.
  const notes = "Faster answers.\nPin apps 2026-08-31.2.";
  const notesFile = path.join(temporary, "release-notes.txt");
  fs.writeFileSync(notesFile, notes);
  const publishedAt = "2026-09-29T12:00:00.000Z";
  const updateSource = JSON.parse(source("platform/distribution/update-source.json")).origin;
  await buildOperatorBundle({
    version,
    revision,
    repository: "TheAndersMadsen/luma",
    tag: `v${version}`,
    receipts,
    pinArchive,
    output,
    root: checkout,
    expectedPinSigner: signerSha256,
    notesFile,
    publishedAt,
  });

  const archiveName = `luma-operator-${version}-linux.tar.gz`;
  const archive = path.join(output, archiveName);
  const descriptorName = `luma-${version}.release.json`;
  const descriptor = JSON.parse(fs.readFileSync(path.join(output, descriptorName), "utf8"));
  assert.deepEqual(Object.keys(descriptor).sort(), [
    "application", "images", "notes", "operator", "pin", "platforms", "product", "publishedAt", "revision",
    "schemaVersion", "source", "updateSource", "version",
  ]);
  assert.equal(descriptor.schemaVersion, 3);
  assert.equal(descriptor.updateSource, updateSource);
  assert.match(updateSource, /^https:\/\/[^/]+$/u);
  assert.equal(descriptor.notes, notes);
  assert.equal(descriptor.publishedAt, publishedAt);
  assert.deepEqual(descriptor.platforms, IMAGE_PLATFORMS);
  assert.equal(descriptor.revision, revision);
  assert.equal(descriptor.application.digest, applicationDigest);
  assert.deepEqual(Object.keys(descriptor.images), IMAGE_NAMES);
  assert.equal(descriptor.operator.archive, archiveName);
  assert.equal(descriptor.operator.size, fs.statSync(archive).size);
  assert.equal(
    descriptor.operator.sha256,
    createHash("sha256").update(fs.readFileSync(archive)).digest("hex"),
  );
  assert.equal(descriptor.pin.archive, `luma-pin-${pinVersion}.tar.gz`);
  assert.equal(descriptor.pin.releaseId, pinManifest.releaseId);
  assert.equal(descriptor.pin.version, pinVersion);
  assert.equal(descriptor.pin.versionCode, pinVersionCode);
  assert.equal(descriptor.pin.signerSha256, signerSha256);
  assert.equal(descriptor.pin.size, fs.statSync(pinArchive).size);
  assert.equal(descriptor.pin.sha256, createHash("sha256").update(fs.readFileSync(pinArchive)).digest("hex"));

  const listed = spawnSync("/usr/bin/tar", ["-tzf", archive], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(`luma-operator-${version}/luma`, "u"));
  assert.match(listed.stdout, /platform\/deploy\/vps\/deploy\.sh/u);
  assert.match(listed.stdout, /platform\/deploy\/vps\/assistant-eval\.mjs/u);
  assert.match(listed.stdout, /platform\/deploy\/pin\/activate\.mjs/u);
  assert.match(listed.stdout, /platform\/deploy\/pin\/device-target-guard\.mjs/u);
  assert.match(listed.stdout, /platform\/deploy\/pin\/import-release\.mjs/u);
  assert.match(listed.stdout, /platform\/deploy\/pin\/acquire-release\.mjs/u);
  assert.match(listed.stdout, /platform\/distribution\/release-proof\.mjs/u);
  assert.doesNotMatch(listed.stdout, /center\/src|cosmos\/crates|pin\/runtime|compose\.yaml/u);
  assert.ok(fs.statSync(archive).size < 2 * 1024 * 1024, "operator bundle should remain under 2 MiB");

  const stamped = spawnSync("/usr/bin/tar", [
    "-xOf", archive, `luma-operator-${version}/platform/distribution/version.json`,
  ], { encoding: "utf8" });
  assert.equal(stamped.status, 0, stamped.stderr);
  assert.deepEqual(JSON.parse(stamped.stdout), {
    schemaVersion: 2,
    version,
    revision,
    application: `oci://ghcr.io/theandersmadsen/luma/application@${applicationDigest}`,
    source: { repository: "TheAndersMadsen/luma", tag: `v${version}` },
    pin: descriptor.pin,
    updateSource,
    notes,
    publishedAt,
  });

  const extracted = path.join(temporary, "extracted");
  fs.mkdirSync(extracted);
  const unpacked = spawnSync("/usr/bin/tar", ["-xzf", archive, "-C", extracted], { encoding: "utf8" });
  assert.equal(unpacked.status, 0, unpacked.stderr);
  const bundle = path.join(extracted, `luma-operator-${version}`);
  const operatorEnv = {
    ...process.env,
    LUMA_CONFIG_DIR: path.join(temporary, "config"),
    LUMA_SECRETS_DIR: path.join(temporary, "secrets"),
    LUMA_ENV_FILE: path.join(temporary, "secrets/runtime.env"),
    LUMA_DATA_DIR: path.join(temporary, "data"),
    LUMA_BUILD_DIR: path.join(temporary, "data/build"),
  };
  const operator = (...args) => spawnSync(process.execPath, [path.join(bundle, "luma"), ...args], {
    cwd: bundle, env: operatorEnv, encoding: "utf8", timeout: 30_000,
  });
  // Before setup, the operator names its own first step, never a command only
  // the source checkout has.
  const commandHelp = operator("deploy", "production", "--help");
  assert.equal(commandHelp.status, 0, commandHelp.stderr);
  assert.match(commandHelp.stdout, /^Usage: luma deploy production \(--dry-run \| --confirm\)/u);
  assert.match(commandHelp.stdout, /^Safety: remote mutation/mu);
  assert.match(operator("pin", "release", "build", "--help").stdout, /^Luma operator CLI/u);
  const checkoutOnly = operator("init");
  assert.equal(checkoutOnly.status, 64);
  assert.match(checkoutOnly.stderr, /\.\/luma --help lists this release's commands/u);
  const freshStatus = operator("setup", "status", "--json");
  assert.equal(JSON.parse(freshStatus.stdout).next, './luma setup production --domain HOST --acme-email EMAIL --operator-email EMAIL ... (README "Get Luma")');
  for (const args of [["config", "check"], ["doctor", "production"], ["deploy", "production", "--dry-run"]]) {
    const early = operator(...args);
    assert.equal(early.status, 1, args.join(" "));
    assert.match(`${early.stdout}${early.stderr}`, /\.\/luma setup production --domain HOST/u, args.join(" "));
    assert.doesNotMatch(`${early.stdout}${early.stderr}`, /\.\/luma init|\.\/luma doctor\b(?! production)/u, args.join(" "));
  }
  assert.equal(fs.existsSync(operatorEnv.LUMA_CONFIG_DIR), false, "nothing before setup creates configuration");
  const invalidPinSetup = spawnSync(process.execPath, [
    path.join(bundle, "luma"),
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
    "--profile", "pin",
  ], { cwd: bundle, env: operatorEnv, encoding: "utf8", timeout: 30_000 });
  assert.equal(invalidPinSetup.status, 1);
  assert.match(invalidPinSetup.stderr, /pin profile requires --public-ip/u);
  assert.equal(fs.existsSync(operatorEnv.LUMA_CONFIG_DIR), false);
  assert.equal(fs.existsSync(operatorEnv.LUMA_DATA_DIR), false);

  const invalidArchiveSetup = spawnSync(process.execPath, [
    path.join(bundle, "luma"),
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
    "--profile", "pin",
    "--public-ip", "203.0.113.42",
    "--pin-release-archive", path.join(temporary, "missing-pin-release.tar.gz"),
  ], { cwd: bundle, env: operatorEnv, encoding: "utf8", timeout: 30_000 });
  assert.equal(invalidArchiveSetup.status, 1);
  assert.match(invalidArchiveSetup.stderr, /Pin release archive does not exist/u);
  assert.equal(fs.existsSync(operatorEnv.LUMA_CONFIG_DIR), false);
  assert.equal(fs.existsSync(operatorEnv.LUMA_DATA_DIR), false);

  const setup = spawnSync(process.execPath, [
    path.join(bundle, "luma"),
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
    "--profile", "pin",
    "--public-ip", "203.0.113.42",
    "--pin-release-archive", pinArchive,
  ], { cwd: bundle, env: operatorEnv, encoding: "utf8", timeout: 30_000 });
  assert.equal(setup.status, 0, setup.stderr);
  for (const directory of [
    operatorEnv.LUMA_CONFIG_DIR,
    operatorEnv.LUMA_SECRETS_DIR,
    operatorEnv.LUMA_DATA_DIR,
  ]) {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(directory, ".luma-managed")).mode & 0o777, 0o600);
  }
  assert.equal(fs.existsSync(path.join(operatorEnv.LUMA_DATA_DIR, "pin-releases", "current.json")), false);
  assert.equal(
    fs.existsSync(path.join(
      operatorEnv.LUMA_DATA_DIR,
      "pin-release-staging", "releases", descriptor.pin.releaseId, descriptor.pin.archive,
    )),
    true,
  );

  const bundledVersion = spawnSync(process.execPath, [path.join(bundle, "luma"), "version", "--json"], {
    cwd: bundle,
    env: operatorEnv,
    encoding: "utf8",
  });
  assert.equal(bundledVersion.status, 0, bundledVersion.stderr);
  const bundledIdentity = JSON.parse(bundledVersion.stdout);
  assert.equal(bundledIdentity.pin.releaseId, descriptor.pin.releaseId);
  assert.deepEqual(bundledIdentity.source, descriptor.source);

  const bundledHelp = spawnSync(process.execPath, [path.join(bundle, "luma"), "--help"], {
    cwd: bundle,
    env: operatorEnv,
    encoding: "utf8",
  });
  assert.equal(bundledHelp.status, 0, bundledHelp.stderr);
  assert.match(bundledHelp.stdout, /\.\/luma setup production --guided/u);

  const setupStatus = spawnSync(process.execPath, [path.join(bundle, "luma"), "setup", "status", "--json"], {
    cwd: bundle,
    env: operatorEnv,
    encoding: "utf8",
  });
  assert.equal(setupStatus.status, 0, setupStatus.stderr);
  const setupReport = JSON.parse(setupStatus.stdout);
  assert.equal(setupReport.schemaVersion, 4);
  assert.deepEqual(setupReport.contract, { id: "operator-setup", version: "2.4.0", journey: "production" });
  assert.equal(setupReport.state, "production-ready");
  assert.equal(setupReport.release.pin.enabled, true);
  assert.equal(setupReport.release.pin.observed.releaseId, descriptor.pin.releaseId);
  assert.equal(setupReport.release.pin.compatible, true);
  assert.equal(setupReport.release.pin.expected.releaseId, descriptor.pin.releaseId);
  assert.equal(setupReport.release.pin.expected.manifestSha256, descriptor.pin.manifestSha256);

  const acquiredRelease = spawnSync(process.execPath, [
    path.join(bundle, "luma"), "pin", "release", "acquire", "--check", "--json",
  ], { cwd: bundle, env: operatorEnv, encoding: "utf8" });
  assert.equal(acquiredRelease.status, 0, acquiredRelease.stderr);
  assert.equal(JSON.parse(acquiredRelease.stdout).releaseId, descriptor.pin.releaseId);

  const activateUsage = spawnSync(process.execPath, [
    path.join(bundle, "luma"), "pin", "activate",
  ], { cwd: bundle, env: operatorEnv, encoding: "utf8" });
  assert.notEqual(activateUsage.status, 0);
  assert.match(activateUsage.stderr, /--serial is required|usage/u);
  assert.doesNotMatch(activateUsage.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/u);
  const runtime = fs.readFileSync(operatorEnv.LUMA_ENV_FILE, "utf8");
  assert.match(runtime, new RegExp(`^LUMA_RELEASE_ID=${revision}\nLUMA_RELEASE_VERSION=1\\.2\\.3$`, "mu"));
  assert.match(runtime, new RegExp(`^LUMA_COMPOSE_APPLICATION=oci://ghcr\\.io/.+@${applicationDigest}$`, "mu"));
  // Setup records the release's whole identity for Center, the release's own
  // update source, and automatic updates on for a new server.
  for (const line of [
    "LUMA_RELEASE_TAG=v1.2.3",
    `LUMA_PIN_RELEASE_VERSION=${pinVersion}`,
    `LUMA_PIN_RELEASE_VERSION_CODE=${pinVersionCode}`,
    `LUMA_RELEASE_PUBLISHED_AT=${publishedAt}`,
    `LUMA_UPDATE_SOURCE=${updateSource}`,
    "LUMA_AUTO_UPDATES=on",
  ]) assert.match(runtime, new RegExp(`^${line.replaceAll(".", "\\.")}$`, "mu"), line);
  assert.doesNotMatch(runtime, /LUMA_RELEASE_NOTES/u, "free-text notes never become a runtime.env line");
  // operators/current names this folder. A folder unpacked outside
  // LUMA_DATA_DIR/operators gets its timers from its first update.
  assert.equal(fs.realpathSync(path.join(operatorEnv.LUMA_DATA_DIR, "operators", "current")), fs.realpathSync(bundle));
  assert.match(setup.stdout, /Updates: this server asks https:\/\/[^ ]+ for newer releases\./u);
  assert.match(setup.stdout, /the timers start once this server runs a release in .+\/operators/u);
  // Center reads the update status through a read-only mount of a
  // world-readable directory, and writes its update request into a
  // world-writable sibling the update service consumes.
  const updates = path.join(operatorEnv.LUMA_DATA_DIR, "updates");
  assert.equal(fs.statSync(updates).mode & 0o777, 0o755);
  const requests = path.join(updates, "requests");
  assert.equal(fs.statSync(requests).mode & 0o777, 0o777);
  const overlay = fs.readFileSync(path.join(operatorEnv.LUMA_CONFIG_DIR, "production", "operator.compose.yaml"), "utf8");
  assert.match(overlay, /LUMA_UPDATE_STATUS_FILE: \/luma-updates\/status\.json/u);
  assert.ok(overlay.includes(`source: ${JSON.stringify(updates)}\n        target: /luma-updates\n        read_only: true`), overlay);
  assert.match(overlay, /LUMA_UPDATE_REQUESTS_DIR: \/luma-update-requests/u);
  assert.ok(overlay.includes(`source: ${JSON.stringify(requests)}\n        target: /luma-update-requests\n        bind: { create_host_path: false }`), overlay);

  const production = path.join(operatorEnv.LUMA_CONFIG_DIR, "production");
  const preservedRealm = fs.readFileSync(path.join(production, "realm.json"), "utf8");
  const preservedSessionSecret = /^AUTH_SESSION_SECRET=(.+)$/mu.exec(runtime)?.[1];
  const releasedVersion = fs.readFileSync(path.join(bundle, "platform/distribution/version.json"), "utf8");
  const nextRevision = "c".repeat(40);
  const nextApplicationDigest = digest("d");
  fs.writeFileSync(
    path.join(bundle, "platform/distribution/version.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      version: "1.2.4",
      revision: nextRevision,
      application: `oci://ghcr.io/theandersmadsen/luma/application@${nextApplicationDigest}`,
      source: { repository: "TheAndersMadsen/luma", tag: "v1.2.4" },
      pin: descriptor.pin,
    })}\n`,
  );
  const staleStatus = spawnSync(process.execPath, [path.join(bundle, "luma"), "setup", "status", "--json"], {
    cwd: bundle,
    env: operatorEnv,
    encoding: "utf8",
  });
  assert.equal(staleStatus.status, 1);
  const staleReport = JSON.parse(staleStatus.stdout);
  assert.equal(staleReport.state, "production-invalid");
  assert.equal(staleReport.next,
    "./luma setup production --pin-release-archive ../luma-pin-*.tar.gz (from the newest luma-operator folder)");
  assert.match(staleReport.problem, new RegExp("this is the Luma 1\\.2\\.4 operator, but this server is configured for " +
    `Luma 1\\.2\\.3 \\(release ${revision.slice(0, 12)}…, folder luma-operator-1\\.2\\.3\\); run \\./luma from ` +
    "that release's folder, or move this server to Luma 1\\.2\\.4 from this folder with \\./luma backup production, " +
    "then \\./luma setup production --pin-release-archive \\.\\./luma-pin-\\*\\.tar\\.gz", "u"));
  assert.doesNotMatch(staleReport.problem, /LUMA_COMPOSE_APPLICATION/u);

  const upgrade = spawnSync(process.execPath, [path.join(bundle, "luma"), "setup", "production"], {
    cwd: bundle,
    env: operatorEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(upgrade.status, 0, upgrade.stderr);
  const upgradedRuntime = fs.readFileSync(operatorEnv.LUMA_ENV_FILE, "utf8");
  assert.match(upgradedRuntime, new RegExp(`^LUMA_RELEASE_ID=${nextRevision}\nLUMA_RELEASE_VERSION=1\\.2\\.4$`, "mu"));
  assert.match(upgradedRuntime, new RegExp(`^LUMA_COMPOSE_APPLICATION=oci://ghcr\\.io/.+@${nextApplicationDigest}$`, "mu"));
  assert.equal(/^AUTH_SESSION_SECRET=(.+)$/mu.exec(upgradedRuntime)?.[1], preservedSessionSecret);
  assert.equal(fs.readFileSync(path.join(production, "realm.json"), "utf8"), preservedRealm);

  // The older release's folder cannot take the configuration back: its next
  // deploy would run older code against the newer release's data.
  fs.writeFileSync(path.join(bundle, "platform/distribution/version.json"), releasedVersion);
  const downgrade = operator("setup", "production");
  assert.equal(downgrade.status, 1);
  assert.match(downgrade.stderr, new RegExp("this is the Luma 1\\.2\\.3 operator, but this server is configured for " +
    `Luma 1\\.2\\.4 \\(release ${nextRevision.slice(0, 12)}…, folder luma-operator-1\\.2\\.4\\)\\. Run \\./luma from ` +
    "that folder \\(README \"Run your server\"\\); nothing was changed\\. To return this server to Luma 1\\.2\\.3, " +
    "restore the backup taken before the update", "u"));
  assert.equal(fs.readFileSync(operatorEnv.LUMA_ENV_FILE, "utf8"), upgradedRuntime);
  // Guided setup and onboarding refuse before asking a single question.
  for (const args of [["setup", "production", "--guided"], ["onboard", "production"]]) {
    const guided = operator(...args);
    assert.equal(guided.status, 1, args.join(" "));
    assert.match(guided.stderr, /this is the Luma 1\.2\.3 operator, but this server is configured for Luma 1\.2\.4/u);
    assert.doesNotMatch(guided.stderr, /interactive terminal/u, args.join(" "));
  }
  const olderDoctor = operator("doctor", "production");
  assert.equal(olderDoctor.status, 1);
  assert.match(olderDoctor.stderr, /this is the Luma 1\.2\.3 operator, but this server is configured for Luma 1\.2\.4 .*; run \.\/luma from that folder/u);

  const checksums = fs.readFileSync(path.join(output, "SHA256SUMS"), "utf8");
  assert.match(checksums, new RegExp(`  ${archiveName}$`, "mu"));
  assert.match(checksums, new RegExp(`  ${descriptorName}$`, "mu"));
  assert.match(checksums, new RegExp(`  ${descriptor.pin.archive}$`, "mu"));
});

test("release input validation rejects a mutable image reference", async (t) => {
  const { receipts, output, pinArchive, signerSha256 } = fixture(t);
  const center = JSON.parse(fs.readFileSync(path.join(receipts, "center.json"), "utf8"));
  center.reference = "ghcr.io/theandersmadsen/luma/center:v1.2.3";
  fs.writeFileSync(path.join(receipts, "center.json"), `${JSON.stringify(center)}\n`);
  const { checkout, revision } = committedSource(t);
  await assert.rejects(
    buildOperatorBundle({
      version: "1.2.3",
      revision,
      repository: "theandersmadsen/Ai-Pin-Luma",
      tag: "v1.2.3",
      receipts,
      pinArchive,
      output,
      root: checkout,
      expectedPinSigner: signerSha256,
    }),
    /digest-pinned GHCR reference/u,
  );
});

test("the operator bundle is packed only from a clean checkout of the named revision", async (t) => {
  const { receipts, output, pinArchive, signerSha256 } = fixture(t);
  const { checkout, revision } = committedSource(t);
  const pack = (options) => buildOperatorBundle({
    version: "1.2.3",
    revision,
    repository: "TheAndersMadsen/luma",
    tag: "v1.2.3",
    receipts,
    pinArchive,
    output,
    root: checkout,
    expectedPinSigner: signerSha256,
    ...options,
  });

  await assert.rejects(pack({ revision: "b".repeat(40) }), new RegExp(
    `--revision ${"b".repeat(40)} is not the checked-out HEAD ${revision}`, "u",
  ));
  await assert.rejects(pack({ revision: revision.slice(0, 12) }), /is not the checked-out HEAD/u);

  const cli = path.join(checkout, "platform/cli/production.js");
  fs.appendFileSync(cli, "// uncommitted\n");
  await assert.rejects(pack(), /refusing to pack a working tree with 1 changed or untracked paths/u);
  spawnSync("git", ["checkout", "--quiet", "--", "platform/cli/production.js"], { cwd: checkout });

  fs.writeFileSync(path.join(checkout, "platform/deploy/vps/stray.sh"), "untracked\n");
  await assert.rejects(pack(), /refusing to pack a working tree with 1 changed or untracked paths/u);
  fs.rmSync(path.join(checkout, "platform/deploy/vps/stray.sh"));

  // git status hides ignored files, but the grafana directory is copied whole.
  // A dot entry is never copied, so an ignored one does not block a pack.
  fs.appendFileSync(path.join(checkout, ".git/info/exclude"), "*.key\n.DS_Store\n");
  const grafana = path.join(checkout, "platform/containers/observability/grafana");
  const leaked = path.join(grafana, "dashboards/owner.key");
  fs.writeFileSync(leaked, "ignored secret\n");
  fs.writeFileSync(path.join(grafana, ".DS_Store"), "finder\n");
  await assert.rejects(
    pack(),
    /refusing to pack 1 git-ignored paths the operator bundle would copy: platform\/containers\/observability\/grafana\/dashboards\/owner\.key;/u,
  );
  fs.rmSync(leaked);

  const unversioned = fs.mkdtempSync(path.join(os.tmpdir(), "luma-unversioned-"));
  t.after(() => fs.rmSync(unversioned, { recursive: true, force: true }));
  await assert.rejects(pack({ root: unversioned }), /must be a git checkout with a commit/u);
  assert.deepEqual(fs.readdirSync(output), [], "a refused pack writes no release output");

  await pack();
  const archive = path.join(output, "luma-operator-1.2.3-linux.tar.gz");
  assert.ok(fs.existsSync(archive));
  const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.doesNotMatch(listing.stdout, /\.DS_Store|owner\.key/u, "only committed files are packed");
});

test("release publication model contains only digest images and portable storage", (t) => {
  const available = spawnSync("docker", ["compose", "version", "--short"], { encoding: "utf8" });
  if (available.error?.code === "ENOENT" || available.status !== 0) {
    t.skip("Docker Compose is unavailable");
    return;
  }
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(available.stdout.trim());
  if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 34)) {
    t.skip("Docker Compose 2.34 or newer is unavailable");
    return;
  }
  const { temporary, receipts } = fixture(t);
  const publicationEnv = path.join(temporary, "publication.env");
  const environment = spawnSync(process.execPath, [
    path.join(root, "platform/distribution/publication-environment.mjs"),
    receipts,
    publicationEnv,
    "b".repeat(40),
  ], { cwd: root, encoding: "utf8" });
  assert.equal(environment.status, 0, environment.stderr);
  assert.equal(fs.statSync(publicationEnv).mode & 0o777, 0o600);
  const compose = spawnSync("docker", [
    "compose",
    "--env-file", publicationEnv,
    "-f", path.join(root, "compose.yaml"),
    "-f", path.join(root, "platform/compose/production.yaml"),
    "--profile", "*",
    "config", "--format", "json",
  ], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  assert.equal(compose.status, 0, compose.stderr);
  const model = JSON.parse(compose.stdout);
  assert.deepEqual(model.services.edge.entrypoint, ["envoy"]);
  assert.equal(model.services.edge.user, "101:101");
  assert.ok(model.services["center-iroh-bridge"], "profiled bridge must be in the audited model");
  assert.equal(
    model.services["center-iroh-bridge"].image,
    `ghcr.io/theandersmadsen/luma/center-iroh-bridge@${digest("2")}`,
  );
  assert.deepEqual(
    Object.keys(model.services["center-iroh-bridge"].networks).sort(),
    ["pin-control", "provider-egress"],
  );
  assert.equal(model.networks["pin-control"].internal, true);
  assert.equal(
    model.services["spotify-adapter"].environment.LUMA_SPOTIFY_ADAPTER_UPSTREAM_ORIGIN,
    "http://center-iroh-bridge:18080",
  );
  assert.equal(
    model.services.center.environment.LUMA_SPOTIFY_ADAPTER_TIMEOUT_MS,
    "10000",
  );
  assert.equal(
    model.services["spotify-adapter"].environment.LUMA_SPOTIFY_ADAPTER_TIMEOUT_MS,
    "10000",
  );
  assert.equal(
    model.services["spotify-adapter"].depends_on["center-iroh-bridge"].condition,
    "service_healthy",
  );
  assert.equal(model.services["center-iroh-bridge"].extra_hosts, undefined);
  const audit = spawnSync(process.execPath, [
    path.join(root, "platform/distribution/audit-compose-publication.mjs"),
  ], { cwd: root, input: compose.stdout, encoding: "utf8" });
  assert.equal(audit.status, 0, audit.stderr);
  assert.match(audit.stdout, /publishable services/u);

  // Exercise Compose's OCI encoder too: `config` accepts some shapes that
  // `publish` cannot encode. Dry-run keeps this independent of a registry.
  const publish = spawnSync("docker", [
    "compose",
    "--env-file", publicationEnv,
    "-f", path.join(root, "compose.yaml"),
    "-f", path.join(root, "platform/compose/production.yaml"),
    "--profile", "*",
    "publish", "--dry-run", "--yes",
    "ghcr.io/example/luma/application:dryrun",
  ], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  assert.equal(publish.status, 0, publish.stderr);
});
