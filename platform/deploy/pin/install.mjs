#!/usr/bin/env -S bun --no-env-file

/*
 * Headless Pin install: the browser installer's pipeline, driven from a shell.
 *
 * `center/src/lib/pin-install/ops/install.ts` already implements the whole
 * ordered mutation, download assets, pre-install cleanup, managed-package
 * cleanup, installer bootstrap, package install, disable configured packages,
 * set the home activity, verify, together with the migration decision that
 * decides which of those steps a given device is even allowed to take. None of
 * that is reimplemented here. The only thing that pipeline could not get from a
 * command line was a device: it talks to the Pin through `AdbSessionTransport`,
 * and the sole implementation was `WebUsbAdbSessionTransport`, which needs a
 * human to pick a device out of a WebUSB chooser.
 *
 * So this file supplies two things and nothing else:
 *
 *   1. `AdbCliSessionTransport`, the same interface over the local `adb`
 *      binary, so the tested ops run unchanged against a cabled Pin.
 *   2. A release source. The browser resolves its target from Center over
 *      HTTPS. Here the LOCAL release store `pin release build` publishes is the
 *      trust root, so the store is validated with this directory's own
 *      contract parsers (./release.mjs) and then served to the unmodified
 *      release code through an in-process fetch.
 *
 * Without `--confirm` this plans only: it resolves and verifies the release,
 * reads the device read-only, prints the plan the real pipeline would execute,
 * and exits. With `--confirm` it modifies the Pin.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { register } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  PinReleaseContractError,
  parseCanonicalPinReleaseManifestDocument,
  parsePinReleaseJson,
} from "./release.mjs";
import { canonicalPinReleaseRoot } from "./release-store-path.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const SOURCE_ROOT = resolve(dirname(SELF_PATH), "../../..");
const CENTER_SRC_URL = pathToFileURL(join(SOURCE_ROOT, "center", "src", "/")).href;

/*
 * The installer's own module graph, resolved the way its bundler resolves it.
 *
 * Center is a Next codebase: it writes extensionless relative imports and the
 * `@/` alias, and Node's ESM resolver does neither. `center/verify/` solves the
 * same problem for its own tests with an out-of-thread `register()` hook. This
 * CLI uses the same streaming file API on Bun.
 * The empty candidate is tried FIRST, so every specifier Node already resolves,
 * builtins, ./release.mjs, the stubs below, resolves exactly as it would
 * without the hook, and a genuinely missing module still fails as missing.
 */
/*
 * Stand-ins for the three packages only `WebUsbAdbSessionTransport` and its
 * authenticator need, used ONLY when they are not installed.
 *
 * They are browser-transport dependencies: `Adb`/`AdbDaemonTransport` speak the
 * ADB wire protocol over WebUSB, which is precisely the job the local `adb`
 * binary does here instead. `pin-install/device.ts` reaches the ops through
 * `@/lib/pin-device/adb`, whose barrel re-exports the WebUSB transport
 * alongside the package/installer helpers, so importing the ops pulls these in
 * even though this tool never constructs a WebUSB session, and an operator
 * host that only ever runs the release tooling has no `center/node_modules` to
 * pull them from. Where the real packages ARE installed they win, so a
 * developer host runs the identical module graph the browser does.
 *
 * Each replacement throws on construction rather than pretending to work: if
 * some future path really does reach for a WebUSB session from the command
 * line, it fails loudly here instead of silently doing nothing. The two
 * constant tables are read only inside the remote-signer authenticator's packet
 * loop, which is unreachable without a WebUSB session.
 */
const WEB_USB_TRANSPORT_PACKAGES = new Map([
  [
    "@yume-chan/adb",
    `const refuse = (symbol) => {
       throw new Error(symbol + " is the WebUSB ADB transport; the headless installer drives the adb CLI instead.");
     };
     export class Adb { constructor() { refuse("Adb"); } }
     export class AdbDaemonTransport {
       constructor() { refuse("AdbDaemonTransport"); }
       static authenticate() { refuse("AdbDaemonTransport.authenticate"); }
     }
     export const AdbAuthType = Object.freeze({});
     export const AdbCommand = Object.freeze({});`,
  ],
  [
    "@yume-chan/adb-daemon-webusb",
    `const refuse = (symbol) => {
       throw new Error(symbol + " needs a WebUSB device chooser, which a headless install has no way to answer.");
     };
     export class AdbDaemonWebUsbDevice { constructor() { refuse("AdbDaemonWebUsbDevice"); } }
     export class AdbDaemonWebUsbDeviceManager {
       // Undefined is what this resolves to under Node in the browser build too,
       // which is why the device layer is import-safe off the browser at all.
       static BROWSER = undefined;
       constructor() { refuse("AdbDaemonWebUsbDeviceManager"); }
     }`,
  ],
  [
    "@yume-chan/stream-extra",
    `const refuse = (symbol) => {
       throw new Error(symbol + " belongs to the WebUSB stream plumbing, which the adb CLI transport replaces.");
     };
     export class ConcatStringStream { constructor() { refuse("ConcatStringStream"); } }
     export class TextDecoderStream { constructor() { refuse("TextDecoderStream"); } }
     export const ReadableStream = globalThis.ReadableStream;`,
  ],
]);

