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
      <main className={styles.main}>
        <div className={styles.intro}>
          <HumaneLogo size={28} />
          <p className={styles.eyebrow}>HTTP 404</p>
          <h1>Page not found</h1>
          <p className={styles.lede}>
            This address is not part of Ai Pin Revival Center. Agents can use the
            sitemap, llms.txt, or developer index to discover supported public resources.
          </p>
        </div>
        <ul className={styles.links}>
          <li><Link href="/sitemap.xml"><strong>Sitemap</strong></Link><span>Index of public human-readable pages.</span></li>
          <li><Link href="/llms.txt"><strong>llms.txt</strong></Link><span>Concise agent guidance and canonical resources.</span></li>
          <li><Link href="/developers"><strong>Developer index</strong></Link><span>CLI, OpenAPI, authentication, and deployment guidance.</span></li>
        </ul>
      </main>
    </div>
  );
}
