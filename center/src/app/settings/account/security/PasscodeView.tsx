"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import styles from "../../settings.module.css";
import editor from "./security.module.css";
import { SectionSkeleton } from "@/components/States";
import { StatusMessage } from "@/components/Status";
import { usePasscodeState } from "@/lib/queries";


const QUERY_KEY = ["account-passcode"];

/**
 * Settings → Pin passcode.
 *
 * The four digits a Pin asks for when it is set up. Stock onboarding sends a
 * wearer who has none here ("You have not set your pincode yet. Go to .center
 * and set it."), and every stock experience says "Update your account passcode
 * at humane.center, which will apply to your Ai Pin after a factory reset".
 * Cosmos keeps only an OPAQUE password file made from it, so the passcode is
 * never shown again, this pane can only say whether one is set.
 */
export function PasscodeView() {
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const { data, isLoading, isError, refetch } = usePasscodeState();

  if (isLoading) return <SectionSkeleton rows={2} />;

  if (isError || !data) {
    return (
      <StatusMessage tone="warning" onRetry={() => void refetch()}>
        Your passcode settings couldn&rsquo;t be loaded just now.
      </StatusMessage>
    );
  }

  const live = data.state === "live" && data.set !== null;
  return (
    <section className={styles.section} data-testid="pinPasscode">
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>Ai Pin passcode</span>
        {live && !editing ? (
          <button
            type="button"
            className={editor.editButton}
            onClick={() => {
              setSaved(false);
              setEditing(true);
            }}
          >
            {data.set ? "Change" : "Set passcode"}
          </button>
        ) : null}
      </div>
      {editing ? (
        <PasscodeEditor
          onDone={(didSave) => {
            setEditing(false);
            setSaved(didSave);
          }}
        />
      ) : null}
      {data.reauthenticate ? (
        <StatusMessage tone="warning">
          Your session expired. <Link href="/login">Sign in again</Link> to manage your passcode.
        </StatusMessage>
      ) : data.state === "absent" ? (
        <StatusMessage tone="info">This Center is not connected to Pin services.</StatusMessage>
      ) : !live ? (
        <StatusMessage tone="warning" onRetry={() => void refetch()}>
          Whether you have a passcode couldn&rsquo;t be checked just now.
        </StatusMessage>
      ) : (
        <div className={styles.infoRowRoot}>
          <span className={styles.titleInfo}>Passcode</span>
          <div className={styles.descWrapper}>
            <span className={styles.description} data-testid="passcode-state">
              {data.set ? "Set" : "Not set"}
            </span>
          </div>
        </div>
      )}
      {saved ? (
        <StatusMessage tone="info">
          Passcode saved. <Link href="/settings/pin/setup">Guided setup</Link> asks you to
          re-enter it once and sends that copy directly to the Pin over USB. A Pin that is
          already set up keeps its current passcode.
        </StatusMessage>
      ) : null}
      <div className={styles.stateRow}>
        <span className={styles.muted}>
          During Guided setup, you re-enter this passcode once so the browser can send it directly
          to the Pin over USB. A Pin that is already set up keeps its current passcode until its
          next setup.
        </span>
      </div>
    </section>
  );
}

function PasscodeEditor({ onDone }: { onDone: (saved: boolean) => void }) {
  const queryClient = useQueryClient();
  const [passcode, setPasscode] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<
    "shape" | "mismatch" | "expired" | "failed" | null
  >(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!/^[0-9]{4}$/u.test(passcode)) {
      setProblem("shape");
      return;
    }
    if (passcode !== confirmation) {
      setProblem("mismatch");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch("/api/account/passcode", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      if (response.ok) {
        setPasscode("");
        setConfirmation("");
        await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
        onDone(true);
        return;
      }
      setProblem(response.status === 401 ? "expired" : response.status === 400 ? "shape" : "failed");
    } catch {
      setProblem("failed");
    } finally {
      setBusy(false);
    }
  }

  const digits = (value: string) => value.replace(/[^0-9]/gu, "").slice(0, 4);
  return (
    <form
      className={editor.editor}
      onSubmit={(event) => void save(event)}
      noValidate
      data-testid="passcodeEditor"
    >
      <label>
        New passcode
        <input
          className={editor.field}
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          pattern="[0-9]{4}"
          maxLength={4}
          value={passcode}
          onChange={(event) => setPasscode(digits(event.target.value))}
        />
      </label>
      <label>
        Confirm passcode
        <input
          className={editor.field}
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          pattern="[0-9]{4}"
          maxLength={4}
          value={confirmation}
          onChange={(event) => setConfirmation(digits(event.target.value))}
        />
      </label>
      <p className={editor.hint}>Four digits.</p>
      {problem === "shape" ? (
        <StatusMessage tone="warning">A passcode is exactly four digits.</StatusMessage>
      ) : problem === "mismatch" ? (
        <StatusMessage tone="warning">The two passcodes don&rsquo;t match.</StatusMessage>
      ) : problem === "expired" ? (
        <StatusMessage tone="warning">
          Your session expired, so nothing was saved. <Link href="/login">Sign in again</Link>.
        </StatusMessage>
      ) : problem === "failed" ? (
        <StatusMessage tone="warning">
          Your passcode couldn&rsquo;t be saved. Nothing was changed.
        </StatusMessage>
      ) : null}
      <div className={editor.actions}>
        <button type="submit" className={editor.primaryButton} disabled={busy}>
          {busy ? "Saving…" : "Save passcode"}
        </button>
        <button
          type="button"
          className={editor.secondaryButton}
          disabled={busy}
          onClick={() => onDone(false)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
