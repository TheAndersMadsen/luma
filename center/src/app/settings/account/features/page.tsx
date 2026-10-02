"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import settings from "../../settings.module.css";
import styles from "./features.module.css";
import { EmptyState, SectionSkeleton } from "@/components/States";
import { StatusMessage, Switch } from "@/components/Status";
import type { Feature } from "@/lib/contracts/features";

/**
 * Settings → Features, as humane.center had it in each account's Settings →
 * Ai Pin group: the wearer's own choices for their own Pins. Cosmos decides
 * which features are offered and keeps the choices per account. This page
 * renders the list it is given (`/api/settings/features`).
 */

type FeatureView = Feature;

type DeliveryResult = "device_fetched" | "push_queued" | "next_sync";

function deliveryResultText(delivery: DeliveryResult): string {
  if (delivery === "device_fetched") {
    return "Saved. Your Pin has the latest setting.";
  }
  if (delivery === "push_queued") {
    return "Saved. Update requested.";
  }
  return "Saved. Your Pin will update when it next connects.";
}

const CATEGORY_ORDER = [
  "Everyday Pin",
  "Voice & assistant",
  "Privacy & data",
  "System & recovery",
  "Experiments",
];

const WEARER_COPY: Record<string, { label: string; description: string }> = {
  touchcode_enabled: {
    label: "Touchcode",
    description: "Touchcode stays available to unlock your Pin.",
  },
  touchcode_timeout_millis: {
    label: "Touchcode timeout",
    description: "Choose how long Touchcode waits between gestures.",
  },
  vision_custom_gesture_enabled: {
    label: "Custom gestures",
    description: "Tap, then hold to ask about what your camera sees.",
  },
  quick_actions_remapping_enabled: {
    label: "Quick Actions",
    description: "Choose what a two-finger hold does.",
  },
  music_interstitials_enabled: {
    label: "Music announcements",
    description: "Announce the selection when music starts.",
  },
  tickle: {
    label: "The Tickle",
    description: "Enable the Pin’s hidden Tickle phrases and experience.",
  },
  cmu_ultra_enabled: {
    label: "Catch Me Up",
    description: "Use eligible notifications from a paired iPhone.",
  },
  cmu_ultra_chime_enabled: {
    label: "Catch Me Up chime",
    description: "Play a chime when Catch Me Up has an eligible notification.",
  },
  vision_actions_enabled: {
    label: "Vision actions",
    description: "Save rules for what your Pin sees, such as “if you see… then…”.",
  },
  fitness_tracker_enabled: {
    label: "Fitness tracking",
    description: "Allow new activity tracking sessions. Stop an active session on your Pin.",
  },
  fitness_tracker_extra_data_enabled: {
    label: "Detailed fitness data",
    description: "Record extra motion data from the next fitness session.",
  },
  esim_qr_scanner_enabled: {
    label: "eSIM QR scanner",
    description: "Scan a carrier QR code when setting up mobile connectivity.",
  },
  network_reset_enabled: {
    label: "Network reset",
    description: "Show the reset option in About. Reopen About after changes.",
  },
};

// INFERRED presentation of Cosmos flag_overrides::FEATURES warnings. The
// authoritative warning stays in Details. Unfamiliar warnings remain visible.
const WARNING_COPY: Record<string, string | null> = {
  touchcode_timeout_millis: "Zero ends Touchcode entry immediately.",
  quick_actions_remapping_enabled: null,
  tickle: "Experimental experience.",
  cmu_ultra_enabled: null,
  cmu_ultra_chime_enabled: "Requires Catch Me Up.",
  vision_actions_enabled: "Requires permission to use camera images.",
  fitness_tracker_enabled: "Records sensitive activity and location data.",
  fitness_tracker_extra_data_enabled: "Includes motion and location data. Requires Fitness tracking.",
  network_reset_enabled: "This shows the reset option; it does not reset your Pin.",
};

