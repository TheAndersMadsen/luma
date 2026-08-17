// Registers the resolve hook that lets src/server/pin-releases.ts reach its own
// extensionless sibling import (`./log`) under Node's type stripping. Static, so
// it is evaluated before the dynamic import below.
import "./tsResolve.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const {
  PIN_RELEASE_PACKAGE_BY_ROLE,
  PIN_RELEASE_ROLES,
  computePinReleaseId,
  parsePinReleaseManifest,
  pinReleaseVerificationStats,
  serializePinReleaseManifest,
  serveCurrentPinRelease,
  servePinReleaseArtifact,
  servePinReleaseOptions,
} = await import("../src/server/pin-releases.ts?pin-release-serving-test");

// No query string: this has to be the SAME module instance pin-releases.ts
// logs through, and a query would make a second one whose sink nobody uses.
const { setLogSinkForTests } = await import("../src/server/log.ts");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function createStore(context) {
  const root = await mkdtemp(path.join(tmpdir(), "revival-pin-releases-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function publishRelease(
  root,
  { seed = "one", version = "2026-08-09.1", versionCode = 101, current = true } = {},
) {
  const bytesByRole = new Map(
    PIN_RELEASE_ROLES.map((role) => [role, Buffer.from(`synthetic-${seed}-${role}-apk`)]),
  );
  const identities = PIN_RELEASE_ROLES.map((role) => {
    const bytes = bytesByRole.get(role);
    return {
      role,
      name: `Penumbra-${seed}-${role}.apk`,
      package: PIN_RELEASE_PACKAGE_BY_ROLE[role],
      versionCode,
      size: bytes.length,
      sha256: sha256(bytes),
    };
  });
  const releaseId = computePinReleaseId({
    schemaVersion: 1,
    version,
    artifacts: identities,
  });
  const manifest = {
    schemaVersion: 1,
    releaseId,
    version,
    artifacts: identities.map((artifact) => ({
      role: artifact.role,
      url: `./${releaseId}/${artifact.role}.apk`,
      name: artifact.name,
      package: artifact.package,
      versionCode: artifact.versionCode,
      size: artifact.size,
      sha256: artifact.sha256,
    })),
  };
  const document = serializePinReleaseManifest(manifest);
  const releaseDirectory = path.join(root, "releases", releaseId);
  await mkdir(releaseDirectory, { recursive: true });
  await Promise.all(
    manifest.artifacts.map((artifact) =>
      writeFile(path.join(releaseDirectory, artifact.name), bytesByRole.get(artifact.role)),
    ),
  );
  await writeFile(path.join(releaseDirectory, "manifest.json"), document);
  if (current) await writeFile(path.join(root, "current.json"), document);
  return { releaseId, manifest, document, bytesByRole, releaseDirectory };
}

function environment(root, origin) {
  return {
    REVIVAL_PIN_RELEASE_DIR: root,
    ...(origin ? { REVIVAL_PIN_SETUP_ORIGIN: origin } : {}),
  };
}

test("current Pin release is canonical, complete, hardened, and same-origin compatible", async (t) => {
  const root = await createStore(t);
  const release = await publishRelease(root);
  const response = await serveCurrentPinRelease(
    new Request("https://carry.example.test/api/pin/releases/current"),
    { environment: environment(root) },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(release.document)));
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const document = await response.text();
  assert.equal(document, release.document);
  assert.equal(document.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(document), release.manifest);
  for (const artifact of release.manifest.artifacts) {
    assert.equal(
      new URL(artifact.url, "https://carry.example.test/api/pin/releases/current").pathname,
      `/api/pin/releases/${release.releaseId}/${artifact.role}.apk`,
    );
  }
});

test("APK downloads use immutable role URLs, exact lengths, and streaming bodies", async (t) => {
  const root = await createStore(t);
  const first = await publishRelease(root, { seed: "first", versionCode: 101 });
  await publishRelease(root, {
    seed: "second",
    version: "2026-08-09.2",
    versionCode: 102,
  });

  const url = `https://carry.example.test/api/pin/releases/${first.releaseId}/installer.apk`;
  const response = await servePinReleaseArtifact(
    new Request(url),
    first.releaseId,
    "installer.apk",
    { environment: environment(root) },
  );
  const expected = first.bytesByRole.get("installer");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/vnd.android.package-archive");
  assert.equal(response.headers.get("content-length"), String(expected.length));
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.ok(response.body instanceof ReadableStream);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);

  const head = await servePinReleaseArtifact(
    new Request(url, { method: "HEAD" }),
    first.releaseId,
    "installer.apk",
    { environment: environment(root), head: true },
  );
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(head.headers.get("content-length"), String(expected.length));
});

