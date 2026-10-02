"use client";

/*
 * The operator's update banner (INFERRED: humane.center never updated
 * itself). Shown only to a session the server calls an operator, and only
 * when there is something new: a newer Luma on the update source, or Pin apps
 * newer than the ones Software & updates last read from the Pin. It never
 * holds a page: it asks `GET /api/admin/updates` after render, and a
 * non-operator never makes that request. Dismissing is per version and
 * stays in this browser.
 */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useOperatorEntitlement } from "@/app/settings/useOperatorEntitlement";
import { updateOverviewSchema, type UpdateOverview } from "@/lib/contracts/updates";
import { dismissNotice, dismissedNotice, rememberedPinRelease } from "@/lib/updateNotices";
import {
  PIN_SOFTWARE_HREF,
  UPDATE_COMMAND,
  UPDATES_SETTINGS_HREF,
  describeNextStep,
  updateNotice,
} from "@/lib/updatesPresentation";
import { CopyCommand } from "./CopyCommand";
import styles from "./updateBanner.module.css";

const TEN_MINUTES = 10 * 60 * 1000;

async function fetchOverview(): Promise<UpdateOverview | null> {
  const response = await fetch("/api/admin/updates", { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return null;
  const parsed = updateOverviewSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

export function UpdateBanner() {
  const operator = useOperatorEntitlement();
  const { data: overview } = useQuery({
    queryKey: ["center-updates"],
    queryFn: fetchOverview,
    enabled: operator,
    retry: false,
    staleTime: TEN_MINUTES,
  });
  // Browser storage is read after mount so the server render and the first
  // client render agree (both show nothing).
  const [stored, setStored] = useState<{ pin: string | null; dismissed: string | null } | null>(null);
  useEffect(() => {
    setStored({ pin: rememberedPinRelease(), dismissed: dismissedNotice() });
  }, []);

  if (!operator || !overview || !stored) return null;
  const notice = updateNotice(overview, stored.pin);
  if (!notice || notice.key === stored.dismissed) return null;

  return (
    <aside className={styles.banner} aria-label="Updates" data-testid="update-banner">
      <div className={styles.body}>
        {notice.center ? (
          <section className={styles.notice} data-testid="update-banner-center">
            <p className={styles.title}>Luma {notice.center.latest.version} is available</p>
            {notice.center.latest.notes ? (
              <details className={styles.notes}>
                <summary>What’s new</summary>
                <p className={styles.notesBody}>{notice.center.latest.notes}</p>
              </details>
            ) : null}
            {notice.center.autoUpdates === "on" ? (
              <p className={styles.copy}>{describeNextStep("on")}</p>
            ) : (
              <>
                <p className={styles.copy}>To install it, run this on your server:</p>
                <CopyCommand command={UPDATE_COMMAND} label="update command" />
                <Link href={UPDATES_SETTINGS_HREF} className={styles.link}>
                  Software updates
                </Link>
              </>
            )}
          </section>
        ) : null}
        {notice.pin ? (
          <section className={styles.notice} data-testid="update-banner-pin">
            <p className={styles.title}>New Pin apps are ready</p>
            <p className={styles.copy}>
              Your server offers {notice.pin.offered}; your Pin has {notice.pin.onPin}.
            </p>
            <Link href={PIN_SOFTWARE_HREF} className={styles.link}>
              Update your Pin
            </Link>
          </section>
        ) : null}
      </div>
      <button
        type="button"
        className={styles.dismiss}
        onClick={() => {
          dismissNotice(notice.key);
          setStored({ ...stored, dismissed: notice.key });
        }}
      >
        Dismiss
      </button>
    </aside>
  );
}
