/*
 * Let a verify test import a `src/` module that imports another one.
 *
 * The tests here load TypeScript directly (`await import("../src/server/…​.ts")`)
 * and lean on Node's built-in type stripping. Node resolves ES module
 * specifiers exactly as written, while this repo — like every bundler-resolved
 * Next codebase — writes extensionless relative imports (`import { logWarn }
 * from "./log"`). So the moment a directly-imported module gained a sibling
 * import, the test failed with ERR_MODULE_NOT_FOUND at load time.
 *
 * The alternatives were worse. Writing `./log.ts` at the call site needs
 * `allowImportingTsExtensions` in tsconfig and leaves one import in the tree
 * spelled differently from every other; giving up and not importing the module
 * would mean the diagnostics could not be asserted at all.
 *
 * This hook is scoped as narrowly as it can be: it only ever runs after the
 * real resolver has already failed, only for relative specifiers, and only adds
 * the extension Node would have found itself if it did bundler resolution. A
 * missing module still fails, with its original error.
 */

import { register } from "node:module";

register(new URL("./tsResolveHook.mjs", import.meta.url), import.meta.url);
