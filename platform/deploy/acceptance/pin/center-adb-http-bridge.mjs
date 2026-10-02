#!/usr/bin/env -S bun --no-env-file

import { spawn as spawnProcess } from "node:child_process";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";

export const BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_LISTEN_PORT = 18_080;
export const DEFAULT_DEVICE_PORT = 8_080;
export const DEFAULT_MAX_HEADER_BYTES = 64 * 1024;
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_MAX_CONNECTIONS = 16;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_ADB_IDLE_SECONDS = 75;

const MAX_HEADER_COUNT = 64;
const MAX_HEADER_NAME_BYTES = 128;
const MAX_METHOD_BYTES = 32;
const MAX_REQUEST_TARGET_BYTES = 8 * 1024;
const MAX_SERIAL_BYTES = 128;
const HEADER_TERMINATOR = Buffer.from("\r\n\r\n", "latin1");
const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SERIAL_PATTERN = /^[0-9A-Za-z._:-]+$/;
const FIXED_HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export class BridgeRequestError extends Error {
  constructor(statusCode, reasonPhrase, publicMessage) {
    super(publicMessage);
    this.name = "BridgeRequestError";
    this.statusCode = statusCode;
    this.reasonPhrase = reasonPhrase;
    this.publicMessage = publicMessage;
  }
}

function requestError(statusCode, reasonPhrase, publicMessage) {
  return new BridgeRequestError(statusCode, reasonPhrase, publicMessage);
}

function isVisibleHeaderValue(value) {
  for (const byte of Buffer.from(value, "latin1")) {
    if (byte !== 0x09 && (byte < 0x20 || byte > 0x7e)) return false;
  }
  return true;
}

function trimOptionalWhitespace(value) {
  return value.replace(/^[ \t]+|[ \t]+$/g, "");
}

function parseContentLength(values, maxBodyBytes) {
  if (values.length > 1) {
    throw requestError(
      400,
      "Bad Request",
      "multiple content-length headers are not supported",
    );
  }
  if (values.length === 0) return 0;

  const value = values[0];
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw requestError(400, "Bad Request", "invalid content-length header");
  }
  const contentLength = Number(value);
  if (!Number.isSafeInteger(contentLength)) {
    throw requestError(400, "Bad Request", "invalid content-length header");
  }
  if (contentLength > maxBodyBytes) {
    throw requestError(413, "Payload Too Large", "request body is too large");
  }
  return contentLength;
}

function parseConnectionTokens(values) {
  const tokens = new Set();
  for (const value of values) {
    for (const candidate of value.split(",")) {
      const token = trimOptionalWhitespace(candidate).toLowerCase();
      if (!token || !HTTP_TOKEN_PATTERN.test(token)) {
        throw requestError(400, "Bad Request", "invalid connection header");
      }
      tokens.add(token);
    }
  }
  return tokens;
}

