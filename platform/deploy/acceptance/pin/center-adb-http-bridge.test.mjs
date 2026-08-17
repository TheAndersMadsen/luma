import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BRIDGE_HOST,
  BridgeRequestError,
  buildUpstreamRequest,
  createCenterAdbHttpBridge,
  parseCliArgs,
  parseRequestHead,
} from "./center-adb-http-bridge.mjs";

const SERIAL = "unit-test-device-123";

const ROOT = dirname(
  dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))),
);
const ON_DEVICE_BRIDGE = join(
  ROOT,
  "pin/runtime/android/src/main/kotlin/com/penumbraos/server/CenterUsbBridge.kt",
);
const ON_DEVICE_REQUEST_SECURITY = join(
  ROOT,
  "pin/runtime/android/src/main/kotlin/com/penumbraos/server/UsbHttpRequestSecurity.kt",
);

class FakeAdbChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.stdinBytes = [];
    this.stdin.on("data", (chunk) => this.stdinBytes.push(Buffer.from(chunk)));
  }

  kill() {
    if (this.killed || this.exitCode !== null || this.signalCode !== null) {
      return false;
    }
    this.killed = true;
    this.signalCode = "SIGTERM";
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    this.emit("killed");
    return true;
  }

  finish(code = 0) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.stdin.destroy();
    this.stderr.end();
    this.stdout.end();
    queueMicrotask(() => this.emit("close", code, null));
  }

  upstreamRequest() {
    return Buffer.concat(this.stdinBytes).toString("latin1");
  }
}

async function startTestBridge(t, overrides = {}) {
  const bridge = createCenterAdbHttpBridge({ serial: SERIAL, ...overrides });
  const address = await bridge.listen(0);
  t.after(() => bridge.close());
  return { bridge, port: address.port };
}

function rawRequest(port, request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = createConnection({ host: BRIDGE_HOST, port }, () => {
      socket.end(request);
    });
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
    socket.on("error", reject);
  });
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("canonicalizes loopback framing without exposing end-to-end headers", () => {
  const parsed = parseRequestHead(
    Buffer.from(
      "GET /api/device?detail=1 HTTP/1.1\r\n" +
        "Host: attacker.invalid\r\n" +
        "Authorization: Bearer unit-test-token\r\n" +
        "Connection: keep-alive, X-Remove-Me\r\n" +
        "X-Remove-Me: private-hop-value\r\n" +
        "Accept: application/json\r\n",
      "latin1",
    ),
  );
  const request = buildUpstreamRequest(parsed, Buffer.alloc(0), 8080).toString(
    "latin1",
  );

  assert.equal(parsed.contentLength, 0);
  assert.match(request, /^GET \/api\/device\?detail=1 HTTP\/1\.1\r\n/);
  assert.match(request, /\r\nHost: 127\.0\.0\.1:8080\r\n/);
  assert.match(request, /\r\nAuthorization: Bearer unit-test-token\r\n/);
  assert.match(request, /\r\nContent-Length: 0\r\n/);
  assert.match(request, /\r\nConnection: close\r\n\r\n$/);
  assert.doesNotMatch(request, /attacker\.invalid|X-Remove-Me|private-hop-value/);
  assert.equal((request.match(/\r\nHost:/g) ?? []).length, 1);
  assert.equal((request.match(/\r\nContent-Length:/g) ?? []).length, 1);
});

test("rejects ambiguous, chunked, upgraded, and oversized requests", () => {
  const cases = [
    {
      name: "duplicate host",
      status: 400,
      head: "GET / HTTP/1.1\r\nHost: one\r\nHost: two\r\n",
    },
    {
      name: "duplicate content length",
      status: 400,
      head: "POST / HTTP/1.1\r\nHost: one\r\nContent-Length: 1\r\nContent-Length: 1\r\n",
    },
    {
      name: "conflicting framing",
      status: 400,
      head: "POST / HTTP/1.1\r\nHost: one\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n",
    },
    {
      name: "chunked body",
      status: 501,
      head: "POST / HTTP/1.1\r\nHost: one\r\nTransfer-Encoding: chunked\r\n",
    },
    {
      name: "expect continue",
      status: 417,
      head: "POST / HTTP/1.1\r\nHost: one\r\nExpect: 100-continue\r\n",
    },
    {
      name: "protocol upgrade",
      status: 400,
      head: "GET / HTTP/1.1\r\nHost: one\r\nUpgrade: websocket\r\n",
    },
    {
      name: "absolute target",
      status: 400,
      head: "GET http://example.test/ HTTP/1.1\r\nHost: one\r\n",
    },
    {
      name: "oversized body declaration",
      status: 413,
      head: "POST / HTTP/1.1\r\nHost: one\r\nContent-Length: 5\r\n",
      options: { maxBodyBytes: 4 },
    },
  ];

  for (const fixture of cases) {
    assert.throws(
      () => parseRequestHead(fixture.head, fixture.options),
      (error) =>
        error instanceof BridgeRequestError && error.statusCode === fixture.status,
      fixture.name,
    );
  }

  assert.throws(
    () =>
      parseRequestHead("GET / HTTP/1.1\r\nHost: one\r\nX-Large: value", {
        maxHeaderBytes: 16,
      }),
    (error) => error instanceof BridgeRequestError && error.statusCode === 431,
  );
});

