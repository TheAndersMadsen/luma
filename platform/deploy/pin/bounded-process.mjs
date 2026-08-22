/**
 * Observe every child lifecycle edge at spawn time and provide one bounded,
 * idempotent termination path. Callers remain responsible for selecting fixed
 * executables and positive environments. Set `ownsProcessGroup` only when the
 * child was spawned with `detached: true` on POSIX.
 */

export const DEFAULT_TERMINATION_GRACE_MILLISECONDS = 5_000;
export const DEFAULT_TERMINATION_DRAIN_MILLISECONDS = 1_000;
export const OWN_CHILD_PROCESS_GROUP = process.platform !== "win32";

const PROCESS_TIMEOUT = Symbol("revival.process-timeout");
const TRACKED_STATE = new WeakMap();

function monotonicNow() {
  return process.hrtime.bigint();
}

function millisecondsToNanoseconds(milliseconds) {
  return BigInt(milliseconds) * 1_000_000n;
}

function requireDuration(milliseconds, label) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return milliseconds;
}

function frozenOutcome(code, signal, error) {
  return Object.freeze({ code, signal, error: error ?? null });
}

export function trackChildProcess(child, { ownsProcessGroup = false } = {}) {
  if (!child || typeof child.once !== "function" || typeof child.kill !== "function") {
    throw new TypeError("tracked process must be a ChildProcess");
  }
  if (typeof ownsProcessGroup !== "boolean") {
    throw new TypeError("ownsProcessGroup must be boolean");
  }

  let spawnOutcome = null;
  let exitOutcome = null;
  let closeOutcome = null;
  let processError = null;
  let resolveSpawn;
  let resolveExit;
  let resolveClose;
  const spawn = new Promise((resolvePromise) => { resolveSpawn = resolvePromise; });
  const exit = new Promise((resolvePromise) => { resolveExit = resolvePromise; });
  const close = new Promise((resolvePromise) => { resolveClose = resolvePromise; });

  const settleSpawn = (outcome) => {
    if (spawnOutcome !== null) return;
    spawnOutcome = Object.freeze(outcome);
    resolveSpawn(spawnOutcome);
  };
  const settleExit = (outcome) => {
    if (exitOutcome !== null) return;
    exitOutcome = outcome;
    resolveExit(exitOutcome);
  };

  child.once("spawn", () => settleSpawn({ pid: child.pid, error: null }));
  child.once("error", (error) => {
    processError = error;
    settleSpawn({ pid: null, error });
    // Node does not promise an `exit` event when spawning itself failed.
    if (spawnOutcome?.pid === null) settleExit(frozenOutcome(null, null, error));
  });
  child.once("exit", (code, signal) => {
    settleExit(frozenOutcome(code, signal, processError));
  });
  child.once("close", (code, signal) => {
    if (exitOutcome === null) settleExit(frozenOutcome(code, signal, processError));
    closeOutcome = frozenOutcome(code, signal, processError);
    resolveClose(closeOutcome);
  });

  const tracked = Object.freeze({
    child,
    spawn,
    exit,
    close,
    ownsProcessGroup,
    spawnOutcome: () => spawnOutcome,
    outcome: () => exitOutcome,
    closeOutcome: () => closeOutcome,
  });
  TRACKED_STATE.set(tracked, { termination: null });
  return tracked;
}

function deadlineAt(end) {
  let timer = null;
  const remaining = end - monotonicNow();
  const promise = remaining <= 0n
    ? Promise.resolve(PROCESS_TIMEOUT)
    : new Promise((resolvePromise) => {
      const milliseconds = Math.max(1, Math.ceil(Number(remaining) / 1_000_000));
      timer = setTimeout(() => resolvePromise(PROCESS_TIMEOUT), milliseconds);
      timer.unref?.();
    });
  return Object.freeze({
    promise,
    cancel() {
      if (timer !== null) clearTimeout(timer);
    },
  });
}

async function raceUntil(operation, end) {
  const limit = deadlineAt(end);
  try {
    return await Promise.race([operation, limit.promise]);
  } finally {
    limit.cancel();
  }
}

