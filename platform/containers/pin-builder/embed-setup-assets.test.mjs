import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

async function setupFork(temporaryRoot) {
  const workspaceRoot = path.join(temporaryRoot, "fork");
  const repositoryRoot = path.join(workspaceRoot, "pin");
  const copiedScript = path.join(workspaceRoot, "platform/containers/pin-builder/embed-setup-assets.mjs");
  // Mirror the script's default input location so the default-path tests below
  // exercise the real default: the device-owned setup page checked in under the
  // runtime crate. The default used to be a browser SPA's Vite output, which is
  // why these tests assert the location and not just the packing.
  const centerOutput = path.join(repositoryRoot, "runtime/core/assets/setup-page");
  await mkdir(path.dirname(copiedScript), { recursive: true });
  await mkdir(path.join(centerOutput, "assets"), { recursive: true });
  await copyFile(path.join(scriptDir, "embed-setup-assets.mjs"), copiedScript);
  return { repositoryRoot, copiedScript, centerOutput };
}

async function writeValidCenterAssets(centerOutput) {
  await writeFile(
    path.join(centerOutput, "index.html"),
    '<script src="/setup/assets/app.js"></script>',
  );
  await writeFile(path.join(centerOutput, "assets/app.js"), "export default true;\n");
}

async function pathExists(candidatePath) {
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

test("default input uses the fork-local Setup build output", async (context) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "penumbra-setup-assets-"),
  );
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const { repositoryRoot, copiedScript, centerOutput } = await setupFork(temporaryRoot);
  await writeValidCenterAssets(centerOutput);

  await execFileAsync(process.execPath, [copiedScript], { cwd: repositoryRoot });

  const outputFile = path.join(
    repositoryRoot,
    "runtime/core/assets/setup-assets.json",
  );
  const pack = JSON.parse(await readFile(outputFile, "utf8"));
  assert.deepEqual(
    pack.assets.map(({ path: assetPath }) => assetPath),
    ["assets/app.js", "index.html"],
  );
});

test("resolves default paths relative to fork root regardless of CWD", async (context) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "penumbra-setup-assets-"),
  );
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const { repositoryRoot, copiedScript, centerOutput } = await setupFork(temporaryRoot);
  await writeValidCenterAssets(centerOutput);

  await execFileAsync(process.execPath, [copiedScript], { cwd: tmpdir() });

  const outputFile = path.join(
    repositoryRoot,
    "runtime/core/assets/setup-assets.json",
  );
  const pack = JSON.parse(await readFile(outputFile, "utf8"));
  assert.deepEqual(
    pack.assets.map(({ path: assetPath }) => assetPath),
    ["assets/app.js", "index.html"],
  );
  assert.equal(pack.schema_version, 1);
  assert.equal(pack.base_path, "/setup/");
  assert.equal(typeof pack.bundle_sha256, "string");
  assert.equal(pack.bundle_sha256.length, 64);
});

test("rejects text assets that are not valid UTF-8", async (context) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "penumbra-setup-assets-"),
  );
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const { repositoryRoot, copiedScript, centerOutput } = await setupFork(temporaryRoot);

  await writeFile(
    path.join(centerOutput, "index.html"),
    '<script src="/setup/assets/app.js"></script>',
  );
  await writeFile(
    path.join(centerOutput, "assets/app.js"),
    Buffer.from([0xff, 0xfe, 0x80, 0x81]),
  );

  await assert.rejects(
    execFileAsync(process.execPath, [copiedScript], { cwd: repositoryRoot }),
    (error) => {
      assert.ok(error.stderr.includes("not valid UTF-8") || error.stdout.includes("not valid UTF-8"),
        `Expected UTF-8 validation error, got: ${error.stderr || error.stdout}`);
      return true;
    },
  );
});

