import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * `/api/pin/adb/sign` is the ONE call the browser-side Pin console cannot make
 * itself: the third-party PenumbraOS signer that answers the device's ADB AUTH
 * challenge. It exists so `connect-src 'self'` never has to be widened on the
 * origin that holds the session cookie. These tests pin what it will forward,
 * where it will forward it, and what it will hand back.
 */

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

const {
  ADB_AUTH_TOKEN_BYTES,
  AdbSignerError,
  DEFAULT_ADB_SIGNER_URL,
  MAX_SIGNER_REQUEST_BYTES,
  MAX_SIGNER_RESPONSE_BYTES,
  assertAdbAuthToken,
  createRateLimiter,
  parseSignerResponse,
  readBoundedBytes,
  requestAdbSignature,
  signerEndpoint,
  signerTimeoutMs,
} = await import("../src/server/adb-signer.ts?adb-sign-proxy-test");

const TOKEN = new Uint8Array(ADB_AUTH_TOKEN_BYTES).fill(7);
const SIGNED = { token: "QUJDRA==", public_key: "QAAAAB0123 luma@center" };

function jsonResponse(body, init) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), init);
}

function stubFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { impl, calls };
}

test("the signing destination is deployment configuration and is validated every call", () => {
  assert.equal(signerEndpoint({}), `${DEFAULT_ADB_SIGNER_URL}/`);
  assert.equal(
    signerEndpoint({ LUMA_PIN_ADB_SIGNER_URL: "https://signer.example/sign" }),
    "https://signer.example/sign",
  );
  // Loopback over http is allowed so the installer can be developed locally.
  assert.equal(
    signerEndpoint({ LUMA_PIN_ADB_SIGNER_URL: "http://127.0.0.1:8787/" }),
    "http://127.0.0.1:8787/",
  );

  for (const configured of [
    "http://signer.example/",           // plaintext to a third party
    "https://user:pass@signer.example/", // credentials in the URL
    "https://signer.example/?to=evil",   // caller-shaped query
    "https://signer.example/#fragment",
    "ftp://signer.example/",
    "not a url",
    " ",
  ]) {
    assert.throws(
      () => signerEndpoint({ LUMA_PIN_ADB_SIGNER_URL: configured }),
      (error) => error instanceof AdbSignerError && error.code === "signer_not_configured" && error.status === 503,
      configured,
    );
  }
});

test("the upstream call is bounded in time", () => {
  assert.equal(signerTimeoutMs({}), 10_000);
  assert.equal(signerTimeoutMs({ LUMA_PIN_ADB_SIGNER_TIMEOUT_MS: "1500" }), 1_500);
  assert.equal(signerTimeoutMs({ LUMA_PIN_ADB_SIGNER_TIMEOUT_MS: "0" }), 500);
  assert.equal(signerTimeoutMs({ LUMA_PIN_ADB_SIGNER_TIMEOUT_MS: "999999" }), 15_000);
  assert.equal(signerTimeoutMs({ LUMA_PIN_ADB_SIGNER_TIMEOUT_MS: "nonsense" }), 10_000);
});

test("only an exact ADB auth token is forwarded", async () => {
  assert.equal(ADB_AUTH_TOKEN_BYTES, 20);
  assert.doesNotThrow(() => assertAdbAuthToken(TOKEN));

  for (const size of [0, 19, 21, 64]) {
    assert.throws(
      () => assertAdbAuthToken(new Uint8Array(size)),
      (error) => error instanceof AdbSignerError && error.status === 400,
      `${size} bytes`,
    );
  }

  const { impl, calls } = stubFetch(() => jsonResponse(SIGNED));
  await assert.rejects(
    requestAdbSignature(new Uint8Array(21), { endpoint: "https://signer.example/", fetchImpl: impl }),
    (error) => error instanceof AdbSignerError && error.code === "invalid_token",
  );
  assert.equal(calls.length, 0, "a body that is not a token must not reach the third party at all");
});

test("a bounded read refuses an oversized body instead of buffering it", async () => {
  const bytes = await readBoundedBytes(new Response(new Uint8Array([1, 2, 3])).body, 8);
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.deepEqual([...(await readBoundedBytes(null, 8))], []);

  await assert.rejects(
    readBoundedBytes(new Response(new Uint8Array(MAX_SIGNER_REQUEST_BYTES + 1)).body, MAX_SIGNER_REQUEST_BYTES),
    (error) => error instanceof AdbSignerError && error.status === 413,
  );
});

