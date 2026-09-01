import Link from "next/link";

import settings from "@/app/settings/settings.module.css";

/** Keeps every branch of the stock-Pin journey connected to its progress page. */
export function GuidedSetupReturn() {
  return (
    <section className={settings.section} data-testid="guided-setup-return">
      <div className={settings.additionRow}>
        <span className={settings.additionRowText}>
          <span className={settings.additionRowTitle}>Guided setup</span>
          <span className={settings.additionRowDesc}>
            Return to the checklist to verify this step and continue with the same Pin.
          </span>
        </span>
        <Link className={settings.additionLink} href="/settings/pin/setup">
          Continue guided setup
        </Link>
      </div>
    </section>
  );
}
