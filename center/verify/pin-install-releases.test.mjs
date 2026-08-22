/*
 * The release trust boundary of the Pin installer client.
 *
 * `center/src/lib/pin-install/` runs in the wearer's browser and mutates a Pin
 * over ADB: it reads a release manifest, downloads APKs, and installs them on a
 * device somebody wears on their chest. Everything between "a manifest arrived"
 * and "an APK was written to the Pin" is decided by the three modules under test
 * here, and none of it had behavioural coverage in Center — the guards lived in
 * the vitest suite of the deleted `pin/setup` SPA. This file is that suite,
 * translated to `node:test`; the ported code is byte-identical to
 * the SPA's apart from the env-var rename noted below, so the guards transfer
 * unchanged.
 *
 * Every assertion here fails closed. The classes of regression they catch:
 *
 *   Manifest shape (parsePinReleaseManifest) — a manifest is a signed-by-shape
 *   inventory of exactly five roles. Loosening it is how an attacker adds a
 *   sixth artifact, swaps one role's package identity for another's, or ships a
 *   truncated APK past the size and SHA-256 checks that the download path later
 *   relies on. Unknown fields are rejected rather than ignored, because an
 *   ignored field is a field a future reader might start honouring.
 *
 *   Manifest provenance (resolveTrustedManifestUrl / resolveTrustedArtifactUrl)
 *   — the manifest and every artifact must come from the Setup application's own
 *   origin over HTTPS, with no fragment and no credentials. These checks run
 *   *before* the fetch, so a mis-configured manifest URL never becomes a request.
 *
 *   Monotonicity (assertMonotonicRelease) — the same immutable releaseId must
 *   always describe the same bytes, and a new releaseId must advance both the
 *   version and the versionCode. This is the anti-rollback rule: without it, a
 *   server that once shipped a fixed build can re-serve the vulnerable one. The
 *   history key deliberately ignores the query string, so cache-busting cannot
 *   be used to reset the floor, and a persisted history that cannot be read is
 *   treated as an attack rather than as "no history yet".
 *
 *   Asset integrity (downloadInstallTargetAssets) — declared length, received
 *   size, and SHA-256 must all agree with the manifest before any blob is handed
 *   to the installer. These three are the last check before bytes reach the Pin.
 *
 *   Target lock (targetLock) — one resolved release is pinned for the duration
 *   of one connection, so a multi-step install cannot silently switch releases
 *   between steps.
 */
import "./tsResolve.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

const {
  DEFAULT_PIN_RELEASE_MANIFEST_URL,
  PinReleaseError,
  createMemoryPinReleaseHistory,
  createPersistentPinReleaseHistory,
  fetchPinReleaseManifest,
  getPinReleaseManifestUrl,
  parsePinReleaseManifest,
} = await import(
  "../src/lib/pin-install/releases/manifest.ts?pin-install-releases-test"
);

const { downloadInstallTargetAssets, recognizeLegacyApkFilename, resolveInstallTarget } =
  await import("../src/lib/pin-install/releases/assets.ts?pin-install-releases-test");

const { clearTargetLock, getLockedTarget, lockResolvedInstallTarget } = await import(
  "../src/lib/pin-install/releases/targetLock.ts?pin-install-releases-test"
);

const { createResolvedInstallTargetFixture } = await import(
  "../src/lib/pin-install/releases/testFixtures.ts?pin-install-releases-test"
);

/*
 * `getPinReleaseManifestUrl()` reads its fallback at call time. Under Next that
 * is `process.env.NEXT_PUBLIC_PIN_RELEASE_MANIFEST_URL`, inlined into the client
 * bundle at build time; the SPA read `import.meta.env.VITE_…`. Production leaves
 * it unset — the same-origin default is what the deploy gates and
 * verify/public-assets.test.mjs pin — so the suite asserts that shape instead of
 * inheriting whatever the shell that ran `npm test` happened to export.
 */
delete process.env.NEXT_PUBLIC_PIN_RELEASE_MANIFEST_URL;

const RELEASE_ID = "a".repeat(64);
const NEXT_RELEASE_ID = "b".repeat(64);
const SHA256 = "c".repeat(64);
const MANIFEST_URL = "https://center.example.test/api/pin/releases/current";

