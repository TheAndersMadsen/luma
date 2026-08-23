import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  PIN_RELEASE_ARTIFACT_ROLES,
  PIN_RELEASE_PACKAGE_BY_ROLE,
  canonicalPinReleaseManifestJson,
  createPinReleaseManifest,
  parsePinReleaseReceiptBundle,
} from "../pin/release.mjs";
import {
  createLocalTransport,
  createPinReleaseShipPlan,
  createSshTransport,
  readLocalPinReleaseStore,
  shipPinRelease,
  validateRemoteRoot,
  validateSshTarget,
} from "../pin/ship.mjs";

const signer = "d8a64e1c3a1afdc340c4b86feaacb88e2d81d66972afbd58e743b7c5b8d1cbdb";
let sequence = 0;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function releaseStore(parent, version = "2026-08-23.1", versionCode = 202_608_231) {
  const root = join(parent, `store-${versionCode}-${sequence++}`);
  const bytes = new Map();
  const receipts = parsePinReleaseReceiptBundle({
    schemaVersion: 1,
    artifacts: PIN_RELEASE_ARTIFACT_ROLES.map((role) => {
      const value = Buffer.from(`apk:${role}:${version}:${versionCode}`);
      bytes.set(`${role}.apk`, value);
      return {
        role, path: `${role}.apk`, name: `${role}.apk`,
        package: PIN_RELEASE_PACKAGE_BY_ROLE[role], versionName: version, versionCode,
        size: value.length, sha256: sha256(value), signerSha256: signer,
      };
    }),
  });
  const manifest = createPinReleaseManifest({ version, receipts });
  const currentSource = canonicalPinReleaseManifestJson(manifest);
  const releaseDirectory = join(root, "releases", manifest.releaseId);
  await mkdir(releaseDirectory, { recursive: true });
  await writeFile(join(root, "current.json"), currentSource);
  await writeFile(join(releaseDirectory, "manifest.json"), currentSource);
  for (const [name, value] of bytes) await writeFile(join(releaseDirectory, name), value);
  return { root, releaseDirectory, manifest, currentSource };
}

test("local publication is atomic, idempotent, and uses one current pointer", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "revival-ship-local-"));
  const source = await releaseStore(temporary);
  const target = join(temporary, "served");
  const transport = createLocalTransport();
  const plan = await shipPinRelease({ releaseRoot: source.root, remoteRoot: target, transport });
  assert.equal(plan.applied, false);
  assert.equal(plan.uploads.length, 7);
  const shipped = await shipPinRelease({
    releaseRoot: source.root, remoteRoot: target, transport, confirm: true,
  });
  assert.equal(shipped.unchanged, false);
  assert.deepEqual((await readdir(target)).sort(), ["current.json", "releases"]);
  assert.equal((await readLocalPinReleaseStore({ root: target })).manifest.releaseId, source.manifest.releaseId);
  assert.equal((await shipPinRelease({
    releaseRoot: source.root, remoteRoot: target, transport, confirm: true,
  })).unchanged, true);
});

test("both version axes must advance and a matching ID must be fully verified", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "revival-ship-version-"));
  const remote = await releaseStore(temporary, "2026-08-23.2", 202_608_232);
  const transport = createLocalTransport();
  for (const local of [
    await releaseStore(temporary, "2026-08-23.3", 202_608_232),
    await releaseStore(temporary, "2026-08-23.2", 202_608_233),
  ]) {
    await assert.rejects(
      shipPinRelease({ releaseRoot: local.root, remoteRoot: remote.root, transport }),
      /version and versionCode must both advance/u,
    );
  }
  const source = await readLocalPinReleaseStore({ root: remote.root });
  assert.throws(
    () => createPinReleaseShipPlan({ local: source, remote: { ...source, verified: false } }),
    /not fully verified/u,
  );
  await writeFile(join(remote.releaseDirectory, "server.apk"), "corrupt");
  await assert.rejects(
    shipPinRelease({ releaseRoot: remote.root, remoteRoot: remote.root, transport }),
    /server APK differs/u,
  );
});

test("local publication resumes safe staging and rejects extras and symlinks", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "revival-ship-partial-"));
  const source = await releaseStore(temporary);
  const stagingTarget = join(temporary, "partial");
  const staging = join(stagingTarget, "releases", `.incoming-${source.manifest.releaseId}`);
  await mkdir(staging, { recursive: true });
  await copyFile(join(source.releaseDirectory, "server.apk"), join(staging, "server.apk"));
  await shipPinRelease({
    releaseRoot: source.root, remoteRoot: stagingTarget, transport: createLocalTransport(), confirm: true,
  });
  assert.equal((await readLocalPinReleaseStore({ root: stagingTarget })).manifest.releaseId, source.manifest.releaseId);

  const extraTarget = join(temporary, "extra");
  const extraStaging = join(extraTarget, "releases", `.incoming-${source.manifest.releaseId}`);
  await mkdir(extraStaging, { recursive: true });
  await writeFile(join(extraStaging, "unexpected.apk"), "x");
  await assert.rejects(
    shipPinRelease({ releaseRoot: source.root, remoteRoot: extraTarget, transport: createLocalTransport() }),
    /unsafe, missing, or unexpected/u,
  );

  const real = join(temporary, "real");
  const linked = join(temporary, "linked");
  await mkdir(real);
  await symlink(real, linked);
  await assert.rejects(
    shipPinRelease({ releaseRoot: source.root, remoteRoot: linked, transport: createLocalTransport() }),
    /canonical real directory/u,
  );
});

