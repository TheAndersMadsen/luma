"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SectionSkeleton } from "@/components/States";
import { StatusChip, StatusMessage } from "@/components/Status";
import styles from "./admin.module.css";
import type {
  ConfigurationConstraint,
  ConfigurationInventory,
  ConfigurationProposalState,
  ConfigurationSettingState,
  ConfigurationState,
} from "./AdminTypes";

/**
 * Deployment configuration, and the only writer for it.
 *
 * SELF-CONTAINED, unlike the flags and provisioning panels whose state is
 * lifted into `page.tsx`. Those two depend on the console's overview — they are
 * unusable without COSMOS_ADMIN_TOKEN and a reachable backend, so they share its
 * loading and unconfigured states. This panel reads Center's OWN environment
 * and Center's own data volume, so it is exactly as available as the page
 * itself: when the backend is down, this is the pane that still answers, and
 * gating it on an overview it does not need would hide it precisely when an
 * operator is trying to work out why the backend is down.
 *
 * WHAT IT PROMISES. Nothing here is live. A saved change is a proposal recorded
 * in Center's data volume; the next deploy is what writes it into the protected
 * env file and restarts the container that reads it. Every editable row says so
 * in its own words, from the server's `effect`, rather than the panel implying
 * it once at the top and hoping the operator scrolls back.
 *
 * WHAT IT NEVER SHOWS. A value. The inventory carries names and a state from a
 * closed union and nothing else — no current value for any setting, secret or
 * not, and no length or prefix of one. The only values on this screen are the
 * ones an operator typed into it. A secret is therefore rendered as a row with
 * a state and an explanation of where to set it, never as a disabled input
 * holding dots: an operator who cannot find the setting goes and edits Compose
 * by hand, which is the out-of-band change the whole mechanism exists to avoid.
 */

const STATE_TONE: Record<ConfigurationState, "live" | "absent" | "degraded" | "off"> = {
  configured: "live",
  default: "off",
  missing: "degraded",
  unreadable: "degraded",
  unobservable: "absent",
};

const STATE_DETAIL: Record<ConfigurationState, string> = {
  configured: "Set in this container's environment.",
  default: "Not set; the coded default applies and nothing is broken.",
  missing: "Not set, and there is no fallback.",
  unreadable: "Set, but the path it names cannot be read from this container.",
  unobservable: "Lives in another container's environment; Center cannot see it from here.",
};

/** The constraint, said out loud. The same object the server validates against. */
function describeConstraint(constraint: ConfigurationConstraint): string {
  switch (constraint.kind) {
    case "integer":
      return `A whole number between ${constraint.minimum} and ${constraint.maximum} ${constraint.unit}.`;
    case "boolean":
      return 'Exactly "true" or "false".';
    case "origin":
      return `An origin only — ${constraint.schemes.join(" or ")}, host and port, no path.`;
    case "tokens":
      return `A space-separated list, at most ${constraint.maximum} entries${
        constraint.required.length > 0 ? `, and it must include ${constraint.required.join(" and ")}` : ""
      }.`;
    case "identifier":
      return `${constraint.shape[0].toUpperCase()}${constraint.shape.slice(1)}.`;
  }
}

type RowStatus = { tone: "danger" | "info"; message: string };

function ProposalRow({
  setting,
  constraint,
  proposal,
  busy,
  status,
  onSave,
  onWithdraw,
}: {
  setting: ConfigurationSettingState;
  /**
   * Passed separately rather than read off `setting`, so this component cannot
   * be rendered for a setting that has no constraint. A proposable setting
   * always has one — `verify/configuration-proposals.test.mjs` holds the
   * catalog to it — and the type here is what makes that a compile error
   * instead of a non-null assertion on the line that draws the input.
   */
  constraint: ConfigurationConstraint;
  proposal: ConfigurationProposalState | undefined;
  busy: boolean;
  status: RowStatus | null;
  onSave: (name: string, value: string) => void;
  onWithdraw: (name: string) => void;
}) {
  const [draft, setDraft] = useState(proposal?.value ?? "");
  // Re-seed when the store changes underneath — a save, a withdrawal, or
  // another operator's change picked up by a reload. Keyed remount would lose
  // an in-progress edit on every unrelated reload, which is how a form starts
  // eating what was typed into it.
  useEffect(() => {
    setDraft(proposal?.value ?? "");
  }, [proposal?.value, proposal?.proposedAt]);

  const unchanged = draft.trim() === (proposal?.value ?? "");

  return (
    <div className={styles.settingControl}>
      <div className={styles.settingInputRow}>
        <input
          className={styles.settingInput}
          value={draft}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          aria-label={`${setting.name} value to propose`}
          placeholder={setting.fallback ?? ""}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          type="button"
          className={styles.miniButton}
          disabled={busy || unchanged || draft.trim().length === 0}
          onClick={() => onSave(setting.name, draft.trim())}
        >
          {busy ? "Saving…" : proposal ? "Update" : "Save"}
        </button>
        {proposal ? (
          <button
            type="button"
            className={styles.miniButton}
            disabled={busy}
            onClick={() => onWithdraw(setting.name)}
          >
            Remove
          </button>
        ) : null}
      </div>
      <p className={styles.settingHint}>{describeConstraint(constraint)}</p>
      <p className={styles.settingHint}>{setting.effect.detail}</p>
      {proposal ? (
        <p className={styles.settingHint}>
          Proposed by {proposal.proposedByEmail ?? proposal.proposedBy} on{" "}
          {proposal.proposedAt.slice(0, 16).replace("T", " ")} UTC.{" "}
          {proposal.delivery === "applied"
            ? "This container already has this value, so a deploy has carried it."
            : proposal.delivery === "unconfirmable"
              ? "It belongs to another container's environment, so Center cannot confirm from here whether a deploy has carried it yet."
              : proposal.delivery === "refused"
                ? "The next deploy will REFUSE this file over this entry — remove it."
                : "Not applied yet."}{" "}
          Removing it stops Center re-asserting the value; it does not put the old one back.
        </p>
      ) : null}
      {status ? (
        <div className={styles.rowError}>
          <StatusMessage tone={status.tone} inline>
            {status.message}
          </StatusMessage>
        </div>
      ) : null}
    </div>
  );
}

