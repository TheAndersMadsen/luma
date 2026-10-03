"use client";

/**
 * Guided setup → Network & time.
 *
 * Gets the connected Pin online and its clock right over the USB session, in
 * the order the Pin needs: Wi-Fi on, a network Android validates, then the
 * clock. Stock NTP normally fixes the clock seconds after the Pin is online;
 * Center sets it only when NTP has not.
 *
 * The Wi-Fi password lives in this component's state and goes to the Pin over
 * USB on the command's standard input. It is never sent to Center's server,
 * never stored, and never part of a command string, an error, or a log line.
 */

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import settings from "../../settings.module.css";
import pin from "../pin.module.css";
import styles from "./setup.module.css";
import { StatusMessage } from "@/components/Status";
import {
  CLOCK_TOLERANCE_MS,
  PinNetworkError,
  PinNetworkUnconfirmedError,
  confirmNetworkWithRightClock,
  joinWifiNetwork,
  readCenterClock,
  scanWifiNetworks,
  settlePinClock,
  turnOnWifi,
  validateJoinRequest,
  waitForOnline,
  type NetworkTiming,
  type PinSetupNetworkFacts,
  type PinShellWithInput,
  type WifiNetwork,
  type WifiSecurity,
} from "@/lib/pin-setup";

type Choice = {
  readonly ssid: string;
  /** `null` for a network Center cannot join (enterprise or WEP). */
  readonly security: WifiSecurity | null;
  /** Typed by the owner rather than picked from the scan. */
  readonly other: boolean;
};

const SECURITY_LABEL: Record<WifiSecurity, string> = {
  wpa2: "Password",
  wpa3: "Password (WPA3)",
  owe: "Open (encrypted)",
  open: "Open",
};

function needsPassword(security: WifiSecurity | null): boolean {
  return security === "wpa2" || security === "wpa3";
}

function ownerMessage(failure: unknown): string {
  return failure instanceof PinNetworkError
    ? failure.message
    : "Center lost contact with the Pin. Check the cable, then try again.";
}

