import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createReleaseDescriptor,
  IMAGE_NAMES,
  IMAGE_PLATFORMS,
} from "../../distribution/release-descriptor.mjs";
import {
  expectedReleaseWorkflowIdentity,
  fetchPublishedReleaseAsset,
  publishedReleaseProofUrls,
  RELEASE_PROOF_POLICY,
  releaseProofBundleName,
  resolvePublishedReleaseAssets,
  verifyReleaseDescriptorProof,
  verifyPublishedReleaseBinding,
} from "../../distribution/release-proof.mjs";

const TAG = "v1.2.3";

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function descriptorFixture() {
  const images = {};
  IMAGE_NAMES.forEach((name, index) => {
    const imageDigest = digest(String(index + 1));
    images[name] = {
      schemaVersion: 2,
      name,
      reference: `ghcr.io/theandersmadsen/ai-pin-revival/${name}@${imageDigest}`,
      digest: imageDigest,
      platforms: IMAGE_PLATFORMS,
    };
  });
  const applicationDigest = digest("a");
  return createReleaseDescriptor({
    version: TAG.slice(1),
    revision: "b".repeat(40),
    repository: RELEASE_PROOF_POLICY.repository,
    tag: TAG,
    application: {
      schemaVersion: 1,
      reference: `oci://ghcr.io/theandersmadsen/ai-pin-revival/application@${applicationDigest}`,
      digest: applicationDigest,
    },
    images,
    operator: {
      archive: `ai-pin-revival-operator-${TAG.slice(1)}-linux.tar.gz`,
      sha256: "c".repeat(64),
      size: 123_456,
    },
    pin: {
      schemaVersion: 1,
      archive: "ai-pin-revival-pin-2026-08-31.2.tar.gz",
      sha256: "d".repeat(64),
      size: 123_456,
      releaseId: "e".repeat(64),
      version: "2026-08-31.2",
      versionCode: 202_608_312,
      signerSha256: "f".repeat(64),
      manifestSha256: "1".repeat(64),
      receiptsSha256: "2".repeat(64),
    },
  });
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `missing verifier argument ${name}`);
  return args[index + 1];
}

async function proofFixture(t, proofOverrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "release-proof-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const descriptorPath = join(directory, "release.json");
  const bundlePath = join(directory, "release.sigstore.json");
  const descriptorBytes = Buffer.from(`${JSON.stringify(descriptorFixture())}\n`);
  const proof = {
    issuer: RELEASE_PROOF_POLICY.oidcIssuer,
    identity: expectedReleaseWorkflowIdentity(TAG),
    repository: RELEASE_PROOF_POLICY.repository,
    workflowName: RELEASE_PROOF_POLICY.workflowName,
    ref: `refs/tags/${TAG}`,
    event: RELEASE_PROOF_POLICY.event,
    sha256: createHash("sha256").update(descriptorBytes).digest("hex"),
    ...proofOverrides,
  };
  await Promise.all([
    writeFile(descriptorPath, descriptorBytes),
    writeFile(bundlePath, `${JSON.stringify(proof)}\n`),
  ]);
  return { descriptorPath, bundlePath, descriptorBytes };
}

async function fixtureVerifier({ executable, arguments: args }) {
  assert.equal(executable, "/pinned/cosign");
  assert.equal(args[0], "verify-blob");
  const descriptorPath = args.at(-1);
  const bundlePath = argumentValue(args, "--bundle");
  const proof = JSON.parse(await readFile(bundlePath, "utf8"));
  const actual = {
    issuer: argumentValue(args, "--certificate-oidc-issuer"),
    identity: argumentValue(args, "--certificate-identity"),
    repository: argumentValue(args, "--certificate-github-workflow-repository"),
    workflowName: argumentValue(args, "--certificate-github-workflow-name"),
    ref: argumentValue(args, "--certificate-github-workflow-ref"),
    event: argumentValue(args, "--certificate-github-workflow-trigger"),
    sha256: createHash("sha256").update(await readFile(descriptorPath)).digest("hex"),
  };
  assert.deepEqual(proof, actual, "fixture proof rejected the requested identity or descriptor bytes");
}

function verifyOptions(fixture) {
  return {
    ...fixture,
    expectedTag: TAG,
    provisionVerifier: async () => "/pinned/cosign",
    executeVerifier: fixtureVerifier,
  };
}

function embeddedBinding(descriptor = descriptorFixture()) {
  return {
    schemaVersion: 2,
    version: descriptor.version,
    source: descriptor.source,
    pin: descriptor.pin,
  };
}

