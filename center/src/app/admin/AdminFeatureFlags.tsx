"use client";

import Link from "next/link";
import { EmptyState, SectionSkeleton } from "@/components/States";
import { StatusChip, StatusMessage, Switch } from "@/components/Status";
import styles from "./admin.module.css";

export type PanelStatus = "loading" | "unconfigured" | "error" | "ready";
export type FlagView = {
  name: string;
  label?: string;
  description?: string;
  evidence?: "observed" | "derived" | "implemented" | "unknown";
  delivery?: string;
  writable?: boolean;
  type: "bool" | "int" | "text" | "float";
  observed: unknown;
  effective: unknown;
  overridden: boolean;
};
export type FlagRowError = { name: string; message: string; tone?: "danger" | "info" };

export function AdminFeatureFlags({
  flags,
  status,
  error,
  revision,
  busy,
  writesEnabled,
  rowError,
  resetOpen,
  resetText,
  resetError,
  onReload,
  onSet,
  onClear,
  onRowError,
  onResetOpen,
  onResetText,
  onReset,
}: {
  flags: FlagView[];
  status: PanelStatus;
  error: string | null;
  revision: number;
  busy: string | null;
  writesEnabled: boolean;
  rowError: FlagRowError | null;
  resetOpen: boolean;
  resetText: string;
  resetError: string | null;
  onReload: () => void;
  onSet: (name: string, value: unknown) => void;
  onClear: (name: string) => void;
  onRowError: (error: FlagRowError | null) => void;
  onResetOpen: (open: boolean) => void;
  onResetText: (value: string) => void;
  onReset: () => void;
}) {
  const overridden = flags.filter((flag) => flag.overridden).length;
  return (
    <section className={styles.card} id="feature-flags">
      <div className={styles.flagsHead}>
        <div>
          <h2>Feature flags</h2>
          <p className={styles.muted}>
            Device-visible runtime controls. Defaults are this deployment&rsquo;s coded values;
            effective values include active overrides. Delivery happens on the Pin&rsquo;s next sync.
          </p>
        </div>
        <Link className={styles.miniButton} href="/settings/account/features">Open wearer-facing feature settings</Link>
        {status === "ready" && overridden > 0 && writesEnabled && !resetOpen ? (
          <button type="button" className={styles.dangerButton} onClick={() => onResetOpen(true)} disabled={busy !== null}>Reset all overrides</button>
        ) : null}
      </div>

      {resetOpen ? (
        <div className={styles.confirmBox}>
          <span className={styles.confirmText}>This clears {overridden} {overridden === 1 ? "override" : "overrides"}. Type <strong>RESET</strong> to confirm.</span>
          <div className={styles.confirmInputWrap}>
            <input className={styles.confirmInput} value={resetText} onChange={(event) => onResetText(event.target.value)} placeholder="RESET" aria-label="Type RESET to confirm clearing every flag override" autoComplete="off" spellCheck={false} />
          </div>
          <div className={styles.confirmActions}>
            <button type="button" className={styles.dangerButton} disabled={resetText.trim() !== "RESET" || busy !== null} onClick={onReset}>{busy === "*" ? "Clearing…" : "Clear every override"}</button>
            <button type="button" className={styles.miniButton} onClick={() => { onResetOpen(false); onResetText(""); }}>Cancel</button>
          </div>
          {resetError ? <StatusMessage tone="danger" inline>{resetError}</StatusMessage> : null}
        </div>
      ) : null}

      {!writesEnabled && status === "ready" && flags.length > 0 ? <div className={styles.panelError}><StatusMessage tone="info">Read-only: setting an override needs an admin token, and this dashboard has none.</StatusMessage></div> : null}
      {status === "loading" ? <SectionSkeleton rows={5} /> : null}
      {status === "unconfigured" ? <StatusMessage tone="info">No backend is configured for this Center, so there are no flags to read.</StatusMessage> : null}
      {status === "error" ? <StatusMessage tone="warning" onRetry={onReload}>{error ?? "Couldn't reach the backend just now."}</StatusMessage> : null}
      {status === "ready" ? flags.length === 0 ? <EmptyState title="No flags reported by the backend" inline /> : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Flag</th><th title="This deployment's coded default, with runtime overrides suppressed.">Default here</th><th>Effective</th><th /></tr></thead>
            <tbody>
              {flags.map((flag) => (
                <tr key={flag.name} className={flag.overridden ? styles.flagOverridden : undefined}>
                  <th scope="row">
                    <span className={styles.flagName}>
                      <code>{flag.name}</code>
                      {flag.overridden ? <StatusChip tone="live" variant="tag" label="override" /> : null}
                      {flag.writable === false ? <StatusChip tone="absent" variant="tag" label="read-only" /> : null}
                    </span>
                    {flag.label ? <span className={styles.flagDefault}>{flag.label}</span> : null}
                  </th>
                  <td className={styles.flagDefault}>{String(flag.observed)}</td>
                  <td>
                    {flag.type === "bool" ? (
                      <Switch checked={Boolean(flag.effective)} onChange={(next) => onSet(flag.name, next)} label={flag.effective ? "on" : "off"} disabled={busy !== null || !writesEnabled || flag.writable === false} />
                    ) : (
                      <div className={styles.flagInputWrap}>
                        <input
                          key={`${flag.name}:${revision}`}
                          className={styles.flagInput}
                          defaultValue={String(flag.effective)}
                          disabled={busy !== null || !writesEnabled || flag.writable === false}
                          spellCheck={false}
                          aria-label={`${flag.name} value`}
                          onBlur={(event) => {
                            const raw = event.target.value;
                            if (raw === String(flag.effective)) return;
                            if (raw.trim() === "") {
                              event.target.value = String(flag.effective);
                              onRowError({ name: flag.name, tone: "info", message: flag.overridden ? "An empty field is not a value. Use revert to remove the override." : "An empty field is not a value, so nothing was written." });
                              return;
                            }
                            const value = flag.type === "int" || flag.type === "float" ? Number(raw) : raw;
                            if (typeof value === "number" && !Number.isFinite(value)) {
                              onRowError({ name: flag.name, message: `"${raw}" is not a ${flag.type}, so nothing was written.` });
                              return;
                            }
                            onSet(flag.name, value);
                          }}
                        />
                      </div>
                    )}
                  </td>
                  <td>
                    {flag.overridden && writesEnabled && flag.writable !== false ? <button type="button" className={styles.miniButton} onClick={() => onClear(flag.name)} disabled={busy !== null}>revert</button> : null}
                    {rowError?.name === flag.name ? <div className={styles.rowError}><StatusMessage tone={rowError.tone ?? "danger"} inline>{rowError.message}</StatusMessage></div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
