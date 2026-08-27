import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
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

import { publishRelease } from "../pin/build.mjs";
import { exportPinRelease } from "../pin/export-release.mjs";
import { importPinRelease } from "../pin/import-release.mjs";
import {
  PIN_COMPATIBILITY_CERT_SHA256,
  PIN_RELEASE_ARTIFACT_ROLES,
  PIN_RELEASE_PACKAGE_BY_ROLE,
} from "../pin/release.mjs";

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), "revival-pin-import-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const stagingRoot = join(temporary, "staging");
  const sourceStore = join(temporary, "source-store");
  const archive = join(temporary, "pin-release.tar.gz");
  await mkdir(stagingRoot);
  const version = "2026-08-24.1";
  const versionCode = 202_608_241;
  const artifacts = [];
  for (const role of PIN_RELEASE_ARTIFACT_ROLES) {
    const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`signed-${role}`)]);
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
      signerSha256: PIN_COMPATIBILITY_CERT_SHA256,
    });
  }
  const published = await publishRelease({
    releaseRoot: sourceStore,
    stagingRoot,
    version,
    receipts: { schemaVersion: 1, artifacts },
  });
  await exportPinRelease({ output: archive, releaseRoot: sourceStore });
  return { temporary, sourceStore, archive, published, version };
}

function tar(parent, directory, archive) {
  const result = spawnSync("/usr/bin/tar", ["-czf", archive, "-C", parent, directory], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

test("published Pin release archives round-trip into a checkout-free operator store", async (t) => {
  const { temporary, archive, published, version } = await fixture(t);
  const importedStore = join(temporary, "imported-store");
  const previousUmask = process.umask(0o077);
  t.after(() => process.umask(previousUmask));
  const imported = await importPinRelease({ archive, releaseRoot: importedStore });

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

test("Pin release import rejects a digest mismatch and archive links", async (t) => {
  const { temporary, archive, version } = await fixture(t);
  const unpacked = join(temporary, "unpacked");
  await mkdir(unpacked);
  const extract = spawnSync("/usr/bin/tar", ["-xzf", archive, "-C", unpacked], { encoding: "utf8" });
  assert.equal(extract.status, 0, extract.stderr);
  const directory = `ai-pin-revival-pin-${version}`;

  await appendFile(join(unpacked, directory, "server.apk"), "tampered");
  const tampered = join(temporary, "tampered.tar.gz");
  tar(unpacked, directory, tampered);
  await assert.rejects(
    importPinRelease({ archive: tampered, releaseRoot: join(temporary, "tampered-store") }),
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
    importPinRelease({ archive: linked, releaseRoot: join(temporary, "linked-store") }),
    /only regular files/u,
  );
});
