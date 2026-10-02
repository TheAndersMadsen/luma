"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import settings from "../settings.module.css";
import styles from "./privacy.module.css";
import { SectionSkeleton } from "@/components/States";
import { StatusMessage, Switch } from "@/components/Status";
import { DeleteAccount } from "./DeleteAccount";
import type { DataState } from "@/lib/contracts/dataSource";
import { privacyDetailsSchema, type PrivacyDetails } from "@/lib/contracts/privacy";

// Mirrors the shape returned by /api/settings/privacy. Declared locally so this
// client component never pulls the server-only route module into its bundle.
interface PrivacySetting {
  name: string;
  value: string;
  status?: string;
}

/**
 * Stock humaneinternal.system.privacy.client.PrivacyClient.getSettings and
 * PrivacySettingsWorker.execute sync these preferences with PublicPrivacyService.
 * Luma owns the labels and unavailable grouping (INFERRED presentation), while
 * the server remains authoritative for values and the stock wire keys.
 */

interface SettingsResponse {
  settings: PrivacySetting[];
  /** live: your settings, possibly none. absent: nothing is configured to answer.
   *  degraded: something is configured and it did not answer. */
  state?: DataState;
  unavailable?: boolean;
  degraded?: string;
}

const TRUTHY = new Set(["true", "1", "on", "enabled", "yes"]);
function isOn(value: string): boolean {
  return TRUTHY.has(value.trim().toLowerCase());
}

