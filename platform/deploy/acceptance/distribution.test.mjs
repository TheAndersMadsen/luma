import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildDistribution } from "../../distribution/build.mjs";
import { renderFormula } from "../../distribution/render-homebrew-formula.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function digest(data) {
  return createHash("sha256").update(data).digest("hex");
}

test("distribution surfaces are honest, pinned, and build-only by default", async () => {
  const release = JSON.parse(await readFile(join(ROOT, "platform/deploy/release.json"), "utf8"));
  const profile = release.profiles.distribution;
  assert.ok(profile.include.includes("revival"));
  for (const boundary of ["center", "cosmos", "pin", "platform", "contracts", "docs"]) {
    assert.ok(profile.include.includes(boundary), `distribution omits ${boundary}`);
  }
  assert.ok(release.ignoredDirectoryNames.includes("test-runs"));

  const version = JSON.parse(
    await readFile(join(ROOT, "platform/distribution/version.json"), "utf8"),
  );
  assert.deepEqual(version, { schemaVersion: 1, version: "0.1.0-dev" });

  const container = JSON.parse(await readFile(join(ROOT, ".devcontainer/devcontainer.json"), "utf8"));
  assert.equal(container.features["ghcr.io/devcontainers/features/node:1"].version, "22.14.0");
  assert.equal(container.features["ghcr.io/devcontainers/features/rust:1"].version, "1.91.1");
  assert.ok(container.features["ghcr.io/devcontainers/features/docker-outside-of-docker:1"]);
  assert.match(container.containerEnv.CARGO_TARGET_DIR, /^\/workspace-state\//);
  assert.match(container.containerEnv.NPM_CONFIG_CACHE, /^\/workspace-state\//);

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
