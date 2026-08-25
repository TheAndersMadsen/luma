"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import settings from "../settings.module.css";
import styles from "./privacy.module.css";
import { SectionSkeleton } from "@/components/States";
import { StatusMessage, Switch } from "@/components/Status";

// Mirrors the shape returned by /api/settings/privacy. Declared locally so this
// client component never pulls the server-only route module into its bundle.
interface PrivacySetting {
  name: string;
  value: string;
  status?: string;
}

/**
 * Settings → Privacy.
 *
 * Toggles are driven by `PublicPrivacyService`: GetSettings on read, UpdateSettings
 * on write, both through /api/settings/privacy. The settings that come back are
 * whatever the backend holds; each renders as a labeled switch. The recovered
 * onboarding flow named toggles like Location, Traces, Vision, Ai Mic Search
 * History, Volume Boost and Personal Voice (their `PrivacyOnboard*Toggle` CSS
 * modules survive), but the live set is authoritative, so we render what the RPC
 * returns rather than hardcoding those.
 *
 * The pane used to branch on `list.length === 0` and tell the wearer "Privacy
 * settings are unavailable from this backend" — the same sentence for a backend
 * that answered with nothing and a backend that did not answer at all. It reads
 * the failure flag the route has always set instead, so a transport failure says
 * so and offers a retry, and a genuinely empty answer is reported as empty.
 */

interface SettingsResponse {
  settings: PrivacySetting[];
  /** live: your settings, possibly none. absent: nothing is configured to answer.
   *  degraded: something is configured and it did not answer. */
  state?: "live" | "absent" | "degraded";
  unavailable?: boolean;
  degraded?: string;
}

const TRUTHY = new Set(["true", "1", "on", "enabled", "yes"]);
function isOn(value: string): boolean {
  return TRUTHY.has(value.trim().toLowerCase());
}

/** "ai_mic_search_history" → "Ai Mic Search History". */
function humanize(name: string): string {
  return name
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => (w.toLowerCase() === "ai" ? "Ai" : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

export default function Page() {
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["settings-privacy"],
    queryFn: async () => {
      const res = await fetch("/api/settings/privacy");
      // Throw on a transport-level failure so `isError` is a real signal; the
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
    },
  });

  const list = data?.settings ?? [];
  // Branch on the FAILURE FLAG the route already sends, never on length. An
  // absence is not retryable, so it never gets a "Try again" that cannot work.
  const state = data?.state ?? (data?.unavailable ? "degraded" : "live");
  const failed = isError || state === "degraded";
  const absent = !isError && state === "absent";

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
              <span className={settings.muted}>Connect a Pin to manage privacy settings.</span>
            </div>
          ) : list.length === 0 ? (
            <div className={settings.stateRow}>
              <span className={settings.muted}>No privacy settings yet.</span>
            </div>
          ) : (
            <>
              {list.map((s) => {
                const on = isOn(s.value);
                return (
                  <div className={styles.toggleRow} key={s.name} data-testid="privacy-setting-row">
                    {/*
                      ONE label per switch. There used to be a second line under
                      each one rendering the raw backend key in 13px monospace —
                      "Traces" over `traces`, "Save Event Location" over
                      `save_event_location` — which stock .Center never showed and
                      which reads, to someone who used the real product, as an
                      error state or an internal build. On the pane where being
                      clear about what is shared matters most, it was the same word
                      twice in two fonts. The sibling Features pane already made
                      this call the other way and pinned it with a test
                      (verify/settings-ia.test.mjs); the key survives as the
                      switch's `key` and in the POST body, where it belongs.
                    */}
                    <span className={styles.toggleText}>
                      <span className={styles.toggleLabel}>{humanize(s.name)}</span>
                    </span>
                    <Switch
                      checked={on}
                      onChange={(next) => mutation.mutate({ name: s.name, value: next })}
                      disabled={mutation.isPending}
                      ariaLabel={humanize(s.name)}
                    />
                  </div>
                );
              })}
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

    </>
  );
}
