'use strict';
// Dock-session host operations. The vendored tool under pin/ghostlock owns
// the firmware, battery, power, and exploit guards. Luma adds an atomic
// boot-scoped claim shared with the on-device runner before routing `run` to
// that tool. The vendored runner itself permits one attempt per boot. `follow`
// restores the temporary session once per fresh boot while the Pin is docked.

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const { fail } = require('./context');

const PROJECT_DIR = path.resolve(__dirname, '../..');
const VENDORED_DOCK_TOOL = path.join(PROJECT_DIR, 'pin', 'ghostlock', 'tools', 'ghostlock.py');
const ONE_ATTEMPT_RUNNER = String.raw`
import hashlib
import importlib.util
import re
import sys
from pathlib import Path

tool = Path(sys.argv[1]).resolve()
spec = importlib.util.spec_from_file_location("luma_vendored_ghostlock", tool)
if spec is None or spec.loader is None:
    raise SystemExit("ERROR: cannot load the vendored dock helper")
ghostlock = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ghostlock
spec.loader.exec_module(ghostlock)

original_build_runner_argv = ghostlock.build_runner_argv

def claimed_build_runner_argv(*args, **kwargs):
    serial = kwargs.get("serial")
    if not isinstance(serial, str) or not serial:
        raise ghostlock.GhostLockError("Luma could not bind the attempt to a device")
    boot_id = ghostlock.shell_value(serial, "cat /proc/sys/kernel/random/boot_id")
    if re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", boot_id) is None:
        raise ghostlock.GhostLockError("Luma could not bind the attempt to this boot")
    component = hashlib.sha256(boot_id.encode("ascii")).hexdigest()[:32]
    root = "/data/local/tmp/.luma-standalone-dock-claims"
    claim = f"{root}/attempt-{component}.lock"
    result = ghostlock.shell(
        serial,
        f"umask 077; mkdir -p {root} && mkdir {claim}",
        check=False,
    )
    if result.returncode != 0:
        raise ghostlock.GhostLockError(
            "this boot already consumed Luma's single dock attempt; reboot before trying again"
        )
    return original_build_runner_argv(*args, **kwargs)

ghostlock.build_runner_argv = claimed_build_runner_argv
raise SystemExit(ghostlock.main(sys.argv[2:]))
`.trim();

const PASSTHROUGH = new Set(['check', 'build', 'run', 'verify', 'report']);

const USAGE =
  'usage: ./luma pin dock check --serial SERIAL | build [--ndk PATH] [--profile ID] |\n' +
  '              run --serial SERIAL [--yes] [--min-battery N] | verify --serial SERIAL |\n' +
  '              report RUN_DIR --output FILE | follow --serial SERIAL --confirm [--min-battery N] [--ndk PATH] [--interval SECONDS]\n' +
  '       run and follow change the connected device and consume at most one attempt per boot.';

function dockToolArgv(arguments_) {
  return arguments_[0] === 'run'
    ? ['-c', ONE_ATTEMPT_RUNNER, VENDORED_DOCK_TOOL, ...arguments_]
    : [VENDORED_DOCK_TOOL, ...arguments_];
}

// A refusal the vendored tool raises before it consumes the boot's single attempt.
// Only these are retried within the same boot. Everything else waits for the
// next one, exactly as the tool's own guidance demands. The two preflight
// sentences are ghostlock.py's power and battery guards. The device-state
// pattern matches only adb's own runtime errors (`device offline`,
// `device 'X' not found`). The vendored tool's inventory refusals instead
// report tallies like `offline=1`, and a device that is absent or unauthorized
// at selection time will not become ready within this boot.
const RECOVERABLE = [
  /external power is not connected/u,
  /battery is \d+%; at least \d+% is required/u,
  /device (?:'[^']*' )?(?:not found|offline|unauthorized)\b/u,
];

function dockCommand(args, { spawnSync: spawnSyncDependency = spawnSync, python = 'python3' } = {}) {
  const subcommand = args.shift();
  if (subcommand === 'follow') {
    void followCommand(args);
    return undefined;
  }
  if (!PASSTHROUGH.has(subcommand)) fail(USAGE, 64);
  const result = spawnSyncDependency(python, dockToolArgv([subcommand, ...args]), { stdio: 'inherit' });
  return result.status ?? 1;
}

