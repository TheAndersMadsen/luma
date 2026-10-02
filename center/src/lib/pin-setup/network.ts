/**
 * Network & time: what a Pin needs before anything else can reach your Luma.
 *
 * A stock Pin can arrive with Wi-Fi off and its clock stuck near Humane's
 * shutdown (the owner's own Pin read 18 February 2025 in September 2026). A
 * clock that far behind makes every certificate your server issued look "not
 * yet valid", so activation, status reports, and the assistant all fail with no
 * clue why. Stock Android fixes the clock itself over NTP within seconds of
 * joining a network it has validated, so the order here is:
 *
 *   Wi-Fi on → join a network → Android validates it → compare the Pin's clock
 *   with Center's → set it with `cmd alarm set-time` only if NTP has not.
 *
 * Everything runs over the USB ADB session as the shell user, which may do all
 * of it without root. The Wi-Fi password travels to the Pin on the command's
 * standard input and never inside a command string, so it cannot surface in an
 * ADB error, a timeout message, a log line, or anything sent to the server.
 *
 * Framework-free like the rest of this directory: the device is anything with
 * `shell` (and `shellWithInput` for joining), and time and sleeping are
 * injectable so the waits are testable.
 */

import type { ShellResult } from "@/lib/pin-device/adb/transport";
import { shellCommand } from "@/lib/pin-device/adb/shellQuote";

/** The part of the USB session reading and changing network state needs. */
export interface PinShell {
  shell(command: string | readonly string[]): Promise<ShellResult>;
}

/** Joining a network also needs standard input, for the password. */
export interface PinShellWithInput extends PinShell {
  shellWithInput(command: string | readonly string[], input: Blob): Promise<ShellResult>;
}

/** The security types `cmd wifi connect-network` accepts. */
export type WifiSecurity = "open" | "owe" | "wpa2" | "wpa3";

export interface WifiNetwork {
  readonly ssid: string;
  /** `null` when Center cannot join it from here (enterprise or WEP). */
  readonly security: WifiSecurity | null;
  readonly signal: "Strong" | "Good" | "Fair" | "Weak";
  readonly rssi: number;
}

/** What the Pin's own Wi-Fi and connectivity services say, read over USB. */
export interface PinNetworkReading {
  readonly wifiEnabled: boolean | null;
  /** The network the Pin's Wi-Fi is associated with, when it says. */
  readonly wifiNetwork: string | null;
  /** Android has validated a network (Wi-Fi or mobile data) as reaching the internet. */
  readonly online: boolean;
  readonly transport: "wifi" | "cellular" | null;
}

export interface PinClockReading {
  /** The Pin's clock, epoch milliseconds. */
  readonly pinTimeEpochMs: number;
  /** The Pin's clock minus Center's clock. Positive means the Pin is ahead. */
  readonly skewMs: number;
}

/** Center's own time, estimated from its HTTP `Date` header. */
export interface CenterClock {
  now(): number;
}

/** Clock and sleep, injectable so every wait can be tested without waiting. */
export interface NetworkTiming {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** An error whose message is already written for the owner. */
export class PinNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinNetworkError";
  }
}

/** The Pin joined a network, but Android never confirmed it reaches the internet. */
export class PinNetworkUnconfirmedError extends PinNetworkError {
  constructor(message: string) {
    super(message);
    this.name = "PinNetworkUnconfirmedError";
  }
}

/**
 * How far the Pin's clock may drift from Center's before Center sets it.
 * Certificates care about days and status reports about ten minutes. A minute
 * leaves NTP room to finish without Center fighting it.
 */
export const CLOCK_TOLERANCE_MS = 60_000;

const defaultTiming: NetworkTiming = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const READ_FAILURE = "Center couldn’t read the Pin’s network. Check that it is still connected, then try again.";

/* -------------------------------------------------------------- parsing -- */

