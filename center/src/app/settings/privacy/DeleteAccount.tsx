"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import settings from "../settings.module.css";
import styles from "./deleteAccount.module.css";
import { StatusMessage } from "@/components/Status";

const CONFIRM_PHRASE = "DELETE";

/**
 * Settings → Privacy → Delete account.
 *
 * humane.center carried this control behind its `accountDeletion` flag. It
 * deletes everything Cosmos holds for the signed-in wearer, then signs them out
 * through Keycloak's end-session page. Typing the phrase is required, so it can
 * never fire on a stray click.
 */
export function DeleteAccount({ navigate = (url: string) => window.location.assign(url) }: {
  navigate?: (url: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function remove(event: FormEvent) {
    event.preventDefault();
    if (busy || typed.trim() !== CONFIRM_PHRASE) return;
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch("/api/settings/privacy/account", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: typed.trim() }),
      });
      const body = (await response.json().catch(() => null)) as
        | { deleted?: boolean; endSessionUrl?: string; error?: string; reauthenticate?: boolean }
        | null;
      if (response.ok && body?.deleted) {
        navigate(body.endSessionUrl ?? "/login");
        return;
      }
      setProblem(
        body?.reauthenticate
          ? "expired"
          : typeof body?.error === "string"
            ? body.error
            : "Your account couldn’t be fully deleted. Try again to finish.",
      );
    } catch {
      setProblem("Your account couldn’t be fully deleted. Try again to finish.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={settings.section} data-testid="deleteAccount">
      <div className={settings.sectionHeader}>
        <span className={settings.sectionTitle}>Delete account</span>
        {!confirming ? (
          <button type="button" className={styles.startButton} onClick={() => setConfirming(true)}>
            Delete account…
          </button>
        ) : null}
      </div>
      <div className={settings.stateRow}>
        <span className={settings.muted}>
          Permanently deletes your notes, captures, Ai Mic history and other events, contacts,
          account settings, the keys your Pin saved here, your Pin passcode, and removes your
          Pins from your account. This can&rsquo;t be undone. A Pin that is still set up can keep
          sending new data until you factory reset it.
        </span>
      </div>
      {confirming ? (
        <form className={styles.confirm} onSubmit={(event) => void remove(event)}>
          <label>
            Type {CONFIRM_PHRASE} to confirm
            <input
              className={styles.field}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
          </label>
          {problem === "expired" ? (
            <StatusMessage tone="warning">
              Your session expired, so nothing was deleted. <Link href="/login">Sign in again</Link>.
            </StatusMessage>
          ) : problem ? (
            <StatusMessage tone="danger">{problem}</StatusMessage>
          ) : null}
          <div className={styles.actions}>
            <button
              type="submit"
              className={styles.dangerButton}
              disabled={busy || typed.trim() !== CONFIRM_PHRASE}
            >
              {busy ? "Deleting…" : "Delete my account"}
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                setTyped("");
                setProblem(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
