/*
 * The resolve hook registered by ./tsResolve.mjs. See that file for why.
 *
 * Runs on the module-customisation thread, so it must not import anything from
 * the test process.
 */

/** Extensions bundler resolution would have tried, in the order it tries them. */
const CANDIDATES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

/**
 * The two ways Node reports "bundler resolution would have found this".
 * `ERR_MODULE_NOT_FOUND` is the extensionless-file case (`./log`);
 * `ERR_UNSUPPORTED_DIR_IMPORT` is the barrel-directory case (`@/lib/pin-device/adb`),
 * which Node refuses outright rather than reporting as missing. Both mean the
 * same thing here — try the candidate suffixes.
 */
const RECOVERABLE = new Set(["ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT"]);

/**
 * `@/…` is the tsconfig path alias for `center/src/…`. Node knows nothing about
 * tsconfig, so a module reached through this hook that imports `@/lib/…` — as
 * `pin-install/device.ts` and `pin-device/adb/*` legitimately do — would fail to
 * resolve. Rewriting it here keeps the alias spelled the same way in `src/` as
 * everywhere else in the codebase; the alternative was relative-path imports in
 * exactly the modules that happen to be under test, which is the tail wagging
 * the dog.
 */
const SOURCE_ROOT = new URL("../src/", import.meta.url).href;

function rewrite(specifier) {
  // Next's package exposes this runtime module as headers.js. The bundler
  // accepts the documented extensionless spelling used by application source;
  // plain `node --test` needs the concrete package file.
  if (specifier === "next/headers") return "next/headers.js";
  return specifier.startsWith("@/") ? `${SOURCE_ROOT}${specifier.slice(2)}` : specifier;
}

export async function resolve(specifier, context, nextResolve) {
  const resolved = rewrite(specifier);
  try {
    return await nextResolve(resolved, context);
  } catch (error) {
    // Only ever a fallback, and only for the repo's own relative and aliased
    // imports: a missing package must keep failing as a missing package.
    if (!RECOVERABLE.has(error?.code)) throw error;
    if (!resolved.startsWith(".") && resolved === specifier) throw error;
    for (const extension of CANDIDATES) {
      try {
        return await nextResolve(`${resolved}${extension}`, context);
      } catch {
        // Try the next shape; the original error is rethrown below if none fit,
        // so the caller still learns which specifier could not be found.
      }
    }
    throw error;
  }
}
