import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { OPENERS, balanced, firstArgument, lineOf, maskSource, sourceFiles } from "./sourceScan.mjs";

/*
 * Nothing interpolated may reach the device's shell unquoted.
 *
 * ADB has NO execve-argv form. `transport.shell([...])` is joined with spaces
 * (`formatCommand`, src/lib/pin-device/adb/transport.ts) and the resulting
 * STRING is handed to the device's shell, so every non-literal that lands in one
 * of those arguments is shell source running with adbd's privileges on a
 * wearer's Pin. `/settings/pin/install` is an ungated wearer path whose "Install
 * APK File" flow takes a name straight from `<input type="file">`, which is what
 * made this reachable with a file someone else chose the name of.
 *
 * The quoting helper (src/lib/pin-device/adb/shellQuote.ts) already exists and
 * the two known callers route through it. This test is about the NEXT call site.
 * It is deliberately not a grep for `shellSingleQuote`: the original hole was
 *
 *     const deviceTmpPath = `${DEVICE_TMP_DIR}/${name}`;
 *     await transport.shell(["rm", "-f", deviceTmpPath]);
 *
 * where the call site contains no interpolation at all — the taint arrives
 * through a local. So the check resolves file-local `const`/`let` definitions
 * into the argument expression before looking for interpolation, and the last
 * test in this file proves it does by running the analyser over that exact
 * historic shape and requiring a finding.
 */

const ROOT = new URL("../src/", import.meta.url);

/** Every sink that ends up as a command string on the device's shell. */
const SHELL_SINKS = /\.(shell|shellWithInput|startCommandStream)\s*\(/g;

/** Calls whose output is already quoted, so what goes into them is inert. */
const SAFE_CALLS = ["shellSingleQuote(", "shellCommand("];

const SAFE_TOKEN = "«Q»";

/** File-local `const x = …` initialisers, so a taint that arrives through a
 *  local is visible at the sink. Function-valued and oversized bindings are
 *  skipped: they are never a command argument and only add noise. */
function localBindings(masked) {
  const bindings = new Map();
  const declaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*/g;
  let match;
  while ((match = declaration.exec(masked)) !== null) {
    const start = match.index + match[0].length;
    let depth = 0;
    let end = start;
    while (end < masked.length) {
      const char = masked[end];
      if (OPENERS[char]) depth += 1;
      else if (char === ")" || char === "]" || char === "}") {
        if (depth === 0) break;
        depth -= 1;
      } else if (depth === 0 && (char === ";" || char === "\n")) break;
      end += 1;
    }
    const initializer = masked.slice(start, end).trim();
    if (initializer.length > 400) continue;
    if (/=>|\bfunction\b|\bawait\b/.test(initializer)) continue;
    if (!bindings.has(match[1])) bindings.set(match[1], initializer);
  }
  return bindings;
}

function expand(expression, bindings, depth = 0) {
  if (depth >= 4) return expression;
  let expanded = expression;
  for (const [name, initializer] of bindings) {
    const reference = new RegExp(`\\b${name}\\b`, "g");
    if (!reference.test(expanded)) continue;
    if (new RegExp(`\\b${name}\\b`).test(initializer)) continue; // self-referential
    expanded = expanded.replace(reference, `(${initializer})`);
  }
  return expanded === expression ? expanded : expand(expanded, bindings, depth + 1);
}

/** Remove the calls that quote their input, plus the `${…}` they fill. */
function stripSafeCalls(expression) {
  let text = expression;
  for (;;) {
    let found = -1;
    let call = "";
    for (const candidate of SAFE_CALLS) {
      const at = text.indexOf(candidate);
      if (at !== -1 && (found === -1 || at < found)) {
        found = at;
        call = candidate;
      }
    }
    if (found === -1) break;
    const parenthesis = found + call.length - 1;
    const region = balanced(text, parenthesis);
    if (!region) break;
    text = `${text.slice(0, found)}${SAFE_TOKEN}${text.slice(region.end + 1)}`;
  }
  return text.replaceAll(new RegExp(`\\$\\{\\s*${SAFE_TOKEN}\\s*\\}`, "g"), "").replaceAll(SAFE_TOKEN, "");
}

/**
 * Every shell sink in one file, with a verdict. Returns
 * `{ line, expression, violation }` per call site.
 */
function shellSinks(source) {
  const masked = maskSource(source);
  const bindings = localBindings(masked);
  const sinks = [];
  SHELL_SINKS.lastIndex = 0;
  let match;
  while ((match = SHELL_SINKS.exec(masked)) !== null) {
    const parenthesis = match.index + match[0].length - 1;
    const region = balanced(masked, parenthesis);
    if (!region) continue;
    const expression = firstArgument(region.text);
    const residue = stripSafeCalls(expand(expression, bindings));
    const violation = residue.includes("${")
      ? "template interpolation"
      : /\+/.test(residue)
        ? "string concatenation"
        : null;
    sinks.push({
      line: lineOf(masked, match.index),
      method: match[1],
      // Sliced from the ORIGINAL text so the failure message shows the code as
      // written rather than the masked skeleton the analysis works on.
      expression: source
        .slice(parenthesis + 1, parenthesis + 1 + expression.length)
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 120),
      violation,
    });
  }
  return sinks;
}

