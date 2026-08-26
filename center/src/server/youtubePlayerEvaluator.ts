import { Script } from "node:vm";

import { JSDOM, VirtualConsole } from "jsdom";
import { Platform } from "youtubei.js";

const MAX_PLAYER_SCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_PLAYER_VALUE_CHARACTERS = 16 * 1024;
const PLAYER_SCRIPT_TIMEOUT_MILLISECONDS = 1_000;
const PLAYER_ENVIRONMENT_NAMES = new Set(["n", "sig", "sp"]);
const UNSAFE_PLAYER_VALUE_PATTERN = /["\\\u0000-\u001f\u007f\u2028\u2029]/u;
const HARDEN_PLAYER_REALM = new Script(`
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
`);

type PlayerScript = {
  output: string;
};

type PlayerEnvironmentValue = string | number | boolean | null | undefined;

function checkedEnvironment(
  environment: Record<string, PlayerEnvironmentValue>,
): Array<[string, PlayerEnvironmentValue]> {
  const values = Object.entries(environment);
  if (values.length > PLAYER_ENVIRONMENT_NAMES.size) {
    throw new Error("YouTube player environment was invalid");
  }
  for (const [name, value] of values) {
    if (
      !PLAYER_ENVIRONMENT_NAMES.has(name) ||
      (value !== null && value !== undefined && typeof value !== "string") ||
      (typeof value === "string" &&
        (value.length > MAX_PLAYER_VALUE_CHARACTERS ||
          UNSAFE_PLAYER_VALUE_PATTERN.test(value)))
    ) {
      throw new Error("YouTube player environment was invalid");
    }
  }
  return values;
}

export function evaluateYoutubePlayerScript(
  data: PlayerScript,
  environment: Record<string, PlayerEnvironmentValue>,
): Record<string, string | undefined> {
  if (
    typeof data.output !== "string" ||
    data.output.length === 0 ||
    Buffer.byteLength(data.output, "utf8") > MAX_PLAYER_SCRIPT_BYTES
  ) {
    throw new Error("YouTube player script was invalid");
  }

  const values = checkedEnvironment(environment);
  const dom = new JSDOM("", {
    url: "https://www.youtube.com/",
    runScripts: "outside-only",
    virtualConsole: new VirtualConsole(),
  });
  try {
    const context = dom.getInternalVMContext();
    HARDEN_PLAYER_REALM.runInContext(context, {
      timeout: PLAYER_SCRIPT_TIMEOUT_MILLISECONDS,
    });
    for (const [name, value] of values) {
      Object.defineProperty(dom.window, name, {
        configurable: true,
        value,
      });
    }
    const result = new Script(`(function() {\n${data.output}\n})()`, {
      filename: "youtube-player.js",
    }).runInContext(context, {
      timeout: PLAYER_SCRIPT_TIMEOUT_MILLISECONDS,
    });
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new Error("YouTube player result was invalid");
    }
    const output: Record<string, string | undefined> = {};
    for (const name of ["n", "sig"] as const) {
      const value = Reflect.get(result, name);
      if (value !== undefined) {
        if (
          typeof value !== "string" ||
          value.length > MAX_PLAYER_VALUE_CHARACTERS ||
          UNSAFE_PLAYER_VALUE_PATTERN.test(value)
        ) {
          throw new Error("YouTube player result was invalid");
        }
        output[name] = value;
      }
    }
    return output;
  } finally {
    dom.window.close();
  }
}

export function configureYoutubePlayerEvaluator(): void {
  Platform.shim.eval = evaluateYoutubePlayerScript;
}