test("asset ordering is bytewise deterministic", async (context) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "penumbra-setup-assets-"),
  );
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const { repositoryRoot, copiedScript, centerOutput } = await setupFork(temporaryRoot);

  await writeFile(
    path.join(centerOutput, "index.html"),
    '<script src="/setup/assets/App.js"></script><script src="/setup/assets/beta.js"></script>',
  );
  await writeFile(path.join(centerOutput, "assets/App.js"), "// App\n");
  await writeFile(path.join(centerOutput, "assets/beta.js"), "// beta\n");

  await execFileAsync(process.execPath, [copiedScript], { cwd: repositoryRoot });

  const outputFile = path.join(
    repositoryRoot,
    "runtime/core/assets/setup-assets.json",
  );
  const pack = JSON.parse(await readFile(outputFile, "utf8"));

  assert.deepEqual(
    pack.assets.map(({ path: assetPath }) => assetPath),
    ["assets/App.js", "assets/beta.js", "index.html"],
  );
});

test("rejects input path traversal outside repository", async (context) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "penumbra-setup-assets-"),
  );
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const { repositoryRoot, copiedScript } = await setupFork(temporaryRoot);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [copiedScript, path.join(temporaryRoot, "nonexistent")],
      { cwd: repositoryRoot },
    ),
    (error) => {
      assert.ok(
        error.stderr.includes("must resolve inside repository") ||
        error.stdout.includes("must resolve inside repository"),
        `Expected containment error, got: ${error.stderr || error.stdout}`,
      );
      return true;
    },
  );
});

test("rejects symlink escape in input directory", async (context) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "penumbra-setup-assets-"),
  );
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const { repositoryRoot, copiedScript, centerOutput } = await setupFork(temporaryRoot);
  await writeValidCenterAssets(centerOutput);

  const escapeTarget = path.join(temporaryRoot, "escape-target");
  await mkdir(escapeTarget, { recursive: true });
  await writeFile(path.join(escapeTarget, "secret.txt"), "secret");

  const symlinkPath = path.join(centerOutput, "escape-link");
  await symlink(escapeTarget, symlinkPath);

  await assert.rejects(
    execFileAsync(process.execPath, [copiedScript], { cwd: repositoryRoot }),
    (error) => {
      assert.ok(
        error.stderr.includes("symlinks") || error.stdout.includes("symlinks") ||
        error.stderr.includes("must resolve inside repository") ||
        error.stdout.includes("must resolve inside repository"),
        `Expected symlink or containment error, got: ${error.stderr || error.stdout}`,
      );
      return true;
    },
  );
});

test("failure preserves existing output file", async (context) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "penumbra-setup-assets-"),
  );
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const { repositoryRoot, copiedScript, centerOutput } = await setupFork(temporaryRoot);
  await writeValidCenterAssets(centerOutput);

  await execFileAsync(process.execPath, [copiedScript], { cwd: repositoryRoot });

  const outputFile = path.join(
    repositoryRoot,
    "runtime/core/assets/setup-assets.json",
  );
  const originalContent = await readFile(outputFile);
  const originalPack = JSON.parse(originalContent.toString("utf8"));

  await writeFile(
    path.join(centerOutput, "assets/app.js"),
    Buffer.from([0xff, 0xfe, 0x80, 0x81]),
  );

  await assert.rejects(
    execFileAsync(process.execPath, [copiedScript], { cwd: repositoryRoot }),
  );

  const afterContent = await readFile(outputFile);
  const afterPack = JSON.parse(afterContent.toString("utf8"));
  assert.equal(afterPack.bundle_sha256, originalPack.bundle_sha256);
  assert.deepEqual(
    afterPack.assets.map(({ path: assetPath }) => assetPath),
    originalPack.assets.map(({ path: assetPath }) => assetPath),
  );
});

