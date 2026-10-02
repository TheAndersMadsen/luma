"use client";

import { type FormEvent, useState } from "react";
import { StatusMessage } from "./Status";
import styles from "@/app/login/login.module.css";

/** Shared password form: reconnect uses the same bounded, throttled endpoint. */
export function SignInForm({ onSuccess, initialError = null, email }: {
  onSuccess: (subject: string) => void;
  initialError?: string | null;
  email?: string;
}) {
  const [username, setUsername] = useState(email ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // The callback's `?error=` is a code, never rendered as sent: it maps to one
  // fixed sentence, and anything unknown reads as the generic notice.
  const [formError, setFormError] = useState<string | null>(initialError);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFormError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(body.error ?? "Sign in failed.");
        return;
      }
      onSuccess(String(body.sub ?? ""));
    } catch {
      setFormError("Your server couldn’t be reached. Try again.");
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  return (
  <form className={styles.form} onSubmit={submit}>
    <label className={styles.fieldRow}>
      <span>Email</span>
      <input
        className={styles.input}
        type="email"
        autoComplete="username"
        readOnly={Boolean(email)}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="you@example.com"
        required
      />
    </label>
    <label className={styles.fieldRow}>
      <span>Password</span>
      <input
        className={styles.input}
        type="password"
        autoFocus={Boolean(email)}
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="••••••••"
        required
      />
    </label>

    {/* A failure is never the caption colour, and never an off-palette hex. */}
    {formError && <StatusMessage tone="danger">{formError}</StatusMessage>}

    <button
      type="submit"
      className={styles.submit}
      disabled={busy || !username.trim() || !password}
    >
      {busy ? "Signing in…" : "Sign in with password"}
    </button>
  </form>
  );
}
