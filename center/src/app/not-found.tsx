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
          aria-label="Luma home"
        >
          <HumaneLogo size={28} />
          <span>Luma</span>
        </Link>
        <h1>Page not found</h1>
        <p className={styles.lede}>This address is not part of this Center.</p>
        <ul className={styles.links}>
          <li>
            <Link href="/" aria-label="Open Center">
              <strong>Open Center</strong>
              <span>Your memories, captures, and notes.</span>
              <span className={styles.linkArrow} aria-hidden="true">→</span>
            </Link>
          </li>
          <li>
            <Link href="/llms.txt" aria-label="llms.txt">
              <strong>llms.txt</strong>
              <span>Agent guidance and this server's public files.</span>
              <span className={styles.linkArrow} aria-hidden="true">→</span>
            </Link>
          </li>
        </ul>
      </main>
    </div>
  );
}