function publishedFetch(descriptor, proofOverrides = {}, requested = []) {
  const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor)}\n`);
  const proof = {
    issuer: RELEASE_PROOF_POLICY.oidcIssuer,
    identity: expectedReleaseWorkflowIdentity(TAG),
    repository: RELEASE_PROOF_POLICY.repository,
    workflowName: RELEASE_PROOF_POLICY.workflowName,
    ref: `refs/tags/${TAG}`,
    event: RELEASE_PROOF_POLICY.event,
    sha256: createHash("sha256").update(descriptorBytes).digest("hex"),
    ...proofOverrides,
  };
  const urls = publishedReleaseProofUrls(descriptor.version);
  const names = {
    descriptor: new URL(urls.descriptor).pathname.split("/").at(-1),
    bundle: new URL(urls.bundle).pathname.split("/").at(-1),
  };
  const assets = [
    {
      id: 101,
      name: names.descriptor,
      size: descriptorBytes.length,
      url: `https://api.github.com/repos/${RELEASE_PROOF_POLICY.repository}/releases/assets/101`,
      browser_download_url: urls.descriptor,
    },
    {
      id: 102,
      name: names.bundle,
      size: Buffer.byteLength(`${JSON.stringify(proof)}\n`),
      url: `https://api.github.com/repos/${RELEASE_PROOF_POLICY.repository}/releases/assets/102`,
      browser_download_url: urls.bundle,
    },
  ];
  const releaseUrl = `https://api.github.com/repos/${RELEASE_PROOF_POLICY.repository}/releases/tags/${TAG}`;
  const responses = new Map([
    [releaseUrl, Buffer.from(`${JSON.stringify({ tag_name: TAG, draft: false, assets })}\n`)],
    [assets[0].url, descriptorBytes],
    [assets[1].url, Buffer.from(`${JSON.stringify(proof)}\n`)],
  ]);
  return async (url) => {
    const selected = String(url);
    requested.push(selected);
    const bytes = responses.get(selected);
    return bytes
      ? new Response(bytes, { status: 200 })
      : new Response("missing", { status: 404 });
  };
}

function publishedRequestUrls(descriptor) {
  return [
    `https://api.github.com/repos/${RELEASE_PROOF_POLICY.repository}/releases/tags/${TAG}`,
    `https://api.github.com/repos/${RELEASE_PROOF_POLICY.repository}/releases/assets/101`,
    `https://api.github.com/repos/${RELEASE_PROOF_POLICY.repository}/releases/assets/102`,
  ];
}

test("release proof accepts exact bytes from the expected GitHub release workflow", async (t) => {
  const fixture = await proofFixture(t);
  const descriptor = await verifyReleaseDescriptorProof(verifyOptions(fixture));
  assert.equal(descriptor.version, TAG.slice(1));
  assert.deepEqual(descriptor.source, {
    repository: RELEASE_PROOF_POLICY.repository,
    tag: TAG,
  });
  assert.equal(releaseProofBundleName(descriptor.version), "ai-pin-revival-1.2.3.release.sigstore.json");
});

test("release proof pins one supported Cosign build for each production architecture", async () => {
  assert.equal(RELEASE_PROOF_POLICY.verifier.version, "v3.1.3");
  assert.deepEqual(Object.keys(RELEASE_PROOF_POLICY.verifier.platforms).sort(), [
    "linux/arm64",
    "linux/x64",
  ]);
  for (const artifact of Object.values(RELEASE_PROOF_POLICY.verifier.platforms)) {
    assert.match(artifact.name, /^cosign-linux-(?:amd64|arm64)$/u);
    assert.ok(Number.isSafeInteger(artifact.size) && artifact.size > 100_000_000);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/u);
  }
});

