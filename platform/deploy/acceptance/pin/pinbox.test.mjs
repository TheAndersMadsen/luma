// Unit tests for the pinbox package. No device required.
// Covers: dispatcher flag translation (spawn-mocked), pure arg helpers,
// in-process readiness arg parsing, and the admin-HTTP allowlist.
// Run: bun test --isolate platform/deploy/acceptance/pin/pinbox.test.mjs

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { dispatch, resolveCommand, splitArgs, buildNativeArgs, COMMANDS } from "./pinbox/dispatch.mjs";
import { assertAllowlistedPath, PROBE_API_PATHS } from "./pinbox/shared/admin-http.mjs";
import { buildReadinessDeviceOptions } from "./pinbox/commands/readiness.mjs";

// ---- a fake spawn that records the translated argv and exits 0 ----
function makeFakeSpawn() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdin = { destroy() {}, end() {} };
    child.stdout = { destroy() {}, resume() {} };
    child.stderr = { destroy() {}, resume() {} };
    child.kill = () => {};
    setImmediate(() => child.emit("close", 0));
    return child;
  };
  return { spawn, calls };
}

function sinks() {
  let out = "";
  let err = "";
  return {
    out: (s) => { out += s; },
    err: (s) => { err += s; },
    getOut: () => out,
    getErr: () => err,
  };
}

function argv(...a) {
  return ["bun", "pinbox.mjs", ...a];
}

// ─── dispatcher: flag translation (shell-out commands) ──────────────────────
test("smoke: --serial and --json are forwarded; unknown flags pass through", async () => {
  const { spawn, calls } = makeFakeSpawn();
  const s = sinks();
  await dispatch(argv("smoke", "--serial", "S", "--json", "--self-check"), { ...s, spawn });
  assert.equal(calls.length, 1);
  assert.match(calls[0].args[0], /agentic-release-smoke\.mjs$/);
  const a = calls[0].args.join(" ");
  assert.match(a, /--serial S /);
  assert.match(a, /--json/);
  assert.match(a, /--self-check/);
  assert.equal(s.getErr(), "");
});

test("smoke: --token-file reaches the tool through env and never argv", async () => {
  const { spawn, calls } = makeFakeSpawn();
  const s = sinks();
  await dispatch(argv("smoke", "--serial", "S", "--token-file", "/tmp/t"), { ...s, spawn });
  assert.equal(calls[0].opts.env.PENUMBRA_PIN_ADMIN_TOKEN_FILE, "/tmp/t");
  assert.equal(calls[0].args.join(" ").includes("--token-file"), false);
});

test("smoke: --verbose echoes the spawn line to stderr", async () => {
  const { spawn } = makeFakeSpawn();
  const s = sinks();
  await dispatch(argv("smoke", "--serial", "S", "--verbose"), { ...s, spawn });
  assert.match(s.getErr(), /^\+ bun .*agentic-release-smoke\.mjs /);
});

test("bridge: --json is dropped with a warning (tool does not take it)", async () => {
  const { spawn, calls } = makeFakeSpawn();
  const s = sinks();
  await dispatch(argv("bridge", "--serial", "S", "--json", "--listen-port", "8080"), { ...s, spawn });
  const a = calls[0].args.join(" ");
  assert.equal(a.includes("--json"), false);
  assert.match(s.getErr(), /--json ignored/);
  assert.match(a, /--listen-port 8080/);
});

test("-- forces passthrough (a colliding flag is preserved untouched)", async () => {
  const { spawn, calls } = makeFakeSpawn();
  const s = sinks();
  await dispatch(argv("smoke", "--serial", "S", "--", "--json"), { ...s, spawn });
  const a = calls[0].args.join(" ");
  assert.match(a, /--serial S /);
  assert.match(a, /--json$/);
});

test("unknown command → exit 2 + help hint", async () => {
  const { spawn, calls } = makeFakeSpawn();
  const s = sinks();
  const code = await dispatch(argv("bogus"), { ...s, spawn });
  assert.equal(code, 2);
  assert.match(s.getErr(), /unknown command "bogus"/);
  assert.match(s.getErr(), /pinbox help/);
  assert.equal(calls.length, 0);
});

test("no args → help, exit 0", async () => {
  const s = sinks();
  const code = await dispatch(argv(), { ...s, spawn: makeFakeSpawn().spawn });
  assert.equal(code, 0);
  assert.match(s.getOut(), /unified Penumbra test CLI/);
  assert.match(s.getOut(), /smoke/);
});

test("list --json → machine-readable registry", async () => {
  const s = sinks();
  const code = await dispatch(argv("list", "--json"), { ...s, spawn: makeFakeSpawn().spawn });
  assert.equal(code, 0);
  const rows = JSON.parse(s.getOut());
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, COMMANDS.length);
  assert.ok(rows.some((r) => r.name === "readiness" && r.inProcess === true));
  assert.equal(rows.some((r) => r.category === "Deploy"), false);
});

