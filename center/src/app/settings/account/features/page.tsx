"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import settings from "../../settings.module.css";
import styles from "./features.module.css";
import { EmptyState, SectionSkeleton } from "@/components/States";
import { StatusMessage, Switch } from "@/components/Status";

type FlagView = {
  name: string;
  label: string;
  description: string;
  category: string;
  evidence: "observed" | "derived" | "implemented" | "unknown";
  delivery: "next_sync" | "next_sync_restart" | "server_only" | "server_controlled" | "inert" | "unknown";
  type: "bool" | "int" | "text" | "float";
  effective: unknown;
  overridden: boolean;
  writable: boolean;
};

type DeliveryResult = "device_fetched" | "push_queued" | "next_sync";

function deliveryResultText(delivery: DeliveryResult): string {
  if (delivery === "device_fetched") {
    return "Saved. Your Pin has the latest setting.";
  }
  if (delivery === "push_queued") {
    return "Saved. Your Pin will update shortly.";
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
    description: "Use a touch gesture to unlock protected Pin actions.",
  },
  touchcode_timeout_millis: {
    label: "Touchcode timeout",
    description: "Choose how many seconds you have to finish entering a Touchcode.",
  },
  vision_custom_gesture_enabled: {
    label: "Custom gestures",
    description: "Use custom hand gestures with the Laser Ink Display.",
  },
  quick_actions_remapping_enabled: {
    label: "Quick Actions",
    description: "Choose which actions appear in your quick-access menu.",
  },
  music_interstitials_enabled: {
    label: "Music announcements",
    description: "Let your Pin announce what is playing when music starts or changes.",
  },
  tickle: {
    label: "The Tickle",
    description: "Enable the Pin’s hidden Tickle phrases and experience.",
  },
  cmu_ultra_enabled: {
    label: "Catch Me Up",
    description: "Let your Pin use eligible notifications from a paired phone.",
  },
  cmu_ultra_chime_enabled: {
    label: "Catch Me Up chime",
    description: "Play a chime when Catch Me Up has an eligible notification.",
  },
  vision_actions_enabled: {
    label: "Vision actions",
    description: "Let your Pin use what its camera sees to help with a request.",
  },
  fitness_tracker_enabled: {
    label: "Fitness tracking",
    description: "Track supported activity with your Pin.",
  },
  fitness_tracker_extra_data_enabled: {
    label: "Detailed fitness data",
    description: "Record additional detail during supported fitness activities.",
  },
  esim_qr_scanner_enabled: {
    label: "eSIM QR scanner",
    description: "Scan a carrier QR code when setting up mobile connectivity.",
  },
  network_reset_enabled: {
    label: "Network reset",
    description: "Allow network settings to be reset from the Pin.",
  },
};

function isWearerFeature(flag: FlagView): boolean {
  return Boolean(WEARER_COPY[flag.name])
    && flag.writable
    && flag.evidence !== "unknown"
    && (flag.delivery === "next_sync" || flag.delivery === "next_sync_restart");
}

