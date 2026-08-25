"use client";

import { useRouter } from "next/navigation";

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
  const router = useRouter();

  function goBack() {
    if (window.history.length > 1) {
      router.back();
      return;
    }
    router.replace("/");
  }

  return (
    <Shell
      showNav={false}
      showAiMic={false}
      showTopBar={false}
      showAccountMenu={false}
    >
      <div className={styles.layout}>
        <header className={styles.header}>
          <button type="button" aria-label="Go back" className={buttons.circularButton} onClick={goBack}>
            <BackIcon size={20} />
          </button>
          <h1>{title}</h1>
          <span aria-hidden />
        </header>
        {children}
      </div>
    </Shell>
  );
}
