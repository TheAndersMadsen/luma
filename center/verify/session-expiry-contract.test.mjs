import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { balanced, lineOf, maskSource, sourceFiles, tryCatchBlocks } from "./sourceScan.mjs";

/*
 * One expired session, one answer.
 *
 * `SessionExpiredError` (src/server/cosmos.ts) exists because a wearer can hold
 * a valid 12-hour Center cookie whose Keycloak grant died underneath it — the
 * realm reaps an SSO session after 30 minutes idle. Only the wearer can fix
 * that, and only if they are told.
 *
 * The recurring defect is not that the typed error is missing. It is that a
 * pre-existing bare `catch {}` downstream eats it, so the same expiry surfaced
 * as 401 + reauthenticate on the Wi-Fi pane, "PublicPrivacyService.GetSettings
 * did not answer" (i.e. the backend is down) on Privacy, a 404 "frame
 * unavailable" on a capture, and a 503 "frame temporarily unavailable" with a
 * retry-after on a download — four contradictory explanations of one condition,
 * three of them blaming something that was fine.
 *
 * So this asserts a PROPERTY, over a file set derived by scanning rather than
 * listed here: any source file that touches a helper known to propagate the
 * typed error must name it. A new route that reaches one of these helpers and
 * swallows its failures fails this test on the day it is written, which is the
 * point — the old tests could only have caught the shape that already existed.
 */

const ROOT = new URL("../src/", import.meta.url);

/**
 * Helpers that let a `SessionExpiredError` out.
 *
 * Each one forwards the wearer's bearer through `webapiHeaders()` or
 * `requestMetadata()` and deliberately does NOT convert the failure into a
 * degraded value, because the caller is the layer that knows how to answer it.
 * `webapiGetForUser` is absent on purpose: public share reads authenticate with
 * the BFF's own projection token and never touch a wearer session.
 */
const PROPAGATING_HELPERS = [
  /\bgetCaptureFrame\b/,
  /\bgetCaptureOriginal\b/,
  /\bgetCapture\b/,
  /\brankCapture\b/,
  /\bsetCaptureBestFrame\b/,
  /\bServices\.privacy\b/,
  /\bServices\.wifi\b/,
];

test("every caller of a bearer-carrying helper answers an expired session as one", async () => {
  const files = await sourceFiles(ROOT, readdir);
  const reached = [];

  for (const file of files) {
    const contents = await readFile(file, "utf8");
    if (!PROPAGATING_HELPERS.some((pattern) => pattern.test(contents))) continue;
    const relative = decodeURIComponent(file.pathname).split("/src/").pop();
    reached.push(relative);
    assert.match(
      contents,
      /instanceof SessionExpiredError/,
      `${relative} reaches a helper that propagates SessionExpiredError but never names it, so an expired grant is reported as something else`,
    );
  }

  // The scan must actually find the callers; a regex that matches nothing would
  // pass every assertion above without checking anything.
  assert.ok(
    reached.includes("server/source.ts") &&
      reached.includes("app/api/settings/wifi/route.ts") &&
      reached.includes("app/api/settings/privacy/route.ts"),
    `the helper scan found only ${JSON.stringify(reached)}`,
  );
});

test("the module that owns the typed error never discards one", async () => {
  const seam = await readFile(new URL("server/source.ts", ROOT), "utf8");
  // Every catch in the data seam binds its error. A bare `catch {}` here is
  // exactly how getCaptureFrame re-hid the failure the typed error was
  // introduced to expose, and it leaves no log line either.
  assert.doesNotMatch(
    seam,
    /\}\s*catch\s*\{/,
    "src/server/source.ts has a bare catch; bind the error and either rethrow SessionExpiredError or log it",
  );
});

/*
 * ---------------------------------------------------------------------------
 * The repo-wide sweep.
 *
 * The test above is a whole-file assertion: it proves a file MENTIONS the typed
 * error somewhere. That is not the same as proving no catch in it eats one — a
 * route can answer the expiry correctly in `GET` and swallow it in `DELETE`, and
 * that is very close to what actually shipped.
 *
 * This one is statement-level. For every file, it works out which
 * bearer-carrying helpers that file can actually call (from its own imports, so
 * a local `const call = fetch` in adb-signer.ts is not mistaken for the gRPC
 * `call`), then looks at each `try`/`catch` whose TRY BLOCK reaches one, and at
 * each seam call that is followed by a promise-style `.catch(…)`.
 *
 * A catch on such a call must do one of four things: name the typed error, log
 * it, rethrow it, or hand it to a classifier that is itself checked below.
 * Anything else is the failure mode that produced three different explanations
 * of one dead session — including `requestMetadata().catch(() => undefined)`,
 * which sent a wearer's Ai Mic turn upstream ANONYMOUS so it was written under
 * the backend's demo principal and answered "Saved:".
 */