/** `cmd wifi status`: whether the radio is on and which network it joined. */
export function parseWifiStatus(stdout: string): {
  enabled: boolean | null;
  ssid: string | null;
} {
  const enabled = /^Wi-?Fi is enabled\b/imu.test(stdout)
    ? true
    : /^Wi-?Fi is disabled\b/imu.test(stdout)
      ? false
      : null;
  const connected = /^Wi-?Fi is connected to "(.*)"\s*$/imu.exec(stdout);
  return { enabled, ssid: connected?.[1] ?? null };
}

/**
 * The `NetworkAgentInfo` lines of `dumpsys connectivity`.
 *
 * A network counts only when it is CONNECTED and Android's own validation
 * passed (`IS_VALIDATED` in its policies, `lastValidated` in its flags): the
 * same check that decides whether the Pin's apps think they are online.
 */
export function parseValidatedNetworks(stdout: string): {
  online: boolean;
  transport: "wifi" | "cellular" | null;
} {
  let cellular = false;
  let other = false;
  for (const line of stdout.split("\n")) {
    if (!line.includes("NetworkAgentInfo")) continue;
    const kind = /\bni\{([A-Z_]+)(?:\[[^\]]*\])?\s+CONNECTED\b/u.exec(line)?.[1];
    if (!kind || !/\bIS_VALIDATED\b|\blastValidated\b/u.test(line)) continue;
    if (kind === "WIFI") return { online: true, transport: "wifi" };
    if (kind === "MOBILE") cellular = true;
    else other = true;
  }
  if (cellular) return { online: true, transport: "cellular" };
  return { online: other, transport: null };
}

/** `date +%s%3N`, or plain seconds on a toybox that ignores `%3N`. */
export function parsePinClock(stdout: string): number | null {
  const text = stdout.trim();
  const millis = /^(\d{12,14})$/u.exec(text);
  if (millis) return Number(millis[1]);
  const seconds = /^(\d{9,11})(?!\d)/u.exec(text);
  return seconds ? Number(seconds[1]) * 1000 : null;
}

function securityFromFlags(flags: string): WifiSecurity | null {
  if (/WEP|EAP|802\.1X|SUITE[_-]?B/iu.test(flags) && !/PSK|SAE/iu.test(flags)) return null;
  if (/PSK/iu.test(flags)) return "wpa2";
  if (/SAE/iu.test(flags)) return "wpa3";
  if (/OWE/iu.test(flags)) return "owe";
  return "open";
}

function signalFromRssi(rssi: number): WifiNetwork["signal"] {
  if (rssi >= -55) return "Strong";
  if (rssi >= -67) return "Good";
  if (rssi >= -78) return "Fair";
  return "Weak";
}

const SCAN_ROW =
  /^\s*[0-9a-f]{2}(?::[0-9a-f]{2}){5}\s+\d+\s+(-?\d+)(?:\([^)]*\))?\s+\S+\s+(.*?)\s*((?:\[[^\]]*\])*)\s*$/iu;

/**
 * `cmd wifi list-scan-results`, one entry per network name, strongest first.
 * Hidden networks have no name to show and are left to "Other network".
 */
export function parseScanResults(stdout: string): WifiNetwork[] {
  const strongest = new Map<string, WifiNetwork>();
  for (const line of stdout.split("\n")) {
    const row = SCAN_ROW.exec(line);
    if (!row) continue;
    const [, rssiText, ssid, flags = ""] = row;
    if (!ssid) continue;
    const rssi = Number(rssiText);
    const previous = strongest.get(ssid);
    if (previous && previous.rssi >= rssi) continue;
    strongest.set(ssid, {
      ssid,
      security: securityFromFlags(flags),
      signal: signalFromRssi(rssi),
      rssi,
    });
  }
  return [...strongest.values()].sort((left, right) => right.rssi - left.rssi);
}

/* ------------------------------------------------------------ describing -- */

