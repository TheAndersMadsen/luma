"use client";

import { SessionReconnect } from "@/components/SessionReconnect";
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import styles from "../../settings.module.css";
import editor from "./details.module.css";
import { SectionSkeleton } from "@/components/States";
import { StatusMessage } from "@/components/Status";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { accountDetailsViewSchema } from "@/lib/contracts/account";
import { parseResponse } from "@/lib/contracts/parse";


export function DetailsView() {
  const [editing, setEditing] = useState(false);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["account-details"],
    queryFn: async () => {
      const response = await fetch("/api/account/details");
      if (!response.ok) throw new Error(`account details returned ${response.status}`);
      return parseResponse(accountDetailsViewSchema, await response.json());
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
   * /api/account/details answers 200 whatever happens, its own comment says
   * so, and says why: preferred name, pronunciation and the sealed-bio flag are
   * the only fields the account RPC serves, and when it does not answer the
   * route still returns 200 with nulls in their place. `isError` is therefore
   * false on every failure and the arm above never runs.
   *
   * Left to the row values alone, a dead account workload, or a Keycloak grant
   * that expired behind a still-valid Center cookie, rendered as "No personal
   * details have been added yet." A wearer who had set a preferred name and a
   * pronunciation on their Pin was told, in the same typography as a healthy
   * read, that they had set nothing. The "Bio data, Available on your Ai Pin"
   * row simply vanished for a wearer who does hold sealed bio data, because a
   * degraded read spells that flag `false`. And the Sign in section kept
   * rendering (its email comes from the cookie, not the RPC), so the pane looked
   * entirely healthy while every backend-served field was missing.
   *
   * Nothing else on screen would have covered for it. <SourceBadge> is gated on
   * `showNav`, and settings/layout.tsx mounts the Shell with showNav={false}, so
   * no settings pane gets the chrome badge. And /api/health probes the events
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
          {/* Only a live read can be edited: saving over a failed read would
              replace values the wearer could not see. */}
          {data.state === "live" && !editing ? (
            <button type="button" className={editor.editButton} onClick={() => setEditing(true)}>
              Edit
            </button>
          ) : null}
        </div>
        {editing ? (
          <ProfileEditor
            preferredName={data.preferredName ?? ""}
            pronunciation={data.pronunciation ?? ""}
            suggestedName={data.firstName ?? null}
            onDone={() => setEditing(false)}
          />
        ) : null}
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
              here has been removed. <SessionReconnect /> to see them.
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
            Connect your Pin to see personal details.
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

/**
 * Preferred name and pronunciation, the two fields the Pin reads from the
 * account (`GetUserPersonalDetails`). First and last name come from sign-in
 * and are not edited here.
 */
function ProfileEditor({
  preferredName,
  pronunciation,
  suggestedName,
  onDone,
}: {
  preferredName: string;
  pronunciation: string;
  suggestedName: string | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(preferredName);
  const [ipa, setIpa] = useState(pronunciation);
  const dirty = name !== preferredName || ipa !== pronunciation;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<"expired" | "tooLong" | "refused" | "failed" | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch("/api/account/details", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preferredName: name, pronunciation: ipa }),
      });
      if (response.ok) {
        await queryClient.invalidateQueries({ queryKey: ["account-details"] });
        onDone();
        return;
      }
      setProblem(
        response.status === 401
          ? "expired"
          : response.status === 413
            ? "tooLong"
            : response.status === 400
              ? "refused"
              : "failed",
      );
    } catch {
      setProblem("failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={editor.editor} onSubmit={(event) => void save(event)} data-testid="profileEditor">
      <UnsavedChangesGuard when={dirty} />
      <label>
        Preferred name
        <input
          className={editor.field}
          value={name}
          readOnly={busy}
          maxLength={100}
          placeholder={suggestedName ?? ""}
          autoComplete="nickname"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <p className={editor.hint}>
        Your Ai Pin uses this name, and calls itself “{name.trim() || "your"}’s Ai Pin” over
        Bluetooth from its next setup.
      </p>
      <label>
        Pronunciation
        <input
          className={editor.field}
          value={ipa}
          readOnly={busy}
          maxLength={100}
          lang="und-fonipa"
          onChange={(event) => setIpa(event.target.value)}
        />
      </label>
      <p className={editor.hint}>Write the pronunciation in the International Phonetic Alphabet (IPA).</p>
      {problem === "expired" ? (
        <StatusMessage tone="warning">
          Your changes are still here. <SessionReconnect onReconnected={() => setProblem(null)} /> to save them.
        </StatusMessage>
      ) : problem === "tooLong" ? (
        <StatusMessage tone="warning">That is too long to save. Nothing was changed.</StatusMessage>
      ) : problem === "refused" ? (
        <StatusMessage tone="warning">
          Names can’t contain control characters. Nothing was changed.
        </StatusMessage>
      ) : problem === "failed" ? (
        <StatusMessage tone="warning">Your details couldn’t be saved. Nothing was changed.</StatusMessage>
      ) : null}
      <div className={editor.actions}>
        <button type="submit" className={editor.primaryButton} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className={editor.secondaryButton} disabled={busy} onClick={() => {
          if (!dirty || window.confirm("Discard your changes to your personal details?")) onDone();
        }}>
          Cancel
        </button>
      </div>
    </form>
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
