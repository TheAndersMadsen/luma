// shared/adb.mjs, bounded child-process + ADB helpers + the device adapter
// for the media-volume guard. Owned here so every in-process command shares
// one capture primitive instead of each re-implementing it.

import { spawn as spawnProcess } from "node:child_process";
import { validateSerial } from "../../agentic-release-smoke-lib.mjs";
import {
  AUDIO_DUMP_ADB_ARGS,
  MEDIA_VOLUME_GET_ADB_ARGS,
  buildMediaVolumeSetAdbArgs,
  parseMediaVolumeSnapshot,
} from "../../media-volume-state-guard.mjs";

export const MAX_CHILD_STDOUT_BYTES = 8 * 1024 * 1024;

// Commands in this package throw ProbeError. The dispatcher converts it to an
// exit code + stderr line. Keeping a distinct error class lets a caller tell a
// real defect (ProbeError) from a programming bug (TypeError etc.).
export class ProbeError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProbeError";
  }
}

export function requireSerial(options) {
  try {
    return validateSerial(options?.serial);
  } catch {
    throw new ProbeError("a valid explicit ADB serial is required");
  }
}

// Bounded spawn: caps stdout, discards stderr (ADB diagnostics can leak
// endpoint detail and add nothing), zeroes stdin buffers. Mirrors the
// captureChild primitive in agentic-release-smoke.mjs so behaviour matches.
export function spawnCapture(
  command,
  args,
  { input = null, timeoutMs = 20_000, maxStdoutBytes = MAX_CHILD_STDOUT_BYTES, spawn = spawnProcess } = {},
) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      rejectPromise(new ProbeError("could not start a required local process"));
      return;
    }
    const stdout = [];
    let stdoutBytes = 0;
    let settled = false;
    const inputBuffer = input === null ? null : Buffer.isBuffer(input) ? input : Buffer.from(input);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (inputBuffer !== null) inputBuffer.fill(0);
      callback();
    };
    const fail = (message) => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      finish(() => rejectPromise(new ProbeError(message)));
    };
    const timer = setTimeout(() => fail("a bounded local operation timed out"), timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        fail("a bounded operation response was too large");
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.resume();
    child.on("error", () => fail("a required local process was unavailable"));
    child.on("close", (code, signal) => {
      finish(() =>
        resolvePromise({
          code: code ?? (signal === null ? 1 : 128),
          stdout: Buffer.concat(stdout),
        }),
      );
    });
    child.stdin.on("error", () => {});
    if (inputBuffer === null) child.stdin.end();
    else child.stdin.end(inputBuffer);
  });
}

export async function runAdb(options, args, opts, publicFailure, spawn = spawnProcess) {
  const serial = requireSerial(options);
  const completed = await spawnCapture(options.adbPath, ["-s", serial, ...args], { ...opts, spawn });
  if (completed.code !== 0) throw new ProbeError(publicFailure);
  return completed.stdout;
}

// Adapter that satisfies media-volume-state-guard's `device` contract
// (readMediaVolumeState / setMediaVolumeIndex) over ADB. Lets the guard module
// stay pure and reusable. This is the only place that knows about adb flags.
export function makeMediaVolumeDevice(options, spawn = spawnProcess) {
  return {
    async readMediaVolumeState() {
      const volumeOutput = await runAdb(options, [...MEDIA_VOLUME_GET_ADB_ARGS], {
        timeoutMs: 10_000, maxStdoutBytes: 4 * 1024,
      }, "the media volume observation failed", spawn);
      const audioDump = await runAdb(options, [...AUDIO_DUMP_ADB_ARGS], {
        timeoutMs: 15_000, maxStdoutBytes: MAX_CHILD_STDOUT_BYTES,
      }, "the media mute observation failed", spawn);
      return parseMediaVolumeSnapshot(volumeOutput, audioDump);
    },
    async setMediaVolumeIndex(index) {
      const out = await runAdb(options, buildMediaVolumeSetAdbArgs(index), {
        timeoutMs: 10_000, maxStdoutBytes: 4 * 1024,
      }, "the media volume restoration failed", spawn);
      out.fill(0);
    },
  };
}