export default function Page() {
  const [flags, setFlags] = useState<FlagView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ name: string; message: string } | null>(null);
  const [delivery, setDelivery] = useState<{ name: string; result: DeliveryResult } | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const response = await fetch("/api/settings/features", { cache: "no-store" }).catch(() => null);
    if (!response?.ok) {
      setError("Features couldn’t be loaded.");
      setLoading(false);
      return;
    }
    const body = (await response.json().catch(() => [])) as unknown;
    setFlags(Array.isArray(body) ? (body as FlagView[]) : []);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visibleFlags = useMemo(() => {
    const query = search.trim().toLowerCase();
    return flags
      .filter(isWearerFeature)
      .map((flag) => ({ ...flag, ...WEARER_COPY[flag.name] }))
      .filter((flag) => !query || `${flag.label} ${flag.description}`.toLowerCase().includes(query));
  }, [flags, search]);

  const grouped = useMemo(() => CATEGORY_ORDER
    .map((category) => ({ category, flags: visibleFlags.filter((flag) => flag.category === category) }))
    .filter((group) => group.flags.length > 0), [visibleFlags]);

  async function write(method: "PUT" | "DELETE", flag: FlagView, value?: unknown) {
    setBusy(flag.name);
    setRowError(null);
    setDelivery(null);
    const response = await fetch("/api/settings/features", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(method === "PUT" ? { name: flag.name, value } : { name: flag.name }),
    }).catch(() => null);
    const body = (await response?.json().catch(() => ({}))) as { error?: string; delivery?: DeliveryResult } | undefined;
    if (!response?.ok) {
      setRowError({ name: flag.name, message: "This feature couldn’t be saved." });
    } else if (body?.delivery) {
      setDelivery({ name: flag.name, result: body.delivery });
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
            Choose how your Pin behaves. Some changes require a restart.
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
        <StatusMessage tone="warning" onRetry={() => void load()}>{error}</StatusMessage>
      ) : grouped.length === 0 ? <EmptyState title="No features match this filter" inline /> : grouped.map((group) => (
        <section className={settings.section} key={group.category}>
          <div className={settings.sectionHeader}>
            <span className={settings.sectionTitle}>{group.category}</span>
            <span className={styles.groupCount}>{group.flags.length}</span>
          </div>
          {group.flags.map((flag) => (
            <FlagRow
              key={flag.name}
              flag={flag}
              busy={busy !== null}
              error={rowError?.name === flag.name ? rowError.message : null}
              delivery={delivery?.name === flag.name ? delivery.result : null}
              onWrite={(value) => void write("PUT", flag, value)}
              onRevert={() => void write("DELETE", flag)}
            />
          ))}
        </section>
      ))}
    </>
  );
}

function FlagRow({ flag, busy, error, delivery, onWrite, onRevert }: {
  flag: FlagView;
  busy: boolean;
  error: string | null;
  delivery: DeliveryResult | null;
  onWrite: (value: unknown) => void;
  onRevert: () => void;
}) {
  const usesSeconds = flag.name === "touchcode_timeout_millis";
  const displayedValue = usesSeconds ? String(Number(flag.effective) / 1000) : String(flag.effective);
  const [draft, setDraft] = useState(displayedValue);
  useEffect(() => setDraft(displayedValue), [displayedValue]);
  const changed = draft !== displayedValue;
  const draftNumber = Number(draft);
  const draftIsValid = flag.type === "text"
    ? draft.trim() !== ""
    : Number.isFinite(draftNumber) && (!usesSeconds || draftNumber >= 0);

  return (
    <div className={`${styles.flagRow} ${!flag.writable ? styles.flagLocked : ""}`}>
      <div className={styles.flagBody}>
        <div className={styles.flagTitleLine}>
          <strong>{flag.label}</strong>
        </div>
        <span className={styles.flagDescription}>{flag.description}</span>
        {error ? <StatusMessage tone="warning" inline>{error}</StatusMessage> : null}
        {delivery ? <StatusMessage tone="info" inline>{deliveryResultText(delivery)}</StatusMessage> : null}
      </div>
      <div className={styles.flagControl}>
        {flag.type === "bool" ? (
          <Switch checked={Boolean(flag.effective)} onChange={onWrite} label={flag.effective ? "On" : "Off"} disabled={busy || !flag.writable} />
        ) : (
          <div className={styles.scalarControl}>
            <input value={draft} onChange={(event) => setDraft(event.target.value)} disabled={busy || !flag.writable} aria-label={`${flag.label}${usesSeconds ? " in seconds" : " value"}`} />
            <button
              type="button"
              disabled={busy || !flag.writable || !changed || !draftIsValid}
              onClick={() => onWrite(
                usesSeconds
                  ? Number(draft) * 1000
                  : flag.type === "int" || flag.type === "float"
                    ? Number(draft)
                    : draft,
              )}
            >
              Save
            </button>
          </div>
        )}
        {flag.overridden && flag.writable ? <button className={styles.revertButton} type="button" disabled={busy} onClick={onRevert}>Restore default</button> : null}
      </div>
    </div>
  );
}
