import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

/*
 * The Pin Device Recovery Console has full administrator control of the wearer's
 * device from a browser tab: `/admin/pin/terminal` opens `shell.pty` over WebUSB ADB
 * session and the Pin asks for no further authorization. This file is the gate
 * around it. It fails if the shell ever becomes reachable by a session that is
 * merely signed in, whether because the route moved, because the operator
 * classification narrowed, because middleware stopped enforcing it on page
 * paths, or because the in-render guard was dropped.
 */

process.env.KEYCLOAK_BASE_URL = "https://keycloak.test";
process.env.KEYCLOAK_CLIENT_ID = "center-test";
process.env.AUTH_SESSION_SECRET = "0123456789abcdef0123456789abcdef";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

/**
 * Drop whole-line comments so an assertion about what a build file *does* is not
 * satisfied or defeated by prose explaining why. The comments here deliberately
 * name the very paths these tests forbid.
 */
function withoutComments(text, marker) {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(marker))
    .join("\n");
}

const {
  OPERATOR_PIN_PATH_PREFIX,
  OPERATOR_PIN_SHELL_PATH,
  RETIRED_WEARER_SHELL_PATH,
  isOperatorPath,
  operatorGateOutcome,
  signSession,
  verifySession,
} = await import("../src/server/auth.ts?pin-terminal-gate-test");

/** The two enforcement points reduced to the decision they both make. */
function gate(pathname, session) {
  if (!isOperatorPath(pathname)) return "ungated";
  return operatorGateOutcome(session);
}

const OPERATOR = { sub: "op", email: "op@example.com", name: "Op", operator: true };
const WEARER = { sub: "wearer", email: "wearer@example.com", name: "Wearer", operator: false };

test("the Pin device shell lives on an operator path", () => {
  assert.equal(OPERATOR_PIN_SHELL_PATH, "/admin/pin/terminal");
  assert.equal(OPERATOR_PIN_PATH_PREFIX, "/admin/pin");
  assert.ok(
    OPERATOR_PIN_SHELL_PATH.startsWith(`${OPERATOR_PIN_PATH_PREFIX}/`),
    "the shell must sit under the prefix the /admin/pin layout guards",
  );

  for (const pathname of [
    OPERATOR_PIN_SHELL_PATH,
    OPERATOR_PIN_PATH_PREFIX,
    "/admin/pin/terminal/",
    "/admin",
    "/api/admin/flags",
    // The path the shell occupied while the Pin console was a standalone SPA.
    // The SPA is deleted, but the path is still a plausible place for someone to
    // put a console back. Naming it keeps a re-creation there failing closed.
    RETIRED_WEARER_SHELL_PATH,
  ]) {
    assert.equal(isOperatorPath(pathname), true, pathname);
  }

  // The rest of the ported Pin console is a wearer surface and must stay open to
  // a signed-in wearer, the gate is narrow on purpose.
  for (const pathname of ["/settings/pin", "/settings/pin/install", "/settings/pin/esim", "/captures"]) {
    assert.equal(isOperatorPath(pathname), false, pathname);
  }
});

test("no session and a wearer session are both refused the device shell", () => {
  assert.equal(gate(OPERATOR_PIN_SHELL_PATH, null), "unauthenticated");
  assert.equal(gate(OPERATOR_PIN_SHELL_PATH, undefined), "unauthenticated");
  assert.equal(gate(OPERATOR_PIN_SHELL_PATH, WEARER), "forbidden");
  assert.equal(gate(OPERATOR_PIN_SHELL_PATH, OPERATOR), "allow");

  // Anything that is not an explicitly-true claim denies: a session minted
  // before the claim existed, and every truthy-but-not-true value.
  for (const claim of [undefined, null, 0, 1, "true", "yes", {}, []]) {
    assert.equal(operatorGateOutcome({ ...WEARER, operator: claim }), "forbidden", String(claim));
  }

  // Same rule, applied to the whole /admin/pin subtree rather than one path.
  assert.equal(gate(`${OPERATOR_PIN_PATH_PREFIX}/anything-added-later`, WEARER), "forbidden");
  assert.equal(gate(RETIRED_WEARER_SHELL_PATH, WEARER), "forbidden");
});

test("a real signed wearer session cannot reach the shell", async () => {
  const wearerToken = await signSession(WEARER);
  const operatorToken = await signSession(OPERATOR);

  assert.equal(gate(OPERATOR_PIN_SHELL_PATH, await verifySession(wearerToken)), "forbidden");
  assert.equal(gate(OPERATOR_PIN_SHELL_PATH, await verifySession(operatorToken)), "allow");
  assert.equal(gate(OPERATOR_PIN_SHELL_PATH, await verifySession("not-a-token")), "unauthenticated");
});

