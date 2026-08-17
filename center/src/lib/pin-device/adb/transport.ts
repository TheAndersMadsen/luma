import { Adb, AdbDaemonTransport, type AdbSocket } from "@yume-chan/adb";
import {
  AdbDaemonWebUsbDevice,
  AdbDaemonWebUsbDeviceManager,
} from "@yume-chan/adb-daemon-webusb";
import {
  ConcatStringStream,
  ReadableStream,
  TextDecoderStream,
} from "@yume-chan/stream-extra";
import { logDebug, logError, logInfo, logWarn } from "../logging";
import type { AdbAuthStrategy } from "./auth";

export interface AdbConnectionInfo {
  readonly serial: string;
  readonly name: string;
}

/**
 * The ADB service the Pin's Revival server publishes its HTTP bridge on.
 *
 * It lives here, next to the transport that opens sockets, rather than next to
 * `UsbAdbHttpTransport` that consumes them: resolving a TARGET into a service
 * string is the whole point of `openBridgeSocket()`. A caller names one of the
 * Pin's two bridges; it never names an ADB service. `shell:` — the service
 * `openPty()` is built on — is therefore not reachable through a session that
 * only exposes this.
 */
export const PIN_BRIDGE_ABSTRACT_SERVICE = "localabstract:penumbra_http";

/**
 * Which of the Pin's two HTTP bridges to open. A current Revival server
 * publishes the abstract socket; the TCP port is the loopback fallback an older
 * APK still answers on.
 */
export type PinBridgeSocketTarget =
  | { readonly kind: "abstract" }
  | { readonly kind: "tcp"; readonly port: number };

export function pinBridgeSocketService(target: PinBridgeSocketTarget): string {
  if (target.kind === "abstract") {
    return PIN_BRIDGE_ABSTRACT_SERVICE;
  }

  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    throw new Error(
      `Refusing to open an ADB socket for an out-of-range Pin port: ${String(target.port)}.`,
    );
  }

  return `tcp:${target.port}`;
}

/** Where a session is in its lifecycle, as seen by whoever observes it. */
export type AdbSessionPhase = "connecting" | "connected" | "idle" | "error";

export interface AdbSessionStateChange {
  readonly phase: AdbSessionPhase;
  /** The device behind the transport AFTER the change; null once it is gone. */
  readonly info: AdbConnectionInfo | null;
  readonly error?: unknown;
}

export interface ShellResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface ShellWithInputProgress {
  readonly bytesWritten: number;
  readonly totalBytes: number;
  readonly elapsedMs: number;
}

export interface ShellWithInputOptions {
  readonly onProgress?: (progress: ShellWithInputProgress) => void;
}

export interface CommandStreamLine {
  readonly id: string;
  readonly timestamp: string;
  readonly text: string;
}

export interface CommandStreamController {
  stop(): Promise<void>;
}

export interface AdbPtySession {
  readonly output: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  write(data: Uint8Array): Promise<void>;
  sigint(): Promise<void>;
  close(): Promise<void>;
}

export interface AdbSessionTransport {
  readonly connectionInfo: AdbConnectionInfo | null;
  connect(): Promise<AdbConnectionInfo>;
  reconnect(): Promise<AdbConnectionInfo>;
  disconnect(): Promise<void>;
  shell(command: string | readonly string[]): Promise<ShellResult>;
  shellWithInput(
    command: string | readonly string[],
    input: Blob,
    options?: ShellWithInputOptions,
  ): Promise<ShellResult>;
  pushFile(remotePath: string, file: Blob): Promise<void>;
  reboot(): Promise<void>;
  startCommandStream(
    command: string | readonly string[],
    onLine: (line: CommandStreamLine) => void,
  ): Promise<CommandStreamController>;
  /**
   * Open one of the Pin's two HTTP bridges. This replaced a free-form
   * `createSocket(service)`: that took an arbitrary ADB service string straight
   * to the daemon, so `createSocket("shell:")` reached the same service
   * `openPty()` is built on and any capability-reduced session that forwarded it
   * still handed out a root shell. Optional because
   * `UsbAdbHttpTransport.request()` fails closed on a transport that cannot
   * tunnel at all, and that check has to keep meaning what it says.
   */
  openBridgeSocket?(target: PinBridgeSocketTarget): Promise<AdbSocket>;
  /**
   * The interactive ROOT shell on the wearer's Pin.
   *
   * OPTIONAL on purpose. Every pane under `/settings/pin` — an ungated wearer
   * surface — drives the device through a value of this type, so the capability
   * must be absent from the session those panes can obtain rather than present
   * and refused at run time. `AdbOperatorSessionTransport` is the type that
   * really carries it, and only `/admin/pin/terminal` asks for one.
   */
  openPty?(): Promise<AdbPtySession>;
}

