// registry.mjs — the command table. Pure data + one lookup. (Information
// Expert: the registry owns the command set and which tool each maps to.)
//
// `serial`/`adb`/`json`/`tokenFile` are the NATIVE flag string a normalized
// common value maps to for a shell-out command, or null if that tool does not
// take it. `inProcess` commands consume common values directly (no native
// flags) and are loaded lazily from `runModule`.

export const VERSION = 1;

export const COMMANDS = [
  {
    name: "probe",
    category: "Prompt / Agentic",
    file: null,
    inProcess: true,
    runModule: "./commands/probe.mjs",
    summary: "One phrase → full evidence bundle (plan/tools/answer/logcat/server-logs/activity). Safe by default; --dispatch for real.",
    serial: "--serial", adb: "--adb-path", json: "--json", tokenFile: null,
  },
  {
    name: "eval",
    category: "Prompt / Agentic",
    file: "prompt-eval.mjs",
    summary: "Repeated A/B latency + behavioural-suite scorer. Safe (never dispatches).",
    serial: "--serial", adb: "--adb-path", json: "--json", tokenFile: null,
  },
  {
    name: "smoke",
    category: "Prompt / Agentic",
    file: "agentic-release-smoke.mjs",
    summary: "Release smoke: installed-identity + safe AIBus Understand probe (fixed fixtures).",
    serial: "--serial", adb: null, json: "--json", tokenFile: null,
  },
  {
    name: "matrix",
    category: "Prompt / Agentic",
    file: "agentic-prompt-matrix.mjs",
    summary: "Pin-local echo compatibility matrix; not a Cosmos or release gate.",
    serial: "--serial", adb: "--adb", json: "--json", tokenFile: null,
  },
  {
    name: "physical",
    category: "Physical (real dispatch — device state changes)",
    file: "physical-prompt-harness.mjs",
    summary: "Full physical prompt harness: real dispatch + logcat evidence (scripted cases).",
    serial: "--serial", adb: "--adb", json: "--json", tokenFile: null,
  },
  {
    name: "speech",
    category: "Physical (real dispatch — device state changes)",
    file: "speech-physical-smoke.mjs",
    summary: "Speech/TTS lifecycle smoke (logcat: PenumbraHook/Server/TTS/AudioFocus).",
    serial: "--serial", adb: "--adb", json: "--json", tokenFile: null,
  },
  {
    name: "continuity",
    category: "Physical (real dispatch — device state changes)",
    file: "session-continuity-physical-smoke.mjs",
    summary: "Session follow-up/reset/recovery smoke.",
    serial: "--serial", adb: "--adb", json: "--json", tokenFile: null,
  },
  {
    name: "cmu",
    category: "Physical (real dispatch — device state changes)",
    file: "android-cmu-physical-smoke.mjs",
    summary: "CMU companion physical smoke (uses --pin-serial/--pixel-serial natively).",
    serial: null, adb: null, json: null, tokenFile: null,
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
