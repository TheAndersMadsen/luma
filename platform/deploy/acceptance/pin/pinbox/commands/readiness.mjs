// commands/readiness.mjs — in-process device readiness + agentic-gate check.
// Reuses the exported collectors from agentic-release-smoke.mjs and the pure
// assessAgenticGate from shared/evidence.mjs. No separate script of its own.

import { assessAgenticGate } from "../shared/evidence.mjs";
import {
  EXPECTED_PIN_SERIAL_ENV,
  resolveExpectedDeviceSerial,
} from "../../../pin/device-target-guard.mjs";

export function buildReadinessDeviceOptions(common, environment = process.env) {
  return {
    serial: common.serial,
    expectedPinSerial: resolveExpectedDeviceSerial({
      environment,
      environmentName: EXPECTED_PIN_SERIAL_ENV,
      label: "AI Pin serial",
    }),
    adbPath: common.adb ?? "adb",
  };
}

export async function run({ common, passthrough, ctx }) {
  const { out, err } = ctx;
  if (passthrough.length > 0) {
    err(`pinbox readiness: unexpected args: ${passthrough.join(" ")}\n`);
    return 2;
  }
  if (!common.serial) {
    err("pinbox readiness: --serial is required\n");
    return 2;
  }
  const { verifyExplicitDevice, collectReadiness, readAdminToken } = await import(
    "../../agentic-release-smoke.mjs"
  );
  if (common.tokenFile !== undefined) {
    process.env.PENUMBRA_PIN_ADMIN_TOKEN_FILE = common.tokenFile;
  }
  let options;
  try {
    options = buildReadinessDeviceOptions(common);
  } catch (e) {
    err(`pinbox readiness: ${String(e?.message ?? e)}\n`);
    return 1;
  }
  let token;
  try {
    token = await readAdminToken();
  } catch (e) {
    err(`pinbox readiness: ${String(e?.message ?? e)}\n`);
    return 1;
  }
  try {
    await verifyExplicitDevice(options);
  } catch (e) {
    err(`pinbox readiness: ${String(e?.message ?? e)}\n`);
    return 1;
  }
  let readiness;
  try {
    readiness = await collectReadiness(options, token);
  } catch (e) {
    readiness = { error: String(e?.message ?? e) };
  }
  const gate = assessAgenticGate(readiness);
  const result = { readiness, agenticGate: gate };
  if (common.json) {
    out(JSON.stringify(result, null, 2) + "\n");
  } else {
    const lines = ["readiness:"];
    if (readiness?.settings) {
      lines.push("  provider authority : cosmos");
      lines.push("  Pin provider keys  : none");
    } else {
      lines.push(`  settings: unavailable (${readiness?.error ?? "no settings"})`);
    }
    if (gate.warn) lines.push(`  WARN: ${gate.warn}`);
    out(lines.join("\n") + "\n");
  }
  return 0;
}
