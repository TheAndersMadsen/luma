"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import styles from "./states.module.css";

function useSkeletonDelay(delay = 180): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), delay);
    return () => window.clearTimeout(timer);
  }, [delay]);
  return visible;
}

export function GridSkeleton({ count = 12 }: { count?: number }) {
  const visible = useSkeletonDelay();
  if (!visible) return null;
  return (
    <div className={styles.skeletonGrid} aria-busy="true" aria-label="Loading captures">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`${styles.skeleton} ${styles.skeletonTile}`} />
      ))}
    </div>
  );
}

export function RowsSkeleton({ count = 6 }: { count?: number }) {
  const visible = useSkeletonDelay();
  if (!visible) return null;
  return (
    <div className={styles.skeletonRows} aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={styles.skeletonRow}>
          <div className={styles.skeletonIcon} />
          <div className={styles.skeletonRowBody}>
            <div className={styles.skeletonLine} style={{ width: "62%" }} />
            <div className={styles.skeletonLine} style={{ width: "88%" }} />
            <div className={styles.skeletonLine} style={{ width: "34%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

const CARD_GRIDS = {
  auto: styles.cardsAuto,
  dashboard: styles.cardsDashboard,
  notes: styles.cardsNotes,
  myData: styles.cardsMyData,
} as const;

/**
 * Card placeholders in the SAME grid as the content they stand in for, so a
 * page stops re-flowing the instant its data lands. `auto` is the historical
 * 260px auto-fill grid and stays the default, so nothing that has not opted in
 * changes shape.
 */
export function CardsSkeleton({
  variant = "auto",
  count = 6,
}: {
  variant?: "dashboard" | "notes" | "myData" | "auto";
  count?: number;
}) {
  const visible = useSkeletonDelay();
  if (!visible) return null;
  return (
    <div className={CARD_GRIDS[variant]} aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`${styles.skeleton} ${styles.skeletonCard}`} />
      ))}
    </div>
  );
}

/**
 * A settings section, loading, on the same 18px/24px row rhythm as the real
 * `.infoRowRoot`s that replace it. Settings had four different one-line loading
 * sentences instead, and each of them made the pane jump.
 */
export function SectionSkeleton({ rows = 4 }: { rows?: number }) {
  const visible = useSkeletonDelay();
  if (!visible) return null;
  return (
    <div className={styles.sectionSkeleton} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.sectionSkeletonRow}>
          <div className={`${styles.skeletonLine} ${styles.sectionSkeletonLabel}`} />
          <div className={`${styles.skeletonLine} ${styles.sectionSkeletonValue}`} />
        </div>
      ))}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  detail,
  onRetry,
  inline = false,
}: {
  title?: string;
  detail?: string;
  onRetry?: () => void;
  /** Sit next to the thing that failed instead of owning the viewport. */
  inline?: boolean;
}) {
  return (
    <div className={`${styles.errorState} ${inline ? styles.errorStateInline : ""}`} role="alert">
      <span className={styles.errorTitle}>{title}</span>
      {detail ? <span className={styles.errorDetail}>{detail}</span> : null}
      {onRetry ? (
        <button className={styles.retryButton} type="button" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/**
 * "Live, and you have none yet", the state most often mis-rendered as broken.
 *
 * Always the right domain icon (Memories used to render the NOTES icon), always
 * headline case, and where one exists, the action that resolves the emptiness.
 * Never inferred from a fetch outcome: this is `state === "live" && !list.length`
 * and nothing else.
 *
 * Recovered copy passes straight through as props, Notes keeps "No notes yet"
 * and its document-with-arrow icon verbatim.
 */
export function EmptyState({
  icon,
  title,
  detail,
  action,
  inline = false,
}: {
  icon?: React.ReactNode;
  title: string;
  detail?: string;
  action?: { label: string; onClick?: () => void; href?: string };
  /** Inside a settings section or a console card rather than a full view. */
  inline?: boolean;
}) {
  return (
    <div
      className={`${styles.emptyState} ${inline ? styles.emptyStateInline : ""}`}
      data-testid="empty-state"
    >
      {icon ? (
        <span className={styles.emptyIcon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className={styles.emptyTitle}>{title}</span>
      {detail ? <span className={styles.emptyDetail}>{detail}</span> : null}
      {action ? (
        action.href ? (
          <Link className={styles.emptyAction} href={action.href}>
            {action.label}
          </Link>
        ) : (
          <button className={styles.emptyAction} type="button" onClick={action.onClick}>
            {action.label}
          </button>
        )
      ) : null}
    </div>
  );
}