/**
 * A session that really does carry the device shell.
 *
 * Handed out by exactly one accessor (`getPinAdbSession()` in
 * `@/lib/pin-session`) and consumed by exactly one component
 * (`app/admin/pin/terminal/DeviceTerminal.tsx`), which sits behind the operator
 * gate that `verify/pin-terminal-gate.test.mjs` pins.
 */
export interface AdbOperatorSessionTransport extends AdbSessionTransport {
  openPty(): Promise<AdbPtySession>;
}

export const DEVICE_STEP_TIMEOUT_MS = 60000;

export class AdbDeviceStepTimeoutError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs = DEVICE_STEP_TIMEOUT_MS) {
    super(`Timed out after ${timeoutMs}ms during device step: ${operation}.`);
    this.name = "AdbDeviceStepTimeoutError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

const timedTransportCache = new WeakMap<AdbSessionTransport, AdbSessionTransport>();
const timedTransportWrappers = new WeakSet<AdbSessionTransport>();

function formatCommand(command: string | readonly string[]) {
  return Array.isArray(command) ? command.join(" ") : command;
}

export function withDeviceStepTimeout<T>(
  operation: string,
  work: () => Promise<T>,
  timeoutMs = DEVICE_STEP_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeoutId = globalThis.setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      reject(new AdbDeviceStepTimeoutError(operation, timeoutMs));
    }, timeoutMs);

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      globalThis.clearTimeout(timeoutId);
      callback();
    };

    let workPromise: Promise<T>;
    try {
      workPromise = work();
    } catch (error) {
      settle(() => reject(error));
      return;
    }

    workPromise.then(
      (value) => {
        settle(() => resolve(value));
      },
      (error) => {
        settle(() => reject(error));
      },
    );
  });
}

export function createTimedAdbSessionTransport(
  transport: AdbSessionTransport,
  timeoutMs = DEVICE_STEP_TIMEOUT_MS,
): AdbSessionTransport {
  if (timedTransportWrappers.has(transport)) {
    return transport;
  }

  if (timeoutMs === DEVICE_STEP_TIMEOUT_MS) {
    const cached = timedTransportCache.get(transport);
    if (cached) {
      return cached;
    }
  }

  const wrappedTransport: AdbSessionTransport = {
    get connectionInfo() {
      return transport.connectionInfo;
    },
    connect() {
      return transport.connect();
    },
    reconnect() {
      return transport.reconnect();
    },
    disconnect() {
      return transport.disconnect();
    },
    shell(command) {
      return withDeviceStepTimeout(
        `shell ${formatCommand(command)}`,
        () => transport.shell(command),
        timeoutMs,
      );
    },
    shellWithInput(command, input, options) {
      return withDeviceStepTimeout(
        `shellWithInput ${formatCommand(command)}`,
        () => transport.shellWithInput(command, input, options),
        timeoutMs,
      );
    },
    pushFile(remotePath, file) {
      return withDeviceStepTimeout(
        `pushFile ${remotePath}`,
        () => transport.pushFile(remotePath, file),
        timeoutMs,
      );
    },
    reboot() {
      return withDeviceStepTimeout("reboot", () => transport.reboot(), timeoutMs);
    },
    startCommandStream(command, onLine) {
      return transport.startCommandStream(command, onLine);
    },
  };

  // `UsbAdbHttpTransport.request()` fails closed when the transport it is given
  // cannot open a bridge socket, and the HTTP-over-ADB tunnel is how every Pin
  // settings/eSIM/flags/logs call reaches the device. Forwarding it here is
  // what lets one shared, timed session carry both the installer and the
  // configuration panes. Deliberately NOT wrapped in the step timeout —
  // `openPty` and `startCommandStream` are untimed for the same reason: the
  // socket outlives the call that opens it, and a late rejection would leak it.
  const openBridgeSocket = transport.openBridgeSocket;
  if (openBridgeSocket) {
    wrappedTransport.openBridgeSocket = (target) =>
      openBridgeSocket.call(transport, target);
  }

  // Forwarded only when the wrapped session actually has it, so wrapping a
  // wearer session in timeouts can never conjure a device shell back onto it.
  const openPty = transport.openPty;
  if (openPty) {
    wrappedTransport.openPty = () => openPty.call(transport);
  }

  timedTransportWrappers.add(wrappedTransport);
  if (timeoutMs === DEVICE_STEP_TIMEOUT_MS) {
    timedTransportCache.set(transport, wrappedTransport);
  }

  return wrappedTransport;
}

