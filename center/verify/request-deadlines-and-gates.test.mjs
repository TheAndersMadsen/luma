import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { sourceFiles } from "./sourceScan.mjs";

/*
 * Two properties that only look unrelated.
 *
 * A GATE that is not in the route is not a gate. The middleware matcher used to
 * exclude any pathname ENDING in an image or font extension — a suffix test over
 * the whole path, not over a static-asset prefix — so appending `.png` to a URL
 * skipped authentication entirely. `/api/capture/memory/{uuid}/file/0.png`
 * reached its handler with no session, because that handler reads its last
 * segment as `Number(index) || 0` and swallowed the suffix; `/captures/x.png`
 * rendered the signed-in app shell to an anonymous caller. Nothing was disclosed
 * — Cosmos hands a non-Web caller the sealed envelope and the channel key refuses
 * to resolve without a wearer identity — but the gate genuinely did not run, and
 * the next route with a suffix-tolerant segment would not have been so lucky.
 *
 * A DEADLINE that is not on the call is not a deadline. Every call to Cosmos or
 * Keycloak has to be bounded, because an upstream that goes SLOW rather than
 * down is the shape that defeats all of this app's careful degraded contracts:
 * the wearer waits, the route's honest `state: "degraded"` never gets to run,
 * and the handler keeps its socket long after nginx has already given up on the
 * browser. The refresh-token exchange was the worst of them — it is upstream of
 * every deadline Center owns, so COSMOS_DEADLINE_MS bounded nothing across it.
 */

const SRC = new URL("../src/", import.meta.url);
const source = (path) => readFile(new URL(path, SRC), "utf8");

test("appending a file extension does not skip authentication", async () => {
  const middleware = await source("middleware.ts");
  const matcher = /matcher: \[\s*"([^"]+)"/.exec(middleware);
  assert.ok(matcher, "middleware no longer declares a matcher this test can read");

  // Next compiles the matcher to a path regex; run it as one. The capture is the
  // raw source text, so undo the string literal's own escaping first.
  const pattern = matcher[1].replace(/\\\\/g, "\\");
  const runs = (pathname) => new RegExp(`^${pattern}$`).test(pathname);

  for (const gated of [
    "/api/capture/memory/2c0f/file/0.png",
    "/api/capture/memory/2c0f/file/0.jpg",
    "/api/capture/memory/2c0f/file/0.svg",
    "/api/capture/memory/2c0f/file/0",
    "/api/admin/devices.png",
    "/admin/pin/terminal.png",
    "/captures/2c0f.png",
    "/settings/pin/gallery/x.woff2",
  ]) {
    assert.ok(runs(gated), `${gated} skips the middleware auth gate`);
  }

  // …and the four files that genuinely are public still are.
  for (const asset of [
    "/favicon.ico",
    "/apple-touch-icon.png",
    "/manifest.json",
    "/fonts/humaneweb-vf.woff2",
    "/_next/static/chunks/main.js",
  ]) {
    assert.ok(!runs(asset), `${asset} now runs middleware, which it must not`);
  }
});

test("the capture frame route carries its own gate and does not serve a document", async () => {
  const route = await source("app/api/capture/memory/[uuid]/file/[index]/route.ts");

  // Middleware is fixed, but a guard in the route cannot be bypassed by a
  // matcher edit or a rewrite — which is the argument src/server/operator.ts
  // already makes, and this route was the one ignoring it.
  assert.match(route, /requireWearerRequest/);
  const gate = route.indexOf("const gate = await requireWearerRequest()");
  const read = route.indexOf("getCaptureFrame(uuid");
  assert.ok(gate > 0 && read > 0 && gate < read, "the frame is read before the session is checked");

  // `sniff()` can return image/svg+xml, which is a DOCUMENT. Under the app's own
  // CSP (script-src 'self' 'unsafe-inline') that renders as same-origin markup
  // with inline script allowed — while the PUBLIC share route sandboxes
  // byte-for-byte identical output.
  assert.match(route, /"content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox"/);
  assert.match(route, /"x-content-type-options": "nosniff"/);
});

test("every call to Cosmos or Keycloak is bounded by a deadline", async () => {
  /*
   * Scanned rather than listed, so a new route that talks to either backend and
   * forgets the bound fails here on the day it is written.
   *
   * Two deliberate exceptions, both of which say so in their own prose: the
   * assistant's SSE turn ("Long turns stream for many seconds; do not buffer or
   * time out early") and the speech proxy that streams synthesised audio back.
   * A deadline on either would cut a wearer off mid-sentence.
   */
  const STREAMING_EXCEPTIONS = [
    "app/api/assistant/stream/route.ts",
    "app/api/assistant/speech/route.ts",
  ];

  const unbounded = [];
  let scanned = 0;
  for (const tree of ["server/", "app/api/"]) {
    for (const file of await sourceFiles(new URL(tree, SRC), readdir)) {
      const relative = decodeURIComponent(file.pathname).split("/src/").pop();
      if (STREAMING_EXCEPTIONS.includes(relative)) continue;
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(/fetch\(/g)) {
        // Slice the call's own argument list by matching its parentheses.
        const open = match.index + match[0].length - 1;
        let depth = 0;
        let close = open;
        for (let i = open; i < text.length; i += 1) {
          if (text[i] === "(") depth += 1;
          else if (text[i] === ")") {
            depth -= 1;
            if (depth === 0) {
              close = i;
              break;
            }
          }
        }
        const args = text.slice(open, close + 1);
        if (!/COSMOS_WEBAPI|KEYCLOAK_BASE_URL/.test(args)) continue;
        scanned += 1;
        if (!/signal:/.test(args)) {
          unbounded.push(`${relative}:${text.slice(0, open).split("\n").length}`);
        }
      }
    }
  }

  assert.ok(scanned >= 20, `only ${scanned} backend calls were scanned; the scan is not finding them`);
  assert.deepEqual(
    unbounded,
    [],
    `${unbounded.join(", ")} can hang on a backend that accepts the connection and stops answering, holding a route handler and an upstream socket long after the wearer has been cut off`,
  );
});

