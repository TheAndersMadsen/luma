import { EmptyState } from "@/components/States";
import { StatusMessage } from "@/components/Status";
import styles from "./admin.module.css";
import type { Overview, ProvisionedDevice } from "./AdminTypes";

export function AdminDataPanels({
  overview,
  devices,
  devicesError,
  onRetryDevices,
  onRetryOverview,
}: {
  overview: Overview;
  devices: ProvisionedDevice[];
  devicesError: string | null;
  onRetryDevices: () => void;
  onRetryOverview: () => void;
}) {
  const countsDegraded = overview.persistenceProvenance
    ? Object.values(overview.persistenceProvenance).some((value) => value.state !== "live")
    : false;

  return (
    <div className={styles.row}>
      <section className={styles.card} id="devices">
        <h2>Provisioned devices</h2>
        <p className={styles.muted}>
          Credentials minted since the backend last started. This is not the wearer&rsquo;s paired-device roster.
        </p>
        {devicesError ? (
          <div className={styles.panelError}>
            <StatusMessage tone="warning" onRetry={onRetryDevices}>{devicesError}</StatusMessage>
          </div>
        ) : null}
        {devices.length === 0 ? (
          <EmptyState title="No credential minted since the last restart" inline />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Device</th><th>Product</th><th>Issued</th></tr></thead>
              <tbody>
                {devices.map((device) => (
                  <tr key={device.device_id}>
                    <td><code>{device.device_id}</code></td>
                    <td>{device.product}</td>
                    <td>{new Date(device.provisioned_at_unix * 1000).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.card} id="persistence">
        <h2>Wearer data</h2>
        <p className={styles.muted}>Wearer-scoped records available to this signed-in account.</p>
        {countsDegraded ? (
          <StatusMessage tone="warning" onRetry={onRetryOverview}>
            Some wearer-scoped counts are unavailable. Center will not replace them with deployment-wide or sample totals.
          </StatusMessage>
        ) : null}
        <div className={styles.counts}>
          <div><strong>{overview.persistence.notes ?? "—"}</strong><span>Notes</span></div>
          <div><strong>{overview.persistence.memories ?? "—"}</strong><span>Memories</span></div>
          <div><strong>{overview.persistence.contacts ?? "—"}</strong><span>Contacts</span></div>
        </div>
      </section>
    </div>
  );
}