export class AdbTransportRecoveredDisconnectError extends Error {
  readonly operation: string;
  readonly attemptsSinceSuccess: number;
  readonly maxAttemptsSinceSuccess: number;
  override readonly cause: unknown;

  constructor(
    operation: string,
    attemptsSinceSuccess: number,
    maxAttemptsSinceSuccess: number,
    cause?: unknown,
  ) {
    super(`Socket closed during ${operation}. ADB session was reconnected.`, {
      cause,
    });
    this.name = "AdbTransportRecoveredDisconnectError";
    this.operation = operation;
    this.attemptsSinceSuccess = attemptsSinceSuccess;
    this.maxAttemptsSinceSuccess = maxAttemptsSinceSuccess;
    this.cause = cause;
  }
}

function errorMessageIncludesSocketClosed(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Socket closed");
}

async function* fixedSizeChunks(
  input: Blob,
  chunkBytes: number,
): AsyncGenerator<Uint8Array, void, void> {
  let offset = 0;

  while (offset < input.size) {
    const end = Math.min(offset + chunkBytes, input.size);
    yield new Uint8Array(await input.slice(offset, end).arrayBuffer());
    offset = end;
  }
}

const MAX_RETRYABLE_DISCONNECTS_SINCE_SUCCESS = 3;
const SHELL_WITH_INPUT_WRITE_CHUNK_BYTES = 64 * 1024;

export interface WebUsbAdbSessionTransportOptions {
  authStrategy: AdbAuthStrategy;
  /**
   * Called whenever `adb`/`info` change, from inside this class.
   *
   * It has to live here rather than on a wrapper because the transport
   * reconnects ITSELF: `recoverFromRetryableDisconnect()` calls `reconnect()`
   * on `this`, so a wrapper's reconnect branch never runs. An observer wired to
   * the wrapper therefore kept publishing "connected" with the old serial while
   * the session underneath had been torn down and re-bound — and on the success
   * path, everything derived from the old device (the HTTP tunnel, the
   * `PinClient` whose object identity is the per-device cache boundary in
   * `settings/pin/_lib/useDeviceSettings.ts`) survived onto a device that may
   * not even be the same Pin.
   */
  onStateChange?: (change: AdbSessionStateChange) => void;
}

export class WebUsbAdbSessionTransport implements AdbOperatorSessionTransport {
  private adb: Adb | null = null;
  private info: AdbConnectionInfo | null = null;
  private readonly authStrategy: AdbAuthStrategy;
  private readonly onStateChange:
    | ((change: AdbSessionStateChange) => void)
    | undefined;
  private retryableDisconnectsSinceSuccess = 0;
  private streamSubscriptionId = 0;
  private currentStreamStop: (() => Promise<void>) | null = null;
  private currentStreamHandler: ((line: CommandStreamLine) => void) | null =
    null;
  private currentStreamCommand: string | readonly string[] | null = null;
  private currentPtySession: AdbPtySession | null = null;
  /**
   * True for the whole of `reconnect()`, including the `disconnect()` inside it.
   * A reconnect is ONE continuous "connecting" window: publishing `idle` in the
   * middle of it would make every consumer clear its device-derived state and
   * tear the console down mid-operation, which is exactly what the recovery
   * path exists to avoid.
   */
  private reconnecting = false;

  constructor(options: WebUsbAdbSessionTransportOptions) {
    this.authStrategy = options.authStrategy;
    this.onStateChange = options.onStateChange;
  }

  get connectionInfo(): AdbConnectionInfo | null {
    return this.info;
  }

  private emitState(phase: AdbSessionPhase, error?: unknown) {
    this.onStateChange?.({ phase, info: this.info, error });
  }

  private markOperationSuccess() {
    this.retryableDisconnectsSinceSuccess = 0;
  }