const DATE_FORMAT = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** The clock's error in words: "set to February 18, 2025" or "5 minutes behind". */
export function describeClockSkew(skewMs: number, pinTimeEpochMs: number): string {
  const size = Math.abs(skewMs);
  const direction = skewMs < 0 ? "behind" : "ahead";
  if (size >= 24 * 60 * 60 * 1000) return `set to ${DATE_FORMAT.format(pinTimeEpochMs)}`;
  if (size >= 2 * 60 * 60 * 1000) return `${plural(Math.round(size / 3_600_000), "hour")} ${direction}`;
  return `${plural(Math.max(1, Math.round(size / 60_000)), "minute")} ${direction}`;
}

/* ------------------------------------------------------------ the device -- */

async function run(
  device: PinShell,
  command: string | readonly string[],
  failure: string,
  acceptedExitCodes: readonly number[] = [0],
): Promise<string> {
  let result: ShellResult;
  try {
    result = await device.shell(command);
  } catch {
    throw new PinNetworkError(failure);
  }
  if (!acceptedExitCodes.includes(result.exitCode)) throw new PinNetworkError(failure);
  return result.stdout;
}

/** Wi-Fi state and whether Android has validated any network. */
export async function readPinNetwork(device: PinShell): Promise<PinNetworkReading> {
  // `grep` exits 1 when no network is listed at all, which is an answer.
  const [status, connectivity] = await Promise.all([
    run(device, "cmd wifi status", READ_FAILURE),
    run(device, "dumpsys connectivity | grep NetworkAgentInfo", READ_FAILURE, [0, 1]),
  ]);
  const wifi = parseWifiStatus(status);
  const validated = parseValidatedNetworks(connectivity);
  return {
    wifiEnabled: wifi.enabled,
    wifiNetwork: wifi.ssid,
    online: validated.online,
    transport: validated.transport,
  };
}

/**
 * Center's clock from the `Date` header of its own public version endpoint.
 * The header has one-second resolution and is stamped roughly halfway through
 * the round trip, which is far inside {@link CLOCK_TOLERANCE_MS}.
 */
export async function readCenterClock(
  fetchImpl: typeof fetch = fetch,
  localNow: () => number = Date.now,
): Promise<CenterClock> {
  const started = localNow();
  let header: string | null = null;
  try {
    const response = await fetchImpl("/api/version", { cache: "no-store" });
    header = response.headers.get("date");
  } catch {
    // Reported below with the same sentence as a missing header.
  }
  const finished = localNow();
  const stamped = header ? Date.parse(header) : Number.NaN;
  if (!Number.isFinite(stamped)) {
    throw new PinNetworkError("Center couldn’t read its own clock. Try again in a moment.");
  }
  const offset = stamped + 500 - (started + finished) / 2;
  return { now: () => localNow() + offset };
}

export async function readPinClock(
  device: PinShell,
  center: CenterClock,
): Promise<PinClockReading> {
  const before = center.now();
  const stdout = await run(device, "date +%s%3N", "Center couldn’t read the Pin’s clock. Try again.");
  const after = center.now();
  const pinTimeEpochMs = parsePinClock(stdout);
  if (pinTimeEpochMs === null) {
    throw new PinNetworkError("Center couldn’t read the Pin’s clock. Try again.");
  }
  return { pinTimeEpochMs, skewMs: pinTimeEpochMs - (before + after) / 2 };
}

/** Turn the radio on and wait until Android says it is on. */
export async function turnOnWifi(
  device: PinShell,
  timing: NetworkTiming = defaultTiming,
  timeoutMs = 15_000,
): Promise<void> {
  const failure = "The Pin’s Wi-Fi didn’t turn on. Restart the Pin, then try again.";
  await run(device, "svc wifi enable", failure);
  const deadline = timing.now() + timeoutMs;
  for (;;) {
    const status = parseWifiStatus(await run(device, "cmd wifi status", READ_FAILURE));
    if (status.enabled === true) return;
    if (timing.now() >= deadline) throw new PinNetworkError(failure);
    await timing.sleep(1_000);
  }
}

