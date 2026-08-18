"use client";

import Link from "next/link";
import { Shell } from "@/components/Shell";
import { Page, PageHeader } from "@/components/Page";
import { CardsSkeleton, EmptyState, ErrorState } from "@/components/States";
import { StatusMessage } from "@/components/Status";
import styles from "@/components/views.module.css";
import { AiMicIcon, MusicIcon, PhoneIcon, TranslationIcon } from "@/icons";
import { useMyDataOverview } from "@/lib/queries";

const ICONS: Record<string, React.ReactNode> = {
  AI_MIC: <AiMicIcon size={22} />,
  CALL: <PhoneIcon size={22} />,
  MUSIC: <MusicIcon size={22} />,
  TRANSLATION: <TranslationIcon size={22} />,
};

export default function MyDataPage() {
  const { data, isLoading, isError, error, refetch } = useMyDataOverview();

  if (isLoading) {
    return (
      <Shell>
        <Page width="content">
          {/* the same 260px overview grid the four tiles land in */}
          <CardsSkeleton variant="myData" count={4} />
        </Page>
      </Shell>
    );
  }

  if (isError || !data) {
    return (
      <Shell>
        <Page width="content">
          <ErrorState
            title="Couldn't load My Data"
            detail={error instanceof Error ? error.message : undefined}
            onRetry={() => refetch()}
          />
        </Page>
      </Shell>
    );
  }

  if (data.data.length === 0) {
    return (
      <Shell>
        <Page width="content">
          {data.state === "live" ? (
            <EmptyState
              icon={<AiMicIcon size={48} />}
              title="Nothing here yet"
              detail="Ai Mic requests, calls, music, and translations will appear here after your Pin syncs them."
            />
          ) : data.state === "degraded" ? (
            <StatusMessage tone="warning" onRetry={() => refetch()}>
              Couldn&rsquo;t load activity from your Pin.
            </StatusMessage>
          ) : (
            /* Absent is not a failure and not retryable — offering "Try again"
               for a backend that was never configured sends the wearer chasing
               an outage that does not exist. */
            <StatusMessage tone="info">
              Connect your Pin to see activity.
            </StatusMessage>
          )}
        </Page>
      </Shell>
    );
  }

  /*
   * A total the backend could only count so far.
   *
   * There is no count RPC on DeviceEventsHistoryService, so getMyDataOverview's
   * "Total" is the LENGTH of a capped QueryEvents page. When a domain reaches
   * that cap the route says so in its provenance (`x-data-degraded`) while
   * staying `live` — the read succeeded, the number is just a lower bound. This
   * page discarded that sentence and printed the sum as a fact, so a wearer past
   * the cap watched their totals freeze with no explanation, which looks exactly
   * like a stalled backend. Qualify the headline and contain the reason verbatim.
   */
  const cappedNote = data.state === "live" ? data.degraded : undefined;
  const sum = data.data.reduce((total, entry) => total + entry.total, 0);

  return (
    <Shell>
      <Page width="content">
        <PageHeader
          title="My Data"
          description="Your recent Pin activity, grouped by experience."
          meta={cappedNote ? `at least ${sum} total` : `${sum} total`}
        />
        {cappedNote ? <StatusMessage tone="info">{cappedNote}</StatusMessage> : null}
        <div className={styles.myDataOverviewCenteringContainer}>
          <div className={styles.myDataOverviewGridContainer}>
            {data.data.map((entry) => (
              <Link key={entry.key} href={entry.href}>
                <div className={styles.overviewTile}>
                  {/* icon-only head: the recovered overview DOM did NOT keep the
                      domain name up here — it sits between the Today value and the
                      Total label below (order: Today / value / NAME / Total / value). */}
                  <div className={styles.overviewTileHead}>{ICONS[entry.key]}</div>
                  {/* DOM order is the recovered one — Today / value / NAME /
                      Total / value. The tile places them with grid areas so the
                      name gets its own line above the two stats: as a single
                      flex row, a long name ("Translation") pushed the Total
                      column past the card's padding box and clipped it. */}
                  <div className={styles.overviewStats}>
                    <div className={styles.overviewStatToday}>
                      <div className={styles.overviewStatLabel}>Today</div>
                      <p className={styles.overviewStatValue}>{entry.today}</p>
                    </div>
                    <span className={styles.overviewTileName}>{entry.label}</span>
                    <div className={styles.overviewStatTotal}>
                      <div className={styles.overviewStatLabel}>Total</div>
                      <p className={styles.overviewStatValue}>{entry.total}</p>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </Page>
    </Shell>
  );
}