const PACKAGES = {
  installer: "com.penumbraos.systeminjector",
  bootstrap: "com.penumbraos.systeminjector.exploit",
  hook: "com.penumbraos.hook",
  server: "com.penumbraos.server",
  "hook-injector": "com.penumbraos.hook.injector",
};
const ROLES = ["installer", "bootstrap", "hook", "server", "hook-injector"];

function authorityFixture(digest = "d".repeat(64)) {
  return {
    kind: "github-hosted-native-x64",
    name: "hosted-attestation.json",
    size: 1234,
    sha256: digest,
    provider: "github-actions-sigstore",
    policySha256: "1".repeat(64),
    requestSha256: "2".repeat(64),
    predicateSha256: "3".repeat(64),
    trustedRootSha256: "4".repeat(64),
    preSignBundleSha256: "5".repeat(64),
    releaseBundleSha256: "6".repeat(64),
    preSignVerificationSha256: "7".repeat(64),
    releaseVerificationSha256: "8".repeat(64),
    runnerEnvironment: "github-hosted",
    runnerLabel: "ubuntu-24.04",
    runnerArchitecture: "x64",
    runnerInvocationUri: "https://github.com/TheAndersMadsen/ai-pin-revival/actions/runs/1/attempts/1",
    repository: "TheAndersMadsen/ai-pin-revival",
    sourceRef: "refs/heads/main",
    sourceDigest: "9".repeat(40),
    sourceGenerationSha256: "a".repeat(64),
    sourceTarSha256: "b".repeat(64),
    toolchainSha256: "c".repeat(64),
    builderImageId: `sha256:${"d".repeat(64)}`,
  };
}

/** A manifest that must be accepted, so every rejection below is a one-field delta. */
function createManifest({ releaseId = RELEASE_ID, version = "2026-08-09.0", versionCode = 202_608_090 } = {}) {
  return {
    schemaVersion: 2,
    releaseId,
    version,
    artifacts: ROLES.map((role, index) => ({
      role,
      url: `./${role}.apk`,
      name: `AiPinRevival-${role}-${version}.apk`,
      package: PACKAGES[role],
      versionCode,
      size: index + 1,
      sha256: SHA256,
    })),
    authority: authorityFixture(),
  };
}

/** The narrow `FetchResponseLike` the manifest loader actually consumes. */
function response(payload, { ok = true, status = 200, statusText = "OK", url } = {}) {
  return {
    ok,
    status,
    statusText,
    url,
    async json() {
      return payload;
    },
  };
}

/**
 * `vi.fn()`'s stand-in: a callable that records its arguments. Call counts are
 * load-bearing in several cases — "did not fetch at all" is the assertion that
 * proves a URL was rejected *before* the request, not after it.
 */
function recordingFetch(implementation = async () => undefined) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ input, init });
    return implementation(input, init);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** `await expect(p).rejects.toMatchObject({ code })`, with the fields named. */
async function rejectsWith(promise, expected) {
  await assert.rejects(promise, (error) => {
    for (const [field, value] of Object.entries(expected)) {
      assert.equal(
        error?.[field],
        value,
        `expected error.${field} === ${JSON.stringify(value)}, got ${JSON.stringify(
          error?.[field],
        )} (${error?.message})`,
      );
    }
    return true;
  });
}

/** `expect(list).toContainEqual(value)` — structural membership, not identity. */
function assertContainsEqual(list, value, message) {
  assert.ok(
    list.some((entry) => isDeepStrictEqual(entry, value)),
    `${message}: ${JSON.stringify(value)} not in ${JSON.stringify(list)}`,
  );
}

/*
 * ---------------------------------------------------------------------------
 * Manifest URL configuration
 *
 * The endpoint is same-origin by default and never silently absolute: an
 * operator can point Setup at another path on the same host, and nothing else.
 * ---------------------------------------------------------------------------
 */

test("getPinReleaseManifestUrl uses the same-origin Cosmos endpoint by default", () => {
  assert.equal(getPinReleaseManifestUrl(undefined), DEFAULT_PIN_RELEASE_MANIFEST_URL);
});

test("getPinReleaseManifestUrl accepts a configured manifest URL", () => {
  assert.equal(getPinReleaseManifestUrl(" /custom/releases/current "), "/custom/releases/current");
});

/*
 * ---------------------------------------------------------------------------
 * parsePinReleaseManifest — the shape of one atomic release
 * ---------------------------------------------------------------------------
 */