test("exactly the token bytes are sent, with nothing of the caller's request attached", async () => {
  // A view onto a larger buffer, which is what a bounded stream read produces.
  const backing = new Uint8Array(64).fill(0xaa);
  backing.set(TOKEN, 12);
  const view = backing.subarray(12, 12 + ADB_AUTH_TOKEN_BYTES);

  const { impl, calls } = stubFetch(() => jsonResponse(SIGNED));
  const signature = await requestAdbSignature(view, {
    endpoint: "https://signer.example/",
    timeoutMs: 1_000,
    fetchImpl: impl,
  });

  assert.deepEqual(signature, SIGNED);
  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, "https://signer.example/");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error", "a moved signer must not silently relay the token elsewhere");
  assert.equal(init.cache, "no-store");
  assert.ok(init.signal, "the upstream call must be abortable");

  const sent = new Uint8Array(init.body);
  assert.equal(sent.byteLength, ADB_AUTH_TOKEN_BYTES, "the surrounding read buffer must not ride along");
  assert.deepEqual([...sent], [...TOKEN]);

  const headerNames = Object.keys(init.headers).map((name) => name.toLowerCase());
  assert.deepEqual(headerNames.sort(), ["accept", "content-type"]);
  for (const forbidden of ["cookie", "authorization", "origin", "referer", "x-forwarded-for"]) {
    assert.ok(!headerNames.includes(forbidden), `${forbidden} must not be forwarded to the signer`);
  }
});

test("only a usable signature and public key are handed back to the browser", () => {
  assert.deepEqual(parseSignerResponse({ ...SIGNED, session: "leak", cookie: "leak" }), SIGNED);

  for (const body of [
    null,
    "a string",
    {},
    { token: SIGNED.token },
    { public_key: SIGNED.public_key },
    { token: "", public_key: SIGNED.public_key },
    { token: "not base64!!", public_key: SIGNED.public_key },
    { token: "QUJD", public_key: "line\nbreak" },
    { token: 42, public_key: SIGNED.public_key },
    { token: SIGNED.token, public_key: "x".repeat(9000) },
  ]) {
    assert.throws(
      () => parseSignerResponse(body),
      (error) => error instanceof AdbSignerError && error.code === "invalid_response" && error.status === 502,
      JSON.stringify(body),
    );
  }
});

test("every upstream failure is reported as a failure, and never echoes the signer's body", async () => {
  const rejected = stubFetch(() => jsonResponse({ error: "Input must be 20 bytes" }, { status: 400 }));
  await assert.rejects(
    requestAdbSignature(TOKEN, { endpoint: "https://signer.example/", fetchImpl: rejected.impl }),
    (error) => {
      assert.ok(error instanceof AdbSignerError);
      assert.equal(error.code, "signer_rejected");
      assert.equal(error.status, 502);
      assert.doesNotMatch(error.message, /Input must be/);
      return true;
    },
  );

  const unreachable = stubFetch(() => {
    throw new Error("ECONNREFUSED https://signer.example/");
  });
  await assert.rejects(
    requestAdbSignature(TOKEN, { endpoint: "https://signer.example/", fetchImpl: unreachable.impl }),
    (error) => {
      assert.ok(error instanceof AdbSignerError);
      assert.equal(error.code, "signer_unreachable");
      assert.doesNotMatch(error.message, /ECONNREFUSED/);
      return true;
    },
  );

  const notJson = stubFetch(() => jsonResponse("<html>signer</html>"));
  await assert.rejects(
    requestAdbSignature(TOKEN, { endpoint: "https://signer.example/", fetchImpl: notJson.impl }),
    (error) => error instanceof AdbSignerError && error.code === "invalid_response",
  );

  const flood = stubFetch(() =>
    jsonResponse(JSON.stringify({ token: "A".repeat(MAX_SIGNER_RESPONSE_BYTES + 4) })),
  );
  await assert.rejects(
    requestAdbSignature(TOKEN, { endpoint: "https://signer.example/", fetchImpl: flood.impl }),
    (error) => error instanceof AdbSignerError && error.code === "invalid_response",
  );
});