test("concurrent writers produce valid packs without temp collisions", async (context) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "penumbra-setup-assets-"),
  );
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const { repositoryRoot, copiedScript, centerOutput } = await setupFork(temporaryRoot);
  await writeValidCenterAssets(centerOutput);

  const runs = Array.from({ length: 4 }, () =>
    execFileAsync(process.execPath, [copiedScript], { cwd: repositoryRoot }),
  );
  await Promise.all(runs);

  const outputDir = path.join(repositoryRoot, "runtime/core/assets");
  const outputFile = path.join(outputDir, "setup-assets.json");

  const pack = JSON.parse(await readFile(outputFile, "utf8"));
  assert.equal(pack.schema_version, 1);
  assert.equal(pack.base_path, "/setup/");
  assert.equal(typeof pack.bundle_sha256, "string");
  assert.equal(pack.bundle_sha256.length, 64);
  assert.equal(pack.assets.length, 2);

  const remainingTempDirs = (await readdir(outputDir)).filter(
    (entry) => entry.startsWith(".setup-assets-tmp-"),
  );
  assert.equal(
    remainingTempDirs.length,
    0,
    `Leftover temporary directories: ${remainingTempDirs.join(", ")}`,
  );
});

test("signal during write causally cleans temporary directory", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "penumbra-setup-assets-"),
  );

  const { repositoryRoot, copiedScript, centerOutput } = await setupFork(temporaryRoot);
  await writeValidCenterAssets(centerOutput);

  const outputDir = path.join(repositoryRoot, "runtime/core/assets");
  const outputFile = path.join(outputDir, "setup-assets.json");
  await mkdir(outputDir, { recursive: true });

  const beforeEntries = new Set(await readdir(outputDir));

  let temporaryObserved = false;

  const { code, signal } = await new Promise((resolveExit) => {
    const child = execFile(process.execPath, [copiedScript], {
      cwd: repositoryRoot,
      env: { ...process.env, PENUMBRA_EMBED_YIELD_MS: "4000" },
    });

    const pollHandle = setInterval(async () => {
      try {
        const entries = await readdir(outputDir);
        const tempEntries = entries.filter(
          (entry) => entry.startsWith(".setup-assets-tmp-") && !beforeEntries.has(entry),
        );
        if (tempEntries.length > 0) {
          temporaryObserved = true;
          clearInterval(pollHandle);
          child.kill("SIGINT");
        }
      } catch {}
    }, 50);

    const safetyHandle = setTimeout(() => {
      clearInterval(pollHandle);
    }, 6000);

    child.on("exit", (exitCode, exitSignal) => {
      clearInterval(pollHandle);
      clearTimeout(safetyHandle);
      resolveExit({ code: exitCode, signal: exitSignal });
    });
  });

  assert.ok(temporaryObserved, "temporary directory was not observed before process exit");
  assert.ok(
    code === 130 || (code === null && signal === "SIGINT"),
    `Expected signal interruption, got code=${code}, signal=${signal}`,
  );

  await new Promise((resolveWait) => setTimeout(resolveWait, 500));

  const afterEntries = (await readdir(outputDir)).filter(
    (entry) => entry.startsWith(".setup-assets-tmp-") && !beforeEntries.has(entry),
  );
  assert.equal(
    afterEntries.length,
    0,
    `Leftover temporary directories: ${afterEntries.join(", ")}`,
  );

  const outputCreated = await pathExists(outputFile);
  assert.equal(outputCreated, false, "output file should not exist when signal interrupts before rename");

  await rm(temporaryRoot, { recursive: true, force: true });
});

// The committed pack is a generated artifact that the Rust server links with
// include_bytes!, and nothing in the build regenerates it — so this repository's
// own copy is the thing most likely to go stale. Run the real script against the
// real tree, the way tier-a-registry.test.mjs proves its generated outputs.
test("committed Setup asset pack matches its committed source", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(scriptDir, "embed-setup-assets.mjs"), "--check"],
    { cwd: scriptDir },
  );
  assert.match(stdout, /^Verified \d+ Setup assets \(\d+ bytes\) in /);
});

