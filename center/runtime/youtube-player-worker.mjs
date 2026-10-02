// INFERRED: Luma's YouTube player evaluator. It runs in a disposable process
// with no inherited credentials. The parent enforces the whole-process deadline.
import { getQuickJS } from "quickjs-emscripten";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const browserLibrary = readFileSync(require.resolve("core-js-bundle/minified.js"), "utf8");

const HARDEN_PLAYER_REALM = `
for (const value of [
  Function,
  (async function() {}).constructor,
  (function*() {}).constructor,
]) {
  Object.defineProperty(value.prototype, "constructor", {
    value: undefined,
    writable: false,
    configurable: false,
  });
}
for (const name of [
  "eval",
  "Function",
  "XMLHttpRequest",
  "WebSocket",
  "Worker",
  "SharedWorker",
]) {
  Object.defineProperty(globalThis, name, {
    value: undefined,
    writable: false,
    configurable: false,
  });
}
`;

process.stdin.setEncoding("utf8");
let input = "";
for await (const bytes of process.stdin) {
  input += bytes.toString();
  if (Buffer.byteLength(input) > 13 * 1024 * 1024) process.exit(1);
}
const { script, values } = JSON.parse(input);
try {
  // QuickJS has no host objects or filesystem/network APIs. The bundled
  // standard library supplies URL and URLSearchParams inside that interpreter.
  const runtime = await getQuickJS();
  const deadline = Date.now() + 900;
  const result = runtime.evalCode(`
    ${browserLibrary}
    ${HARDEN_PLAYER_REALM}
    for (const [name, value, absent] of ${JSON.stringify(values)}) {
      Object.defineProperty(globalThis, name, { value: absent ? undefined : value });
    }
    const result = (function() {\n${script}\n})();
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new Error("invalid result");
    }
    const output = {};
    for (const name of ["n", "sig"]) {
      const value = Reflect.get(result, name);
      if (value !== undefined) {
        if (typeof value !== "string" || value.length > 16 * 1024 || /["\\\\\\u0000-\\u001f\\u007f\\u2028\\u2029]/u.test(value)) {
          throw new Error("invalid result");
        }
        output[name] = value;
      }
    }
    JSON.stringify(output);
  `, {
    memoryLimitBytes: 32 * 1024 * 1024,
    maxStackSizeBytes: 512 * 1024,
    shouldInterrupt: () => Date.now() >= deadline,
  });
  if (typeof result !== "string") throw new Error("invalid result");
  process.stdout.write(result);
} catch {
  process.exitCode = 1;
}
