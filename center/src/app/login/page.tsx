"use client";

import { FormEvent, Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { HumaneLogo } from "@/icons";
import { StatusMessage } from "@/components/Status";
import styles from "./login.module.css";

/**
 * The sign-in page.
 *
 * This deployment exposes one direct password sign-in action. The OIDC
 * callback remains available for authentication, but the page presents only
 * the form the wearer actually uses.
 */
function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  // Same-origin only — reject protocol-relative (`//host`) / scheme redirects so
  // the post-login navigation can't be steered off-site (open-redirect guard).
  const rawNext = params.get("next") || "/";
  const next =
    rawNext.startsWith("/") && !rawNext.startsWith("//") && !rawNext.startsWith("/\\")
      ? rawNext
      : "/";
  const error = params.get("error");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(
    error ? "We couldn't complete sign-in. Try again below." : null,
  );

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
      router.replace(next);
      router.refresh();
    } catch {
      setFormError("The service is unreachable. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.screen}>
      <aside className={styles.visual}>
        <Link className={styles.visualBrand} href="/welcome" aria-label="Ai Pin Revival home">
          <HumaneLogo size={27} />
          <span>Ai Pin Revival</span>
        </Link>
        <div className={styles.visualCopy}>
          <p>Center + Cosmos</p>
          <strong>Your Pin, ready when you are.</strong>
          <span>Private services. Familiar experience. Operated by you.</span>
        </div>
      </aside>

      <section className={styles.panel} aria-labelledby="sign-in-title">
        <div className={styles.card}>
          <Link className={styles.mobileBrand} href="/welcome" aria-label="Ai Pin Revival home">
            <HumaneLogo size={28} />
          </Link>
          <p className={styles.kicker}>Private Center</p>
          <h1 id="sign-in-title" className={styles.title}>Welcome back.</h1>
          <p className={styles.sub}>Sign in to see your Pin&rsquo;s memories, captures, and settings.</p>

          <form className={styles.form} onSubmit={submit}>
            <label className={styles.fieldRow}>
              <span>Email</span>
              <input
                className={styles.input}
                type="email"
                autoComplete="username"
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

          <p className={styles.foot}>Protected by this deployment&rsquo;s Keycloak.</p>
        </div>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
