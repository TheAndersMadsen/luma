"use client";

import { SessionReconnect } from "@/components/SessionReconnect";
import { SectionSkeleton } from "@/components/States";
import { StatusMessage } from "@/components/Status";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import type {
  FoodIntake,
  FoodLogEntry,
  FoodPreferences,
  FoodRestriction,
  NutrientGoal,
} from "@/lib/contracts/food";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import settings from "../settings.module.css";
import styles from "./food.module.css";
import {
  NUTRIENTS,
  RESTRICTION_TYPES,
  SEVERITIES,
  UNITS,
  describeGoal,
  describeIntake,
  goalDraft,
  goalsFromDrafts,
  intakeNote,
  nutrientLabel,
  type GoalDraft,
} from "./nutrients";
import type { DataState } from "@/lib/contracts/dataSource";

interface FoodPreferencesResponse {
  preferences: (FoodPreferences & { sealedRestrictions: number }) | null;
  state: DataState;
  degraded?: string;
  reauthenticate?: true;
}

interface FoodIntakeResponse {
  intake: FoodIntake | null;
  state: DataState;
  reauthenticate?: true;
}

const QUERY_KEY = ["food-preferences"];
/** Today's totals carry the goals' bounds, so a goals save refreshes them too. */
const INTAKE_KEY = ["food-intake-today"];

/**
 * The wearer's today: local midnight to the next, bounds inclusive. Only the
 * browser knows it. The day runs to its end rather than to "now", because a
 * meal carries the Pin's clock: one a minute ahead of this browser's must still
 * count today.
 */
function today(): URLSearchParams {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const next = new Date(midnight);
  next.setDate(next.getDate() + 1);
  return new URLSearchParams({
    startTime: midnight.toISOString(),
    endTime: new Date(next.getTime() - 1).toISOString(),
  });
}

/**
 * Food & nutrition: the daily intake goals and food restrictions the Pin's food
 * experience sends the wearer to .center for, today's totals against the goals,
 * and what they logged today.
 */
export function FoodView() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const response = await fetch("/api/account/food-preferences", { cache: "no-store" });
      if (!response.ok) throw new Error(`food preferences returned ${response.status}`);
      return (await response.json()) as FoodPreferencesResponse;
    },
    staleTime: 10_000,
  });

  if (isLoading) {
    return (
      <>
        <SectionSkeleton rows={3} />
        <SectionSkeleton rows={2} />
      </>
    );
  }
  if (isError || !data) {
    return (
      <StatusMessage tone="warning" onRetry={() => void refetch()}>
        Your food goals couldn&rsquo;t be loaded just now.
      </StatusMessage>
    );
  }
  // Only a live read is the wearer's data. An unreadable account must never
  // look like one with no goals, and must never be saved over.
  if (data.state === "degraded" || !data.preferences) {
    return data.reauthenticate ? (
      <StatusMessage tone="warning">
        Your session expired, so your food goals couldn&rsquo;t be read. Nothing has been
        removed. <SessionReconnect /> to see them.
      </StatusMessage>
    ) : data.state === "absent" ? (
      <StatusMessage tone="info">Connect your Pin to set food goals.</StatusMessage>
    ) : (
      <StatusMessage tone="warning" onRetry={() => void refetch()}>
        Your food goals couldn&rsquo;t be read just now. Nothing has been removed.
      </StatusMessage>
    );
  }

  return (
    <>
      <GoalsSection goals={data.preferences.dailyIntakeGoals} />
      <RestrictionsSection
        restrictions={data.preferences.restrictions}
        sealed={data.preferences.sealedRestrictions}
      />
      <TodayTotals />
      <LoggedToday />
    </>
  );
}

type SaveProblem = "expired" | "refused" | "failed";

