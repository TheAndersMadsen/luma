import type { AdbSocket } from "@yume-chan/adb";
import { RemoteSignerAdbAuthStrategy } from "./adb/auth";
import {
  PIN_BRIDGE_ABSTRACT_SERVICE,
  WebUsbAdbSessionTransport,
  type AdbConnectionInfo,
  type AdbSessionTransport,
  type PinBridgeSocketTarget,
} from "./adb/transport";
import {
  BufferedPinResponse,
  type PinResponseLike,
  type PinTransport,
} from "./transport";

/**
 * Port the Pin's HTTP server listens on.
 *
 * Relocated here from the Setup SPA's `api/discovery.ts`, which is not ported:
 * mDNS probing of `penumbra*.local` is dead from an HTTPS origin. The constant
 * itself is still load-bearing for the `tcp:8080` legacy socket fallback and
 * for the `Host:` header the device's HTTP server expects.
 */
export const DEFAULT_PIN_PORT = 8080;

const START_SERVER_MAINTENANCE_COMMAND = [
  "content",
  "call",
  "--uri",
  "content://com.penumbraos.server.maintenance",
  "--method",
  "GET",
  "--arg",
  "/api/settings",
] as const;
const HTTP_HEADER_SEPARATOR = "\r\n\r\n";
const HTTP_HEADER_SEPARATOR_BYTES = new TextEncoder().encode(
  HTTP_HEADER_SEPARATOR,
);
type AdbReadableReader = ReturnType<AdbSocket["readable"]["getReader"]>;

class UsbStreamResponse implements PinResponseLike {
  readonly ok: boolean;

  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;

  constructor(
    status: number,
    statusText: string,
    headers: Headers,
    body: ReadableStream<Uint8Array> | null,
  ) {
    this.status = status;
    this.statusText = statusText;
    this.headers = headers;
    this.body = body;
    this.ok = status >= 200 && status < 300;
  }

  async arrayBuffer() {
    if (!this.body) return new ArrayBuffer(0);
    const reader = this.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalLength += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = mergeChunks(chunks, totalLength);
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  }

  async blob() {
    return new Blob([await this.arrayBuffer()], {
      type: this.headers.get("content-type") ?? undefined,
    });
  }

  async text() {
    return new TextDecoder().decode(await this.arrayBuffer());
  }

  async json() {
    return JSON.parse(await this.text()) as unknown;
  }
}

async function requestBodyToBytes(
  body: BodyInit | null | undefined,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof URLSearchParams)
    return new TextEncoder().encode(body.toString());
  throw new Error("USB mode does not support this request body type yet.");
}

function mergeChunks(chunks: Uint8Array[], totalLength: number) {
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function concatBytes(a: Uint8Array, b: Uint8Array) {
  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a, 0);
  result.set(b, a.byteLength);
  return result;
}

