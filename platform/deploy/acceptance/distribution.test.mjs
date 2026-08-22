import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildDistribution, cleanupOwnedOutput } from "../../distribution/build.mjs";
import { renderFormula } from "../../distribution/render-homebrew-formula.mjs";
import {
  collectPinGradleFiles,
  parsePinBuilderDockerfileContract,
  parsePinBuilderToolchainContract,
  pinBuilderToolchainMismatches,
} from "../../containers/pin-builder/doctor.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function digest(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function distributionFixture() {
  const fixture = await mkdtemp(join(tmpdir(), "ai-pin-revival-distribution-mutation-"));
  const output = await mkdtemp(join(tmpdir(), "ai-pin-revival-distribution-output-"));
  await mkdir(join(fixture, "platform/deploy"), { recursive: true });
  await mkdir(join(fixture, "platform/distribution"), { recursive: true });
  await mkdir(join(fixture, "center/ancestor"), { recursive: true });
  await writeFile(join(fixture, "revival"), "#!/usr/bin/env node\n", { mode: 0o755 });
  await writeFile(join(fixture, "center/ancestor/product.txt"), "inside marker\n");
  await writeFile(
    join(fixture, "platform/distribution/version.json"),
    '{"schemaVersion":1,"version":"0.1.0-dev"}\n',
  );
  await writeFile(
    join(fixture, "platform/deploy/release.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      profiles: { distribution: { include: ["revival", "center", "platform"], exclude: [] } },
      ignoredDirectoryNames: [],
      ignoredFileNames: [],
      ignoredExtensions: [],
      forbiddenRootDirectories: [],
      forbiddenDirectoryNames: [],
      forbiddenExtensions: [],
    })}\n`,
  );
  return { fixture, output };
}

test("distribution surfaces are honest, pinned, and build-only by default", async () => {
  const release = JSON.parse(await readFile(join(ROOT, "platform/deploy/release.json"), "utf8"));
  const profile = release.profiles.distribution;
  assert.ok(profile.include.includes("revival"));
  for (const [name, candidate] of Object.entries(release.profiles)) {
    assert.ok(
      candidate.include.includes("rust-toolchain.toml"),
      `${name} release omits the exact Rust toolchain pin`,
    );
  }
  for (const boundary of ["center", "cosmos", "pin", "platform", "contracts", "docs"]) {
    assert.ok(profile.include.includes(boundary), `distribution omits ${boundary}`);
  }
  assert.ok(release.ignoredDirectoryNames.includes("test-runs"));

  const version = JSON.parse(
    await readFile(join(ROOT, "platform/distribution/version.json"), "utf8"),
  );
  assert.deepEqual(version, { schemaVersion: 1, version: "0.1.0-dev" });

  const container = JSON.parse(await readFile(join(ROOT, ".devcontainer/devcontainer.json"), "utf8"));
  assert.equal(container.features["ghcr.io/devcontainers/features/node:2.1.0"].version, "22.14.0");
  assert.ok(container.features["ghcr.io/devcontainers/features/docker-outside-of-docker:1.10.0"]);
  assert.match(container.containerEnv.CARGO_TARGET_DIR, /^\/workspace-cache\//);
  assert.match(container.containerEnv.NPM_CONFIG_CACHE, /^\/workspace-cache\//);
  assert.match(container.containerEnv.REVIVAL_SECRETS_DIR, /^\/workspace-private\//);

  const rootToolchain = await readFile(join(ROOT, "rust-toolchain.toml"), "utf8");
  assert.match(rootToolchain, /^\[toolchain\]$/m);
  const rootRustVersion = /^channel = "(\d+\.\d+\.\d+)"$/m.exec(rootToolchain)?.[1];
  assert.match(rootToolchain, /^profile = "minimal"$/m);
  assert.match(rootToolchain, /^components = \["clippy", "rustfmt"\]$/m);

  const builderToolchainText = await readFile(
    join(ROOT, "platform/containers/pin-builder/toolchain.json"),
    "utf8",
  );
  const builderToolchain = JSON.parse(builderToolchainText);
  const rust = builderToolchain.toolchain.rust;
  assert.equal(rust.version, "1.91.1");
  assert.equal(rootRustVersion, rust.version);
  assert.equal(
    container.features["ghcr.io/devcontainers/features/rust:1.5.1"].version,
    rust.version,
  );
  const cosmosDockerfile = await readFile(join(ROOT, "cosmos/Dockerfile"), "utf8");
  const buildImage = cosmosDockerfile.match(/^FROM (\S+) AS build$/m)?.[1];
  assert.equal(buildImage, `${rust.image}@${rust.imageIndexDigest}`);
  assert.match(
    cosmosDockerfile,
    /URIs: http:\/\/snapshot\.debian\.org\/archive\/debian\/20260803T000000Z/u,
  );
  assert.match(
    cosmosDockerfile,
    /Suites: bookworm bookworm-updates/u,
  );
  assert.match(
    cosmosDockerfile,
    /URIs: http:\/\/snapshot\.debian\.org\/archive\/debian-security\/20260803T000000Z/u,
  );
  assert.match(cosmosDockerfile, /Suites: bookworm-security/u);
  assert.equal(cosmosDockerfile.match(/Check-Valid-Until: no/gu)?.length, 2);
  assert.doesNotMatch(cosmosDockerfile, /deb\.debian\.org|security\.debian\.org/u);

  const pinDockerfile = await readFile(
    join(ROOT, "platform/containers/pin-builder/Dockerfile"),
    "utf8",
  );
  const centerDockerfile = await readFile(join(ROOT, "center/Dockerfile"), "utf8");
  const pinBaseImages = [...pinDockerfile.matchAll(/^FROM (\S+)/gm)].map((match) => match[1]);
  assert.deepEqual(
    pinBuilderToolchainMismatches(
      parsePinBuilderToolchainContract(builderToolchainText),
      parsePinBuilderDockerfileContract(
        pinDockerfile,
        centerDockerfile,
        collectPinGradleFiles(ROOT),
      ),
    ),
    [],
    "every exact Pin Docker surface must match toolchain.json",
  );
  assert.ok(pinBaseImages.includes(`${rust.image}@${rust.imageIndexDigest}`));
  assert.ok(
    pinDockerfile.includes(
      `rustup target add aarch64-linux-android --toolchain ${rust.version};`,
    ),
  );
  assert.match(
    pinDockerfile,
    /URIs: http:\/\/snapshot\.debian\.org\/archive\/debian\/20260803T000000Z/u,
  );
  assert.match(pinDockerfile, /Suites: bookworm bookworm-updates/u);
  assert.match(
    pinDockerfile,
    /URIs: http:\/\/snapshot\.debian\.org\/archive\/debian-security\/20260803T000000Z/u,
  );
  assert.match(pinDockerfile, /Suites: bookworm-security/u);
  // Native SDK acquisition and final amd64 assembly are distinct pinned
  // Debian consumers; each carries one main and one security stanza.
  assert.equal(pinDockerfile.match(/Check-Valid-Until: no/gu)?.length, 4);
  assert.doesNotMatch(pinDockerfile, /deb\.debian\.org|security\.debian\.org/u);
  const pinBuild = await readFile(join(ROOT, "platform/deploy/pin/build.mjs"), "utf8");
  assert.ok(
    [...pinBuild.matchAll(/"--platform", "linux\/amd64"/gu)].length >= 3,
    "Pin image build and both execution phases must force the contracted linux/amd64 platform",
  );

  const ci = await readFile(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const ciRustPins = [...ci.matchAll(/uses: dtolnay\/rust-toolchain@([0-9a-f]{40}) # (\S+)/g)]
    .map((match) => [match[1], match[2]]);
  assert.ok(ciRustPins.length > 0, "CI must install the operational Rust toolchain");
  assert.deepEqual([...new Set(ciRustPins.map((pin) => JSON.stringify(pin)))], [
    JSON.stringify(["38ae5351029910ad7674ccfad89c37cbd636f3c4", rust.version]),
  ]);
  const cosmosJob = /^  cosmos:\n(?<body>[\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu.exec(ci)?.groups?.body;
  const centerJob = /^  center:\n(?<body>[\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu.exec(ci)?.groups?.body;
  assert.ok(centerJob, "CI must define a Center job");
  assert.match(
    centerJob,
    /- name: UI component checks\n        run: npm --prefix center run test:ui/u,
  );
  assert.doesNotMatch(centerJob, /continue-on-error:\s*true/u);
  assert.ok(cosmosJob, "CI must define a Cosmos job");
  const postgresDigest =
    "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";
  assert.ok(cosmosJob.includes(`        image: ${postgresDigest}\n`));
  assert.match(cosmosJob, /^          POSTGRES_USER: cosmos_test$/m);
  assert.match(cosmosJob, /^          POSTGRES_PASSWORD: cosmos_test_ci_only$/m);
  assert.match(cosmosJob, /^          POSTGRES_DB: cosmos_test$/m);
  assert.match(cosmosJob, /^          - 5432:5432$/m);
  assert.match(cosmosJob, /--health-cmd "pg_isready -U cosmos_test -d cosmos_test"/);
  assert.match(cosmosJob, /--health-interval 2s/);
  assert.match(cosmosJob, /--health-timeout 5s/);
  assert.match(cosmosJob, /--health-retries 20/);
  assert.doesNotMatch(
    /^    env:\n(?<env>[\s\S]*?)(?=^    steps:)/mu.exec(cosmosJob)?.groups?.env ?? "",
    /COSMOS_TEST_DATABASE_URL/u,
    "generic Cosmos steps must not inherit the real-Postgres URL",
  );
  assert.match(cosmosJob, /cargo test --workspace --locked --manifest-path cosmos\/Cargo\.toml/);
  assert.doesNotMatch(
    cosmosJob,
    /migrations_are_globally_numbered_and_append_only|migration_parser_preserves_every_explicit_statement|ai_bus_startup_rejects_missing_or_invalid_kid_scope_before_binding/,
    "ordinary workspace tests must not be rerun serially",
  );
  assert.match(
    cosmosJob,
    /- name: real Postgres lifecycle and atomic migration contention\n        working-directory: cosmos\n        env:\n          COSMOS_TEST_DATABASE_URL: postgresql:\/\/cosmos_test:cosmos_test_ci_only@127\.0\.0\.1:5432\/cosmos_test\n        run: \|\n          node -e "require\('\.\.\/platform\/cli\/context'\)\.validateDisposablePostgresTestUrl\(process\.env\.COSMOS_TEST_DATABASE_URL\)"\n          env -u COSMOS_STATE_DIR -u COSMOS_WORKLOAD COSMOS_TEST_DATABASE_URL="\$COSMOS_TEST_DATABASE_URL" cargo test -p cosmos keydirectory::tests::a_second_workload_observes_import_replacement_revocation_and_reimport -- --exact --nocapture\n          env -u COSMOS_STATE_DIR -u COSMOS_WORKLOAD COSMOS_TEST_DATABASE_URL="\$COSMOS_TEST_DATABASE_URL" cargo test -p cosmos store_postgres::tests::many_concurrent_key_directories_migrate_one_fresh_postgres_schema_atomically -- --exact --nocapture/,
  );
  assert.doesNotMatch(cosmosJob, /\$\{\{\s*secrets\./);

  const cosmosManifest = await readFile(join(ROOT, "cosmos/Cargo.toml"), "utf8");
  const cosmosMsrv = /^rust-version = "(\d+\.\d+)"$/m.exec(cosmosManifest)?.[1];
  assert.equal(cosmosMsrv, "1.85");
  assert.notEqual(cosmosMsrv, rust.version, "package MSRV is metadata, not the operational compiler pin");

  const formula = await readFile(
    join(ROOT, "platform/distribution/homebrew/ai-pin-revival.rb.template"),
    "utf8",
  );
  assert.match(formula, /depends_on "node@22"/);
  assert.match(formula, /libexec\.install Dir\["\*"\]/);
  assert.match(formula, /libexec\.install "\.dockerignore", "\.editorconfig", "\.env\.example", "\.gitignore"/);
  assert.match(formula, /@@URL@@/);
  assert.match(formula, /@@SHA256@@/);
  assert.doesNotMatch(formula, /github\.com\//);

  const workflow = await readFile(join(ROOT, ".github/workflows/release-cli.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /default: false/);
  assert.match(workflow, /github\.ref_type == 'tag'/);
  assert.match(workflow, /github\.ref_name == format\('v\{0\}', inputs\.version\)/);
  assert.match(workflow, /Publishing requires dispatching from the existing v\$RELEASE_VERSION tag/);
  assert.match(workflow, /sha256sum --check SHA256SUMS/g);
  assert.match(workflow, /sha256sum "\$output\/ai-pin-revival\.rb" >> "\$output\/SHA256SUMS"/);
  assert.doesNotMatch(workflow, /attest|provenance|id-token:/i);
});

test("builder stamps only the payload and emits verifiable checksums", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "ai-pin-revival-distribution-fixture-"));
  const output = await mkdtemp(join(tmpdir(), "ai-pin-revival-distribution-output-"));
  try {
    await mkdir(join(fixture, "platform/deploy"), { recursive: true });
    await mkdir(join(fixture, "platform/distribution"), { recursive: true });
    await mkdir(join(fixture, "center"), { recursive: true });
    await writeFile(join(fixture, "revival"), "#!/usr/bin/env node\n", { mode: 0o755 });
    await writeFile(join(fixture, "center/product.txt"), "complete product marker\n");
    await writeFile(
      join(fixture, "platform/distribution/version.json"),
      '{"schemaVersion":1,"version":"0.1.0-dev"}\n',
    );
    const config = {
      schemaVersion: 1,
      profiles: {
        distribution: {
          include: ["revival", "center", "platform"],
          exclude: [],
        },
      },
      ignoredDirectoryNames: [],
      ignoredFileNames: [],
      ignoredExtensions: [],
      forbiddenRootDirectories: [],
      forbiddenDirectoryNames: [],
      forbiddenExtensions: [],
    };
    await writeFile(
      join(fixture, "platform/deploy/release.json"),
      `${JSON.stringify(config, null, 2)}\n`,
    );

    const built = await buildDistribution({
      version: "1.2.3",
      outputDirectory: output,
      root: fixture,
    });
    assert.equal(built.payload.kind, "full-product-source");
    const archive = await readFile(join(output, built.payload.archive));
    assert.equal(digest(archive), built.payload.archiveSha256);

    const checksums = await readFile(join(output, "SHA256SUMS"), "utf8");
    for (const name of [built.payload.archive, built.payload.manifest, built.descriptor]) {
      const data = await readFile(join(output, name));
      assert.match(checksums, new RegExp(`^${digest(data)}  ${name}$`, "m"));
    }

    const extracted = spawnSync(
      "tar",
      ["-xOzf", join(output, built.payload.archive), "platform/distribution/version.json"],
      { encoding: "utf8" },
    );
    assert.equal(extracted.status, 0, extracted.stderr);
    assert.deepEqual(JSON.parse(extracted.stdout), { schemaVersion: 1, version: "1.2.3" });
    assert.deepEqual(
      JSON.parse(await readFile(join(fixture, "platform/distribution/version.json"), "utf8")),
      { schemaVersion: 1, version: "0.1.0-dev" },
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});

test("distribution cleanup never overwrites a second replacement while restoring a foreign inode", async () => {
  const output = await mkdtemp(join(tmpdir(), "ai-pin-revival-distribution-cleanup-"));
  try {
    const target = join(output, "artifact.bin");
    const displaced = join(output, "owned-displaced.bin");
    await writeFile(target, "owned\n");
    const owned = await lstat(target, { bigint: true });
    const receipt = { dev: owned.dev.toString(), ino: owned.ino.toString() };
    const cleaned = await cleanupOwnedOutput(target, receipt, {
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
    const quarantines = (await readdir(output)).filter((name) =>
      name.startsWith("artifact.bin.cleanup-"));
    assert.equal(quarantines.length, 1);
    assert.equal(await readFile(join(output, quarantines[0]), "utf8"), "first foreign\n");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("distribution rejects linked inputs and ancestor swaps before staging writes", async (t) => {
  for (const label of ["absolute", "relative", "dangling"]) {
    await t.test(`${label} version link`, async () => {
      const { fixture, output } = await distributionFixture();
      const outside = join(dirname(fixture), `${label}-outside-version.json`);
      try {
        await writeFile(outside, "outside sentinel\n");
        const version = join(fixture, "platform/distribution/version.json");
        await rm(version);
        const target = label === "absolute"
          ? outside
          : label === "relative"
            ? relative(dirname(version), outside)
            : "missing-version.json";
        await symlink(target, version);
        await assert.rejects(
          buildDistribution({ version: "1.2.3", outputDirectory: output, root: fixture }),
          /symbolic links are forbidden|changed during descriptor/u,
        );
        assert.equal(await readFile(outside, "utf8"), "outside sentinel\n");
      } finally {
        await rm(fixture, { recursive: true, force: true });
        await rm(output, { recursive: true, force: true });
        await rm(outside, { force: true });
      }
    });
  }

  await t.test("version ancestor link", async () => {
    const { fixture, output } = await distributionFixture();
    const outside = await mkdtemp(join(tmpdir(), "distribution-version-ancestor-"));
    try {
      await writeFile(join(outside, "version.json"), "outside ancestor sentinel\n");
      await rm(join(fixture, "platform/distribution"), { recursive: true });
      await symlink(outside, join(fixture, "platform/distribution"));
      await assert.rejects(
        buildDistribution({ version: "1.2.3", outputDirectory: output, root: fixture }),
        /symbolic links are forbidden|changed during descriptor/u,
      );
      assert.equal(await readFile(join(outside, "version.json"), "utf8"), "outside ancestor sentinel\n");
    } finally {
      await rm(fixture, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  await t.test("concurrent included ancestor swap", async () => {
    const { fixture, output } = await distributionFixture();
    const outside = await mkdtemp(join(tmpdir(), "distribution-concurrent-ancestor-"));
    try {
      await writeFile(join(outside, "product.txt"), "outside concurrent sentinel\n");
      await assert.rejects(
        buildDistribution({
          version: "1.2.3",
          outputDirectory: output,
          root: fixture,
          beforeSourceStabilityCheck: async () => {
            await rm(join(fixture, "center/ancestor"), { recursive: true });
            await symlink(outside, join(fixture, "center/ancestor"));
          },
        }),
        /symbolic links are forbidden|source manifest changed|root changed/u,
      );
      assert.equal(await readFile(join(outside, "product.txt"), "utf8"), "outside concurrent sentinel\n");
    } finally {
      await rm(fixture, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  await t.test("source root under a linked ancestor", async () => {
    const { fixture, output } = await distributionFixture();
    const outer = await mkdtemp(join(tmpdir(), "distribution-root-alias-"));
    const realParent = join(outer, "real-parent");
    const nestedRoot = join(realParent, "source");
    try {
      await mkdir(realParent);
      await rename(fixture, nestedRoot);
      await symlink(realParent, join(outer, "alias-parent"));
      await assert.rejects(
        buildDistribution({
          version: "1.2.3",
          outputDirectory: output,
          root: join(outer, "alias-parent", "source"),
        }),
        /source root ancestors must not be symbolic links/u,
      );
    } finally {
      await rm(outer, { recursive: true, force: true });
      await rm(fixture, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

  await t.test("concurrent source-root ancestor replacement", async () => {
    const { fixture, output } = await distributionFixture();
    const outer = await mkdtemp(join(tmpdir(), "distribution-root-swap-"));
    const realParent = join(outer, "real-parent");
    const nestedRoot = join(realParent, "source");
    const displaced = join(outer, "real-parent-before-swap");
    try {
      await mkdir(realParent);
      await rename(fixture, nestedRoot);
      await assert.rejects(
        buildDistribution({
          version: "1.2.3",
          outputDirectory: output,
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
      await rm(fixture, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    }
  });

  await t.test("external hardlink", async () => {
    const { fixture, output } = await distributionFixture();
    const outside = join(dirname(fixture), "distribution-hardlink-sentinel.txt");
    try {
      await writeFile(outside, "outside hardlink sentinel\n");
      const product = join(fixture, "center/ancestor/product.txt");
      await rm(product);
      await link(outside, product);
      await assert.rejects(
        buildDistribution({ version: "1.2.3", outputDirectory: output, root: fixture }),
        /hard-linked files are forbidden/u,
      );
      assert.equal(await readFile(outside, "utf8"), "outside hardlink sentinel\n");
    } finally {
      await rm(fixture, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });

  const buildSource = await readFile(join(ROOT, "platform/distribution/build.mjs"), "utf8");
  assert.match(buildSource, /mkdtemp\(join\(outputRoot, "\.ai-pin-revival-build-"\)\)/u);
  assert.doesNotMatch(buildSource, /mkdtemp\(join\(tmpdir\(\)/u);
  assert.doesNotMatch(buildSource, /\bcp\(/u);
});

test("Homebrew formula becomes usable only with explicit release coordinates", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "ai-pin-revival-formula-"));
  try {
    const output = join(temporary, "ai-pin-revival.rb");
    await renderFormula({
      template: join(ROOT, "platform/distribution/homebrew/ai-pin-revival.rb.template"),
      output,
      homepage: "https://github.test/owner/repository",
      url: "https://github.test/owner/repository/releases/download/v1.2.3/ai-pin-revival-1.2.3.tar.gz",
      version: "1.2.3",
      sha256: "a".repeat(64),
    });
    const formula = await readFile(output, "utf8");
    assert.doesNotMatch(formula, /@@[A-Z0-9_]+@@/);
    assert.match(formula, /version "1\.2\.3"/);
    assert.match(formula, /sha256 "a{64}"/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
