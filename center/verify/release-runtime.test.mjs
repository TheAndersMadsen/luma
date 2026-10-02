import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Center builds a minimal non-root standalone image with runtime assets", async () => {
  const [dockerfile, config] = await Promise.all([
    source("Dockerfile"),
    source("next.config.mjs"),
  ]);

  assert.match(config, /output:\s*["']standalone["']/);
  assert.match(config, /img-src[^\n]+https:\/\/resources\.tidal\.com/);
  assert.match(config, /img-src[^\n]+https:\/\/i\.ytimg\.com/);
  assert.match(config, /img-src[^\n]+https:\/\/\*\.spotifycdn\.com/);
  assert.match(await source("src/components/MusicArtwork.tsx"), /referrerPolicy="no-referrer"/);
  assert.match(
    dockerfile,
    /FROM oven\/bun:1\.4\.2-slim@sha256:[0-9a-f]{64} AS runtime/,
  );
  assert.match(dockerfile, /\.next\/standalone/);
  assert.match(dockerfile, /ARG LUMA_RELEASE_ID/);
  assert.match(dockerfile, /FROM --platform=\$BUILDPLATFORM oven\/bun:1\.4\.2-slim/);
  assert.match(dockerfile, /AS runtime-dependencies/);
  assert.match(dockerfile, /rm -rf node_modules center\/node_modules/);
  assert.match(dockerfile, /--from=runtime-dependencies[^\n]+\/app\/node_modules/);
  assert.match(dockerfile, /\/app\/center\/\.next\/static/);
  assert.match(dockerfile, /\/app\/center\/public/);
  assert.match(dockerfile, /COSMOS_CONTRACTS_DIR=\/app\/contracts/);
  assert.match(dockerfile, /\. \.\/contracts/);
  assert.match(dockerfile, /--chown=1000:1001/);
  assert.match(dockerfile, /USER 1000:1001/);
  // Center holds no wearer key: Cosmos seals and opens every wearer payload.
  assert.doesNotMatch(dockerfile, /CHANNEL_KEY/);
  assert.match(dockerfile, /chown 1000:1001 \/data/);
  assert.match(dockerfile, /CMD \["bun", "--no-env-file", "center\/server\.js"\]/);
});

test("Center build identity is the mandatory immutable release id", async () => {
  const priorReleaseId = process.env.LUMA_RELEASE_ID;
  const module = await import(`../next.config.mjs?build-id=${Date.now()}`);
  const releaseId = "a".repeat(64);

  try {
    process.env.LUMA_RELEASE_ID = releaseId;
    assert.equal(module.lumaBuildId(process.env), releaseId);
    assert.equal(await module.default.generateBuildId(), releaseId);
    assert.equal(await module.default.generateBuildId(), releaseId);

    delete process.env.LUMA_RELEASE_ID;
    assert.throws(
      () => module.lumaBuildId(process.env),
      /LUMA_RELEASE_ID is required for Center builds/,
    );
    await assert.rejects(
      () => module.default.generateBuildId(),
      /LUMA_RELEASE_ID is required for Center builds/,
    );
    assert.throws(
      () => module.lumaBuildId({ LUMA_RELEASE_ID: "../unsafe" }),
      /LUMA_RELEASE_ID is required for Center builds/,
    );
  } finally {
    if (priorReleaseId === undefined) delete process.env.LUMA_RELEASE_ID;
    else process.env.LUMA_RELEASE_ID = priorReleaseId;
  }
});

test("Center sign-in exposes one direct password action in every build", async () => {
  const [dockerfile, exampleEnvironment, login] = await Promise.all([
    source("Dockerfile"),
    source(".env.example"),
    Promise.all([source("src/app/login/page.tsx"), source("src/components/SignInForm.tsx")]).then(parts => parts.join("\n")),
  ]);
  const combined = `${dockerfile}\n${exampleEnvironment}\n${login}`;

  assert.doesNotMatch(combined, /NEXT_PUBLIC_OIDC_AUTOREDIRECT/);
  assert.doesNotMatch(dockerfile, /ARG NEXT_PUBLIC_/);
  assert.doesNotMatch(login, /window\.location\.assign|autoRedirect/);
  assert.doesNotMatch(login, /api\/auth\/login\/start|>\s*Continue\s*</);
  assert.match(login, /fetch\("\/api\/auth\/login"/);
  assert.match(login, /Sign in with password/);
});

test("dynamic Center responses are private and hardened", async () => {
  const [config, middleware] = await Promise.all([
    source("next.config.mjs"),
    source("src/middleware.ts"),
  ]);

  for (const header of [
    "Content-Security-Policy",
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
  ]) {
    assert.match(config, new RegExp(header));
  }
  assert.match(middleware, /private, no-store, max-age=0, must-revalidate/);
});

test("public version endpoint exposes product, release, and explicit runtime environment", async () => {
  const [route, identity, middleware] = await Promise.all([
    source("src/app/api/version/route.ts"),
    source("src/lib/runtimeIdentity.ts"),
    source("src/middleware.ts"),
  ]);

  assert.match(route, /centerRuntimeIdentity\(\)/);
  assert.match(identity, /LUMA_RELEASE_ID/);
  assert.match(identity, /COSMOS_REVISION/);
  assert.match(identity, /LUMA_ENVIRONMENT/);
  assert.match(identity, /product: "Luma Center"/);
  assert.match(identity, /environment: environment\.LUMA_ENVIRONMENT\?\.trim\(\) \|\| "development"/);
  assert.match(route, /"cache-control": "no-store"/);
  assert.doesNotMatch(`${route}\n${identity}`, /hostname|provider|region|endpoint|secret/i);
  assert.match(middleware, /RATE_LIMITED_PUBLIC_API_PATHS/);
  assert.match(middleware, /"\/api\/version"/);

  const priorRelease = process.env.LUMA_RELEASE_ID;
  const priorRevision = process.env.COSMOS_REVISION;
  const priorEnvironment = process.env.LUMA_ENVIRONMENT;
  try {
    process.env.LUMA_RELEASE_ID = "test-release";
    process.env.COSMOS_REVISION = "ignored-revision";
    process.env.LUMA_ENVIRONMENT = "production";
    const { centerRuntimeIdentity } = await import(`../src/lib/runtimeIdentity.ts?identity=${Date.now()}`);
    // Only the identity variables are set here. Every release field is null.
    assert.deepEqual(centerRuntimeIdentity({
      LUMA_RELEASE_ID: process.env.LUMA_RELEASE_ID,
      COSMOS_REVISION: process.env.COSMOS_REVISION,
      LUMA_ENVIRONMENT: process.env.LUMA_ENVIRONMENT,
    }), {
      product: "Luma Center",
      release: "test-release",
      environment: "production",
      version: null,
      tag: null,
      pin: null,
      notes: null,
      publishedAt: null,
    });
  } finally {
    if (priorRelease === undefined) delete process.env.LUMA_RELEASE_ID;
    else process.env.LUMA_RELEASE_ID = priorRelease;
    if (priorRevision === undefined) delete process.env.COSMOS_REVISION;
    else process.env.COSMOS_REVISION = priorRevision;
    if (priorEnvironment === undefined) delete process.env.LUMA_ENVIRONMENT;
    else process.env.LUMA_ENVIRONMENT = priorEnvironment;
  }
});