function signalTrackedProcess(tracked, signal) {
  const pid = tracked.child.pid;
  if (
    tracked.ownsProcessGroup && process.platform !== "win32" &&
    Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid
  ) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if (error?.code !== "ESRCH") {
        // Fall through to the direct child. A later bounded exit check still
        // fails closed if the process tree could not be terminated.
      }
    }
  }
  try {
    return tracked.child.kill(signal);
  } catch {
    return false;
  }
}

function destroyChildStdio(child) {
  for (const stream of [child.stdin, child.stdout, child.stderr, child.stdio?.[3], child.stdio?.[4]]) {
    try {
      stream?.destroy?.();
    } catch {
      // Termination is already at its hard bound. Do not let a broken stream
      // extend it or hide the direct-child outcome.
    }
  }
  try {
    child.disconnect?.();
  } catch {
    // No IPC channel, or it was already closed.
  }
}

async function terminateOnce(tracked, { graceMilliseconds, drainMilliseconds }) {
  if (tracked.closeOutcome() !== null) return tracked.outcome() ?? tracked.closeOutcome();

  const started = monotonicNow();
  const graceEnd = started + millisecondsToNanoseconds(graceMilliseconds);
  const hardEnd = graceEnd + millisecondsToNanoseconds(drainMilliseconds);
  try {
    tracked.child.stdin?.destroy?.();
  } catch {
    // Signalling remains authoritative even if stdin was already broken.
  }

  signalTrackedProcess(tracked, "SIGTERM");
  const graceful = await raceUntil(tracked.close, graceEnd);
  if (graceful !== PROCESS_TIMEOUT) return tracked.outcome() ?? graceful;

  signalTrackedProcess(tracked, "SIGKILL");
  const drained = await raceUntil(tracked.close, hardEnd);
  if (drained !== PROCESS_TIMEOUT) return tracked.outcome() ?? drained;

  // A descendant may keep an inherited pipe open after the direct child has
  // already been reaped. At the hard monotonic deadline, detach those streams
  // so their `close` event cannot hold this process or cleanup path forever.
  destroyChildStdio(tracked.child);
  const outcome = tracked.outcome();
  if (outcome !== null) return outcome;

  // SIGKILL was sent before the bounded drain. Missing the direct `exit` edge
  // at this point is a lifecycle failure, but it must not turn into a hang.
  tracked.child.unref?.();
  throw new Error("tracked direct child did not exit before the termination deadline");
}

export async function terminateTrackedProcess(
  tracked,
  {
    graceMilliseconds = DEFAULT_TERMINATION_GRACE_MILLISECONDS,
    drainMilliseconds = DEFAULT_TERMINATION_DRAIN_MILLISECONDS,
  } = {},
) {
  const state = TRACKED_STATE.get(tracked);
  if (!state) throw new TypeError("process was not created by trackChildProcess");
  requireDuration(graceMilliseconds, "tracked process TERM grace");
  requireDuration(drainMilliseconds, "tracked process post-SIGKILL drain");
  if (state.termination === null) {
    state.termination = terminateOnce(tracked, { graceMilliseconds, drainMilliseconds });
  }
  return await state.termination;
}

export async function withTrackedDeadline(
  tracked,
  operation,
  { milliseconds, timeoutError, graceMilliseconds, drainMilliseconds } = {},
) {
  requireDuration(milliseconds, "tracked process deadline");
  const end = monotonicNow() + millisecondsToNanoseconds(milliseconds);
  const result = await raceUntil(operation, end);
  if (result !== PROCESS_TIMEOUT) return result;

  let terminationFailure = null;
  try {
    await terminateTrackedProcess(tracked, { graceMilliseconds, drainMilliseconds });
  } catch (error) {
    terminationFailure = error;
  }
  const selected = typeof timeoutError === "function" ? timeoutError() : timeoutError;
  const error = selected instanceof Error ? selected : new Error("tracked process deadline expired");
  if (terminationFailure !== null && error.cause === undefined) {
    Object.defineProperty(error, "cause", { value: terminationFailure, enumerable: false });
  }
  throw error;
}
