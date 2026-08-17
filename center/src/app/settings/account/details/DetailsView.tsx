"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import styles from "../../settings.module.css";
import { SectionSkeleton } from "@/components/States";
import { StatusMessage } from "@/components/Status";

interface AccountDetails {
  preferredName: string | null;
  pronunciation: string | null;
  hasSecureBioData: boolean;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  state?: "live" | "absent" | "degraded";
  degraded?: string;
  /** The account RPC failed because the wearer's Keycloak grant died. */
  reauthenticate?: true;
}

export function DetailsView() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["account-details"],
    queryFn: async () => {
      const response = await fetch("/api/account/details");
      if (!response.ok) throw new Error(`account details returned ${response.status}`);
      return (await response.json()) as AccountDetails;
    },
    staleTime: 10_000,
  });

  if (isLoading) {
    return (
      <>
        <SectionSkeleton rows={4} />
        <SectionSkeleton rows={2} />
      </>
    );
  }

  if (isError || !data) {
    return (
      <StatusMessage tone="warning" onRetry={() => void refetch()}>
        Your account details couldn&rsquo;t be loaded just now.
      </StatusMessage>
    );
  }

  const personalRows: Array<[string, string | null | undefined]> = [
    ["First name", data.firstName],
    ["Last name", data.lastName],
    ["Preferred name", data.preferredName],
    ["Pronunciation", data.pronunciation],
  ];
  const hasPersonal = personalRows.some(([, value]) => Boolean(value));

  /*
   * WHY THIS PANE READS `state`.
   *
   * /api/account/details answers 200 whatever happens — its own comment says
   * so, and says why: preferred name, pronunciation and the sealed-bio flag are
   * the only fields the account RPC serves, and when it does not answer the
   * route still returns 200 with nulls in their place. `isError` is therefore
   * false on every failure and the arm above never runs.
   *
   * Left to the row values alone, a dead account workload — or a Keycloak grant
   * that expired behind a still-valid Center cookie — rendered as "No personal
   * details have been added yet." A wearer who had set a preferred name and a
   * pronunciation on their Pin was told, in the same typography as a healthy
   * read, that they had set nothing; the "Bio data — Available on your Ai Pin"
   * row simply vanished for a wearer who does hold sealed bio data, because a
   * degraded read spells that flag `false`; and the Sign in section kept
   * rendering (its email comes from the cookie, not the RPC), so the pane looked
   * entirely healthy while every backend-served field was missing.
   *
   * Nothing else on screen would have covered for it. <SourceBadge> is gated on
   * `showNav`, and settings/layout.tsx mounts the Shell with showNav={false}, so
   * no settings pane gets the chrome badge; and /api/health probes the events
   * workload, not the account one, so an account-only outage leaves it "live".
   * This branch is the wearer's only signal.
   */
  const degraded = data.state === "degraded";
  const absent = data.state === "absent";

  return (
    <>
      <section className={styles.section} data-testid="personalDetails">
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>Personal Information</span>
        </div>
        {hasPersonal
          ? personalRows.map(([label, value]) =>
              value ? <InfoRow key={label} label={label} value={value} /> : null,
            )
          : null}
        {degraded ? (
          data.reauthenticate ? (
            /* The one cause the wearer can clear, and the one a reload cannot:
               the Center cookie is still valid, so nothing redirects them. */
            <StatusMessage tone="warning">
              Your session expired, so your account details couldn&rsquo;t be read. Nothing
              here has been removed. <Link href="/login">Sign in again</Link> to see them.
            </StatusMessage>
          ) : (
            <StatusMessage tone="warning" onRetry={() => void refetch()}>
              Your account details couldn&rsquo;t be read just now, so anything you have set
              on your Pin is missing from this section rather than unset.
            </StatusMessage>
          )
        ) : absent ? (
          /* Absent is a fact about this deployment, not a runtime failure, so it
             never offers a retry. */
          <StatusMessage tone="info">
            Connect your Pin to view personal details.
          </StatusMessage>
        ) : hasPersonal ? null : (
          <div className={styles.stateRow}>No personal details have been added yet.</div>
        )}
        {data.hasSecureBioData ? (
          <InfoRow label="Bio data" value="Available on your Ai Pin" />
        ) : null}
      </section>

      {data.username ? (
        <section className={styles.section} data-testid="loginDetails">
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>Sign in</span>
          </div>
          <InfoRow label="Email" value={data.username} />
        </section>
      ) : null}

    </>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.infoRowRoot}>
      <span className={styles.titleInfo} data-testid="info-row-title">
        {label}
      </span>
      <div className={styles.descWrapper}>
        <span className={styles.description}>{value}</span>
      </div>
    </div>
  );
}
