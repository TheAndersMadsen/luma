"use client";

import type { ReactNode } from "react";
import { Switch } from "@/components/Status";
import styles from "./surfaces.module.css";
import type { PermissionFailure } from "./permissions";

const FAILURE: Record<PermissionFailure, string> = {
  unavailable: "This setting could not be read.",
  changed: "This device’s approval changed.",
  unconfirmed: "Cosmos did not confirm the change. It may still have been saved, so check again before retrying.",
};

type Props = {
  title: string;
  description: ReactNode;
  checked: boolean;
  /** True while this cannot be turned on; turning it off stays possible. */
  disabled?: boolean;
  busy: boolean;
  reading: boolean;
  failure: PermissionFailure | null;
  message: string;
  onChange(next: boolean): void;
  onRetry(): void;
  children?: ReactNode;
};

/** One plain switch: a title, one line about what it allows, and the state Cosmos last confirmed. */
export function PermissionSwitch({ title, description, checked, disabled = false, busy, reading, failure, message, onChange, onRetry, children }: Props) {
  return <div className={styles.switchRow} role="group" aria-label={title}>
    <div className={styles.switchText}>
      <span className={styles.switchTitle}>{title}</span>
      <span className={styles.switchDescription}>{description}</span>
      {children}
      {reading ? <span className={styles.switchState} role="status">Checking…</span> : null}
      {failure ? <span className={styles.switchState} role="alert">{FAILURE[failure]}{" "}
        <button type="button" className={styles.linkButton} disabled={busy} onClick={onRetry}>{failure === "changed" ? "Refresh devices" : "Check again"}</button>
      </span> : null}
      {message ? <span className={styles.switchState} role="status">{message}</span> : null}
    </div>
    <Switch checked={checked} disabled={busy || reading || failure !== null || (!checked && disabled)} ariaLabel={title} onChange={onChange} />
  </div>;
}