/** "ai_mic_search_history" → "Ai Mic Search History". */
function humanize(name: string): string {
  // Luma presentation label. The stock privacy-setting key stays unchanged.
  if (name === "v1p0_defaults") return "Default privacy settings";
  return name
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => (w.toLowerCase() === "ai" ? "Ai" : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

// Stock humaneinternal.system.coordination.impl.NotableEventsAccessImpl
// .uploadNotableEvent reads save_event_location; .uploadNotableEventInner adds
// location to new Pin app events only when it is on. Central events omit it.
// INFERRED Luma enforcement extends consent to cloud ingest/providers and the
// wearer-only last-location/diagnostic view. Standard sync follows the stock
// PrivacyDatabase_Impl.createAllTables UploadableKey predicate. History rows stay;
// PrivacyClientListener.updatePrivacyService may revoke their durable keys when
// no enabled setting matches the stock RevocableKey predicate.
const PRIVACY_CHOICES: Record<string, { label: string; description: string }> = {
  save_event_location: {
    label: "Save activity location",
    description: "Include your location with new activity recorded on your Pin.",
  },
  last_location: {
    label: "Save last location",
    description: "Keep the latest location your Pin sends for location-based requests.",
  },
  location: {
    label: "Location access",
    description: "Use your Pin’s location for nearby places, weather and directions in Luma.",
  },
  share_capture_location: {
    label: "Location in shared photos",
    description: "Include embedded location information in photos you share.",
  },
  traces: {
    label: "Save diagnostics",
    description: "Keep the latest assistant outcome and timing for troubleshooting. Your words and answers aren’t included.",
  },
  v1p0_defaults: {
    label: "Standard data sync",
    description: "Allow Pin data keys to sync to your server. Other privacy choices can allow specific data.",
  },
};

const DIAGNOSTIC_OUTCOMES: Record<string, string> = {
  answered: "Answered",
  device_action: "Sent to your Pin",
  clarification: "Asked for more information",
  confirmation_required: "Waiting for confirmation",
  locked: "Pin was locked",
  blocked: "Stopped by a setting",
  cancelled: "Request cancelled",
  superseded: "Replaced by a new request",
  deadline: "Timed out",
  too_many_actions: "Action limit reached",
  no_answer: "No answer available",
  model_refused: "Assistant declined the request",
  model_malformed: "Assistant reply couldn’t be read",
  model_unreachable: "Assistant couldn’t be reached",
};

export default function Page() {
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["settings-privacy"],
    queryFn: async () => {
      const res = await fetch("/api/settings/privacy");
      // Throw on a transport-level failure so `isError` is a real signal. The
      // route itself degrades to 200 + `unavailable` and never 500s.
      if (!res.ok) throw new Error(`/api/settings/privacy → ${res.status}`);
      return (await res.json()) as SettingsResponse;
    },
    staleTime: 10_000,
  });

  const mutation = useMutation({
    mutationFn: async (vars: { name: string; value: boolean }) => {
      const res = await fetch("/api/settings/privacy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(vars),
      });
      const body = (await res.json()) as { ok: boolean };
      // A write that the backend refused is a failed write, not a quiet no-op.
      if (!res.ok || !body.ok) throw new Error("the setting was not written");
      return body;
    },
    // Optimistic: flip immediately, roll back if the write fails.
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ["settings-privacy"] });
      const previous = queryClient.getQueryData<SettingsResponse>(["settings-privacy"]);
      queryClient.setQueryData<SettingsResponse>(["settings-privacy"], (old) =>
        old
          ? {
              ...old,
              settings: old.settings.map((s) =>
                s.name === vars.name ? { ...s, value: vars.value ? "on" : "off" } : s,
              ),
            }
          : old,
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["settings-privacy"], context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["settings-privacy"] });
      queryClient.invalidateQueries({ queryKey: ["settings-privacy-details"] });
    },
  });

  const list = data?.settings ?? [];
  // Branch on the FAILURE FLAG the route already sends, never on length. An
  // absence is not retryable, so it never gets a "Try again" that cannot work.
  const state = data?.state ?? (data?.unavailable ? "degraded" : "live");
  const failed = isError || state === "degraded";
  const absent = !isError && state === "absent";

  function settingRow(s: PrivacySetting, editable: boolean) {
    const choice = PRIVACY_CHOICES[s.name] ?? {
      label: humanize(s.name),
      description: "This preference isn’t supported by this Center yet.",
    };
    return (
      <div className={styles.toggleRow} key={s.name} data-testid="privacy-setting-row">
        <span className={styles.toggleText}>
          <span className={styles.toggleLabel}>{choice.label}</span>
          <span className={settings.muted} data-testid="privacy-setting-description">
            {choice.description}
          </span>
        </span>
        <Switch
          checked={isOn(s.value)}
          onChange={(next) => mutation.mutate({ name: s.name, value: next })}
          disabled={!editable || mutation.isPending}
          ariaLabel={choice.label}
        />
      </div>
    );
  }
  const available = list.filter((s) => Object.hasOwn(PRIVACY_CHOICES, s.name));
  const unavailable = list.filter((s) => !Object.hasOwn(PRIVACY_CHOICES, s.name));
  const lastLocationOn = list.some((s) => s.name === "last_location" && isOn(s.value));
  const diagnosticsOn = list.some((s) => s.name === "traces" && isOn(s.value));
  const details = useQuery({
    queryKey: ["settings-privacy-details"],
    enabled: !isLoading && !failed && !absent && (lastLocationOn || diagnosticsOn),
    queryFn: async () => {
      const response = await fetch("/api/settings/privacy/details");
      if (!response.ok) throw new Error("Privacy details could not be loaded");
      const body = await response.json() as { details: PrivacyDetails | null; state: DataState };
      if (body.state !== "live" || !body.details) throw new Error("Privacy details could not be loaded");
      return privacyDetailsSchema.parse(body.details);
    },
    staleTime: 10_000,
  });
  const location = details.data?.lastLocation;
  const diagnostic = details.data?.diagnostics;

  return (
    <>
      {isLoading ? (
        <SectionSkeleton rows={5} />
      ) : (
        <section className={settings.section} data-testid="privacySettings">
          <div className={settings.sectionHeader}>
            <span className={settings.sectionTitle}>Privacy</span>
          </div>

          {failed ? (
            <div className={settings.stateRow}>
              <StatusMessage tone="warning" onRetry={() => void refetch()}>
                Your privacy settings couldn&rsquo;t be loaded just now.
              </StatusMessage>
            </div>
          ) : absent ? (
            <div className={settings.stateRow}>
              <StatusMessage tone="info">Connect your Pin to manage privacy settings.</StatusMessage>
            </div>
          ) : list.length === 0 ? (
            <div className={settings.stateRow}>
              <span className={settings.muted}>No privacy settings yet.</span>
            </div>
          ) : (
            <>
              {available.map((s) => settingRow(s, true))}
              {available.some((s) => s.name === "v1p0_defaults") ? (
                <div className={settings.stateRow}>
                  <StatusMessage tone="info">
                    Turning off standard sync can stop photos, notes and other activity from saving.
                    Previously synced data may become unreadable after your Pin updates its privacy settings.
                  </StatusMessage>
                </div>
              ) : null}
              {available.length === 0 ? (
                <div className={settings.stateRow}>
                  <span className={settings.muted}>No privacy controls are available yet.</span>
                </div>
              ) : null}
              {mutation.isError ? (
                <div className={settings.stateRow}>
                  <StatusMessage tone="warning">
                    Couldn&rsquo;t save that setting. Try again.
                  </StatusMessage>
                </div>
              ) : null}
            </>
          )}
        </section>
      )}

      {!isLoading && !failed && !absent && unavailable.length > 0 ? (
        <details className={`${settings.section} ${styles.unavailableDetails}`}>
          <summary>
            Not available yet
            <span className={styles.disclosureMark} aria-hidden>+</span>
          </summary>
          <div className={settings.stateRow}>
            <span className={settings.muted}>
              These preferences are saved, but aren’t applied yet.
            </span>
          </div>
          {unavailable.map((s) => settingRow(s, false))}
        </details>
      ) : null}

      {!isLoading && !failed && !absent && (lastLocationOn || diagnosticsOn) ? (
        <section className={settings.section}>
          <div className={settings.sectionHeader}>
            <span className={settings.sectionTitle}>Saved privacy details</span>
          </div>
          <div className={`${settings.stateRow} ${styles.savedDetails}`}>
            {details.isError ? (
              <StatusMessage tone="warning" onRetry={() => void details.refetch()}>
                Your saved privacy details couldn’t be loaded just now.
              </StatusMessage>
            ) : details.isPending ? (
              <span className={settings.muted}>Loading saved details…</span>
            ) : (
              <>
                {lastLocationOn ? (
                  <>
                    <strong>Last saved location</strong>
                    {location ? (
                      <>
                        <span>{location.humanReadable || location.fullAddress || `${location.latitude}, ${location.longitude}`}</span>
                        <span className={settings.muted}>
                          {location.staleStatus === "stale" ? "Stale location" : location.staleStatus === "fresh" ? "Fresh location" : "Location freshness unknown"}
                          {location.timestamp === null ? " · Time unavailable" : ` · ${new Date(location.timestamp).toLocaleString()}`}
                        </span>
                      </>
                    ) : (
                      <span className={settings.muted}>
                        {details.data?.lastLocationEnabled ? "No location saved yet. It will appear after a location-based request on your Pin." : "Location access is off. Your last location won’t update."}
                      </span>
                    )}
                  </>
                ) : null}
                {diagnosticsOn ? (
                  <>
                    <strong>Latest assistant diagnostic</strong>
                    {diagnostic ? (
                      <>
                        <span>{DIAGNOSTIC_OUTCOMES[diagnostic.outcome] ?? humanize(diagnostic.outcome)} · {diagnostic.elapsedMs} ms</span>
                        <span className={settings.muted}>{new Date(diagnostic.recordedAt).toLocaleString()}</span>
                        <details className={styles.diagnosticDetails}>
                          <summary>More details</summary>
                          <span className={settings.muted}>{diagnostic.route} · {diagnostic.transport} · {diagnostic.outcome}</span>
                        </details>
                      </>
                    ) : (
                      <span className={settings.muted}>No diagnostic saved yet. It will appear after your next assistant request.</span>
                    )}
                  </>
                ) : null}
              </>
            )}
          </div>
        </section>
      ) : null}

      <DeleteAccount />
    </>
  );
}
