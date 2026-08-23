import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PIN_COMPATIBILITY_CERT_SHA256,
  createDockerBuildInvocation,
  createDockerPrefetchInvocation,
  createDockerRunInvocation,
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
  assert.deepEqual(build.args.slice(0, 3), ["build", "--platform", "linux/amd64"]);
  const prefetch = createDockerPrefetchInvocation(common);
  assert.ok(prefetch.args.includes("prefetch-release"));
  assert.equal(prefetch.args.some((value) => value.includes("signing.env")), false);
  const signed = createDockerRunInvocation({
    ...common,
    signingEnvironment: "/inputs/signing.env",
    compatibilitySigningStore: "/inputs/release.keystore",
    embeddedPatchSigningStore: "/inputs/patch.keystore",
    privateAssets: "/inputs/assets",
  });
  assert.ok(signed.args.includes("none"));
  assert.ok(signed.args.some((value) => value.includes("/run/secrets/pin/signing.env")));
  assert.ok(signed.args.some((value) => value === "type=bind,src=/source,dst=/workspace,readonly"));
  assert.ok(signed.args.includes("build-release"));
});

test("builder metadata accepts exactly five digest-matched APKs", async () => {
  const stagingRoot = await mkdtemp(join(tmpdir(), "revival-release-metadata-"));
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
  const temporary = await mkdtemp(join(tmpdir(), "revival-release-store-"));
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