/** Parse a complete HTTP/1.1 header block without the trailing CRLFCRLF. */
export function parseRequestHead(
  input,
  {
    maxHeaderBytes = DEFAULT_MAX_HEADER_BYTES,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  } = {},
) {
  const bytes = Buffer.isBuffer(input)
    ? input
    : Buffer.from(String(input), "latin1");
  if (bytes.length > maxHeaderBytes) {
    throw requestError(
      431,
      "Request Header Fields Too Large",
      "request headers are too large",
    );
  }
  if (bytes.includes(0)) {
    throw requestError(400, "Bad Request", "invalid request headers");
  }

  const lines = bytes.toString("latin1").split("\r\n");
  // Accept callers that include the first CRLF from the header terminator.
  // The live accumulator passes the block without it, but this keeps the pure
  // parser unambiguous for tests and other reuse.
  if (lines.at(-1) === "") lines.pop();
  const requestLine = lines.shift() ?? "";
  const match = requestLine.match(/^([^ ]+) ([^ ]+) (HTTP\/[^ ]+)$/);
  if (!match) {
    throw requestError(400, "Bad Request", "invalid request line");
  }

  const [, method, target, version] = match;
  if (
    method.length > MAX_METHOD_BYTES ||
    !HTTP_TOKEN_PATTERN.test(method)
  ) {
    throw requestError(400, "Bad Request", "invalid request method");
  }
  if (version !== "HTTP/1.1") {
    throw requestError(
      505,
      "HTTP Version Not Supported",
      "only HTTP/1.1 is supported",
    );
  }
  if (
    target.length > MAX_REQUEST_TARGET_BYTES ||
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("#") ||
    [...Buffer.from(target, "latin1")].some(
      (byte) => byte < 0x21 || byte > 0x7e,
    )
  ) {
    throw requestError(400, "Bad Request", "invalid request target");
  }

  if (lines.length > MAX_HEADER_COUNT) {
    throw requestError(
      431,
      "Request Header Fields Too Large",
      "too many request headers",
    );
  }

  const headers = [];
  const byName = new Map();
  for (const line of lines) {
    if (!line || line.startsWith(" ") || line.startsWith("\t")) {
      throw requestError(400, "Bad Request", "invalid request header");
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      throw requestError(400, "Bad Request", "invalid request header");
    }
    const name = line.slice(0, colon);
    const value = trimOptionalWhitespace(line.slice(colon + 1));
    if (
      name.length > MAX_HEADER_NAME_BYTES ||
      !HTTP_TOKEN_PATTERN.test(name) ||
      !isVisibleHeaderValue(value)
    ) {
      throw requestError(400, "Bad Request", "invalid request header");
    }
    const lowerName = name.toLowerCase();
    headers.push({ name, lowerName, value });
    const values = byName.get(lowerName) ?? [];
    values.push(value);
    byName.set(lowerName, values);
  }

  if ((byName.get("host") ?? []).length !== 1) {
    throw requestError(400, "Bad Request", "exactly one host header is required");
  }

  const transferEncodings = byName.get("transfer-encoding") ?? [];
  const contentLengths = byName.get("content-length") ?? [];
  if (transferEncodings.length > 0 && contentLengths.length > 0) {
    throw requestError(400, "Bad Request", "conflicting request framing");
  }
  if (transferEncodings.length > 0) {
    throw requestError(
      501,
      "Not Implemented",
      "transfer-encoded request bodies are not supported",
    );
  }
  if ((byName.get("expect") ?? []).length > 0) {
    throw requestError(417, "Expectation Failed", "expect is not supported");
  }
  if ((byName.get("upgrade") ?? []).length > 0) {
    throw requestError(400, "Bad Request", "protocol upgrades are not supported");
  }

  const contentLength = parseContentLength(contentLengths, maxBodyBytes);
  const connectionTokens = parseConnectionTokens(byName.get("connection") ?? []);
  return {
    method,
    target,
    headers,
    contentLength,
    connectionTokens,
  };
}

/** Build one canonical request for the device loopback HTTP listener. */
export function buildUpstreamRequest(parsed, body, devicePort = DEFAULT_DEVICE_PORT) {
  const bodyBytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (bodyBytes.length !== parsed.contentLength) {
    throw new Error("request body length does not match parsed content-length");
  }
  validatePort(devicePort, { allowZero: false, label: "device port" });

  const lines = [
    `${parsed.method} ${parsed.target} HTTP/1.1`,
    `Host: 127.0.0.1:${devicePort}`,
  ];
  for (const header of parsed.headers) {
    if (
      FIXED_HOP_BY_HOP_HEADERS.has(header.lowerName) ||
      header.lowerName === "content-length" ||
      parsed.connectionTokens.has(header.lowerName)
    ) {
      continue;
    }
    lines.push(`${header.name}: ${header.value}`);
  }
  lines.push(`Content-Length: ${bodyBytes.length}`);
  lines.push("Connection: close", "", "");
  return Buffer.concat([Buffer.from(lines.join("\r\n"), "latin1"), bodyBytes]);
}

function errorResponse(statusCode, reasonPhrase, publicMessage) {
  const body = Buffer.from(`${publicMessage}\n`, "utf8");
  return Buffer.concat([
    Buffer.from(
      `HTTP/1.1 ${statusCode} ${reasonPhrase}\r\n` +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        `Content-Length: ${body.length}\r\n` +
        "Cache-Control: no-store\r\n" +
        "Connection: close\r\n\r\n",
      "latin1",
    ),
    body,
  ]);
}

function sendError(socket, error) {
  if (socket.destroyed || socket.writableEnded) return;
  const safeError =
    error instanceof BridgeRequestError
      ? error
      : requestError(502, "Bad Gateway", "device bridge is unavailable");
  socket.end(
    errorResponse(
      safeError.statusCode,
      safeError.reasonPhrase,
      safeError.publicMessage,
    ),
  );
}

function validateSerial(serial) {
  if (
    typeof serial !== "string" ||
    serial.length === 0 ||
    serial.length > MAX_SERIAL_BYTES ||
    !SERIAL_PATTERN.test(serial)
  ) {
    throw new Error("a valid ADB serial is required");
  }
  return serial;
}

function validatePort(value, { allowZero, label }) {
  if (
    !Number.isInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > 65_535
  ) {
    throw new Error(`${label} must be an integer between ${allowZero ? 0 : 1} and 65535`);
  }
  return value;
}

function validatePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function safeKill(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  try {
    child.kill();
  } catch {
    // The process may already have exited between the state check and kill.
  }
}