function indexOfBytes(buffer: Uint8Array, marker: Uint8Array) {
  outer: for (let i = 0; i <= buffer.byteLength - marker.byteLength; i += 1) {
    for (let j = 0; j < marker.byteLength; j += 1) {
      if (buffer[i + j] !== marker[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function parseHeaders(headerBytes: Uint8Array) {
  const headerText = new TextDecoder().decode(headerBytes);
  const [statusLine, ...headerLines] = headerText.split("\r\n");
  const statusMatch = statusLine.match(
    /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/i,
  );
  if (!statusMatch) {
    throw new Error(`USB HTTP response had invalid status line: ${statusLine}`);
  }

  const headers = new Headers();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }

  return {
    status: Number(statusMatch[1]),
    statusText: statusMatch[2] ?? "",
    headers,
  };
}

async function writeAll(socket: AdbSocket, bytes: Uint8Array) {
  const writer = socket.writable.getWriter();
  try {
    await writer.write(bytes);
  } finally {
    writer.releaseLock();
  }
}

async function readHeaders(reader: AdbReadableReader) {
  let buffer = new Uint8Array();
  while (true) {
    const separatorIndex = indexOfBytes(buffer, HTTP_HEADER_SEPARATOR_BYTES);
    if (separatorIndex >= 0) {
      return {
        headerBytes: buffer.slice(0, separatorIndex),
        remainder: buffer.slice(
          separatorIndex + HTTP_HEADER_SEPARATOR_BYTES.byteLength,
        ),
      };
    }

    const { done, value } = await reader.read();
    if (done) {
      throw new Error("USB HTTP response ended before headers were complete.");
    }
    buffer = concatBytes(buffer, value);
  }
}

function closeSocket(socket: AdbSocket) {
  return Promise.resolve(socket.close()).catch(() => undefined);
}

function hasNoBody(status: number, method: string) {
  return (
    method.toUpperCase() === "HEAD" ||
    status === 204 ||
    status === 304 ||
    (status >= 100 && status < 200)
  );
}

/**
 * Release the ADB socket and its reader exactly once. Erroring a stream via
 * `controller.error()` (e.g. on abort) does NOT invoke a ReadableStream's
 * `cancel` handler, so every terminal path — normal end, error, caller abort,
 * and a thrown parse failure — must funnel through here or the underlying
 * `localabstract:penumbra_http` socket leaks and the ADB readable stays locked.
 * Cancelling before releasing the lock keeps `releaseLock()` safe even when a
 * `reader.read()` is still outstanding.
 */
function createSocketReleaser(socket: AdbSocket, reader: AdbReadableReader) {
  let released = false;
  return async function release(reason?: unknown): Promise<void> {
    if (released) return;
    released = true;
    await reader.cancel(reason).catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // Already released/detached; the socket close below is what matters.
    }
    await closeSocket(socket);
  };
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("Aborted", "AbortError");
}

/**
 * Wire a caller's `AbortSignal` to a body stream.
 *
 * Every branch of `request()` needs this, not just the Content-Length one: the
 * Pin's NDJSON endpoints (`/api/events`, `/api/esim/events`) answer with
 * `Body::from_stream` and no Content-Length, so they take the chunked branch —
 * exactly the streams the stall detector and every unmount cleanup abort. With
 * the signal wired to only one branch, `controller.abort()` reached nothing: a
 * reader parked in `read()` stayed parked and the underlying
 * `localabstract:penumbra_http` socket leaked once per teardown.
 */
function wireAbortToStream(
  controller: ReadableStreamDefaultController<Uint8Array>,
  release: (reason?: unknown) => Promise<void>,
  signal: AbortSignal | undefined,
) {
  if (!signal) return;

  const abort = () => {
    controller.error(abortReason(signal));
    void release(signal.reason);
  };

  if (signal.aborted) {
    abort();
    return;
  }

  signal.addEventListener("abort", abort, { once: true });
}

/**
 * Race `work` against `signal`.
 *
 * An ADB socket has no cancellation of its own, so the loser is abandoned; the
 * caller closes the socket, and that is what unblocks the abandoned read. This
 * is what makes a deadline like `HEALTH_PROBE_TIMEOUT_MS` bound anything at all
 * — before it, `request()` consulted the signal for the first time when it
 * built the body stream, so a device that accepted the bridge socket and never
 * answered held the call open until the device-side bridge timed out.
 */
async function withAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) throw abortReason(signal);

  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(abortReason(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function makeFixedLengthStream(
  socket: AdbSocket,
  reader: AdbReadableReader,
  initial: Uint8Array,
  length: number,
  signal?: AbortSignal,
) {
  let remaining = length;
  let pending = initial;
  const release = createSocketReleaser(socket, reader);

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!Number.isFinite(remaining)) {
          controller.error(
            new Error(
              `USB HTTP response had an unparseable Content-Length: ${String(length)}.`,
            ),
          );
          await release();
          return;
        }

        if (remaining <= 0) {
          controller.close();
          await release();
          return;
        }

        if (pending.byteLength === 0) {
          const { done, value } = await reader.read();
          if (done) {
            controller.error(
              new Error(
                "USB HTTP response ended before Content-Length was satisfied.",
              ),
            );
            await release();
            return;
          }
          pending = value;
        }

        const chunk = pending.slice(0, Math.min(remaining, pending.byteLength));
        pending = pending.slice(chunk.byteLength);
        remaining -= chunk.byteLength;
        controller.enqueue(chunk);
      } catch (error) {
        controller.error(
          error instanceof Error ? error : new Error(String(error)),
        );
        await release();
      }
    },
    cancel(reason) {
      return release(reason);
    },
    start(controller) {
      wireAbortToStream(controller, release, signal);
    },
  });
}

