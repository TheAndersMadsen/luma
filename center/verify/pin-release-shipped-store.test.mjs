// Registers the resolve hook that lets src/server/pin-releases.ts reach its own
// extensionless sibling import (`./log`) under Node's type stripping.
import "./tsResolve.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { publishPinReleaseFixture } from "../../platform/deploy/pin/build.mjs";
import {
  createLocalTransport,
  shipPinReleaseFixture as shipPinRelease,
} from "../../platform/deploy/pin/ship.mjs";

const {
  PIN_RELEASE_PACKAGE_BY_ROLE,
  PIN_RELEASE_ROLES,
  serveCurrentPinRelease,
  servePinReleaseArtifact,
} = await import("../src/server/pin-releases.ts?pin-release-shipped-store-test");

/*
 * The gap this closes, stated as a test.
 *
 * `./revival pin release build` published five signed APKs into a store on the
 * operator's machine. Center serves a store of exactly that shape from
 * REVIVAL_PIN_RELEASE_DIR. Nothing connected the two, so the in-browser
 * installer's very first request — GET /api/pin/releases/current — answered 404
 * on a healthy, fully deployed server, and both the canary and the staging
 * smoke were written to accept that 404.
 *
 * So the assertion that matters is not "the ship wrote some files". It is that
 * the bytes the ship leaves behind are bytes CENTER accepts: same canonical
 * manifest, same per-artifact digests, same release identity — verified here by
 * Center's own serving module, not by the shipper's opinion of itself.
 */

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const SIGNER = "d8a64e1c3a1afdc340c4b86feaacb88e2d81d66972afbd58e743b7c5b8d1cbdb";
process.env.REVIVAL_PIN_ENABLE_TEST_FIXTURES = "1";

function helpersAvailable() {
  return ["bash", "python3"].every(
    (executable) => spawnSync(executable, ["--version"], { encoding: "utf8" }).status === 0,
  );
}

/**
 * A local store in the layout `publishPinRelease` writes, built through the
 * same `release.mjs` manifest constructor so the fixture cannot describe a
 * release the publisher could never produce.
 */
async function buildLocalStore(root, { version, versionCode }) {
  const stagingRoot = `${root}-staging`;
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const bytesByRole = new Map(
    PIN_RELEASE_ROLES.map((role) => [
      role,
      Buffer.from(`synthetic-apk:${role}:${version}:${versionCode}\n`),
    ]),
  );
  const receipts = {
    schemaVersion: 1,
    artifacts: PIN_RELEASE_ROLES.map((role) => {
      const bytes = bytesByRole.get(role);
      return {
        role,
        path: `${role}.apk`,
        name: `${role}.apk`,
        package: PIN_RELEASE_PACKAGE_BY_ROLE[role],
        versionName: version,
        versionCode,
        size: bytes.length,
        sha256: sha256(bytes),
        signerSha256: SIGNER,
      };
    }),
  };
  for (const artifact of receipts.artifacts) {
    await writeFile(path.join(stagingRoot, artifact.name), bytesByRole.get(artifact.role), {
      mode: 0o600,
    });
  }
  await publishPinReleaseFixture({
    releaseRoot: root,
    stagingRoot,
    version,
    receipts,
  });
  const canonical = await readFile(path.join(root, "current.json"), "utf8");
  const manifest = JSON.parse(canonical);
  return { manifest, canonical, bytesByRole };
}

test("a store the ship produced is a store Center serves to the browser installer", async (t) => {
  if (!helpersAvailable()) {
    t.skip("bash and python3 are required to run the release-store helpers");
    return;
  }

  const workspace = await mkdtemp(path.join(tmpdir(), "revival-shipped-store-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const localRoot = path.join(workspace, "operator-store");
  const servedRoot = path.join(workspace, "served-store");
  await mkdir(localRoot, { mode: 0o700 });
  await mkdir(servedRoot, { mode: 0o700 });

  const release = await buildLocalStore(localRoot, {
    version: "2026-08-09.1",
    versionCode: 202_608_091,
  });

  // Before the ship: exactly the 404 the installer has been getting.
  const empty = await serveCurrentPinRelease(
    new Request("https://center.example.test/api/pin/releases/current"),
    { environment: { REVIVAL_PIN_RELEASE_DIR: servedRoot } },
  );
  assert.equal(empty.status, 404);

  const result = await shipPinRelease({
    releaseRoot: localRoot,
    remoteRoot: servedRoot,
    transport: createLocalTransport(),
    confirm: true,
  });
  assert.equal(result.applied, true);
  assert.equal(result.releaseId, release.manifest.releaseId);

  const environment = {
    REVIVAL_PIN_RELEASE_DIR: servedRoot,
    REVIVAL_PIN_SETUP_ORIGIN: "https://center.example.test",
  };
  const manifestResponse = await serveCurrentPinRelease(
    new Request("https://center.example.test/api/pin/releases/current", {
      headers: { origin: "https://center.example.test" },
    }),
    { environment },
  );
  assert.equal(manifestResponse.status, 200);
  assert.equal(
    manifestResponse.headers.get("access-control-allow-origin"),
    "https://center.example.test",
  );
  const document = await manifestResponse.text();
  assert.equal(document, release.canonical);
  assert.equal(
    document,
    await readFile(path.join(localRoot, "current.json"), "utf8"),
    "Center serves bytes that differ from the release the operator published",
  );

  // Every artifact URL the installer will follow resolves to the exact bytes,
  // digest-pinned by Center itself.
  for (const artifact of JSON.parse(document).artifacts) {
    const asset = new URL(
      artifact.url,
      "https://center.example.test/api/pin/releases/current",
    ).pathname.split("/").at(-1);
    const response = await servePinReleaseArtifact(
      new Request(
        `https://center.example.test/api/pin/releases/${release.manifest.releaseId}/${asset}`,
        { headers: { origin: "https://center.example.test" } },
      ),
      release.manifest.releaseId,
      asset,
      { environment },
    );
    assert.equal(response.status, 200, `${artifact.role}: ${response.status}`);
    assert.equal(
      response.headers.get("content-type"),
      "application/vnd.android.package-archive",
    );
    assert.equal(response.headers.get("content-length"), String(artifact.size));
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(sha256(body), artifact.sha256);
    assert.deepEqual(body, release.bytesByRole.get(artifact.role));
  }

  // The shipped store carries the anti-rollback history too. Center does not
  // read it, but it is what makes the NEXT ship refuse to serve something older,
  // and it must not confuse Center's strict store layout either.
  assert.equal(
    await readFile(path.join(servedRoot, "history.json"), "utf8"),
    await readFile(path.join(localRoot, "history.json"), "utf8"),
  );
});
