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
  assert.match(await source("src/app/page.tsx"), /referrerPolicy="no-referrer"/);
  assert.match(
    dockerfile,
    /FROM node:22\.14\.0-bookworm-slim@sha256:[0-9a-f]{64} AS runtime/,
  );
  assert.match(dockerfile, /\.next\/standalone/);
  assert.match(dockerfile, /ARG REVIVAL_RELEASE_ID/);
  assert.match(dockerfile, /\/app\/\.next\/static/);
  assert.match(dockerfile, /\/app\/public/);
  assert.match(dockerfile, /COSMOS_CONTRACTS_DIR=\/app\/contracts/);
  assert.match(dockerfile, /\. \.\/contracts/);
  assert.match(dockerfile, /rm -rf \/app\/node_modules\/typescript/);
  assert.match(dockerfile, /--chown=1000:1001/);
  assert.match(dockerfile, /USER 1000:1001/);
  assert.match(dockerfile, /COSMOS_CHANNEL_KEY_FILE=\/data\/channel-key\.json/);
  assert.match(dockerfile, /chown 1000:1001 \/data/);
  assert.match(dockerfile, /CMD \["node", "server\.js"\]/);
});

test("Center build identity is the mandatory immutable release id", async () => {
  const priorReleaseId = process.env.REVIVAL_RELEASE_ID;
  const module = await import(`../next.config.mjs?build-id=${Date.now()}`);
  const releaseId = "a".repeat(64);

  try {
    process.env.REVIVAL_RELEASE_ID = releaseId;
    assert.equal(module.revivalBuildId(process.env), releaseId);
    assert.equal(await module.default.generateBuildId(), releaseId);
    assert.equal(await module.default.generateBuildId(), releaseId);

    delete process.env.REVIVAL_RELEASE_ID;
    assert.throws(
      () => module.revivalBuildId(process.env),
      /REVIVAL_RELEASE_ID is required for Center builds/,
    );
    await assert.rejects(
      () => module.default.generateBuildId(),
      /REVIVAL_RELEASE_ID is required for Center builds/,
    );
    assert.throws(
      () => module.revivalBuildId({ REVIVAL_RELEASE_ID: "../unsafe" }),
      /REVIVAL_RELEASE_ID is required for Center builds/,
    );
  } finally {
    if (priorReleaseId === undefined) delete process.env.REVIVAL_RELEASE_ID;
    else process.env.REVIVAL_RELEASE_ID = priorReleaseId;
  }
});

test("Center sign-in exposes one direct password action in every build", async () => {
  const [dockerfile, exampleEnvironment, login] = await Promise.all([
    source("Dockerfile"),
    source(".env.example"),
    source("src/app/login/page.tsx"),
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

test("public version endpoint exposes only product and immutable release identity", async () => {
  const [route, middleware] = await Promise.all([
    source("src/app/api/version/route.ts"),
    source("src/middleware.ts"),
  ]);

  assert.match(route, /REVIVAL_RELEASE_ID/);
  assert.match(route, /COSMOS_REVISION/);
  assert.match(route, /product: "Ai Pin Revival Center", release: RELEASE_ID/);
  assert.match(route, /"cache-control": "no-store"/);
  assert.doesNotMatch(route, /hostname|provider|region|endpoint|secret/i);
  assert.match(middleware, /pathname === "\/api\/version"/);
});
