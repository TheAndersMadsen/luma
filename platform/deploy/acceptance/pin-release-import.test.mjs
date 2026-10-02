import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createV2SignedApkFixture } from "./fixtures/signed-apk.mjs";
import { describePinReleaseArchive, importPinRelease } from "../pin/import-release.mjs";
import {
  activateMatchingPinRelease,
  acquireMatchingPinRelease,
  checkMatchingPinRelease,
  exactPinReleaseUrl,
} from "../pin/acquire-release.mjs";
import {
  canonicalPinReleaseManifestJson,
  createPinReleaseManifest,
  PIN_RELEASE_ARTIFACT_ROLES,
  PIN_RELEASE_PACKAGE_BY_ROLE,
} from "../pin/release.mjs";
import { canonicalPinReleasePaths } from "../pin/release-store-path.mjs";
import { validateReleaseStore } from "../pin/validate-release-store.mjs";

const trustEmbeddedRelease = async ({ embedded }) => embedded;
const acquireFixtureRelease = (options) => acquireMatchingPinRelease({
  ...options,
  verifyBindingImpl: trustEmbeddedRelease,
  resolveAssetImpl: async ({ name }) => {
    const document = JSON.parse(await readFile(options.versionFile, "utf8"));
    return Object.freeze({
      name,
      size: document.pin.size,
      url: "https://api.github.com/repos/TheAndersMadsen/luma/releases/assets/123",
    });
  },
});
const checkFixtureRelease = (options) => checkMatchingPinRelease({
  ...options,
  verifyBindingImpl: trustEmbeddedRelease,
});
const activateFixtureRelease = (options) => activateMatchingPinRelease({
  ...options,
  verifyBindingImpl: trustEmbeddedRelease,
});

async function fixture(t, {
  version = "2026-08-24.1",
  versionCode = 202_608_241,
} = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "luma-pin-import-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const stagingRoot = join(temporary, "staging");
  const archive = join(temporary, `luma-pin-${version}.tar.gz`);
  await mkdir(stagingRoot);
  const signed = createV2SignedApkFixture({ directory: join(temporary, "signing") });
  const artifacts = [];
  for (const role of PIN_RELEASE_ARTIFACT_ROLES) {
    const bytes = signed.bytes;
    await writeFile(join(stagingRoot, `${role}.apk`), bytes);
    artifacts.push({
      role,
      path: `${role}.apk`,
      name: `${role}.apk`,
      package: PIN_RELEASE_PACKAGE_BY_ROLE[role],
      versionName: version,
      versionCode,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      signerSha256: signed.signerSha256,
    });
  }
  const receipts = { schemaVersion: 1, artifacts };
  const published = createPinReleaseManifest({ version, receipts });
  const directory = `luma-pin-${version}`;
  const releaseDirectory = join(temporary, directory);
  await mkdir(releaseDirectory);
  await writeFile(join(releaseDirectory, "manifest.json"), canonicalPinReleaseManifestJson(published));
  await writeFile(join(releaseDirectory, "receipts.json"), `${JSON.stringify(receipts)}\n`);
  for (const role of PIN_RELEASE_ARTIFACT_ROLES) {
    await writeFile(join(releaseDirectory, `${role}.apk`), signed.bytes);
  }
  tar(temporary, directory, archive);
  return { temporary, archive, published, version, signerSha256: signed.signerSha256 };
}