test("parsePinReleaseManifest validates and normalizes the complete atomic release", () => {
  const manifest = parsePinReleaseManifest(createManifest(), MANIFEST_URL);

  assert.equal(manifest.releaseId, RELEASE_ID);
  // Roles come back in the canonical install order regardless of document order,
  // so the installer never depends on how the server happened to serialize them.
  assert.deepEqual(
    manifest.artifacts.map((artifact) => artifact.role),
    ROLES,
  );
  // Relative artifact URLs are resolved against the manifest URL, not the page.
  assert.equal(
    manifest.artifacts[0].url,
    "https://center.example.test/api/pin/releases/installer.apk",
  );
  // Frozen: the validated release is the installer's only source of truth, and
  // nothing downstream may edit a role's package, size, or hash after the fact.
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.artifacts[0]), true);
});

test("parsePinReleaseManifest rejects missing, duplicate, and unknown artifact roles", () => {
  // Missing: an install that silently skips a component leaves a half-migrated Pin.
  const missing = createManifest();
  missing.artifacts.pop();
  assert.throws(() => parsePinReleaseManifest(missing, MANIFEST_URL), PinReleaseError);

  // Duplicate: two entries claiming one role means the loser's bytes are chosen
  // by iteration order rather than by the manifest.
  const duplicate = createManifest();
  duplicate.artifacts[4] = { ...duplicate.artifacts[0] };
  assert.throws(() => parsePinReleaseManifest(duplicate, MANIFEST_URL), PinReleaseError);

  // Unknown: a role the installer has no handler for must not travel through it.
  const unknown = createManifest();
  unknown.artifacts[0].role = "firmware";
  assert.throws(() => parsePinReleaseManifest(unknown, MANIFEST_URL), PinReleaseError);
});

test("parsePinReleaseManifest rejects a sixth artifact that shadows a role", () => {
  // The count check, which the duplicate case above never reaches: that one
  // overwrites a role, so it is caught for having four distinct roles. Here all
  // five roles are present and a sixth entry is prepended, so the manifest is
  // well-formed by every other rule. It still has to be rejected, because the
  // canonical mapping resolves a role by first match — the extra installer
  // entry would be the APK installed, and the real one would sit in the
  // manifest unused, describing bytes nobody fetched.
  const manifest = createManifest();
  manifest.artifacts.unshift({
    ...manifest.artifacts[0],
    name: "AiPinRevival-installer-shadow.apk",
    sha256: "e".repeat(64),
  });
  assert.equal(manifest.artifacts.length, 6);
  assert.throws(() => parsePinReleaseManifest(manifest, MANIFEST_URL), PinReleaseError);
});

test("parsePinReleaseManifest rejects unknown fields and unsupported schema versions", () => {
  // An unrecognised field is rejected rather than dropped: today it is inert,
  // and the day something starts reading it, it is an unreviewed input.
  assert.throws(
    () => parsePinReleaseManifest({ ...createManifest(), mutable: true }, MANIFEST_URL),
    PinReleaseError,
  );
  // A newer schema is a manifest this client cannot claim to have understood.
  assert.throws(
    () => parsePinReleaseManifest({ ...createManifest(), schemaVersion: 1 }, MANIFEST_URL),
    PinReleaseError,
  );
  const missingAuthorityBinding = createManifest();
  delete missingAuthorityBinding.authority.requestSha256;
  assert.throws(
    () => parsePinReleaseManifest(missingAuthorityBinding, MANIFEST_URL),
    PinReleaseError,
  );
  const selfHosted = createManifest();
  selfHosted.authority.runnerEnvironment = "self-hosted";
  assert.throws(() => parsePinReleaseManifest(selfHosted, MANIFEST_URL), PinReleaseError);
});

test("parsePinReleaseManifest rejects bad release IDs and non-monotonic version syntax", () => {
  // The releaseId is the identity the anti-rollback history is keyed on; a
  // human-readable label like "mutable" is exactly the thing it must not be.
  assert.throws(
    () => parsePinReleaseManifest({ ...createManifest(), releaseId: "mutable" }, MANIFEST_URL),
    PinReleaseError,
  );
  // A version that does not parse cannot be compared, and an uncomparable
  // version would make every monotonicity check below vacuous.
  assert.throws(
    () => parsePinReleaseManifest({ ...createManifest(), version: "v1" }, MANIFEST_URL),
    PinReleaseError,
  );
});