const INSTALL_LOADER_SOURCE = String.raw`
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const CANDIDATES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const EXPECTED_REPLACEMENTS = [
  "@yume-chan/adb",
  "@yume-chan/adb-daemon-webusb",
  "@yume-chan/stream-extra",
];
let centerSourceUrl;
let replacements;

export function initialize(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      Object.keys(data).sort().join(",") !== "centerSourceUrl,replacementEntries") {
    throw new Error("invalid headless Pin installer loader data");
  }
  const root = new URL(data.centerSourceUrl);
  if (root.protocol !== "file:" || root.search || root.hash || !root.pathname.endsWith("/")) {
    throw new Error("invalid headless Pin installer source root");
  }
  if (!Array.isArray(data.replacementEntries) ||
      data.replacementEntries.some((entry) => !Array.isArray(entry) || entry.length !== 2 ||
        typeof entry[0] !== "string" || typeof entry[1] !== "string")) {
    throw new Error("invalid headless Pin installer replacement set");
  }
  replacements = new Map(data.replacementEntries);
  if (replacements.size !== EXPECTED_REPLACEMENTS.length ||
      [...replacements.keys()].sort().join(",") !== [...EXPECTED_REPLACEMENTS].sort().join(",")) {
    throw new Error("incomplete headless Pin installer replacement set");
  }
  centerSourceUrl = root.href;
}

export async function resolve(specifier, context, nextResolve) {
  const target = specifier.startsWith("@/")
    ? new URL(specifier.slice(2), centerSourceUrl).href
    : specifier;
  let firstFailure;
  for (const candidate of CANDIDATES) {
    try {
      return await nextResolve(target + candidate, context);
    } catch (error) {
      firstFailure ??= error;
    }
  }
  const replacement = replacements.get(specifier);
  if (replacement !== undefined) {
    return {
      url: "data:text/javascript," + encodeURIComponent(replacement),
      shortCircuit: true,
    };
  }
  throw firstFailure;
}

export async function load(url, context, nextLoad) {
  const parsed = new URL(url);
  if (parsed.protocol === "file:" && !parsed.search && !parsed.hash &&
      parsed.href.startsWith(centerSourceUrl) && /\.tsx?$/.test(parsed.pathname)) {
    if (parsed.pathname.endsWith(".tsx")) {
      throw new Error("the headless Pin installer cannot execute TSX modules");
    }
    const source = await readFile(parsed, "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: stripTypeScriptTypes(source, {
        mode: "transform",
        sourceUrl: parsed.href,
      }),
    };
  }
  return nextLoad(url, context);
}
`;

register(
  `data:text/javascript;base64,${Buffer.from(INSTALL_LOADER_SOURCE).toString("base64")}`,
  {
    parentURL: import.meta.url,
    data: {
      centerSourceUrl: CENTER_SRC_URL,
      replacementEntries: [...WEB_USB_TRANSPORT_PACKAGES],
    },
  },
);

const {
  INSTALL_OPERATION_PHASES,
  InstallPlanningError,
  createInstallPlan,
  inspectInstallState,
  isPinReleaseError,
  resolveInstallTarget,
  runInstallOperation,
} = await import(
  pathToFileURL(join(SOURCE_ROOT, "center", "src", "lib", "pin-install", "index.ts")).href
);

/* ── the local release store ─────────────────────────────────────────────── */

/**
 * Where `./luma pin release build` published, resolved with that tool's own
 * precedence (platform/deploy/pin/build.mjs) so both agree without a shared
 * config file.
 */
export function resolveReleaseStore(environment = process.env) {
  return canonicalPinReleaseRoot(environment);
}

async function sha256File(path) {
  const digest = createHash("sha256");
  await pipeline(createReadStream(path), digest);
  return digest.digest("hex");
}

class InstallError extends Error {
  constructor(message) {
    super(message);
    this.name = "InstallError";
  }
}

async function readStoreFile(path, label) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new InstallError(`cannot read ${label} at ${path}: ${error.message}`);
  }
}

/**
 * Read and validate the store BEFORE anything touches the Pin.
 *
 * Every check here uses release.mjs, the same contract used by `pin release
 * build`: canonical manifest bytes, a releaseId derived from the artifact
 * metadata rather than asserted by it, fixed package identity per role, and a
 * immutable manifest whose bytes must match the atomic current pointer.
 */
export async function readRelease(storeRoot, requestedReleaseId) {
  const currentSource = await readStoreFile(join(storeRoot, "current.json"), "current release pointer");
  const current = parseCanonicalPinReleaseManifestDocument(currentSource);
  const releaseId = requestedReleaseId ?? current.releaseId;
  const releaseDir = join(storeRoot, "releases", releaseId);
  const manifestSource = await readStoreFile(join(releaseDir, "manifest.json"), "release manifest");
  const manifest = parseCanonicalPinReleaseManifestDocument(manifestSource);

  if (manifest.releaseId !== releaseId) {
    throw new InstallError(
      `release ${releaseId} contains a manifest for ${manifest.releaseId}`,
    );
  }
  if (releaseId === current.releaseId && manifestSource !== currentSource) {
    throw new InstallError(
      "current.json and the release's own manifest.json disagree; refusing to guess which one is the release",
    );
  }

  return Object.freeze({
    releaseId,
    releaseDir,
    manifest,
    manifestSource,
    isCurrent: releaseId === current.releaseId,
    currentReleaseId: current.releaseId,
  });
}