function makeEofStream(
  socket: AdbSocket,
  reader: AdbReadableReader,
  initial: Uint8Array,
  signal?: AbortSignal,
) {
  let pending = initial;
  const release = createSocketReleaser(socket, reader);

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (pending.byteLength > 0) {
          controller.enqueue(pending);
          pending = new Uint8Array();
          return;
        }

        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await release();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(
          error instanceof Error ? error : new Error(String(error)),
        );
        await release();
      }
    },
    cancel(reason) {
      return release(reason);
    },
    start(controller) {
      wireAbortToStream(controller, release, signal);
    },
  });
}

function makeChunkedStream(
  socket: AdbSocket,
  reader: AdbReadableReader,
  initial: Uint8Array,
  signal?: AbortSignal,
) {
  let buffer = initial;
  let remainingChunkBytes = 0;
  let doneReading = false;
  const release = createSocketReleaser(socket, reader);

  async function ensureBytes(count: number) {
    while (buffer.byteLength < count) {
      const { done, value } = await reader.read();
      if (done) throw new Error("USB HTTP chunked response ended early.");
      buffer = concatBytes(buffer, value);
    }
  }

  async function readChunkSize() {
    while (true) {
      const newlineIndex = indexOfBytes(
        buffer,
        new TextEncoder().encode("\r\n"),
      );
      if (newlineIndex >= 0) {
        const line = new TextDecoder().decode(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 2);
        const size = Number.parseInt(line.split(";", 1)[0].trim(), 16);
        if (!Number.isInteger(size) || size < 0) {
          throw new Error(
            `USB HTTP chunked response had an invalid chunk size: ${line}.`,
          );
        }
        return size;
      }
      const { done, value } = await reader.read();
      if (done)
        throw new Error("USB HTTP chunked response ended before chunk size.");
      buffer = concatBytes(buffer, value);
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (doneReading) {
          controller.close();
          await release();
          return;
        }

        if (remainingChunkBytes === 0) {
          remainingChunkBytes = await readChunkSize();
          if (remainingChunkBytes === 0) {
            doneReading = true;
            await ensureBytes(2);
            buffer = buffer.slice(2);
            controller.close();
            await release();
            return;
          }
        }

        await ensureBytes(Math.min(remainingChunkBytes, 8192));
        const chunk = buffer.slice(
          0,
          Math.min(remainingChunkBytes, buffer.byteLength),
        );
        buffer = buffer.slice(chunk.byteLength);
        remainingChunkBytes -= chunk.byteLength;
        if (remainingChunkBytes === 0) {
          await ensureBytes(2);
          buffer = buffer.slice(2);
        }
        controller.enqueue(chunk);
      } catch (error) {
        controller.error(
          error instanceof Error ? error : new Error(String(error)),
        );
        await release();
      }
    },
    cancel(reason) {
      return release(reason);
    },
    start(controller) {
      wireAbortToStream(controller, release, signal);
    },
  });
}

export interface UsbAdbHttpTransportSessionOptions {
  readonly port?: number;
  /**
   * Run the shell-only maintenance provider probe that starts the on-device
   * server. Defaults to true; set false when the caller already did it.
   */
  readonly startMaintenanceService?: boolean;
}

