// registry.mjs, the command table. Pure data + one lookup. (Information
// Expert: the registry owns the command set and which tool each maps to.)
//
// `serial`/`adb`/`json`/`tokenFile` are the NATIVE flag string a normalized
// common value maps to for a shell-out command, or null if that tool does not
// take it. `inProcess` commands consume common values directly (no native
// flags) and are loaded lazily from `runModule`.

export const VERSION = 1;

export const COMMANDS = [
  {
    name: "smoke",
    category: "Prompt / Agentic",
    file: "agentic-release-smoke.mjs",
    summary: "Release smoke: installed-identity + safe AIBus Understand probe (fixed fixtures).",
    serial: "--serial", adb: null, json: "--json", tokenFile: null,
  },
  {
    name: "bridge",
    category: "Transport / Infra",
    file: "center-adb-http-bridge.mjs",
    summary: "Host TCP→adb→device loopback HTTP proxy (127.0.0.1:8080).",
    serial: "--serial", adb: "--adb", json: null, tokenFile: null,
  },
  {
    name: "remote-acceptance",
    category: "Transport / Infra",
    file: "remote-center-acceptance.mjs",
    summary: "Remote Center protocol acceptance (stdin-driven).",
    serial: null, adb: null, json: null, tokenFile: null,
  },
  {
    name: "readiness",
    category: "Transport / Infra",
    file: null,
    inProcess: true,
    runModule: "./commands/readiness.mjs",
    summary: "In-process: verify device + collectReadiness + agentic-gate assessment.",
    serial: "--serial", adb: null, json: "--json", tokenFile: null,
  },
];

export const CATEGORIES = [...new Set(COMMANDS.map((c) => c.category))];

export function resolveCommand(name) {
  return COMMANDS.find((c) => c.name === name) ?? null;
}
