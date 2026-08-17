import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/*
 * The motion system is two tokens and a kill switch.
 *
 * Direct feedback (a control answering the pointer) runs at ~300ms; a larger
 * state transition (a dialog or overlay arriving) runs at ~600ms; and
 * `prefers-reduced-motion` flattens every duration in the app from one rule in
 * globals.css. Everything below exists so a new surface cannot quietly invent a
 * third tier or a literal that escapes the reduced-motion rule.
 */

const ROOT = new URL("../src/", import.meta.url);
const globals = await readFile(new URL("app/globals.css", ROOT), "utf8");

test("the two motion tiers are defined once, at the sanctioned values", () => {
  assert.match(globals, /--hu-motion-feedback: 300ms;/);
  assert.match(globals, /--hu-motion-transition: 600ms;/);
  // The recovered aliases resolve through the feedback tier rather than
  // carrying live literals of their own.
  assert.match(globals, /--transition-duration: var\(--hu-motion-feedback\);/);
  assert.match(globals, /--hu-motion-fast: var\(--hu-motion-feedback\);/);
  assert.match(globals, /--hu-motion-standard: var\(--hu-motion-feedback\);/);
});

test("reduced motion flattens every animation and transition", () => {
  const rule = /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration: 0\.01ms !important;[\s\S]*?transition-duration: 0\.01ms !important;/;
  assert.match(globals, rule);
});

async function cssModules(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    if (entry.isDirectory()) found.push(...(await cssModules(full)));
    else if (entry.name.endsWith(".css")) found.push(full);
  }
  return found;
}

test("no component or page stylesheet invents its own duration", async () => {
  const srcDir = fileURLToPath(ROOT);
  const files = [
    ...(await cssModules(path.join(srcDir, "app"))),
    ...(await cssModules(path.join(srcDir, "components"))),
  ];
  assert.ok(files.length >= 15, `the stylesheet scan found only ${files.length} files`);

  const offenders = [];
  for (const file of files) {
    if (file.endsWith("globals.css")) continue;
    const text = await readFile(file, "utf8");
    // One declaration at a time: property name through to its semicolon, so a
    // `var(--transition-duration)` on one line can never borrow a literal from
    // the declaration after it.
    for (const match of text.matchAll(
      /(?:^|[{;])\s*((?:transition|animation)(?:-[a-z]+)?)\s*:([^;{}]*)/g,
    )) {
      const [, property, value] = match;
      // A stagger delay phases an ambient loop; it is not a motion tier.
      if (property === "animation-delay") continue;
      // An ambient loop — a spinner, shimmer, or breathing indicator — has a
      // PERIOD, not a duration; the two-tier rule is about one-shot motion.
      if (/\binfinite\b/.test(value)) continue;
      for (const literal of value.matchAll(/\b(\d+(?:\.\d+)?m?s)\b/g)) {
        // `0s`/`0ms` is a legitimate disable, not a tier.
        if (/^0m?s$/.test(literal[1])) continue;
        offenders.push(
          `${path.relative(path.dirname(srcDir), file)}: ${property}: ${value.trim()}`,
        );
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `duration literals outside the token block:\n${offenders.join("\n")}`,
  );
});
