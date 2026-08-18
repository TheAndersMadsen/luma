import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const middleware = await readFile(new URL("../src/middleware.ts", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../public/manifest.json", import.meta.url), "utf8"));
const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
const nextConfig = await readFile(new URL("../next.config.mjs", import.meta.url), "utf8");
const compose = await readFile(new URL("../../compose.yaml", import.meta.url), "utf8");
const releaseClient = await readFile(
  new URL("../src/lib/pin-install/releases/manifest.ts", import.meta.url),
  "utf8",
);
const providers = await readFile(new URL("../src/components/Providers.tsx", import.meta.url), "utf8");

async function pngDimensions(path) {
  const bytes = await readFile(new URL(path, import.meta.url));
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

async function sourceFiles(directory, found = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) await sourceFiles(child, found);
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) found.push(child);
  }
  return found;
}

function withoutComments(text, marker) {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(marker))
    .join("\n");
}

test("Center's installable PWA assets remain public before sign in", async () => {
  assert.match(middleware, /favicon\.ico/);
  assert.match(middleware, /manifest\.json/);
  assert.ok(middleware.includes("icon-192\\\\.png"));
  assert.ok(middleware.includes("icon-512\\\\.png"));
  assert.equal(manifest.id, "/");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#000000");
  assert.deepEqual(
    manifest.icons.map(({ src, sizes, type }) => ({ src, sizes, type })),
    [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  );
  assert.deepEqual(await pngDimensions("../public/icon-192.png"), [192, 192]);
  assert.deepEqual(await pngDimensions("../public/icon-512.png"), [512, 512]);
});

test("the PWA stays an online shell and does not cache setup facts offline", async () => {
  assert.ok(!existsSync(new URL("../public/sw.js", import.meta.url)));
  assert.ok(!existsSync(new URL("../public/service-worker.js", import.meta.url)));
  assert.doesNotMatch(providers, /serviceWorker|workbox|CacheStorage|caches\.open/);
  for (const file of await sourceFiles(new URL("../src/", import.meta.url))) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /serviceWorker\.register|caches\.open|workbox/i, file.pathname);
  }
});

test("the Pin release manifest is served from Center's own origin", () => {
  /*
   * The installer reads the release manifest from a ROOT-RELATIVE path, so the
   * only origin that ever fetches `/api/pin/releases/*` is the one serving the
   * console. That is what lets `REVIVAL_PIN_SETUP_ORIGIN` — the CORS allowlist
   * on those routes — stay pinned to Center's own origin instead of widening to
   * admit some second host. Point this default at an absolute URL and the
   * allowlist has to grow to match, which is the regression being guarded.
   *
   * This used to read the same constant out of the standalone `pin/setup` SPA,
   * back when the SPA was the thing doing the fetching. The SPA is deleted; the
   * installer is `center/src/lib/pin-install`, so that is what is checked here.
   */
  assert.match(
    releaseClient,
    /DEFAULT_PIN_RELEASE_MANIFEST_URL = "\/api\/pin\/releases\/current"/,
  );

  // Same-origin is only true if Center actually answers that path, so assert the
  // route exists rather than trusting the string. A renamed route handler would
  // otherwise leave this test green while the installer 404s.
  assert.ok(
    existsSync(new URL("../src/app/api/pin/releases/current/route.ts", import.meta.url)),
    "Center must serve the manifest path its own installer defaults to",
  );
});

test("Center does not ship a second Pin console at an ungated /setup", () => {
  /*
   * Center used to build a standalone Setup SPA into `public/setup` and rewrite
   * `/setup` to its index. That bundle carried an interactive ADB PTY — a ROOT
   * shell on the wearer's Pin — and `/setup` is an ordinary wearer path: not
   * `isOperatorPath`, so middleware asked only for a session. It was a second,
   * ungated door to the exact capability `/admin/pin/terminal` exists to gate.
   *
   * The console is native now and the SPA's source is deleted. Deletion is not
   * a guard, though — it removes today's bundle, not the ability to add one —
   * so these assertions stay on the two build files that would have to name it.
   */
  // Whole-line comments are stripped first: the comments in both files name the
  // paths on purpose, explaining why they must not appear as instructions.
  const build = withoutComments(dockerfile, "#");
  const config = withoutComments(nextConfig, "//");
  assert.doesNotMatch(build, /dist-setup/);
  assert.doesNotMatch(build, /public\/setup/);
  assert.doesNotMatch(build, /--from=pin_setup/);
  assert.doesNotMatch(config, /source:\s*["']\/setup(?:["'/:])/);

  // A real compose-level check.
  //
  // This was `assert.ok(typeof compose === "string")`, which is true for every
  // possible content of compose.yaml — including one whose center stage builds
  // and copies the SPA. It sat directly under a comment about `pin_setup`
  // stages, at the end of the test guarding a root-shell-in-a-static-bundle
  // outage, so it read as compose coverage while covering nothing. The property
  // the comment described was in fact already enforced one line up, on the
  // Dockerfile, which is where stage consumption happens.
  //
  // So assert the thing itself: compose.yaml declares no `pin_setup` context and
  // no build stage takes ./pin/setup as one. Comments are stripped first for the
  // same reason as above — this file names the paths on purpose.
  const services = withoutComments(compose, "#");
  assert.doesNotMatch(services, /pin_setup/);
  assert.doesNotMatch(services, /context:\s*\.\/pin\/setup/);

  // Scope, stated rather than implied: every check in this test is NAME-specific
  // (`dist-setup`, `public/setup`, `--from=pin_setup`, `/setup`, `pin_setup`). A
  // stage that builds the same SPA under a different context name and copies it
  // in under a different path passes all of them. What is closed here is the
  // exact door that was open, not the class of door.
});