function startDeviceRelay({
  socket,
  session,
  request,
  serial,
  adbPath,
  devicePort,
  adbIdleSeconds,
  spawnImpl,
}) {
  let child;
  try {
    child = spawnImpl(
      adbPath,
      [
        "-s",
        serial,
        // `adb exec-out` does not forward an open host stdin reliably on the
        // Pin's ADB build. Non-PTY `adb shell` does, while still preserving the
        // raw HTTP byte stream and separate stderr channel.
        "shell",
        "toybox",
        "nc",
        "-4",
        "-W",
        String(adbIdleSeconds),
        BRIDGE_HOST,
        String(devicePort),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    sendError(socket, requestError(502, "Bad Gateway", "device bridge is unavailable"));
    return;
  }

  session.child = child;
  let responseStarted = false;
  let upstreamClosed = false;

  // ADB diagnostics can include device identifiers and request context. Drain
  // them without forwarding or logging them.
  child.stderr?.resume();
  child.stdout.once("data", () => {
    responseStarted = true;
  });
  child.stdout.pipe(socket, { end: false });

  const upstreamFailure = () => {
    if (upstreamClosed || socket.destroyed) return;
    upstreamClosed = true;
    if (responseStarted) socket.destroy();
    else sendError(socket, requestError(502, "Bad Gateway", "device bridge is unavailable"));
  };

  child.once("error", upstreamFailure);
  child.stdout.once("error", upstreamFailure);
  child.stdin.once("error", (error) => {
    if (error?.code !== "EPIPE") upstreamFailure();
  });
  child.once("close", () => {
    upstreamClosed = true;
    session.child = null;
    if (!socket.destroyed && !socket.writableEnded) socket.end();
  });

  // Deliberately do not call child.stdin.end(). The request has explicit
  // Content-Length framing, so the server can answer while the full-duplex ADB
  // socket remains open. Browser cancellation or remote close performs cleanup.
  child.stdin.write(request, (error) => {
    if (error) upstreamFailure();
  });
}

export function createCenterAdbHttpBridge({
  serial,
  adbPath = "adb",
  devicePort = DEFAULT_DEVICE_PORT,
  maxHeaderBytes = DEFAULT_MAX_HEADER_BYTES,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  maxConnections = DEFAULT_MAX_CONNECTIONS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  adbIdleSeconds = DEFAULT_ADB_IDLE_SECONDS,
  spawnImpl = spawnProcess,
} = {}) {
  const validatedSerial = validateSerial(serial);
  validatePort(devicePort, { allowZero: false, label: "device port" });
  validatePositiveInteger(maxHeaderBytes, "maximum header bytes");
  validatePositiveInteger(maxBodyBytes, "maximum body bytes");
  validatePositiveInteger(maxConnections, "maximum connections");
  validatePositiveInteger(requestTimeoutMs, "request timeout");
  validatePositiveInteger(adbIdleSeconds, "ADB idle timeout");
  if (adbIdleSeconds <= 30) {
    throw new Error("ADB idle timeout must exceed the 30-second event heartbeat");
  }
  if (typeof adbPath !== "string" || adbPath.length === 0) {
    throw new Error("ADB executable path is required");
  }

  const sessions = new Set();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const session = { socket, child: null };
    sessions.add(session);
    socket.setNoDelay(true);
    socket.setTimeout(requestTimeoutMs);

    let buffer = Buffer.alloc(0);
    let parsed = null;
    let expectedBytes = null;
    let launched = false;
    let rejected = false;

    const reject = (error) => {
      if (rejected || launched) return;
      rejected = true;
      sendError(socket, error);
    };

    const inspectRequest = () => {
      if (rejected || launched) return;
      if (!parsed) {
        const marker = buffer.indexOf(HEADER_TERMINATOR);
        if (marker < 0) {
          if (buffer.length > maxHeaderBytes) {
            reject(
              requestError(
                431,
                "Request Header Fields Too Large",
                "request headers are too large",
              ),
            );
          }
          return;
        }
        if (marker > maxHeaderBytes) {
          reject(
            requestError(
              431,
              "Request Header Fields Too Large",
              "request headers are too large",
            ),
          );
          return;
        }
        try {
          parsed = parseRequestHead(buffer.subarray(0, marker), {
            maxHeaderBytes,
            maxBodyBytes,
          });
        } catch (error) {
          reject(error);
          return;
        }
        expectedBytes = marker + HEADER_TERMINATOR.length + parsed.contentLength;
      }

      if (buffer.length < expectedBytes) return;
      if (buffer.length > expectedBytes) {
        reject(requestError(400, "Bad Request", "HTTP pipelining is not supported"));
        return;
      }

      const marker = buffer.indexOf(HEADER_TERMINATOR);
      const body = buffer.subarray(marker + HEADER_TERMINATOR.length);
      let request;
      try {
        request = buildUpstreamRequest(parsed, body, devicePort);
      } catch {
        reject(requestError(400, "Bad Request", "invalid request framing"));
        return;
      }

      launched = true;
      buffer = Buffer.alloc(0);
      socket.setTimeout(0);
      startDeviceRelay({
        socket,
        session,
        request,
        serial: validatedSerial,
        adbPath,
        devicePort,
        adbIdleSeconds,
        spawnImpl,
      });
    };

    socket.on("data", (chunk) => {
      if (rejected) return;
      if (launched) {
        socket.destroy();
        return;
      }
      const maximumBufferedBytes = maxHeaderBytes + HEADER_TERMINATOR.length + maxBodyBytes;
      if (buffer.length + chunk.length > maximumBufferedBytes) {
        reject(requestError(413, "Payload Too Large", "request is too large"));
        return;
      }
      buffer = Buffer.concat([buffer, chunk], buffer.length + chunk.length);
      inspectRequest();
    });
    socket.on("end", () => {
      if (!launched && !rejected) {
        reject(requestError(400, "Bad Request", "request ended before it was complete"));
      }
      // A complete client-side half-close is legal. allowHalfOpen keeps the
      // response side alive while the ADB relay finishes.
    });
    socket.on("timeout", () => {
      reject(requestError(408, "Request Timeout", "request timed out"));
    });
    socket.on("error", () => {});
    socket.once("close", () => {
      sessions.delete(session);
      safeKill(session.child);
      session.child = null;
    });
  });

  server.maxConnections = maxConnections;

  return {
    server,
    async listen(port = DEFAULT_LISTEN_PORT) {
      validatePort(port, { allowZero: true, label: "listen port" });
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, BRIDGE_HOST);
      });
      return server.address();
    },
    async close() {
      for (const session of sessions) {
        session.socket.destroy();
        safeKill(session.child);
      }
      sessions.clear();
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function parseCliInteger(value, label, { allowZero = false } = {}) {
  if (!/^[0-9]+$/.test(value ?? "")) {
    throw new Error(`${label} must be an integer`);
  }
  const parsed = Number(value);
  validatePort(parsed, { allowZero, label });
  return parsed;
}

export function parseCliArgs(argv) {
  const options = {
    serial: null,
    adbPath: "adb",
    listenPort: DEFAULT_LISTEN_PORT,
    devicePort: DEFAULT_DEVICE_PORT,
    adbIdleSeconds: DEFAULT_ADB_IDLE_SECONDS,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      return value;
    };
    switch (argument) {
      case "--serial":
        options.serial = next();
        break;
      case "--adb":
        options.adbPath = next();
        break;
      case "--listen-port":
        options.listenPort = parseCliInteger(next(), "listen port", {
          allowZero: false,
        });
        break;
      case "--device-port":
        options.devicePort = parseCliInteger(next(), "device port");
        break;
      case "--adb-idle-seconds": {
        const value = next();
        if (!/^[0-9]+$/.test(value)) {
          throw new Error("ADB idle timeout must be an integer");
        }
        options.adbIdleSeconds = Number(value);
        if (!Number.isSafeInteger(options.adbIdleSeconds) || options.adbIdleSeconds <= 30) {
          throw new Error("ADB idle timeout must exceed 30 seconds");
        }
        break;
      }
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option: ${argument}`);
    }
  }

  if (!options.help) validateSerial(options.serial);
  if (typeof options.adbPath !== "string" || options.adbPath.length === 0) {
    throw new Error("ADB executable path is required");
  }
  return options;
}

function usage() {
  return [
    "Usage: bun platform/deploy/acceptance/pin/center-adb-http-bridge.mjs --serial SERIAL [options]",
    "",
    "Options:",
    `  --listen-port PORT       Host loopback port (default ${DEFAULT_LISTEN_PORT})`,
    `  --device-port PORT       Device loopback port (default ${DEFAULT_DEVICE_PORT})`,
    `  --adb-idle-seconds N     Upstream idle timeout (default ${DEFAULT_ADB_IDLE_SECONDS})`,
    "  --adb PATH               ADB executable (default: adb from PATH)",
    "  -h, --help               Show this help",
  ].join("\n");
}

async function main() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "invalid arguments");
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }

  const bridge = createCenterAdbHttpBridge(options);
  try {
    const address = await bridge.listen(options.listenPort);
    console.log(
      `Center ADB HTTP recovery bridge listening on http://${BRIDGE_HOST}:${address.port}`,
    );
  } catch {
    console.error("Center ADB HTTP recovery bridge failed to listen");
    process.exitCode = 1;
    return;
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await bridge.close().catch(() => undefined);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