function artifactPath(release, artifact) {
  // release.mjs pins every manifest URL to exactly `./<releaseId>/<role>.apk`,
  // so the file this hashes is the file the manifest URL names, no path is
  // assembled out of anything the manifest could have chosen freely.
  const fileName = basename(artifact.url);
  if (artifact.name !== fileName) {
    throw new InstallError(
      `${artifact.role} artifact is named ${artifact.name} but published at ${artifact.url}`,
    );
  }
  return join(release.releaseDir, fileName);
}

/**
 * Hash every APK against the manifest before any device I/O, so a corrupt or
 * substituted artifact costs the Pin nothing. The pipeline verifies each asset
 * again as it loads it, that check is the installer's own and stays where it
 * is, but by then the device has already been inspected and, on the recovery
 * path, cleaned up.
 */
export async function verifyReleaseArtifacts(release) {
  const verified = [];
  for (const artifact of release.manifest.artifacts) {
    const path = artifactPath(release, artifact);
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      throw new InstallError(`cannot read ${artifact.role} artifact at ${path}: ${error.message}`);
    }
    if (!info.isFile()) {
      throw new InstallError(`${artifact.role} artifact at ${path} is not a regular file`);
    }
    if (info.size !== artifact.size) {
      throw new InstallError(
        `${artifact.role} artifact is ${info.size} bytes; the manifest declares ${artifact.size}`,
      );
    }
    const digest = await sha256File(path);
    if (digest !== artifact.sha256) {
      throw new InstallError(
        `${artifact.role} artifact sha256 ${digest} does not match the manifest's ${artifact.sha256}`,
      );
    }
    verified.push({ artifact, path, digest });
  }
  return verified;
}

/*
 * A synthetic same-origin release service.
 *
 * `resolveInstallTarget()` and `downloadInstallTargetAssets()` are written
 * against an origin-checked HTTPS service, and those checks are load-bearing,
 * they are what stops a release manifest pointing an APK at somebody else's
 * host. Rather than relaxing them for the CLI, this hands the unmodified code a
 * fetch whose entire routing table is built from the already-validated
 * manifest: one URL for the manifest, one per artifact, nothing else resolvable.
 * A traversal has nowhere to land because no path is ever assembled from input.
 */
export const STORE_ORIGIN = "https://pin-release-store.invalid";
export const STORE_MANIFEST_URL = `${STORE_ORIGIN}/pin-releases/current`;

function storeResponse(url, { size, json, openBody }) {
  // One body per response, opened on first read: the caller picks either `body`
  // or `blob()`, and handing out a second file stream would leak a descriptor
  // for the one it did not use.
  let body;
  const stream = () => {
    body ??= openBody?.() ?? null;
    return body;
  };

  return {
    ok: true,
    status: 200,
    statusText: "OK",
    url,
    headers: {
      get(name) {
        return name.toLowerCase() === "content-length" && size !== undefined ? String(size) : null;
      },
    },
    get body() {
      return stream();
    },
    async json() {
      if (json === undefined) {
        throw new InstallError(`${url} is not a JSON resource`);
      }
      return json;
    },
    async blob() {
      const source = stream();
      if (!source) {
        return new Blob([JSON.stringify(json)]);
      }
      const chunks = [];
      for await (const chunk of source) {
        chunks.push(chunk);
      }
      return new Blob(chunks, { type: "application/vnd.android.package-archive" });
    },
  };
}

export function createReleaseStoreFetch(release, verifiedArtifacts) {
  const files = new Map(
    verifiedArtifacts.map(({ artifact, path }) => [
      new URL(artifact.url, STORE_MANIFEST_URL).href,
      { path, size: artifact.size },
    ]),
  );
  const manifestUrl = new URL(STORE_MANIFEST_URL).href;
  const manifestJson = parsePinReleaseJson(release.manifestSource, "release manifest");

  return async (input) => {
    const url = new URL(input, STORE_MANIFEST_URL).href;
    if (url === manifestUrl) {
      return storeResponse(url, {
        size: Buffer.byteLength(release.manifestSource),
        json: manifestJson,
      });
    }
    const file = files.get(url);
    if (!file) {
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        url,
        headers: { get: () => null },
        body: null,
        async json() {
          throw new InstallError(`${url} is not published by this release`);
        },
        async blob() {
          throw new InstallError(`${url} is not published by this release`);
        },
      };
    }
    return storeResponse(url, {
      size: file.size,
      openBody: () => Readable.toWeb(createReadStream(file.path)),
    });
  };
}

/* ── the adb CLI as an AdbSessionTransport ───────────────────────────────── */

const SERIAL_RE = /^[A-Za-z0-9._:-]{1,64}$/u;
const RELEASE_ID_RE = /^[0-9a-f]{64}$/u;

/*
 * adb failing to REACH the device, as opposed to a device command exiting
 * non-zero. The distinction matters: `waitForDeviceReady()` polls
 * `shell(["echo", "ready"])` and treats a thrown error as "not back yet", so an
 * unreachable device that merely returned a non-zero exit code would be read as
 * a booted one and the soft-reboot waits during bootstrap would all fall
 * through immediately. Device commands never emit these lines. Adb's own
 * transport diagnostics always do.
 */