test("waits for the complete body, keeps ADB stdin open, and streams the response", async (t) => {
  let child;
  let spawnArgs;
  const spawned = new EventEmitter();
  const { port } = await startTestBridge(t, {
    spawnImpl(_command, args, options) {
      spawnArgs = { args, options };
      child = new FakeAdbChild();
      queueMicrotask(() => spawned.emit("spawn"));
      return child;
    },
  });

  const responseChunks = [];
  let responseEnded = false;
  const socket = createConnection({ host: BRIDGE_HOST, port });
  socket.on("data", (chunk) => responseChunks.push(Buffer.from(chunk)));
  socket.on("end", () => {
    responseEnded = true;
  });
  await once(socket, "connect");

  socket.write(
    "POST /api/settings HTTP/1.1\r\n" +
      "Host: 127.0.0.1:18081\r\n" +
      "Authorization: Bearer unit-test-token\r\n" +
      "Content-Length: 5\r\n\r\nhe",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child, undefined, "ADB must not start before the full body arrives");

  const spawnPromise = once(spawned, "spawn");
  socket.end("llo");
  await spawnPromise;
  await waitFor(
    () => child.stdinBytes.length > 0,
    "the canonical request was not written to ADB",
  );

  assert.deepEqual(spawnArgs.args, [
    "-s",
    SERIAL,
    "shell",
    "toybox",
    "nc",
    "-4",
    "-W",
    "75",
    "127.0.0.1",
    "8080",
  ]);
  assert.deepEqual(spawnArgs.options, { stdio: ["pipe", "pipe", "pipe"] });
  assert.equal(child.stdin.writableEnded, false);
  assert.match(child.upstreamRequest(), /\r\nHost: 127\.0\.0\.1:8080\r\n/);
  assert.match(child.upstreamRequest(), /\r\nContent-Length: 5\r\n/);
  assert.match(child.upstreamRequest(), /\r\nConnection: close\r\n\r\nhello$/);

  child.stdout.write(
    "HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\nhello",
  );
  await waitFor(
    () => Buffer.concat(responseChunks).includes(Buffer.from("hello")),
    "the first response segment was not relayed",
  );
  assert.equal(responseEnded, false, "the response stream closed after its first segment");

  child.stdout.write(" world");
  child.finish();
  await once(socket, "close");
  const response = Buffer.concat(responseChunks).toString("latin1");
  assert.match(response, /\r\n\r\nhello world$/);
  assert.equal(child.killed, false);
});

test("keeps an event response streaming until the browser cancels", async (t) => {
  let child;
  const spawned = new EventEmitter();
  const { port } = await startTestBridge(t, {
    spawnImpl() {
      child = new FakeAdbChild();
      queueMicrotask(() => spawned.emit("spawn"));
      return child;
    },
  });

  const chunks = [];
  const socket = createConnection({ host: BRIDGE_HOST, port });
  socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  await once(socket, "connect");
  const spawnPromise = once(spawned, "spawn");
  socket.write("GET /api/events HTTP/1.1\r\nHost: localhost\r\n\r\n");
  await spawnPromise;

  child.stdout.write(
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n" +
      "15\r\n{\"type\":\"heartbeat\"}\n\r\n",
  );
  await waitFor(
    () => Buffer.concat(chunks).includes(Buffer.from("heartbeat")),
    "the first event was not relayed",
  );
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(child.killed, false);

  child.stdout.write("15\r\n{\"type\":\"heartbeat\"}\n\r\n");
  await waitFor(
    () =>
      (Buffer.concat(chunks).toString("utf8").match(/heartbeat/g) ?? []).length === 2,
    "the second event was not relayed",
  );

  const killed = once(child, "killed");
  socket.resetAndDestroy();
  await killed;
  assert.equal(child.killed, true);
  assert.equal(child.stdin.destroyed, true);
});

