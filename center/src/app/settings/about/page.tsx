import styles from "../settings.module.css";

export const dynamic = "force-dynamic";

export const metadata = { title: "Humane Center" };

/**
 * The nav and the settings information architecture both offer "About this
 * Center", so this has to be a real pane. It reports the exact immutable
 * release this deployment is running — the same identity `/api/version`
 * serves — because that is the one fact an operator needs when comparing a
 * dashboard against a Pin or a deployment record.
 */
export default function AboutPage() {
  const release = process.env.REVIVAL_RELEASE_ID ?? "unknown";
  const environment = process.env.REVIVAL_DEPLOYMENT_ENVIRONMENT ?? "unknown";

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
            <span className={styles.description}>Ai Pin Revival Center</span>
            <span className={styles.muted}>
              An operator-owned dashboard for a Humane Ai Pin. It is not affiliated with Humane.
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
              The immutable release identity this deployment is serving.
            </span>
          </div>
        </div>
        <div className={styles.infoRowRoot}>
          <span className={styles.titleInfo} data-testid="info-row-title">
            Environment
          </span>
          <div className={styles.descWrapper}>
            <span className={styles.description}>{environment}</span>
          </div>
        </div>
      </section>
    </>
  );
}
