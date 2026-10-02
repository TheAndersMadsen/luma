/*
 * Center's server-side log.
 *
 * Every diagnostic this BFF emits has exactly one reader: `docker logs
 * luma-center-1`. A line that does not reach that stream is not a
 * weaker diagnostic, it is no diagnostic at all, and this deployment has
 * already shipped outages whose only trace was a log line nobody could find.
 *
 * `console` is the wrong primitive for the job, for three reasons:
 *
 *   1. It is a MUTABLE GLOBAL. The framework, an instrumentation hook or any
 *      dependency can replace `console.warn` with something that buffers or
 *      drops, and neither the call site nor any test would change or fail. An
 *      audit of this deployment concluded the whole BFF was logging into a void
 *      on exactly that theory. The theory turned out to be wrong (the container
 *      was running a build that predated the log lines being looked for), but
 *      "we cannot tell whether our logging works" is itself the defect.
 *   2. `console.warn(message, error)` formats through `util.inspect`, which is
 *      MULTI-LINE. The json-file driver stores one record per line, so a stack
 *      trace arrives as forty unrelated records and a grep for the message
 *      returns the first line only.
 *   3. Nothing could assert that any of it worked.
 *
 * So the default sink writes the finished line straight at the file descriptor
 * with `fs.writeSync`. That is the descriptor the container runtime reads, it
 * cannot be intercepted from JavaScript, and it is synchronous, the line is on
 * the wire before the request that produced it returns, which matters because
 * the failures worth logging are often the ones about to take the process down.
 *
 * `verify/server-logging.test.mjs` proves it rather than assuming it: it runs
 * this module in a child process with every `console` method replaced by a
 * no-op and asserts the bytes still arrive on the child's stdout and stderr. It
 * also fails if any module under `src/server` or `src/app/api` goes back to
 * `console.*`, so a diagnostic added to a route handler cannot be dead on
 * arrival the way the pin-release reasons were.
 *
 * NOT for secrets. Wearer key material, bearer tokens, cookie contents and ADB
 * signing material never come here, `verify/adb-sign-proxy.test.mjs` holds the
 * two modules that handle signing material to having no logging at all, which
 * is also why `detail` is rendered with `String()` rather than serialized: an
 * object dumped into a log line is how a token gets into one.
 */

import fs from "node:fs";

export type LogLevel = "info" | "warn" | "error";

/** Where a finished line goes. Replaced only by the verify tests. */
export type LogSink = (level: LogLevel, line: string) => void;

const STDOUT_FD = 1;
const STDERR_FD = 2;

/**
 * Informational lines join Next's own startup banner on stdout. Anything
 * reporting a failure goes to stderr, so a reader that separates the two
 * streams still sees the failures.
 */
function descriptorFor(level: LogLevel): number {
  return level === "info" ? STDOUT_FD : STDERR_FD;
}

/**
 * How many times to re-offer a line to a descriptor that is momentarily full.
 *
 * Docker reads the container's stdout through a pipe. A pipe whose buffer is
 * full answers EAGAIN instead of blocking, and the remedy is simply to write
 * again once the runtime drains it. Bounded, because an unbounded spin here
 * would turn a slow log reader into a hung request.
 */
const EAGAIN_ATTEMPTS = 64;

/** The default sink: the container's own file descriptors, and nothing else. */
function writeToDescriptor(level: LogLevel, line: string): void {
  const descriptor = descriptorFor(level);
  const payload = Buffer.from(line, "utf8");
  let written = 0;
  let attempts = 0;

  while (written < payload.length) {
    try {
      written += fs.writeSync(descriptor, payload, written, payload.length - written);
      attempts = 0;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // The reader is gone, the container is shutting down, or nothing is
      // attached. There is no second place to say so.
      if (code === "EPIPE") return;
      if (code === "EAGAIN" && (attempts += 1) <= EAGAIN_ATTEMPTS) continue;
      // Last resort: the buffered stream API, which can queue what the
      // descriptor would not take. It gives up the synchronous ordering above,
      // which is a fair trade against losing the line entirely.
      try {
        (descriptor === STDOUT_FD ? process.stdout : process.stderr).write(payload);
      } catch {
        // Nowhere left to report this. Swallowing here cannot hide anything
        // that was not already unreportable.
      }
      return;
    }
  }
}

let sink: LogSink = writeToDescriptor;

/**
 * Read what a module logged, from a test.
 *
 * The seam exists so a verify test can assert the CONTENT of a diagnostic
 * (`pin release artifact server.apk: 404 artifact_route_unknown` really names
 * its reason) without parsing a child process's stdout. Passing `null` restores
 * the descriptor sink.
 *
 * It is deliberately the only way to displace the sink, and
 * `verify/server-logging.test.mjs` asserts that no module under `src/` other
 * than this one so much as names it, a runtime path that could silence the log
 * would recreate the exact condition this module was written to rule out.
 */
export function setLogSinkForTests(next: LogSink | null): void {
  sink = next ?? writeToDescriptor;
}

/**
 * One event, one line.
 *
 * A newline inside a message would split one event into two records, and the
 * second would have no timestamp, no level and no context, which is how a
 * flattened stack trace becomes forty log lines that grep cannot reassemble.
 * Other control characters are removed for the same reason: a stray CR or an
 * ANSI escape from an upstream error message rewrites the reader's terminal.
 */
function flatten(text: string): string {
  return text
    .replace(/\r?\n/g, " \\n ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
}

/**
 * What to say about the second argument.
 *
 * An `Error` is rendered errno-first, because the errno is what an operator
 * greps for when a file will not open, and it is the one part `error.message`
 * routinely omits. Anything else is `String()`d rather than serialized: this
 * function must never turn "somebody passed the request options" into a bearer
 * token in the container log.
 */
function describe(detail: unknown): string {
  if (detail instanceof Error) {
    const code = (detail as NodeJS.ErrnoException).code;
    // `stack` already opens with `Name: message`, so it replaces rather than
    // supplements it. When a runtime withholds it, say the same thing by hand.
    const body = detail.stack ?? `${detail.name}: ${detail.message}`;
    return code ? `[${code}] ${body}` : body;
  }
  return String(detail);
}

function formatLine(level: LogLevel, message: string, detail?: unknown): string {
  const parts = [new Date().toISOString(), level, flatten(message)];
  if (detail !== undefined) parts.push(flatten(describe(detail)));
  return `${parts.join(" ")}\n`;
}

function emit(level: LogLevel, message: string, detail?: unknown): void {
  try {
    sink(level, formatLine(level, message, detail));
  } catch {
    // A logger that can fail the request it was describing is worse than a lost
    // line. The default sink handles its own write errors above, so reaching
    // here means a test sink threw.
  }
}

/** Something an operator wants to see on a good day: a release verified, say. */
export function logInfo(message: string, detail?: unknown): void {
  emit("info", message, detail);
}

/** Something went wrong and the request carried on regardless. Name what. */
export function logWarn(message: string, detail?: unknown): void {
  emit("warn", message, detail);
}

/** Something went wrong and the wearer did not get what they asked for. */
export function logError(message: string, detail?: unknown): void {
  emit("error", message, detail);
}