test("rejects unsupported framing before spawning ADB", async (t) => {
  let spawnCalls = 0;
  const { port } = await startTestBridge(t, {
    spawnImpl() {
      spawnCalls += 1;
      return new FakeAdbChild();
    },
  });

  const chunked = await rawRequest(
    port,
    "POST /api/settings HTTP/1.1\r\n" +
      "Host: localhost\r\n" +
      "Transfer-Encoding: chunked\r\n\r\n" +
      "0\r\n\r\n",
  );
  assert.match(chunked, /^HTTP\/1\.1 501 Not Implemented\r\n/);
  assert.match(chunked, /transfer-encoded request bodies are not supported/);
  assert.equal(spawnCalls, 0);
});

test("returns a generic 502 and never forwards spawn diagnostics", async (t) => {
  const sensitiveDiagnostic = "Bearer must-not-be-logged-or-returned";
  const { port } = await startTestBridge(t, {
    spawnImpl() {
      const child = new FakeAdbChild();
      queueMicrotask(() => child.emit("error", new Error(sensitiveDiagnostic)));
      return child;
    },
  });

  const response = await rawRequest(
    port,
    "GET /api/health HTTP/1.1\r\nHost: localhost\r\n\r\n",
  );
  assert.match(response, /^HTTP\/1\.1 502 Bad Gateway\r\n/);
  assert.match(response, /device bridge is unavailable/);
  assert.doesNotMatch(response, new RegExp(sensitiveDiagnostic));
});

test("binds only to loopback and validates all runtime routing inputs", async (t) => {
  const { bridge } = await startTestBridge(t, {
    spawnImpl() {
      return new FakeAdbChild();
    },
  });
  assert.equal(bridge.server.address().address, BRIDGE_HOST);
  assert.equal(bridge.server.maxConnections, 16);

  assert.deepEqual(
    parseCliArgs([
      "--serial",
      "device:5555",
      "--listen-port",
      "18081",
      "--device-port",
      "8080",
      "--adb-idle-seconds",
      "90",
    ]),
    {
      serial: "device:5555",
      adbPath: "adb",
      listenPort: 18081,
      devicePort: 8080,
      adbIdleSeconds: 90,
      help: false,
    },
  );
  assert.throws(() => parseCliArgs([]), /valid ADB serial/);
  assert.throws(
    () => parseCliArgs(["--serial", "device;reboot"]),
    /valid ADB serial/,
  );
  assert.throws(
    () => parseCliArgs(["--serial", "device", "--listen-port", "0"]),
    /listen port/,
  );
  assert.throws(
    () => parseCliArgs(["--serial", "device", "--adb-idle-seconds", "30"]),
    /exceed 30 seconds/,
  );
});

/*
 * The on-device `CenterUsbBridge` is the other implementation of the same
 * relay, and it must obey the same rule this file already enforces for the host
 * recovery bridge above ("keeps ADB stdin open"): never signal end-of-request
 * on the loopback socket while the response is still being produced.
 *
 * hyper's HTTP/1 server defaults to `half_close = false` and `axum::serve`
 * exposes no way to change it, so a read EOF that lands mid-request makes hyper
 * abort the connection and discard the response the handler was still building.
 * With the loopback socket half-closed after the request, that was a race the
 * device lost for every handler slower than an in-memory read: Center's
 * gallery, conversations, activity, and contacts panes saw a socket that closed
 * with zero response bytes, while `/api/health` answered 200 and made the
 * bridge look healthy.
 *
 * The Kotlin has no JVM-testable seam here — the relay is written against
 * `android.net.LocalSocket` — so this asserts on the source, together with the
 * exact-Content-Length rule that makes dropping the half-close safe.
 */
test("the on-device bridge never half-closes the loopback request socket", () => {
  const source = readFileSync(ON_DEVICE_BRIDGE, "utf8");
  const relay = source.slice(
    source.indexOf("private fun bridgeConnection"),
    source.indexOf("private fun copyExactly"),
  );
  assert.ok(relay.length > 0, "bridgeConnection was not found");

  // Both spellings: the helper call and a direct call on the loopback socket.
  assert.doesNotMatch(relay, /shutdownOutputQuietly\(httpSocket\)/);
  assert.doesNotMatch(relay, /httpSocket[^\n]*\.shutdownOutput\(\)/);

  // The ADB side keeps its half-close: it is the end-of-response signal for
  // Center's `makeEofStream` when a response has no Content-Length.
  assert.match(relay, /shutdownOutputQuietly\(localSocket\)/);

  // Dropping the half-close is only safe because the request is always framed
  // by an exact Content-Length, so the server never infers framing from EOF.
  const requestSecurity = readFileSync(ON_DEVICE_REQUEST_SECURITY, "utf8");
  assert.match(
    requestSecurity,
    /val exactContentLength = contentLength \?: throw RejectedRequest\(\)/,
  );
});