test("release workflow creates and publishes the identity-verified Sigstore bundle", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/release-cli.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /^      id-token: write$/mu);
  assert.match(
    workflow,
    /sigstore\/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6 # v4\.1\.2/u,
  );
  assert.match(workflow, /^          cosign-release: v3\.1\.3$/mu);
  assert.match(workflow, /cosign sign-blob --yes --bundle "\$bundle" "\$descriptor"/u);
  assert.match(workflow, /--certificate-oidc-issuer 'https:\/\/token\.actions\.githubusercontent\.com'/u);
  assert.match(workflow, /--certificate-identity "\$identity"/u);
  assert.match(workflow, /--certificate-github-workflow-repository "\$GITHUB_REPOSITORY"/u);
  assert.match(workflow, /--certificate-github-workflow-name 'immutable release'/u);
  assert.match(workflow, /--certificate-github-workflow-ref "\$GITHUB_REF"/u);
  assert.match(workflow, /--certificate-github-workflow-trigger push/u);
  assert.ok(
    workflow.match(/ai-pin-revival-\$RELEASE_VERSION\.release\.sigstore\.json/gu)?.length >= 3,
    "the proof bundle must be created, uploaded, and included in exact remote verification",
  );
  assert.doesNotMatch(workflow, /--insecure-ignore-(?:sct|tlog)/u);
});

test("server releases republish one exact verified signed Pin archive", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/release-cli.yml", import.meta.url),
    "utf8",
  );
  const pinJob = workflow.match(/^  pin-release:\n[\s\S]*?^  images:/mu)?.[0];
  assert.ok(pinJob, "release workflow must contain the bounded Pin release job");
  assert.match(pinJob, /name: acquire exact signed Pin release/u);
  assert.match(pinJob, /signedReleaseSource\.repository/u);
  assert.match(pinJob, /signedReleaseSource\.tag/u);
  assert.match(pinJob, /signedReleaseSource\.sha256/u);
  assert.match(pinJob, /signedReleaseSource\.releaseId/u);
  assert.match(pinJob, /describePinReleaseArchive/u);
  assert.match(pinJob, /name: release-pin/u);
  assert.match(pinJob, /path: \$\{\{ runner\.temp \}\}\/release-pin\//u);
  assert.doesNotMatch(pinJob, /privateAssetSource|platform\/deploy\/pin\/(?:build|export-release)\.mjs/u);
  assert.doesNotMatch(pinJob, /PIN_(?:COMPATIBILITY_KEYSTORE|SIGNING|EMBEDDED_PATCH_KEYSTORE|TFLITE_LIBRARY)/u);
});

test("release proof rejects a certificate from the wrong OIDC issuer", async (t) => {
  const fixture = await proofFixture(t, { issuer: "https://issuer.invalid" });
  await assert.rejects(
    verifyReleaseDescriptorProof(verifyOptions(fixture)),
    /fixture proof rejected/u,
  );
});

test("release proof rejects a certificate from the wrong GitHub repository", async (t) => {
  const fixture = await proofFixture(t, {
    identity: expectedReleaseWorkflowIdentity(TAG).replace(
      RELEASE_PROOF_POLICY.repository,
      "attacker/ai-pin-revival",
    ),
    repository: "attacker/ai-pin-revival",
  });
  await assert.rejects(
    verifyReleaseDescriptorProof(verifyOptions(fixture)),
    /fixture proof rejected/u,
  );
});

test("release proof rejects a certificate from the wrong GitHub workflow", async (t) => {
  const fixture = await proofFixture(t, {
    identity: expectedReleaseWorkflowIdentity(TAG).replace(
      RELEASE_PROOF_POLICY.workflowPath,
      ".github/workflows/untrusted.yml",
    ),
  });
  await assert.rejects(
    verifyReleaseDescriptorProof(verifyOptions(fixture)),
    /fixture proof rejected/u,
  );
});

test("release proof rejects descriptor bytes changed after signing", async (t) => {
  const fixture = await proofFixture(t);
  await writeFile(fixture.descriptorPath, Buffer.concat([fixture.descriptorBytes, Buffer.from(" ")]));
  await assert.rejects(
    verifyReleaseDescriptorProof(verifyOptions(fixture)),
    /fixture proof rejected/u,
  );
});

test("release coordinates are validated only after the byte proof succeeds", async (t) => {
  const fixture = await proofFixture(t);
  const untrusted = JSON.parse(fixture.descriptorBytes.toString("utf8"));
  untrusted.source.repository = "attacker/ai-pin-revival";
  const changedBytes = Buffer.from(`${JSON.stringify(untrusted)}\n`);
  await writeFile(fixture.descriptorPath, changedBytes);
  const proof = JSON.parse(await readFile(fixture.bundlePath, "utf8"));
  proof.sha256 = createHash("sha256").update(changedBytes).digest("hex");
  await writeFile(fixture.bundlePath, `${JSON.stringify(proof)}\n`);

  let proofCompleted = false;
  await assert.rejects(
    verifyReleaseDescriptorProof({
      ...verifyOptions(fixture),
      executeVerifier: async (options) => {
        await fixtureVerifier(options);
        proofCompleted = true;
      },
    }),
    /does not match the expected repository and tag/u,
  );
  assert.equal(proofCompleted, true, "coordinates must not be consumed before proof verification");
});

