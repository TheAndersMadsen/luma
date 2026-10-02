"use client";

import Link from "next/link";

import { BackIcon } from "@/icons";
import { Shell } from "@/components/Shell";
import buttons from "@/components/buttons.module.css";
import { SettingsNav } from "./SettingsNav";
import styles from "./settings.module.css";

/** Shared settings master/detail chrome, including public utilities such as /wifi. */
export function SettingsFrame({
  children,
  title,
  group,
  backHref,
  backLabel,
  showAiMic = true,
  overview = false,
}: {
  children: React.ReactNode;
  title: string;
  group?: string;
  backHref: string;
  backLabel: string;
  showAiMic?: boolean;
  overview?: boolean;
}) {
  return (
    <Shell showAiMic={showAiMic}>
      <div className={`${styles.sysLayout} ${overview ? styles.settingsOverview : ""}`}>
        {!overview ? <aside className={styles.sysLayoutSidebar}>
          <SettingsNav />
        </aside> : null}

        <div role="article" className={styles.article}>
          <header className={styles.settingsPageHeader}>
            <div className={styles.settingsPageHeaderLeftButton}>
              <Link href={backHref} aria-label={backLabel}>
                <span className={buttons.circularButton}>
                  <BackIcon size={20} />
                </span>
              </Link>
            </div>
            <div className={styles.settingsPageHeaderTitleGroup}>
              <h1 className={styles.settingsPageHeaderTitle}>{title}</h1>
              {group && group !== title ? <span className={styles.settingsPageHeaderSubtitle}>{group}</span> : null}
            </div>
          </header>

          {children}
        </div>
      </div>
    </Shell>
  );
}