test("SSH publication resumes with minimal rsync and commits current.json last under CAS", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "revival-ship-ssh-"));
  const fixture = await releaseStore(temporary);
  const local = await readLocalPinReleaseStore({ root: fixture.root });
  const root = "/srv/pin";
  const releases = `${root}/releases`;
  const staging = `${releases}/.incoming-${local.manifest.releaseId}`;
  const final = `${releases}/${local.manifest.releaseId}`;
  const pointer = `${releases}/.current-${local.manifest.releaseId}.tmp`;
  const directories = new Set(["/srv"]);
  const files = new Map();
  const calls = [];
  let staged = false;
  const result = (status = 0, stdout = "") => ({ status, stdout, stderr: "" });
  const listRelease = () => [
    "manifest.json", ...local.manifest.artifacts.map((artifact) => artifact.name),
  ].map((name) => `${name}\0f\0`).join("");

  const execute = async (command, args, options = {}) => {
    calls.push({ command, args: [...args], options });
    if (command === "rsync") {
      if (args.at(-2).endsWith("/")) staged = true;
      else files.set(pointer, local.currentSource);
      return result();
    }
    const remoteArgs = args.slice(args.indexOf("operator@example.test") + 1);
    const action = remoteArgs[0];
    if (action === "stat") {
      const path = remoteArgs.at(-1);
      if (directories.has(path)) return result(0, "41c0:0\n");
      if (files.has(path)) return result(0, `81a4:${Buffer.byteLength(files.get(path))}\n`);
      const artifact = local.manifest.artifacts.find(({ name }) => path.endsWith(`/${name}`));
      if ((path.startsWith(staging) && staged || path.startsWith(final) && directories.has(final)) && artifact) {
        return result(0, `81a4:${artifact.size}\n`);
      }
      if ((path === `${staging}/manifest.json` && staged) || (path === `${final}/manifest.json` && directories.has(final))) {
        return result(0, `81a4:${Buffer.byteLength(local.currentSource)}\n`);
      }
      return result(1);
    }
    if (action === "realpath") return result(0, `${remoteArgs.at(-1)}\n`);
    if (action === "mkdir") { directories.add(remoteArgs.at(-1)); return result(); }
    if (action === "find") {
      const path = remoteArgs[1];
      return result(0, ((path === staging && staged) || (path === final && directories.has(final))) ? listRelease() : "");
    }
    if (action === "cat") return result(0, files.get(remoteArgs.at(-1)) ?? local.currentSource);
    if (action === "sha256sum") {
      const path = remoteArgs.at(-1);
      const artifact = local.manifest.artifacts.find(({ name }) => path.endsWith(`/${name}`));
      return result(0, `${artifact.sha256}  ${path}\n`);
    }
    if (action === "mv") {
      directories.delete(staging); directories.add(final); return result();
    }
    if (remoteArgs.length === 1 && remoteArgs[0].startsWith("flock -x ")) {
      files.set(`${root}/current.json`, local.currentSource); files.delete(pointer); return result();
    }
    return result();
  };
  await createSshTransport({ remote: "operator@example.test", execute }).publish({
    local, remote: null, remoteRoot: root,
  });
  const rsync = calls.filter(({ command }) => command === "rsync");
  assert.equal(rsync.length, 2);
  for (const flag of ["--recursive", "--partial", "--delete"]) assert.ok(rsync[0].args.includes(flag));
  assert.ok(rsync.every(({ options }) => Number.isFinite(options.timeoutMs) && options.timeoutMs > 60_000));
  const releaseUpload = calls.indexOf(rsync[0]);
  const finalMove = calls.findIndex(({ command, args }) => command === "ssh" && args.includes(staging) && args.includes(final));
  const pointerUpload = calls.indexOf(rsync[1]);
  const commit = calls.findIndex(({ command, args }) => command === "ssh" && args.at(-1).startsWith("flock -x "));
  assert.ok(releaseUpload < finalMove && finalMove < pointerUpload && pointerUpload < commit);
  assert.match(calls[commit].args.at(-1), /exit 73.*mv -T -f/u);
});

test("CLI values and remote destinations fail closed", () => {
  for (const value of ["-oProxyCommand=x", "bad host", "user@@host"]) {
    assert.throws(() => validateSshTarget(value), /unsafe SSH target/u);
  }
  for (const value of ["/", "/srv/../tmp", "relative", "/srv/path/"]) {
    assert.throws(() => validateRemoteRoot(value), /unsafe remote release store path/u);
  }
  const result = spawnSync(process.execPath, [
    new URL("../pin/ship.mjs", import.meta.url).pathname, "ship", "--remote", "--confirm",
  ], { encoding: "utf8" });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /argument is ambiguous|requires a value/u);
});
