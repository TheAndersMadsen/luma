import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createReproducibleTar } from "../../archive-tar.mjs";
import { IMAGE_NAMES, IMAGE_PLATFORMS } from "../../distribution/release-descriptor.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const workflow = path.join(root, ".github/workflows/release-cli.yml");
const builder = path.join(root, "platform/distribution/build.mjs");

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
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-distribution-"));
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
      reference: `ghcr.io/theandersmadsen/ai-pin-revival/${name}@${imageDigest}`,
      digest: imageDigest,
      platforms: IMAGE_PLATFORMS,
    })}\n`);
  });
  const applicationDigest = digest("a");
  fs.writeFileSync(path.join(receipts, "application.json"), `${JSON.stringify({
    schemaVersion: 1,
    reference: `oci://ghcr.io/theandersmadsen/ai-pin-revival/application@${applicationDigest}`,
    digest: applicationDigest,
  })}\n`);
  return { temporary, receipts, output, applicationDigest };
}

test("release archives are byte-reproducible with the supported host tar", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-archive-"));
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

test("operator docs keep the general control timeout separate from playback", () => {
  const example = source("center/.env.example");
  assert.match(example, /^# General Spotify control-route timeout\./mu);
  assert.match(example, /^# REVIVAL_SPOTIFY_ADAPTER_TIMEOUT_MS=10000$/mu);

  const readme = source("README.md");
  assert.match(
    readme,
    /`REVIVAL_SPOTIFY_ADAPTER_TIMEOUT_MS` remains the general control-route timeout\s+and defaults to 10 seconds\./u,
  );
  assert.match(
    readme,
    /The YouTube Music Pin-egress playback path uses a\s+separate route-specific ladder: 25 seconds for the Pin provider request, 30 for\s+Iroh, 35 for adapter egress, 40 for Center resolution, 50 for the Pin music\s+gateway, and a 60-second Android read-idle timeout\./u,
  );
  assert.match(
    readme,
    /The Android value limits how\s+long a response-body read may stay idle; it is not a strict total request\s+deadline\./u,
  );
});

test("tag release workflow publishes the exact hardened image and Compose boundaries", () => {
  const source = fs.readFileSync(workflow, "utf8");
  assert.match(source, /push:\n\s+tags:\n\s+- "v\*"/u);
  assert.doesNotMatch(source, /workflow_dispatch/u);
  for (const name of IMAGE_NAMES) assert.match(source, new RegExp(`name: ${name}`, "u"));
  for (const match of source.matchAll(/^\s*uses:\s+[^@\s]+@([^\s#]+)/gmu)) {
    assert.match(match[1], /^[0-9a-f]{40}$/u, match[0]);
  }
  assert.match(source, /platforms: linux\/amd64,linux\/arm64/u);
  assert.match(source, /docker\/setup-qemu-action@[0-9a-f]{40}/u);
  assert.match(source, /provenance: mode=max/u);
  assert.match(source, /sbom: true/u);
  assert.match(source, /cache-from: type=gha,scope=release-\$\{\{ matrix\.name \}\}/u);
  assert.match(source, /cache-to: type=gha,scope=release-\$\{\{ matrix\.name \}\},mode=max/u);
  assert.match(source, /--profile '\*'\s+\\\n\s+publish --yes --resolve-image-digests/u);
  assert.doesNotMatch(source, /--with-env/u);
  const buildArgs = source.match(/^\s*build-args:.*$/gmu) || [];
  assert.equal(buildArgs.length, 1);
  assert.doesNotMatch(buildArgs[0], /(?:SECRET|TOKEN|PASSWORD|PRIVATE|KEY)=/u);
  assert.match(source, /REVIVAL_RELEASE_ID=/u);
  assert.match(source, /platform\/containers\/keycloak\/Dockerfile/u);
  assert.match(source, /platform\/containers\/center-iroh-bridge\/Dockerfile/u);

  const keycloakDockerfile = fs.readFileSync(
    path.join(root, "platform/containers/keycloak/Dockerfile"),
    "utf8",
  );
  assert.match(keycloakDockerfile, /COPY --chown=keycloak:keycloak .*themes\/revival \/opt\/keycloak\/themes\/revival/u);
  assert.equal(
    fs.readFileSync(
      path.join(root, "platform/containers/keycloak/themes/revival/login/theme.properties"),
      "utf8",
    ),
    "parent=keycloak\nstyles=css/login.css css/revival.css\n",
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

test("operator release is lean, versioned, and bound to exact OCI digests", (t) => {
  const { temporary, receipts, output, applicationDigest } = fixture(t);
  const version = "1.2.3";
  const revision = "b".repeat(40);
  const result = spawnSync(process.execPath, [
    builder,
    "--version", version,
    "--revision", revision,
    "--repository", "theandersmadsen/Ai-Pin-Revival",
    "--tag", `v${version}`,
    "--receipts", receipts,
    "--output", output,
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const archiveName = `ai-pin-revival-operator-${version}-linux.tar.gz`;
  const archive = path.join(output, archiveName);
  const descriptorName = `ai-pin-revival-${version}.release.json`;
  const descriptor = JSON.parse(fs.readFileSync(path.join(output, descriptorName), "utf8"));
  assert.deepEqual(Object.keys(descriptor).sort(), [
    "application", "images", "operator", "platforms", "product", "revision", "schemaVersion", "source", "version",
  ]);
  assert.equal(descriptor.schemaVersion, 2);
  assert.deepEqual(descriptor.platforms, IMAGE_PLATFORMS);
  assert.equal(descriptor.revision, revision);
  assert.equal(descriptor.application.digest, applicationDigest);
  assert.deepEqual(Object.keys(descriptor.images), IMAGE_NAMES);
  assert.equal(descriptor.operator.archive, archiveName);
  assert.equal(
    descriptor.operator.sha256,
    createHash("sha256").update(fs.readFileSync(archive)).digest("hex"),
  );

  const listed = spawnSync("/usr/bin/tar", ["-tzf", archive], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(`ai-pin-revival-operator-${version}/revival`, "u"));
  assert.match(listed.stdout, /platform\/deploy\/vps\/deploy\.sh/u);
  assert.match(listed.stdout, /platform\/deploy\/pin\/activate\.mjs/u);
  assert.match(listed.stdout, /platform\/deploy\/pin\/device-target-guard\.mjs/u);
  assert.match(listed.stdout, /platform\/deploy\/pin\/import-release\.mjs/u);
  assert.doesNotMatch(listed.stdout, /center\/src|cosmos\/crates|pin\/runtime|compose\.yaml/u);
  assert.ok(fs.statSync(archive).size < 2 * 1024 * 1024, "operator bundle should remain under 2 MiB");

  const stamped = spawnSync("/usr/bin/tar", [
    "-xOf", archive, `ai-pin-revival-operator-${version}/platform/distribution/version.json`,
  ], { encoding: "utf8" });
  assert.equal(stamped.status, 0, stamped.stderr);
  assert.deepEqual(JSON.parse(stamped.stdout), {
    schemaVersion: 1,
    version,
    revision,
    application: `oci://ghcr.io/theandersmadsen/ai-pin-revival/application@${applicationDigest}`,
  });

  const extracted = path.join(temporary, "extracted");
  fs.mkdirSync(extracted);
  const unpacked = spawnSync("/usr/bin/tar", ["-xzf", archive, "-C", extracted], { encoding: "utf8" });
  assert.equal(unpacked.status, 0, unpacked.stderr);
  const bundle = path.join(extracted, `ai-pin-revival-operator-${version}`);
  const operatorEnv = {
    ...process.env,
    REVIVAL_CONFIG_DIR: path.join(temporary, "config"),
    REVIVAL_SECRETS_DIR: path.join(temporary, "secrets"),
    REVIVAL_ENV_FILE: path.join(temporary, "secrets/runtime.env"),
    REVIVAL_DATA_DIR: path.join(temporary, "data"),
    REVIVAL_BUILD_DIR: path.join(temporary, "data/build"),
  };
  const setup = spawnSync(process.execPath, [
    path.join(bundle, "revival"),
    "setup", "production",
    "--domain", "pin.example.test",
    "--acme-email", "acme@example.test",
    "--operator-email", "owner@example.test",
  ], { cwd: bundle, env: operatorEnv, encoding: "utf8", timeout: 30_000 });
  assert.equal(setup.status, 0, setup.stderr);

  const importUsage = spawnSync(process.execPath, [
    path.join(bundle, "revival"), "pin", "release", "import",
  ], { cwd: bundle, env: operatorEnv, encoding: "utf8" });
  assert.equal(importUsage.status, 1);
  assert.match(importUsage.stderr, /pin release import ARCHIVE/u);
  assert.doesNotMatch(importUsage.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/u);

  const activateUsage = spawnSync(process.execPath, [
    path.join(bundle, "revival"), "pin", "activate",
  ], { cwd: bundle, env: operatorEnv, encoding: "utf8" });
  assert.notEqual(activateUsage.status, 0);
  assert.match(activateUsage.stderr, /--serial is required|usage/u);
  assert.doesNotMatch(activateUsage.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/u);
  const runtime = fs.readFileSync(operatorEnv.REVIVAL_ENV_FILE, "utf8");
  assert.match(runtime, new RegExp(`^REVIVAL_RELEASE_ID=${revision}$`, "mu"));
  assert.match(runtime, new RegExp(`^REVIVAL_COMPOSE_APPLICATION=oci://ghcr\\.io/.+@${applicationDigest}$`, "mu"));

  const production = path.join(operatorEnv.REVIVAL_CONFIG_DIR, "production");
  const preservedRealm = fs.readFileSync(path.join(production, "realm.json"), "utf8");
  const preservedSessionSecret = /^AUTH_SESSION_SECRET=(.+)$/mu.exec(runtime)?.[1];
  const nextRevision = "c".repeat(40);
  const nextApplicationDigest = digest("d");
  fs.writeFileSync(
    path.join(bundle, "platform/distribution/version.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      version: "1.2.4",
      revision: nextRevision,
      application: `oci://ghcr.io/theandersmadsen/ai-pin-revival/application@${nextApplicationDigest}`,
    })}\n`,
  );
  const upgrade = spawnSync(process.execPath, [path.join(bundle, "revival"), "setup", "production"], {
    cwd: bundle,
    env: operatorEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(upgrade.status, 0, upgrade.stderr);
  const upgradedRuntime = fs.readFileSync(operatorEnv.REVIVAL_ENV_FILE, "utf8");
  assert.match(upgradedRuntime, new RegExp(`^REVIVAL_RELEASE_ID=${nextRevision}$`, "mu"));
  assert.match(upgradedRuntime, new RegExp(`^REVIVAL_COMPOSE_APPLICATION=oci://ghcr\\.io/.+@${nextApplicationDigest}$`, "mu"));
  assert.equal(/^AUTH_SESSION_SECRET=(.+)$/mu.exec(upgradedRuntime)?.[1], preservedSessionSecret);
  assert.equal(fs.readFileSync(path.join(production, "realm.json"), "utf8"), preservedRealm);

  const checksums = fs.readFileSync(path.join(output, "SHA256SUMS"), "utf8");
  assert.match(checksums, new RegExp(`  ${archiveName}$`, "mu"));
  assert.match(checksums, new RegExp(`  ${descriptorName}$`, "mu"));
});