/** Modules whose exports can throw the typed error at their caller. */
const SEAM_MODULES = /^(?:@\/server\/|\.\.?\/)(?:cosmos|source|channel)$/;

/** Names that reach `requestBearer()` and therefore let the expiry out. */
const PROPAGATORS = [
  "call",
  "webapiGet",
  "webapiPost",
  "webapiDelete",
  "webapiHeaders",
  "requestMetadata",
  "ingestAnswerEvent",
  "channelKey",
  "getCapture",
  "getCaptureFrame",
  "getCaptureOriginal",
  "rankCapture",
  "setCaptureBestFrame",
];

/** The seam modules themselves own every propagator, imported or not. */
const SEAM_FILES = ["server/cosmos.ts", "server/source.ts", "server/channel.ts"];

/**
 * Catch bodies that classify the error for the caller instead of describing it.
 * Each is asserted to name the typed error itself, so delegating to one is not a
 * way to launder a swallow.
 */
const CLASSIFIERS = ["failedGrpc", "failedWebapi"];

/** Which propagators this file can actually reach, from its own import list. */
function seamNames(source, relative) {
  if (SEAM_FILES.includes(relative)) return PROPAGATORS;
  const names = new Set();
  const imports = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  let match;
  while ((match = imports.exec(source)) !== null) {
    if (!SEAM_MODULES.test(match[2])) continue;
    for (const clause of match[1].split(",")) {
      const local = clause.trim().split(/\s+as\s+/).pop()?.trim();
      if (local && PROPAGATORS.includes(local)) names.add(local);
    }
  }
  return [...names];
}

function mentionsSeam(text, names) {
  return names.some((name) => new RegExp(`\\b${name}\\s*[(<]`).test(text));
}

/**
 * Does this catch body do anything with the error, or does it drop it?
 *
 * `logInfo`/`logWarn`/`logError` (src/server/log.ts) are the server-side log now
 * and `console.*` is banned under src/server and src/app/api by
 * verify/server-logging.test.mjs, so both spellings count as saying something.
 * `console` stays listed because a catch that still uses it is a violation of
 * that other test, not a licence to discard the error here as well.
 */
function handles(body) {
  return (
    /SessionExpiredError/.test(body) ||
    /console\.(warn|error|info|log)/.test(body) ||
    /\blog(Warn|Error|Info)\s*\(/.test(body) ||
    /\bthrow\b/.test(body) ||
    CLASSIFIERS.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(body))
  );
}