  private async recoverFromRetryableDisconnect(
    operation: string,
    cause: unknown,
    rethrowRecoveredError = true,
  ) {
    if (!errorMessageIncludesSocketClosed(cause)) {
      throw cause;
    }

    this.retryableDisconnectsSinceSuccess += 1;
    if (
      this.retryableDisconnectsSinceSuccess >
      MAX_RETRYABLE_DISCONNECTS_SINCE_SUCCESS
    ) {
      throw cause;
    }

    logWarn("install-adb", "Socket closed during operation; reconnecting", {
      operation,
      attemptsSinceSuccess: this.retryableDisconnectsSinceSuccess,
      maxAttemptsSinceSuccess: MAX_RETRYABLE_DISCONNECTS_SINCE_SUCCESS,
      device: this.info,
    });

    await this.reconnect();

    if (rethrowRecoveredError) {
      throw new AdbTransportRecoveredDisconnectError(
        operation,
        this.retryableDisconnectsSinceSuccess,
        MAX_RETRYABLE_DISCONNECTS_SINCE_SUCCESS,
        cause,
      );
    }
  }

  async connect(): Promise<AdbConnectionInfo> {
    // Already claimed: `connect()` is idempotent and does not re-prompt, so it
    // must not announce a state change either.
    if (this.adb && this.info) {
      return this.info;
    }

    this.emitState("connecting");

    try {
      const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
      if (!manager) {
        throw new Error("WebUSB is not supported in this browser.");
      }

      const device = await manager.requestDevice();
      if (!device) {
        throw new Error("No USB device was selected.");
      }

      return await this.connectToDevice(device);
    } catch (error) {
      this.emitState("error", error);
      throw error;
    }
  }

  async reconnect(): Promise<AdbConnectionInfo> {
    const previousInfo = this.info;
    const activeStream = this.currentStreamHandler && this.currentStreamCommand;

    this.reconnecting = true;
    this.emitState("connecting");

    try {
      const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
      if (!manager) {
        throw new Error("WebUSB is not supported in this browser.");
      }

      await this.disconnect();

      const devices = await manager.getDevices();
      if (devices.length === 0) {
        throw new Error("No previously authorized USB device is available.");
      }

      /*
       * No `?? devices[0]` fallback. This transport is shared by the whole tab,
       * and `PinClient` object identity — which hangs off it — is what
       * `settings/pin/_lib/useDeviceSettings.ts` uses as its per-device privacy
       * boundary. Silently re-binding to whichever Pin happens to be attached
       * would read and WRITE one wearer's device settings against another's
       * device. If the authorized serial is gone, say so.
       */
      let device: AdbDaemonWebUsbDevice | undefined;
      if (previousInfo?.serial) {
        device = devices.find((entry) => entry.serial === previousInfo.serial);
        if (!device) {
          throw new Error(
            `The previously authorized Pin (${previousInfo.serial}) is no longer attached.`,
          );
        }
      } else {
        device = devices[0];
      }

      const info = await this.connectToDevice(device);

      if (
        activeStream &&
        this.currentStreamHandler &&
        this.currentStreamCommand
      ) {
        const subscriptionId = ++this.streamSubscriptionId;
        await this.launchCommandStream(
          subscriptionId,
          this.currentStreamCommand,
          this.currentStreamHandler,
        );
      }

      return info;
    } catch (error) {
      this.emitState("error", error);
      throw error;
    } finally {
      this.reconnecting = false;
    }
  }

  async disconnect(): Promise<void> {
    await this.stopCurrentPty();
    await this.stopCurrentStream();

    const adb = this.adb;
    try {
      // A close that FAILS still means this transport is unusable — the usual
      // cause is writing to a device that has already been unplugged. Letting
      // the rejection escape used to leave `adb`/`info` set, after which
      // `connect()` short-circuited on them and reported the stale serial as
      // "Connected" without ever touching a device.
      if (adb) {
        await adb.close().catch((error: unknown) => {
          logWarn("install-adb", "ADB close failed; dropping the session anyway", {
            errorName: error instanceof Error ? error.name : "UnknownError",
            device: this.info,
          });
        });
      }
    } finally {
      this.adb = null;
      this.info = null;
      if (!this.reconnecting) {
        this.emitState("idle");
      }
    }
  }

