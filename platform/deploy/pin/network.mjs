#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateDeviceSerial } from "../acceptance/pin/device-target-guard.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);

export class PinNetworkError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PinNetworkError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PinNetworkError(code, message);
}

function defaultRuntime() {
  return {
    environment: process.env,
    platform: process.platform,
    out: (text) => process.stdout.write(text),
    spawnSync,
  };
}

export function wifiPageUrl(environment = process.env) {
  const configured = environment.REVIVAL_PUBLIC_ORIGIN ?? "http://127.0.0.1:4000";
  let origin;
  try {
    origin = new URL(configured);
  } catch {
    fail("origin-invalid", "REVIVAL_PUBLIC_ORIGIN must be an HTTP(S) origin");
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    (origin.pathname !== "/" && origin.pathname !== "")
  ) {
    fail("origin-invalid", "REVIVAL_PUBLIC_ORIGIN must be an HTTP(S) origin without credentials or a path");
  }
  return new URL("/wifi", origin).toString();
}

function run(runtime, command, args) {
  const result = runtime.spawnSync(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.error?.code === "ENOENT") fail("command-missing", `${command} is required`);
  if (result.status !== 0) fail("command-failed", `${command} command failed`);
  return String(result.stdout ?? "");
}

function adb(runtime, serial, args) {
  return run(runtime, runtime.environment.ADB ?? "adb", ["-s", serial, ...args]);
}

function ensureExactPin(runtime, serial) {
  const selected = validateDeviceSerial(serial, "Pin serial");
  if (adb(runtime, selected, ["get-serialno"]).trim() !== selected) {
    fail("serial-mismatch", "connected device did not report the exact requested Pin serial");
  }
  return selected;
}

export function classifyWifiStatus(output) {
  const text = String(output);
  const enabled = /\bWi-?Fi is enabled\b/iu.test(text)
    ? true
    : /\bWi-?Fi is disabled\b/iu.test(text)
      ? false
      : null;
  const disconnected = /\b(?:not connected|disconnected|supplicant state:\s*(?:DISCONNECTED|INACTIVE|UNINITIALIZED))\b/iu.test(text);
  const connected = disconnected
    ? false
    : /\b(?:connected to|WifiInfo\b[\s\S]*supplicant state:\s*COMPLETED)\b/iu.test(text)
      ? true
      : null;
  return Object.freeze({ enabled, connected });
}

export function inspectPinNetwork(serial, runtime = defaultRuntime()) {
  const selected = ensureExactPin(runtime, serial);
  // `cmd wifi status` may carry an SSID or BSSID. It is classified in memory
  // and deliberately never echoed, logged, or returned to callers.
  const status = classifyWifiStatus(adb(runtime, selected, ["shell", "cmd", "wifi", "status"]));
  return Object.freeze({ serial: selected, enabled: status.enabled, connected: status.connected });
}

export function parseNetworkArgs(args) {
  const values = [...args];
  if (values[0] === "qr") {
    values.shift();
    let open = false;
    for (const value of values) {
      if (value === "--open" && !open) open = true;
      else fail("usage", "usage: pin network qr [--open]");
    }
    return Object.freeze({ command: "qr", open });
  }
  let serial = null;
  while (values.length > 0) {
    const option = values.shift();
    if (option === "--serial" && serial === null && values.length > 0) serial = values.shift();
    else {
      // There is intentionally no SSID/password/PSK option. Network secrets
      // belong in Center's browser-local QR generator, never in argv.
      fail("usage", "usage: pin network --serial SERIAL | pin network qr [--open]");
    }
  }
  if (!serial) fail("usage", "usage: pin network --serial SERIAL | pin network qr [--open]");
  return Object.freeze({ command: "status", serial: validateDeviceSerial(serial, "Pin serial") });
}

function openWifiPage(url, runtime) {
  const command = runtime.platform === "darwin" ? "open" : "xdg-open";
  run(runtime, command, [url]);
}

export function main(args = process.argv.slice(2), runtime = defaultRuntime()) {
  const options = parseNetworkArgs(args);
  const url = wifiPageUrl(runtime.environment);
  if (options.command === "qr") {
    runtime.out(
      `Wi-Fi QR setup: ${url}\n` +
      "The browser builds the QR locally. This command accepts no network name or passcode.\n",
    );
    if (options.open) openWifiPage(url, runtime);
    return Object.freeze({ url, opened: options.open });
  }

  const status = inspectPinNetwork(options.serial, runtime);
  const radio = status.enabled === null ? "unknown" : status.enabled ? "enabled" : "disabled";
  const connection = status.connected === null ? "unknown" : status.connected ? "connected" : "not connected";
  runtime.out(
    `Pin ${status.serial}: Wi-Fi ${radio}; network ${connection}.\n` +
    `To add a network without putting credentials in shell history, open ${url}\n` +
    "No Wi-Fi setting was changed.\n",
  );
  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF_PATH) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = error instanceof PinNetworkError && error.code === "usage" ? 64 : 1;
  }
}