test("--check fails on drift and leaves the pack untouched", async (context) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "penumbra-setup-assets-"),
  );
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const { repositoryRoot, copiedScript, centerOutput } = await setupFork(temporaryRoot);
  await writeValidCenterAssets(centerOutput);

  await execFileAsync(process.execPath, [copiedScript], { cwd: repositoryRoot });

  const outputDir = path.join(repositoryRoot, "runtime/core/assets");
  const outputFile = path.join(outputDir, "setup-assets.json");

  await execFileAsync(process.execPath, [copiedScript, "--check"], { cwd: repositoryRoot });

  // Drift the pack the way a stale artifact drifts: same shape, wrong bytes.
  const drifted = JSON.parse(await readFile(outputFile, "utf8"));
  drifted.assets[0].sha256 = "0".repeat(64);
  const driftedContent = `${JSON.stringify(drifted)}\n`;
  await writeFile(outputFile, driftedContent);

  await assert.rejects(
    execFileAsync(process.execPath, [copiedScript, "--check"], { cwd: repositoryRoot }),
    (error) => {
      const output = `${error.stderr}${error.stdout}`;
      // The message reports the realpath, which on macOS differs from the
      // tmpdir path this test built, so match the pack it names, not the prefix.
      assert.match(
        output,
        /Setup asset pack drift in \S*runtime\/core\/assets\/setup-assets\.json/,
      );
      assert.ok(
        output.includes("node platform/containers/pin-builder/embed-setup-assets.mjs"),
        `Expected the regeneration command, got: ${output}`,
      );
      return true;
    },
  );

  assert.equal(
    await readFile(outputFile, "utf8"),
    driftedContent,
    "--check must not rewrite the committed pack",
  );
  const remainingTempDirs = (await readdir(outputDir)).filter(
    (entry) => entry.startsWith(".setup-assets-tmp-"),
  );
  assert.equal(
    remainingTempDirs.length,
    0,
    `Leftover temporary directories: ${remainingTempDirs.join(", ")}`,
  );
});

test("--check treats a missing pack as drift without creating it", async (context) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "penumbra-setup-assets-"),
  );
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const { repositoryRoot, copiedScript, centerOutput } = await setupFork(temporaryRoot);
  await writeValidCenterAssets(centerOutput);

  const outputDir = path.join(repositoryRoot, "runtime/core/assets");
  const outputFile = path.join(outputDir, "setup-assets.json");

  await assert.rejects(
    execFileAsync(process.execPath, [copiedScript, "--check"], { cwd: repositoryRoot }),
    (error) => {
      const output = `${error.stderr}${error.stdout}`;
      assert.ok(
        output.includes("Setup asset pack drift in"),
        `Expected drift error, got: ${output}`,
      );
      return true;
    },
  );

  assert.equal(await pathExists(outputFile), false);
});

// Without an explicit option check, a mistyped flag would be swallowed as the
// input directory argument — and a mistyped `--check` would silently write.
test("rejects unknown options instead of reading them as paths", async (context) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "penumbra-setup-assets-"),
  );
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const { repositoryRoot, copiedScript, centerOutput } = await setupFork(temporaryRoot);
  await writeValidCenterAssets(centerOutput);

  await assert.rejects(
    execFileAsync(process.execPath, [copiedScript, "--chek"], { cwd: repositoryRoot }),
    (error) => {
      const output = `${error.stderr}${error.stdout}`;
      assert.ok(
        output.includes("unknown option --chek"),
        `Expected unknown option error, got: ${output}`,
      );
      return true;
    },
  );

  assert.equal(
    await pathExists(path.join(repositoryRoot, "runtime/core/assets/setup-assets.json")),
    false,
  );
});

test("works from non-root CWD with explicit paths", async (context) => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "penumbra-setup-assets-"),
  );
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const { repositoryRoot, copiedScript, centerOutput } = await setupFork(temporaryRoot);
  await writeValidCenterAssets(centerOutput);

  const subDir = path.join(repositoryRoot, "some/nested/dir");
  await mkdir(subDir, { recursive: true });

  await execFileAsync(
    process.execPath,
    [
      copiedScript,
      centerOutput,
      path.join(repositoryRoot, "runtime/core/assets/setup-assets.json"),
    ],
    { cwd: subDir },
  );

  const outputFile = path.join(
    repositoryRoot,
    "runtime/core/assets/setup-assets.json",
  );
  const pack = JSON.parse(await readFile(outputFile, "utf8"));
  assert.equal(pack.schema_version, 1);
  assert.equal(pack.assets.length, 2);
});