const REAL_TIME: NetworkTiming = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function NetworkTimePanel({
  network,
  device,
  onChanged,
  timing = REAL_TIME,
}: {
  network: PinSetupNetworkFacts;
  /** The shared USB session. Everything typed here travels only over it. */
  device: () => PinShellWithInput;
  /** Re-read the setup facts after the Pin's state changed. */
  onChanged: () => void;
  /** How long the waits take. Real time unless a test says otherwise. */
  timing?: NetworkTiming;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [networks, setNetworks] = useState<WifiNetwork[] | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [otherSsid, setOtherSsid] = useState("");
  const [otherSecurity, setOtherSecurity] = useState<WifiSecurity>("wpa2");
  const [hidden, setHidden] = useState(false);
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ ssid?: string; password?: string }>({});
  const scannedOnce = useRef(false);
  const passwordId = useId();

  async function act(work: () => Promise<void>) {
    if (busy) return;
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(ownerMessage(failure));
    } finally {
      setBusy(null);
    }
  }

  async function settleClock(session: PinShellWithInput) {
    setBusy("Checking the Pin’s clock…");
    await settlePinClock(session, await readCenterClock(), timing);
  }

  async function scan(session: PinShellWithInput) {
    setBusy("Looking for Wi-Fi networks near your Pin…");
    setNetworks(await scanWifiNetworks(session, timing));
  }

  // A clock stuck in the past fails Android's check on every network. When the
  // Pin joined but Android never confirmed it, set the clock and look again.
  async function confirmWithRightClock(session: PinShellWithInput, ssid: string) {
    setBusy("Checking the Pin’s clock…");
    const center = await readCenterClock();
    const result = await confirmNetworkWithRightClock(session, center, ssid, timing);
    if (result.adjusted && !result.confirmed) {
      onChanged();
      throw new PinNetworkError(
        `Center set the Pin’s clock, but Android hasn’t confirmed that “${ssid}” reaches the internet yet. Choose Check again in a minute, or choose another network.`,
      );
    }
    return result.confirmed;
  }

  const wifiOnButOffline = network.state === "read" && network.online === false && network.wifiEnabled !== false;

  // Offer the nearby networks straight away instead of asking for a click.
  // The ref makes this run once per mount, however often the facts refresh.
  useEffect(() => {
    if (!wifiOnButOffline || scannedOnce.current) return;
    scannedOnce.current = true;
    void act(() => scan(device()));
  }, [wifiOnButOffline]);

  const onTurnOnWifi = () =>
    act(async () => {
      const session = device();
      setBusy("Turning on Wi-Fi…");
      await turnOnWifi(session, timing);
      setBusy("Waiting to see whether the Pin rejoins a network it already knows…");
      const reading = await waitForOnline(session, { timeoutMs: 20_000 }, timing);
      const online =
        reading.online ||
        (reading.wifiNetwork !== null && (await confirmWithRightClock(session, reading.wifiNetwork)));
      if (online) {
        await settleClock(session);
      } else {
        scannedOnce.current = true;
        await scan(session);
      }
      onChanged();
    });

  const onSetClock = () =>
    act(async () => {
      await settleClock(device());
      onChanged();
    });

  const onJoin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!choice) return;
    const security = choice.other ? otherSecurity : choice.security;
    if (security === null) return;
    const request = {
      ssid: choice.other ? otherSsid : choice.ssid,
      security,
      password: needsPassword(security) ? password : "",
      hidden: choice.other && hidden,
    };
    const problems = validateJoinRequest(request);
    setFieldErrors(problems);
    if (problems.ssid || problems.password) return;

    void act(async () => {
      const session = device();
      setBusy(`Joining “${request.ssid}”. This can take up to a minute…`);
      try {
        await joinWifiNetwork(session, request, timing);
      } catch (failure) {
        if (!(failure instanceof PinNetworkUnconfirmedError)) throw failure;
        if (!(await confirmWithRightClock(session, request.ssid))) throw failure;
      }
      setPassword("");
      await settleClock(session);
      onChanged();
    });
  };

  const clockWrong =
    network.clockSkewMs !== null && Math.abs(network.clockSkewMs) > CLOCK_TOLERANCE_MS;
  const chosenSecurity = choice ? (choice.other ? otherSecurity : choice.security) : null;

  let body: React.ReactNode = null;
  if (network.state !== "read") {
    body = null;
  } else if (network.online && clockWrong) {
    body = (
      <div className={styles.actions}>
        <button type="button" className={pin.button} onClick={() => void onSetClock()}>
          Set the Pin’s clock
        </button>
      </div>
    );
  } else if (!network.online && network.wifiEnabled === false) {
    body = (
      <>
        <p className={pin.fieldHint}>
          Center turns Wi-Fi on over the USB cable. If the Pin already knows a
          network nearby, it joins by itself. Otherwise you choose one next.
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={pin.button}
            onClick={() => void onTurnOnWifi()}
            data-testid="pin-setup-wifi-on"
          >
            Turn on Wi-Fi
          </button>
        </div>
      </>
    );
  } else if (!network.online) {
    body = (
      <>
        {networks && networks.length > 0 ? (
          <ul className={styles.networkList} aria-label="Wi-Fi networks your Pin can see">
            {networks.map((candidate) => {
              const selected = choice?.other === false && choice.ssid === candidate.ssid;
              return (
                <li key={candidate.ssid}>
                  <button
                    type="button"
                    className={styles.networkOption}
                    aria-pressed={selected}
                    disabled={candidate.security === null}
                    onClick={() => {
                      setChoice({ ssid: candidate.ssid, security: candidate.security, other: false });
                      setFieldErrors({});
                    }}
                  >
                    <span className={styles.networkName}>{candidate.ssid}</span>
                    <span className={styles.networkMeta}>
                      {candidate.security === null
                        ? "Needs a username · not supported"
                        : `${SECURITY_LABEL[candidate.security]} · ${candidate.signal} signal`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : networks ? (
          <p className={pin.fieldHint}>
            Your Pin can’t see any Wi-Fi networks. Move it closer to your router, then scan again.
          </p>
        ) : null}

        <div className={styles.actions}>
          <button
            type="button"
            className={pin.buttonQuiet}
            onClick={() => void act(() => scan(device()))}
          >
            {networks ? "Scan again" : "Find networks"}
          </button>
          <button
            type="button"
            className={pin.buttonQuiet}
            aria-pressed={choice?.other === true}
            onClick={() => {
              setChoice({ ssid: "", security: null, other: true });
              setFieldErrors({});
            }}
          >
            Other network
          </button>
        </div>

        {choice ? (
          <form
            className={styles.networkForm}
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            data-form-type="other"
            onSubmit={onJoin}
            aria-label="Join a Wi-Fi network"
          >
            {choice.other ? (
              <div className={pin.fieldPair}>
                <label className={pin.field}>
                  <span className={pin.fieldLabel}>Network name</span>
                  <input
                    className={pin.fieldInput}
                    name="wifi-ssid"
                    value={otherSsid}
                    onChange={(event) => setOtherSsid(event.target.value)}
                    autoComplete="off"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-form-type="other"
                    aria-invalid={Boolean(fieldErrors.ssid)}
                  />
                  {fieldErrors.ssid ? <span className={styles.fieldError}>{fieldErrors.ssid}</span> : null}
                </label>
                <label className={pin.field}>
                  <span className={pin.fieldLabel}>Security</span>
                  <select
                    className={pin.fieldInput}
                    value={otherSecurity}
                    onChange={(event) => setOtherSecurity(event.target.value as WifiSecurity)}
                  >
                    <option value="wpa2">Password (most networks)</option>
                    <option value="wpa3">Password (WPA3 only)</option>
                    <option value="open">No password</option>
                  </select>
                </label>
              </div>
            ) : (
              <p className={styles.networkChosen}>{choice.ssid}</p>
            )}

            {needsPassword(chosenSecurity) ? (
              <div className={pin.field}>
                <label className={pin.fieldLabel} htmlFor={passwordId}>
                  Wi-Fi password
                </label>
                <span className={styles.passwordWrap}>
                  <input
                    id={passwordId}
                    className={pin.fieldInput}
                    name="wifi-network-key"
                    type={reveal ? "text" : "password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="new-password"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-form-type="other"
                    aria-invalid={Boolean(fieldErrors.password)}
                  />
                  <button
                    type="button"
                    className={pin.buttonQuiet}
                    aria-label={reveal ? "Hide password" : "Show password"}
                    onClick={() => setReveal((value) => !value)}
                  >
                    {reveal ? "Hide" : "Show"}
                  </button>
                </span>
                {fieldErrors.password ? (
                  <span className={styles.fieldError}>{fieldErrors.password}</span>
                ) : null}
              </div>
            ) : null}

            {choice.other ? (
              <label className={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={hidden}
                  onChange={(event) => setHidden(event.target.checked)}
                />
                <span>This network is hidden</span>
              </label>
            ) : null}

            <p className={pin.fieldHint}>
              The password goes from this browser to your Pin over the USB cable.
              It is not sent to your server or kept anywhere else.
            </p>
            <div className={styles.actions}>
              <button type="submit" className={pin.button} data-testid="pin-setup-wifi-join">
                Join network
              </button>
            </div>
          </form>
        ) : null}

        <Link className={settings.additionLink} href="/wifi">
          No cable? Make a Wi-Fi QR code instead
        </Link>
      </>
    );
  }

  return (
    <div className={styles.network} data-testid="pin-setup-network">
      {error ? (
        <StatusMessage tone="warning" inline>
          {error}
        </StatusMessage>
      ) : null}
      {busy ? (
        <p className={pin.busy} role="status">
          {busy}
        </p>
      ) : (
        body
      )}
    </div>
  );
}