test("the wearer's identity is resolved before the deadline clock starts", async () => {
  /*
   * Object-literal properties evaluate in order. With `signal:` written above
   * `headers: await webapiHeaders()`, the 8s clock started BEFORE the token
   * refresh, so a Keycloak slower than that handed `fetch` a signal that had
   * already fired — and `describeWebapi` reported it as "cosmos webapi timed
   * out". Center blaming a healthy Cosmos for an IdP stall is exactly the
   * misattribution this codebase keeps writing prose about.
   */
  for (const path of [
    "server/cosmos.ts",
    "server/domain/provenance.ts",
    "server/domain/captures.ts",
  ]) {
    const text = await source(path);
    for (const match of text.matchAll(/signal: AbortSignal\.timeout\([^)]*\)[^]*?\}/g)) {
      assert.ok(
        !/headers: await /.test(match[0].split("\n").slice(0, 6).join("\n")),
        `${path}: a deadline is constructed before an awaited header call, so it is spent on the auth hop`,
      );
    }
    assert.doesNotMatch(
      text,
      /signal: AbortSignal\.timeout\([^)]*\),\s*\n\s*cache: "no-store",\s*\n\s*headers: await/,
      `${path}: the deadline still starts before the wearer's identity is resolved`,
    );
  }

  const auth = await source("server/auth.ts");
  assert.match(auth, /const KEYCLOAK_DEADLINE_MS/);
  // Every Keycloak token exchange, not just the refresh: a sign-in that hangs
  // is a sign-in that failed.
  const exchanges = [...auth.matchAll(/protocol\/openid-connect\/token`|OIDC_PATH\}\/token`/g)];
  assert.ok(exchanges.length >= 3, "the Keycloak token calls this test knows about have moved");
  assert.equal(
    [...auth.matchAll(/signal: AbortSignal\.timeout\(KEYCLOAK_DEADLINE_MS\)/g)].length,
    exchanges.length,
    "a Keycloak token call is still unbounded, and it sits upstream of every deadline Center owns",
  );
});

test("the burst ranking releases its own control after it succeeds", async () => {
  const detail = await source("app/captures/CaptureDetail.tsx");
  /*
   * `applyBestFrame` mutates `record`, which is a dependency of the ranking
   * effect, so the effect's own SUCCESS triggers its own cleanup — before the
   * `.finally` runs. Gated on `!cancelled`, the reset was therefore skipped
   * every time the ranking worked, and `rankPending` latched true: the wearer
   * watched Center choose a hero frame for their burst photo and then could not
   * override it, re-run it, or learn why, because every control was disabled and
   * the header said "Choosing the clearest frame…" forever.
   */
  assert.match(detail, /\.finally\(\(\) => setRankPending\(false\)\)/);
  assert.doesNotMatch(
    detail,
    /if \(!cancelled\) setRankPending\(false\)/,
    "the auto-rank reset is gated on `cancelled` again, which its own success guarantees",
  );
});

test("the Ai Mic chat stops talking when the wearer leaves it", async () => {
  const chat = await source("components/AiMicChat.tsx");
  /*
   * `speak()` builds a DETACHED Audio element, which React unmounting cannot
   * touch and which is not collected while it is playing. A wearer who asked the
   * Pin something on /talk and then tapped Memories had the answer keep playing
   * over an unrelated page, with nothing on screen to stop it — reloading the tab
   * was the only way out. `audioRef` had been written and never read.
   */
  assert.match(chat, /const audio = audioRef\.current;/);
  assert.match(chat, /audio\.pause\(\);/);
  assert.match(chat, /URL\.revokeObjectURL\(audioUrlRef\.current\)/);
  // Nothing may START speaking after the unmount either — the reply arrives long
  // after the request that asked for it.
  assert.match(chat, /if \(!liveRef\.current\) return;/);
  // And the SSE reader has to be released, the way PinDeviceProvider says.
  assert.match(chat, /signal: controller\.signal/);
  assert.match(chat, /await reader\.cancel\(\)\.catch\(\(\) => undefined\);/);
  assert.match(chat, /streamAbortRef\.current\?\.abort\(\)/);
});
