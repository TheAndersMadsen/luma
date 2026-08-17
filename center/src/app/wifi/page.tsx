"use client";

import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { CaretDown } from "@/icons";
import { PublicUtilityFrame } from "@/components/PublicUtilityFrame";
import settings from "@/app/settings/settings.module.css";
import styles from "./wifi.module.css";

/** Public, browser-local Wi-Fi QR generator rendered inside normal Center chrome. */
type Security = "WPA/WPA2/WPA3" | "None";

function WifiGlyph() {
  return (
    <svg viewBox="0 0 24 24" width={24} height={24} aria-hidden fill="none">
      <path d="M2 8.5C7.5 3.8 16.5 3.8 22 8.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M5.5 12.5C9.2 9.4 14.8 9.4 18.5 12.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M9 16.5C10.8 15 13.2 15 15 16.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="12" cy="20" r="1.4" fill="currentColor" />
    </svg>
  );
}

/** WIFI:T:<type>;S:<ssid>;P:<pass>;H:<hidden>;; — the standard payload. */
function wifiPayload(ssid: string, password: string, security: Security, hidden: boolean) {
  const t = security === "None" ? "nopass" : "WPA";
  const esc = (value: string) => value.replace(/([\\;,:\"])/g, "\\$1");
  return `WIFI:T:${t};S:${esc(ssid)};P:${security === "None" ? "" : esc(password)};H:${hidden};;`;
}

export default function WifiPage() {
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [security, setSecurity] = useState<Security>("WPA/WPA2/WPA3");
  const [hidden, setHidden] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ ssid?: string; password?: string }>({});

  function validate() {
    const next: { ssid?: string; password?: string } = {};
    if (!ssid.trim()) next.ssid = "Enter a network name.";
    else if (ssid.length > 32) next.ssid = "Use 32 characters or fewer.";

    if (security !== "None") {
      if (!password) next.password = "Enter the Wi-Fi password.";
      else if (password.length < 8) next.password = "Use at least 8 characters.";
      else if (password.length > 63) next.password = "Use 63 characters or fewer.";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  return (
    <PublicUtilityFrame title="Wi-Fi">
      <section className={settings.section} data-testid="wifi-qr-generator">
        <header className={styles.sectionHeader}>
          <div>
            <h1 className={styles.sectionTitle}>{generated ? "Scan this code" : "Add a Wi-Fi network"}</h1>
            <p className={styles.sectionDescription}>
              {generated
                ? "Keep this page open while your Pin connects."
                : "Create a QR code your Ai Pin can scan."}
            </p>
          </div>
          <span className={styles.wifiGlyph}><WifiGlyph /></span>
        </header>

        {generated ? (
          <div className={styles.result}>
            <div className={styles.qrWrap} aria-label="Wi-Fi QR code">
              <QRCodeSVG value={generated} size={240} level="M" />
            </div>
            <div className={styles.resultCopy}>
              <h2>On your Ai Pin</h2>
              <ol>
                <li>Hold the touchpad and say “turn on Wi-Fi”.</li>
                <li>Show this code to the Pin until you hear a chime.</li>
              </ol>
              <button className={styles.secondaryButton} type="button" onClick={() => setGenerated(null)}>
                Change network details
              </button>
            </div>
          </div>
        ) : (
          <form
            className={styles.form}
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            data-form-type="other"
            onSubmit={(event) => {
              event.preventDefault();
              if (validate()) setGenerated(wifiPayload(ssid, password, security, hidden));
            }}
          >
            <div className={styles.fieldGrid}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Network name</span>
                <input
                  className={styles.input}
                  name="wifi-ssid"
                  value={ssid}
                  onChange={(event) => setSsid(event.target.value)}
                  autoComplete="off"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-form-type="other"
                  aria-invalid={Boolean(errors.ssid)}
                  aria-describedby={errors.ssid ? "wifi-ssid-error" : undefined}
                />
                {errors.ssid ? <span id="wifi-ssid-error" className={styles.error}>{errors.ssid}</span> : null}
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Security</span>
                <span className={styles.selectWrap}>
                  <select
                    className={styles.select}
                    value={security}
                    onChange={(event) => setSecurity(event.target.value as Security)}
                  >
                    <option>WPA/WPA2/WPA3</option>
                    <option>None</option>
                  </select>
                  <span className={styles.chevron}><CaretDown size={12} /></span>
                </span>
              </label>
            </div>

            {security !== "None" ? (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Password</span>
                <span className={styles.passwordWrap}>
                  <input
                    className={styles.input}
                    name="wifi-network-key"
                    type={reveal ? "text" : "password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="new-password"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    data-form-type="other"
                    aria-invalid={Boolean(errors.password)}
                    aria-describedby={errors.password ? "wifi-password-error" : undefined}
                  />
                  <button
                    className={styles.reveal}
                    type="button"
                    aria-label={reveal ? "Hide password" : "Show password"}
                    onClick={() => setReveal((value) => !value)}
                  >
                    {reveal ? "Hide" : "Show"}
                  </button>
                </span>
                {errors.password ? <span id="wifi-password-error" className={styles.error}>{errors.password}</span> : null}
              </label>
            ) : null}

            <label className={styles.checkboxRow}>
              <span>
                <span className={styles.checkboxLabel}>Hidden network</span>
                <span className={styles.checkboxHint}>Include the hidden-network flag in the code.</span>
              </span>
              <input
                className={styles.checkbox}
                type="checkbox"
                checked={hidden}
                onChange={(event) => setHidden(event.target.checked)}
              />
            </label>

            <footer className={styles.actions}>
              <p>Your network name and password stay in this browser.</p>
              <button className={styles.primaryButton} type="submit">Generate QR code</button>
            </footer>
          </form>
        )}
      </section>
    </PublicUtilityFrame>
  );
}
