import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const VERIFIER = join(ROOT, "platform", "deploy", "vps", "verify-release.py");
const LOCAL_LIB = join(ROOT, "platform", "deploy", "vps", "lib", "local.sh");
const LOCAL_DEPLOY = join(ROOT, "platform", "deploy", "vps", "deploy.sh");
const REQUIRED = Object.freeze({
  "platform/deploy/vps/remote/common.sh": { data: "# selected common\n", mode: "0644" },
  "platform/deploy/vps/remote/deploy.sh": { data: "# selected deploy\n", mode: "0644" },
  "platform/deploy/vps/remote/preflight.sh": { data: "# selected preflight\n", mode: "0644" },
  "platform/deploy/vps/verify-release.py": { data: "# selected verifier\n", mode: "0644" },
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function manifestFor(files) {
  const entries = Object.entries(files)
    .map(([path, record]) => {
      const data = Buffer.from(record.data);
      return { path, sha256: sha256(data), size: data.length, mode: record.mode };
    })
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const payload = { schemaVersion: 1, profile: "vps", entries };
  return { ...payload, releaseId: sha256(JSON.stringify(payload)) };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    input: options.input,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function runVerifier(args) {
  return run("python3", [VERIFIER, ...args]);
}

async function writeArchive(path, records) {
  const serialized = records.map((record) => ({
    ...record,
    data: record.data === undefined ? undefined : Buffer.from(record.data).toString("base64"),
  }));
  const python = String.raw`
import base64,io,json,sys,tarfile
target=sys.argv[1]
records=json.load(sys.stdin)
with tarfile.open(target,"w:gz",format=tarfile.USTAR_FORMAT) as archive:
    for record in records:
        info=tarfile.TarInfo(record["path"])
        info.mode=int(record.get("mode","0644"),8)
        info.uid=0; info.gid=0; info.mtime=0
        kind=record.get("kind","file")
        if kind=="file":
            data=base64.b64decode(record.get("data", "")); info.size=len(data)
            archive.addfile(info,io.BytesIO(data))
        elif kind=="directory":
            info.type=tarfile.DIRTYPE; archive.addfile(info)
        elif kind=="symlink":
            info.type=tarfile.SYMTYPE; info.linkname=record.get("linkname","target"); archive.addfile(info)
        elif kind=="fifo":
            info.type=tarfile.FIFOTYPE; archive.addfile(info)
        else:
            raise SystemExit("unsupported fixture kind")
`;
  const result = run("python3", ["-c", python, path], { input: JSON.stringify(serialized) });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture(directory, { files = REQUIRED, records } = {}) {
  await mkdir(directory, { recursive: true });
  const manifest = manifestFor(files);
  const manifestPath = join(directory, `vps-${manifest.releaseId}.manifest.json`);
  const archivePath = join(directory, `vps-${manifest.releaseId}.tar.gz`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await writeArchive(
    archivePath,
    records ?? manifest.entries.map((entry) => ({
      path: entry.path,
      data: files[entry.path].data,
      mode: entry.mode,
    })),
  );
  return { archivePath, manifest, manifestPath };
}

test("remote verifier strictly binds archive, manifest, release id, and tree", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "revival-deploy-binding-"));
  try {
    const valid = await fixture(directory);
    const extracted = join(directory, "extracted");

    await t.test("accepts an exact release and atomically extracts it", () => {
      const result = runVerifier([
        "--archive", valid.archivePath,
        "--manifest", valid.manifestPath,
        "--extract", extracted,
        "--expect-release-id", valid.manifest.releaseId,
        "--json",
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: true,
        releaseId: valid.manifest.releaseId,
        profile: "vps",
        files: valid.manifest.entries.length,
      });
      const tree = runVerifier([
        "--tree", extracted,
        "--manifest", valid.manifestPath,
        "--expect-release-id", valid.manifest.releaseId,
        "--json",
      ]);
      assert.equal(tree.status, 0, tree.stderr);
    });

    await t.test("rejects a mismatched selected release id", () => {
      const result = runVerifier([
        "--archive", valid.archivePath,
        "--manifest", valid.manifestPath,
        "--expect-release-id", "0".repeat(64),
      ]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /does not match the expected release/);
    });

    await t.test("rejects schema drift even when the canonical payload digest is unchanged", async () => {
      const changed = { ...valid.manifest, unexpected: true };
      const path = join(directory, "manifest-extra-field.json");
      await writeFile(path, JSON.stringify(changed));
      const result = runVerifier(["--archive", valid.archivePath, "--manifest", path]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /fields do not match/);
    });

    await t.test("rejects path spellings that normalize to a different path", async () => {
      for (const unsafePath of ["platform//deploy.sh", "platform/./deploy.sh", "platform/../deploy.sh"]) {
        const entries = valid.manifest.entries.map((entry, index) => (
          index === 0 ? { ...entry, path: unsafePath } : entry
        ));
        const payload = { schemaVersion: 1, profile: "vps", entries };
        const changed = { ...payload, releaseId: sha256(JSON.stringify(payload)) };
        const path = join(directory, `manifest-unsafe-${sha256(unsafePath).slice(0, 8)}.json`);
        await writeFile(path, JSON.stringify(changed));
        const result = runVerifier(["--archive", valid.archivePath, "--manifest", path]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /non-canonical path/);
      }
    });

    await t.test("rejects a driver whose bytes do not match its manifest entry", async () => {
      const archivePath = join(directory, "mismatched-driver.tar.gz");
      await writeArchive(archivePath, valid.manifest.entries.map((entry) => ({
        path: entry.path,
        data: entry.path.endsWith("/deploy.sh") ? "# corrupted driver\n" : REQUIRED[entry.path].data,
        mode: entry.mode,
      })));
      const result = runVerifier(["--archive", archivePath, "--manifest", valid.manifestPath]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /size mismatch|digest mismatch/);
    });

    for (const [label, hostile] of [
      ["directory", { path: "platform", kind: "directory", mode: "0755" }],
      ["symlink", { path: valid.manifest.entries[0].path, kind: "symlink", linkname: "/tmp/escape" }],
      ["fifo", { path: valid.manifest.entries[0].path, kind: "fifo" }],
    ]) {
      await t.test(`rejects an archive ${label} member`, async () => {
        const archivePath = join(directory, `hostile-${label}.tar.gz`);
        const records = valid.manifest.entries.map((entry) => ({
          path: entry.path,
          data: REQUIRED[entry.path].data,
          mode: entry.mode,
        }));
        if (label === "directory") records.unshift(hostile);
        else records[0] = hostile;
        await writeArchive(archivePath, records);
        const result = runVerifier(["--archive", archivePath, "--manifest", valid.manifestPath]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /non-regular member/);
      });
    }

    await t.test("rejects directory, symlink, and non-regular verifier inputs", async () => {
      const manifestLink = join(directory, "manifest-link.json");
      await symlink(valid.manifestPath, manifestLink);
      let result = runVerifier(["--archive", valid.archivePath, "--manifest", manifestLink]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /manifest must be a regular file/);

      const archiveDirectory = join(directory, "archive-directory");
      await mkdir(archiveDirectory);
      result = runVerifier(["--archive", archiveDirectory, "--manifest", valid.manifestPath]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /archive must be a regular file/);

      const fifo = join(directory, "manifest-fifo");
      const fifoResult = run("mkfifo", [fifo]);
      assert.equal(fifoResult.status, 0, fifoResult.stderr);
      result = runVerifier(["--archive", valid.archivePath, "--manifest", fifo]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /manifest must be a regular file/);
    });

    await t.test("rejects hostile tree and extraction targets", async () => {
      const treeLink = join(directory, "tree-link");
      await symlink(extracted, treeLink);
      let result = runVerifier(["--tree", treeLink, "--manifest", valid.manifestPath]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /release tree must be a real directory/);

      const unexpectedDirectory = join(extracted, "unexpected-empty-directory");
      await mkdir(unexpectedDirectory);
      result = runVerifier(["--tree", extracted, "--manifest", valid.manifestPath]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unexpected or unsafe directory/);
      await rm(unexpectedDirectory, { recursive: true });

      const driver = join(extracted, "platform", "deploy", "vps", "remote", "deploy.sh");
      const driverCopy = join(directory, "driver-copy");
      await copyFile(driver, driverCopy);
      await unlink(driver);
      await symlink(driverCopy, driver);
      result = runVerifier(["--tree", extracted, "--manifest", valid.manifestPath]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unexpected or unsafe file/);

      const existingTarget = join(directory, "existing-target");
      await mkdir(existingTarget);
      result = runVerifier([
        "--archive", valid.archivePath,
        "--manifest", valid.manifestPath,
        "--extract", existingTarget,
      ]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /extraction target already exists/);
    });

    await t.test("never includes file contents in a verification failure", async () => {
      const marker = "DO_NOT_PRINT_PRIVATE_VALUE_9e65";
      const files = { ...REQUIRED, "private-marker.txt": { data: marker, mode: "0644" } };
      const marked = await fixture(join(directory, "marked"), { files });
      const archivePath = join(directory, "marked-corrupt.tar.gz");
      await writeArchive(archivePath, marked.manifest.entries.map((entry) => ({
        path: entry.path,
        data: entry.path === "private-marker.txt" ? `${marker}-changed` : files[entry.path].data,
        mode: entry.mode,
      })));
      const result = runVerifier(["--archive", archivePath, "--manifest", marked.manifestPath]);
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(marker));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local deploy driver uses only the selected release for cutover", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revival-local-binding-"));
  try {
    const valid = await fixture(directory);
    const materialized = join(directory, "selected-verifier.py");
    await writeFile(materialized, "", { mode: 0o600 });
    const extract = run("bash", [
      "-c",
      'source "$1"; materialize_release_member "$2" "$3" "$4" "$5"',
      "binding-test",
      LOCAL_LIB,
      valid.archivePath,
      valid.manifestPath,
      "platform/deploy/vps/verify-release.py",
      materialized,
    ]);
    assert.equal(extract.status, 0, extract.stderr);
    assert.equal(await readFile(materialized, "utf8"), REQUIRED["platform/deploy/vps/verify-release.py"].data);

    const contract = run("bash", [
      "-c",
      'source "$1"; assert_release_bootstrap_contract "$2" "$3"',
      "binding-test",
      LOCAL_LIB,
      valid.manifestPath,
      valid.manifest.releaseId,
    ]);
    assert.equal(contract.status, 0, contract.stderr);

    const deploySource = await readFile(LOCAL_DEPLOY, "utf8");
    const librarySource = await readFile(LOCAL_LIB, "utf8");
    assert.doesNotMatch(deploySource, /node platform\/deploy\/release\.mjs build/);
    assert.match(deploySource, /node platform\/deploy\/release\.mjs verify/);
    assert.match(deploySource, /assertLegacyProductionCompatible/);
    assert.match(deploySource, /--candidate-id/);
    assert.match(librarySource, /--partial --append-verify --protect-args/);
    assert.doesNotMatch(deploySource, /platform\/release\/package\.mjs/);
    assert.match(librarySource, /platform\/deploy\/release\.mjs/);
    assert.doesNotMatch(librarySource, /platform\/release\/package\.mjs/);
    assert.doesNotMatch(deploySource, /scp[^\n]*SCRIPT_DIR[^\n]*verify-release\.py/);
    assert.doesNotMatch(deploySource, /run_remote_impl\s+deploy\.sh/);
    assert.match(deploySource, /materialize_release_member[^\n]*RELEASE_VERIFIER_PATH/);
    assert.match(deploySource, /run_verified_release_deploy/);
    const dryRunBoundary = deploySource.indexOf("if ((dry_run))");
    const localPreflight = deploySource.indexOf("local_preflight", dryRunBoundary);
    assert.ok(dryRunBoundary >= 0 && localPreflight > dryRunBoundary);
    assert.doesNotMatch(deploySource.slice(0, localPreflight), /run_ssh|remote_preupload_gate/);
    assert.match(deploySource, /--cleanup-project-images is unavailable with --dry-run/);
    assert.match(librarySource, /cat "\$REMOTE_IMPL\/bootstrap-release\.py"/u);
    assert.match(librarySource, /run_held_bootstrap_entry platform\/deploy\/release-candidate\.mjs node/u);
    assert.match(librarySource, /run_held_bootstrap_entry platform\/deploy\/vps\/remote\/preflight\.sh bash/u);
    assert.match(librarySource, /run_held_bootstrap_entry platform\/deploy\/vps\/remote\/deploy\.sh bash/u);
    assert.match(librarySource, /os\.memfd_create\("revival-held-exec"[\s\S]*F_ADD_SEALS/u);
    assert.match(
      librarySource,
      /held-release-exec\.py[\s\S]*pass_fds=\((?:sealed|sealed_fd),/u,
    );
    const incomingRetirement = librarySource.slice(
      librarySource.indexOf("# The selected driver cannot move the workspace"),
      librarySource.indexOf('exit "$status"', librarySource.indexOf("# The selected driver cannot move the workspace")),
    );
    assert.match(incomingRetirement, /cat "\$REVIVAL_ROOT\/platform\/deploy\/candidate-store\.py"/u,
      "incoming retirement must stream the canonical candidate-store helper");
    assert.match(incomingRetirement, /retire-path --parent "\$remote_root\/incoming" --name "\$release_id"/u);
    assert.match(incomingRetirement, /\^\\\.candidate-retired-\[0-9a-f\]\{32\}\$/u,
      "the accepted cleanup result must be the exact content receipt name");
    assert.match(incomingRetirement, /\(\(status != 0\)\) \|\| status=\$cleanup_status/u,
      "cleanup must preserve a nonzero selected-driver exit status");
    assert.doesNotMatch(incomingRetirement, /ftruncate|fchmod|unlink|rmdir|rm -rf|secrets\.|token_hex/u,
      "the bootstrap must not carry a second destructive retirement implementation");
    assert.doesNotMatch(librarySource, /python3 "\$verifier" --(?:archive|tree)|exec bash "\$entry"/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