/** Save one half of the preferences. Cosmos keeps the other. */
function useSave() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<SaveProblem | null>(null);

  async function save(body: Partial<FoodPreferences>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch("/api/account/food-preferences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
          queryClient.invalidateQueries({ queryKey: INTAKE_KEY }),
        ]);
        return true;
      }
      setProblem(
        response.status === 401
          ? "expired"
          : response.status === 400 || response.status === 413
            ? "refused"
            : "failed",
      );
      return false;
    } catch {
      setProblem("failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, problem, setProblem, save };
}

function SaveProblemMessage({ problem, local, onReconnected }: { problem: SaveProblem | null; local: string | null; onReconnected: () => void }) {
  if (local) return <StatusMessage tone="warning">{local}</StatusMessage>;
  if (problem === "expired") {
    return (
      <StatusMessage tone="warning">
        Your changes are still here. <SessionReconnect onReconnected={onReconnected} /> to save them.
      </StatusMessage>
    );
  }
  if (problem === "refused") {
    return <StatusMessage tone="warning">That couldn&rsquo;t be saved as written. Nothing was changed.</StatusMessage>;
  }
  if (problem === "failed") {
    return <StatusMessage tone="warning">That couldn&rsquo;t be saved. Nothing was changed.</StatusMessage>;
  }
  return null;
}

function GoalsSection({ goals }: { goals: NutrientGoal[] }) {
  const [editing, setEditing] = useState(false);
  return (
    <section className={settings.section} data-testid="dailyIntakeGoals">
      <div className={settings.sectionHeader}>
        <span className={settings.sectionTitle}>Daily goals</span>
        {editing ? null : (
          <button type="button" className={styles.quietButton} onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <GoalsEditor goals={goals} onDone={() => setEditing(false)} />
      ) : goals.length === 0 ? (
        <div className={settings.stateRow}>
          <span className={settings.muted}>
            No daily goals yet. Your Pin measures food answers against the goals you set here.
          </span>
        </div>
      ) : (
        goals.map((goal) => (
          <div className={settings.infoRowRoot} key={goal.uuid}>
            <span className={settings.titleInfo}>{nutrientLabel(goal.type)}</span>
            <div className={settings.descWrapper}>
              <span className={settings.description}>{describeGoal(goal)}</span>
            </div>
          </div>
        ))
      )}
    </section>
  );
}

function GoalsEditor({ goals, onDone }: { goals: NutrientGoal[]; onDone: () => void }) {
  const [drafts, setDrafts] = useState<GoalDraft[]>(() => goals.map(goalDraft));
  const dirty = JSON.stringify(drafts) !== JSON.stringify(goals.map(goalDraft));
  const [local, setLocal] = useState<string | null>(null);
  const { busy, problem, setProblem, save } = useSave();
  const [nextGoal] = NUTRIENTS.filter((nutrient) => !drafts.some((draft) => draft.type === nutrient.type));

  function update(index: number, change: Partial<GoalDraft>) {
    setDrafts((current) => current.map((draft, at) => (at === index ? { ...draft, ...change } : draft)));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = goalsFromDrafts(drafts);
    if (typeof parsed === "string") {
      setLocal(parsed);
      return;
    }
    setLocal(null);
    if (await save({ dailyIntakeGoals: parsed })) onDone();
  }

  return (
    <form className={styles.editor} onSubmit={(event) => void submit(event)} data-testid="goalsEditor">
      <UnsavedChangesGuard when={dirty} />
      <fieldset className={styles.editorFields} disabled={busy} aria-label="Daily goals">
        {drafts.map((draft, index) => (
          <div className={styles.row} key={draft.uuid || `new-${index}`}>
            <label>
              Nutrient
              <select
                className={styles.field}
                value={draft.type}
                onChange={(event) => {
                  const nutrient = NUTRIENTS.find((entry) => entry.type === event.target.value);
                  if (nutrient) update(index, { type: nutrient.type, unit: nutrient.unit });
                }}
              >
                {NUTRIENTS.filter(
                  (nutrient) =>
                    nutrient.type === draft.type || !drafts.some((other) => other.type === nutrient.type),
                ).map((nutrient) => (
                  <option key={nutrient.type} value={nutrient.type}>
                    {nutrient.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              At least
              <input
                className={styles.field}
                inputMode="decimal"
                value={draft.min}
                onChange={(event) => update(index, { min: event.target.value })}
              />
            </label>
            <label>
              At most
              <input
                className={styles.field}
                inputMode="decimal"
                value={draft.max}
                onChange={(event) => update(index, { max: event.target.value })}
              />
            </label>
            <label>
              Unit
              <select
                className={styles.field}
                value={draft.unit}
                onChange={(event) => update(index, { unit: event.target.value as GoalDraft["unit"] })}
              >
                {UNITS.map((unit) => (
                  <option key={unit.unit} value={unit.unit}>
                    {unit.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={styles.quietButton}
              onClick={() => setDrafts((current) => current.filter((_, at) => at !== index))}
            >
              Remove
            </button>
          </div>
        ))}
        {nextGoal ? (
          <div>
            <button
              type="button"
              className={styles.quietButton}
              onClick={() =>
                setDrafts((current) => [
                  ...current,
                  { uuid: "", type: nextGoal.type, unit: nextGoal.unit, min: "", max: "" },
                ])
              }
            >
              Add a goal
            </button>
          </div>
        ) : null}
        <SaveProblemMessage problem={problem} local={local} onReconnected={() => setProblem(null)} />
        <div className={styles.actions}>
          <button type="submit" className={styles.primaryButton} disabled={busy}>
            {busy ? "Saving…" : "Save goals"}
          </button>
          <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => {
            if (!dirty || window.confirm("Discard your changes to your daily goals?")) onDone();
          }}>
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function restrictionLabel(restriction: FoodRestriction): string {
  const type = RESTRICTION_TYPES.find((entry) => entry.type === restriction.restrictionType)?.label;
  const severity =
    restriction.severity === "UNKNOWN"
      ? null
      : SEVERITIES.find((entry) => entry.severity === restriction.severity)?.label;
  return [type, severity].filter(Boolean).join(" · ");
}

function RestrictionsSection({
  restrictions,
  sealed,
}: {
  restrictions: FoodRestriction[];
  sealed: number;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <section className={settings.section} data-testid="foodRestrictions">
      <div className={settings.sectionHeader}>
        <span className={settings.sectionTitle}>Food restrictions</span>
        {editing ? null : (
          <button type="button" className={styles.quietButton} onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <RestrictionsEditor restrictions={restrictions} onDone={() => setEditing(false)} />
      ) : restrictions.length === 0 && sealed === 0 ? (
        <div className={settings.stateRow}>
          <span className={settings.muted}>No allergies, intolerances or diets yet.</span>
        </div>
      ) : (
        restrictions.map((restriction) => (
          <div className={settings.infoRowRoot} key={restriction.uuid}>
            <span className={settings.titleInfo}>{restriction.name}</span>
            <div className={settings.descWrapper}>
              <span className={settings.description}>{restrictionLabel(restriction)}</span>
            </div>
          </div>
        ))
      )}
      {sealed > 0 ? (
        <div className={settings.stateRow}>
          <span className={settings.muted}>
            {sealed === 1 ? "1 restriction" : `${sealed} restrictions`} saved elsewhere can&rsquo;t be
            shown here. They stay on your account unchanged.
          </span>
        </div>
      ) : null}
    </section>
  );
}

function RestrictionsEditor({
  restrictions,
  onDone,
}: {
  restrictions: FoodRestriction[];
  onDone: () => void;
}) {
  const [drafts, setDrafts] = useState<FoodRestriction[]>(restrictions);
  const dirty = JSON.stringify(drafts) !== JSON.stringify(restrictions);
  const [local, setLocal] = useState<string | null>(null);
  const { busy, problem, setProblem, save } = useSave();

  function update(index: number, change: Partial<FoodRestriction>) {
    setDrafts((current) => current.map((draft, at) => (at === index ? { ...draft, ...change } : draft)));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (drafts.some((draft) => draft.name.trim() === "")) {
      setLocal("Every restriction needs a name.");
      return;
    }
    setLocal(null);
    const cleaned = drafts.map((draft) => ({ ...draft, name: draft.name.trim() }));
    if (await save({ restrictions: cleaned })) onDone();
  }

  return (
    <form
      className={styles.editor}
      onSubmit={(event) => void submit(event)}
      data-testid="restrictionsEditor"
    >
      <UnsavedChangesGuard when={dirty} />
      <fieldset className={styles.editorFields} disabled={busy} aria-label="Food restrictions">
        {drafts.map((draft, index) => (
          <div className={styles.restrictionRow} key={draft.uuid || `new-${index}`}>
            <label>
              Name
              <input
                className={styles.field}
                value={draft.name}
                maxLength={100}
                placeholder="Peanuts"
                onChange={(event) => update(index, { name: event.target.value })}
              />
            </label>
            <label>
              Kind
              <select
                className={styles.field}
                value={draft.restrictionType}
                onChange={(event) =>
                  update(index, {
                    restrictionType: event.target.value as FoodRestriction["restrictionType"],
                  })
                }
              >
                {RESTRICTION_TYPES.map((entry) => (
                  <option key={entry.type} value={entry.type}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Severity
              <select
                className={styles.field}
                value={draft.severity}
                onChange={(event) =>
                  update(index, { severity: event.target.value as FoodRestriction["severity"] })
                }
              >
                {SEVERITIES.map((entry) => (
                  <option key={entry.severity} value={entry.severity}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={styles.quietButton}
              onClick={() => setDrafts((current) => current.filter((_, at) => at !== index))}
            >
              Remove
            </button>
          </div>
        ))}
        <div>
          <button
            type="button"
            className={styles.quietButton}
            onClick={() =>
              setDrafts((current) => [
                ...current,
                { uuid: "", name: "", restrictionType: "ALLERGY", severity: "UNKNOWN" },
              ])
            }
          >
            Add a restriction
          </button>
        </div>
        <SaveProblemMessage problem={problem} local={local} onReconnected={() => setProblem(null)} />
        <div className={styles.actions}>
          <button type="submit" className={styles.primaryButton} disabled={busy}>
            {busy ? "Saving…" : "Save restrictions"}
          </button>
          <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => {
            if (!dirty || window.confirm("Discard your changes to your food restrictions?")) onDone();
          }}>
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}

/**
 * Today's totals against the daily goals, as Cosmos adds them up from the food
 * log. INFERRED: stock shows no totals anywhere, so this is Luma's reading of
 * the same log and goals the Pin uses.
 */
function TodayTotals() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: INTAKE_KEY,
    queryFn: async () => {
      const response = await fetch(`/api/account/food-intake?${today()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`food intake returned ${response.status}`);
      return (await response.json()) as FoodIntakeResponse;
    },
    staleTime: 30_000,
  });

  return (
    <section className={settings.section} data-testid="foodIntakeToday">
      <div className={settings.sectionHeader}>
        <span className={settings.sectionTitle}>Today&rsquo;s totals</span>
      </div>
      {isLoading ? (
        <div className={settings.stateRow}>
          <span className={settings.muted}>Adding up today&rsquo;s food log…</span>
        </div>
      ) : data?.reauthenticate ? (
        <div className={settings.stateRow}>
          <StatusMessage tone="warning">
            Your session expired, so today&rsquo;s totals couldn&rsquo;t be read.{" "}
            <SessionReconnect /> to see them.
          </StatusMessage>
        </div>
      ) : isError || !data?.intake || data.state !== "live" ? (
        <div className={settings.stateRow}>
          <StatusMessage tone="warning" onRetry={() => void refetch()}>
            Today&rsquo;s totals couldn&rsquo;t be worked out just now.
          </StatusMessage>
        </div>
      ) : (
        data.intake.nutrients.map((total) => {
          const note = intakeNote(total);
          return (
            <div className={settings.infoRowRoot} key={total.type}>
              <span className={settings.titleInfo}>{nutrientLabel(total.type)}</span>
              <div className={settings.descWrapper}>
                <span className={settings.description}>{describeIntake(total)}</span>
                {note ? <span className={settings.muted}>{note}</span> : null}
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}

/** What the Pin logged today, from the same food log its food experience reads. */
function LoggedToday() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["food-log-today"],
    queryFn: async () => {
      const response = await fetch(`/api/capture/food-log?${today()}`, { cache: "no-store" });
      if (response.status === 401) {
        return { entries: [] as FoodLogEntry[], state: "degraded", reauthenticate: true, note: null };
      }
      if (!response.ok) throw new Error(`food log returned ${response.status}`);
      const state = response.headers.get("x-data-state");
      return {
        entries: (await response.json()) as FoodLogEntry[],
        state,
        reauthenticate: false,
        // On a live read this is how many entries Cosmos keeps sealed.
        note: state === "live" ? response.headers.get("x-data-degraded") : null,
      };
    },
    staleTime: 30_000,
  });

  return (
    <section className={settings.section} data-testid="foodLogToday">
      <div className={settings.sectionHeader}>
        <span className={settings.sectionTitle}>Logged today</span>
      </div>
      {isLoading ? (
        <div className={settings.stateRow}>
          <span className={settings.muted}>Checking today&rsquo;s food log…</span>
        </div>
      ) : data?.reauthenticate ? (
        <div className={settings.stateRow}>
          <StatusMessage tone="warning">
            Your session expired, so today&rsquo;s food log couldn&rsquo;t be read.{" "}
            <SessionReconnect /> to see it.
          </StatusMessage>
        </div>
      ) : isError || !data || data.state === "degraded" ? (
        <div className={settings.stateRow}>
          <StatusMessage tone="warning" onRetry={() => void refetch()}>
            Today&rsquo;s food log couldn&rsquo;t be read just now.
          </StatusMessage>
        </div>
      ) : (
        <>
          {data.note ? (
            <div className={settings.stateRow} data-testid="foodLogSealed">
              <StatusMessage tone="info" inline>{data.note}</StatusMessage>
            </div>
          ) : null}
          {data.entries.length === 0 ? (
            <div className={settings.stateRow}>
              <span className={settings.muted}>
                {data.note ? "Nothing else logged today." : "Nothing logged today."}
              </span>
            </div>
          ) : (
            data.entries.map((entry, index) => (
              <div className={settings.infoRowRoot} key={`${entry.loggedAt}-${index}`}>
                <span className={settings.titleInfo}>{entry.itemName}</span>
                <div className={settings.descWrapper}>
                  <span className={settings.description}>
                    {entry.servingsConsumed === 1
                      ? "1 serving"
                      : `${entry.servingsConsumed.toLocaleString()} servings`}{" "}
                    · {new Date(entry.loggedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </span>
                </div>
              </div>
            ))
          )}
        </>
      )}
    </section>
  );
}
