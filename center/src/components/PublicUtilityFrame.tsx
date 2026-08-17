"use client";

import Link from "next/link";

import { BackIcon } from "@/icons";
import buttons from "./buttons.module.css";
import { Shell } from "./Shell";
import styles from "./publicUtility.module.css";

/** One-column chrome for browser-local utilities that do not require a session. */
export function PublicUtilityFrame({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Shell
      showNav={false}
      showAiMic={false}
      showTopBar={false}
      showAccountMenu={false}
    >
      <div className={styles.layout}>
        <header className={styles.header}>
          <Link href="/" aria-label="Back to Center" className={buttons.circularButton}>
            <BackIcon size={20} />
          </Link>
          <h1>{title}</h1>
          <span aria-hidden />
        </header>
        {children}
      </div>
    </Shell>
  );
}