test("published binding fetches proof only from the hardcoded repository", async () => {
  const descriptor = descriptorFixture();
  const requested = [];
  const verified = await verifyPublishedReleaseBinding({
    embedded: embeddedBinding(descriptor),
    fetchImpl: publishedFetch(descriptor, {}, requested),
    provisionVerifier: async () => "/pinned/cosign",
    executeVerifier: fixtureVerifier,
  });
  assert.deepEqual(requested.sort(), publishedRequestUrls(descriptor).sort());
  assert.deepEqual(verified.source, descriptor.source);
  assert.deepEqual(verified.pin, descriptor.pin);
});

test("published binding authenticates private release proof downloads without exposing the token", async () => {
  const descriptor = descriptorFixture();
  const fetchFixture = publishedFetch(descriptor);
  const verified = await verifyPublishedReleaseBinding({
    embedded: embeddedBinding(descriptor),
    githubToken: "fixture-private-token",
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.authorization, "Bearer fixture-private-token");
      assert.equal(options.headers["x-github-api-version"], "2022-11-28");
      assert.ok([
        "application/vnd.github+json",
        "application/octet-stream",
      ].includes(options.headers.accept));
      return fetchFixture(url, options);
    },
    provisionVerifier: async () => "/pinned/cosign",
    executeVerifier: fixtureVerifier,
  });
  assert.equal(verified.version, descriptor.version);
});

test("GitHub asset redirects drop the private token before reaching signed object storage", async () => {
  const calls = [];
  const body = Buffer.from("verified asset");
  const response = await fetchPublishedReleaseAsset({
    asset: {
      name: "asset.bin",
      size: body.length,
      url: `https://api.github.com/repos/${RELEASE_PROOF_POLICY.repository}/releases/assets/77`,
    },
    githubToken: "fixture-private-token",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), headers: options.headers });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://release-assets.githubusercontent.com/objects/asset.bin" },
        });
      }
      return new Response(body, { status: 200 });
    },
  });
  assert.equal(Buffer.from(await response.arrayBuffer()).toString("utf8"), "verified asset");
  assert.equal(calls[0].headers.authorization, "Bearer fixture-private-token");
  assert.equal(calls[1].headers, undefined);
});

test("GitHub release metadata cannot redirect an expected name to a foreign browser asset", async () => {
  await assert.rejects(
    resolvePublishedReleaseAssets({
      tag: TAG,
      names: ["asset.bin"],
      fetchImpl: async () => new Response(JSON.stringify({
        tag_name: TAG,
        draft: false,
        assets: [{
          id: 77,
          name: "asset.bin",
          size: 10,
          url: `https://api.github.com/repos/${RELEASE_PROOF_POLICY.repository}/releases/assets/77`,
          browser_download_url: "https://attacker.invalid/asset.bin",
        }],
      }), { status: 200 }),
    }),
    /asset\.bin metadata is invalid/u,
  );
});

test("published binding exposes no Pin coordinates when descriptor proof fails", async () => {
  const descriptor = descriptorFixture();
  const requested = [];
  await assert.rejects(
    verifyPublishedReleaseBinding({
      embedded: embeddedBinding(descriptor),
      fetchImpl: publishedFetch(descriptor, { issuer: "https://issuer.invalid" }, requested),
      provisionVerifier: async () => "/pinned/cosign",
      executeVerifier: fixtureVerifier,
    }),
    /fixture proof rejected/u,
  );
  assert.deepEqual(requested.sort(), publishedRequestUrls(descriptor).sort());
  assert.ok(requested.every((url) => !url.endsWith(descriptor.pin.archive)));
});

test("published binding rejects validly proved coordinates that differ from the operator", async () => {
  const embeddedDescriptor = descriptorFixture();
  const remoteDescriptor = JSON.parse(JSON.stringify(embeddedDescriptor));
  remoteDescriptor.pin.releaseId = "9".repeat(64);
  await assert.rejects(
    verifyPublishedReleaseBinding({
      embedded: embeddedBinding(embeddedDescriptor),
      fetchImpl: publishedFetch(remoteDescriptor),
      provisionVerifier: async () => "/pinned/cosign",
      executeVerifier: fixtureVerifier,
    }),
    /does not match the embedded operator release binding/u,
  );
});
