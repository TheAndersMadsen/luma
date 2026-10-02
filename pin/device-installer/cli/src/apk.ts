import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const APKANALYZER = process.env.APKANALYZER || "apkanalyzer";
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

export function parseApkApplicationId(output: string): string {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1 || !PACKAGE_NAME.test(lines[0]!)) {
    throw new Error(`Invalid APK application ID response: ${output.trim() || "no response"}`);
  }
  return lines[0]!;
}

/** Read an APK's manifest application ID without installing it. */
export async function getApkApplicationId(apkPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      APKANALYZER,
      ["manifest", "application-id", apkPath],
      { maxBuffer: 1024 * 1024 }
    );
    return parseApkApplicationId(stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to inspect APK manifest with ${APKANALYZER}: ${detail}. ` +
        "Set APKANALYZER to the Android SDK apkanalyzer executable."
    );
  }
}

export async function requireApkApplicationId(
  apkPath: string,
  expectedPackageName: string
): Promise<void> {
  const actual = await getApkApplicationId(apkPath);
  if (actual !== expectedPackageName) {
    throw new Error(
      `APK ${apkPath} has package ${actual}; expected ${expectedPackageName}`
    );
  }
}
