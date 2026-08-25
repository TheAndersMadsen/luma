import type { Metadata } from "next";
import Link from "next/link";

import { HumaneLogo } from "@/icons";
import styles from "@/components/public-page.module.css";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <div className={styles.screen}>
      <main className={styles.notFound}>
        <Link
          className={`${styles.brand} ${styles.notFoundBrand}`}
          href="/"
          aria-label="Ai Pin Revival home"
        >
          <HumaneLogo size={28} />
          <span>Ai Pin Revival</span>
        </Link>
        <p className={styles.eyebrow}>404 · Wrong turn</p>
        <h1>Page not found</h1>
        <p className={styles.lede}>
          This address is not part of Center. Continue from the public index, or use
          the machine-readable resources below to find a supported route.
        </p>
        <ul className={styles.links}>
          <li>
            <Link href="/sitemap.xml" aria-label="Sitemap">
              <strong>Sitemap</strong>
              <span>Every public human-readable page.</span>
              <span className={styles.linkArrow} aria-hidden="true">→</span>
            </Link>
          </li>
          <li>
            <Link href="/llms.txt" aria-label="llms.txt">
              <strong>llms.txt</strong>
              <span>Agent guidance and canonical resources.</span>
              <span className={styles.linkArrow} aria-hidden="true">→</span>
            </Link>
          </li>
          <li>
            <Link href="/developers" aria-label="Developer index">
              <strong>Developer index</strong>
              <span>CLI, OpenAPI, authentication, and deployment.</span>
              <span className={styles.linkArrow} aria-hidden="true">→</span>
            </Link>
          </li>
        </ul>
      </main>
    </div>
  );
}
