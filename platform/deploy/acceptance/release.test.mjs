import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildRelease } from "../release.mjs";

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const TOOL = join(ROOT, "platform", "deploy", "release.mjs");

function runTool(args) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

function parseSingleJsonLine(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `expected exactly one JSON line, got ${result.stdout}`);
  return JSON.parse(lines[0]);
}

function digestManifestPayload(manifest) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: manifest.schemaVersion,
        profile: manifest.profile,
        entries: manifest.entries,
      }),
    )
    .digest("hex");
}

test("release packaging is clean, deterministic, and independently verifiable", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "ai-pin-revival-release-test-"));
  try {
    let vpsBuild;
    await t.test("vps profile emits one canonical JSON result and excludes Pin source", async () => {
      vpsBuild = parseSingleJsonLine(
        runTool(["build", "--profile", "vps", "--output", output, "--json"]),
      );
      assert.match(vpsBuild.releaseId, /^[0-9a-f]{64}$/);
      assert.equal(isAbsolute(vpsBuild.archivePath), true);
      assert.equal(isAbsolute(vpsBuild.manifestPath), true);
      assert.equal(basename(vpsBuild.archivePath), `vps-${vpsBuild.releaseId}.tar.gz`);
      assert.equal(
        basename(vpsBuild.manifestPath),
        `vps-${vpsBuild.releaseId}.manifest.json`,
      );

      const manifest = JSON.parse(await readFile(vpsBuild.manifestPath, "utf8"));
      assert.deepEqual(Object.keys(manifest), [
        "schemaVersion",
        "profile",
        "releaseId",
        "entries",
      ]);
      assert.equal(manifest.schemaVersion, 1);
      assert.equal(manifest.profile, "vps");
      assert.equal(manifest.releaseId, digestManifestPayload(manifest));
      assert.ok(manifest.entries.length > 20);
      assert.deepEqual(
        manifest.entries.map((entry) => entry.path),
        manifest.entries.map((entry) => entry.path).toSorted((a, b) => a.localeCompare(b, "en")),
      );
      assert.ok(manifest.entries.some((entry) => entry.path === "compose.yaml"));
      assert.ok(manifest.entries.some((entry) => entry.path === "platform/deploy/release.json"));
      assert.ok(manifest.entries.some((entry) => entry.path === "cosmos/search/settings.yml"));
      assert.ok(manifest.entries.some((entry) => entry.path === "platform/deploy/release.mjs"));
      assert.equal(
        manifest.entries.find((entry) => entry.path === "revival")?.mode,
        "0755",
        "ordinary executable scripts must remain packageable and executable",
      );
      assert.ok(manifest.entries.some((entry) => entry.path.startsWith("center/")));
      assert.ok(manifest.entries.some((entry) => entry.path.startsWith("cosmos/")));
      // No `pin/` source at all. The VPS release used to contain `pin/setup`,
      // the browser-only Setup SPA, because that was the one part of `pin/`
      // a server could legitimately serve. The console is part of Center now
      // (`center/src/app/settings/pin`, `center/src/lib/pin-install`), so the
      // exception has no subject left and the rule collapses to the simpler
      // one it always meant: privileged device source never reaches the VPS.
      assert.deepEqual(
        manifest.entries.filter((entry) => entry.path.startsWith("pin/")).map((entry) => entry.path),
        [],
        "the VPS release must contain no Pin source",
      );
      assert.equal(
        manifest.entries.some((entry) => entry.path.startsWith("platform/containers/pin-builder/")),
        false,
      );
      assert.equal(
        manifest.entries.some((entry) => entry.path.startsWith("platform/deploy/acceptance/pin/")),
        false,
      );
      for (const entry of manifest.entries) {
        assert.deepEqual(Object.keys(entry), ["path", "sha256", "size", "mode"]);
        assert.match(entry.sha256, /^[0-9a-f]{64}$/);
        assert.match(entry.mode, /^(?:0644|0755)$/);
        assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0);
        assert.doesNotMatch(
          entry.path,
          /(?:^|\/)(?:private|state|\.git|target|node_modules|\.next|build|\.gradle)(?:\/|$)/,
        );
      }
    });

    await t.test("verify checks the archive, manifest, extraction, hashes, and modes", () => {
      const verified = parseSingleJsonLine(
        runTool([
          "verify",
          "--archive",
          vpsBuild.archivePath,
          "--manifest",
          vpsBuild.manifestPath,
          "--json",
        ]),
      );
      assert.deepEqual(verified, {
        ok: true,
        releaseId: vpsBuild.releaseId,
        profile: "vps",
        files: verified.files,
      });
      assert.ok(verified.files > 20);
    });

    await t.test("verify rejects a corrupted archive", async () => {
      const corruptPath = join(output, "corrupt.tar.gz");
      const corruptArchive = Buffer.from(await readFile(vpsBuild.archivePath));
      corruptArchive[Math.floor(corruptArchive.length / 2)] ^= 0xff;
      await writeFile(corruptPath, corruptArchive, { flag: "wx", mode: 0o600 });
      const result = runTool([
        "verify",
        "--archive",
        corruptPath,
        "--manifest",
        vpsBuild.manifestPath,
        "--json",
      ]);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /cannot decompress|mismatch|invalid|truncated/);
    });

    await t.test("the same source produces byte-identical release artifacts", async () => {
      const fixtureRoot = await mkdtemp(join(tmpdir(), "ai-pin-revival-determinism-"));
      try {
        const fixtureOutput = join(output, "determinism");
        await mkdir(join(fixtureRoot, "platform", "deploy"), { recursive: true });
        await writeFile(join(fixtureRoot, "README.md"), "deterministic fixture\n");
        await writeFile(
          join(fixtureRoot, "platform", "deploy", "release.json"),
          `${JSON.stringify({
            schemaVersion: 1,
            profiles: { fixture: { include: ["README.md"] } },
            ignoredDirectoryNames: [
              ".git",
              ".gradle",
              ".next",
              "build",
              "node_modules",
              "target",
            ],
            ignoredFileNames: [".DS_Store"],
            ignoredExtensions: [".pyc"],
            forbiddenRootDirectories: ["private", "state", "releases", "backups"],
            forbiddenDirectoryNames: ["firmware", "packet-captures"],
            forbiddenExtensions: [".apk", ".key", ".pcap"],
          })}\n`,
        );
        const first = await buildRelease({
          profile: "fixture",
          outputDirectory: fixtureOutput,
          root: fixtureRoot,
        });
        const firstArchiveDigest = createHash("sha256")
          .update(await readFile(first.archivePath))
          .digest("hex");
        const firstManifest = await readFile(first.manifestPath, "utf8");
        const rebuilt = await buildRelease({
          profile: "fixture",
          outputDirectory: fixtureOutput,
          root: fixtureRoot,
        });
        assert.equal(rebuilt.releaseId, first.releaseId);
        assert.equal(rebuilt.archivePath, first.archivePath);
        assert.equal(rebuilt.manifestPath, first.manifestPath);
        assert.equal(
          createHash("sha256").update(await readFile(rebuilt.archivePath)).digest("hex"),
          firstArchiveDigest,
        );
        assert.equal(await readFile(rebuilt.manifestPath, "utf8"), firstManifest);
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    });

    await t.test("source profile includes clean Pin source", async () => {
      const sourceBuild = parseSingleJsonLine(
        runTool(["build", "--profile", "source", "--output", output, "--json"]),
      );
      const manifest = JSON.parse(await readFile(sourceBuild.manifestPath, "utf8"));
      assert.equal(manifest.profile, "source");
      assert.ok(manifest.entries.some((entry) => entry.path.startsWith("pin/")));
      for (const requiredToolchainPath of [
        "platform/containers/pin-builder/Dockerfile",
        "platform/containers/pin-builder/entrypoint.sh",
        "platform/containers/pin-builder/tier-a-registry.mjs",
      ]) {
        assert.ok(
          manifest.entries.some((entry) => entry.path === requiredToolchainPath),
          `${requiredToolchainPath} must be present in the clean source release`,
        );
      }
      const externalTierAEvidence =
        "pin/contracts/tier-a/external-operational-marker-evidence.tsv";
      assert.equal(
        manifest.entries.some((entry) => entry.path === externalTierAEvidence),
        false,
        `${externalTierAEvidence} must remain outside the clean source release`,
      );
      // Generated output must never reach a source release. The names here are
      // the ones release.json ignores; `dist-setup` used to be among them and
      // went with the Vite SPA that produced it.
      assert.equal(
        manifest.entries.some((entry) =>
          /(?:^|\/)(?:node_modules|target|build|\.gradle)(?:\/|$)/.test(entry.path),
        ),
        false,
      );
      const operatorSpecificFiles = [
        "pin/hook/payload/src/test/kotlin/com/penumbraos/hook/ChannelFactoryBypassTest.kt",
      ];
      for (const operatorSpecificPath of operatorSpecificFiles) {
        const source = await readFile(join(ROOT, operatorSpecificPath), "utf8");
        for (const match of source.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
          const octets = match[0].split(".").map(Number);
          if (octets.some((octet) => octet > 255)) continue;
          const [first, second, third] = octets;
          const isNonPublic =
            first === 0 ||
            first === 10 ||
            first === 127 ||
            (first === 100 && second >= 64 && second <= 127) ||
            (first === 169 && second === 254) ||
            (first === 172 && second >= 16 && second <= 31) ||
            (first === 192 && second === 168) ||
            (first === 192 && second === 0 && third === 2) ||
            (first === 198 && second === 51 && third === 100) ||
            (first === 203 && second === 0 && third === 113) ||
            first >= 224;
          assert.equal(
            isNonPublic,
            true,
            `machine-local public IPv4 literal found in ${operatorSpecificPath}`,
          );
        }
      }
      const releaseSource = JSON.parse(
        await readFile(join(ROOT, "platform", "deploy", "release.json"), "utf8"),
      );
      assert.ok(releaseSource.forbiddenDirectoryNames.includes("release-assets"));
      for (const extension of [".so", ".tflite", ".onnx", ".bin", ".dll", ".dylib"]) {
        assert.ok(
          releaseSource.forbiddenExtensions.includes(extension),
          `${extension} must remain forbidden`,
        );
      }
    });

    await t.test("profile exclusions must stay inside an included source boundary", async () => {
      const fixtureRoot = await mkdtemp(join(tmpdir(), "ai-pin-revival-exclusion-boundary-"));
      try {
        const fixtureOutput = join(output, "exclusion-boundary");
        await mkdir(join(fixtureRoot, "platform", "deploy"), { recursive: true });
        await writeFile(join(fixtureRoot, "README.md"), "fixture\n");
        await writeFile(
          join(fixtureRoot, "platform", "deploy", "release.json"),
          `${JSON.stringify({
            schemaVersion: 1,
            profiles: {
              fixture: {
                include: ["README.md"],
                exclude: ["operator-evidence"],
              },
            },
            ignoredDirectoryNames: [],
            ignoredFileNames: [],
            ignoredExtensions: [],
            forbiddenRootDirectories: [],
            forbiddenDirectoryNames: [],
            forbiddenExtensions: [],
          })}\n`,
        );
        await assert.rejects(
          buildRelease({
            profile: "fixture",
            outputDirectory: fixtureOutput,
            root: fixtureRoot,
          }),
          /exclude entry is not beneath an included path/,
        );
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    });

    await t.test("native and model binaries in an allowed path abort packaging", async () => {
      const fixture = join(ROOT, "platform", "deploy", "acceptance", `.release-native-fixture-${randomUUID()}.so`);
      try {
        await writeFile(fixture, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), {
          flag: "wx",
          mode: 0o600,
        });
        const result = runTool(["build", "--profile", "vps", "--output", output, "--json"]);
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /forbidden artifact type in release source/);
      } finally {
        await rm(fixture, { force: true });
      }
    });

    await t.test("release-assets directories abort source packaging", async () => {
      const fixtureRoot = join(ROOT, "pin", `.release-assets-fixture-${randomUUID()}`);
      const releaseAssets = join(fixtureRoot, "release-assets");
      try {
        await mkdir(releaseAssets, { recursive: true });
        await writeFile(join(releaseAssets, "operator-extracted-artifact.txt"), "not distributable\n", {
          flag: "wx",
          mode: 0o600,
        });
        const result = runTool([
          "build",
          "--profile",
          "source",
          "--output",
          output,
          "--json",
        ]);
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /proprietary or private directory found.*release-assets/);
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    });

    await t.test("nested secret and runtime-state directories abort packaging", async () => {
      const fixtureRoot = join(ROOT, "platform", "deploy", "acceptance", `.release-private-fixture-${randomUUID()}`);
      try {
        await mkdir(join(fixtureRoot, "secrets"), { recursive: true });
        await writeFile(join(fixtureRoot, "secrets", "token.txt"), "synthetic-test-value\n", {
          flag: "wx",
          mode: 0o600,
        });
        const result = runTool(["build", "--profile", "vps", "--output", output, "--json"]);
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /proprietary or private directory found.*secrets/);
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    });

    await t.test("output directories inside the source tree are rejected before creation", async () => {
      const nestedOutput = join(ROOT, "docs", `.release-output-fixture-${randomUUID()}`);
      try {
        const result = runTool([
          "build",
          "--profile",
          "vps",
          "--output",
          nestedOutput,
          "--json",
        ]);
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /release output must be outside the source root/);
        await assert.rejects(lstat(nestedOutput), { code: "ENOENT" });
      } finally {
        await rm(nestedOutput, { recursive: true, force: true });
      }
    });

    await t.test("Python bytecode and cache directories are excluded", async () => {
      const suffix = randomUUID();
      const cacheDirectory = join(ROOT, "platform", "deploy", "acceptance", "__pycache__");
      const cachedFile = join(cacheDirectory, `fixture-${suffix}.pyc`);
      const directFile = join(ROOT, "platform", "deploy", "acceptance", `.release-fixture-${suffix}.pyc`);
      try {
        await mkdir(cacheDirectory, { recursive: true });
        await writeFile(cachedFile, Buffer.from([0x42, 0x0d, 0x0d, 0x0a]), { flag: "wx" });
        await writeFile(directFile, Buffer.from([0x42, 0x0d, 0x0d, 0x0a]), { flag: "wx" });
        const build = parseSingleJsonLine(
          runTool(["build", "--profile", "vps", "--output", output, "--json"]),
        );
        const manifest = JSON.parse(await readFile(build.manifestPath, "utf8"));
        assert.equal(
          manifest.entries.some(
            (entry) => entry.path.includes("/__pycache__/") || entry.path.endsWith(".pyc"),
          ),
          false,
        );
      } finally {
        await rm(directFile, { force: true });
        await rm(cacheDirectory, { recursive: true, force: true });
      }
    });

    await t.test("an allowed-path high-confidence secret aborts before JSON output", async () => {
      const fixture = join(ROOT, "platform", "deploy", "acceptance", `.release-secret-fixture-${randomUUID()}.txt`);
      const fakeAccessKey = "AKIA" + "ABCDEFGHIJKLMNOP";
      try {
        await writeFile(fixture, `AWS_ACCESS_KEY_ID=${fakeAccessKey}\n`, { flag: "wx", mode: 0o600 });
        const result = runTool(["build", "--profile", "vps", "--output", output, "--json"]);
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /AWS access key detected in release source/);
      } finally {
        await rm(fixture, { force: true });
      }
    });

    await t.test("an allowed-path symbolic link is rejected without following it", async () => {
      const fixture = join(ROOT, "platform", "deploy", "acceptance", `.release-symlink-fixture-${randomUUID()}`);
      try {
        await symlink("release.mjs", fixture);
        const result = runTool(["build", "--profile", "vps", "--output", output, "--json"]);
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /symbolic links are forbidden/);
      } finally {
        await rm(fixture, { force: true });
      }
    });

    await t.test("source policy is location-independent through a symlinked temp path", () => {
      const result = spawnSync("sh", [join(ROOT, "platform", "deploy", "acceptance", "source-policy.sh")], {
        cwd: tmpdir(),
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, "source policy: ok\n");
    });
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