  async shell(command: string | readonly string[]): Promise<ShellResult> {
    const adb = this.requireAdb();
    const shell = adb.subprocess.shellProtocol;

    if (!shell) {
      throw new Error("Shell protocol is not supported by this device.");
    }

    try {
      const result = await shell.spawnWaitText(command);
      this.markOperationSuccess();
      return result;
    } catch (error) {
      await this.recoverFromRetryableDisconnect(
        `shell ${Array.isArray(command) ? command.join(" ") : command}`,
        error,
      );
      throw error;
    }
  }

  async shellWithInput(
    command: string | readonly string[],
    input: Blob,
    options: ShellWithInputOptions = {},
  ): Promise<ShellResult> {
    const adb = this.requireAdb();
    const shell = adb.subprocess.shellProtocol;

    if (!shell) {
      throw new Error("Shell protocol is not supported by this device.");
    }

    const start = Date.now();
    let bytesWritten = 0;

    try {
      const process = await shell.spawn(command);
      const writer = process.stdin.getWriter();

      try {
        for await (const chunk of fixedSizeChunks(
          input,
          SHELL_WITH_INPUT_WRITE_CHUNK_BYTES,
        )) {
          await writer.write(chunk);
          bytesWritten += chunk.byteLength;
          options.onProgress?.({
            bytesWritten,
            totalBytes: input.size,
            elapsedMs: Date.now() - start,
          });
        }
        await writer.close();
      } finally {
        writer.releaseLock();
      }

      const stdout = await this.readText(process.stdout);
      const stderr = await this.readText(process.stderr);
      const exitCode = await process.exited;
      this.markOperationSuccess();
      return { stdout, stderr, exitCode };
    } catch (error) {
      await this.recoverFromRetryableDisconnect(
        `shellWithInput ${Array.isArray(command) ? command.join(" ") : command}`,
        error,
      );
      throw error;
    }
  }

  async pushFile(remotePath: string, file: Blob): Promise<void> {
    while (true) {
      const adb = this.requireAdb();
      const sync = await adb.sync();
      let shouldRetry = false;

      try {
        await sync.write({
          filename: remotePath,
          // Importing `ReadableStream` from `@yume-chan/stream-extra` installs
          // `Symbol.asyncIterator` on `ReadableStream.prototype` when the
          // runtime lacks it, so a Blob stream is always async-iterable by the
          // time `from()` sees it. TypeScript only models that under the
          // `DOM.AsyncIterable` lib, which Center does not enable, so the
          // assertion below states what the import already guarantees. It is
          // type-only: the runtime path is unchanged from the Setup SPA.
          file: ReadableStream.from(
            file.stream() as unknown as AsyncIterable<Uint8Array>,
          ),
        });
        this.markOperationSuccess();
        return;
      } catch (error) {
        if (errorMessageIncludesSocketClosed(error)) {
          await this.recoverFromRetryableDisconnect(
            `pushFile ${remotePath}`,
            error,
            false,
          );
          shouldRetry = true;
        } else {
          throw error;
        }
      } finally {
        await sync.dispose().catch(() => undefined);
      }

      if (!shouldRetry) {
        return;
      }
    }
  }

  async reboot(): Promise<void> {
    const adb = this.requireAdb();

    try {
      await adb.power.reboot();
    } catch (error) {
      if (errorMessageIncludesSocketClosed(error)) {
        this.markOperationSuccess();
        return;
      }
      throw error;
    }

    this.markOperationSuccess();
  }

  async openPty(): Promise<AdbPtySession> {
    const adb = this.requireAdb();
    const shell = adb.subprocess.shellProtocol;

    if (!shell) {
      throw new Error("Shell protocol is not supported by this device.");
    }

    await this.stopCurrentPty();

    const process = await shell.pty({ terminalType: "xterm-256color" });
    const writer = process.input.getWriter();

    const session: AdbPtySession = {
      output: process.output,
      exited: process.exited,
      write: async (data) => {
        await writer.write(data);
      },
      sigint: async () => {
        await process.sigint();
      },
      close: async () => {
        try {
          await Promise.resolve(process.kill()).catch(() => undefined);
        } finally {
          writer.releaseLock();
          await process.output.cancel().catch(() => undefined);
          if (this.currentPtySession === session) {
            this.currentPtySession = null;
          }
        }
      },
    };

    this.currentPtySession = session;
    this.markOperationSuccess();
    return session;
  }

  /**
   * The ONLY socket capability any session exposes.
   *
   * `createSocket` below stays private: it takes a free-form ADB service string
   * straight to the daemon, so a delegate that forwarded it would still reach
   * `shell:` — the same service `openPty()` is built on — however carefully it
   * refused `openPty` itself.
   */
  async openBridgeSocket(target: PinBridgeSocketTarget): Promise<AdbSocket> {
    return this.createSocket(pinBridgeSocketService(target));
  }

