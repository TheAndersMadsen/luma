"use client";

import { useCallback, useRef, useState } from "react";
import styles from "./panes.module.css";

/*
 * The write-only credential input, re-expressed on Center's own primitives.
 *
 * Ported in BEHAVIOUR from the retired Setup SPA's
 * `components/SecretInput.tsx`, not in markup: the SPA's version reached for
 * `app-secret-field` / `app-form-input` / `app-inline-icon-button` from the
 * vendored PenumbraOS stylesheet, none of which crosses into Center.
 *
 * The rule it enforces is the reason it exists at all. The Pin never returns a
 * stored credential, only a `has_*` boolean, so a field that is currently
 * SET renders a mask and a Replace control, never a value. There is no state in
 * which a stored device credential is placed into the DOM.
 */

const MASK = "•".repeat(16);

export function SecretField({
  value,
  onChange,
  hasExisting,
  placeholder = "Enter API key",
  id,
  disabled = false,
  ariaLabel,
}: {
  /** The pending NEW value only. Never the stored one. */
  value: string;
  onChange: (value: string) => void;
  /** What the Pin reports: a credential is stored for this field. */
  hasExisting: boolean;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleReplace = useCallback(() => {
    onChange("");
    setIsEditing(true);
    // Focus after the swap so a keyboard user is not dropped back at the top.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [onChange]);

  const handleCancel = useCallback(() => {
    onChange("");
    setIsEditing(false);
  }, [onChange]);

  if (hasExisting && !isEditing) {
    return (
      <div className={styles.secretField}>
        <span className={styles.secretMask} aria-label="A credential is stored">
          {MASK}
        </span>
        <button
          type="button"
          className={styles.smallButton}
          onClick={handleReplace}
          disabled={disabled}
        >
          Replace
        </button>
      </div>
    );
  }

  return (
    <div className={styles.secretField}>
      <input
        ref={inputRef}
        id={id}
        aria-label={ariaLabel}
        type="password"
        className={styles.inputWide}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        // `off` is only advisory for credential managers. Chromium may still
        // restore a saved password into the field and React then treats it as
        // a requested credential rotation. `new-password` is the standardized
        // signal that this is a NEW write-only value, never a login credential
        // to restore. Besides avoiding a secret in the DOM, it keeps an
        // unrelated settings save from being blocked by an autofilled value.
        autoComplete="new-password"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        disabled={disabled}
        data-testid="pin-secret-input"
      />
      {hasExisting ? (
        <button
          type="button"
          className={styles.smallButton}
          onClick={handleCancel}
          disabled={disabled}
        >
          Cancel
        </button>
      ) : null}
    </div>
  );
}