export default function Page() {
  const [features, setFeatures] = useState<FeatureView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; reauthenticate: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ name: string; message: string; reauthenticate?: boolean } | null>(null);
  const [delivery, setDelivery] = useState<{ name: string; result: DeliveryResult } | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const response = await fetch("/api/settings/features", { cache: "no-store" }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as unknown;
    if (!response?.ok || !Array.isArray(body)) {
      const reauthenticate = (body as { reauthenticate?: unknown } | null)?.reauthenticate === true;
      setError({ message: "Your features couldn’t be loaded.", reauthenticate });
      setLoading(false);
      return;
    }
    setFeatures(body as FeatureView[]);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visibleFeatures = useMemo(() => {
    const query = search.trim().toLowerCase();
    return features
      .map((feature) => ({ ...feature, ...WEARER_COPY[feature.name] }))
      .filter((feature) => !query || `${feature.label} ${feature.description}`.toLowerCase().includes(query));
  }, [features, search]);

  const grouped = useMemo(() => {
    const categories = [
      ...CATEGORY_ORDER,
      ...visibleFeatures.map((feature) => feature.category).filter((category) => !CATEGORY_ORDER.includes(category)),
    ];
    return [...new Set(categories)]
      .map((category) => ({ category, features: visibleFeatures.filter((feature) => feature.category === category) }))
      .filter((group) => group.features.length > 0);
  }, [visibleFeatures]);

  async function write(method: "PUT" | "DELETE", feature: FeatureView, value?: unknown) {
    setBusy(feature.name);
    setRowError(null);
    setDelivery(null);
    const response = await fetch("/api/settings/features", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(method === "PUT" ? { name: feature.name, value } : { name: feature.name }),
    }).catch(() => null);
    const body = (await response?.json().catch(() => ({}))) as
      | { error?: string; reauthenticate?: boolean; delivery?: DeliveryResult }
      | undefined;
    if (!response?.ok) {
      const reauthenticate = body?.reauthenticate === true;
      const message = reauthenticate
        ? "Your session expired, so nothing was saved."
        : body?.error ?? "This feature couldn’t be saved.";
      setRowError({ name: feature.name, message, reauthenticate });
    } else if (body?.delivery) {
      setDelivery({ name: feature.name, result: body.delivery });
    }
    await load();
    setBusy(null);
  }

  return (
    <>
      <section className={settings.section}>
        <div className={settings.sectionHeader}>
          <span className={settings.sectionTitle}>Features</span>
        </div>
        <div className={styles.intro}>
          <p>
            Choose how your Pin behaves. Your choices apply only to the Pins on your account, and some
            take effect after your Pin restarts.
          </p>
        </div>
      </section>

      <section className={settings.section}>
        <div className={styles.toolbar}>
          <label className={styles.searchLabel}>
            <span>Find a feature</span>
            <input className={styles.search} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search features" />
          </label>
        </div>
      </section>

      {loading ? <SectionSkeleton rows={6} /> : error ? (
        error.reauthenticate ? (
          <StatusMessage tone="warning">
            Your session expired, so your features couldn’t be read. <Link href="/login">Sign in again</Link> to see them.
          </StatusMessage>
        ) : (
          <StatusMessage tone="warning" onRetry={() => void load()}>{error.message}</StatusMessage>
        )
      ) : grouped.length === 0 ? <EmptyState title="No features match this filter" inline /> : grouped.map((group) => (
        <section className={settings.section} key={group.category}>
          <div className={settings.sectionHeader}>
            <span className={settings.sectionTitle}>{group.category}</span>
            <span className={styles.groupCount}>{group.features.length}</span>
          </div>
          {group.features.map((feature) => (
            <FlagRow
              key={feature.name}
              flag={feature}
              busy={busy !== null}
              error={rowError?.name === feature.name ? rowError : null}
              delivery={delivery?.name === feature.name ? delivery.result : null}
              onWrite={(value) => void write("PUT", feature, value)}
              onRevert={() => void write("DELETE", feature)}
            />
          ))}
        </section>
      ))}
    </>
  );
}

function FlagRow({ flag, busy, error, delivery, onWrite, onRevert }: {
  flag: FeatureView;
  busy: boolean;
  error: { message: string; reauthenticate?: boolean } | null;
  delivery: DeliveryResult | null;
  onWrite: (value: unknown) => void;
  onRevert: () => void;
}) {
  const usesSeconds = flag.name === "touchcode_timeout_millis";
  const displayedValue = usesSeconds ? String(Number(flag.effective) / 1000) : String(flag.effective);
  const [draft, setDraft] = useState(displayedValue);
  const savedValue = useRef(displayedValue);
  useEffect(() => {
    // Initial state already contains the saved value. A delayed mount effect
    // must not replace a draft the wearer has started editing.
    if (savedValue.current !== displayedValue) {
      savedValue.current = displayedValue;
      setDraft(displayedValue);
    }
  }, [displayedValue]);
  const changed = draft !== displayedValue;
  const draftNumber = Number(draft);
  const draftIsValid = flag.type === "text"
    ? draft.trim() !== ""
    : Number.isFinite(draftNumber) && (!usesSeconds || draftNumber >= 0);
  const warning = flag.warning
    ? Object.hasOwn(WARNING_COPY, flag.name) ? WARNING_COPY[flag.name] : flag.warning
    : null;

  return (
    <div className={styles.flagRow}>
      <div className={styles.flagBody}>
        <div className={styles.flagTitleLine}>
          <strong>{flag.label}</strong>
          {flag.delivery === "next_sync_restart" ? (
            <span className={styles.restart}>Restart recommended</span>
          ) : null}
        </div>
        <span className={styles.flagDescription}>{flag.description}</span>
        {warning ? <StatusMessage tone="warning" inline>{warning}</StatusMessage> : null}
        {flag.warning ? (
          <details className={styles.details}>
            <summary>More details</summary>
            <p>{flag.warning}</p>
          </details>
        ) : null}
        {error ? (
          <StatusMessage tone="warning" inline>
            {error.message}
            {error.reauthenticate ? <> <Link href="/login">Sign in again</Link> to change it.</> : null}
          </StatusMessage>
        ) : null}
        {delivery ? <StatusMessage tone="info" inline>{deliveryResultText(delivery)}</StatusMessage> : null}
      </div>
      <div className={styles.flagControl}>
        {!flag.editable ? <span>Always available</span> : flag.type === "bool" ? (
          <Switch checked={Boolean(flag.effective)} onChange={onWrite} label={flag.effective ? "On" : "Off"} disabled={busy} />
        ) : (
          <div className={styles.scalarControl}>
            <input value={draft} onChange={(event) => setDraft(event.target.value)} disabled={busy} aria-label={`${flag.label}${usesSeconds ? " in seconds" : " value"}`} />
            <button
              type="button"
              disabled={busy || !changed || !draftIsValid}
              onClick={() => onWrite(
                usesSeconds
                  ? Math.round(Number(draft) * 1000)
                  : flag.type === "int" || flag.type === "float"
                    ? Number(draft)
                    : draft,
              )}
            >
              Save
            </button>
          </div>
        )}
        {flag.overridden ? <button className={styles.revertButton} type="button" disabled={busy} onClick={onRevert}>Restore default</button> : null}
      </div>
    </div>
  );
}