  private async createSocket(service: string): Promise<AdbSocket> {
    const adb = this.requireAdb();
    try {
      const socket = await adb.createSocket(service);
      this.markOperationSuccess();
      return socket;
    } catch (error) {
      await this.recoverFromRetryableDisconnect(`createSocket ${service}`, error);
      throw error;
    }
  }

  async startCommandStream(
    command: string | readonly string[],
    onLine: (line: CommandStreamLine) => void,
  ): Promise<CommandStreamController> {
    this.currentStreamHandler = onLine;
    this.currentStreamCommand = command;
    const subscriptionId = ++this.streamSubscriptionId;

    await this.stopCurrentStream();
    await this.launchCommandStream(subscriptionId, command, onLine);

    return {
      stop: async () => {
        if (subscriptionId !== this.streamSubscriptionId) {
          return;
        }

        this.currentStreamHandler = null;
        this.currentStreamCommand = null;
        this.streamSubscriptionId += 1;
        await this.stopCurrentStream();
      },
    };
  }

  private async connectToDevice(
    device: AdbDaemonWebUsbDevice,
  ): Promise<AdbConnectionInfo> {
    let connection: Awaited<
      ReturnType<AdbDaemonWebUsbDevice["connect"]>
    > | null = null;

    try {
      connection = await device.connect();
      const authBundle = await this.authStrategy.createAuthenticationBundle({
        serial: device.serial,
        name: device.name,
      });
      const transport = await AdbDaemonTransport.authenticate({
        serial: device.serial,
        connection,
        credentialStore: authBundle.credentialStore,
        authenticators: [...authBundle.authenticators],
        initialDelayedAckBytes: 0,
      });

      this.adb = new Adb(transport);
      this.info = {
        serial: device.serial,
        name: device.name,
      };
      logInfo("install-adb", "ADB transport authenticated", {
        device: this.info,
      });
      // Published from here, the one place `adb`/`info` become non-null, so an
      // internal reconnect is observed exactly like a user-initiated connect.
      this.emitState("connected");
      return this.info;
    } catch (error) {
      if (connection) {
        await Promise.allSettled([
          connection.writable.close(),
          connection.readable.cancel(),
        ]);
      }

      logError("install-adb", "Failed to connect to USB device", error, {
        serial: device.serial,
        name: device.name,
      });
      // The `error` phase is published by `connect()`/`reconnect()`, the only
      // two callers, so a failure is announced exactly once however it arose.
      throw error;
    }
  }

  private async launchCommandStream(
    subscriptionId: number,
    command: string | readonly string[],
    onLine: (line: CommandStreamLine) => void,
  ) {
    const adb = this.requireAdb();
    const shell = adb.subprocess.shellProtocol;

    if (!shell) {
      throw new Error("Shell protocol is not supported by this device.");
    }

    const process = await shell.spawn(command);
    let stopped = false;

    this.currentStreamStop = async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      try {
        await Promise.resolve(process.kill()).catch(() => undefined);
      } finally {
        await Promise.allSettled([
          process.stdout.cancel().catch(() => undefined),
          process.stderr.cancel().catch(() => undefined),
        ]);
      }
    };

    void process.stdout
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new ConcatStringStream())
      .then((output) => {
        if (stopped || subscriptionId !== this.streamSubscriptionId) {
          return;
        }

        output.split(/\r?\n/).forEach((text) => {
          if (!text.trim()) {
            return;
          }

          onLine({
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            text,
          });
        });
      })
      .catch((error) => {
        logDebug("install-adb", "Command stream ended with error", {
          command,
          error,
        });
      });
  }

  private async stopCurrentPty() {
    const session = this.currentPtySession;
    this.currentPtySession = null;
    if (session) {
      await session.close().catch(() => undefined);
    }
  }

  private async stopCurrentStream() {
    const stop = this.currentStreamStop;
    this.currentStreamStop = null;
    if (stop) {
      await stop();
    }
  }

  private async readText(stream: ReadableStream<Uint8Array>) {
    return stream
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new ConcatStringStream());
  }

  private requireAdb(): Adb {
    if (!this.adb) {
      throw new Error("ADB is not connected.");
    }

    return this.adb;
  }
}
