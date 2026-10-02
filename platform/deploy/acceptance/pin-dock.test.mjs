import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const {
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
} = require("../../cli/pin-dock.js");

function harness() {
  const calls = [];
  let bootId = "b1".repeat(16);
  let online = true;
  const results = new Map(); // subcommand -> {status, stderr} or function
  const logs = [];
  const defaultsFor = (argv) => {
    if (results.has(argv[0])) return results.get(argv[0]);
    return { status: 1, stderr: "ERROR: unexpected subcommand" };
  };
  const harnessDeps = {
    serial: "SERIAL",
    options: parseFollowArgs(["--serial", "SERIAL", "--confirm"]),
    adbState: () => (online ? "device" : "offline"),
    adbShell: () => (online ? `${bootId}\n` : ""),
    dockTool: async (argv) => {
      calls.push(argv);
      const result = typeof defaultsFor(argv) === "function" ? defaultsFor(argv)(argv) : defaultsFor(argv);
      return result;
    },
    log: (line) => logs.push(line),
  };
  return {
    calls,
    logs,
    deps: harnessDeps,
    offline: () => {
      online = false;
    },
    reboot: () => {
      bootId = `b2${bootId.slice(2)}`;
    },
    on: (subcommand, result) => results.set(subcommand, result),
  };
}