test("schema v1 rejects unknown fields, unsafe names, identity drift, and role drift", async (t) => {
  const root = await createStore(t);
  const release = await publishRelease(root);
  const baseline = JSON.parse(release.document);
  const rejected = (mutate) => {
    const candidate = structuredClone(baseline);
    mutate(candidate);
    assert.throws(() => parsePinReleaseManifest(candidate), /Pin release unavailable/);
  };

  rejected((candidate) => {
    candidate.sample = true;
  });
  rejected((candidate) => {
    candidate.schemaVersion = 2;
  });
  rejected((candidate) => {
    candidate.version = "2026-02-30.1";
  });
  rejected((candidate) => {
    candidate.releaseId = candidate.releaseId.toUpperCase();
  });
  rejected((candidate) => {
    candidate.artifacts[0].debug = true;
  });
  rejected((candidate) => {
    candidate.artifacts[0].name = "../outside.apk";
  });
  rejected((candidate) => {
    candidate.artifacts[0].package = "com.example.substitute";
  });
  rejected((candidate) => {
    candidate.artifacts[0].url = `./${candidate.releaseId}/${candidate.artifacts[0].name}`;
  });
  rejected((candidate) => {
    candidate.artifacts[1].role = candidate.artifacts[0].role;
  });
  rejected((candidate) => {
    candidate.artifacts[1].versionCode += 1;
  });
  rejected((candidate) => {
    candidate.artifacts[0].size = 0;
  });
  rejected((candidate) => {
    candidate.artifacts[0].sha256 = candidate.artifacts[0].sha256.toUpperCase();
  });
  rejected((candidate) => {
    candidate.artifacts[0].sha256 = "0".repeat(64);
  });
});

test("corrupt or symlinked release state fails closed without leaking disk paths", async (t) => {
  const corruptRoot = await createStore(t);
  const corrupt = await publishRelease(corruptRoot);
  const installer = corrupt.manifest.artifacts.find((artifact) => artifact.role === "installer");
  await writeFile(path.join(corrupt.releaseDirectory, installer.name), "changed-after-publish");

  const corruptResponse = await servePinReleaseArtifact(
    new Request(
      `https://carry.example.test/api/pin/releases/${corrupt.releaseId}/installer.apk`,
    ),
    corrupt.releaseId,
    "installer.apk",
    { environment: environment(corruptRoot) },
  );
  assert.equal(corruptResponse.status, 503);
  assert.equal(await corruptResponse.text(), '{"error":"Pin release unavailable."}');
  assert.equal((await serveCurrentPinRelease(
    new Request("https://carry.example.test/api/pin/releases/current"),
    { environment: environment(corruptRoot) },
  )).status, 503);

  const symlinkRoot = await createStore(t);
  const symlinked = await publishRelease(symlinkRoot, { seed: "symlink" });
  const linkedArtifact = symlinked.manifest.artifacts[0];
  const outside = path.join(path.dirname(symlinkRoot), `outside-${symlinked.releaseId}.apk`);
  t.after(() => rm(outside, { force: true }));
  await writeFile(outside, symlinked.bytesByRole.get(linkedArtifact.role));
  await unlink(path.join(symlinked.releaseDirectory, linkedArtifact.name));
  await symlink(outside, path.join(symlinked.releaseDirectory, linkedArtifact.name));
  const symlinkResponse = await servePinReleaseArtifact(
    new Request(
      `https://carry.example.test/api/pin/releases/${symlinked.releaseId}/installer.apk`,
    ),
    symlinked.releaseId,
    "installer.apk",
    { environment: environment(symlinkRoot) },
  );
  assert.equal(symlinkResponse.status, 503);
  assert.doesNotMatch(await symlinkResponse.text(), new RegExp(symlinkRoot.replaceAll("/", "\\/")));

  await unlink(path.join(symlinkRoot, "current.json"));
  await symlink(
    path.join(symlinked.releaseDirectory, "manifest.json"),
    path.join(symlinkRoot, "current.json"),
  );
  assert.equal((await serveCurrentPinRelease(
    new Request("https://carry.example.test/api/pin/releases/current"),
    { environment: environment(symlinkRoot) },
  )).status, 503);
});