async function writeVersionFile(temporary, pin) {
  const versionFile = join(temporary, "version.json");
  await writeFile(versionFile, `${JSON.stringify({
    schemaVersion: 2,
    version: "1.2.3",
    revision: "b".repeat(40),
    application: `oci://ghcr.io/example/project/application@sha256:${"a".repeat(64)}`,
    source: { repository: "TheAndersMadsen/luma", tag: "v1.2.3" },
    pin,
  })}\n`);
  return versionFile;
}

function tar(parent, directory, archive) {
  const result = spawnSync("/usr/bin/tar", ["-czf", archive, "-C", parent, directory], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

test("every Pin release operation shares the canonical data-root namespace", () => {
  const paths = canonicalPinReleasePaths({
    LUMA_DATA_DIR: "/operator/data",
    LUMA_PIN_RELEASE_OUTPUT_DIR: "/ambient/split-store",
  });
  assert.deepEqual(paths, {
    data: "/operator/data",
    active: "/operator/data/pin-releases",
    staging: "/operator/data/pin-release-staging",
  });
});

test("published Pin release archives round-trip into a checkout-free operator store", async (t) => {
  const { temporary, archive, published, version, signerSha256 } = await fixture(t);
  const importedStore = join(temporary, "imported-store");
  const previousUmask = process.umask(0o077);
  t.after(() => process.umask(previousUmask));
  const imported = await importPinRelease({ archive, releaseRoot: importedStore, expectedSigner: signerSha256 });

  assert.equal(imported.version, version);
  assert.equal(imported.releaseId, published.releaseId);
  assert.deepEqual((await readdir(importedStore)).sort(), ["current.json", "releases"]);
  assert.equal(
    await readFile(join(importedStore, "current.json"), "utf8"),
    await readFile(join(importedStore, "releases", imported.releaseId, "manifest.json"), "utf8"),
  );
  assert.equal((await stat(importedStore)).mode & 0o777, 0o755);
  assert.equal((await stat(join(importedStore, "releases"))).mode & 0o777, 0o755);
  const releaseDirectory = join(importedStore, "releases", imported.releaseId);
  assert.equal((await stat(releaseDirectory)).mode & 0o777, 0o755);
  for (const name of ["current.json", "manifest.json", ...PIN_RELEASE_ARTIFACT_ROLES.map((role) => `${role}.apk`)]) {
    const filename = name === "current.json" ? join(importedStore, name) : join(releaseDirectory, name);
    assert.equal((await stat(filename)).mode & 0o777, 0o444, filename);
  }
});

test("descriptor-bound acquisition downloads one exact asset and is idempotent", async (t) => {
  const { temporary, archive, published, version, signerSha256 } = await fixture(t);
  const pin = await describePinReleaseArchive({ archive, expectedSigner: signerSha256 });
  const versionFile = await writeVersionFile(temporary, pin);
  const expectedUrl = `https://github.com/TheAndersMadsen/luma/releases/download/v1.2.3/${pin.archive}`;
  assert.equal(exactPinReleaseUrl({
    source: { repository: "TheAndersMadsen/luma", tag: "v1.2.3" },
    pin,
  }), expectedUrl);

  const releaseRoot = join(temporary, "acquired-store");
  const stagingRoot = join(temporary, "pin-release-staging");
  await assert.rejects(
    checkFixtureRelease({ releaseRoot, stagingRoot, versionFile }),
    /neither active nor staged/u,
  );
  const requested = [];
  const fetchImpl = async (url, options) => {
    requested.push({ url: String(url), options });
    return new Response(await readFile(archive), {
      status: 200,
      headers: { "content-length": String((await stat(archive)).size) },
    });
  };
  const acquired = await acquireFixtureRelease({ releaseRoot, stagingRoot, versionFile, fetchImpl });
  assert.equal(acquired.acquired, true);
  assert.equal(acquired.active, false);
  assert.equal(acquired.staged, true);
  assert.equal(acquired.releaseId, published.releaseId);
  assert.equal(acquired.version, version);
  assert.equal(acquired.versionCode, pin.versionCode);
  assert.equal(acquired.manifestSha256, pin.manifestSha256);
  assert.deepEqual(requested.map(({ url }) => url), [
    "https://api.github.com/repos/TheAndersMadsen/luma/releases/assets/123",
  ]);
  assert.equal(requested[0].options.redirect, "manual");

  const again = await acquireFixtureRelease({
    releaseRoot,
    stagingRoot,
    versionFile,
    fetchImpl: async () => { throw new Error("compatible releases must not be downloaded twice"); },
  });
  assert.equal(again.acquired, false);
  assert.equal((await checkFixtureRelease({ releaseRoot, stagingRoot, versionFile })).staged, true);
  await assert.rejects(readFile(join(releaseRoot, "current.json")), /ENOENT/u);

  const activated = await activateFixtureRelease({ releaseRoot, stagingRoot, versionFile });
  assert.equal(activated.activated, true);
  assert.equal(activated.active, true);
  assert.equal((await checkFixtureRelease({ releaseRoot, stagingRoot, versionFile })).active, true);
});

