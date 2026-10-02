// render.mjs, presentation only (help / list / version). No dispatch, no I/O
// beyond the injected sink. (SRP: the orchestrator decides. This just formats.)

import { CATEGORIES, COMMANDS, VERSION } from "./registry.mjs";

export function renderHelp(ctx) {
  const out = [];
  out.push(`pinbox v${VERSION} — unified Penumbra test CLI`);
  out.push("");
  out.push("usage: pinbox <command> [common flags] [tool-specific flags]");
  out.push("       pinbox help | list [--json] | version");
  out.push("");
  out.push("common flags: --serial <S>  --adb <PATH>  --json  --token-file <PATH>  --verbose  (rest pass through)");
  out.push("");
  for (const cat of CATEGORIES) {
    out.push(cat);
    for (const c of COMMANDS.filter((c) => c.category === cat)) {
      out.push(`  ${c.name.padEnd(18)} ${c.summary}`);
    }
    out.push("");
  }
  out.push("Each shell-out command maps to an existing tool in tools/ and runs it verbatim.");
  out.push("In-process commands (probe, readiness) run their own engine in this process.");
  out.push("Per-command help is the tool's own --help where the tool supports it.");
  ctx.out(out.join("\n") + "\n");
}

export function renderListJson(ctx) {
  const rows = COMMANDS.map((c) => ({
    name: c.name,
    category: c.category,
    file: c.file,
    summary: c.summary,
    serial: c.serial,
    adb: c.adb,
    json: c.json,
    inProcess: Boolean(c.inProcess),
  }));
  ctx.out(JSON.stringify(rows, null, 2) + "\n");
}

export function renderVersion(ctx) {
  ctx.out(`pinbox v${VERSION}\ntools dir: ${import.meta.dirname ?? ""}\n`);
}