function parseFollowArgs(argv) {
  const options = { serial: null, confirmed: false, minBattery: undefined, ndk: null, intervalSeconds: '15' };
  const value = (name) => {
    const next = argv.shift();
    if (next === undefined) throw new Error(`./luma pin dock follow: ${name} requires a value`);
    return next;
  };
  while (argv.length) {
    const argument = argv.shift();
    if (argument === '--serial') options.serial = value('--serial');
    else if (argument === '--confirm' && !options.confirmed) options.confirmed = true;
    else if (argument === '--min-battery') options.minBattery = value('--min-battery');
    else if (argument === '--ndk') options.ndk = value('--ndk');
    else if (argument === '--interval') options.intervalSeconds = value('--interval');
    else throw new Error(`./luma pin dock follow: unknown or repeated option ${argument}`);
  }
  if (!options.serial) throw new Error(USAGE);
  if (!options.confirmed) {
    throw new Error('./luma pin dock follow: literal --confirm is required because this command can change the connected Pin');
  }
  if (!/^[1-9][0-9]*$/.test(options.intervalSeconds)) {
    throw new Error('./luma pin dock follow: --interval must be a positive number of seconds');
  }
  return options;
}

function followRunArgs(options) {
  const argv = ['run', '--serial', options.serial, '--yes'];
  if (options.minBattery !== undefined) argv.push('--min-battery', options.minBattery);
  if (options.ndk) argv.push('--ndk', options.ndk);
  return argv;
}

function recoverableRefusal(stderr) {
  return RECOVERABLE.some((pattern) => pattern.test(String(stderr)));
}

// One iteration of the follow loop, pure over the injected dependencies so
// the boot state machine is testable without a device. Each fresh boot is
// handled exactly once: verify first (the dock session may already be active),
// then one guarded run. A recoverable preflight refusal is retried. Anything
// else settles the boot and waits for the next.
async function followStep(state, { serial, options, adbState, adbShell, dockTool, log }) {
  if (adbState() !== 'device') {
    if (state.bootId) log(`waiting for ${serial} on ADB`);
    return { bootId: null, bootSettled: false };
  }
  const bootId = String(adbShell('cat /proc/sys/kernel/random/boot_id') || '').trim();
  if (!bootId) return state;
  if (bootId !== state.bootId) {
    log(`fresh boot ${bootId.slice(0, 8)} on ${serial}`);
    state = { bootId, bootSettled: false };
  }
  if (state.bootSettled) return state;
  const verified = await dockTool(['verify', '--serial', serial]);
  if (verified.status === 0) {
    log(`dock session already active on ${serial} for this boot`);
    return { ...state, bootSettled: true };
  }
  const attempted = await dockTool(followRunArgs(options));
  if (attempted.status === 0) {
    log(`dock session active on ${serial} for this boot`);
    return { ...state, bootSettled: true };
  }
  if (recoverableRefusal(attempted.stderr)) {
    log('preflight refused the attempt (power, battery, or ADB); retrying this boot');
    return state;
  }
  log('dock session could not be started; waiting for the next boot');
  return { ...state, bootSettled: true };
}

function runDockToolCaptured(arguments_, { python = 'python3' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(python, dockToolArgv(arguments_), { stdio: ['inherit', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', (error) => {
      process.stderr.write(`${error.message}\n`);
      resolve({ status: 1, stderr: `${stderr}\n${error.message}` });
    });
    child.on('close', (code) => resolve({ status: code ?? 1, stderr }));
  });
}

// The follow loop's iteration guard: one step's failure, a vanished adb, a
// crashed probe, must never end the follow session, only that iteration.
async function followLoop(state, dependencies, delay) {
  for (;;) {
    try {
      state = await followStep(state, dependencies);
    } catch (error) {
      dependencies.log(`follow step failed; continuing: ${error?.message ?? error}`);
    }
    await delay();
  }
}

// The real probes. adb that cannot spawn answers with stdout null, so every
// probe tolerates a missing capture exactly as followStep's shell reader does.
function followDependencies(options, capture, log) {
  return {
    serial: options.serial,
    options,
    adbState: () => (capture(['-s', options.serial, 'get-state']).stdout || '').trim(),
    adbShell: (command) => capture(['-s', options.serial, 'shell', command]).stdout,
    dockTool: (arguments_) => runDockToolCaptured(arguments_),
    log,
  };
}

async function followCommand(argv, {
  log = (line) => process.stderr.write(`${line}\n`),
  capture = (arguments_) => spawnSync('adb', arguments_, { encoding: 'utf8' }),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  let options;
  try {
    options = parseFollowArgs(argv);
  } catch (error) {
    fail(error.message, 64);
  }
  log(`following ${options.serial}: the dock session is restored once per boot while connected; Ctrl-C stops`);
  await followLoop(
    { bootId: null, bootSettled: false },
    followDependencies(options, capture, log),
    () => sleep(Number(options.intervalSeconds) * 1000),
  );
}

module.exports = {
  VENDORED_DOCK_TOOL,
  ONE_ATTEMPT_RUNNER,
  dockCommand,
  dockToolArgv,
  followCommand,
  followLoop,
  followRunArgs,
  followStep,
  parseFollowArgs,
  recoverableRefusal,
};
