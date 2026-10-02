import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  PIN_COMPATIBILITY_CERT_SHA256,
  createDockerBuildInvocation,
  createDockerPrefetchInvocation,
  createDockerRunInvocation,
  nativeDockerPlatform,
  parseBuilderMetadata,
  parseLiteralSigningEnvironment,
  publishRelease,
  validatePinReleaseVersion,
} from "../pin/build.mjs";
import { PIN_RELEASE_ARTIFACT_ROLES, PIN_RELEASE_PACKAGE_BY_ROLE } from "../pin/release.mjs";

test("literal signing parser accepts only the four required values", () => {
  const parsed = parseLiteralSigningEnvironment([
    "export PIN_SIGNING_STORE_FILE='/outside/pin.keystore'",
    "export PIN_SIGNING_STORE_PASSWORD='store pass'",
    "export PIN_SIGNING_KEY_ALIAS=release",
    "export PIN_SIGNING_KEY_PASSWORD='key pass'",
    "",
  ].join("\n"));
  assert.equal(parsed.PIN_SIGNING_KEY_ALIAS, "release");
  assert.throws(
    () => parseLiteralSigningEnvironment("export PIN_SIGNING_STORE_FILE=/x"),
    /missing PIN_SIGNING_STORE_PASSWORD/u,
  );
  assert.throws(
    () => parseLiteralSigningEnvironment([
      "export PIN_SIGNING_STORE_FILE=/x",
      "export PIN_SIGNING_STORE_PASSWORD=x",
      "export PIN_SIGNING_KEY_ALIAS=x",
      "export PIN_SIGNING_KEY_PASSWORD=x",
      "export EXTRA=x",
    ].join("\n")),
    /unsupported name/u,
  );
});

test("release version parser rejects impossible dates and Android overflow", () => {
  assert.deepEqual(validatePinReleaseVersion("2026-08-23.1", 202_608_231), {
    version: "2026-08-23.1",
    versionCode: 202_608_231,
  });
  assert.throws(() => validatePinReleaseVersion("2026-02-30.1", 1), /real date/u);
  assert.throws(() => validatePinReleaseVersion("2026-08-23.0", 1), /positive sequence/u);
  assert.throws(() => validatePinReleaseVersion("2026-08-23.1", 2_147_483_648), /Android integer/u);
});

test("Docker release flow separates dependency fetch from signing inputs", () => {
  const common = {
    sourceRoot: "/source",
    stateDir: "/build/state",
    cacheDir: "/build/cache",
    image: "fixture:image",
    version: "2026-08-23.1",
    versionCode: 202_608_231,
  };
  const build = createDockerBuildInvocation({ sourceRoot: common.sourceRoot, image: common.image });
  assert.deepEqual(build.args.slice(0, 3), ["build", "--platform", nativeDockerPlatform()]);
  const prefetch = createDockerPrefetchInvocation(common);
  assert.ok(prefetch.args.includes("prefetch-release"));
  assert.equal(prefetch.args.some((value) => value.includes("signing.env")), false);
  const signed = createDockerRunInvocation({
    ...common,
    signingEnvironment: "/inputs/signing.env",
    compatibilitySigningStore: "/inputs/release.keystore",
    embeddedPatchSigningStore: "/inputs/patch.keystore",
  });
  assert.ok(signed.args.includes("none"));
  assert.ok(signed.args.some((value) => value.includes("/run/secrets/pin/signing.env")));
  assert.ok(signed.args.some((value) => value === "type=bind,src=/source,dst=/workspace,readonly"));
  assert.ok(signed.args.includes("build-release"));
  // Docker splits a --mount value at commas, so a signing path with one is
  // refused in plain words instead of mounting the wrong file.
  assert.throws(() => createDockerRunInvocation({
    ...common,
    signingEnvironment: "/inputs/pin,signing/signing.env",
    compatibilitySigningStore: "/inputs/release.keystore",
    embeddedPatchSigningStore: "/inputs/patch.keystore",
  }), /Docker bind mounts cannot use a path containing a comma: \/inputs\/pin,signing\/signing\.env/u);
});

test("builder metadata accepts exactly five digest-matched APKs", async () => {
  const stagingRoot = await mkdtemp(join(tmpdir(), "luma-release-metadata-"));
  const version = "2026-08-23.1";
  const versionCode = 202_608_231;
  const rows = [];
  for (const role of PIN_RELEASE_ARTIFACT_ROLES) {
    const bytes = Buffer.from(`fixture-${role}`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(stagingRoot, `${role}.apk`), bytes);
    rows.push([
      role,
      PIN_RELEASE_PACKAGE_BY_ROLE[role],
      version,
      versionCode,
      PIN_COMPATIBILITY_CERT_SHA256,
      digest,
      bytes.length,
    ].join("\t"));
  }
  await writeFile(join(stagingRoot, "release-metadata.tsv"), `${rows.join("\n")}\n`);
  const receipts = await parseBuilderMetadata({ stagingRoot, version, versionCode });
  assert.deepEqual(receipts.artifacts.map((artifact) => artifact.role), PIN_RELEASE_ARTIFACT_ROLES);
  await writeFile(join(stagingRoot, "server.apk"), "tampered");
  await assert.rejects(
    parseBuilderMetadata({ stagingRoot, version, versionCode }),
    /server APK differs/u,
  );
});