test("parsePinReleaseManifest rejects package substitutions, bad sizes, and bad hashes", () => {
  // Package substitution is the whole game: the installer grants each role's
  // package specific privileges on the Pin, so a role must contain its own package.
  const packageSwap = createManifest();
  packageSwap.artifacts[0].package = PACKAGES.server;
  assert.throws(() => parsePinReleaseManifest(packageSwap, MANIFEST_URL), PinReleaseError);

  // Size 0 would make the download path's length checks trivially satisfiable.
  const badSize = createManifest();
  badSize.artifacts[0].size = 0;
  assert.throws(() => parsePinReleaseManifest(badSize, MANIFEST_URL), PinReleaseError);

  // A malformed digest must fail here, not silently never match later.
  const badHash = createManifest();
  badHash.artifacts[0].sha256 = "ABC";
  assert.throws(() => parsePinReleaseManifest(badHash, MANIFEST_URL), PinReleaseError);
});

test("parsePinReleaseManifest rejects inconsistent versionCodes within one atomic release", () => {
  // One release is one versionCode. Mixed codes are how a manifest smuggles an
  // older component into an otherwise current install.
  const manifest = createManifest();
  manifest.artifacts[1].versionCode += 1;
  assert.throws(() => parsePinReleaseManifest(manifest, MANIFEST_URL), PinReleaseError);
});

test("parsePinReleaseManifest rejects insecure absolute and cross-origin artifact URLs", () => {
  // Plaintext: the APK is about to be installed with elevated privileges.
  const insecure = createManifest();
  insecure.artifacts[0].url = "http://center.example.test/installer.apk";
  assert.throws(() => parsePinReleaseManifest(insecure, MANIFEST_URL), PinReleaseError);

  // Another origin: a manifest may not redirect the download to a host the
  // Setup application's own origin policy never vouched for.
  const crossOrigin = createManifest();
  crossOrigin.artifacts[0].url = "https://assets.example.test/installer.apk";
  assert.throws(() => parsePinReleaseManifest(crossOrigin, MANIFEST_URL), PinReleaseError);

  // A fragment is never meaningful to a fetch, so its presence means the URL was
  // constructed by something other than the release publisher.
  const fragment = createManifest();
  fragment.artifacts[0].url = "./installer.apk#unexpected";
  assert.throws(() => parsePinReleaseManifest(fragment, MANIFEST_URL), PinReleaseError);
});

/*
 * ---------------------------------------------------------------------------
 * fetchPinReleaseManifest — provenance, transport failure, and the rollback floor
 * ---------------------------------------------------------------------------
 */

test("fetchPinReleaseManifest fetches the configured endpoint without losing global fetch context", async () => {
  // `globalThis.fetch` is a browser builtin that throws "Illegal invocation" when
  // called with the wrong receiver, which is what happens if the default fetch is
  // ever destructured (`const { fetch } = globalThis`). The stub reproduces that
  // rule so the mistake fails here rather than on a wearer's device.
  const originalFetch = globalThis.fetch;
  const calls = [];
  const contextFetch = function (input) {
    if (this !== globalThis) {
      throw new TypeError("Illegal invocation");
    }
    calls.push(input);
    return Promise.resolve(response(createManifest()));
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: contextFetch,
  });

  try {
    const result = await fetchPinReleaseManifest({
      baseUrl: "https://center.example.test/setup",
      history: createMemoryPinReleaseHistory(),
    });
    assert.equal(result.manifest.version, "2026-08-09.0");
    assert.deepEqual(calls, ["/api/pin/releases/current"]);
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  }
});

test("fetchPinReleaseManifest rejects insecure absolute manifest URLs before fetching", async () => {
  const fetchImpl = recordingFetch();
  await rejectsWith(
    fetchPinReleaseManifest({
      manifestUrl: "http://center.example.test/api/pin/releases/current",
      fetchImpl,
      history: createMemoryPinReleaseHistory(),
    }),
    { code: "release-manifest-untrusted" },
  );
  // Not one request: the URL is judged before it can leak a session cookie to
  // a plaintext endpoint.
  assert.equal(fetchImpl.calls.length, 0);
});

