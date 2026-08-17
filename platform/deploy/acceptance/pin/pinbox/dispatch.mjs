// dispatch.mjs — the orchestrator. (Controller + Pure Fabrication: it wires
// argv → help/list/version/unknown → spawn or in-process command; it owns no
// logic of its own, delegating to registry/flags/spawner/render and the
// per-command run modules.)
//
// `ctx` lets tests inject stdout/stderr sinks and a fake spawn. dispatch()
// returns an exit code so the caller can set process.exitCode without a
// hard exit (cleaner for tests and for chaining).

import { spawn as spawnProcess } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COMMANDS, resolveCommand, VERSION } from "./registry.mjs";
import { splitArgs, buildNativeArgs } from "./flags.mjs";
import { spawnChild } from "./spawner.mjs";
import { renderHelp, renderListJson, renderVersion } from "./render.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = resolve(SCRIPT_DIR, "..");

export async function dispatch(argv, ctx = {}) {
  const out = ctx.out ?? ((s) => process.stdout.write(s));
  const err = ctx.err ?? ((s) => process.stderr.write(s));
  const spawn = ctx.spawn ?? spawnProcess;
  const dctx = { out, err, spawn };

  const args = argv.slice(2);

  // Top-level help / meta.
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    renderHelp(dctx);
    return 0;
  }
  if (args[0] === "version" || args[0] === "--version") {
    renderVersion(dctx);
    return 0;
  }
  if (args[0] === "list") {
    if (args.slice(1).includes("--json")) renderListJson(dctx);
    else renderHelp(dctx);
    return 0;
  }

  const name = args[0];
  const spec = resolveCommand(name);
  if (!spec) {
    err(`pinbox: unknown command "${name}"\n`);
    err(`Run \`pinbox help\` for the command list.\n`);
    return 2;
  }

  const rest = args.slice(1);
  const { common, passthrough } = splitArgs(rest);

  if (spec.inProcess) {
    const mod = await import(spec.runModule);
    if (typeof mod.run !== "function") {
      err(`pinbox: in-process command "${name}" is malformed (no run export)\n`);
      return 2;
    }
    return mod.run({ common, passthrough, ctx: dctx });
  }

  const { args: nativeArgs, warnings } = buildNativeArgs(spec, common, passthrough);
  for (const w of warnings) err(w + "\n");

  const file = join(TOOLS_DIR, spec.file);
  const env = { ...process.env };
  if (common.tokenFile !== undefined) {
    env.PENUMBRA_PIN_ADMIN_TOKEN_FILE = common.tokenFile;
  }
  if (common.verbose) {
    err(`+ node ${file} ${nativeArgs.join(" ")}\n`);
  }
  return spawnChild(spawn, file, nativeArgs, env, dctx);
}

export { COMMANDS, resolveCommand, splitArgs, buildNativeArgs, VERSION };