test("explicit offline archive acquisition stages only exact embedded bytes without network fallback", async (t) => {
  const { temporary, archive, published, signerSha256 } = await fixture(t);
  const pin = await describePinReleaseArchive({ archive, expectedSigner: signerSha256 });
  const versionFile = await writeVersionFile(temporary, pin);
  const releaseRoot = join(temporary, "offline-active");
  const stagingRoot = join(temporary, "offline-stage");
  const noNetwork = async () => { throw new Error("offline acquisition must not use the network"); };
  const acquired = await acquireMatchingPinRelease({
    releaseRoot,
    stagingRoot,
    versionFile,
    archiveFile: archive,
    fetchImpl: noNetwork,
    verifyBindingImpl: noNetwork,
  });
  assert.equal(acquired.acquired, true);
  assert.equal(acquired.staged, true);
  assert.equal(acquired.releaseId, published.releaseId);
  assert.equal((await checkMatchingPinRelease({ releaseRoot, stagingRoot, versionFile })).staged, true);

  const malformed = join(temporary, "malformed-local.tar.gz");
  await writeFile(malformed, Buffer.concat([await readFile(archive), Buffer.from("tampered")]));
  await assert.rejects(
    acquireMatchingPinRelease({
      releaseRoot: join(temporary, "malformed-active"),
      stagingRoot: join(temporary, "malformed-stage"),
      versionFile,
      archiveFile: malformed,
      fetchImpl: noNetwork,
      verifyBindingImpl: noNetwork,
    }),
    /does not match its embedded size and SHA-256: .+ is \d+ bytes; this release needs luma-pin-\S+\.tar\.gz \(\d+ bytes, SHA-256 [0-9a-f]{64}\)/u,
  );
});

test("descriptor-bound acquisition rejects a mixed current release before downloading", async (t) => {
  const { temporary, archive, signerSha256 } = await fixture(t);
  const pin = await describePinReleaseArchive({ archive, expectedSigner: signerSha256 });
  const versionFile = await writeVersionFile(temporary, { ...pin, releaseId: "f".repeat(64) });
  const releaseRoot = join(temporary, "mixed-store");
  await importPinRelease({ archive, releaseRoot, expectedSigner: signerSha256 });
  let fetched = false;
  await assert.rejects(
    acquireFixtureRelease({
      releaseRoot,
      stagingRoot: join(temporary, "pin-release-staging"),
      versionFile,
      fetchImpl: async () => { fetched = true; throw new Error("must not fetch"); },
    }),
    /does not match operator release Pin/u,
  );
  assert.equal(fetched, false);
});

test("acquisition authenticates the published binding before reading or downloading a Pin release", async (t) => {
  const { temporary, archive, signerSha256 } = await fixture(t);
  const pin = await describePinReleaseArchive({ archive, expectedSigner: signerSha256 });
  const versionFile = await writeVersionFile(temporary, pin);
  let fetched = false;
  await assert.rejects(
    acquireMatchingPinRelease({
      releaseRoot: join(temporary, "active"),
      stagingRoot: join(temporary, "stage"),
      versionFile,
      fetchImpl: async () => { fetched = true; throw new Error("Pin archive fetch must not run"); },
      verifyBindingImpl: async () => { throw new Error("published release proof is invalid"); },
    }),
    /published release proof is invalid/u,
  );
  assert.equal(fetched, false);
});

test("descriptor-bound acquisition rejects wrong bytes and redirect escape before import", async (t) => {
  const { temporary, archive, signerSha256 } = await fixture(t);
  const pin = await describePinReleaseArchive({ archive, expectedSigner: signerSha256 });
  const versionFile = join(temporary, "version.json");
  const writeVersion = async (selectedPin) => writeVersionFile(temporary, selectedPin);

  await writeVersion({ ...pin, size: pin.size + 1 });
  await assert.rejects(
    acquireFixtureRelease({
      releaseRoot: join(temporary, "wrong-size-store"),
      versionFile,
      fetchImpl: async () => new Response(await readFile(archive), {
        status: 200,
        headers: { "content-length": String(pin.size) },
      }),
    }),
    /download size does not match/u,
  );

  await writeVersion(pin);
  await assert.rejects(
    acquireFixtureRelease({
      releaseRoot: join(temporary, "redirect-store"),
      versionFile,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: "https://downloads.example.invalid/pin.tar.gz" },
      }),
    }),
    /left the approved HTTPS boundary/u,
  );
});

