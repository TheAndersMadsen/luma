import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IMAGE_NAMES } from "../../distribution/release-descriptor.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const workflow = path.join(root, ".github/workflows/release-cli.yml");
const builder = path.join(root, "platform/distribution/build.mjs");

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
      schemaVersion: 1,
      name,
      reference: `ghcr.io/theandersmadsen/ai-pin-revival/${name}@${imageDigest}`,
      digest: imageDigest,
      platform: "linux/amd64",
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

test("tag release workflow publishes the exact hardened image and Compose boundaries", () => {
  const source = fs.readFileSync(workflow, "utf8");
  assert.match(source, /push:\n\s+tags:\n\s+- "v\*"/u);
  assert.doesNotMatch(source, /workflow_dispatch/u);
  for (const name of IMAGE_NAMES) assert.match(source, new RegExp(`name: ${name}`, "u"));
  for (const match of source.matchAll(/^\s*uses:\s+[^@\s]+@([^\s#]+)/gmu)) {
    assert.match(match[1], /^[0-9a-f]{40}$/u, match[0]);
  }
  assert.match(source, /platforms: linux\/amd64/u);
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

  const archiveName = `ai-pin-revival-operator-${version}-linux-x64.tar.gz`;
  const archive = path.join(output, archiveName);
  const descriptorName = `ai-pin-revival-${version}.release.json`;
  const descriptor = JSON.parse(fs.readFileSync(path.join(output, descriptorName), "utf8"));
  assert.deepEqual(Object.keys(descriptor).sort(), [
    "application", "images", "operator", "platform", "product", "revision", "schemaVersion", "source", "version",
  ]);
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
  const runtime = fs.readFileSync(operatorEnv.REVIVAL_ENV_FILE, "utf8");
  assert.match(runtime, new RegExp(`^REVIVAL_RELEASE_ID=${revision}$`, "mu"));
  assert.match(runtime, new RegExp(`^REVIVAL_COMPOSE_APPLICATION=oci://ghcr\\.io/.+@${applicationDigest}$`, "mu"));

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
