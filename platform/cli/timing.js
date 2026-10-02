'use strict';

const { fail, info, run } = require('./context');

class TimedSubprocessFailure extends Error {
  constructor(result) {
    super(result.signal
      ? `subprocess terminated by ${result.signal}`
      : `subprocess exited with status ${result.status ?? 1}`);
    this.name = 'TimedSubprocessFailure';
    this.result = result;
  }
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error(`invalid stage duration: ${milliseconds}`);
  }
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1000).toFixed(2)}s`;
}

function timedStage(label, action, { now = () => process.hrtime.bigint(), report = info } = {}) {
  const started = now();
  try {
    return action();
  } finally {
    const elapsedNanoseconds = now() - started;
    const elapsedMilliseconds = Number(elapsedNanoseconds) / 1_000_000;
    report(`[timing] ${label}: ${formatDuration(elapsedMilliseconds)}`);
  }
}

function exitLikeChild(result) {
  if (result.signal) {
    // This is called only at the outer boundary, after synchronous `finally`
    // blocks and registered cleanup actions have had a chance to run.
    process.kill(process.pid, result.signal);
    return;
  }
  process.exit(result.status ?? 1);
}

function throwLikeChild(result) {
  throw new TimedSubprocessFailure(result);
}

// The outer boundary of both CLIs: a failed timed subprocess exits like the
// child, and any other failure is one `error:` line instead of a stack trace.
function runTimedBoundary(action) {
  try {
    return action();
  } catch (error) {
    if (!(error instanceof TimedSubprocessFailure)) {
      fail(error instanceof Error ? error.message : String(error));
    }
    exitLikeChild(error.result);
    return undefined;
  }
}

function timedRun(label, command, args, options = {}) {
  const callerAllowsFailure = options.allowFailure === true;
  const result = timedStage(label, () => run(command, args, {
    ...options,
    allowFailure: true,
  }));
  if ((result.signal || result.status !== 0) && !callerAllowsFailure) throwLikeChild(result);
  return result;
}

module.exports = {
  TimedSubprocessFailure,
  exitLikeChild,
  formatDuration,
  runTimedBoundary,
  throwLikeChild,
  timedRun,
  timedStage,
};
