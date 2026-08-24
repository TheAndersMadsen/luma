import assert from "node:assert/strict";
import test from "node:test";

import { configBounds, digestToken, loadConfig } from "../src/config.mjs";

const TOKEN = "test-token-".padEnd(40, "x");
const readToken = () => Buffer.from(`${TOKEN}\n`);

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
      () =>
        loadConfig(
          { REVIVAL_SPOTIFY_ADAPTER_BIND_ADDRESS: bindAddress },
          readToken,
        ),
      /BIND_ADDRESS/,
    );
  }
  assert.equal(loadConfig({ REVIVAL_SPOTIFY_ADAPTER_BIND_ADDRESS: "0.0.0.0" }, readToken).bindAddress, "0.0.0.0");
});

test("loads bounded configuration and only retains the token digest", () => {
  let observedPath;
  const config = loadConfig(
    {
      REVIVAL_SPOTIFY_ADAPTER_BIND_ADDRESS: "192.0.2.20",
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
  assert.equal(config.port, 19081);
  assert.equal(config.timeoutMs, 750);
  assert.deepEqual(config.expectedTokenDigest, digestToken(TOKEN));
  assert.equal("token" in config, false);
});

test("rejects unsafe token and timeout values", () => {
  const env = { REVIVAL_SPOTIFY_ADAPTER_BIND_ADDRESS: "192.0.2.20" };
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
          REVIVAL_SPOTIFY_ADAPTER_BIND_ADDRESS: "192.0.2.20",
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