test("unconfigured stores and malformed immutable paths return bounded 404 responses", async (t) => {
  const absent = await serveCurrentPinRelease(
    new Request("https://carry.example.test/api/pin/releases/current"),
    { environment: {} },
  );
  assert.equal(absent.status, 404);
  assert.equal(await absent.text(), '{"error":"Pin release not found."}');

  const emptyRoot = await createStore(t);
  assert.equal((await serveCurrentPinRelease(
    new Request("https://carry.example.test/api/pin/releases/current"),
    { environment: environment(emptyRoot) },
  )).status, 404);

  for (const [releaseId, asset] of [
    ["../current.json", "installer.apk"],
    ["a".repeat(64), "../installer.apk"],
    ["a".repeat(64), "unknown.apk"],
  ]) {
    const response = await servePinReleaseArtifact(
      new Request("https://carry.example.test/api/pin/releases/bad/unknown.apk"),
      releaseId,
      asset,
      { environment: environment(emptyRoot) },
    );
    assert.equal(response.status, 404);
    assert.ok(Number(response.headers.get("content-length")) < 128);
  }
});

/*
 * The public release surface must not be a hashing service.
 *
 * `/api/pin/releases/current` is reachable with no session (middleware lets
 * `isPublicPinReleaseRequest` through), is `force-dynamic`, and used to
 * stream-SHA256 every artifact in the store on every GET — with a 202 MB
 * server.apk published that is hundreds of megabytes of disk read per anonymous
 * request, on the box that also serves the dashboard.
 *
 * The fix may not become "stop verifying". These two tests are a pair and only
 * mean anything together: the sweep runs once for a given set of files, AND any
 * change to those files re-runs it before the manifest is served again.
 */
test("a verified release is not re-hashed on every public request", async (t) => {
  const root = await createStore(t);
  const release = await publishRelease(root, { seed: "cached" });
  const request = () =>
    serveCurrentPinRelease(
      new Request("https://carry.example.test/api/pin/releases/current"),
      { environment: environment(root) },
    );

  const before = pinReleaseVerificationStats();
  assert.equal((await request()).status, 200);
  const verified = pinReleaseVerificationStats();
  assert.equal(verified.verifications, before.verifications + 1);
  assert.ok(
    verified.hashedBytes > before.hashedBytes,
    "the first load must hash the artifacts it vouches for",
  );

  const second = await request();
  assert.equal(second.status, 200);
  assert.equal(await second.text(), release.document);
  assert.deepEqual(
    pinReleaseVerificationStats(),
    verified,
    "a second GET re-hashed the whole store; an anonymous client can force that at will",
  );

  // The artifact download reuses the same verdict — it is the same file, proven
  // by the same identity — so a 202 MB APK costs one stream, not a stream plus a
  // full re-hash.
  const installer = release.manifest.artifacts.find((artifact) => artifact.role === "installer");
  const download = await servePinReleaseArtifact(
    new Request(`https://carry.example.test/api/pin/releases/${release.releaseId}/installer.apk`),
    release.releaseId,
    "installer.apk",
    { environment: environment(root) },
  );
  assert.equal(download.status, 200);
  assert.deepEqual(
    Buffer.from(await download.arrayBuffer()),
    release.bytesByRole.get("installer"),
  );
  assert.deepEqual(pinReleaseVerificationStats(), verified);

  // Same length, different bytes: nothing about the manifest changes, so only
  // the stat identity can catch this. If the cache ever keys on the path alone,
  // this is the assertion that fails.
  await writeFile(
    path.join(release.releaseDirectory, installer.name),
    Buffer.alloc(installer.size, 0x41),
  );
  const tampered = await request();
  assert.equal(tampered.status, 503);
  assert.equal(await tampered.text(), '{"error":"Pin release unavailable."}');
  assert.ok(
    pinReleaseVerificationStats().hashedBytes > verified.hashedBytes,
    "a changed artifact must be re-hashed, not served from a stale verdict",
  );
});