/**
 * Best-effort nudge for the on-device HTTP server.
 *
 * Package replacement can leave the new server APK installed without a
 * BOOT_COMPLETED delivery. The shell-only maintenance provider starts the
 * service and waits for its loopback HTTP endpoint. Failure is not fatal: older
 * APKs without the provider can still use an already-running abstract or TCP
 * bridge, and the socket probe in `request()` remains the source of truth.
 */
async function startServerMaintenanceService(transport: AdbSessionTransport) {
  try {
    await transport.shell(START_SERVER_MAINTENANCE_COMMAND);
  } catch {
    // Intentionally ignored; see the doc comment above.
  }
}

export class UsbAdbHttpTransport implements PinTransport {
  readonly mode = "usb" as const;
  readonly baseUrl = null;
  readonly connectionInfo: AdbConnectionInfo;
  private readonly transport: AdbSessionTransport;
  private readonly port: number;
  private readonly ownsSession: boolean;

  private constructor(
    transport: AdbSessionTransport,
    connectionInfo: AdbConnectionInfo,
    port = DEFAULT_PIN_PORT,
    ownsSession = true,
  ) {
    this.transport = transport;
    this.connectionInfo = connectionInfo;
    this.port = port;
    this.ownsSession = ownsSession;
  }

  /**
   * The underlying ADB session.
   *
   * Exposed so the installer can drive shell/push/reboot over the SAME session
   * this transport tunnels HTTP through. Two `Adb` handles cannot claim the
   * same USB interface, so there is exactly one session per connected device
   * and it is owned by whoever created it.
   */
  get session(): AdbSessionTransport {
    return this.transport;
  }

  /** True when `disconnect()` will tear the ADB session down. */
  get ownsAdbSession(): boolean {
    return this.ownsSession;
  }

  /** Claim a USB device and own its ADB session. Requires a user gesture. */
  static async connect(port = DEFAULT_PIN_PORT) {
    const adbTransport = new WebUsbAdbSessionTransport({
      authStrategy: new RemoteSignerAdbAuthStrategy(),
    });
    const info = await adbTransport.connect();

    await startServerMaintenanceService(adbTransport);

    return new UsbAdbHttpTransport(adbTransport, info, port);
  }

  /**
   * Tunnel HTTP over an ADB session somebody else already opened and owns.
   *
   * This is the path Center actually uses: one WebUSB session, held by the
   * provider that stays mounted across route changes, carries BOTH the
   * SystemInjector installer and every settings/eSIM/flags/logs call. The
   * returned transport therefore does NOT close the session on `disconnect()`
   * — navigating away from a pane must not unplug the device.
   */
  static async fromSession(
    transport: AdbSessionTransport,
    connectionInfo?: AdbConnectionInfo,
    options: UsbAdbHttpTransportSessionOptions = {},
  ) {
    const info = connectionInfo ?? transport.connectionInfo;
    if (!info) {
      throw new Error("ADB session is not connected to a device.");
    }

    if (options.startMaintenanceService ?? true) {
      await startServerMaintenanceService(transport);
    }

    return new UsbAdbHttpTransport(
      transport,
      info,
      options.port ?? DEFAULT_PIN_PORT,
      false,
    );
  }