test("fetchPinReleaseManifest rejects cross-origin and fragment manifest URLs before fetching", async () => {
  const fetchImpl = recordingFetch();
  const baseUrl = "https://center.example.test/setup/";

  await rejectsWith(
    fetchPinReleaseManifest({
      manifestUrl: "https://attacker.example.test/api/pin/releases/current",
      baseUrl,
      fetchImpl,
      history: createMemoryPinReleaseHistory(),
    }),
    { code: "release-manifest-untrusted" },
  );

  await rejectsWith(
    fetchPinReleaseManifest({
      manifestUrl: "/api/pin/releases/current#unexpected",
      baseUrl,
      fetchImpl,
      history: createMemoryPinReleaseHistory(),
    }),
    { code: "release-manifest-untrusted" },
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("fetchPinReleaseManifest rejects a manifest response that landed on another origin", async () => {
  // The two checks above judge the URL the client is about to REQUEST. This one
  // judges where the response came from, which is the only way to catch a
  // same-origin request that was redirected off-host: `redirect: "error"` is
  // asked for, but the client cannot prove the runtime honoured it, and a
  // service worker or a proxy can hand back a response from anywhere. A
  // manifest is a list of APKs to install with system privileges, so it may
  // only ever be believed from the origin Setup itself is served from.
  const common = { baseUrl: "https://center.example.test/", history: createMemoryPinReleaseHistory() };

  await rejectsWith(
    fetchPinReleaseManifest({
      ...common,
      fetchImpl: async () =>
        response(createManifest(), {
          url: "https://attacker.example.test/api/pin/releases/current",
        }),
    }),
    { code: "release-manifest-untrusted" },
  );

  // The same response, landed where it was asked for, is accepted — otherwise
  // this guard could be satisfied by rejecting every response that reports a URL.
  const landed = await fetchPinReleaseManifest({
    ...common,
    fetchImpl: async () =>
      response(createManifest(), {
        url: "https://center.example.test/api/pin/releases/current",
      }),
  });
  assert.equal(landed.manifest.releaseId, RELEASE_ID);
});

test("fetchPinReleaseManifest maps network and HTTP failures to manifest fetch errors", async () => {
  // A transport failure must arrive as a typed release error, so the installer
  // reports "could not load the release" instead of some raw TypeError that a
  // caller might mistake for a programming bug and retry through.
  const networkFetch = async () => {
    throw new Error("offline");
  };
  await rejectsWith(
    fetchPinReleaseManifest({
      fetchImpl: networkFetch,
      baseUrl: "https://center.example.test/",
      history: createMemoryPinReleaseHistory(),
    }),
    { code: "release-manifest-fetch-failed" },
  );

  const httpFetch = async () => response([], { ok: false, status: 503, statusText: "Unavailable" });
  await rejectsWith(
    fetchPinReleaseManifest({
      fetchImpl: httpFetch,
      baseUrl: "https://center.example.test/",
      history: createMemoryPinReleaseHistory(),
    }),
    { code: "release-manifest-fetch-failed", status: 503 },
  );
});

test("fetchPinReleaseManifest rejects releaseId equivocation and version or versionCode regression", async () => {
  const history = createMemoryPinReleaseHistory();
  let payload = createManifest();
  const fetchImpl = async () => response(payload);
  const options = { fetchImpl, baseUrl: "https://center.example.test/", history };

  // Same release, served twice, byte-identical: accepted both times.
  await fetchPinReleaseManifest(options);
  const repeat = await fetchPinReleaseManifest(options);
  assert.equal(repeat.manifest.releaseId, RELEASE_ID);

  // Equivocation: one immutable releaseId describing two different documents.
  // The changed field is only a filename, which is the point — any difference at
  // all means the identity was reused, so nothing about it can be trusted.
  payload = createManifest();
  payload.artifacts[0].name = "Changed-Installer.apk";
  await rejectsWith(fetchPinReleaseManifest(options), {
    code: "release-manifest-equivocation",
  });

  // Rollback: a new releaseId containing an older version and versionCode is the
  // server re-offering a build that a fix has already superseded.
  payload = createManifest({
    releaseId: NEXT_RELEASE_ID,
    version: "2026-08-08.9",
    versionCode: 202_608_089,
  });
  await rejectsWith(fetchPinReleaseManifest(options), {
    code: "release-manifest-version-regression",
  });

  // Half a rollback is still a rollback: the version string advances while the
  // versionCode — the number Android itself compares — stands still.
  payload = createManifest({
    releaseId: NEXT_RELEASE_ID,
    version: "2026-08-09.1",
    versionCode: 202_608_090,
  });
  await rejectsWith(fetchPinReleaseManifest(options), {
    code: "release-manifest-version-regression",
  });
});

test("fetchPinReleaseManifest accepts a new release only when both version dimensions increase", async () => {
  // The counterpart to the case above: the floor must not be so strict that a
  // genuine upgrade cannot land, or the guard would be removed the first time it
  // blocked a real release.
  const history = createMemoryPinReleaseHistory();
  let payload = createManifest();
  const fetchImpl = async () => response(payload);
  const options = { fetchImpl, baseUrl: "https://center.example.test/", history };

  await fetchPinReleaseManifest(options);
  payload = createManifest({
    releaseId: NEXT_RELEASE_ID,
    version: "2026-08-09.1",
    versionCode: 202_608_091,
  });
  const upgraded = await fetchPinReleaseManifest(options);
  assert.equal(upgraded.manifest.releaseId, NEXT_RELEASE_ID);
  assert.equal(upgraded.manifest.version, "2026-08-09.1");
});

test("fetchPinReleaseManifest keeps the monotonic floor across cache-busting query parameters", async () => {
  // The history key is origin + pathname. If it ever included the query string,
  // appending `?cache=<anything>` would mint a fresh, empty history and hand back
  // the rollback that the previous test just blocked.
  const history = createMemoryPinReleaseHistory();
  let payload = createManifest({
    releaseId: NEXT_RELEASE_ID,
    version: "2026-08-09.1",
    versionCode: 202_608_091,
  });
  const fetchImpl = async () => response(payload);
  const common = { fetchImpl, baseUrl: "https://center.example.test/setup/", history };

  await fetchPinReleaseManifest({
    ...common,
    manifestUrl: "/api/pin/releases/current?cache=one",
  });
  payload = createManifest();

  await rejectsWith(
    fetchPinReleaseManifest({
      ...common,
      manifestUrl: "/api/pin/releases/current?cache=two",
    }),
    { code: "release-manifest-version-regression" },
  );
});

test("fetchPinReleaseManifest fails closed when persistent release history is unavailable or corrupt", async () => {
  // No storage is not "no history yet". A browser with storage disabled — or an
  // attacker who cleared it — must not be able to install anything, because a
  // client that cannot remember what it accepted cannot detect a rollback.
  const fetchImpl = async () => response(createManifest());
  const common = { fetchImpl, baseUrl: "https://center.example.test/setup/" };

  await rejectsWith(
    fetchPinReleaseManifest({
      ...common,
      history: createPersistentPinReleaseHistory(() => null),
    }),
    { code: "release-manifest-untrusted" },
  );

  // Unparseable history is treated the same way, rather than being discarded and
  // replaced — discarding it is precisely what an attacker would want.
  await rejectsWith(
    fetchPinReleaseManifest({
      ...common,
      history: createPersistentPinReleaseHistory(() => ({
        getItem: () => "{not-json",
        setItem: () => undefined,
      })),
    }),
    { code: "release-manifest-untrusted" },
  );
});

/*
 * ---------------------------------------------------------------------------
 * assets — resolving one install target and downloading its bytes
 * ---------------------------------------------------------------------------
 */

const APK_BYTES = new TextEncoder().encode("apk");
const APK_SHA256 = "dd37c2d7274f7ea982cb83390c36918fee9ce8889073c44b68cdc00bdb8c3e04";
const ASSET_RELEASE_ID = "d".repeat(64);

/** A manifest whose declared size and digest match APK_BYTES exactly. */
function assetManifest() {
  return {
    schemaVersion: 2,
    releaseId: ASSET_RELEASE_ID,
    version: "2026-08-09.0",
    artifacts: ROLES.map((role) => ({
      role,
      url: `./${role}.apk`,
      name: `AiPinRevival-${role}-2026-08-09.0.apk`,
      package: PACKAGES[role],
      versionCode: 202_608_090,
      size: APK_BYTES.byteLength,
      sha256: APK_SHA256,
    })),
    authority: authorityFixture("e".repeat(64)),
  };
}

function resolveFixtureTarget() {
  return resolveInstallTarget({
    fetchImpl: async () => response(assetManifest()),
    baseUrl: "https://center.example.test/setup",
    history: createMemoryPinReleaseHistory(),
  });
}

/**
 * The narrow `AssetFetchResponseLike` the download path consumes. `stream: true`
 * exercises the incremental reader; the default exercises the `blob()` fallback
 * for responses without a body stream.
 */
function assetResponse(bytes = APK_BYTES, { stream = false, contentLength, url } = {}) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    url,
    body: stream
      ? new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 1));
            controller.enqueue(bytes.slice(1));
            controller.close();
          },
        })
      : null,
    headers: {
      get(name) {
        return name.toLowerCase() === "content-length"
          ? (contentLength ?? String(bytes.byteLength))
          : null;
      },
    },
    async blob() {
      return new Blob([bytes]);
    },
    async text() {
      return "";
    },
  };
}