/** Ask for a fresh scan and read what the Pin can see. */
export async function scanWifiNetworks(
  device: PinShell,
  timing: NetworkTiming = defaultTiming,
): Promise<WifiNetwork[]> {
  const failure = "Center couldn’t list the networks your Pin can see. Try again.";
  // A refused or throttled scan still leaves Android's recent results to list.
  await device.shell("cmd wifi start-scan").catch(() => undefined);
  let networks: WifiNetwork[] = [];
  for (let attempt = 0; attempt < 4 && networks.length === 0; attempt += 1) {
    await timing.sleep(attempt === 0 ? 3_000 : 2_000);
    networks = parseScanResults(await run(device, "cmd wifi list-scan-results", failure));
  }
  return networks;
}

/**
 * Poll until Android validates a network. With `ssid`, only that Wi-Fi network
 * counts, so mobile data coming up meanwhile is not mistaken for success.
 */
export async function waitForOnline(
  device: PinShell,
  options: { ssid?: string; timeoutMs: number },
  timing: NetworkTiming = defaultTiming,
): Promise<PinNetworkReading> {
  const deadline = timing.now() + options.timeoutMs;
  for (;;) {
    const reading = await readPinNetwork(device);
    const satisfied = options.ssid === undefined
      ? reading.online
      : reading.online && reading.transport === "wifi" && reading.wifiNetwork === options.ssid;
    if (satisfied || timing.now() >= deadline) return reading;
    await timing.sleep(2_000);
  }
}

