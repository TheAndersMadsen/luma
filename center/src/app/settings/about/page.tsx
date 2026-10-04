import styles from "../settings.module.css";

import { COMMUNITY_DISCORD_URL } from "@/lib/community";
import { centerRuntimeIdentity } from "@/lib/runtimeIdentity";

export const dynamic = "force-dynamic";

export const metadata = { title: "Humane Center" };

/**
 * The nav and the settings information architecture both offer "About this
 * Center", so this has to be a real pane. It reports the exact immutable
 * release this deployment is running, the same identity `/api/version`
 * serves, because that is the one fact an operator needs when comparing a
 * dashboard against a Pin or a deployment record.
 */
export default function AboutPage() {
  const { release, environment } = centerRuntimeIdentity();

  return (
    <>
      <section className={styles.section} data-testid="about-center">
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>About this Center</span>
        </div>
        <div className={styles.infoRowRoot}>
          <span className={styles.titleInfo} data-testid="info-row-title">
            Product
          </span>
          <div className={styles.descWrapper}>
            <span className={styles.description}>Luma Center</span>
            <span className={styles.muted}>
              Your Ai Pin dashboard.
            </span>
          </div>
        </div>
        <div className={styles.infoRowRoot}>
          <span className={styles.titleInfo} data-testid="info-row-title">
            Release
          </span>
          <div className={styles.descWrapper}>
            <span className={styles.description} data-testid="about-release">
              {release}
            </span>
            <span className={styles.muted}>
              Running release.
            </span>
          </div>
        </div>
        <div className={styles.infoRowRoot}>
          <span className={styles.titleInfo} data-testid="info-row-title">
            Environment
          </span>
          <div className={styles.descWrapper}>
            <span className={styles.description} data-testid="about-environment">
              {environment}
            </span>
          </div>
        </div>
        <div className={styles.infoRowRoot}>
          <span className={styles.titleInfo} data-testid="info-row-title">
            Community
          </span>
          <div className={styles.descWrapper}>
            <a className={styles.description} href={COMMUNITY_DISCORD_URL} target="_blank" rel="noopener noreferrer" data-testid="about-community">
              reHumane Discord
            </a>
            <span className={styles.muted}>
              Luma&apos;s official community for help and release news.
            </span>
          </div>
        </div>
      </section>
    </>
  );
}