test("release input validation rejects a mutable image reference", (t) => {
  const { receipts, output } = fixture(t);
  const center = JSON.parse(fs.readFileSync(path.join(receipts, "center.json"), "utf8"));
  center.reference = "ghcr.io/theandersmadsen/ai-pin-revival/center:v1.2.3";
  fs.writeFileSync(path.join(receipts, "center.json"), `${JSON.stringify(center)}\n`);
  const result = spawnSync(process.execPath, [
    builder,
    "--version", "1.2.3",
    "--revision", "b".repeat(40),
    "--repository", "theandersmadsen/Ai-Pin-Revival",
    "--tag", "v1.2.3",
    "--receipts", receipts,
    "--output", output,
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /digest-pinned GHCR reference/u);
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
    `ghcr.io/theandersmadsen/ai-pin-revival/center-iroh-bridge@${digest("2")}`,
  );
  assert.deepEqual(
    Object.keys(model.services["center-iroh-bridge"].networks).sort(),
    ["provider-egress", "spotify-control"],
  );
  assert.equal(model.networks["spotify-control"].internal, true);
  assert.equal(
    model.services["spotify-adapter"].environment.REVIVAL_SPOTIFY_ADAPTER_UPSTREAM_ORIGIN,
    "http://center-iroh-bridge:18080",
  );
  assert.equal(
    model.services.center.environment.REVIVAL_SPOTIFY_ADAPTER_TIMEOUT_MS,
    "10000",
  );
  assert.equal(
    model.services["spotify-adapter"].environment.REVIVAL_SPOTIFY_ADAPTER_TIMEOUT_MS,
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
    "ghcr.io/example/ai-pin-revival/application:dryrun",
  ], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  assert.equal(publish.status, 0, publish.stderr);
});