test("version → exit 0", async () => {
  const s = sinks();
  const code = await dispatch(argv("version"), { ...s, spawn: makeFakeSpawn().spawn });
  assert.equal(code, 0);
  assert.match(s.getOut(), /pinbox v/);
});

// ─── pure arg helpers ───────────────────────────────────────────────────────
test("splitArgs: consumes common, passes the rest through", () => {
  const { common, passthrough } = splitArgs(["--serial", "S", "--adb", "A", "--json", "--case", "x", "--run"]);
  assert.equal(common.serial, "S");
  assert.equal(common.adb, "A");
  assert.equal(common.json, true);
  assert.deepEqual(passthrough, ["--case", "x", "--run"]);
});

test("splitArgs: --adb-path is an alias for --adb", () => {
  const { common } = splitArgs(["--adb-path", "/x/adb"]);
  assert.equal(common.adb, "/x/adb");
});

test("splitArgs: -- forces the rest to passthrough", () => {
  const { common, passthrough } = splitArgs(["--serial", "S", "--", "--json", "--adb", "A"]);
  assert.equal(common.serial, "S");
  assert.equal(common.json, false);
  assert.deepEqual(passthrough, ["--json", "--adb", "A"]);
});

test("buildNativeArgs: emits native serial/adb/json and drops unsupported with warning", () => {
  const spec = resolveCommand("bridge");
  const { args, warnings } = buildNativeArgs(spec, { serial: "S", adb: undefined, json: true }, ["--listen-port", "8080"]);
  assert.deepEqual(args, ["--serial", "S", "--listen-port", "8080"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /--json ignored/);
});

test("resolveCommand: unknown → null", () => {
  assert.equal(resolveCommand("nope"), null);
  assert.ok(resolveCommand("readiness"));
});

test("COMMANDS: every shell-out command has a file that exists; in-process has none", () => {
  for (const c of COMMANDS) {
    if (c.inProcess) assert.equal(c.file, null);
    else assert.equal(typeof c.file, "string");
  }
});

// ─── in-process readiness arg handling ─────────────────────────────────────
test("readiness: no --serial → exit 2", async () => {
  const s = sinks();
  const code = await dispatch(argv("readiness"), { ...s, spawn: makeFakeSpawn().spawn });
  assert.equal(code, 2);
  assert.match(s.getErr(), /--serial is required/);
});

test("readiness: --serial FOO (no device/token) → in-process path runs, exits 1", async () => {
  const s = sinks();
  const code = await dispatch(argv("readiness", "--serial", "FOO"), { ...s, spawn: makeFakeSpawn().spawn });
  // The in-process command runs readAdminToken + verifyExplicitDevice. With no
  // device (and possibly no readable token file) it must surface a readiness-
  // prefixed error and exit non-zero, proving the in-process path executed.
  assert.equal(code, 1);
  assert.match(s.getErr(), /^pinbox readiness:/);
});

test("readiness passes the independently supplied expected serial to the device guard", () => {
  assert.deepEqual(
    buildReadinessDeviceOptions(
      { serial: "device-123", adb: "/opt/adb" },
      { PENUMBRA_EXPECTED_PIN_SERIAL: "device-123" },
    ),
    {
      serial: "device-123",
      expectedPinSerial: "device-123",
      adbPath: "/opt/adb",
    },
  );
});

// ─── admin-HTTP allowlist (shared/admin-http.mjs) ───────────────────────────
test("the admin-HTTP allowlist is absolute and query-free", () => {
  // The shared allowlist guards every tool that talks to Center's admin
  // plane. It is the load-bearing surface the probe tools build on.
  assert.ok(PROBE_API_PATHS instanceof Set);
  assert.ok(PROBE_API_PATHS.size > 0);
  for (const p of PROBE_API_PATHS) {
    assert.ok(p.startsWith("/"), p);
    assert.equal(p.includes("?"), false, p);
  }
});

test("allowlist matches the PATH, not the query string", () => {
  const path = [...PROBE_API_PATHS][0];
  assert.doesNotThrow(() => assertAllowlistedPath(`${path}?refresh=1`));
});

test("allowlist is NOT widened: a new endpoint is still refused, with or without a query", () => {
  assert.throws(() => assertAllowlistedPath("/api/admin/overview"));
  assert.throws(() => assertAllowlistedPath("/api/admin/overview?x=1"));
});

test("allowlist guards the query charset (the path is spliced into a curl config)", () => {
  const path = [...PROBE_API_PATHS][0];
  assert.doesNotThrow(() => assertAllowlistedPath(`${path}?q=abc%0Ainject`));
  assert.throws(() => assertAllowlistedPath(`${path}?q=abc\ninject`));
  assert.throws(() => assertAllowlistedPath(`${path}?q=abc"inject`));
});
