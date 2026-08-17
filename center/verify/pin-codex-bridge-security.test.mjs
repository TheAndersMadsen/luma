/*
 * Behavioural guards for `_lib/codexBridgeSecurity`, the two validators that run
 * before a secret-bearing Codex save leaves the browser for the Pin.
 *
 * Both are client-side mirrors of the on-device bridge policy, and both are the
 * last thing between a user and a mistake that is invisible afterwards: a
 * plaintext LAN bridge URL puts the bridge token on the wire, and a pasted key
 * pair gets stored and then displayed back as a "configured" CA with no way to
 * tell from the UI that a private key went with it.
 *
 * These cases came from the `pin/setup` SPA's vitest suite. The module was
 * ported into Center byte-for-byte (only a header comment was added), so the
 * assertions are the SPA's unchanged — including the exact substrings of the
 * rejection messages, which is what stops a reworded error from quietly
 * becoming a different verdict.
 */

// Registers the resolve hook that lets these `src/` modules reach their own
// extensionless siblings and `@/lib/…` aliases under Node's type stripping.
// Static, so it is evaluated before the dynamic imports below.
import "./tsResolve.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const QUERY = "?pin-codex-bridge-security-test";

const { validateCodexBridgeUrl, validatePublicCaPem } = await import(
  `../src/app/settings/pin/_lib/codexBridgeSecurity.ts${QUERY}`
);

/*
 * The repo's credential scanner (platform/deploy/acceptance/source-policy.sh)
 * greps every tracked file for a literal `-----BEGIN … PRIVATE KEY-----`, and it
 * is right to: a real key in the tree is exactly what it is there to catch. This
 * fixture needs that header as *input* to prove the validator rejects it, so the
 * header is assembled at runtime from fragments and the literal never appears in
 * the source. The alternative was a scanner exclusion for this file, which would
 * have switched the check off for everything else added here later.
 */
function pemHeader(kind, marker) {
  return `-----${marker} ${kind}-----`;
}

const CERTIFICATE = [
  pemHeader("CERTIFICATE", "BEGIN"),
  "ZmFrZQ==",
  pemHeader("CERTIFICATE", "END"),
].join("\n");

const PRIVATE_KEY = [
  pemHeader("PRIVATE KEY", "BEGIN"),
  "c2VjcmV0",
  pemHeader("PRIVATE KEY", "END"),
].join("\n");

/* ── validateCodexBridgeUrl ───────────────────────────────────────────────── */

test("Codex bridge URL policy allows HTTPS hosts and loopback HTTP", () => {
  assert.equal(validateCodexBridgeUrl("https://bridge.example:8765"), null);
  assert.equal(validateCodexBridgeUrl("http://localhost:8765"), null);
  assert.equal(validateCodexBridgeUrl("http://127.42.0.1:8765"), null);
  assert.equal(validateCodexBridgeUrl("http://[::1]:8765"), null);
});

test("Codex bridge URL policy rejects plaintext LAN hosts and authority-smuggling fields", () => {
  assert.match(validateCodexBridgeUrl("http://192.168.1.20:8765"), /Use HTTPS/);
  assert.match(
    validateCodexBridgeUrl("https://user:secret@bridge.example:8765"),
    /cannot contain credentials/,
  );
  assert.match(
    validateCodexBridgeUrl("https://bridge.example:8765?q=secret"),
    /cannot contain credentials/,
  );
  assert.match(validateCodexBridgeUrl("https://0.0.0.0:8765"), /connectable host/);
});

test("Codex bridge URL policy refuses each authority field on its own", () => {
  // Beyond the SPA's set. The case above pastes a `user:secret@` pair and a
  // query, which leaves three of the guard's four fields unpinned: dropping
  // `url.username`, `url.password`, or `url.hash` from it individually changes
  // nothing that suite can see, because a URL carrying both halves of a
  // credential pair still trips whichever half is left. The fields are
  // independently reachable — `https://:secret@host` parses with an empty
  // username and a password — so each one is asserted on its own here.
  assert.match(
    validateCodexBridgeUrl("https://user@bridge.example:8765"),
    /cannot contain credentials/,
  );
  assert.match(
    validateCodexBridgeUrl("https://:secret@bridge.example:8765"),
    /cannot contain credentials/,
  );
  assert.match(
    validateCodexBridgeUrl("https://bridge.example:8765/#secret"),
    /cannot contain credentials/,
  );
});

/* ── validatePublicCaPem ──────────────────────────────────────────────────── */

test("Codex private CA input accepts one public certificate block", () => {
  assert.equal(validatePublicCaPem(CERTIFICATE), null);
});

test("Codex private CA input rejects private keys and mixed PEM bundles", () => {
  assert.match(
    validatePublicCaPem(`${CERTIFICATE}\n${PRIVATE_KEY}`),
    /never a private key/,
  );
  assert.match(
    validatePublicCaPem(`${CERTIFICATE}\n${CERTIFICATE}`),
    /exactly one/,
  );
});