test("middleware enforces the operator gate on page paths, before the local-development open door", async () => {
  const middleware = await source("src/middleware.ts");

  const operatorBranch = middleware.indexOf("if (isOperatorPath(pathname))");
  const openDoor = middleware.indexOf("if (!AUTH_ENABLED) return privateResponse");
  assert.ok(operatorBranch > 0, "middleware must classify operator paths");
  assert.ok(openDoor > 0, "middleware must still open up when no Keycloak is configured");
  assert.ok(
    operatorBranch < openDoor,
    "the operator gate must run BEFORE the unauthenticated open door, or a Keycloak-less deployment serves the device shell to anyone",
  );

  // One rule, two enforcement points: middleware must not restate it.
  assert.match(middleware, /operatorGateOutcome\(await verifySession\(sessionToken\)\)/);

  // Page paths are denied too, they are redirected off the route rather than
  // 403'd, so "it 403s" is the wrong thing to assert about a page.
  const branch = middleware.slice(operatorBranch, openDoor);
  assert.match(branch, /outcome === "unauthenticated"/);
  assert.match(branch, /outcome === "forbidden"/);
  assert.match(branch, /NextResponse\.redirect\(url\)/);
  assert.match(branch, /status: 403/);

  // The matcher must keep sending /admin/* through middleware at all.
  const matcher = middleware.slice(middleware.indexOf("matcher"));
  assert.doesNotMatch(matcher, /admin/);
});

test("the device shell is guarded again inside the render, not by middleware alone", async () => {
  const layout = await source("src/app/admin/pin/layout.tsx");

  assert.doesNotMatch(layout, /^"use client"/m, "the gate must run on the server");
  assert.match(layout, /requireOperatorSession/);
  assert.match(layout, /force-dynamic/);

  const guard = await source("src/server/operator.ts");
  assert.match(guard, /operatorGateOutcome/);
  assert.match(guard, /redirect\("\/"\)/);
  // The guard must never hand back a session on a non-allow outcome.
  assert.match(guard, /if \(outcome === "allow" && session\) return session;/);
});

test("the operator surface presents a recovery console with an explicit authority warning", async () => {
  const pane = await source("src/app/admin/pin/terminal/TerminalPane.tsx");
  const page = await source("src/app/admin/pin/terminal/page.tsx");
  const diagnostics = await source("src/app/settings/pin/diagnostics/page.tsx");

  assert.match(pane, /Device Recovery Console/);
  assert.match(pane, /full administrator control/);
  assert.match(page, /title: "Device Recovery Console"/);
  assert.match(diagnostics, /Full administrator access for recovering a failed installation/);
});

test("no second, ungated Pin console is shipped as a static bundle", async () => {
  /*
   * The gate is a property of the DEPLOYED IMAGE, not only of the route table.
   * A standalone SPA was once a complete Pin console including an interactive
   * ADB PTY, and Center compiled it into `public/setup` and rewrote `/setup` to
   * its index. `/setup` is not an operator path, so that bundle handed a device
   * full device control to every signed-in wearer, around, not through, `isOperatorPath`.
   * Nothing about the App Router tree would have shown it.
   *
   * That SPA's source is deleted, which closes the hole but does not guard it:
   * a build file is one line away from reopening it with any static console.
   * So the assertions stay, on the two files where such a line would have to go.
   */
  const dockerfile = withoutComments(await source("Dockerfile"), "#");
  const nextConfig = withoutComments(await source("next.config.mjs"), "//");
  assert.doesNotMatch(dockerfile, /public\/setup/);
  assert.doesNotMatch(dockerfile, /dist-setup/);
  assert.doesNotMatch(nextConfig, /destination: "\/setup/);
});

/** Every source file under `src/`, keyed by its repository-relative path. */
async function sourceFiles(prefix) {
  const dir = new URL(`${prefix}/`, root);
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(tsx?|mjs|jsx?)$/.test(entry.name)) continue;
    const parent = entry.parentPath ?? entry.path ?? "";
    const absolute = `${parent.replace(/\/$/, "")}/${entry.name}`;
    const relative = absolute.slice(absolute.indexOf(prefix));
    files.push({ relative, content: await readFile(absolute, "utf8") });
  }
  return files;
}

const GATED_SUBTREE = "src/app/admin/pin/";

