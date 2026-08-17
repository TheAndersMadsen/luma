// commands/readiness.mjs — in-process device readiness + agentic-gate check.
// Reuses the exported collectors from agentic-release-smoke.mjs and the pure
// assessAgenticGate from shared/evidence.mjs. No separate script of its own.

import { assessAgenticGate } from "../shared/evidence.mjs";

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
  const options = { serial: common.serial, adbPath: common.adb ?? "adb" };
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
    const llm = readiness?.settings?.llm;
    if (llm) {
      lines.push(`  provider           : ${llm.provider ?? "?"}`);
      lines.push(`  model              : ${llm.model ?? "?"}`);
      lines.push(`  tools.enabled      : ${llm.tools?.enabled ?? "?"}`);
      lines.push(`  codex_custom_active: ${llm.codex_custom_active ?? "?"}`);
      lines.push(`  has_api_key        : ${llm.has_api_key ?? "?"}`);
    } else {
      lines.push(`  settings: unavailable (${readiness?.error ?? "no llm settings"})`);
    }
    if (gate.warn) lines.push(`  WARN: ${gate.warn}`);
    out(lines.join("\n") + "\n");
  }
  return 0;
}