test("recognizeLegacyApkFilename recognizes old filenames without using them as a release source", () => {
  // Operators still hand over hand-downloaded PenumbraOS APKs. Recognising the
  // filename is a courtesy for labelling them; it is never how a release is
  // chosen, because a filename asserts nothing about the bytes.
  assert.equal(
    recognizeLegacyApkFilename("PenumbraOS-SystemInjector-Installer-2026-04-29.0.apk"),
    "installer",
  );
  assert.equal(
    recognizeLegacyApkFilename("PenumbraOS-SystemInjector-Exploit-2026-04-29.0.apk"),
    "bootstrap",
  );
  assert.equal(recognizeLegacyApkFilename("PenumbraOS-HumaneHooks-2026-04-29.0.apk"), "hook");
  assert.equal(recognizeLegacyApkFilename("unrelated.apk"), null);
});

test("resolveInstallTarget maps one typed manifest into one atomic install target", async () => {
  const resolved = await resolveFixtureTarget();

  // `manifestVerified` is the flag the install steps gate on; it may only ever be
  // set on this path, after the manifest has passed every check above.
  assert.equal(resolved.manifestVerified, true);
  assert.equal(resolved.releaseId, ASSET_RELEASE_ID);
  assert.equal(resolved.version, "2026-08-09.0");
  assert.equal(resolved.versionCode, 202_608_090);
  // Manifest roles map to fixed install slots; the mapping is what stops a
  // "bootstrap" artifact from being installed where "installer" was expected.
  assert.equal(resolved.artifacts.installerApk.role, "installer");
  assert.equal(resolved.artifacts.exploitApk.role, "bootstrap");
  assert.equal(resolved.artifacts.serverApk.package, "com.penumbraos.server");
  assert.equal(Object.isFrozen(resolved), true);
});