test("no interpolated value reaches an ADB shell argument unquoted", async () => {
  const files = await sourceFiles(ROOT, readdir);
  const reached = [];
  const violations = [];

  for (const file of files) {
    const relative = decodeURIComponent(file.pathname).split("/src/").pop();
    const sinks = shellSinks(await readFile(file, "utf8"));
    if (sinks.length === 0) continue;
    reached.push(relative);
    for (const sink of sinks) {
      if (!sink.violation) continue;
      violations.push(
        `src/${relative}:${sink.line} — ${sink.violation} reaches ${sink.method}(): ${sink.expression}`,
      );
    }
  }

  assert.deepEqual(
    violations,
    [],
    `wrap the value with shellSingleQuote() (or build the whole command with shellCommand()) from src/lib/pin-device/adb/shellQuote.ts:\n${violations.join("\n")}`,
  );

  // A scan that matched nothing would pass the assertion above without checking
  // anything, and these are the files that own the device command surface.
  for (const owner of [
    "lib/pin-device/adb/systemInstaller.ts",
    "lib/pin-device/adb/packageManager.ts",
    "lib/pin-device/adb/transport.ts",
    "lib/pin-device/usbTransport.ts",
  ]) {
    assert.ok(reached.includes(owner), `the shell-sink scan never reached ${owner}`);
  }
});

test("the analyser fails the shapes it exists to catch", () => {
  // The historic bug, both ways round: the taint at the call site, and the taint
  // arriving through a local — the form that actually shipped, and the form a
  // grep for `shellSingleQuote` next to `.shell(` would have missed.
  const direct = shellSinks("await transport.shell([`rm -f ${DEVICE_TMP_DIR}/${name}`]);");
  assert.equal(direct.length, 1);
  assert.equal(direct[0].violation, "template interpolation");

  const throughLocal = shellSinks(`
    const deviceTmpPath = \`\${DEVICE_TMP_DIR}/\${name}\`;
    await transport.shell(["rm", "-f", deviceTmpPath]);
  `);
  assert.equal(throughLocal.length, 1);
  assert.equal(throughLocal[0].violation, "template interpolation");

  const concatenated = shellSinks('await transport.shell(["rm", "-f", DEVICE_TMP_DIR + name]);');
  assert.equal(concatenated[0].violation, "string concatenation");

  // …and passes the quoted forms the code actually uses, or it would just be a
  // ban on interpolation near a device.
  const quoted = shellSinks(`
    const deviceTmpPath = \`\${DEVICE_TMP_DIR}/\${name}\`;
    await transport.shell(shellCommand(["rm", "-f", deviceTmpPath]));
  `);
  assert.equal(quoted[0].violation, null);

  const redirected = shellSinks(`
    const deviceTmpPath = \`\${DEVICE_TMP_DIR}/\${name}\`;
    return transport.shell([
      "sh",
      "-c",
      shellSingleQuote(
        \`content write --uri \${shellSingleQuote(stagingFileUri)} < \${shellSingleQuote(deviceTmpPath)}\`,
      ),
    ]);
  `);
  assert.equal(redirected[0].violation, null);

  // A command handed in from outside the file is the caller's to quote; flagging
  // it would make every transport wrapper unwritable.
  assert.equal(shellSinks("shell(command) { return transport.shell(command); }")[0].violation, null);
});