export function AdminConfiguration() {
  const [inventory, setInventory] = useState<ConfigurationInventory | null>(null);
  const [proposals, setProposals] = useState<ConfigurationProposalState[]>([]);
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [error, setError] = useState<string | null>(null);
  /** Non-null while the store itself cannot be read; separate from a row error. */
  const [storeError, setStoreError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowStatus, setRowStatus] = useState<Record<string, RowStatus>>({});

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    const [inventoryResponse, proposalResponse] = await Promise.all([
      fetch("/api/admin/configuration", { cache: "no-store" }).catch(() => null),
      fetch("/api/admin/configuration/proposals", { cache: "no-store" }).catch(() => null),
    ]);
    if (!inventoryResponse?.ok) {
      setError(
        inventoryResponse
          ? `The dashboard answered ${inventoryResponse.status} for its own configuration.`
          : "The request did not complete — this browser could not reach the dashboard.",
      );
      setStatus("error");
      return;
    }
    setInventory((await inventoryResponse.json()) as ConfigurationInventory);

    // A store that cannot be read is NOT "no pending changes": the difference is
    // whether a save is about to overwrite entries nobody can see. The
    // inventory is still worth rendering, so this reports beside it.
    if (proposalResponse?.ok) {
      const body = (await proposalResponse.json()) as { proposals: ConfigurationProposalState[] };
      setProposals(body.proposals);
      setStoreError(null);
    } else {
      const body = proposalResponse
        ? ((await proposalResponse.json().catch(() => null)) as { error?: string } | null)
        : null;
      setProposals([]);
      setStoreError(
        body?.error ??
          "Pending changes could not be read from this deployment's data volume, so this pane cannot tell you what is already queued.",
      );
    }
    setStatus("ready");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byName = useMemo(
    () => new Map(proposals.map((proposal) => [proposal.name, proposal])),
    [proposals],
  );

  const write = useCallback(
    async (name: string, request: RequestInit) => {
      setBusy(name);
      setRowStatus((current) => {
        const next = { ...current };
        delete next[name];
        return next;
      });
      const response = await fetch("/api/admin/configuration/proposals", {
        ...request,
        headers: { "content-type": "application/json" },
      }).catch(() => null);
      setBusy(null);
      if (!response) {
        setRowStatus((current) => ({
          ...current,
          [name]: { tone: "danger", message: "The request did not complete, so nothing was saved." },
        }));
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setRowStatus((current) => ({
          ...current,
          // The server's own sentence, which names the constraint and what a
          // usable value would look like. Replacing it with "invalid value"
          // here would throw away the only part an operator can act on.
          [name]: { tone: "danger", message: body?.error ?? `The dashboard answered ${response.status}.` },
        }));
        return;
      }
      await load();
    },
    [load],
  );

  const save = useCallback(
    (name: string, value: string) =>
      void write(name, { method: "PUT", body: JSON.stringify({ name, value }) }),
    [write],
  );

  const withdraw = useCallback(
    (name: string) => void write(name, { method: "DELETE", body: JSON.stringify({ name }) }),
    [write],
  );

  const groups = useMemo(() => {
    const ordered = new Map<string, ConfigurationSettingState[]>();
    for (const setting of inventory?.settings ?? []) {
      const bucket = ordered.get(setting.group) ?? [];
      bucket.push(setting);
      ordered.set(setting.group, bucket);
    }
    return [...ordered.entries()];
  }, [inventory]);

  const pending = proposals.filter((proposal) => proposal.delivery !== "applied").length;
  const refused = proposals.filter((proposal) => proposal.delivery === "refused").length;

  /**
   * Pending entries with no row to sit in.
   *
   * A store entry naming a setting this build's catalog no longer carries has
   * no group, no impact and no descriptor — so the grouped list above cannot
   * render it, and without this the only control that could remove it would not
   * exist. That is the trap worth closing: the next deploy refuses the whole
   * file over exactly this entry, and an operator who cannot see it has no way
   * to deploy at all short of editing the file on the VPS.
   */
  const catalogued = useMemo(
    () => new Set((inventory?.settings ?? []).map((setting) => setting.name)),
    [inventory],
  );
  const orphaned = proposals.filter((proposal) => !catalogued.has(proposal.name));

  return (
    <section className={styles.card} id="configuration">
      <div className={styles.flagsHead}>
        <div>
          <h2>Deployment configuration</h2>
          <p className={styles.muted}>
            What this deployment is configured with, and the settings you can change from here. A
            change is saved as a pending value and applied by the next deploy — the protected env
            files are fingerprinted into every deployment record, so writing one out of band would
            leave rollback unable to trust its own evidence. Nothing on this pane shows a current
            value, for any setting.
          </p>
        </div>
        <button type="button" className={styles.miniButton} onClick={() => void load()}>
          Reload
        </button>
      </div>

      {storeError ? (
        <div className={styles.panelError}>
          <StatusMessage tone="warning">{storeError}</StatusMessage>
        </div>
      ) : null}
      {refused > 0 ? (
        <div className={styles.panelError}>
          <StatusMessage tone="danger">
            {refused} pending {refused === 1 ? "change names a setting" : "changes name settings"} this
            build no longer accepts. The next deploy refuses the whole file rather than guess, so remove
            {refused === 1 ? " it" : " them"} before deploying.
          </StatusMessage>
        </div>
      ) : null}
      {status === "ready" && pending > 0 ? (
        <div className={styles.panelError}>
          <StatusMessage tone="info">
            {pending} pending {pending === 1 ? "change is" : "changes are"} waiting for the next deploy.
            Nothing about the running system has changed.
          </StatusMessage>
        </div>
      ) : null}

      {orphaned.length > 0 ? (
        <ul className={styles.settingList}>
          {orphaned.map((proposal) => (
            <li key={proposal.name} className={styles.settingRow}>
              <div className={styles.settingName}>
                <code>{proposal.name}</code>
                <StatusChip tone="degraded" variant="tag" label="not in this build" />
              </div>
              <p className={styles.settingImpact}>
                This deployment has no setting by that name, so nothing here can validate or apply it.
              </p>
              <div className={styles.settingInputRow}>
                <button
                  type="button"
                  className={styles.miniButton}
                  disabled={busy === proposal.name}
                  onClick={() => withdraw(proposal.name)}
                >
                  Remove
                </button>
              </div>
              {rowStatus[proposal.name] ? (
                <div className={styles.rowError}>
                  <StatusMessage tone={rowStatus[proposal.name].tone} inline>
                    {rowStatus[proposal.name].message}
                  </StatusMessage>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {status === "loading" ? <SectionSkeleton rows={6} /> : null}
      {status === "error" ? (
        <StatusMessage tone="warning" onRetry={() => void load()}>
          {error ?? "The configuration inventory could not be read."}
        </StatusMessage>
      ) : null}

      {status === "ready" && inventory
        ? groups.map(([group, settings]) => (
            <div key={group} className={styles.settingGroup}>
              <h3 className={styles.settingGroupHead}>{group}</h3>
              <ul className={styles.settingList}>
                {settings.map((setting) => {
                  const proposal = byName.get(setting.name);
                  return (
                    <li key={setting.name} className={styles.settingRow}>
                      <div className={styles.settingName}>
                        <code>{setting.name}</code>
                        <StatusChip
                          tone={STATE_TONE[setting.state]}
                          label={setting.state}
                          detail={STATE_DETAIL[setting.state]}
                        />
                        {setting.sensitivity !== "operational" ? (
                          <StatusChip tone="absent" variant="tag" label={setting.sensitivity} />
                        ) : null}
                        {proposal ? (
                          <StatusChip
                            tone={proposal.delivery === "applied" ? "live" : "degraded"}
                            variant="tag"
                            label={
                              proposal.delivery === "applied"
                                ? "applied"
                                : proposal.delivery === "refused"
                                  ? "refused"
                                  : "pending"
                            }
                          />
                        ) : null}
                      </div>
                      <p className={styles.settingImpact}>{setting.impact}</p>
                      {setting.writable === "proposable" && setting.constraint ? (
                        <ProposalRow
                          setting={setting}
                          constraint={setting.constraint}
                          proposal={proposal}
                          busy={busy === setting.name}
                          status={rowStatus[setting.name] ?? null}
                          onSave={save}
                          onWithdraw={withdraw}
                        />
                      ) : null}
                      {/* Never a disabled input. A greyed-out field reads as
                          "this will be editable later"; the sentence says where
                          the setting actually lives, which is what stops an
                          operator going to the VPS and editing Compose by hand. */}
                      {setting.guidance ? (
                        <p className={styles.settingGuidance}>{setting.guidance}</p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        : null}
    </section>
  );
}
