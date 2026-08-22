import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  APPROVED_CANONICAL_PRODUCTION_PATHS,
  buildRelease,
  cleanupOwnedPublication,
  containsEncodedPrivateKey,
  findUnapprovedMachinePath,
  isEncryptedPkcs8Der,
  isPrivateKeyFileName,
} from "../release.mjs";

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const TOOL = join(ROOT, "platform", "deploy", "release.mjs");

function runTool(args, { env = process.env } = {}) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT,
    env,
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

function runtimeJoin(parts, separator) {
  return parts.join(separator);
}

async function withTinyReleaseFixture(callback) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ai-pin-release-policy-source-"));
  const fixtureOutput = await mkdtemp(join(tmpdir(), "ai-pin-release-policy-output-"));
  try {
    const payload = join(fixtureRoot, "payload");
    await mkdir(join(fixtureRoot, "platform", "deploy"), { recursive: true });
    await mkdir(payload);
    const config = JSON.parse(
      await readFile(join(ROOT, "platform", "deploy", "release.json"), "utf8"),
    );
    config.profiles = { fixture: { include: ["payload"] } };
    await writeFile(
      join(fixtureRoot, "platform", "deploy", "release.json"),
      `${JSON.stringify(config)}\n`,
    );
    return await callback({ fixtureRoot, fixtureOutput, payload });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(fixtureOutput, { recursive: true, force: true });
  }
}

