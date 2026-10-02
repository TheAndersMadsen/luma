import styles from "../../settings.module.css";
import editor from "./security.module.css";

/**
 * The Center sign-in password lives in the identity service (Keycloak), which
 * Center already serves at its own origin under /realms/<realm>. Changing it
 * happens on Keycloak's own signing-in page, so Center never sees or stores the
 * password. A plain link keeps this usable without JavaScript.
 */
export function PasswordSection({ realm }: { realm: string }) {
  const href = `/realms/${encodeURIComponent(realm)}/account/account-security/signing-in`;
  return (
    <section className={styles.section} data-testid="centerPassword">
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>Center password</span>
      </div>
      <div className={editor.editor}>
        <p className={editor.hint}>
          Change the password you use to sign in to Center. It opens the sign-in settings of your
          identity service in this tab.
        </p>
        <div className={editor.actions}>
          <a className={editor.primaryButton} href={href} data-testid="changePassword">
            Change password
          </a>
        </div>
      </div>
    </section>
  );
}