const ADB_TRANSPORT_FAILURE_RE =
  /^(?:adb: |error: (?:device |no devices|closed|protocol fault|unknown host service|cannot connect))/mu;

const MAX_CAPTURED_OUTPUT_BYTES = 32 * 1024 * 1024;
/* Longer than the ops' own 60s step timeout on purpose: the pipeline's timeout
 * is the one that should fire and be reported, not a private one here. This is
 * only a backstop against an adb child that hangs forever. */
const CHILD_TIMEOUT_MS = 15 * 60 * 1000;

function formatCommand(command) {
  // Byte-identical to `formatCommand` in center/src/lib/pin-device/adb/transport.ts.
  // ADB has no execve-argv form: the array is joined with single spaces and the
  // resulting STRING is what the device's shell parses, which is the whole
  // reason every caller routes non-literals through shellQuote.ts first.
  return Array.isArray(command) ? command.join(" ") : command;
}

class AdbCliSessionTransport {
  #adbPath;
  #serial;
  #info = null;
  #streams = new Set();

  constructor({ adbPath, serial }) {
    if (!SERIAL_RE.test(serial)) {
      throw new InstallError(`${serial} is not a usable ADB serial`);
    }
    this.#adbPath = adbPath;
    this.#serial = serial;
  }

  get connectionInfo() {
    return this.#info;
  }

  get serial() {
    return this.#serial;
  }

