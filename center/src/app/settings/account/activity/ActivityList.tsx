"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Activity } from "@/server/activity";
import settings from "../../settings.module.css";
import styles from "./activity.module.css";
import { dayHeading, dayKey, exactTime, relativeTime } from "./activityTime";

const ACTIVITY = "/settings/account/activity";

/**
 * Recent turns in plain words: when, from which kind of device, what happened.
 * There is no request text or reply here because the ledger keeps none.
 *
 * The server spells every time in UTC so the page reads with JavaScript off;
 * once it hydrates, the viewer's own clock takes over and the rows group into
 * their local days.
 */
export function ActivityList({ activity }: { activity: Activity }) {
  // `local` is false for the server pass and the first client render, so the
  // markup React hydrates is byte-identical; the clock arrives one tick later.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(tick);
  }, []);
  const local = now !== null;
  const clock = now ?? 0;

  const rows = activity.state === "ready" ? activity.rows : [];
  return <section className={settings.section} aria-label="Recent activity">
    <p className={styles.lead}>Every time you ask Cosmos, this shows where you asked and where the reply went.
      Cosmos keeps no record of what you asked or what it answered, so none appears here.</p>
    {activity.state !== "ready" ? <div className={styles.empty} role="status">
      <p className={styles.emptyTitle}>Recent activity could not be read</p>
      <p>Cosmos did not answer just now. Nothing has been lost.</p>
      <Link className={styles.emptyAction} href={ACTIVITY}>Try again</Link>
    </div>
      : rows.length === 0 ? <div className={styles.empty} role="status">
        <p className={styles.emptyTitle}>Nothing here yet</p>
        <p>Ask Cosmos from one of your devices and the turn appears here within seconds.</p>
        <Link className={styles.emptyAction} href="/settings/account/surfaces">Go to Devices</Link>
      </div>
        : <>
          {activity.unnamed ? <p className={styles.note} role="status">Some device lists could not be read, so some devices may show as removed.</p> : null}
          <ol className={styles.turns} aria-label="Recent turns">
            {rows.map((row, index) => {
              const opensDay = index === 0 || dayKey(rows[index - 1].startedAt, local) !== dayKey(row.startedAt, local);
              return <li key={row.turnId} className={styles.turn}>
                {opensDay ? <h2 className={styles.day}>{dayHeading(row.startedAt, clock, local)}</h2> : null}
                <div className={styles.row}>
                  <p className={styles.when}>
                    <time dateTime={new Date(row.startedAt).toISOString()} title={exactTime(row.startedAt, local)}>
                      {relativeTime(row.startedAt, clock, local)}
                    </time>
                  </p>
                  <p className={styles.asked}>{row.asked}</p>
                  <p className={styles.outcome}>{row.outcome}</p>
                  <details className={styles.why}>
                    <summary>Why</summary>
                    <div className={styles.reason}>
                      {/* What actually happened first: a confirmation, a device's own
                          report, a stop, a limit. Then where it could have gone. */}
                      {row.why.events.length ? <ul>{row.why.events.map((line, position) => <li key={position}>{line}</li>)}</ul> : null}
                      {row.why.candidates.length ? <ul>{row.why.candidates.map((line, position) => <li key={position}>{line}</li>)}</ul>
                        : <p>Cosmos recorded no device choice for this turn.</p>}
                      {/* What kind of reply it was, and which screen that kind belongs on. */}
                      {row.why.choice.length ? <ul>{row.why.choice.map((line, position) => <li key={position}>{line}</li>)}</ul> : null}
                      {row.why.hint ? <p>{row.why.hint}</p> : null}
                      <p>{row.why.privacy}</p>
                      {row.why.expression ? <p>Cosmos also said something shared-safe in its own words.</p> : null}
                    </div>
                  </details>
                </div>
              </li>;
            })}
          </ol>
        </>}
  </section>;
}