export interface JoinWifiRequest {
  readonly ssid: string;
  readonly security: WifiSecurity;
  readonly password: string;
  readonly hidden: boolean;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Why a network name or password cannot be sent, in the owner's words. */
export function validateJoinRequest(request: JoinWifiRequest): {
  ssid?: string;
  password?: string;
} {
  const errors: { ssid?: string; password?: string } = {};
  const { ssid, password } = request;
  if (!ssid.trim()) errors.ssid = "Enter a network name.";
  else if (new TextEncoder().encode(ssid).length > 32) errors.ssid = "Use 32 characters or fewer.";
  else if (hasControlCharacter(ssid)) errors.ssid = "Remove line breaks and control characters.";

  if (request.security === "wpa2" || request.security === "wpa3") {
    if (!password) errors.password = "Enter the Wi-Fi password.";
    else if (password.length < 8) errors.password = "Use at least 8 characters.";
    else if (password.length > 63) errors.password = "Use 63 characters or fewer.";
    else if (hasControlCharacter(password)) errors.password = "Remove line breaks and control characters.";
  }
  return errors;
}

/**
 * The on-device half of joining. The network name, security type, hidden flag,
 * and password arrive on standard input, one per line. The command string never
 * changes, so nothing the owner typed can be read back from it.
 */
export const JOIN_WIFI_COMMAND =
  'IFS= read -r ssid && IFS= read -r security && IFS= read -r hidden && IFS= read -r psk || exit 64; case "$hidden" in yes) set -- -h ;; no) set -- ;; *) exit 64 ;; esac; case "$security" in open|owe) exec cmd wifi connect-network "$ssid" "$security" "$@" ;; wpa2|wpa3) exec cmd wifi connect-network "$ssid" "$security" "$psk" "$@" ;; esac; exit 64';

/**
 * Join a network over USB and wait for Android to validate it.
 *
 * Android saves the network like any other, so the Pin rejoins it by itself
 * after a restart. Center keeps nothing: the password exists only in the
 * browser tab that sent it and on the Pin.
 */
export async function joinWifiNetwork(
  device: PinShellWithInput,
  request: JoinWifiRequest,
  timing: NetworkTiming = defaultTiming,
  timeoutMs = 45_000,
): Promise<PinNetworkReading> {
  const problems = validateJoinRequest(request);
  const problem = problems.ssid ?? problems.password;
  if (problem) throw new PinNetworkError(problem);

  const name = `“${request.ssid}”`;
  const needsPassword = request.security === "wpa2" || request.security === "wpa3";
  const input = [
    request.ssid,
    request.security,
    request.hidden ? "yes" : "no",
    needsPassword ? request.password : "",
  ].join("\n") + "\n";

  let started: ShellResult;
  try {
    started = await device.shellWithInput(JOIN_WIFI_COMMAND, new Blob([input], { type: "text/plain" }));
  } catch {
    throw new PinNetworkError(`Your Pin couldn’t start joining ${name}. Check that it is still connected, then try again.`);
  }
  if (started.exitCode !== 0 || /Connection failed/iu.test(started.stdout)) {
    throw new PinNetworkError(`Your Pin couldn’t start joining ${name}. Check the network name and security, then try again.`);
  }

  const reading = await waitForOnline(device, { ssid: request.ssid, timeoutMs }, timing);
  if (reading.online && reading.transport === "wifi" && reading.wifiNetwork === request.ssid) {
    return reading;
  }
  if (reading.wifiNetwork === request.ssid) {
    throw new PinNetworkUnconfirmedError(
      `Your Pin joined ${name}, but that network doesn’t reach the internet. Check the router, or choose another network.`,
    );
  }
  throw new PinNetworkError(
    needsPassword
      ? `Your Pin couldn’t join ${name}. Check the password and try again.`
      : `Your Pin couldn’t join ${name}. Move it closer to the router and try again.`,
  );
}

/**
 * Make the Pin's clock agree with Center's.
 *
 * NTP gets the first chance, because on a validated network stock Android
 * corrects the clock by itself within seconds. Center sets the time only when
 * the clock is still off after `waitMs`, and then checks that it took.
 */
export async function settlePinClock(
  device: PinShell,
  center: CenterClock,
  timing: NetworkTiming = defaultTiming,
  waitMs = 20_000,
): Promise<{ skewMs: number; adjusted: boolean }> {
  let reading = await readPinClock(device, center);
  const deadline = timing.now() + waitMs;
  while (Math.abs(reading.skewMs) > CLOCK_TOLERANCE_MS && timing.now() < deadline) {
    await timing.sleep(2_000);
    reading = await readPinClock(device, center);
  }
  if (Math.abs(reading.skewMs) <= CLOCK_TOLERANCE_MS) {
    return { skewMs: reading.skewMs, adjusted: false };
  }

  await run(
    device,
    shellCommand(["cmd", "alarm", "set-time", String(Math.round(center.now()))]),
    "Center couldn’t set the Pin’s clock. Restart the Pin, then try again.",
  );
  reading = await readPinClock(device, center);
  if (Math.abs(reading.skewMs) > CLOCK_TOLERANCE_MS) {
    throw new PinNetworkError("The Pin’s clock is still wrong after Center set it. Restart the Pin, then try again.");
  }
  return { skewMs: reading.skewMs, adjusted: true };
}

/**
 * Get Android to confirm a Wi-Fi network the Pin joined but Android has not
 * confirmed.
 *
 * Android confirms a network over HTTPS, and a clock stuck in the past fails
 * that check on every network. NTP normally corrects the clock within seconds
 * of joining. On a network that blocks NTP it cannot, and the Pin would sit on
 * Wi-Fi that never counts as online. The caller has already waited, so NTP has
 * had its chance: Center sets the clock at once and gives Android another look.
 * A clock that was already right is left alone, because then the network
 * itself is the problem.
 */
export async function confirmNetworkWithRightClock(
  device: PinShell,
  center: CenterClock,
  ssid: string,
  timing: NetworkTiming = defaultTiming,
  timeoutMs = 60_000,
): Promise<{ adjusted: boolean; confirmed: boolean }> {
  const { adjusted } = await settlePinClock(device, center, timing, 0);
  if (!adjusted) return { adjusted, confirmed: false };
  const reading = await waitForOnline(device, { ssid, timeoutMs }, timing);
  return {
    adjusted,
    confirmed: reading.online && reading.transport === "wifi" && reading.wifiNetwork === ssid,
  };
}
