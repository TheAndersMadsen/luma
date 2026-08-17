#!/usr/bin/env node

// pinbox — unified Penumbra test CLI. One entry, many commands.
//
// This file is a thin entry: it delegates to the pinbox package in ./pinbox/.
// See `node platform/deploy/acceptance/pin/pinbox.mjs help` for the command list, or the package's
// dispatch.mjs for how a command is routed (shell-out to an existing tool, or
// in-process for probe/readiness).

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dispatch } from "./pinbox/dispatch.mjs";

// Run only when invoked directly, not when imported (e.g. by the unit test).
// realpath on both sides survives macOS symlinks (/tmp -> /private/tmp), which
// would otherwise make a naive URL-string compare skip dispatch entirely.
const isMainModule = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMainModule) {
  dispatch(process.argv).then((code) => {
    process.exitCode = code;
  });
}
