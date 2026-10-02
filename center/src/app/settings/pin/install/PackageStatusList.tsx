"use client";

/**
 * The five managed package roles and any detected conflicts, as a compact
 * definition list, ported from the retired Setup SPA's
 * `components/PackageStatusList.tsx` and restyled onto install.module.css.
 *
 * Kept inside the install pane rather than promoted to `@/components`: the plan
 * wants a shared `PackageStatusList` primitive that /settings/account/devices
 * also uses, but that file belongs to whoever folds the device-software section
 * into the devices page. This component's props are already the shape that
 * primitive needs, so hoisting it later is a move, not a rewrite.
 */

import styles from "./install.module.css";

export interface PackageStatusRowViewModel {
  readonly id: string;
  readonly role: string;
  readonly value: string;
  readonly tone: "default" | "success" | "warning";
  readonly category?: "managed" | "conflict";
  readonly badge?: string | null;
}

const TONE_CLASS: Record<PackageStatusRowViewModel["tone"], string | undefined> = {
  default: styles.packageValueDefault,
  success: styles.packageValueSuccess,
  warning: styles.packageValueWarning,
};

function PackageStatusRow({
  row,
  conflict = false,
}: {
  row: PackageStatusRowViewModel;
  conflict?: boolean;
}) {
  return (
    <div
      className={[styles.package, conflict ? styles.packageConflict : ""]
        .filter(Boolean)
        .join(" ")}
    >
      <dt>{row.role}</dt>
      <dd className={`${styles.packageValue} ${TONE_CLASS[row.tone]}`} title={row.value}>
        <span>{row.value}</span>
        {conflict && row.badge ? (
          <span className={styles.packageBadge}>{row.badge}</span>
        ) : null}
      </dd>
    </div>
  );
}

export function PackageStatusList({
  rows,
  conflictRows = [],
  ariaLabel,
}: {
  rows: readonly PackageStatusRowViewModel[];
  conflictRows?: readonly PackageStatusRowViewModel[];
  ariaLabel: string;
}) {
  if (rows.length === 0 && conflictRows.length === 0) {
    return null;
  }

  return (
    <dl className={styles.packages} aria-label={ariaLabel}>
      {rows.map((row) => (
        <PackageStatusRow key={row.id} row={row} />
      ))}
      {conflictRows.length > 0 ? (
        <div className={styles.packagesDivider} aria-hidden="true">
          Installation conflicts
        </div>
      ) : null}
      {conflictRows.map((row) => (
        <PackageStatusRow key={row.id} row={row} conflict />
      ))}
    </dl>
  );
}
