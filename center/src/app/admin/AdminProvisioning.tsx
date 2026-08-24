import { StatusChip, StatusMessage } from "@/components/Status";
import { activationCommands, createActivationBundleJson } from "./activationBundle";
import styles from "./admin.module.css";
import type { Bundle, Overview } from "./AdminTypes";

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
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
  const commands = bundle
    ? activationCommands(bundle.device_id, overview.device_edge_ipv4)
    : null;

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
              This activation file contains a one-time private key and is never stored. Download it
              before you leave or reload this page, then keep it private. The enrollment PIN is a
              separate one-time code and is not included in the file.
            </StatusMessage>
            <div className={styles.downloads}>
              <button
                type="button"
                className={styles.miniButton}
                onClick={() => download(
                  commands!.credentialFile,
                  createActivationBundleJson(bundle, overview.device_status_endpoint!),
                  "application/json",
                )}
                disabled={!overview.device_status_endpoint}
              >
                ↓ activation.json
              </button>
            </div>
            <ol className={styles.steps}>
              <li>
                Move <code>{commands!.credentialFile}</code> to <code>{commands!.credentialPath}</code>
                on the trusted computer connected to the Pin. Keep the directory at <code>0700</code>
                and the file at <code>0600</code>; never store it in a repository.
              </li>
              <li>
                Keep the enrollment PIN {bundle.pincode ? <code>{bundle.pincode}</code> : <em>none (keyless)</em>} separate.
                It is used once during onboarding, not by the activation command.
              </li>
              <li>
                Replace <code>PIN_SERIAL</code> with the serial reported by <code>adb devices</code>,
                then preview the exact device change:<br /><code>{commands!.plan}</code>
              </li>
              <li>
                Review the plan, then apply it:<br /><code>{commands!.confirm}</code>
              </li>
              <li>
                Verify the reconciled activation state:<br /><code>{commands!.status}</code>
              </li>
            </ol>
          </div>
        ) : null}
      </section>
    </>
  );
}