test("descriptor-bound acquisition fails closed for malformed metadata, digest mismatch, network failure, and timeout", async (t) => {
  const { temporary, archive, signerSha256 } = await fixture(t);
  const pin = await describePinReleaseArchive({ archive, expectedSigner: signerSha256 });
  const bytes = await readFile(archive);
  const releaseRoot = join(temporary, "active");
  const nextStage = (name) => join(temporary, `stage-${name}`);

  const malformed = join(temporary, "malformed-version.json");
  await writeFile(malformed, "{not-json\n");
  await assert.rejects(
    acquireFixtureRelease({
      releaseRoot,
      stagingRoot: nextStage("malformed"),
      versionFile: malformed,
      fetchImpl: async () => { throw new Error("must not fetch malformed metadata"); },
    }),
    /JSON|property name/u,
  );

  const unbound = join(temporary, "unbound-version.json");
  await writeFile(unbound, `${JSON.stringify({
    schemaVersion: 1,
    version: "1.2.3",
    revision: "b".repeat(40),
    application: `oci://ghcr.io/example/project/application@sha256:${"a".repeat(64)}`,
  })}\n`);
  await assert.rejects(
    acquireFixtureRelease({
      releaseRoot,
      stagingRoot: nextStage("unbound"),
      versionFile: unbound,
      fetchImpl: async () => { throw new Error("must not fetch unbound metadata"); },
    }),
    /does not contain a supported matching Pin descriptor/u,
  );

  const badDigest = {
    ...pin,
    sha256: `${pin.sha256[0] === "0" ? "1" : "0"}${pin.sha256.slice(1)}`,
  };
  const badDigestFile = await writeVersionFile(temporary, badDigest);
  await assert.rejects(
    acquireFixtureRelease({
      releaseRoot,
      stagingRoot: nextStage("digest"),
      versionFile: badDigestFile,
      fetchImpl: async () => new Response(bytes, {
        status: 200,
        headers: { "content-length": String(bytes.length) },
      }),
    }),
    /descriptor-bound size and SHA-256/u,
  );

  const versionFile = await writeVersionFile(temporary, pin);
  await assert.rejects(
    acquireFixtureRelease({
      releaseRoot,
      stagingRoot: nextStage("network"),
      versionFile,
      fetchImpl: async () => { throw new Error("simulated connection failure"); },
    }),
    /simulated connection failure/u,
  );

  await assert.rejects(
    acquireFixtureRelease({
      releaseRoot,
      stagingRoot: nextStage("timeout"),
      versionFile,
      fetchTimeoutMs: 10,
      fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
        const keepEventLoopAlive = setTimeout(resolve, 1_000);
        signal.addEventListener("abort", () => {
          clearTimeout(keepEventLoopAlive);
          reject(signal.reason);
        }, { once: true });
      }),
    }),
    /timeout|timed out/iu,
  );
});

test("concurrent acquisition and activation publish one idempotent matching release", async (t) => {
  const { temporary, archive, published, signerSha256 } = await fixture(t);
  const pin = await describePinReleaseArchive({ archive, expectedSigner: signerSha256 });
  const versionFile = await writeVersionFile(temporary, pin);
  const releaseRoot = join(temporary, "active");
  const stagingRoot = join(temporary, "stage");
  const bytes = await readFile(archive);
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(bytes, {
      status: 200,
      headers: { "content-length": String(bytes.length) },
    });
  };

  const acquired = await Promise.all([
    acquireFixtureRelease({ releaseRoot, stagingRoot, versionFile, fetchImpl }),
    acquireFixtureRelease({ releaseRoot, stagingRoot, versionFile, fetchImpl }),
  ]);
  assert.equal(acquired.filter((entry) => entry.acquired).length, 1);
  assert.ok(requests >= 1 && requests <= 2);
  assert.ok(acquired.every((entry) => entry.staged));

  const activated = await Promise.all([
    activateFixtureRelease({ releaseRoot, stagingRoot, versionFile }),
    activateFixtureRelease({ releaseRoot, stagingRoot, versionFile }),
  ]);
  assert.equal(activated.filter((entry) => entry.activated).length, 1);
  assert.ok(activated.every((entry) => entry.active));
  assert.equal((await validateReleaseStore(releaseRoot)).releaseId, published.releaseId);
});

test("failed staged activation preserves the previously active Pin release", async (t) => {
  const target = await fixture(t, { version: "2026-08-24.1", versionCode: 202_608_241 });
  const previous = await fixture(t, { version: "2026-08-23.1", versionCode: 202_608_231 });
  const pin = await describePinReleaseArchive({
    archive: target.archive,
    expectedSigner: target.signerSha256,
  });
  const versionFile = await writeVersionFile(target.temporary, pin);
  const releaseRoot = join(target.temporary, "active");
  const stagingRoot = join(target.temporary, "stage");
  await importPinRelease({
    archive: previous.archive,
    releaseRoot,
    expectedSigner: previous.signerSha256,
  });
  const oldCurrent = await readFile(join(releaseRoot, "current.json"), "utf8");
  const bytes = await readFile(target.archive);
  await acquireFixtureRelease({
    releaseRoot,
    stagingRoot,
    versionFile,
    fetchImpl: async () => new Response(bytes, {
      status: 200,
      headers: { "content-length": String(bytes.length) },
    }),
  });
  const stagedServer = join(
    stagingRoot, "releases", target.published.releaseId,
    "store", "releases", target.published.releaseId, "server.apk",
  );
  await chmod(stagedServer, 0o600);
  await appendFile(stagedServer, "tampered after acquisition");

  await assert.rejects(
    activateFixtureRelease({ releaseRoot, stagingRoot, versionFile }),
    /server artifact size does not match/u,
  );
  assert.equal(await readFile(join(releaseRoot, "current.json"), "utf8"), oldCurrent);
  assert.equal((await validateReleaseStore(releaseRoot)).releaseId, previous.published.releaseId);
});

test("successful activation retains the previous immutable release for in-flight clients", async (t) => {
  const target = await fixture(t, { version: "2026-08-24.1", versionCode: 202_608_241 });
  const previous = await fixture(t, { version: "2026-08-23.1", versionCode: 202_608_231 });
  const pin = await describePinReleaseArchive({
    archive: target.archive,
    expectedSigner: target.signerSha256,
  });
  const versionFile = await writeVersionFile(target.temporary, pin);
  const releaseRoot = join(target.temporary, "retained-active");
  const stagingRoot = join(target.temporary, "retained-stage");
  await importPinRelease({
    archive: previous.archive,
    releaseRoot,
    expectedSigner: previous.signerSha256,
  });
  const bytes = await readFile(target.archive);
  await acquireFixtureRelease({
    releaseRoot,
    stagingRoot,
    versionFile,
    fetchImpl: async () => new Response(bytes, {
      status: 200,
      headers: { "content-length": String(bytes.length) },
    }),
  });

  await activateFixtureRelease({ releaseRoot, stagingRoot, versionFile });

  assert.equal((await validateReleaseStore(releaseRoot)).releaseId, target.published.releaseId);
  assert.equal(
    (await stat(join(releaseRoot, "releases", previous.published.releaseId))).isDirectory(),
    true,
  );
});

test("concurrent manual imports cannot publish an older release last", async (t) => {
  const newer = await fixture(t, { version: "2026-08-25.1", versionCode: 202_608_251 });
  const older = await fixture(t, { version: "2026-08-24.1", versionCode: 202_608_241 });
  const releaseRoot = join(newer.temporary, "concurrent-import-store");
  const outcomes = await Promise.allSettled([
    importPinRelease({
      archive: newer.archive,
      releaseRoot,
      expectedSigner: newer.signerSha256,
    }),
    importPinRelease({
      archive: older.archive,
      releaseRoot,
      expectedSigner: older.signerSha256,
    }),
  ]);
  assert.equal(outcomes[0].status, "fulfilled");
  assert.equal((await validateReleaseStore(releaseRoot)).releaseId, newer.published.releaseId);
  if (outcomes[1].status === "rejected") {
    assert.match(String(outcomes[1].reason), /refusing to replace current Pin release/u);
  }
});

test("Pin release import rejects a digest mismatch and archive links", async (t) => {
  const { temporary, archive, version, signerSha256 } = await fixture(t);
  const unpacked = join(temporary, "unpacked");
  await mkdir(unpacked);
  const extract = spawnSync("/usr/bin/tar", ["-xzf", archive, "-C", unpacked], { encoding: "utf8" });
  assert.equal(extract.status, 0, extract.stderr);
  const directory = `luma-pin-${version}`;

  await appendFile(join(unpacked, directory, "server.apk"), "tampered");
  const tampered = join(temporary, "tampered.tar.gz");
  tar(unpacked, directory, tampered);
  await assert.rejects(
    importPinRelease({
      archive: tampered,
      releaseRoot: join(temporary, "tampered-store"),
      expectedSigner: signerSha256,
    }),
    /server\.apk does not match its manifest/u,
  );

  await rm(unpacked, { recursive: true });
  await mkdir(unpacked);
  const extractAgain = spawnSync("/usr/bin/tar", ["-xzf", archive, "-C", unpacked], { encoding: "utf8" });
  assert.equal(extractAgain.status, 0, extractAgain.stderr);
  await unlink(join(unpacked, directory, "server.apk"));
  await symlink("hook.apk", join(unpacked, directory, "server.apk"));
  const linked = join(temporary, "linked.tar.gz");
  tar(unpacked, directory, linked);
  await assert.rejects(
    importPinRelease({
      archive: linked,
      releaseRoot: join(temporary, "linked-store"),
      expectedSigner: signerSha256,
    }),
    /only regular files/u,
  );
});