test("a successful build removes old local releases", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "luma-release-store-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const releaseRoot = join(temporary, "published");
  await mkdir(join(releaseRoot, "releases", "old-release"), { recursive: true });

  const version = "2026-08-23.2", versionCode = 202_608_232;
  const stagingRoot = join(temporary, "staging");
  await mkdir(stagingRoot);
  const rows = [];
  for (const role of PIN_RELEASE_ARTIFACT_ROLES) {
    const bytes = Buffer.from(`fixture-${version}-${role}`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(stagingRoot, `${role}.apk`), bytes);
    rows.push([
      role, PIN_RELEASE_PACKAGE_BY_ROLE[role], version, versionCode,
      PIN_COMPATIBILITY_CERT_SHA256, digest, bytes.length,
    ].join("\t"));
  }
  await writeFile(join(stagingRoot, "release-metadata.tsv"), `${rows.join("\n")}\n`);
  const receipts = await parseBuilderMetadata({ stagingRoot, version, versionCode });
  const published = await publishRelease({ releaseRoot, stagingRoot, version, receipts });

  assert.deepEqual((await readdir(releaseRoot)).sort(), ["current.json", "releases"]);
  assert.deepEqual(await readdir(join(releaseRoot, "releases")), [published.releaseId]);
  assert.equal(await readFile(published.currentManifest, "utf8"), await readFile(join(published.releaseDirectory, "manifest.json"), "utf8"));
});

test("pin release build first keeps the current release, which the build removes from the store", async (t) => {
  const root = resolve(import.meta.dirname, "../../..");
  const data = await mkdtemp(join(tmpdir(), "luma-pin-keep-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const releaseId = "a".repeat(64);
  const script = `
const fs = require("node:fs");
const { keepCurrentPinRelease } = require(${JSON.stringify(join(root, "platform/cli/pin.js"))});
const exported = [];
const exportRelease = (archive) => { exported.push(archive); fs.writeFileSync(archive, "exported release"); };
const kept = [keepCurrentPinRelease({ exportRelease }), keepCurrentPinRelease({ exportRelease })];
process.stdout.write("RESULT " + JSON.stringify({ kept, exported }) + "\\n");
`;
  const env = { ...process.env, LUMA_DATA_DIR: data };
  for (const name of ["LUMA_BUILD_DIR", "LUMA_ENV_FILE"]) delete env[name];
  const keep = () => spawnSync(process.execPath, ["-e", script], { cwd: root, env, encoding: "utf8" });
  const result = (run) => JSON.parse(/^RESULT (.*)$/mu.exec(run.stdout)?.[1] ?? "null");

  const nothing = keep();
  assert.equal(nothing.status, 0, nothing.stderr);
  assert.deepEqual(result(nothing), { kept: [null, null], exported: [] }, "no current release, nothing to keep");

  await mkdir(join(data, "pin-releases"), { recursive: true, mode: 0o700 });
  await writeFile(join(data, "pin-releases", "current.json"), "{not json");
  const unreadable = keep();
  assert.equal(unreadable.status, 1);
  assert.match(unreadable.stderr, /cannot read the current Pin release [^\n]*move it aside before building/u);

  await writeFile(join(data, "pin-releases", "current.json"),
    JSON.stringify({ schemaVersion: 1, releaseId, version: "2026-09-23.1", artifacts: [] }));
  const kept = keep();
  assert.equal(kept.status, 0, kept.stderr);
  const archive = join(data, "pin-release-exports", releaseId, "luma-pin-2026-09-23.1.tar.gz");
  assert.deepEqual(result(kept), { kept: [archive, archive], exported: [archive] },
    "exported once, then reused");
  assert.match(kept.stdout, /\[pin\] the current Pin release 2026-09-23\.1 is kept at /u);
  for (const directory of [join(data, "pin-release-exports"), join(data, "pin-release-exports", releaseId)]) {
    assert.equal((await stat(directory)).mode & 0o777, 0o700, directory);
  }
  // The archive name is the one `setup production --pin-release-archive` imports.
  assert.match(archive, /\/luma-pin-\d{4}-\d{2}-\d{2}\.\d+\.tar\.gz$/u);

  const pinCli = await readFile(join(root, "platform/cli/pin.js"), "utf8");
  assert.ok(
    pinCli.indexOf("if (operation === 'build') keepCurrentPinRelease();") <
      pinCli.indexOf("run(resolveTool('bun'), [tools[operation]"),
    "the current release is kept before the build runs",
  );
});