test("dock routes inspection directly and every run through Luma's one-attempt claim", () => {
  const invocations = [];
  const status = dockCommand(["check", "--serial", "SERIAL"], {
    spawnSync: (binary, arguments_) => {
      invocations.push([binary, arguments_]);
      return { status: 0 };
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(invocations, [["python3", [VENDORED_DOCK_TOOL, "check", "--serial", "SERIAL"]]]);

  assert.deepEqual(
    dockToolArgv(["run", "--serial", "SERIAL", "--yes"]),
    ["-c", ONE_ATTEMPT_RUNNER, VENDORED_DOCK_TOOL, "run", "--serial", "SERIAL", "--yes"],
  );
  assert.doesNotMatch(ONE_ATTEMPT_RUNNER, /RUN_ATTEMPTS/u);
  assert.match(ONE_ATTEMPT_RUNNER, /attempt-.*\.lock/u);

  invocations.length = 0;
  const failing = dockCommand(["run", "--serial", "SERIAL", "--yes"], {
    spawnSync: (binary, arguments_) => {
      invocations.push([binary, arguments_]);
      return { status: 2 };
    },
  });
  assert.equal(failing, 2);
  assert.deepEqual(invocations, [["python3", dockToolArgv(["run", "--serial", "SERIAL", "--yes"])]]);
});

test("follow drives one guarded non-interactive attempt per fresh boot", async () => {
  const harnessInstance = harness();
  harnessInstance.on("verify", { status: 1, stderr: "" });
  harnessInstance.on("run", { status: 0, stderr: "" });

  let state = await followStep({ bootId: null, bootSettled: false }, harnessInstance.deps);
  assert.match(harnessInstance.calls[0].join(" "), /verify --serial SERIAL/u);
  assert.deepEqual(harnessInstance.calls[1], ["run", "--serial", "SERIAL", "--yes"]);
  assert.equal(state.bootSettled, true);
  assert.match(harnessInstance.logs.at(-1), /dock session active/u);

  // A settled boot is left alone until the boot id changes.
  harnessInstance.calls.length = 0;
  state = await followStep(state, harnessInstance.deps);
  assert.equal(harnessInstance.calls.length, 0);

  harnessInstance.reboot();
  state = await followStep(state, harnessInstance.deps);
  assert.match(harnessInstance.calls[0].join(" "), /verify/u);
  assert.equal(state.bootSettled, true);
});

test("an already-active boot is never re-run", async () => {
  const harnessInstance = harness();
  harnessInstance.on("verify", { status: 0, stderr: "active" });
  const state = await followStep({ bootId: null, bootSettled: false }, harnessInstance.deps);
  assert.equal(state.bootSettled, true);
  assert.equal(harnessInstance.calls.filter((argv) => argv[0] === "run").length, 0);
  assert.match(harnessInstance.logs.at(-1), /already active/u);
});

test("a pre-attempt power or battery refusal is retried within the same boot", async () => {
  const harnessInstance = harness();
  harnessInstance.on("verify", { status: 1, stderr: "" });
  let refused = true;
  harnessInstance.on("run", () =>
    refused
      ? { status: 2, stderr: "ERROR: external power is not connected" }
      : { status: 0, stderr: "" });

  let state = await followStep({ bootId: null, bootSettled: false }, harnessInstance.deps);
  assert.equal(state.bootSettled, false, "a power refusal must not settle the boot");
  assert.match(harnessInstance.logs.at(-1), /retrying this boot/u);

  refused = false;
  state = await followStep(state, harnessInstance.deps);
  assert.equal(state.bootSettled, true);
});

test("any other failure settles the boot and waits for the next one", async () => {
  const harnessInstance = harness();
  harnessInstance.on("verify", { status: 1, stderr: "" });
  harnessInstance.on("run", { status: 2, stderr: "ERROR: dock session unavailable after attempts" });

  let state = await followStep({ bootId: null, bootSettled: false }, harnessInstance.deps);
  assert.equal(state.bootSettled, true);
  assert.match(harnessInstance.logs.at(-1), /waiting for the next boot/u);

  harnessInstance.calls.length = 0;
  state = await followStep(state, harnessInstance.deps);
  assert.equal(harnessInstance.calls.length, 0, "the same boot is never retried after a real attempt");
});

test("a disconnect clears the boot and the next connection starts fresh", async () => {
  const harnessInstance = harness();
  harnessInstance.on("verify", { status: 0, stderr: "" });
  let state = await followStep({ bootId: "old", bootSettled: false }, harnessInstance.deps);
  harnessInstance.offline();
  state = await followStep(state, harnessInstance.deps);
  assert.equal(state.bootId, null);
  assert.match(harnessInstance.logs.at(-1), /waiting for SERIAL on ADB/u);
});

// One iteration's crash, a vanished adb binary, a failed probe, must cost
// that iteration only. The follow session outlives it.
test("a failing follow iteration is logged and the loop continues", async () => {
  const logs = [];
  let iterations = 0;
  await assert.rejects(
    followLoop({ bootId: null, bootSettled: false }, {
      serial: "SERIAL",
      options: parseFollowArgs(["--serial", "SERIAL", "--confirm"]),
      adbState: () => {
        throw new Error("spawn adb ENOENT");
      },
      dockTool: async () => {
        throw new Error("must not be reached");
      },
      log: (line) => logs.push(line),
    }, async () => {
      iterations += 1;
      if (iterations === 2) throw new Error("stop-follow");
    }),
    /stop-follow/u,
  );
  assert.equal(iterations, 2);
  assert.deepEqual(logs, [
    "follow step failed; continuing: spawn adb ENOENT",
    "follow step failed; continuing: spawn adb ENOENT",
  ]);
});

test("follow probes tolerate an adb that cannot spawn", async () => {
  const logs = [];
  let iterations = 0;
  // adb missing: spawnSync answers with stdout null, so the old
  // `.stdout.trim()` probe crashed the loop with a TypeError on its first
  // iteration. The stop-follow sentinel proves two iterations survived it,
  // and the device was never reached, so the vendored tool never runs.
  await assert.rejects(
    followCommand(["--serial", "SERIAL", "--confirm", "--interval", "1"], {
      log: (line) => logs.push(line),
      capture: () => ({ status: null, signal: null, stdout: null, stderr: null }),
      sleep: async () => {
        iterations += 1;
        if (iterations === 2) throw new Error("stop-follow");
      },
    }),
    /stop-follow/u,
  );
  assert.equal(iterations, 2);
  assert.match(logs.join("\n"), /following SERIAL: the dock session is restored once per boot/u);
});

test("follow passes its safety options through to the guarded run", () => {
  const options = parseFollowArgs([
    "--serial", "S", "--confirm", "--min-battery", "40",
    "--ndk", "/ndk", "--interval", "5",
  ]);
  assert.deepEqual(
    followRunArgs(options),
    ["run", "--serial", "S", "--yes", "--min-battery", "40", "--ndk", "/ndk"],
  );
  assert.equal(options.intervalSeconds, "5");
  assert.throws(() => parseFollowArgs(["--serial", "S"]), /literal --confirm/u);
  assert.throws(() => parseFollowArgs(["--serial", "S", "--confirm", "--confirm"]), /repeated/u);
  assert.throws(() => parseFollowArgs(["--serial", "S", "--confirm", "--interval", "0"]), /positive/u);
  assert.throws(() => parseFollowArgs([]), /usage/u);
});

// The refusal texts are ghostlock.py's own (read-only reference): its two
// `select_serial` inventory refusals embed tallies like
// `ready=0, unauthorized=1, offline=0, other=0`, and a device that is absent
// or unauthorized at selection time will not become ready within this boot,
// so they are terminal. adb's own mid-session errors are the transient ones.
test("only pre-attempt refusals count as recoverable", () => {
  assert.equal(recoverableRefusal("ERROR: external power is not connected"), true);
  assert.equal(recoverableRefusal("ERROR: battery is 12%; at least 20% is required"), true);
  assert.equal(recoverableRefusal("ERROR: device 'S' not found"), true);
  assert.equal(recoverableRefusal("command failed (1): adb -s <serial> shell id\nerror: device offline"), true);
  assert.equal(recoverableRefusal("error: device unauthorized."), true);
  // Inventory refusals and every later guard settle the boot instead.
  assert.equal(recoverableRefusal(
    "ERROR: device '<redacted>' is not ready; ADB states: ready=0, unauthorized=1, offline=0, other=0",
  ), false);
  assert.equal(recoverableRefusal(
    "ERROR: connect exactly one authorized AI Pin or pass --serial; ADB states: ready=2, unauthorized=0, offline=0, other=0",
  ), false);
  assert.equal(recoverableRefusal(
    "ERROR: battery or power state is unavailable; use --min-battery 0 only after " +
    "you have independently confirmed stable external power",
  ), false);
  assert.equal(recoverableRefusal(
    "ERROR: unsupported device or firmware; no evidence-backed profile matches. Mismatch: kernel",
  ), false);
  assert.equal(recoverableRefusal(
    "ERROR: no root after 3 attempts (120s); reboot the pin and try again on a fresh boot",
  ), false);
  assert.equal(recoverableRefusal("ERROR: dock session unavailable after 2 attempts"), false);
  assert.equal(recoverableRefusal("ERROR: confirmation did not match"), false);
});

test("the vendored dock-helper tree is present, pinned, and licensed", () => {
  assert.equal(fs.existsSync(VENDORED_DOCK_TOOL), true, "vendored CLI is missing");
  const upstream = fs.readFileSync(path.join(root, "pin/ghostlock/UPSTREAM.md"), "utf8");
  assert.match(upstream, /humane-aipin-ghostlock/u);
  assert.match(upstream, /[0-9a-f]{40}/u, "the vendored commit hash is recorded");
  assert.match(upstream, /platform\/cli\/pin-dock\.js/u);
  assert.match(upstream, /\.\/luma pin dock follow/u);
  assert.equal(fs.existsSync(path.join(root, "pin/ghostlock/LICENSE")), true);
});

test("the operator contract marks dock run and follow as confirmed device mutations", () => {
  const contract = JSON.parse(fs.readFileSync(path.join(root, "contracts/operator-setup.json"), "utf8"));
  for (const id of ["pin.dock.run", "pin.dock.follow"]) {
    const command = contract.commands.find((entry) => entry.id === id);
    assert.ok(command, `${id} is in the contract`);
    assert.equal(command.effect, "device-mutation");
    assert.equal(command.confirmationRequired, true);
    assert.equal(command.exactSerialRequired, true);
  }
  assert.match(contract.commands.find((entry) => entry.id === "pin.dock.follow").usage, /--confirm/u);
});

test("the retired command group is not retained as an alias", () => {
  const retiredGroup = path.basename(path.dirname(path.dirname(VENDORED_DOCK_TOOL)));
  const result = spawnSync(process.execPath, [path.join(root, "luma"), "pin", retiredGroup, "check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /dock check\|build\|run\|verify\|report\|follow/u);
});