test("one opaque sentence on the wire, one distinct reason in the log", async (t) => {
  const root = await createStore(t);
  const release = await publishRelease(root, { seed: "reasons" });
  const installer = release.manifest.artifacts.find((artifact) => artifact.role === "installer");
  await writeFile(path.join(release.releaseDirectory, installer.name), "changed-after-publish");

  // Read through the log module's own sink rather than by stubbing `console`:
  // `console` is not how this code reports any more, precisely because nothing
  // could prove it arrived. verify/server-logging.test.mjs proves the default
  // sink puts these same lines on the process's stderr.
  const warnings = [];
  setLogSinkForTests((level, line) => warnings.push(`${level} ${line.trimEnd()}`));
  let unconfigured;
  let corrupt;
  try {
    unconfigured = await serveCurrentPinRelease(
      new Request("https://carry.example.test/api/pin/releases/current"),
      { environment: {} },
    );
    corrupt = await serveCurrentPinRelease(
      new Request("https://carry.example.test/api/pin/releases/current"),
      { environment: environment(root) },
    );
  } finally {
    setLogSinkForTests(null);
  }

  // The wire answer stays exactly what it was: this route is unauthenticated and
  // must not narrate the store's internals to the internet.
  assert.equal(unconfigured.status, 404);
  assert.equal(await unconfigured.text(), '{"error":"Pin release not found."}');
  assert.equal(corrupt.status, 503);
  assert.equal(await corrupt.text(), '{"error":"Pin release unavailable."}');

  // …and the operator gets the two causes apart. Both used to be one sentence
  // with no log line at all: ~57 causes, one answer, empty container logs.
  assert.equal(warnings.length, 2, warnings.join("\n"));
  assert.match(warnings[0], /release_dir_unset/);
  assert.match(warnings[1], /artifact_(size_mismatch|sha256_mismatch)/);
  assert.notEqual(warnings[0], warnings[1]);
  for (const warning of warnings) {
    assert.doesNotMatch(warning, new RegExp(root.replaceAll("/", "\\/")));
  }
});

test("CORS is absent by default and exact for one configured Setup origin", async (t) => {
  const root = await createStore(t);
  await publishRelease(root);
  const setupOrigin = "https://setup.example.test";
  const allowedEnvironment = environment(root, setupOrigin);
  const allowed = await serveCurrentPinRelease(
    new Request("https://carry.example.test/api/pin/releases/current", {
      headers: { origin: setupOrigin },
    }),
    { environment: allowedEnvironment },
  );
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), setupOrigin);
  assert.equal(
    allowed.headers.get("access-control-expose-headers"),
    "Content-Length, Content-Type",
  );
  assert.notEqual(allowed.headers.get("access-control-allow-origin"), "*");

  const sameOrigin = await serveCurrentPinRelease(
    new Request("https://carry.example.test/api/pin/releases/current", {
      headers: { origin: "https://carry.example.test" },
    }),
    { environment: allowedEnvironment },
  );
  assert.equal(sameOrigin.status, 200);

  const rejected = await serveCurrentPinRelease(
    new Request("https://carry.example.test/api/pin/releases/current", {
      headers: { origin: "https://attacker.example" },
    }),
    { environment: allowedEnvironment },
  );
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.has("access-control-allow-origin"), false);

  const preflight = servePinReleaseOptions(
    new Request("https://carry.example.test/api/pin/releases/current", {
      method: "OPTIONS",
      headers: {
        origin: setupOrigin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "Accept",
      },
    }),
    allowedEnvironment,
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), setupOrigin);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
  assert.equal(preflight.headers.get("access-control-allow-headers"), "Accept");

  const mutationPreflight = servePinReleaseOptions(
    new Request("https://carry.example.test/api/pin/releases/current", {
      method: "OPTIONS",
      headers: {
        origin: setupOrigin,
        "access-control-request-method": "POST",
      },
    }),
    allowedEnvironment,
  );
  assert.equal(mutationPreflight.status, 403);

  const wildcard = await serveCurrentPinRelease(
    new Request("https://carry.example.test/api/pin/releases/current"),
    { environment: environment(root, "*") },
  );
  assert.equal(wildcard.status, 503);
  assert.equal(wildcard.headers.has("access-control-allow-origin"), false);
});
