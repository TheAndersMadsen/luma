import { spawn } from "node:child_process";
import { join } from "node:path";
import { Platform } from "youtubei.js";

const MAX_PLAYER_SCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_PLAYER_VALUE_CHARACTERS = 16 * 1024;
const PLAYER_SCRIPT_TIMEOUT_MILLISECONDS = 1_000;
const PLAYER_ENVIRONMENT_NAMES = new Set(["n", "sig", "sp"]);
const UNSAFE_PLAYER_VALUE_PATTERN = /["\\\u0000-\u001f\u007f\u2028\u2029]/u;

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
): Promise<Record<string, string | undefined>> {
  if (
    typeof data.output !== "string" ||
    data.output.length === 0 ||
    Buffer.byteLength(data.output, "utf8") > MAX_PLAYER_SCRIPT_BYTES
  ) {
    throw new Error("YouTube player script was invalid");
  }

  const values = checkedEnvironment(environment);
  // A process boundary makes the deadline effective even for CPU-bound code
  // or result getters. Only the small player inputs cross it, never credentials.
  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, [
      '--no-env-file', join(process.cwd(), 'runtime', 'youtube-player-worker.mjs'),
    ], {
      env: { NODE_ENV: 'production', DO_NOT_TRACK: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '';
    let failure: Error | null = null;
    const stop = (message: string) => {
      failure ??= new Error(message);
      worker.kill('SIGKILL');
    };
    const deadline = setTimeout(() => stop('YouTube player evaluation timed out'), PLAYER_SCRIPT_TIMEOUT_MILLISECONDS);
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output) > 256 * 1024) stop('YouTube player result was invalid');
    });
    worker.on('error', () => { failure = new Error('YouTube player evaluator could not start'); });
    worker.stdin.on('error', () => { stop('YouTube player evaluator could not receive input'); });
    worker.on('close', (code) => {
      clearTimeout(deadline);
      if (failure || code !== 0) {
        reject(failure ?? new Error('YouTube player evaluation failed'));
        return;
      }
      try {
        // Interpreter output is untrusted, even after its own serialization.
        const result: unknown = JSON.parse(output);
        if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error();
        const validated: Record<string, string | undefined> = {};
        for (const name of ['n', 'sig']) {
          const value = (result as Record<string, unknown>)[name];
          if (value === undefined) continue;
          if (typeof value !== 'string' || value.length > MAX_PLAYER_VALUE_CHARACTERS ||
              UNSAFE_PLAYER_VALUE_PATTERN.test(value)) throw new Error();
          validated[name] = value;
        }
        resolve(validated);
      } catch {
        reject(new Error('YouTube player result was invalid'));
      }
    });
    worker.stdin.end(JSON.stringify({ script: data.output, values: values.map(([name, value]) => [name, value, value === undefined]) }));
  });
}

export function configureYoutubePlayerEvaluator(): void {
  Platform.shim.eval = evaluateYoutubePlayerScript;
}
