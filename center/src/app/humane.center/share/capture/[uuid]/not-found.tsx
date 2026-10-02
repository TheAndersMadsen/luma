import { HumaneLogo } from "@/icons";
import Link from "next/link";
import styles from "./share.module.css";

/**
 * A forged, expired, or malformed share link, or one whose capture is gone.
 * The page calls `notFound()` for these, so the answer is a real 404 with the
 * same sentence the page used to show under a 200.
 */
export default function SharedCaptureNotFound() {
  return (
    <main className={styles.stage}>
      <header className={styles.chrome}>
        <Link href="/" className={styles.brand} aria-label="Luma home">
          <HumaneLogo size={20} />
        </Link>
      </header>
      <div className={styles.unavailable} data-testid="share-unavailable">
        <h1 className={styles.unavailableTitle}>
          This share link isn&rsquo;t valid or has expired.
        </h1>
        <p className={styles.unavailableDetail}>Ask the person who shared it for a new link.</p>
        <Link href="/" className={styles.retry}>Open Center</Link>
      </div>
    </main>
  );
}