  async request(path: string, options: RequestInit = {}, signal?: AbortSignal) {
    const openBridgeSocket = this.transport.openBridgeSocket;
    if (!openBridgeSocket) {
      throw new Error(
        "ADB socket tunneling is not supported by this transport.",
      );
    }

    // Checked before anything is opened: an already-aborted caller must not
    // cost the device a bridge socket at all.
    if (signal?.aborted) throw abortReason(signal);

    /*
     * `withAbort` ABANDONS the open when the caller's deadline wins, and an
     * abandoned open can still succeed a moment later. Nothing else would ever
     * hold that socket, so close it on arrival — otherwise every timed-out
     * probe would leak the very `localabstract:penumbra_http` socket the
     * releaser exists to protect.
     */
    const openBridge = (target: PinBridgeSocketTarget) => {
      const pending = openBridgeSocket.call(this.transport, target);
      return withAbort(pending, signal).catch((error: unknown) => {
        void pending.then(closeSocket).catch(() => undefined);
        throw error;
      });
    };

    let socket: AdbSocket;
    try {
      socket = await openBridge({ kind: "abstract" });
    } catch (error) {
      // An abort is the caller's decision, not evidence that the abstract
      // bridge is missing; do not spend a second socket proving otherwise.
      if (signal?.aborted) throw error;
      try {
        socket = await openBridge({ kind: "tcp", port: this.port });
      } catch {
        throw new Error(
          `USB HTTP bridge is unavailable. Install the latest Ai Pin Revival Server APK with ${PIN_BRIDGE_ABSTRACT_SERVICE} support. Original error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    let reader: AdbReadableReader | null = null;
    try {
      const body = await requestBodyToBytes(options.body);
      const headers = new Headers(options.headers);
      if (!headers.has("Content-Length")) {
        headers.set("Content-Length", String(body.byteLength));
      }
      if (!headers.has("Host")) headers.set("Host", `127.0.0.1:${this.port}`);
      if (!headers.has("Connection")) headers.set("Connection", "close");
      if (!headers.has("Accept")) headers.set("Accept", "*/*");

      const method = options.method ?? "GET";
      const headerLines = Array.from(headers.entries()).map(
        ([key, value]) => `${key}: ${value}`,
      );
      const head = `${method} ${path} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`;
      const headBytes = new TextEncoder().encode(head);
      const requestBytes = new Uint8Array(
        headBytes.byteLength + body.byteLength,
      );
      requestBytes.set(headBytes, 0);
      requestBytes.set(body, headBytes.byteLength);

      await withAbort(writeAll(socket, requestBytes), signal);

      reader = socket.readable.getReader();
      // Headers are the unbounded wait that matters: a device that accepts the
      // bridge socket and then says nothing parks here forever, so the caller's
      // deadline has to reach it.
      const { headerBytes, remainder } = await withAbort(
        readHeaders(reader),
        signal,
      );
      const {
        status,
        statusText,
        headers: responseHeaders,
      } = parseHeaders(headerBytes);

      if (hasNoBody(status, method)) {
        reader.releaseLock();
        reader = null;
        await closeSocket(socket);
        return new BufferedPinResponse(
          status,
          statusText,
          responseHeaders,
          new Uint8Array(),
        );
      }

      const contentLength = responseHeaders.get("content-length");
      const transferEncoding =
        responseHeaders.get("transfer-encoding")?.toLowerCase() ?? "";
      const bodyStream = transferEncoding.includes("chunked")
        ? makeChunkedStream(socket, reader, remainder, signal)
        : contentLength !== null
          ? makeFixedLengthStream(
              socket,
              reader,
              remainder,
              Number(contentLength),
              signal,
            )
          : makeEofStream(socket, reader, remainder, signal);

      // Ownership of the reader passes to the body stream's releaser.
      reader = null;

      return new UsbStreamResponse(
        status,
        statusText,
        responseHeaders,
        bodyStream,
      );
    } catch (error) {
      // Cancelling first is what unblocks a `read()` this call abandoned when
      // the caller aborted; closing the socket alone would leave the ADB
      // readable locked by a reader nobody holds any more.
      if (reader) {
        await reader.cancel(error).catch(() => undefined);
        try {
          reader.releaseLock();
        } catch {
          // Already detached; the close below is what matters.
        }
      }
      await closeSocket(socket);
      throw error;
    }
  }

  assetUrl() {
    return null;
  }

  /**
   * Close the ADB session, but only if this transport opened it.
   *
   * `PinClient.disconnect()` calls through to here, and panes dispose their
   * clients on unmount. A borrowed session must survive that.
   */
  async disconnect() {
    if (!this.ownsSession) {
      return;
    }
    await this.transport.disconnect();
  }
}
