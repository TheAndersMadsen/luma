import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  OWN_CHILD_PROCESS_GROUP,
  terminateTrackedProcess,
  trackChildProcess,
  withTrackedDeadline,
} from "../pin/bounded-process.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");

function occurrences(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function ready(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", resolve);
  });
}

function readLine(stream) {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffered = "";
    const onData = (chunk) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      resolvePromise(buffered.slice(0, newline));
    };
    const onError = (error) => { cleanup(); rejectPromise(error); };
    const onEnd = () => { cleanup(); rejectPromise(new Error("child closed before one line")); };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("end", onEnd);
    };
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}

async function waitForPidToDisappear(pid, milliseconds = 1_000) {
  const end = process.hrtime.bigint() + BigInt(milliseconds) * 1_000_000n;
  while (process.hrtime.bigint() < end) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.fail(`descendant ${pid} survived its owned process-group deadline`);
}

test("process exit is captured at spawn even when callers await it later", async () => {
  const tracked = trackChildProcess(spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: ["ignore", "ignore", "ignore"],
  }));
  const spawned = await tracked.spawn;
  assert.equal(spawned.error, null);
  assert.ok(Number.isSafeInteger(spawned.pid));
  const first = await tracked.exit;
  const second = await tracked.exit;
  const closed = await tracked.close;
  assert.strictEqual(first, second);
  assert.deepEqual(first, { code: 0, signal: null, error: null });
  assert.deepEqual(closed, first);
  assert.strictEqual(tracked.outcome(), first);
  assert.strictEqual(tracked.closeOutcome(), closed);
  assert.strictEqual(await terminateTrackedProcess(tracked), first);
});

test("the wall-clock deadline TERM/KILLs and reaps a stubborn child", async () => {
  const child = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); process.stdout.write('READY\\n'); setInterval(() => {}, 1_000);",
  ], {
    detached: OWN_CHILD_PROCESS_GROUP,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const tracked = trackChildProcess(child, { ownsProcessGroup: OWN_CHILD_PROCESS_GROUP });
  await ready(child);
  const started = Date.now();
  await assert.rejects(
    withTrackedDeadline(tracked, new Promise(() => {}), {
      milliseconds: 40,
      graceMilliseconds: 40,
      drainMilliseconds: 100,
      timeoutError: () => new Error("fixture deadline expired"),
    }),
    /fixture deadline expired/u,
  );
  const outcome = await tracked.exit;
  assert.equal(outcome.code, null);
  assert.equal(outcome.signal, "SIGKILL");
  assert.equal(outcome.error, null);
  assert.ok(Date.now() - started < 2_000, "termination must be bounded by wall clock");
  assert.strictEqual(await terminateTrackedProcess(tracked), outcome);
});

test("a TERM-ignoring grandchild holding stdout is group-killed without an orphan or close hang", {
  skip: process.platform === "win32",
}, async () => {
  const grandchildProgram = [
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1_000);",
  ].join("");
  const parentProgram = [
    "const {spawn}=require('node:child_process');",
    "process.on('SIGTERM', () => {});",
    `const held=spawn(process.execPath,['-e',${JSON.stringify(grandchildProgram)}],{stdio:['ignore','inherit','inherit']});`,
    "process.stdout.write(`GRANDCHILD ${held.pid}\\n`);",
    "setInterval(() => {}, 1_000);",
  ].join("");
  const child = spawn(process.execPath, ["-e", parentProgram], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tracked = trackChildProcess(child, { ownsProcessGroup: true });
  const line = await readLine(child.stdout);
  const match = /^GRANDCHILD ([1-9][0-9]*)$/u.exec(line);
  assert.ok(match, `unexpected fixture readiness line: ${line}`);
  const grandchildPid = Number(match[1]);
  const started = process.hrtime.bigint();
  await assert.rejects(
    withTrackedDeadline(tracked, tracked.close, {
      milliseconds: 30,
      graceMilliseconds: 40,
      drainMilliseconds: 120,
      timeoutError: () => new Error("process-tree deadline expired"),
    }),
    /process-tree deadline expired/u,
  );
  const elapsedMilliseconds = Number(process.hrtime.bigint() - started) / 1_000_000;
  assert.ok(elapsedMilliseconds < 750, `termination took ${elapsedMilliseconds.toFixed(1)}ms`);
  const outcome = await tracked.exit;
  assert.equal(outcome.code, null);
  assert.equal(outcome.signal, "SIGKILL");
  await tracked.close;
  await waitForPidToDisappear(grandchildPid);
  assert.strictEqual(await terminateTrackedProcess(tracked), outcome);
});

test("every hosted build, gh, SSH, rsync, and READY child is tracked and bounded", async () => {
  const [build, ship, verifier, setup, vpsWorkflow, pinWorkflow] = await Promise.all([
    readFile(resolve(ROOT, "platform/deploy/pin/build.mjs"), "utf8"),
    readFile(resolve(ROOT, "platform/deploy/pin/ship.mjs"), "utf8"),
    readFile(resolve(ROOT, "platform/deploy/pin/hosted-attestation.mjs"), "utf8"),
    readFile(resolve(ROOT, "platform/cli/setup.js"), "utf8"),
    readFile(resolve(ROOT, ".github/workflows/vps-candidate.yml"), "utf8"),
    readFile(resolve(ROOT, ".github/workflows/pin-release.yml"), "utf8"),
  ]);
  for (const [label, source] of [["build", build], ["ship", ship], ["verifier", verifier]]) {
    assert.equal(
      occurrences(source, /\bspawn\(/gu),
      occurrences(source, /trackChildProcess\(/gu),
      `${label} must capture every child exit at spawn`,
    );
    assert.match(source, /withTrackedDeadline\(/u, `${label} must impose wall-clock deadlines`);
    assert.equal(
      occurrences(source, /\bspawn\(/gu),
      occurrences(source, /detached: OWN_CHILD_PROCESS_GROUP/gu),
      `${label} must create an owned POSIX process group for every child`,
    );
    assert.equal(
      occurrences(source, /\bspawn\(/gu),
      occurrences(source, /ownsProcessGroup: OWN_CHILD_PROCESS_GROUP/gu),
      `${label} must register every owned process group`,
    );
  }
  assert.match(build, /BROKER_READY_TIMEOUT_MILLISECONDS/u);
  assert.match(build, /BROKER_CLOSE_TIMEOUT_MILLISECONDS/u);
  assert.match(build, /let closePromise = null/u);
  assert.match(ship, /READY_TIMEOUT_MILLISECONDS/u);
  assert.match(ship, /post-READY wall-clock deadline/u);
  assert.match(ship, /RSYNC_TIMEOUT_MILLISECONDS/u);
  assert.match(verifier, /VERIFIER_TIMEOUT_MILLISECONDS/u);
  assert.match(setup, /timeout: ARTIFACT_TOOL_TIMEOUT_MILLISECONDS/u);
  assert.match(setup, /killSignal: 'SIGKILL'/u);
  assert.match(vpsWorkflow, /timeout-minutes: 180/u);
  assert.match(pinWorkflow, /timeout-minutes: 180/u);
});
