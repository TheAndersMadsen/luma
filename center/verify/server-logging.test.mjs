import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { maskSource, sourceFiles } from "./sourceScan.mjs";

/*
 * Does this deployment's logging actually work?
 *
 * That question has been asked twice about Center and answered from evidence
 * both times — once with a request whose 404 body proved the handler ran while
 * `docker logs … | wc -c` did not move. The conclusion drawn from it (that
 * something in the framework was eating `console`) turned out to be wrong: the
 * running image predated the log lines being looked for, so there was nothing to
 * discard. But the reason the wrong conclusion was reachable at all is that
 * NOTHING in this repo asserted the property. A diagnostic can be dead on
 * arrival — never written, or written somewhere nobody reads — and every test,
 * health check and green deploy will agree that it is fine.
 *
 * So this file asserts the property directly:
 *
 *   1. the log module really puts bytes on the process's own stdout/stderr, with
 *      `console` comprehensively destroyed first, proven in a child process;
 *   2. one event is one line, even when the detail is a stack trace;
 *   3. nothing under src/server or src/app/api goes back to `console.*`, so a
 *      new diagnostic cannot be added on the fragile path; and
 *   4. the test-only sink seam is not reachable from runtime code.
 *
 * If server logging silently stops working again, this fails.
 */

const LOG_MODULE = new URL("../src/server/log.ts", import.meta.url);
const SRC = new URL("../src/", import.meta.url);

/** Directories whose diagnostics have exactly one reader: the container log. */
const SERVER_TREES = ["server/", "app/api/"];

const TIMESTAMPED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

function lines(text) {
  return text.split("\n").filter((line) => line.length > 0);
}

test("a log line reaches the process's own stdout and stderr with console destroyed", () => {
  /*
   * `console` is replaced BEFORE the module is imported and replaced wholesale,
   * not method by method, so a logger that reached for it at import time or
   * through any property name would emit nothing and fail here. That is the
   * point: this asserts the log does not depend on a mutable global that the
   * framework, an instrumentation hook or a dependency can take away.
   */
  const probe = `
    globalThis.console = new Proxy({}, { get: () => () => {} });
    const log = await import(${JSON.stringify(LOG_MODULE.href)});
    log.logInfo("probe-info");
    log.logWarn("probe-warn");
    log.logError("probe-error", new Error("probe-detail"));
  `;
  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", probe],
    { encoding: "utf8" },
  );

  assert.equal(
    child.status,
    0,
    `the log module could not run standalone: ${child.stderr || child.error?.message}`,
  );

  const out = lines(child.stdout);
  const err = lines(child.stderr);

  // The bytes arrived at all. Everything else in this file is refinement.
  assert.deepEqual(
    out.length,
    1,
    `expected exactly one informational line on stdout, got ${JSON.stringify(child.stdout)}`,
  );
  assert.match(out[0], TIMESTAMPED);
  assert.match(out[0], /\binfo probe-info$/);

  // One event, one line — including the one carrying a multi-line stack. A
  // stack that arrives as forty json-file records is a stack `grep` cannot
  // reassemble, which is most of why `console.warn(msg, error)` was unusable.
  assert.equal(
    err.length,
    2,
    `expected exactly two lines on stderr, got ${JSON.stringify(child.stderr)}`,
  );
  assert.match(err[0], /\bwarn probe-warn$/);
  assert.match(err[1], /\berror probe-error /);
  assert.match(err[1], /probe-detail/);

  // Failures land on stderr and only on stderr, so a reader that splits the two
  // streams still sees them.
  assert.doesNotMatch(child.stdout, /probe-warn|probe-error/);
});

test("the sink seam sees the same line the descriptor would have", async () => {
  const { logWarn, setLogSinkForTests } = await import("../src/server/log.ts");
  const captured = [];
  setLogSinkForTests((level, line) => captured.push([level, line]));
  try {
    logWarn("first line\nsecond line", new Error("detail"));
  } finally {
    setLogSinkForTests(null);
  }

  assert.equal(captured.length, 1);
  const [level, line] = captured[0];
  assert.equal(level, "warn");
  // Newline-terminated, and newline-free everywhere else: a message that could
  // split itself in two would produce a second record with no timestamp, no
  // level and no context.
  assert.ok(line.endsWith("\n"), `log line is not newline-terminated: ${JSON.stringify(line)}`);
  assert.equal(line.slice(0, -1).includes("\n"), false, JSON.stringify(line));
  assert.match(line, TIMESTAMPED);
  assert.match(line, /warn first line \\n second line /);
  assert.match(line, /detail/);
});

test("no module under src/server or src/app/api logs through console", async () => {
  const offenders = [];
  const scanned = [];

  for (const tree of SERVER_TREES) {
    for (const file of await sourceFiles(new URL(tree, SRC), readdir)) {
      const relative = decodeURIComponent(file.pathname).split("/src/").pop();
      scanned.push(relative);
      // Masked, so the word in a comment ("the Pin console") is not a finding
      // and a real call inside a template literal still is.
      const code = maskSource(await readFile(file, "utf8"));
      if (/\bconsole\s*\./.test(code)) offenders.push(relative);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `${offenders.join(", ")} log through console; use logInfo/logWarn/logError from src/server/log.ts, whose delivery this file proves`,
  );

  // Anti-vacuity: a scan that found nothing would pass the assertion above
  // without checking anything, which is the failure mode this whole file is
  // about.
  for (const owner of [
    "server/channel.ts",
    "server/cosmos.ts",
    "server/pin-releases.ts",
    "server/source.ts",
    "app/api/devices/status/route.ts",
    "app/api/assistant/stream/route.ts",
  ]) {
    assert.ok(scanned.includes(owner), `the console sweep never inspected ${owner}`);
  }
  assert.ok(scanned.length >= 40, `the console sweep only inspected ${scanned.length} files`);
});

test("the test-only sink seam is unreachable from runtime code", async () => {
  const users = [];
  for (const file of await sourceFiles(SRC, readdir)) {
    const relative = decodeURIComponent(file.pathname).split("/src/").pop();
    if (/setLogSinkForTests/.test(await readFile(file, "utf8"))) users.push(relative);
  }
  // A runtime caller could silence every diagnostic in the process, which is
  // precisely the condition this module exists to make impossible.
  assert.deepEqual(
    users,
    ["server/log.ts"],
    `setLogSinkForTests is named outside the module that defines it: ${users.join(", ")}`,
  );
});