test("the route is session-gated, same-origin, and silent about token material", async () => {
  const route = await source("src/app/api/pin/adb/sign/route.ts");

  assert.match(route, /export async function POST/);
  for (const mutation of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    assert.doesNotMatch(
      route,
      new RegExp(`export (?:async )?function ${mutation}\\b`),
      `${mutation} must not be served by the signing proxy`,
    );
  }

  assert.match(route, /requireWearerRequest\(\)/);
  assert.match(route, /if \(gate instanceof Response\) return gate;/);
  assert.match(route, /isSameOriginRequest\(request\)/);
  assert.match(route, /status: 403/);
  assert.match(route, /readBoundedBytes\(request\.body, MAX_SIGNER_REQUEST_BYTES\)/);
  assert.match(route, /cache-control": "no-store/);

  // Nothing on this path may log: the token is in scope throughout. Both
  // spellings are refused, the rest of src/server moved from `console` to
  // src/server/log.ts, and a logger whose delivery is now proven would be a
  // BETTER way to leak a signing token, not a safer one.
  const silent = /console\.|\blog(Info|Warn|Error)\s*\(/;
  assert.doesNotMatch(route, silent);
  const signer = await source("src/server/adb-signer.ts");
  assert.doesNotMatch(signer, silent);
});

test("the gates run in order, before anything reaches the third-party signer", async () => {
  /*
   * Presence is not the property. Every assertion above is satisfied by a route
   * that reads the body and calls the third-party signer FIRST and only then
   * checks the session, an unauthenticated relay to PenumbraOS with all five
   * strings still present and this suite still green.
   *
   * Ordering is asserted over the source rather than by invoking POST, and that
   * limit is real: this harness supplies no Next request context for
   * `next/headers`, so nothing here executes the handler. What IS executed is
   * the rate limiter below and every unit in adb-signer.ts above. The gate order
   * is the one thing this file can only read.
   */
  const route = await source("src/app/api/pin/adb/sign/route.ts");
  const handler = route.slice(route.indexOf("export async function POST"));
  assert.ok(handler.length > 0, "the POST handler must be present");

  const at = (needle) => {
    const index = handler.indexOf(needle);
    assert.ok(index >= 0, `the sign route must contain: ${needle}`);
    return index;
  };
  const ordered = [
    "requireWearerRequest()",
    "if (gate instanceof Response) return gate;",
    "isSameOriginRequest(request)",
    "allowSignature(",
    "readBoundedBytes(request.body, MAX_SIGNER_REQUEST_BYTES)",
    "requestAdbSignature(",
  ];
  const positions = ordered.map(at);
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(
      positions[index - 1] < positions[index],
      `"${ordered[index - 1]}" must run before "${ordered[index]}" — otherwise the signer is spent before the caller is known`,
    );
  }

  // The denials each gate produces, so a reorder that keeps the order but drops
  // the early return is still caught.
  assert.match(handler, /if \(!isSameOriginRequest\(request\)\)[\s\S]{0,200}status: 403/);
  assert.match(handler, /if \(!allowSignature\([\s\S]{0,200}status: 429/);
});

test("the configured budget is the one that actually refuses the next call", async () => {
  // Drive the real limiter with the route's own configured numbers, so a
  // widened budget has to be a deliberate edit rather than a silent one.
  const route = await source("src/app/api/pin/adb/sign/route.ts");
  const configured = route.match(
    /createRateLimiter\(\{\s*windowMs:\s*([\d_]+),\s*max:\s*([\d_]+),\s*maxTracked:\s*([\d_]+)\s*\}\)/,
  );
  assert.ok(configured, "the sign route must configure its rate limiter inline");
  const windowMs = Number(configured[1].replaceAll("_", ""));
  const max = Number(configured[2].replaceAll("_", ""));
  const maxTracked = Number(configured[3].replaceAll("_", ""));
  assert.ok(max > 0 && max <= 60, `a per-session budget of ${max} is not a budget`);

  const allow = createRateLimiter({ windowMs, max, maxTracked });
  const start = 2_000_000;
  for (let call = 0; call < max; call += 1) {
    assert.equal(allow("wearer", start + call), true, `call ${call + 1} of ${max}`);
  }
  assert.equal(allow("wearer", start + max), false, "the call past the budget must be refused");
  assert.equal(allow("other", start + max), true, "a different account keeps its own budget");
  assert.equal(allow("wearer", start + windowMs + 1), true, "the window must roll");
});

test("the signing proxy is not part of the public Pin release surface", async () => {
  /*
   * The old proxy for this was `assert.doesNotMatch(middleware, /adb/i)`, which
   * is indirect in the wrong direction: widening the predicate to
   * `pathname.startsWith("/api/pin/")` contains no "adb", opens this route to
   * anonymous callers, and passes. Read the predicate's own literals instead and
   * evaluate them against the path that must never be public.
   */
  const middleware = await source("src/middleware.ts");
  const predicate = middleware.match(
    /export function isPublicPinReleaseRequest\([\s\S]*?\n\}/,
  )?.[0];
  assert.ok(predicate, "middleware must export the public Pin release predicate");

  const prefixes = [...predicate.matchAll(/pathname\.startsWith\("([^"]+)"\)/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    prefixes,
    ["/api/pin/releases/"],
    "the public surface is the immutable release download tree and nothing else",
  );
  for (const prefix of prefixes) {
    assert.equal(
      "/api/pin/adb/sign".startsWith(prefix),
      false,
      `the signing proxy falls inside the public prefix ${prefix}`,
    );
  }

  const methods = [...predicate.matchAll(/normalizedMethod === "([A-Z]+)"/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(
    methods,
    ["GET", "HEAD", "OPTIONS"],
    "only safe methods may be public; this route is a POST",
  );
});