  async connect() {
    if (this.#info) {
      return this.#info;
    }
    const state = await this.#capture(["get-state"], { timeoutMs: 30_000 });
    if (state.code !== 0 || state.stdout.trim() !== "device") {
      throw new InstallError(
        `${this.#serial} is not in the "device" state: ${state.stdout.trim() || state.stderr.trim() || "unavailable"}`,
      );
    }
    // The transport contract's `name` is a human label for the attached device;
    // WebUSB takes it from the USB descriptor, which is where this one comes
    // from too by way of the property the descriptor is built from.
    const model = await this.#capture(["shell", "-T", "getprop ro.product.model"], {
      timeoutMs: 30_000,
    });
    this.#info = Object.freeze({
      serial: this.#serial,
      name: model.stdout.trim() || this.#serial,
    });
    return this.#info;
  }

  async reconnect() {
    this.#info = null;
    const waited = await this.#capture(["wait-for-device"], { timeoutMs: CHILD_TIMEOUT_MS });
    if (waited.code !== 0) {
      throw new InstallError(`waiting for ${this.#serial} to come back failed: ${waited.stderr.trim()}`);
    }
    return this.connect();
  }

  async disconnect() {
    for (const controller of [...this.#streams]) {
      await controller.stop();
    }
    // Deliberately no `adb kill-server`: the server is shared with whatever else
    // the operator has attached, and this tool did not start it.
    this.#info = null;
  }

  async shell(command) {
    return this.#deviceShell(command, {});
  }

  async shellWithInput(command, input, options = {}) {
    return this.#deviceShell(command, { input, onInputProgress: options.onProgress });
  }

  async pushFile(remotePath, file) {
    // `adb push` uses the sync protocol, not a shell, so `remotePath` travels as
    // an argv element and needs none of shellQuote.ts's discipline here.
    const directory = await mkdtemp(join(tmpdir(), "pin-install-"));
    const staged = join(directory, "payload.apk");
    try {
      await pipeline(
        Readable.fromWeb(file.stream()),
        createWriteStream(staged, { mode: 0o600 }),
      );
      const pushed = await this.#capture(["push", staged, remotePath]);
      this.#assertReachedDevice(pushed, `push to ${remotePath}`);
      if (pushed.code !== 0) {
        throw new InstallError(
          `adb push to ${remotePath} failed: ${pushed.stderr.trim() || pushed.stdout.trim()}`,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async reboot() {
    const result = await this.#capture(["reboot"]);
    this.#assertReachedDevice(result, "reboot");
    if (result.code !== 0) {
      throw new InstallError(`adb reboot failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
  }

  async startCommandStream(command, onLine) {
    const child = this.#spawn(["shell", "-T", this.#deviceCommandLine(command)]);
    child.stdin.end();
    let pending = "";
    const emit = (text) => {
      if (!text.trim()) {
        return;
      }
      onLine({ id: randomUUID(), timestamp: new Date().toISOString(), text });
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        emit(line);
      }
    });
    child.stderr.resume();

    const controller = {
      stop: async () => {
        this.#streams.delete(controller);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
        await new Promise((settle) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            settle();
            return;
          }
          child.once("close", settle);
        });
        emit(pending);
        pending = "";
      },
    };
    this.#streams.add(controller);
    child.once("close", () => this.#streams.delete(controller));
    return controller;
  }

  #deviceCommandLine(command) {
    const commandLine = formatCommand(command);
    if (commandLine.startsWith("-")) {
      // `adb shell` would read it as one of its own flags rather than as the
      // device command. Nothing in the installer produces such a command, and a
      // future caller that did would otherwise get silent misbehaviour.
      throw new InstallError(
        `refusing to run a device command that adb would read as a flag: ${commandLine}`,
      );
    }
    return commandLine;
  }

  async #deviceShell(command, { input, onInputProgress }) {
    const result = await this.#capture(["shell", "-T", this.#deviceCommandLine(command)], {
      input,
      onInputProgress,
    });
    this.#assertReachedDevice(result, `shell ${formatCommand(command)}`);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
  }

  #assertReachedDevice(result, description) {
    if (result.signal) {
      throw new InstallError(`adb was killed by ${result.signal} during ${description}`);
    }
    if (result.code !== 0 && ADB_TRANSPORT_FAILURE_RE.test(result.stderr)) {
      const [detail] = result.stderr.trim().split(/\r?\n/);
      throw new InstallError(`adb could not reach ${this.#serial} during ${description}: ${detail}`);
    }
  }

  #spawn(args) {
    return spawn(this.#adbPath, ["-s", this.#serial, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  #capture(args, { input, onInputProgress, timeoutMs = CHILD_TIMEOUT_MS } = {}) {
    return new Promise((settle, reject) => {
      let child;
      try {
        child = this.#spawn(args);
      } catch (error) {
        reject(new InstallError(`could not run ${this.#adbPath}: ${error.message}`));
        return;
      }

      const stdout = [];
      const stderr = [];
      let captured = 0;
      let finished = false;
      const finish = (settleWith) => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        settleWith();
      };
      const abort = (message) => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        finish(() => reject(new InstallError(message)));
      };
      const timer = setTimeout(
        () => abort(`adb ${args[0]} did not finish within ${Math.round(timeoutMs / 1000)}s`),
        timeoutMs,
      );

      const collect = (sink) => (chunk) => {
        captured += chunk.length;
        if (captured > MAX_CAPTURED_OUTPUT_BYTES) {
          abort(`adb ${args[0]} produced more than ${MAX_CAPTURED_OUTPUT_BYTES} bytes of output`);
          return;
        }
        sink.push(chunk);
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.on("error", (error) => abort(`could not run ${this.#adbPath}: ${error.message}`));
      child.on("close", (code, signal) => {
        finish(() =>
          settle({
            code: code ?? (signal === null ? 1 : 128),
            signal,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          }),
        );
      });

      child.stdin.on("error", () => {
        // A device command that exits before reading all of stdin closes the
        // pipe under us. The exit code it produced is the real result.
      });
      if (!input) {
        child.stdin.end();
        return;
      }

      const start = Date.now();
      let written = 0;
      pipeline(
        (async function* () {
          for await (const chunk of Readable.fromWeb(input.stream())) {
            written += chunk.length;
            onInputProgress?.({
              bytesWritten: written,
              totalBytes: input.size,
              elapsedMs: Date.now() - start,
            });
            yield chunk;
          }
        })(),
        child.stdin,
      ).catch(() => {
        // Same closed-pipe case as above.
      });
    });
  }
}

async function listAttachedSerials(adbPath) {
  const listed = await new Promise((settle, reject) => {
    const child = spawn(adbPath, ["devices"], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.resume();
    child.on("error", (error) => reject(new InstallError(`could not run ${adbPath}: ${error.message}`)));
    child.on("close", () => settle(Buffer.concat(stdout).toString("utf8")));
  });

  return listed
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 2 && fields[1] === "device")
    .map((fields) => fields[0]);
}

/* ── device preconditions ────────────────────────────────────────────────── */

const MIN_BATTERY_PERCENT = 30;
const MIN_DATA_FREE_BYTES = 1024 * 1024 * 1024;

function parseBatteryState(output) {
  const level = /^\s*level:\s*(\d+)\s*$/mu.exec(output);
  const scale = /^\s*scale:\s*(\d+)\s*$/mu.exec(output);
  if (!level) {
    return null;
  }
  const divisor = scale ? Number(scale[1]) : 100;
  const status = /^\s*status:\s*(\d+)\s*$/mu.exec(output);
  return {
    percent: divisor > 0 ? Math.round((Number(level[1]) / divisor) * 100) : Number(level[1]),
    // Android's BatteryManager reports 2 for CHARGING and 5 for FULL. The
    // powered flags cover a Pin sitting on its booster with a flat status line.
    charging:
      /^\s*(?:AC|USB|Wireless) powered:\s*true\s*$/mu.test(output) ||
      status?.[1] === "2" ||
      status?.[1] === "5",
  };
}

function parseDataFreeBytes(output) {
  const rows = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const row of rows.reverse()) {
    const fields = row.split(/\s+/);
    // Filesystem, 1K-blocks, Used, Available, Use%, Mounted on, the header row
    // is skipped by requiring the Available column to be a number.
    if (fields.length >= 6 && /^\d+$/u.test(fields[3])) {
      return Number(fields[3]) * 1024;
    }
  }
  return null;
}

async function readDeviceCapacity(transport) {
  const [battery, storage] = await Promise.all([
    transport.shell(["dumpsys", "battery"]),
    transport.shell(["df", "-k", "/data"]),
  ]);
  return {
    battery: parseBatteryState(battery.stdout),
    dataFreeBytes: parseDataFreeBytes(storage.stdout),
  };
}

function capacityBlockers({ battery, dataFreeBytes }) {
  const blockers = [];
  if (!battery) {
    blockers.push("the Pin's battery level could not be read");
  } else if (battery.percent < MIN_BATTERY_PERCENT && !battery.charging) {
    blockers.push(
      `battery is ${battery.percent}% and not charging; ${MIN_BATTERY_PERCENT}% or a charger is required`,
    );
  }
  if (dataFreeBytes === null) {
    blockers.push("free space on /data could not be read");
  } else if (dataFreeBytes < MIN_DATA_FREE_BYTES) {
    blockers.push(
      `/data has ${formatBytes(dataFreeBytes)} free; at least ${formatBytes(MIN_DATA_FREE_BYTES)} is required`,
    );
  }
  return blockers;
}

/* ── reporting ───────────────────────────────────────────────────────────── */

function line(text = "") {
  process.stdout.write(`${text}\n`);
}

function section(title) {
  line();
  line(title);
  line("-".repeat(title.length));
}

function formatBytes(bytes) {
  const mib = bytes / (1024 * 1024);
  return mib >= 1024 ? `${(mib / 1024).toFixed(2)} GiB` : `${mib.toFixed(1)} MiB`;
}

function pad(value, width) {
  return String(value).padEnd(width);
}

const PACKAGE_ROLES = ["installer", "hook", "server", "loader"];

/**
 * `expectedVersion` is a function of the role, not one version for all four:
 * on the in-place paths the installer is deliberately RETAINED at the version
 * it already had, `verifyInstalledManagedState()` fails the install if it
 * moves, so holding it to the target version would report a textbook install
 * as a mismatch.
 */
function reportPackages(inspection, expectedVersion) {
  const rows = PACKAGE_ROLES.map((role) => {
    const pkg = inspection.packages[role];
    const expected = expectedVersion(role);
    return {
      role,
      packageName: pkg.packageName,
      expected,
      installed: pkg.installed ? pkg.versionName ?? "(unreadable)" : "(absent)",
      healthy: pkg.installed ? (pkg.healthy ? "yes" : "no") : "-",
      matches: pkg.installed && pkg.versionName === expected,
    };
  });
  const nameWidth = Math.max(...rows.map((row) => row.packageName.length)) + 2;
  const installedWidth = Math.max(...rows.map((row) => row.installed.length)) + 2;
  const expectedWidth = Math.max(...rows.map((row) => row.expected.length)) + 2;

  for (const row of rows) {
    line(
      `  ${pad(row.role, 10)}${pad(row.packageName, nameWidth)}` +
        `installed=${pad(row.installed, installedWidth)}` +
        `expected=${pad(row.expected, expectedWidth)}` +
        `healthy=${pad(row.healthy, 7)}${row.matches ? "match" : "DIFFERS"}`,
    );
  }
  return rows;
}

/**
 * What each package should report once the plan has run: the target for the
 * runtime packages, and for the installer either the target (it is being
 * re-bootstrapped) or exactly the identity the plan promised to retain.
 */
function expectedVersionForPlan(plan, target) {
  return (role) =>
    role === "installer" && plan?.verificationPolicy.mode === "in-place"
      ? plan.retainedInstaller?.versionName ?? target.version
      : target.version;
}

function createProgressReporter() {
  let last = null;
  return (event) => {
    if (event.logEntry === false) {
      return;
    }
    const key = `${event.phase}:${event.message}`;
    if (key === last) {
      return;
    }
    last = key;
    const percent = String(event.overallPercent).padStart(3);
    line(`  [${pad(event.phase, 9)}${percent}%] ${event.message}`);
  };
}

/* ── the command ─────────────────────────────────────────────────────────── */

const USAGE = `usage: ./luma pin install [--confirm] [--serial SERIAL] [options]

Installs the current local Pin release onto a cabled Ai Pin, using the same
install pipeline the Center browser installer runs.

WITHOUT --confirm this only PLANS. It verifies the release, reads the device
read-only, prints the plan, and changes nothing on the Pin.
WITH --confirm it MODIFIES THE DEVICE: it installs and replaces packages, and
on the recovery path it also removes packages, disables configured system
packages, and sets the default launcher.

Options
  --confirm                       perform the install; without it, plan only
  --confirm-bootstrap-recovery    additionally allow the installer-bootstrap
                                  recovery path, which is refused by default
                                  because it uninstalls the managed packages
                                  before reinstalling them
  --serial SERIAL                 target device; required when more than one
                                  device is attached
  --release RELEASE_ID            install a specific published release instead
                                  of the store's current one
  --store DIR                     release store root (default: the directory
                                  \`luma pin release build\` publishes to)
  --adb PATH                      adb binary to drive (default: adb)
  --help                          show this message`;

function parseCommandLine(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        confirm: { type: "boolean", default: false },
        "confirm-bootstrap-recovery": { type: "boolean", default: false },
        serial: { type: "string" },
        release: { type: "string" },
        store: { type: "string" },
        adb: { type: "string" },
        help: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n${USAGE}\n`);
    process.exit(64);
  }

  const values = parsed.values;
  if (values.release !== undefined && !RELEASE_ID_RE.test(values.release)) {
    process.stderr.write("error: --release must be a 64-character lowercase hexadecimal release id\n");
    process.exit(64);
  }
  if (values.serial !== undefined && !SERIAL_RE.test(values.serial)) {
    process.stderr.write("error: --serial is not a usable ADB serial\n");
    process.exit(64);
  }
  return values;
}

async function selectSerial(adbPath, requested) {
  if (requested) {
    return requested;
  }
  const attached = await listAttachedSerials(adbPath);
  if (attached.length === 1) {
    return attached[0];
  }
  if (attached.length === 0) {
    throw new InstallError("no Ai Pin is attached in the \"device\" state");
  }
  throw new InstallError(
    `${attached.length} devices are attached (${attached.join(", ")}); name one with --serial`,
  );
}

export function describePlan(plan, target) {
  const kinds = {
    "routine-in-place": "in-place update from the canonical profile",
    "bootstrap-recovery": "installer bootstrap recovery (destructive)",
  };
  line(`  migration        ${plan.kind} — ${kinds[plan.kind]}`);
  line(`  packages         ${plan.packageRoles.length > 0 ? plan.packageRoles.join(", ") : "(none; runtime packages are current)"}`);
  line(`  keeping data of  ${plan.expectedExistingPackageNames.join(", ") || "(nothing; every package is new)"}`);
  line(`  assets to load   ${plan.requiredAssetRoles.join(", ") || "(none)"}`);
  line(
    `  installer        ${
      plan.retainedInstaller
        ? `retained at ${plan.retainedInstaller.versionName} (signer ${plan.retainedInstaller.signerIdentity})`
        : `re-bootstrapped to ${target.version}`
    }`,
  );
  line(`  verification     ${plan.verificationPolicy.mode}`);
  line();
  line("  Phases the pipeline will run, in order:");
  const steps = {
    Assets: `load and re-verify ${plan.requiredAssetRoles.length} APK${plan.requiredAssetRoles.length === 1 ? "" : "s"} from the local store`,
    Cleanup: plan.shouldRunPreinstallCleanup || plan.shouldCleanupManagedPackages
      ? "run pre-install cleanup and remove the managed packages"
      : "skipped; the installer and app data are retained",
    Installer: plan.shouldBootstrapInstaller
      ? "bootstrap the final installer package"
      : "skipped; the healthy installer is retained",
    Install: plan.packageRoles.length > 0
      ? `stage and install ${plan.packageRoles.join(", ")} through the installer provider`
      : "skipped; nothing to install",
    Disable: plan.shouldDisableConfiguredPackages
      ? "disable the configured stock/system packages"
      : "skipped for a targeted update",
    Configure: plan.shouldSetHomeActivity ? "set the default launcher" : "skipped for a targeted update",
    Verify: plan.verificationPolicy.mode === "in-place"
      ? "re-inspect runtime packages at target and require the retained installer to stay unchanged"
      : "re-inspect and require every managed package to match the target",
  };
  for (const [index, phase] of INSTALL_OPERATION_PHASES.entries()) {
    line(`    ${index + 1}. ${pad(phase, 10)}${steps[phase]}`);
  }
}

async function main(argv) {
  const values = parseCommandLine(argv);
  if (values.help) {
    line(USAGE);
    return 0;
  }

  const adbPath = values.adb ?? "adb";
  const storeRoot = values.store ? resolve(values.store) : resolveReleaseStore();

  section("Release");
  const release = await readRelease(storeRoot, values.release);
  line(`  store            ${storeRoot}`);
  line(`  release          ${release.manifest.version} (versionCode ${release.manifest.artifacts[0].versionCode})`);
  line(`  releaseId        ${release.releaseId}${release.isCurrent ? " (current)" : ""}`);
  if (!release.isCurrent) {
    line(`  note             the store's current release is ${release.currentReleaseId}`);
  }

  const verifiedArtifacts = await verifyReleaseArtifacts(release);
  for (const { artifact, digest } of verifiedArtifacts) {
    line(`  verified         ${pad(artifact.role, 14)}${pad(formatBytes(artifact.size), 12)}sha256 ${digest.slice(0, 16)}…`);
  }

  const storeFetch = createReleaseStoreFetch(release, verifiedArtifacts);
  const target = await resolveInstallTarget({
    fetchImpl: storeFetch,
    manifestUrl: STORE_MANIFEST_URL,
    baseUrl: `${STORE_ORIGIN}/`,
  });

  section("Device");
  const transport = new AdbCliSessionTransport({ adbPath, serial: await selectSerial(adbPath, values.serial) });
  const connection = await transport.connect();
  line(`  serial           ${connection.serial}`);
  line(`  adb              ${adbPath}`);

  const capacity = await readDeviceCapacity(transport);
  line(
    `  battery          ${capacity.battery ? `${capacity.battery.percent}%${capacity.battery.charging ? " (charging)" : ""}` : "unreadable"}`,
  );
  line(`  /data free       ${capacity.dataFreeBytes === null ? "unreadable" : formatBytes(capacity.dataFreeBytes)}`);

  const inspection = await inspectInstallState(transport, { target, readinessSettleDelayMs: 0 });
  line(`  identity         ${inspection.device.manufacturer} ${inspection.device.model} (${inspection.device.product})`);
  line(`  recognized       ${inspection.device.recognizedAiPin ? "yes" : "NO — not a recognized Humane Ai Pin"}`);
  line(`  credential state ${inspection.readiness.credentialState.state}`);
  line(`  action           ${inspection.actionState.action} — ${inspection.actionState.reasons.join(" ")}`);
  if (inspection.hasDetectedConflicts) {
    for (const conflict of inspection.detectedConflicts) {
      line(`  conflict         ${conflict.label}: ${conflict.installedPackageIds.join(", ")}`);
    }
  }

  section(`Installed packages vs target ${target.version}`);
  reportPackages(inspection, () => target.version);

  const blockers = capacityBlockers(capacity);
  if (blockers.length > 0 && values.confirm) {
    for (const blocker of blockers) {
      process.stderr.write(`error: ${blocker}\n`);
    }
    process.stderr.write("error: refusing to install; the device is not in a safe state\n");
    return 1;
  }

  section("Plan");
  let plan = null;
  let bootstrapRecoveryHeld = false;
  let refusal = null;
  try {
    plan = createInstallPlan({
      transport,
      target,
      inspection,
      bootstrapRecoveryConfirmed: values["confirm-bootstrap-recovery"],
    });
  } catch (error) {
    if (!(error instanceof InstallPlanningError)) {
      throw error;
    }
    if (error.code === "bootstrap-recovery-confirmation-required") {
      // Show what recovery WOULD do rather than printing an error and stopping:
      // knowing that the device needs the destructive path, and what that path
      // touches, is exactly what the operator ran the dry run to find out.
      bootstrapRecoveryHeld = true;
      plan = createInstallPlan({ transport, target, inspection, bootstrapRecoveryConfirmed: true });
    } else {
      // A "blocked" decision is an answer, not a crash: the migration rules
      // examined this exact device and refused it. Reporting it inside the plan
      // keeps the dry run's promise that it always says what it found.
      refusal = error.message;
    }
  }

  if (plan) {
    describePlan(plan, target);
  } else {
    line(`  No install is permitted for this device: ${refusal}`);
    line("  The installed packages above are what the migration rules were shown.");
  }

  if (bootstrapRecoveryHeld) {
    line();
    line("  This device needs the installer bootstrap recovery path, which removes the");
    line("  managed packages before reinstalling them. Add --confirm-bootstrap-recovery");
    line("  to allow it.");
  }
  if (blockers.length > 0) {
    line();
    for (const blocker of blockers) {
      line(`  BLOCKED: ${blocker}`);
    }
  }

  if (!values.confirm) {
    section("Dry run");
    line("  Nothing was changed on the Pin. Re-run with --confirm to install.");
    await transport.disconnect();
    return blockers.length > 0 || refusal ? 1 : 0;
  }

  if (refusal) {
    process.stderr.write(`error: this device may not be installed to: ${refusal}\n`);
    await transport.disconnect();
    return 1;
  }
  if (bootstrapRecoveryHeld) {
    process.stderr.write(
      "error: this device needs installer bootstrap recovery; re-run with --confirm-bootstrap-recovery\n",
    );
    await transport.disconnect();
    return 1;
  }

  section("Installing");
  line(`  Modifying ${connection.serial}. Do not unplug the Pin.`);
  const result = await runInstallOperation({
    transport,
    target,
    inspection,
    bootstrapRecoveryConfirmed: values["confirm-bootstrap-recovery"],
    fetchImpl: storeFetch,
    onProgress: createProgressReporter(),
  });

  for (const warning of result.warnings) {
    line(`  warning: ${warning.code}${warning.packageName ? ` (${warning.packageName})` : ""}: ${warning.message}`);
  }

  if (!result.success) {
    section("Failed");
    process.stderr.write(`error: install failed during ${result.failedPhase ?? "planning"}: ${result.error?.message}\n`);
    if (result.deviceChangesStarted) {
      process.stderr.write("error: device changes started; inspect the Pin before retrying or uninstalling\n");
    }
    await transport.disconnect();
    return 1;
  }

  section("Verification");
  const rows = reportPackages(result.inspection, expectedVersionForPlan(plan, target));
  const mismatched = rows.filter((row) => !row.matches);
  line();
  line(
    mismatched.length === 0
      ? `  Every managed package reports the version this plan expected of it (runtime packages at ${target.version}).`
      : `  ${mismatched.length} package(s) do not report their expected version: ${mismatched
          .map((row) => `${row.role} is ${row.installed}, expected ${row.expected}`)
          .join("; ")}`,
  );
  await transport.disconnect();
  return mismatched.length === 0 ? 0 : 1;
}

// Guarded the same way ./release.mjs guards its CLI, so importing this module
// never reaches for a device.
if (process.argv[1] && resolve(process.argv[1]) === resolve(SELF_PATH)) {
  process.exitCode = await main(process.argv.slice(2)).catch((error) => {
    if (error instanceof InstallError || error instanceof PinReleaseContractError) {
      process.stderr.write(`error: ${error.message}\n`);
      return 1;
    }
    if (isPinReleaseError(error)) {
      process.stderr.write(`error: ${error.code}: ${error.message}\n`);
      return 1;
    }
    if (error instanceof InstallPlanningError) {
      process.stderr.write(`error: this device may not be installed to: ${error.message}\n`);
      return 1;
    }
    process.stderr.write(`error: ${error?.stack ?? error}\n`);
    return 1;
  });
}
