/**
 * Resolve Center's own module specifiers for `node --test`.
 *
 * `src/` is written for the bundler's resolution mode: `../logging` means
 * `../logging.ts`, and `@/lib/...` means `src/lib/...` per the `paths` entry in
 * `center/tsconfig.json`. Node's ESM resolver does neither, so a verify test
 * that imports a module with either kind of specifier — as the pin-device
 * transport and system installer do — cannot load it without this hook.
 *
 * Deliberately narrow, so it cannot quietly resolve something the real build
 * would not: exactly the one `@/*` alias tsconfig declares, `.ts` as the only
 * inferred extension, and the extension only when the default resolution would
 * have failed anyway. No directory-index guessing, no `.js`/`.json` fallbacks.
 */
const ALIAS_PREFIX = "@/";
const SRC = new URL("../../src/", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(ALIAS_PREFIX)) {
    return resolve(
      `${SRC}${specifier.slice(ALIAS_PREFIX.length)}`,
      context,
      nextResolve,
    );
  }

  const withoutQuery = specifier.split("?", 1)[0];
  const isRelativeOrAbsolute =
    withoutQuery.startsWith("./") ||
    withoutQuery.startsWith("../") ||
    withoutQuery.startsWith("file:");
  const hasExtension = /\.[cm]?[jt]sx?$/.test(withoutQuery);

  if (isRelativeOrAbsolute && !hasExtension) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      // Not a TypeScript source; fall through to the default resolution so the
      // caller still sees Node's own error.
    }
  }

  return nextResolve(specifier, context);
}
