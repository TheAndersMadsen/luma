"use client";

/**
 * One local-only handoff for the passcode stock onboarding already expects.
 *
 * The account API deliberately exposes only whether a passcode exists, so the
 * owner re-enters the same digits here. This component clears its field before
 * the USB operation starts and never sends the value through `fetch` or a log.
 */

import { useId, useState, type FormEvent } from "react";
import { StatusMessage } from "@/components/Status";
import {
  PinOnboardingError,
  finishPinOnboarding,
  isPinPasscode,
  type OnboardingTiming,
  type PinShellWithInput,
} from "@/lib/pin-setup";
import pin from "../pin.module.css";
import styles from "./setup.module.css";

export function OnboardingPasscodePanel({
  device,
  onChanged,
  timing,
  timeoutMs,
}: {
  /** The already-connected shared USB session. */
  device: () => PinShellWithInput;
  /** Re-read Guided setup after stock confirms completion. */
  onChanged: () => void;
  /** Injectable only so the bounded wait is instant in tests. */
  timing?: OnboardingTiming;
  timeoutMs?: number;
}) {
  const fieldId = useId();
  const hintId = useId();
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (!isPinPasscode(passcode)) {
      setError("A passcode is exactly four digits.");
      return;
    }

    let oneTimePasscode = passcode;
    setPasscode("");
    setError(null);
    setBusy(true);
    void Promise.resolve()
      .then(() => {
        try {
          return finishPinOnboarding(device(), oneTimePasscode, timing, timeoutMs);
        } finally {
          oneTimePasscode = "";
        }
      })
      .then(onChanged)
      .catch((failure: unknown) => {
        setError(
          failure instanceof PinOnboardingError
            ? failure.message
            : "Center lost contact with the Pin before setup finished. Check the cable and try again.",
        );
      })
      .finally(() => setBusy(false));
  };

  return (
    <form
      className={styles.onboardingForm}
      autoComplete="off"
      data-1p-ignore="true"
      data-lpignore="true"
      data-form-type="other"
      noValidate
      onSubmit={submit}
      aria-label="Finish the Pin’s own setup"
    >
      <label className={pin.field} htmlFor={fieldId}>
        <span className={pin.fieldLabel}>Your four-digit Pin passcode</span>
        <input
          id={fieldId}
          className={pin.fieldInput}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9]{4}"
          maxLength={4}
          value={passcode}
          aria-describedby={hintId}
          disabled={busy}
          onChange={(event) => {
            setPasscode(event.target.value.replace(/[^0-9]/gu, "").slice(0, 4));
            setError(null);
          }}
        />
      </label>
      <p className={pin.fieldHint} id={hintId}>
        This copy goes straight over USB to this Pin. Center does not save it,
        and the browser field clears as soon as you continue.
      </p>
      <div className={styles.actions}>
        <button type="submit" className={pin.button} disabled={busy}>
          {busy ? "Finishing setup…" : "Finish setup on this Pin"}
        </button>
      </div>
      {error ? <StatusMessage tone="warning">{error}</StatusMessage> : null}
    </form>
  );
}