/** Every seam call swallowed by a promise-style `.catch(…)`. */
function promiseCatches(source, names) {
  const masked = maskSource(source);
  const found = [];
  for (const name of names) {
    const call = new RegExp(`\\b${name}\\s*\\(`, "g");
    let match;
    while ((match = call.exec(masked)) !== null) {
      const region = balanced(masked, match.index + match[0].length - 1);
      if (!region) continue;
      const tail = masked.slice(region.end + 1);
      const handler = /^\s*\.catch\s*\(/.exec(tail);
      if (!handler) continue;
      const body = balanced(masked, region.end + 1 + handler[0].length - 1);
      found.push({
        line: lineOf(masked, match.index),
        name,
        body: source.slice(
          region.end + 1 + handler[0].length,
          region.end + 1 + handler[0].length + (body?.text.length ?? 0),
        ),
      });
    }
  }
  return found;
}

function swallows(source, relative) {
  const names = seamNames(source, relative);
  if (names.length === 0) return [];
  const problems = [];

  for (const block of tryCatchBlocks(source)) {
    if (!mentionsSeam(block.tryBody, names)) continue;
    if (block.binding === null) {
      problems.push(
        `${relative}:${block.line} — bare \`catch {\` around a call that carries the wearer's bearer: it cannot even log what it dropped`,
      );
      continue;
    }
    if (!handles(block.catchBody)) {
      problems.push(
        `${relative}:${block.line} — \`catch (${block.binding})\` neither names SessionExpiredError, nor logs it, nor rethrows it`,
      );
    }
  }

  for (const swallow of promiseCatches(source, names)) {
    if (/SessionExpiredError|\bthrow\b/.test(swallow.body)) continue;
    problems.push(
      `${relative}:${swallow.line} — \`${swallow.name}(…).catch(…)\` discards the expiry, so the call proceeds without the wearer's identity`,
    );
  }
  return problems;
}

test("no catch on a bearer-carrying call discards an expired session", async () => {
  const files = await sourceFiles(ROOT, readdir);
  const problems = [];
  const inspected = [];

  for (const file of files) {
    const relative = decodeURIComponent(file.pathname).split("/src/").pop();
    const source = await readFile(file, "utf8");
    if (seamNames(source, relative).length === 0) continue;
    inspected.push(relative);
    problems.push(...swallows(source, relative));
  }

  assert.deepEqual(problems, [], problems.join("\n"));

  // Anti-vacuity: the sweep must have reached the seam itself and the routes
  // that answer for it, or an import-shape change would silently empty it.
  for (const owner of [
    "server/source.ts",
    "server/channel.ts",
    "app/api/settings/wifi/route.ts",
    "app/api/settings/privacy/route.ts",
    "app/api/assistant/stream/route.ts",
    "app/api/capture/memory/[uuid]/route.ts",
  ]) {
    assert.ok(inspected.includes(owner), `the swallow sweep never inspected ${owner}`);
  }

  // The classifiers a catch is allowed to delegate to must themselves name the
  // typed error, or delegation would be a hole rather than a handling.
  const seam = await readFile(new URL("server/source.ts", ROOT), "utf8");
  for (const classifier of CLASSIFIERS) {
    const declaration = new RegExp(
      `function ${classifier}[\\s\\S]{0,240}?instanceof SessionExpiredError`,
    );
    assert.match(
      seam,
      declaration,
      `${classifier}() is trusted to classify an expired session but does not test for one`,
    );
  }
});

test("every route that recognises the expiry answers it the same way", async () => {
  const routes = (await sourceFiles(new URL("app/api/", ROOT), readdir)).filter((file) =>
    /route\.ts$/.test(file.pathname),
  );
  const answering = [];

  for (const file of routes) {
    const relative = decodeURIComponent(file.pathname).split("/src/").pop();
    const source = await readFile(file, "utf8");
    if (!/instanceof SessionExpiredError/.test(source)) continue;
    answering.push(relative);

    // Recognising it and then answering it as something else is the original
    // bug wearing a new coat, so the flag is required wherever it is named.
    assert.match(
      source,
      /reauthenticate: true/,
      `${relative} recognises an expired session but never tells the client it can be fixed by signing in`,
    );

    // 401 is the answer api/settings/wifi established. A 200 or a 502 carrying
    // the flag would leave two panes disagreeing about one condition again.
    let index = source.indexOf("reauthenticate: true");
    while (index !== -1) {
      assert.match(
        source.slice(index, index + 240),
        /status: 401/,
        `${relative} carries \`reauthenticate\` on a response that is not a 401`,
      );
      index = source.indexOf("reauthenticate: true", index + 1);
    }
  }

  assert.ok(
    answering.length >= 8,
    `only ${answering.length} routes answer the expiry: ${JSON.stringify(answering)}`,
  );
});

test("the sweep fails the shapes it exists to catch", () => {
  const bare = swallows(
    `import { call, Services } from "@/server/cosmos";
     export async function GET() {
       try {
         return Response.json(await call(Services.privacy, "GetSettings", {}));
       } catch {
         return Response.json({ error: "the backend did not answer" }, { status: 502 });
       }
     }`,
    "app/api/example/route.ts",
  );
  assert.equal(bare.length, 1);
  assert.match(bare[0], /bare `catch \{`/);

  const described = swallows(
    `import { webapiGet } from "@/server/cosmos";
     export async function GET() {
       try {
         return Response.json(await webapiGet("/notes"));
       } catch (error) {
         return Response.json({ error: String(error) }, { status: 502 });
       }
     }`,
    "app/api/example/route.ts",
  );
  assert.equal(described.length, 1);
  assert.match(described[0], /neither names SessionExpiredError/);

  // The exact shape that ran every Ai Mic turn under the demo principal.
  const swallowed = swallows(
    `import { requestMetadata } from "@/server/cosmos";
     const md = await requestMetadata().catch(() => undefined);`,
    "app/api/assistant/stream/route.ts",
  );
  assert.equal(swallowed.length, 1);
  assert.match(swallowed[0], /discards the expiry/);

  // A local binding that merely shares a name with a seam export is not one:
  // src/server/adb-signer.ts really does `const call = options.fetchImpl ?? fetch`
  // and really must swallow, because the ADB token is in scope.
  assert.deepEqual(
    swallows(
      `const call = options.fetchImpl ?? fetch;
       try { response = await call(endpoint, {}); } catch { throw new AdbSignerError("signer_unreachable"); }`,
      "server/adb-signer.ts",
    ),
    [],
  );

  // …and the handled shapes pass, or this would just be a ban on catching.
  assert.deepEqual(
    swallows(
      `import { call, SessionExpiredError } from "@/server/cosmos";
       try { await call("x", "y", {}); } catch (error) {
         if (error instanceof SessionExpiredError) return reauthenticate();
         return NextResponse.json({ error: "carry did not answer" }, { status: 502 });
       }`,
      "app/api/example/route.ts",
    ),
    [],
  );
  assert.deepEqual(
    swallows(
      `import { webapiGet } from "@/server/cosmos";
       try { await webapiGet("/notes"); } catch (error) { return failedWebapi([], error); }`,
      "server/source.ts",
    ),
    [],
  );
});