test("downloadInstallTargetAssets uses the default global fetch without losing invocation context", async () => {
  const originalFetch = globalThis.fetch;
  const resolved = await resolveFixtureTarget();
  const seen = [];
  const contextFetch = function (input, init) {
    if (this !== globalThis) {
      throw new TypeError("Illegal invocation");
    }
    seen.push({ input, init });
    return Promise.resolve(assetResponse());
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: contextFetch,
  });

  try {
    const result = await downloadInstallTargetAssets(resolved);
    assert.ok(result.serverApk instanceof Blob);
    assert.equal(seen.length, 5);
    // The request options are part of the trust boundary, not decoration:
    // `redirect: "error"` refuses an off-origin hop, `credentials: "same-origin"`
    // keeps the session from travelling, `cache: "no-store"` keeps a poisoned
    // response from surviving the page.
    assert.equal(seen[0].input, "https://center.example.test/api/pin/releases/installer.apk");
    assert.deepEqual(seen[0].init, {
      method: "GET",
      headers: { Accept: "application/vnd.android.package-archive" },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  }
});

test("downloadInstallTargetAssets downloads and verifies only selected roles", async () => {
  // A repair flow that only needs the hook must not pull the 200 MB server APK
  // over a wearer's connection, and must not silently return the other slots.
  const resolved = await resolveFixtureTarget();
  const fetchImpl = recordingFetch(async () => assetResponse());
  const progress = [];
  const result = await downloadInstallTargetAssets(resolved, {
    fetchImpl,
    assetRoles: ["hookApk"],
    onAssetProgress(event) {
      progress.push({ assetCount: event.assetCount, assetIndex: event.assetIndex });
    },
  });

  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(result.hookApk instanceof Blob);
  assert.equal(result.serverApk, undefined);
  assert.equal(result.installerApk, undefined);
  // Progress is reported against the selection, not the whole release, so the
  // wearer is not shown "1 of 5" for a one-asset download.
  assertContainsEqual(progress, { assetCount: 1, assetIndex: 0 }, "asset progress");
});

test("downloadInstallTargetAssets reports exact manifest-based progress while streaming", async () => {
  // Totals come from the manifest, never from a server-supplied header, so a
  // lying Content-Length cannot make a truncated download look complete.
  const resolved = await resolveFixtureTarget();
  const progress = [];
  await downloadInstallTargetAssets(resolved, {
    fetchImpl: async () => assetResponse(APK_BYTES, { stream: true }),
    assetRoles: ["serverApk"],
    onAssetProgress(event) {
      progress.push({ loaded: event.bytesLoaded, total: event.bytesTotal });
    },
  });
  assertContainsEqual(progress, { loaded: 0, total: 3 }, "stream start");
  assertContainsEqual(progress, { loaded: 3, total: 3 }, "stream completion");
});

test("downloadInstallTargetAssets fails closed on declared-length, received-size, and SHA-256 mismatches", async () => {
  // The last checkpoint before bytes are installed on a device somebody wears.
  // All three must fail: a header that disagrees with the manifest, a body that
  // disagrees with the manifest, and a body whose digest disagrees — each one is
  // a different point at which a substituted APK could enter.
  const resolved = await resolveFixtureTarget();

  await rejectsWith(
    downloadInstallTargetAssets(resolved, {
      fetchImpl: async () => assetResponse(APK_BYTES, { contentLength: "4" }),
      assetRoles: ["installerApk"],
    }),
    { code: "release-asset-integrity-failed" },
  );

  await rejectsWith(
    downloadInstallTargetAssets(resolved, {
      fetchImpl: async () =>
        assetResponse(new TextEncoder().encode("too long"), { contentLength: "" }),
      assetRoles: ["installerApk"],
    }),
    { code: "release-asset-integrity-failed" },
  );

  await rejectsWith(
    downloadInstallTargetAssets(resolved, {
      fetchImpl: async () => assetResponse(new TextEncoder().encode("bad")),
      assetRoles: ["installerApk"],
    }),
    { code: "release-asset-integrity-failed" },
  );
});

test("downloadInstallTargetAssets rejects an APK response that landed on another origin", async () => {
  // The artifact URL was already pinned to the manifest's origin when the
  // manifest was parsed, so this is the other half of that promise: where the
  // bytes actually came FROM. A redirect that lands on a CDN is the ordinary
  // way this happens, and the digest check further down is not a substitute —
  // the manifest that declared the digest and the response that carries the
  // bytes would both be under whoever controls the redirect.
  const resolved = await resolveFixtureTarget();

  await rejectsWith(
    downloadInstallTargetAssets(resolved, {
      fetchImpl: async () =>
        assetResponse(APK_BYTES, { url: "https://cdn.example.test/installer.apk" }),
      assetRoles: ["installerApk"],
    }),
    { code: "release-asset-download-failed" },
  );

  // Landed where it was asked for: accepted, digest and all.
  const downloaded = await downloadInstallTargetAssets(resolved, {
    fetchImpl: async (input) => assetResponse(APK_BYTES, { url: input }),
    assetRoles: ["installerApk"],
  });
  assert.ok(downloaded.installerApk instanceof Blob);
});

/*
 * ---------------------------------------------------------------------------
 * targetLock — one release per connection
 * ---------------------------------------------------------------------------
 */

test("lockResolvedInstallTarget locks a resolved target for the current connection", () => {
  // An install is several ADB steps long. The lock is what makes those steps
  // apply to one release: whatever the manifest endpoint starts serving midway
  // through, the steps keep operating on the target that was verified up front.
  const target = createResolvedInstallTargetFixture();
  const lock = lockResolvedInstallTarget(target);

  assert.equal(lock.locked, true);
  // Scoped to the page, not to a clock: it dies with the connection rather than
  // expiring into an unlocked state while an install is still running.
  assert.equal(lock.expiresOn, "page-leave");
  // Identity, not equality — the locked target is the verified object itself.
  assert.equal(getLockedTarget(lock), target);
  assert.equal(Object.isFrozen(lock), true);
});

test("clearTargetLock clears the target lock", () => {
  // Clearing yields null, and a null lock reads as no target: the absent case is
  // represented once, so no caller can mistake a cleared lock for a live one.
  assert.equal(clearTargetLock(), null);
  assert.equal(getLockedTarget(null), null);
});
