import assert from "node:assert/strict";
import test from "node:test";

import { configBounds, digestToken, loadConfig } from "../src/config.mjs";

const TOKEN = "test-token-".padEnd(40, "x");
const readToken = () => Buffer.from(`${TOKEN}\n`);
const BASE_ENV = Object.freeze({
  REVIVAL_SPOTIFY_ADAPTER_BIND_ADDRESS: "192.0.2.20",
  REVIVAL_SPOTIFY_ADAPTER_UPSTREAM_ORIGIN: "http://center-iroh-bridge:18080",
});

test("requires a literal non-loopback bind address", () => {
  assert.throws(() => loadConfig({}, readToken), /BIND_ADDRESS is required/);
  for (const bindAddress of [
    "127.0.0.1",
    "127.99.2.3",
    "::1",
    "0:0:0:0:0:ffff:7f00:1",
    "adapter.local",
  ]) {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, REVIVAL_SPOTIFY_ADAPTER_BIND_ADDRESS: bindAddress }, readToken),
      /BIND_ADDRESS/,
    );
  }
  assert.equal(loadConfig({ ...BASE_ENV, REVIVAL_SPOTIFY_ADAPTER_BIND_ADDRESS: "0.0.0.0" }, readToken).bindAddress, "0.0.0.0");
});

test("requires one canonical HTTP upstream origin", () => {
  assert.throws(
    () => loadConfig({ REVIVAL_SPOTIFY_ADAPTER_BIND_ADDRESS: "0.0.0.0" }, readToken),
    /UPSTREAM_ORIGIN is required/,
  );
  for (const origin of [
    "file:///tmp/bridge",
    "http://user:password@bridge:18080",
    "http://bridge:18080/extra",
    "http://bridge:18080/?debug=true",
    "http://bridge:18080/",
    "http://bridge:18080",
    "https://center-iroh-bridge:18080",
    "https://example.com",
  ]) {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, REVIVAL_SPOTIFY_ADAPTER_UPSTREAM_ORIGIN: origin }, readToken),
      /UPSTREAM_ORIGIN/,
      origin,
    );
  }
  assert.equal(loadConfig(BASE_ENV, readToken).upstreamOrigin, "http://center-iroh-bridge:18080");
  assert.equal(
    loadConfig({ ...BASE_ENV, REVIVAL_SPOTIFY_ADAPTER_UPSTREAM_ORIGIN: "http://127.0.0.1:18080" }, readToken).upstreamOrigin,
    "http://127.0.0.1:18080",
  );
});

test("loads bounded configuration and only retains the token digest", () => {
  let observedPath;
  const config = loadConfig(
    {
      ...BASE_ENV,
      REVIVAL_SPOTIFY_ADAPTER_PORT: "19081",
      REVIVAL_SPOTIFY_ADAPTER_TIMEOUT_MS: "750",
      REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE: "/private/token",
      REVIVAL_SPOTIFY_ADAPTER_TOKEN: "ignored-environment-secret",
    },
    (path) => {
      observedPath = path;
      return Buffer.from(`${TOKEN}\n`);
    },
  );

  assert.equal(observedPath, "/private/token");
  assert.equal(config.bindAddress, "192.0.2.20");
  assert.equal(config.upstreamOrigin, "http://center-iroh-bridge:18080");
  assert.equal(config.port, 19081);
  assert.equal(config.timeoutMs, 750);
  assert.deepEqual(config.expectedTokenDigest, digestToken(TOKEN));
  assert.equal("token" in config, false);
});

test("the default timeout covers Pin integrity responses over Iroh", () => {
  assert.equal(loadConfig(BASE_ENV, readToken).timeoutMs, 10_000);
});

test("rejects unsafe token and timeout values", () => {
  const env = BASE_ENV;
  assert.throws(() => loadConfig(env, () => Buffer.from("short")), /32-512/);
  assert.throws(() => loadConfig(env, () => Buffer.from("x".repeat(513))), /32-512/);
  assert.throws(() => loadConfig(env, () => Buffer.from(`${"x".repeat(31)} y`)), /32-512/);
  assert.throws(
    () =>
      loadConfig(
        { ...env, REVIVAL_SPOTIFY_ADAPTER_TIMEOUT_MS: String(configBounds.minTimeoutMs - 1) },
        readToken,
      ),
    /must be between/,
  );
  assert.throws(
    () =>
      loadConfig(
        { ...env, REVIVAL_SPOTIFY_ADAPTER_TIMEOUT_MS: String(configBounds.maxTimeoutMs + 1) },
        readToken,
      ),
    /must be between/,
  );
});

test("reports token file failures without disclosing the path", () => {
  assert.throws(
    () =>
      loadConfig(
        {
          ...BASE_ENV,
          REVIVAL_SPOTIFY_ADAPTER_TOKEN_FILE: "/private/very-secret-name",
        },
        () => {
          throw new Error("ENOENT /private/very-secret-name");
        },
      ),
    (error) => {
      assert.equal(error.message, "Spotify adapter bearer token file could not be read");
      assert.doesNotMatch(error.message, /very-secret-name/);
      return true;
    },
  );
});
