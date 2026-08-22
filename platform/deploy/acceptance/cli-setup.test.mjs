import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(root, "revival");
const require = createRequire(import.meta.url);

function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-setup-"));
  const env = {
    ...process.env,
    REVIVAL_CONFIG_DIR: path.join(temporary, "config"),
    REVIVAL_SECRETS_DIR: path.join(temporary, "secrets"),
    REVIVAL_ENV_FILE: path.join(temporary, "secrets", "runtime.env"),
    REVIVAL_DATA_DIR: path.join(temporary, "data"),
    REVIVAL_BUILD_DIR: path.join(temporary, "data", "build"),
    REVIVAL_BACKUP_DIR: path.join(temporary, "backups"),
  };
  return { temporary, env };
}

function invoke(env, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8" });
}

test("setup stores only the selected track and recomputes an actionable plan", () => {
  const { temporary, env } = fixture();
  try {
    const selected = invoke(env, "setup", "local", "--json");
    assert.equal(selected.status, 0, selected.stderr);
    const report = JSON.parse(selected.stdout);
    assert.equal(report.selectedTrack, "local");
    assert.equal(report.next.action, "./revival init");

    const stateFile = path.join(temporary, "setup-state.json");
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), {
      schemaVersion: 1,
      selectedTrack: "local",
    });

    const resumed = invoke(env, "setup", "--resume", "--json");
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.deepEqual(JSON.parse(resumed.stdout), report);
    assert.equal(fs.existsSync(env.REVIVAL_CONFIG_DIR), false, "setup must not initialize product state");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Pin setup retains no serial or secret and preserves physical acceptance", () => {
  const { temporary, env } = fixture();
  try {
    env.REVIVAL_TEST_SECRET = "never-write-this-secret";
    const signingFile = path.join(env.REVIVAL_SECRETS_DIR, "pin", "signing.env");
    const releaseDirectory = path.join(env.REVIVAL_DATA_DIR, "releases", "unverified");
    fs.mkdirSync(path.dirname(signingFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(signingFile, "PIN_SIGNING_STORE_FILE=/protected/store\n", { mode: 0o600 });
    fs.mkdirSync(releaseDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(releaseDirectory, "manifest.json"), "{}\n", { mode: 0o600 });

    const result = invoke(env, "setup", "pin", "--json");
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.physicalAcceptanceRequired, true);
    assert.equal(report.next.action, "./revival pin doctor");
    assert.equal(report.steps[0].status, "pending");
    assert.ok(
      report.steps.slice(1).every((step) => step.status === "blocked"),
      "prerequisite file presence must not become fake command completion",
    );
    const state = fs.readFileSync(path.join(temporary, "setup-state.json"), "utf8");
    assert.doesNotMatch(state, /serial|secret|never-write-this-secret/i);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("all setup surfaces inspect evidence without executing external tools", () => {
  const { temporary, env } = fixture();
  try {
    const bin = path.join(temporary, "bin");
    const marker = path.join(temporary, "executed-tools.txt");
    fs.mkdirSync(bin, { mode: 0o700 });
    for (const command of ["adb", "curl", "docker", "scp", "ssh"]) {
      const stub = path.join(bin, command);
      fs.writeFileSync(
        stub,
        "#!/bin/sh\nprintf '%s\\n' \"$0\" >> \"$REVIVAL_EXEC_MARKER\"\nexit 97\n",
        { mode: 0o700 },
      );
    }
    fs.mkdirSync(env.REVIVAL_SECRETS_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(env.REVIVAL_ENV_FILE, "REVIVAL_CONFIG_VERSION=1\n", { mode: 0o600 });
    env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    env.REVIVAL_EXEC_MARKER = marker;

    for (const track of ["local", "contributor", "production", "pin"]) {
      const selected = invoke(env, "setup", track, "--json");
      assert.equal(selected.status, 0, `${track}: ${selected.stderr}`);
      assert.doesNotThrow(() => JSON.parse(selected.stdout));

      const status = invoke(env, "setup", "status", "--json");
      assert.equal(status.status, 0, `${track} status: ${status.stderr}`);
      const resumed = invoke(env, "setup", "--resume", "--json");
      assert.equal(resumed.status, 0, `${track} resume: ${resumed.stderr}`);
    }
    assert.equal(fs.existsSync(marker), false, "setup must never execute Docker, ADB, network, or remote tools");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("hosted import child refuses absent or cross-action whole-source bindings before its verifier", () => {
  const { temporary, env } = fixture();
  try {
    const setupPath = path.join(root, "platform", "cli", "setup.js");
    const invokeSetup = (binding) => spawnSync(process.execPath, ["-e", [
      "const { setupCommand } = require(process.argv[1]);",
      "const binding = JSON.parse(process.argv[2]);",
      "setupCommand(['import', 'vps-candidate', '--handoff-root', '/definitely/missing'], { invocationBinding: binding });",
    ].join("\n"), setupPath, JSON.stringify(binding)], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    const absent = invokeSetup(null);
    assert.equal(absent.status, 1);
    assert.match(absent.stderr, /invocation binding has an unsupported or mismatched shape/u);
    const mismatched = invokeSetup({
      schemaVersion: 3,
      actionId: "setup.import.pin-release",
      actionBindingSha256: "1".repeat(64),
      untrackedPolicySha256: "2".repeat(64),
      untrackedEnumerationSha256: "3".repeat(64),
      trackedMembershipSha256: "4".repeat(64),
      trackedSourceBindingSha256: "5".repeat(64),
      trackedSourceEvidenceSha256: "6".repeat(64),
      invocationSha256: "7".repeat(64),
    });
    assert.equal(mismatched.status, 1);
    assert.match(mismatched.stderr, /invocation binding has an unsupported or mismatched shape/u);
    assert.doesNotMatch(`${absent.stderr}${mismatched.stderr}`, /handoff root|provider|attestation/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("setup success receipts are canonical, source/action-bound, expiring, and never physical", () => {
  const { temporary, env } = fixture();
  try {
    env.REVIVAL_STATE_DIR = path.join(temporary, "guided-state");
    const modulePath = path.join(root, "platform", "cli", "setup-state.js");
    const script = [
      "const state = require(process.argv[1]);",
      "const now = Date.now();",
      "const done = (actionId, outcome) => ({ schemaVersion: 1, actionId, outcome, status: 0, signal: null });",
      "const record = (argv, completion, options = {}) => state.recordSetupInvocationSuccess(argv, completion, { ...options, invocationBinding: state.captureSetupInvocation(argv) });",
      "state.selectSetupTrack('local');",
      "const written = record(['doctor'], done('doctor.local', 'local-prerequisites-verified'), { now, requireReceipt: true });",
      "const current = state.readSetupActionReceipt('doctor.local', { now: now + 1 });",
      "const expired = state.readSetupActionReceipt('doctor.local', { now: now + 16 * 60 * 1000 });",
      "const physical = record(['pin', 'install', '--confirm'], done('pin.install', 'installed'), { now });",
      "const imported = record(['setup', 'import', 'vps-candidate', '--handoff-root', '/tmp/x'], done('setup.import.vps-candidate', 'hosted-vps-candidate-imported'), { evidenceSha256: 'a'.repeat(64), now, requireReceipt: true });",
      "const releaseStep = require('./platform/cli/setup').setupReport('production').steps.find((step) => step.id === 'release');",
      "const mapped = state.commandIdForInvocation(['setup', 'import', 'vps-candidate', '--handoff-root', '/tmp/x']);",
      "process.stdout.write(JSON.stringify({ written, current, expired, physical, imported, releaseStep, mapped, receiptDir: state.RECEIPT_DIR }));",
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", script, modulePath], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.current, report.written);
    assert.equal(report.written.schemaVersion, 5);
    assert.equal(report.expired, null);
    assert.equal(report.physical, null);
    assert.equal(report.imported.actionId, "setup.import.vps-candidate");
    assert.equal(report.releaseStep.status, "complete");
    assert.match(report.releaseStep.evidence, /source\/action-bound success receipt/u);
    assert.equal(report.mapped, "setup.import.vps-candidate");
    assert.equal(fs.statSync(report.receiptDir).mode & 0o777, 0o700);
    const receiptPath = path.join(report.receiptDir, "doctor.local.json");
    assert.equal(fs.statSync(receiptPath).mode & 0o777, 0o600);
    const source = fs.readFileSync(receiptPath, "utf8");
    assert.equal(source, `${JSON.stringify(JSON.parse(source), Object.keys(JSON.parse(source)).sort())}\n`);

    const tampered = JSON.parse(source);
    tampered.untrackedEnumerationSha256 = "0".repeat(64);
    fs.writeFileSync(receiptPath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
    const refused = spawnSync(process.execPath, ["-e", [
      "const state = require(process.argv[1]);",
      "try { const value = state.readSetupActionReceipt('doctor.local', { now: 1_900_000_000_001 }); process.stdout.write(String(value)); }",
      "catch (error) { process.stdout.write(error.message); }",
    ].join("\n"), modulePath], { cwd: root, env, encoding: "utf8" });
    assert.equal(refused.status, 0, refused.stderr);
    assert.match(refused.stdout, /unsupported shape|^null$/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("setup receipts require exact action results and reject plan, dry-run, status, alias, and flag bypasses", () => {
  const { temporary, env } = fixture();
  try {
    env.REVIVAL_STATE_DIR = path.join(temporary, "guided-state");
    const modulePath = path.join(root, "platform", "cli", "setup-state.js");
    const script = [
      "const state = require(process.argv[1]);",
      "const done = (actionId, outcome, extra = {}) => ({ schemaVersion: 1, actionId, outcome, status: 0, signal: null, ...extra });",
      "const record = (argv, id, outcome, options = {}) => state.recordSetupInvocationSuccess(argv, done(id, outcome), { ...options, invocationBinding: state.captureSetupInvocation(argv) });",
      "const values = {};",
      "values.upAlias = record(['up'], 'stack.up', 'local-stack-started');",
      "values.stackStatus = record(['status'], 'stack.status', 'local-stack-running');",
      "values.help = record(['doctor', '--help'], 'doctor.local', 'local-prerequisites-verified');",
      "values.deployPlan = record(['deploy', 'production', '--candidate-id', '1'.repeat(64)], 'deploy.production', 'production-deployment-applied');",
      "values.deployDry = record(['deploy', 'production', '--candidate-id', '1'.repeat(64), '--confirm', '--dry-run'], 'deploy.production', 'production-deployment-applied');",
      "values.deployDuplicate = record(['deploy', 'production', '--candidate-id', '1'.repeat(64), '--confirm', '--confirm'], 'deploy.production', 'production-deployment-applied');",
      "values.deployWeak = record(['deploy', 'production', '--candidate-id', '1'.repeat(64), '--confirm', '--skip-staging-smoke'], 'deploy.production', 'production-deployment-applied');",
      "values.deployApplied = record(['deploy', 'production', '--candidate-id', '1'.repeat(64), '--confirm'], 'deploy.production', 'production-deployment-applied');",
      "values.baselinePlan = record(['deploy', 'carry-baseline', '--candidate-id', '1'.repeat(64)], 'deploy.carry-baseline', 'carry-baseline-registered');",
      "values.baselineDry = record(['deploy', 'carry-baseline', '--candidate-id', '1'.repeat(64), '--dry-run'], 'deploy.carry-baseline', 'carry-baseline-registered');",
      "values.baselineDuplicate = record(['deploy', 'carry-baseline', '--candidate-id', '1'.repeat(64), '--confirm', '--confirm'], 'deploy.carry-baseline', 'carry-baseline-registered');",
      "values.baselineWeak = record(['deploy', 'carry-baseline', '--candidate-id', '1'.repeat(64), '--confirm', '--cleanup-project-images'], 'deploy.carry-baseline', 'carry-baseline-registered');",
      "values.baselineConflict = record(['deploy', 'carry-baseline', '--candidate', '/tmp/candidate', '--candidate-id', '1'.repeat(64), '--confirm'], 'deploy.carry-baseline', 'carry-baseline-registered');",
      "values.baselineApplied = record(['deploy', 'carry-baseline', '--candidate-id', '1'.repeat(64), '--confirm'], 'deploy.carry-baseline', 'carry-baseline-registered');",
      "values.shipPlan = record(['pin', 'release', 'ship'], 'pin.release.ship', 'pin-release-published');",
      "values.shipLocal = record(['pin', 'release', 'ship', '--confirm', '--local'], 'pin.release.ship', 'pin-release-published');",
      "values.shipRemote = record(['pin', 'release', 'ship', '--confirm', '--remote', 'vps'], 'pin.release.ship', 'pin-release-published');",
      "values.pkiStatus = record(['pki', 'status'], 'pki.import', 'device-user-ca-imported');",
      "values.pkiMissing = record(['pki', 'import', 'device-user', '--confirm', '--cert', '/tmp/cert'], 'pki.import', 'device-user-ca-imported');",
      "values.pkiImported = record(['pki', 'import', 'device-user', '--key', '/tmp/key', '--confirm', '--cert', '/tmp/cert'], 'pki.import', 'device-user-ca-imported');",
      "values.backupPlan = record(['backup'], 'backup', 'production-backup-created');",
      "values.backupDone = record(['backup', '--confirm', '--fetch'], 'backup', 'production-backup-created');",
      "values.canaryWeak = record(['canary', '--confirm', '--wearer-plane-optional'], 'canary', 'production-canary-passed');",
      "values.canaryDone = record(['canary', '--confirm'], 'canary', 'production-canary-passed');",
      "values.wrongResult = record(['doctor'], 'doctor.local', 'wrong-outcome');",
      "values.failedResult = state.recordSetupInvocationSuccess(['doctor'], done('doctor.local', 'local-prerequisites-verified', { status: 1 }), { invocationBinding: state.captureSetupInvocation(['doctor']) });",
      "values.physical = record(['pin', 'install', '--confirm'], 'pin.install', 'installed');",
      "try { record(['setup', 'import', 'pin-release', '--release-root', '/tmp/release'], 'setup.import.pin-release', 'hosted-pin-release-imported', { requireReceipt: true }); values.importWithoutEvidence = 'accepted'; } catch (error) { values.importWithoutEvidence = error.message; }",
      "process.stdout.write(JSON.stringify(values));",
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", script, modulePath], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const values = JSON.parse(result.stdout);
    for (const key of [
      "upAlias", "stackStatus", "deployApplied", "baselineApplied", "shipRemote", "pkiImported", "backupDone", "canaryDone",
    ]) assert.equal(values[key].outcome, "success", key);
    for (const key of [
      "help", "deployPlan", "deployDry", "deployDuplicate", "deployWeak", "baselinePlan", "baselineDry",
      "baselineDuplicate", "baselineWeak", "baselineConflict", "shipPlan", "shipLocal", "pkiStatus",
      "pkiMissing", "backupPlan", "canaryWeak", "wrongResult", "failedResult", "physical",
    ]) assert.equal(values[key], null, key);
    assert.match(values.importWithoutEvidence, /evidence/u);
    const source = fs.readFileSync(modulePath, "utf8");
    assert.match(source, /TRACKED_GIT_EXECUTABLE = '\/usr\/bin\/git'/u);
    assert.match(source, /'ls-files', '--cached', '--stage', '--full-name', '-z', '--'/u);
    assert.match(source, /'ls-files', '--others', '-z', '--'/u);
    assert.match(source, /allowedWorkspaceInstructions: Object\.freeze\(\['AGENTS\.md', 'CLAUDE\.md'\]\)/u);
    assert.match(source, /enumeration: 'git-ls-files-others-unfiltered'/u);
    assert.match(source, /usesRepositoryGitignore: false/u);
    assert.match(source, /usesGitInfoExclude: false/u);
    assert.doesNotMatch(source, /--exclude-standard|--exclude-per-directory/u);
    assert.match(source, /function captureTrackedSource\(\)/u);
    assert.match(source, /trackedMembershipSha256/u);
    assert.doesNotMatch(source, /implementationTree|implementationFiles|perGroup|captureImplementationFileSet/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("pre-dispatch evidence is one closed whole-tracked-source capture and rejects failed completion", () => {
  const { temporary, env } = fixture();
  try {
    env.REVIVAL_STATE_DIR = path.join(temporary, "guided-state");
    const state = require(path.join(root, "platform", "cli", "setup-state.js"));
    const tracked = state.captureTrackedSource();
    assert.equal(tracked.schemaVersion, 2);
    assert.equal(tracked.fileCount, tracked.membership.length);
    assert.equal(tracked.fileCount, tracked.entries.length);
    assert.equal(tracked.repository.index.path, "gitdir/index");
    assert.deepEqual(Object.keys(tracked.repository.gitDir).sort(), [
      "dev", "gid", "ino", "mode", "path", "type", "uid",
    ]);
    assert.equal(Object.hasOwn(tracked.repository.gitDir, "ctimeNs"), false);
    assert.equal(tracked.gitExecutable.path, "/usr/bin/git");
    assert.deepEqual(tracked.untracked, ["AGENTS.md", "CLAUDE.md"]);
    assert.equal(tracked.untrackedPolicy.enumeration, "git-ls-files-others-unfiltered");
    assert.equal(tracked.untrackedPolicy.usesRepositoryGitignore, false);
    assert.equal(tracked.untrackedPolicy.usesGitInfoExclude, false);
    const membership = new Set(tracked.membership.map((entry) => entry.path));
    assert.equal(membership.has("revival"), true);
    assert.equal(membership.has("contracts/operator-setup.json"), true);
    assert.equal(membership.has("platform/deploy/release.mjs"), true);
    assert.equal(membership.has("platform/cli/authority.js"), true);
    assert.equal(membership.has("platform/deploy/pin/github-private-trusted-root.jsonl"), true);
    assert.equal(membership.has(".env.example"), true);
    assert.equal(membership.has("AGENTS.md"), false, "injected untracked instructions entered receipt source");
    assert.equal(membership.has("CLAUDE.md"), false, "injected untracked instructions entered receipt source");

    const argv = ["doctor"];
    const invocationBinding = state.captureSetupInvocation(argv, { trackedSourceCapture: tracked });
    assert.deepEqual(Object.keys(invocationBinding).sort(), [
      "actionBindingSha256",
      "actionId",
      "invocationSha256",
      "schemaVersion",
      "untrackedEnumerationSha256",
      "untrackedPolicySha256",
      "trackedMembershipSha256",
      "trackedSourceBindingSha256",
      "trackedSourceEvidenceSha256",
    ].sort());
    const completion = { schemaVersion: 1, actionId: "doctor.local", outcome: "local-prerequisites-verified", status: 1, signal: null };
    assert.equal(state.recordSetupInvocationSuccess(argv, completion, {
      invocationBinding,
      postTrackedSourceCapture: tracked,
    }), null);
    assert.throws(
      () => state.recordSetupInvocationSuccess(argv, completion, {
        invocationBinding,
        postTrackedSourceCapture: tracked,
        requireReceipt: true,
      }),
      /exact action-specific success result/u,
    );
    const exchangedBinding = { ...invocationBinding, trackedSourceEvidenceSha256: "0".repeat(64) };
    assert.equal(state.recordSetupInvocationSuccess(argv, { ...completion, status: 0 }, {
      invocationBinding: exchangedBinding,
      postTrackedSourceCapture: tracked,
    }), null);
    assert.throws(
      () => state.recordSetupInvocationSuccess(argv, { ...completion, status: 0 }, {
        invocationBinding: exchangedBinding,
        postTrackedSourceCapture: tracked,
        requireReceipt: true,
      }),
      /changed during execution/u,
    );
    assert.throws(
      () => state.captureSetupInvocation(argv, {
        trackedSourceCapture: {
          schemaVersion: 1,
          membership: [{ path: "revival" }],
          entries: [],
        },
      }),
      /tracked-source capture has an unsupported shape/u,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
