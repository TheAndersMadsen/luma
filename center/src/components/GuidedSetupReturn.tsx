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
            Setting up a new Pin? The checklist confirms this step and shows what comes next.
          </span>
        </span>
        <Link className={settings.additionLink} href="/settings/pin/setup">
          Open Guided setup
        </Link>
      </div>
    </section>
  );
}
