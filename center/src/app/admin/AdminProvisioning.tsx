import { StatusChip, StatusMessage } from "@/components/Status";
import styles from "./admin.module.css";
import type { Bundle, Overview } from "./AdminTypes";

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/x-pem-file" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function AdminProvisioning({
  overview,
  revealPin,
  deviceId,
  product,
  busy,
  provisionError,
  bundle,
  onRevealPin,
  onDeviceId,
  onProvision,
  onClearBundle,
}: {
  overview: Overview;
  revealPin: boolean;
  deviceId: string;
  product: string;
  busy: boolean;
  provisionError: string | null;
  bundle: Bundle | null;
  onRevealPin: () => void;
  onDeviceId: (value: string) => void;
  onProvision: () => void;
  onClearBundle: () => void;
}) {
  const enrollment = overview.enrollment;

  return (
    <>
      <section className={styles.card} id="enrollment">
        <h2>Enrollment</h2>
        <dl className={styles.facts}>
          <div>
            <dt>Enrollment pincode</dt>
            <dd className={styles.pin}>
              {enrollment.keyless ? (
                <span className={styles.muted}>keyless — this deployment holds no credential</span>
              ) : (
                <>
                  <code>{revealPin ? enrollment.pincode : "••••••"}</code>
                  <button type="button" className={styles.miniButton} onClick={onRevealPin}>
                    {revealPin ? "hide" : "reveal"}
                  </button>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>Enrolled user</dt>
            <dd>{enrollment.display_name} <code className={styles.uuid}>{enrollment.user_id}</code></dd>
          </div>
          <div>
            <dt>Onboarding edge</dt>
            <dd>
              {overview.onboarding.endpoint ? (
                <code>{overview.onboarding.endpoint}</code>
              ) : (
                <span className={styles.muted}>set COSMOS_ONBOARDING_ENDPOINT to show</span>
              )}
              {overview.onboarding.authority ? (
                <span className={styles.muted}> · authority {overview.onboarding.authority}</span>
              ) : null}
            </dd>
          </div>
        </dl>
      </section>

      <section className={styles.card} id="provision">
        <h2>Provision a Pin</h2>
        <p className={styles.muted}>
          Mints a device-attestation certificate signed by the edge&rsquo;s trust anchor. The
          private key is generated once and returned here — it is never stored. Provisioning
          requires the hexadecimal identity read from the connected Pin; this dashboard cannot
          detect a USB device from the browser.
        </p>
        <details>
          <summary>Expert mode — enter a detected device id</summary>
          <p className={styles.muted}>
            Read the id with the local setup tool while the intended Pin is connected. Do not
            invent, randomize, or reuse an identity from another device.
          </p>
          <div className={styles.form}>
            <label>
              <span>Detected device id (hex)</span>
              <input
                className={styles.textField}
                value={deviceId}
                onChange={(event) => onDeviceId(event.target.value.toLowerCase())}
                spellCheck={false}
                placeholder="0011223344556677"
                inputMode="text"
                pattern="[0-9a-fA-F]+"
                autoComplete="off"
              />
            </label>
            <label>
              <span>Stock product identity</span>
              <input
                className={styles.textField}
                value={product}
                readOnly
                aria-readonly="true"
              />
            </label>
            <button
              type="button"
              className={styles.primary}
              onClick={onProvision}
              disabled={busy || !/^[0-9a-f]+$/i.test(deviceId.trim()) || !enrollment.provisioning_configured}
            >
              {busy ? "Minting…" : "Provision detected Pin"}
            </button>
          </div>
        </details>

        {!enrollment.provisioning_configured ? (
          <div className={styles.panelError}>
            <StatusMessage tone="warning">
              No attestation CA is configured, so credentials cannot be minted on this deployment.
            </StatusMessage>
          </div>
        ) : null}

        {provisionError ? (
          <div className={styles.panelError}>
            <StatusMessage tone="danger">{provisionError}</StatusMessage>
          </div>
        ) : null}

        {bundle ? (
          <div className={styles.bundle}>
            <div className={styles.bundleHead}>
              <StatusChip tone="live" label="Issued" />
              <code>{bundle.subject}</code>
              <button type="button" className={`${styles.miniButton} ${styles.bundleDismiss}`} onClick={onClearBundle}>
                Done — clear from screen
              </button>
            </div>
            <StatusMessage tone="warning">
              This private key and pincode are shown once and never stored. Download all three files
              before you leave or reload this page.
            </StatusMessage>
            <div className={styles.downloads}>
              <button type="button" className={styles.miniButton} onClick={() => download(`device-${bundle.device_id}.crt`, bundle.certificate_pem)}>↓ device.crt</button>
              <button type="button" className={styles.miniButton} onClick={() => download(`device-${bundle.device_id}.key`, bundle.private_key_pem)}>↓ device.key</button>
              <button type="button" className={styles.miniButton} onClick={() => download("attestation-ca.crt", bundle.ca_certificate_pem)}>↓ ca.crt</button>
            </div>
            <ol className={styles.steps}>
              <li>Save the device certificate, private key, and trusted CA on the Pin or test harness.</li>
              <li>
                Point onboarding at <code>{bundle.onboarding.endpoint || "the onboarding edge"}</code>
                {bundle.onboarding.authority ? <> with authority <code>{bundle.onboarding.authority}</code></> : null},
                presenting <code>device.crt</code> and <code>device.key</code> for mTLS.
              </li>
              <li>
                Complete OPAQUE with pincode {bundle.pincode ? <code>{bundle.pincode}</code> : <em>none (keyless)</em>},
                then run <code>CreateDeviceUserBinding</code> to receive a DeviceUser certificate.
              </li>
            </ol>
          </div>
        ) : null}
      </section>
    </>
  );
}
