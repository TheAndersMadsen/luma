// flags.mjs, argument splitting + translation. Pure: no I/O, no side effects.
//
// splitArgs separates pinbox's normalized common flags from tool-specific
// passthrough; `--` forces the rest to passthrough (escape hatch for flag
// collisions). buildNativeArgs translates the common values into a tool's
// native flag spellings and reports anything dropped (so a dropped --json is
// visible, not silently lost).

export const COMMON_FLAGS = new Set([
  "--serial",
  "--adb",
  "--adb-path",
  "--json",
  "--token-file",
  "--verbose",
]);

export function splitArgs(argv) {
  const common = { serial: undefined, adb: undefined, json: false, tokenFile: undefined, verbose: false };
  const passthrough = [];
  let forcePassthrough = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (forcePassthrough) {
      passthrough.push(arg);
      continue;
    }
    if (arg === "--") {
      forcePassthrough = true;
      continue;
    }
    if (arg === "--serial") {
      common.serial = argv[++i];
    } else if (arg === "--adb" || arg === "--adb-path") {
      common.adb = argv[++i];
    } else if (arg === "--json") {
      common.json = true;
    } else if (arg === "--token-file") {
      common.tokenFile = argv[++i];
    } else if (arg === "--verbose") {
      common.verbose = true;
    } else {
      passthrough.push(arg);
    }
  }
  return { common, passthrough };
}

// Translate normalized common values into the tool's native flags per spec.
// Returns {args, warnings}. Warnings describe deliberately-dropped flags.
export function buildNativeArgs(spec, common, passthrough) {
  const args = [];
  const warnings = [];
  if (common.serial !== undefined) {
    if (spec.serial) args.push(spec.serial, common.serial);
    else warnings.push(`pinbox: --serial ignored (command "${spec.name}" does not take it)`);
  }
  if (common.adb !== undefined) {
    if (spec.adb) args.push(spec.adb, common.adb);
    else warnings.push(`pinbox: --adb ignored (command "${spec.name}" does not take it)`);
  }
  if (common.json) {
    if (spec.json) args.push(spec.json);
    else warnings.push(`pinbox: --json ignored (command "${spec.name}" does not support it)`);
  }
  if (common.tokenFile !== undefined && spec.tokenFile) {
    args.push(spec.tokenFile, common.tokenFile);
    // Tools without a native --token-file read the token via the
    // PENUMBRA_PIN_ADMIN_TOKEN_FILE env, which the spawner sets on the child.
  }
  for (const p of passthrough) args.push(p);
  return { args, warnings };
}