test("no browser-reachable device shell exists outside the operator gate", async () => {
  const routes = await sourceFiles("src/app");
  assert.ok(routes.length > 0, "the app router tree must be readable");

  // A route that opens a PTY on the device, by shape or by content.
  const shellSignals = [/@xterm\//, /\bshell\.pty\b/, /xterm-256color/, /terminalType/];
  for (const { relative, content } of routes) {
    const isShellRoute = /\/terminal\/(page|layout|route)\.tsx?$/.test(relative);
    const looksLikeShell = shellSignals.some((signal) => signal.test(content));
    if (!isShellRoute && !looksLikeShell) continue;
    assert.ok(
      relative.startsWith(GATED_SUBTREE),
      `${relative} exposes a device shell outside the operator-gated /admin/pin subtree`,
    );
  }

  // And nothing in the wearer settings tree may route to a shell of its own.
  for (const { relative, content } of routes) {
    if (!relative.startsWith("src/app/settings/")) continue;
    assert.doesNotMatch(
      content,
      /\/settings\/pin\/terminal/,
      `${relative} links to a wearer-path device shell`,
    );
  }
});

test("the wearer console cannot open a PTY through the session it already holds", async () => {
  /*
   * The gate above is about ROUTES. This is about the CAPABILITY, which travels
   * separately: every pane under `/settings/pin`, an ungated wearer surface,
   * holds the borrowed session from `PinDeviceProvider`, and that object is a
   * delegate over the real ADB transport. If it forwards `openPty()`, a shell on
   * a wearer pane is one already-in-scope call away and no route check is
   * involved, so nothing above would notice. The provider therefore refuses it,
   * and the operator terminal takes the shared session directly instead.
   */
  const provider = await source("src/app/settings/pin/PinDeviceProvider.tsx");
  assert.doesNotMatch(
    provider,
    /openPty:\s*\(\)\s*=>\s*session\.openPty\(\)/,
    "the borrowed wearer session must not forward openPty() to the device",
  );
  assert.match(provider, /openPty: \(\) => \{[\s\S]*?throw new Error\(/);

  // Redundant on purpose: the whole-tree scan below subsumes this, but keeping
  // the settings tree named makes the most likely regression fail with the most
  // specific message.
  for (const { relative, content } of await sourceFiles("src/app/settings")) {
    assert.doesNotMatch(
      content,
      /\.openPty\(/,
      `${relative} opens a device PTY from the ungated wearer console`,
    );
  }
});

/**
 * Files permitted to name a device-shell capability, by exact prefix.
 *
 * `src/app/admin/pin/` is the operator-gated subtree. The two library modules
 * are where the capability is IMPLEMENTED and delegated. Everything else in
 * `src/` is wearer-reachable by default, so it fails.
 */
const CAPABILITY_ALLOWLIST = [
  GATED_SUBTREE,
  "src/lib/pin-session/index.ts",
  "src/lib/pin-device/adb/transport.ts",
];

function allowed(relative, extra = []) {
  return [...CAPABILITY_ALLOWLIST, ...extra].some((prefix) => relative.startsWith(prefix));
}

test("no file outside the operator gate and the device library can open a PTY", async () => {
  /*
   * This used to scan `src/app/settings` alone, which asserted today's SHAPE
   * rather than the property. A new client component at
   * `src/components/DeviceConsole.tsx`, or a page at `src/app/tools/pin/page.tsx`,
   * calling `getPinAdbSession().openPty()` and piping bytes into a <pre>, no
   * xterm, no "terminal" in the path, passed every assertion in this file while
   * handing a root device shell to every signed-in wearer. That is the /setup
   * static-bundle hole moved one directory over.
   */
  const tree = await sourceFiles("src");
  assert.ok(tree.length > 0, "the Center source tree must be readable");

  for (const { relative, content } of tree) {
    if (!/\.openPty\s*\(/.test(content)) continue;
    assert.ok(
      allowed(relative),
      `${relative} opens a device PTY outside the operator gate and the device library`,
    );
  }
});

test("no wearer surface can obtain the unreduced ADB session", async () => {
  /*
   * `getPinAdbSession()` hands back the OPERATOR session, the one that carries
   * `openPty()`. A wearer pane holding it is one already-in-scope call away from
   * full device control no matter what any borrowed delegate refuses, so the accessor
   * itself is the boundary, and `getWearerPinAdbSession()` is what the ungated
   * `/settings/pin` tree gets instead.
   *
   * The word-boundary lookbehind is load-bearing: without it every
   * `getWearerPinAdbSession()` call would match this and the test would forbid
   * the very accessor that makes the boundary work.
   */
  for (const { relative, content } of await sourceFiles("src")) {
    if (!/(?<![A-Za-z0-9_])getPinAdbSession\s*\(/.test(content)) continue;
    assert.ok(
      allowed(relative),
      `${relative} takes the unreduced ADB session on a wearer-reachable path`,
    );
  }
});

test("no file outside the device library opens a raw ADB service socket", async () => {
  /*
   * `createSocket(service)` takes a free-form ADB service string that goes
   * straight to the daemon, so `createSocket("shell:")` reaches the same shell
   * service `openPty()` is built on, refusing `openPty` while forwarding
   * `createSocket` refuses nothing. The device library legitimately needs it
   * (`localabstract:penumbra_http` and the configured tcp port). No page,
   * component or hook does.
   */
  for (const { relative, content } of await sourceFiles("src")) {
    if (!/createSocket\s*!?\s*\(/.test(content)) continue;
    assert.ok(
      allowed(relative, ["src/lib/pin-device/"]),
      `${relative} opens a raw ADB service socket outside the device library`,
    );
  }
});

test("the browser terminal itself is colocated inside the gated subtree", async () => {
  // The device layer may legitimately speak `shell.pty`, it is a library. The
  // xterm UI is different: it exists only to put that shell in front of a person,
  // so a shared component outside the gate would be a wearer-reachable shell one
  // import away.
  for (const { relative, content } of await sourceFiles("src")) {
    if (!/from "@xterm\/|import "@xterm\//.test(content)) continue;
    assert.ok(
      relative.startsWith(GATED_SUBTREE),
      `${relative} imports the browser terminal outside the operator-gated /admin/pin subtree`,
    );
  }
});
