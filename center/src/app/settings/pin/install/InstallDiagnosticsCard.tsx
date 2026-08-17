"use client";

/**
 * Debugging — support bundle downloads, device identity, per-package state,
 * detected conflicts, the resolved release target, the last operation and the
 * full activity log. Ported from the retired Setup SPA's
 * `install/components/InstallDiagnosticsCard.tsx`.
 *
 * Opens itself when the controller is in an error stage, because that is the
 * only moment any of this matters and asking a stuck wearer to go find a
 * disclosure triangle is how support tickets arrive with no logs attached.
 */

import type { ReactNode } from "react";
import {
  createInstallSupportBundleFiles,
  downloadSupportBundleFile,
  formatDetectedPackageConflict,
  formatManagedPackageRole,
  getDisplayedPackageVersion,
  getManagedPackageSnapshots,
} from "@/lib/pin-install";
import styles from "./install.module.css";
import type { InstallController } from "./useInstallController";

function shouldShowPackageDumpsys(pkg: {
  installed: boolean;
  versionReadable: boolean;
  versionComparison: string | null;
  rawOutput: string | null;
}) {
  if (!pkg.rawOutput) {
    return false;
  }

  return (
    pkg.installed &&
    (!pkg.versionReadable || pkg.versionComparison === "unreadable")
  );
}

function KvRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className={styles.kvRow}>
      <dt>{label}</dt>
      <dd className={mono ? styles.mono : undefined}>{value}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {children}
    </div>
  );
}

export function InstallDiagnosticsCard({
  controller,
}: {
  controller: InstallController;
}) {
  const { state } = controller;
  const packages = getManagedPackageSnapshots(state.inspection);
  const supportFiles = createInstallSupportBundleFiles(state, controller);
  const isError = state.stage === "error";

  return (
    <details className={styles.diagnostics} open={isError}>
      <summary className={styles.diagnosticsSummary}>
        <span className={styles.diagnosticsHeading}>
          <span className={styles.diagnosticsTitle}>Debugging</span>
          <span className={styles.diagnosticsSubtitle}>
            Download logs and diagnostic information
          </span>
        </span>
        <svg
          className={styles.diagnosticsChevron}
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M6 4l4 4-4 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>

      <div className={styles.diagnosticsBody}>
        {supportFiles.length > 0 ? (
          <Section title="Support bundle">
            <div className={styles.downloads}>
              {supportFiles.map((file) => (
                <button
                  key={file.fileName}
                  type="button"
                  className={styles.download}
                  onClick={() => {
                    void downloadSupportBundleFile(file);
                  }}
                >
                  {file.label ?? file.fileName}
                </button>
              ))}
            </div>
          </Section>
        ) : null}

        {state.inspection ? (
          <Section title="Device">
            <dl className={styles.kv}>
              <KvRow label="Manufacturer" value={state.inspection.device.manufacturer} />
              <KvRow label="Model" value={state.inspection.device.model} />
              <KvRow label="Product" value={state.inspection.device.product} />
              <KvRow
                label="Build fingerprint"
                value={state.inspection.device.buildFingerprint || "Unavailable"}
                mono
              />
            </dl>
          </Section>
        ) : null}

        {state.inspection ? (
          <Section title="Managed packages">
            {packages.map((pkg) => (
              <div key={pkg.role} className={styles.diagnosticsPackage}>
                <div className={styles.diagnosticsPackageHead}>
                  <span className={styles.diagnosticsPackageName}>
                    {formatManagedPackageRole(pkg.role)}
                  </span>
                  <span className={styles.diagnosticsPackageVersion}>
                    {getDisplayedPackageVersion(pkg.versionName, pkg.installed)} →{" "}
                    {pkg.targetVersion}
                  </span>
                </div>
                <dl className={styles.kv}>
                  <KvRow label="Installed" value={pkg.installed ? "Yes" : "No"} />
                  <KvRow label="Healthy" value={pkg.healthy ? "Yes" : "No"} />
                  <KvRow label="Comparison" value={pkg.versionComparison ?? "Unknown"} />
                  <KvRow label="Package" value={pkg.packageName} mono />
                </dl>
                {shouldShowPackageDumpsys(pkg) && pkg.rawOutput ? (
                  <details>
                    <summary className={styles.dumpToggle}>View dumpsys output</summary>
                    <pre className={styles.dump}>{pkg.rawOutput}</pre>
                  </details>
                ) : null}
              </div>
            ))}
          </Section>
        ) : null}

        {state.inspection?.hasDetectedConflicts ? (
          <Section title="Known conflicts">
            <dl className={styles.kv}>
              {state.inspection.detectedConflicts.map((conflict) => (
                <KvRow
                  key={conflict.id}
                  label={conflict.label}
                  value={formatDetectedPackageConflict(conflict)}
                  mono
                />
              ))}
            </dl>
          </Section>
        ) : null}

        {state.target ? (
          <Section title="Release target">
            <dl className={styles.kv}>
              <KvRow label="Release" value={state.target.version} />
              <KvRow label="Release ID" value={state.target.releaseId} mono />
              <KvRow
                label="Installer"
                value={state.target.artifacts.installerApk.name}
                mono
              />
              <KvRow
                label="Bootstrap"
                value={state.target.artifacts.exploitApk.name}
                mono
              />
              <KvRow label="Hook" value={state.target.artifacts.hookApk.name} mono />
              <KvRow label="Server" value={state.target.artifacts.serverApk.name} mono />
              <KvRow
                label="Hook injector"
                value={state.target.artifacts.injectorApk.name}
                mono
              />
              <KvRow
                label="Locked at"
                value={state.targetLock?.lockedAt ?? "Not locked"}
              />
            </dl>
          </Section>
        ) : null}

        {state.lastOperationResult ? (
          <Section title="Last operation">
            <dl className={styles.kv}>
              <KvRow label="Action" value={state.lastOperationResult.kind} />
              <KvRow
                label="Success"
                value={state.lastOperationResult.result.success ? "Yes" : "No"}
              />
              <KvRow
                label="Warnings"
                value={state.lastOperationResult.result.warnings.length}
              />
              {"failedPhase" in state.lastOperationResult.result ? (
                <KvRow
                  label="Failed phase"
                  value={state.lastOperationResult.result.failedPhase ?? "None"}
                />
              ) : null}
              {state.lastOperationResult.result.error ? (
                <KvRow
                  label="Error"
                  value={state.lastOperationResult.result.error.message}
                />
              ) : null}
            </dl>
          </Section>
        ) : null}

        <Section title="Activity log">
          {state.progressEntries.length > 0 ? (
            <ul className={styles.log}>
              {state.progressEntries.map((entry) => (
                <li key={entry.id} className={styles.logEntry}>
                  <span className={styles.logPhase}>{entry.phase}</span>
                  <div>
                    <div className={styles.logMessage}>{entry.message}</div>
                    <div className={styles.logTime}>{entry.timestamp}</div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>No activity yet.</p>
          )}
        </Section>
      </div>
    </details>
  );
}