async function buildTinyFixture(paths) {
  return withTinyReleaseFixture(async ({ fixtureRoot, fixtureOutput, payload }) => {
    for (const [relativePath, value] of paths) {
      const destination = join(payload, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, value, { mode: 0o600 });
    }
    return buildRelease({
      profile: "fixture",
      outputDirectory: fixtureOutput,
      root: fixtureRoot,
    });
  });
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

    await t.test("canonical server paths package under the production HOME without exempting arbitrary home paths", async () => {
      const slash = String.fromCodePoint(47);
      const productionHome = ["", "home", "anders"].join(slash);
      assert.equal(
        APPROVED_CANONICAL_PRODUCTION_PATHS.find((entry) => entry.path === productionHome)
          ?.descendants,
        false,
        "the account home may be used only as one exact filesystem probe",
      );
      const approvedRemote = [productionHome, "ai-pin-revival", "private", "attest"].join("/");
      assert.equal(findUnapprovedMachinePath(approvedRemote, productionHome), null);

      const arbitrary = [
        [productionHome, ".ssh", "id_ed25519"].join("/"),
        [productionHome, "Developer", "local-checkout"].join("/"),
        [productionHome, "secrets", "token"].join("/"),
        [productionHome, "ai-pin-revival", "..", ".ssh", "id_ed25519"].join("/"),
        `/prefix${productionHome}/ai-pin-revival/private/attest`,
        `${productionHome}en/ai-pin-revival`,
        `${approvedRemote}:/../../.ssh/id_ed25519`,
        `${approvedRemote} /../../.ssh/id_ed25519`,
        `${approvedRemote}@/../../.ssh/id_ed25519`,
        `${approvedRemote}=/../../.ssh/id_ed25519`,
        `${approvedRemote}%2f..%2f..%2f.ssh%2fid_ed25519`,
        `'${approvedRemote}'"/../../.ssh/id_ed25519"`,
        `${approvedRemote}#/../../.ssh/id_ed25519`,
        `${approvedRemote}?/../../.ssh/id_ed25519`,
        `${approvedRemote}!/../../.ssh/id_ed25519`,
        `${approvedRemote};/../../.ssh/id_ed25519`,
        `${approvedRemote}|/../../.ssh/id_ed25519`,
        `${approvedRemote}☃/../../.ssh/id_ed25519`,
        `"${approvedRemote}"+"/../.ssh/id_ed25519"`,
        `${approvedRemote}\\x2f..\\x2f.ssh\\x2fid_ed25519`,
        `${productionHome}/.cloudflared/arbitrary-operator-secret.json`,
        `${approvedRemote}#evil`,
        `${approvedRemote}?evil`,
        `${approvedRemote}!evil`,
        `${approvedRemote};evil`,
        `${approvedRemote}|evil`,
        `${approvedRemote}☃evil`,
        `"${approvedRemote}"+"-evil"`,
        `${approvedRemote}\\x23evil`,
        `${productionHome}/.cloudflared/config.yml\\u002ebak`,
        `${productionHome}/.cloudflared/config.yml#copy`,
      ];
      for (const machinePath of arbitrary) {
        assert.equal(findUnapprovedMachinePath(machinePath, productionHome), productionHome);
      }
      const quote = String.fromCodePoint(34);
      const sourceLineContinuation = `${String.fromCodePoint(92)}\n`;
      for (const encodedHome of [
        runtimeJoin(["%2F", "home", "%2F", "alice", "%2F", "secret"], ""),
        runtimeJoin(["\\x2f", "home", "\\x2f", "jozias", "\\x2f", "secret"], ""),
        runtimeJoin(["\\u002f", "Users", "\\u002f", "alice", "\\u002f", "secret"], ""),
        runtimeJoin([quote, runtimeJoin(["", "Users", "al"], "/"), quote, " + ", quote, "ice/secret", quote], ""),
        runtimeJoin([quote, runtimeJoin(["", "home", "an"], "/"), quote, " + ", sourceLineContinuation,
          quote, "ders/.ssh/id_ed25519", quote], ""),
      ]) {
        assert.notEqual(findUnapprovedMachinePath(encodedHome), null, encodedHome);
      }
      const homeHead = `${slash}ho`;
      const homeTail = ["me", "alice", "secret"].join(slash);
      const homeChild = `${slash}${["alice", "secret"].join(slash)}`;
      const templateReference = ["$", "{root}"].join("");
      const staticPolicyCases = [
        ["JavaScript split token", `const p = ${JSON.stringify(`${slash}ho`)} /* split */ + ${JSON.stringify("me/alice/secret")};`],
        ["JavaScript concat method", ["const p = ", JSON.stringify(homeHead), ".concat(\"me\", ", JSON.stringify(homeChild), ");"].join("")],
        ["JavaScript array join", ["const p = [", JSON.stringify(homeHead), ", \"me\", ", JSON.stringify(homeChild), "].join(\"\");"].join("")],
        ["JavaScript static template binding", ["const root = ", JSON.stringify(homeHead), "; const p = `", templateReference, homeTail, "`;"].join("")],
        ["JavaScript static template expression", ["const p = `${", JSON.stringify(homeHead), "}", homeTail, "`;"].join("")],
        ["shell adjacent literals", `P=${JSON.stringify(`${slash}ho`)}'me/alice/secret'`],
        ["shell multiline literals", `P='${slash}ho'${String.fromCodePoint(92)}\n'me/alice/secret'`],
        ["Rust concat macro", `const P: &str = concat!(${JSON.stringify(slash)}, "home", "/", "alice", "/secret");`],
        ["comment-split bare token", `${slash}ho/* split */me/alice/secret`],
        ["octal slash", runtimeJoin(["\\057", "home", "\\057", "alice", "\\057", "secret"], "")],
        ["five-level percent encoding", runtimeJoin(["%25252525252F", "home", "%25252525252F", "alice"], "")],
        ["Unicode Linux home", [slash, "home", "用户", "secret"].join(slash)],
        ["Unicode macOS home", [slash, "Users", "Åsa", "secret"].join(slash)],
        ["Windows backslash home", ["C:", "Users", "Alice", "secret"].join(String.fromCodePoint(92))],
        ["Windows slash home", ["C:", "Users", "Alice", "secret"].join(slash)],
        ["path.join traversal", `path.join(${JSON.stringify(`${slash}home`)}, "anders", "ai-pin-revival", "..", ".ssh")`],
        ["separator traversal", `${JSON.stringify(approvedRemote)} + path.sep + ".." + path.sep + ".ssh"`],
      ];
      for (const [label, source] of staticPolicyCases) {
        assert.notEqual(findUnapprovedMachinePath(source, productionHome), null, label);
      }
      assert.throws(
        () => findUnapprovedMachinePath(`%${"25".repeat(20)}2Fhome%${"25".repeat(20)}2Falice`),
        /normalization did not reach a fixed point/u,
      );
      assert.equal(
        findUnapprovedMachinePath(
          `path.join(${JSON.stringify(`${slash}home`)}, "anders", "ai-pin-revival", "private", "attest")`,
          productionHome,
        ),
        null,
        "a statically joined canonical path remains approved",
      );
      const legacyCarryCenter = ["", "home", "anders", "carry-center-data"].join(slash);
      assert.equal(
        findUnapprovedMachinePath(JSON.stringify(legacyCarryCenter), productionHome),
        null,
        "the exact legacy Carry Center data root remains an immutable production contract",
      );
      assert.equal(
        findUnapprovedMachinePath(JSON.stringify(`${legacyCarryCenter}/releases`), productionHome),
        null,
        "the legacy Carry Center operational data root permits real descendants",
      );
      for (const nearNeighbor of [
        `${legacyCarryCenter}-copy`,
        ["", "home", "anders", "carry-center"].join(slash),
        ["", "home", "anders", "carry-center-database"].join(slash),
      ]) {
        assert.notEqual(
          findUnapprovedMachinePath(JSON.stringify(nearNeighbor), productionHome),
          null,
          `legacy Carry approval must reject ${nearNeighbor}`,
        );
      }
      assert.equal(
        findUnapprovedMachinePath(`${approvedRemote}:/etc/cosmos-attest/ca.crt:ro`, productionHome),
        null,
        "a normal Compose source:destination mount is not traversal",
      );
      assert.equal(
        findUnapprovedMachinePath(
          `${productionHome}/.cloudflared/11111111-2222-3333-4444-555555555555.json`,
          productionHome,
        ),
        null,
      );
      assert.equal(
        findUnapprovedMachinePath(`${productionHome}/.cloudflared/config.yml`, productionHome),
        null,
      );
      assert.equal(
        findUnapprovedMachinePath(
          `const canonical = "${approvedRemote}"; const unrelated = "..";`,
          productionHome,
        ),
        null,
        "an unrelated same-line parent token must not taint an approved path",
      );

      await assert.rejects(
        buildTinyFixture([[
          "encoded-path.txt",
          `${runtimeJoin(["%2F", "Users", "%2F", "alice", "%2F", "secret"], "")}\n`,
        ]]),
        /machine-local path found in release source/u,
      );
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
        const firstOutput = join(output, "determinism-first");
        const secondOutput = join(output, "determinism-second");
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
          outputDirectory: firstOutput,
          root: fixtureRoot,
        });
        const firstArchiveDigest = createHash("sha256")
          .update(await readFile(first.archivePath))
          .digest("hex");
        const firstManifest = await readFile(first.manifestPath, "utf8");
        const rebuilt = await buildRelease({
          profile: "fixture",
          outputDirectory: secondOutput,
          root: fixtureRoot,
        });
        assert.equal(rebuilt.releaseId, first.releaseId);
        assert.equal(basename(rebuilt.archivePath), basename(first.archivePath));
        assert.equal(basename(rebuilt.manifestPath), basename(first.manifestPath));
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
      await assert.rejects(
        buildTinyFixture([["native.so", Buffer.from([0x7f, 0x45, 0x4c, 0x46])]]),
        /forbidden artifact type in release source/,
      );
    });

    await t.test("release-assets directories abort source packaging", async () => {
      await assert.rejects(
        buildTinyFixture([["release-assets/operator-extracted-artifact.txt", "not distributable\n"]]),
        /proprietary or private directory found.*release-assets/,
      );
    });

    await t.test("nested secret and runtime-state directories abort packaging", async () => {
      await assert.rejects(
        buildTinyFixture([["nested/secrets/token.txt", "synthetic-test-value\n"]]),
        /proprietary or private directory found.*secrets/,
      );
    });

    await t.test("policy mutations fail at the actual package boundary", async () => {
      const slash = String.fromCodePoint(47);
      const githubPrefix = String.fromCodePoint(103, 104, 112, 95);
      const homeHead = `${slash}ho`;
      const homeTail = ["me", "alice", "secret"].join(slash);
      const homeChild = `${slash}${["alice", "secret"].join(slash)}`;
      const templateReference = ["$", "{root}"].join("");
      const boundHomeHead = String.fromCodePoint(47, 104, 111);
      const boundHomeRoot = String.fromCodePoint(47, 104, 111, 109, 101);
      const boundHomeTail = String.fromCodePoint(
        109, 101, 47, 97, 108, 105, 99, 101, 47, 115, 101, 99, 114, 101, 116,
      );
      const boundHomeChild = String.fromCodePoint(
        97, 108, 105, 99, 101, 47, 115, 101, 99, 114, 101, 116,
      );
      const bindingFlood = Array.from({ length: 1025 }, (_unused, index) =>
        `value${index}='';`).join("");
      const staticCases = [
        ["concat-path.mjs", ["const p = ", JSON.stringify(homeHead), ".concat(\"me\", ", JSON.stringify(homeChild), ");\n"].join(""), /machine-local path/u],
        ["join-path.mjs", ["const p = [", JSON.stringify(homeHead), ", \"me\", ", JSON.stringify(homeChild), "].join(\"\");\n"].join(""), /machine-local path/u],
        ["template-path.mjs", ["const root = ", JSON.stringify(homeHead), "; const p = `", templateReference, homeTail, "`;\n"].join(""), /machine-local path/u],
        ["concat-secret.mjs", `const token = ${JSON.stringify(githubPrefix.slice(0, 2))}.concat(${JSON.stringify(githubPrefix.slice(2))}, ${JSON.stringify("a".repeat(36))});\n`, /GitHub access token/u],
        ["bound-array-join.mjs", ["const sep = \"\"; const p = [", JSON.stringify(boundHomeHead), ", ", JSON.stringify(boundHomeTail), "].join(sep);\n"].join(""), /machine-local path/u],
        ["bound-concat.mjs", ["const a = ", JSON.stringify(boundHomeHead), "; const b = ", JSON.stringify("me/alice"), "; const p = a.concat(b, \"/secret\");\n"].join(""), /machine-local path/u],
        ["bound-path-join.mjs", ["const root = ", JSON.stringify(boundHomeRoot), "; const child = ", JSON.stringify(boundHomeChild), "; const p = path.join(root, child);\n"].join(""), /machine-local path/u],
        ["bound-secret-concat.mjs", ["const prefix = ", JSON.stringify(githubPrefix), "; const body = ", JSON.stringify("a".repeat(36)), "; const token = prefix.concat(body);\n"].join(""), /GitHub access token/u],
        ["binding-cap.mjs", bindingFlood, /source static evaluator binding limit exceeded/u],
        ["nonfixed-path.txt", `%${"25".repeat(20)}2Fhome%${"25".repeat(20)}2Falice\n`, /normalization did not reach a fixed point/u],
      ];
      for (const [name, source, expected] of staticCases) {
        await assert.rejects(buildTinyFixture([[name, source]]), expected, name);
      }

      for (const directory of [".secrets", "Secrets", "...SECRETS..."]) {
        await assert.rejects(
          buildTinyFixture([[`${directory}/value.txt`, "synthetic\n"]]),
          /proprietary or private directory/u,
          directory,
        );
      }

      const binaryPath = Buffer.concat([
        Buffer.from([0, 255, 0]),
        Buffer.from([slash, "Users", "binary-user", "secret"].join(slash), "ascii"),
      ]);
      await assert.rejects(
        buildTinyFixture([["binary-path.dat", binaryPath]]),
        /machine-local path/u,
      );
      const binarySecret = Buffer.concat([
        Buffer.from([0, 255, 0]),
        Buffer.from(`${githubPrefix}${"a".repeat(36)}`, "ascii"),
      ]);
      await assert.rejects(
        buildTinyFixture([["binary-secret.dat", binarySecret]]),
        /GitHub access token/u,
      );

      for (const name of [
        "channel-key.json",
        "channel.keys.json",
        "channel_store.json",
        "wearer-channel.json",
        "key.material.json",
        ".cosmos-channel-key.json.123.tmp",
        "ai-bus-keymaterial.json.swap",
      ]) {
        await assert.rejects(
          buildTinyFixture([[name, "LIVE_SNAPSHOT_CONTENT_MUST_NOT_BE_ECHOED\n"]]),
          (error) => {
            assert.match(error.message, /live channel\/key-material snapshot filename/u);
            assert.doesNotMatch(error.message, /LIVE_SNAPSHOT_CONTENT_MUST_NOT_BE_ECHOED/u);
            return true;
          },
          name,
        );
      }

      const channelKey = Buffer.alloc(16, 7).toString("base64");
      const centerStore = {
        kid: "U:reviewer/center/ephemeral",
        key: channelKey,
        keys: { "U:reviewer/center/ephemeral": channelKey },
      };
      const cosmosStore = {
        wrapping_private_key: null,
        channel_keys: { "reviewer-kid": channelKey },
      };
      for (const [name, store] of [
        ["innocuous-center-fixture.json", centerStore],
        ["innocuous-cosmos-fixture.json", cosmosStore],
      ]) {
        await assert.rejects(
          buildTinyFixture([[name, `${JSON.stringify(store)}\n`]]),
          (error) => {
            assert.match(error.message, /live channel\/key-material snapshot content/u);
            assert.doesNotMatch(error.message, /reviewer-kid|BwcHBw/u);
            return true;
          },
          name,
        );
      }
      await buildTinyFixture([["store-lookalike.json", JSON.stringify({
        kid: "U:reviewer/center/ephemeral",
        key: "public-metadata-not-a-channel-key",
      })]]);
    });

    await t.test("ignored top-level private and state roots abort before packaging", async () => {
      for (const boundary of ["private", "state"]) {
        await withTinyReleaseFixture(async ({ fixtureRoot, fixtureOutput }) => {
          await mkdir(join(fixtureRoot, boundary));
          await assert.rejects(
            buildRelease({ profile: "fixture", outputDirectory: fixtureOutput, root: fixtureRoot }),
            /forbidden top-level private\/state boundary/u,
          );
        });
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
      await withTinyReleaseFixture(async ({ fixtureRoot, fixtureOutput, payload }) => {
        await mkdir(join(payload, "__pycache__"));
        await writeFile(join(payload, "__pycache__", "cached.pyc"), Buffer.from([0x42]));
        await writeFile(join(payload, "direct.pyc"), Buffer.from([0x42]));
        await writeFile(join(payload, "kept.txt"), "kept\n");
        const build = await buildRelease({
          profile: "fixture",
          outputDirectory: fixtureOutput,
          root: fixtureRoot,
        });
        const manifest = JSON.parse(await readFile(build.manifestPath, "utf8"));
        assert.equal(
          manifest.entries.some(
            (entry) => entry.path.includes("/__pycache__/") || entry.path.endsWith(".pyc"),
          ),
          false,
        );
        assert.ok(manifest.entries.some((entry) => entry.path === "payload/kept.txt"));
      });
    });

    await t.test("an allowed-path high-confidence secret aborts before JSON output", async () => {
      const fakeAccessKey = String.fromCodePoint(65, 75, 73, 65) + "ABCDEFGHIJKLMNOP";
      await assert.rejects(
        buildTinyFixture([["secret.txt", `AWS_ACCESS_KEY_ID=${fakeAccessKey}\n`]]),
        /AWS access key detected in release source/,
      );
    });

    await t.test("private-key detector covers persisted formats without rejecting public material", async () => {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 1024,
        privateKeyEncoding: { format: "der", type: "pkcs8" },
        publicKeyEncoding: { format: "der", type: "spki" },
      });
      const { privateKey: pkcs1PrivateKey } = generateKeyPairSync("rsa", {
        modulusLength: 1024,
        privateKeyEncoding: { format: "der", type: "pkcs1" },
        publicKeyEncoding: { format: "der", type: "spki" },
      });
      const { privateKey: sec1PrivateKey } = generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
        privateKeyEncoding: { format: "der", type: "sec1" },
        publicKeyEncoding: { format: "der", type: "spki" },
      });
      const { privateKey: ed25519PrivateKey, publicKey: ed25519PublicKey } =
        generateKeyPairSync("ed25519", {
          privateKeyEncoding: { format: "der", type: "pkcs8" },
          publicKeyEncoding: { format: "der", type: "spki" },
        });
      const jwkPair = generateKeyPairSync("rsa", { modulusLength: 1024 });
      const privateJwk = jwkPair.privateKey.export({ format: "jwk" });
      const publicJwk = jwkPair.publicKey.export({ format: "jwk" });
      const encryptedDer = jwkPair.privateKey.export({
        format: "der",
        type: "pkcs8",
        cipher: "aes-256-cbc",
        passphrase: "runtime-only-policy-fixture",
      });
      const encryptedPem = jwkPair.privateKey.export({
        format: "pem",
        type: "pkcs8",
        cipher: "aes-256-cbc",
        passphrase: "runtime-only-policy-fixture",
      });
      const privateBase64url = Buffer.from(privateKey).toString("base64url");
      const splitPrivateBase64url = privateBase64url
        .match(/.{1,23}/gu)
        .map((part) => JSON.stringify(part))
        .join(" + ");
      const commentSplitPrivateBase64url = privateBase64url
        .match(/.{1,23}/gu)
        .map((part) => JSON.stringify(part))
        .join(" /* static split */ + ");
      const shellPrivateBase64url = privateBase64url
        .match(/.{1,23}/gu)
        .map((part) => `'${part}'`)
        .join(`${String.fromCodePoint(92)}\n`);
      const rustPrivateBase64url = `concat!(${privateBase64url
        .match(/.{1,23}/gu)
        .map((part) => JSON.stringify(part))
        .join(", /* static split */ ")})`;
      const sourceJwk = (jwk, splitD = false) => `{ ${Object.entries(jwk)
        .map(([key, value]) => {
          if (key === "d" && splitD) {
            return `${key}: ${value.match(/.{1,19}/gu).map((part) => JSON.stringify(part)).join(" + ")}`;
          }
          return `${key}: ${JSON.stringify(value)}`;
        })
        .join(", ")} }`;
      const fixtures = [
        ["raw PKCS#8 DER", privateKey],
        ["base64 PKCS#8", Buffer.from(privateKey).toString("base64")],
        ["base64url PKCS#8", privateBase64url],
        ["split base64url source expression", splitPrivateBase64url],
        ["comment-split base64url source expression", commentSplitPrivateBase64url],
        ["shell-adjacent base64url source expression", shellPrivateBase64url],
        ["Rust concat base64url source expression", rustPrivateBase64url],
        ["hex PKCS#8", Buffer.from(privateKey).toString("hex")],
        ["formatted hex", [...privateKey].map((byte) => `0x${byte.toString(16).padStart(2, "0")}`).join(", ")],
        ["escaped JS bytes", [...privateKey].map((byte) => `\\x${byte.toString(16).padStart(2, "0")}`).join("")],
        ["decimal byte array", `[${[...privateKey].join(",")}]`],
        ["Rust decimal u8 byte array", `[${[...privateKey].map((byte) => `${byte}u8`).join(",")}]`],
        ["Rust u8 byte array", `[${[...privateKey].map((byte) => `0x${byte.toString(16).padStart(2, "0")}u8`).join(",")}]`],
        ["Rust underscored hex u8 byte array", `[${[...privateKey].map((byte) => {
          const digits = byte.toString(16).padStart(2, "0");
          return `0x${digits[0]}_${digits[1]}_u8`;
        }).join(",")}]`],
        ["raw PKCS#1 DER", pkcs1PrivateKey],
        ["base64url PKCS#1", Buffer.from(pkcs1PrivateKey).toString("base64url")],
        ["raw SEC1 DER", sec1PrivateKey],
        ["hex SEC1", Buffer.from(sec1PrivateKey).toString("hex")],
        ["embedded Ed25519 PKCS#8 DER", Buffer.concat([
          Buffer.from([0, 0xff, 0x42, 0]),
          ed25519PrivateKey,
          Buffer.from([0, 0x24, 0xff]),
        ])],
        ["JSON private JWK", JSON.stringify(privateJwk)],
        ["TypeScript private JWK", sourceJwk(privateJwk)],
        ["TypeScript split private JWK", sourceJwk(privateJwk, true)],
        ["TypeScript shorthand private JWK", `${Object.entries(privateJwk)
          .map(([key, value]) => `const ${key} = ${JSON.stringify(value)};`)
          .join("\n")}\nconst key = { kty, n, e, d, p, q, dp, dq, qi };`],
        ["TypeScript variable and spread private JWK", `${Object.entries(privateJwk)
          .map(([key, value]) => {
            if (key !== "d") return `const ${key} = ${JSON.stringify(value)};`;
            const split = Math.floor(value.length / 2);
            return `const dLeft = ${JSON.stringify(value.slice(0, split))};\nconst dRight = ${JSON.stringify(value.slice(split))};\nconst d = dLeft + dRight;`;
          })
          .join("\n")}\nconst publicPart = { kty, n, e };\nconst privatePart = { d, p, q, dp, dq, qi };\nconst key = { ...publicPart, ...privatePart };`],
        ["raw encrypted PKCS#8 DER", encryptedDer],
        ["base64 encrypted PKCS#8 DER", encryptedDer.toString("base64")],
        ["base64url encrypted PKCS#8 DER", encryptedDer.toString("base64url")],
        ["hex encrypted PKCS#8 DER", encryptedDer.toString("hex")],
        ["encrypted PKCS#8 PEM", encryptedPem],
        ["generic PEM carrying PKCS#8", `-----BEGIN DATA-----\n${Buffer.from(privateKey).toString("base64")}\n-----END DATA-----\n`],
        ["generic PEM carrying encrypted PKCS#8", `-----BEGIN BLOB-----\n${encryptedDer.toString("base64")}\n-----END BLOB-----\n`],
      ];
      for (const [label, value] of fixtures) {
        assert.equal(containsEncodedPrivateKey(Buffer.from(value)), true, label);
      }
      assert.equal(isEncryptedPkcs8Der(encryptedDer), true);
      const pbkdf2AsTopLevelAlgorithm = Buffer.from(encryptedDer);
      const pbes2Oid = Buffer.from("06092a864886f70d01050d", "hex");
      const pbes2Offset = pbkdf2AsTopLevelAlgorithm.indexOf(pbes2Oid);
      assert.notEqual(pbes2Offset, -1, "fixture contains the standard PBES2 OID");
      pbkdf2AsTopLevelAlgorithm[pbes2Offset + pbes2Oid.length - 1] = 0x0c;
      const unknownKdf = Buffer.from(encryptedDer);
      const pbkdf2Oid = Buffer.from("06092a864886f70d01050c", "hex");
      const pbkdf2Offset = unknownKdf.indexOf(pbkdf2Oid);
      assert.notEqual(pbkdf2Offset, -1, "fixture contains the PBKDF2 OID");
      unknownKdf[pbkdf2Offset + pbkdf2Oid.length - 1] ^= 0x01;
      const unknownCipher = Buffer.from(encryptedDer);
      const aes256CbcOid = Buffer.from("060960864801650304012a", "hex");
      const cipherOffset = unknownCipher.indexOf(aes256CbcOid);
      assert.notEqual(cipherOffset, -1, "fixture contains the AES-256-CBC OID");
      unknownCipher[cipherOffset + aes256CbcOid.length - 1] ^= 0x01;
      const invalidCipherParameters = Buffer.from(encryptedDer);
      const invalidParametersOffset = invalidCipherParameters.indexOf(aes256CbcOid) + aes256CbcOid.length;
      assert.equal(invalidCipherParameters[invalidParametersOffset], 0x04, "cipher parameters are an IV");
      invalidCipherParameters[invalidParametersOffset] = 0x05;
      const negatives = [
        ["SPKI DER", publicKey],
        ["embedded Ed25519 SPKI DER", Buffer.concat([
          Buffer.from([0, 0xff, 0x42, 0]),
          ed25519PublicKey,
          Buffer.from([0, 0x24, 0xff]),
        ])],
        ["SPKI base64", Buffer.from(publicKey).toString("base64")],
        ["public JWK JSON", JSON.stringify(publicJwk)],
        ["public JWK TypeScript", sourceJwk(publicJwk)],
        ["public JWK shorthand and spread", `${Object.entries(publicJwk)
          .map(([key, value]) => `const ${key} = ${JSON.stringify(value)};`)
          .join("\n")}\nconst publicPart = { kty, n, e };\nconst key = { ...publicPart };`],
        ["generic PEM carrying public DER", `-----BEGIN DATA-----\n${Buffer.from(publicKey).toString("base64")}\n-----END DATA-----\n`],
        ["random base64", Buffer.alloc(256, 0x42).toString("base64")],
        ["DER-shaped but non-key data", Buffer.from("3006020101020102", "hex")],
        ["PBKDF2 misused as a top-level encryption algorithm", pbkdf2AsTopLevelAlgorithm],
        ["unknown PBES2 KDF", unknownKdf],
        ["unknown PBES2 cipher", unknownCipher],
        ["invalid PBES2 cipher parameters", invalidCipherParameters],
      ];
      for (const [label, value] of negatives) {
        assert.equal(containsEncodedPrivateKey(Buffer.from(value)), false, label);
      }
      assert.equal(isEncryptedPkcs8Der(Buffer.from(publicKey)), false);

      // One representative complete package walk proves the pure detector is
      // wired at the boundary without multiplying that walk by every encoding.
      await assert.rejects(
        buildTinyFixture([["encrypted-key.dat", encryptedDer]]),
        /encoded private key material detected/u,
      );
      await assert.rejects(
        buildTinyFixture([["fixture.dat", Buffer.concat([
          Buffer.from([0, 0xff, 0x42, 0]),
          ed25519PrivateKey,
          Buffer.from([0, 0x24, 0xff]),
        ])]]),
        /encoded private key material detected/u,
      );
    });

    await t.test("compound PKCS#8 and private-key filenames fail package policy", async () => {
      for (const name of [
        "fixture.pkcs8.b64",
        "fixture.pk8.hex",
        "fixture-private-key.txt",
        "fixture_private_key.json",
        "privatekey.backup",
      ]) {
        assert.equal(isPrivateKeyFileName(name), true, name);
      }
      for (const name of ["public-key.txt", "private-notes.txt", "keypair.test.mjs"]) {
        assert.equal(isPrivateKeyFileName(name), false, name);
      }
      await assert.rejects(
        buildTinyFixture([["fixture.pkcs8.b64", "synthetic non-key fixture\n"]]),
        /private-key filename is forbidden/u,
      );
    });

    await t.test("package inputs reject external hard-linked inodes", async () => {
      await withTinyReleaseFixture(async ({ fixtureRoot, fixtureOutput, payload }) => {
        const external = join(dirname(fixtureRoot), `release-hardlink-${randomUUID()}.txt`);
        try {
          await writeFile(external, "outside inode\n");
          await link(external, join(payload, "linked.txt"));
          await assert.rejects(
            buildRelease({ profile: "fixture", outputDirectory: fixtureOutput, root: fixtureRoot }),
            /hard-linked files are forbidden/u,
          );
          assert.equal(await readFile(external, "utf8"), "outside inode\n");
        } finally {
          await rm(external, { force: true });
        }
      });
    });

    await t.test("preexisting archive and manifest nodes are never replaced", async () => {
      await withTinyReleaseFixture(async ({ fixtureRoot, fixtureOutput, payload }) => {
        await writeFile(join(payload, "kept.txt"), "stable fixture\n");
        const seedOutput = join(fixtureOutput, "seed");
        const seed = await buildRelease({
          profile: "fixture",
          outputDirectory: seedOutput,
          root: fixtureRoot,
        });
        const names = {
          archive: basename(seed.archivePath),
          manifest: basename(seed.manifestPath),
        };
        for (const role of ["archive", "manifest"]) {
          for (const kind of ["file", "symlink", "hardlink", "directory"]) {
            const caseOutput = join(fixtureOutput, `${role}-${kind}`);
            await mkdir(caseOutput);
            const target = join(caseOutput, names[role]);
            const sentinel = join(fixtureOutput, `${role}-${kind}-sentinel.txt`);
            if (kind === "directory") {
              await mkdir(target);
            } else {
              await writeFile(sentinel, `${role}-${kind}-sentinel\n`);
              if (kind === "file") await writeFile(target, `${role}-${kind}-sentinel\n`);
              else if (kind === "symlink") await symlink(sentinel, target);
              else await link(sentinel, target);
            }
            await assert.rejects(
              buildRelease({ profile: "fixture", outputDirectory: caseOutput, root: fixtureRoot }),
              /refusing to replace existing release output|EEXIST/u,
            );
            const targetStat = await lstat(target);
            if (kind === "directory") assert.equal(targetStat.isDirectory(), true);
            else if (kind === "symlink") {
              assert.equal(targetStat.isSymbolicLink(), true);
              assert.equal(await readFile(sentinel, "utf8"), `${role}-${kind}-sentinel\n`);
            } else {
              assert.equal(await readFile(target, "utf8"), `${role}-${kind}-sentinel\n`);
              if (kind === "hardlink") {
                assert.equal(await readFile(sentinel, "utf8"), `${role}-${kind}-sentinel\n`);
              }
            }
            const otherRole = role === "archive" ? "manifest" : "archive";
            await assert.rejects(lstat(join(caseOutput, names[otherRole])), { code: "ENOENT" });
          }
        }
      });
    });

    await t.test("a concurrent manifest collision removes only the owned archive", async () => {
      await withTinyReleaseFixture(async ({ fixtureRoot, fixtureOutput, payload }) => {
        await writeFile(join(payload, "kept.txt"), "stable fixture\n");
        const first = await buildRelease({
          profile: "fixture",
          outputDirectory: fixtureOutput,
          root: fixtureRoot,
        });
        await rm(first.archivePath);
        await rm(first.manifestPath);
        await assert.rejects(
          buildRelease({
            profile: "fixture",
            outputDirectory: fixtureOutput,
            root: fixtureRoot,
            beforeManifestPublication: async ({ manifestPath }) => {
              await mkdir(manifestPath);
            },
          }),
          /refusing to replace existing release output|EEXIST/iu,
        );
        await assert.rejects(lstat(first.archivePath), { code: "ENOENT" });
        assert.equal((await lstat(first.manifestPath)).isDirectory(), true);
        const names = await readdir(fixtureOutput);
        assert.deepEqual(names, [basename(first.manifestPath)]);
      });
    });

    await t.test("cleanup preserves a concurrent archive replacement", async () => {
      await withTinyReleaseFixture(async ({ fixtureRoot, fixtureOutput, payload }) => {
        await writeFile(join(payload, "kept.txt"), "stable fixture\n");
        const seed = await buildRelease({
          profile: "fixture",
          outputDirectory: fixtureOutput,
          root: fixtureRoot,
        });
        await rm(seed.archivePath);
        await rm(seed.manifestPath);
        const displaced = `${seed.archivePath}.displaced`;
        await assert.rejects(
          buildRelease({
            profile: "fixture",
            outputDirectory: fixtureOutput,
            root: fixtureRoot,
            beforeManifestPublication: async ({ archivePath, manifestPath }) => {
              await rename(archivePath, displaced);
              await writeFile(archivePath, "concurrent replacement\n", { flag: "wx" });
              await mkdir(manifestPath);
            },
          }),
          /refusing to replace existing release output|EEXIST/iu,
        );
        assert.equal(await readFile(seed.archivePath, "utf8"), "concurrent replacement\n");
        assert.equal((await lstat(displaced)).isFile(), true);
        assert.equal((await lstat(seed.manifestPath)).isDirectory(), true);
      });
    });

    await t.test("cleanup never overwrites a second replacement while restoring a foreign inode", async () => {
      await withTinyReleaseFixture(async ({ fixtureOutput }) => {
        const target = join(fixtureOutput, "publication.bin");
        const displaced = join(fixtureOutput, "owned-displaced.bin");
        await writeFile(target, "owned\n");
        const owned = await lstat(target, { bigint: true });
        const receipt = { dev: owned.dev.toString(), ino: owned.ino.toString() };
        const cleaned = await cleanupOwnedPublication(target, receipt, {
          afterOwnershipCheck: async () => {
            await rename(target, displaced);
            await writeFile(target, "first foreign\n", { flag: "wx" });
          },
          beforeForeignRestore: async () => {
            await writeFile(target, "second foreign\n", { flag: "wx" });
          },
        });
        assert.equal(cleaned, false);
        assert.equal(await readFile(target, "utf8"), "second foreign\n");
        assert.equal(await readFile(displaced, "utf8"), "owned\n");
        const quarantines = (await readdir(fixtureOutput))
          .filter((name) => name.startsWith("publication.bin.cleanup-"));
        assert.equal(quarantines.length, 1);
        assert.equal(await readFile(join(fixtureOutput, quarantines[0]), "utf8"), "first foreign\n");
      });
    });

    await t.test("source receipts are rooted at the release tree, not mutable filesystem ancestors", async () => {
      await withTinyReleaseFixture(async ({ fixtureRoot, fixtureOutput, payload }) => {
        await writeFile(join(payload, "kept.txt"), "stable fixture\n");
        const unrelatedSibling = join(tmpdir(), `release-unrelated-${randomUUID()}`);
        try {
          const built = await buildRelease({
            profile: "fixture",
            outputDirectory: fixtureOutput,
            root: fixtureRoot,
            beforeSourceStabilityCheck: async () => {
              await mkdir(unrelatedSibling);
            },
          });
          assert.equal((await lstat(built.archivePath)).isFile(), true);
        } finally {
          await rm(unrelatedSibling, { recursive: true, force: true });
        }

        await assert.rejects(
          buildRelease({
            profile: "fixture",
            outputDirectory: fixtureOutput,
            root: fixtureRoot,
            configPath: join(ROOT, "platform", "deploy", "release.json"),
          }),
          /config escapes the source root/u,
        );
      });
    });

    await t.test("absolute, relative, dangling, and concurrent-swap links are rejected without following", async () => {
      for (const target of ["target.txt", join(tmpdir(), `release-target-${randomUUID()}`), "missing.txt"]) {
        await withTinyReleaseFixture(async ({ fixtureRoot, fixtureOutput, payload }) => {
          await writeFile(join(payload, "target.txt"), "synthetic\n");
          await symlink(target, join(payload, "linked.txt"));
          await assert.rejects(
            buildRelease({ profile: "fixture", outputDirectory: fixtureOutput, root: fixtureRoot }),
            /symbolic links are forbidden/,
          );
        });
      }
      await withTinyReleaseFixture(async ({ fixtureRoot, fixtureOutput, payload }) => {
        const source = join(payload, "swap.txt");
        await writeFile(source, "before\n");
        await assert.rejects(
          buildRelease({
            profile: "fixture",
            outputDirectory: fixtureOutput,
            root: fixtureRoot,
            beforeSourceStabilityCheck: async () => {
              await rm(source);
              await symlink("target.txt", source);
            },
          }),
          /symbolic links are forbidden|source manifest changed/u,
        );
      });
      await withTinyReleaseFixture(async ({ fixtureRoot, fixtureOutput }) => {
        const external = await mkdtemp(join(tmpdir(), "release-profile-alias-external-"));
        try {
          await writeFile(join(external, "file.txt"), "external must not package\n");
          const configPath = join(fixtureRoot, "platform", "deploy", "release.json");
          const config = JSON.parse(await readFile(configPath, "utf8"));
          config.profiles.fixture.include = ["profile-alias/file.txt"];
          await writeFile(configPath, `${JSON.stringify(config)}\n`);
          await symlink(external, join(fixtureRoot, "profile-alias"));
          await assert.rejects(
            buildRelease({ profile: "fixture", outputDirectory: fixtureOutput, root: fixtureRoot }),
            /symbolic links are forbidden.*profile-alias/u,
          );
        } finally {
          await rm(external, { recursive: true, force: true });
        }
      });
      await withTinyReleaseFixture(async ({ fixtureRoot, fixtureOutput, payload }) => {
        const external = await mkdtemp(join(tmpdir(), "release-ancestor-swap-external-"));
        try {
          await mkdir(join(payload, "ancestor"));
          await writeFile(join(payload, "ancestor", "file.txt"), "inside\n");
          await writeFile(join(external, "file.txt"), "outside\n");
          await assert.rejects(
            buildRelease({
              profile: "fixture",
              outputDirectory: fixtureOutput,
              root: fixtureRoot,
              beforeSourceStabilityCheck: async () => {
                await rm(join(payload, "ancestor"), { recursive: true });
                await symlink(external, join(payload, "ancestor"));
              },
            }),
            /symbolic links are forbidden|source manifest changed/u,
          );
        } finally {
          await rm(external, { recursive: true, force: true });
        }
      });
      await withTinyReleaseFixture(async ({ fixtureRoot, fixtureOutput }) => {
        const outer = await mkdtemp(join(tmpdir(), "release-root-alias-"));
        const realParent = join(outer, "real-parent");
        const nestedRoot = join(realParent, "source");
        try {
          await mkdir(realParent);
          await rename(fixtureRoot, nestedRoot);
          await symlink(realParent, join(outer, "alias-parent"));
          await assert.rejects(
            buildRelease({
              profile: "fixture",
              outputDirectory: fixtureOutput,
              root: join(outer, "alias-parent", "source"),
            }),
            /source root ancestors must not be symbolic links/u,
          );
        } finally {
          await rm(outer, { recursive: true, force: true });
        }
      });
      await withTinyReleaseFixture(async ({ fixtureRoot, fixtureOutput }) => {
        const outer = await mkdtemp(join(tmpdir(), "release-root-swap-"));
        const realParent = join(outer, "real-parent");
        const nestedRoot = join(realParent, "source");
        const displaced = join(outer, "real-parent-before-swap");
        try {
          await mkdir(realParent);
          await rename(fixtureRoot, nestedRoot);
          await assert.rejects(
            buildRelease({
              profile: "fixture",
              outputDirectory: fixtureOutput,
              root: nestedRoot,
              beforeSourceStabilityCheck: async () => {
                await rename(realParent, displaced);
                await cp(displaced, realParent, { recursive: true, preserveTimestamps: true });
              },
            }),
            /root changed|source root changed|source manifest changed/u,
          );
        } finally {
          await rm(outer, { recursive: true, force: true });
        }
      });
    });

  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
