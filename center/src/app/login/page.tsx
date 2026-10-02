"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { HumaneLogo } from "@/icons";
import { signInErrorNotice } from "@/lib/signInErrors";
import { SignInForm } from "@/components/SignInForm";
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
  // Same-origin only, reject protocol-relative (`//host`) / scheme redirects so
  // the post-login navigation can't be steered off-site (open-redirect guard).
  const rawNext = params.get("next") || "/";
  const next =
    rawNext.startsWith("/") && !rawNext.startsWith("//") && !rawNext.startsWith("/\\")
      ? rawNext
      : "/";
  const error = params.get("error");


  return (
    <main className={styles.screen}>
      <aside className={styles.visual}>
        <Link className={styles.visualBrand} href="/" aria-label="Luma home">
          <HumaneLogo size={27} />
          <span>Luma</span>
        </Link>
        <div className={styles.visualCopy}>
          <p>Self-hosted</p>
          <strong>Your Pin, on your server.</strong>
          <span>Your memories, notes, and captures are stored on this server.</span>
        </div>
      </aside>

      <section className={styles.panel} aria-labelledby="sign-in-title">
        <div className={styles.card}>
          <Link className={styles.mobileBrand} href="/" aria-label="Luma home">
            <HumaneLogo size={28} />
          </Link>
          <p className={styles.kicker}>Sign in</p>
          <h1 id="sign-in-title" className={styles.title}>Center</h1>
          <p className={styles.sub}>Memories, notes, captures, and settings for your Pin.</p>

          <SignInForm
            initialError={error ? signInErrorNotice(error) : null}
            onSuccess={() => { router.replace(next); router.refresh(); }}
          />
          <p className={styles.foot}>Your sign-in is saved on this browser.</p>

          <p className={styles.foot}>
            Forgot your password? The operator of this server can reset it with{" "}
            <code>./luma reset-password production</code>.
          </p>
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
