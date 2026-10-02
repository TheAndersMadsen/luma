import type {
  FoodRestriction,
  NutrientGoal,
  NutrientIntake,
  NutrientType,
  NutrientUnit,
} from "@/lib/contracts/food";

/**
 * Names for the stock `humane.common.food` enums, as the Pin's food experience
 * shows them (`FoodUtils.getNutrientName`, `abbreviatedUnitsString`), with the
 * unit each nutrient is usually counted in as the editor's default.
 */
export const NUTRIENTS: ReadonlyArray<{ type: NutrientType; label: string; unit: NutrientUnit }> = [
  { type: "CALORIES", label: "Calories", unit: "KCAL" },
  { type: "PROTEIN", label: "Protein", unit: "GRAMS" },
  { type: "TOTAL_CARBS", label: "Total carbs", unit: "GRAMS" },
  { type: "DIETARY_FIBER", label: "Dietary fiber", unit: "GRAMS" },
  { type: "SUGARS", label: "Sugars", unit: "GRAMS" },
  { type: "TOTAL_FAT", label: "Total fat", unit: "GRAMS" },
  { type: "SATURATED_FAT", label: "Saturated fat", unit: "GRAMS" },
  { type: "TRANS_FAT", label: "Trans fat", unit: "GRAMS" },
  { type: "MONOUNSATURATED_FAT", label: "Monounsaturated fat", unit: "GRAMS" },
  { type: "POLYUNSATURATED_FAT", label: "Polyunsaturated fat", unit: "GRAMS" },
  { type: "CHOLESTEROL", label: "Cholesterol", unit: "MILLIGRAMS" },
  { type: "SODIUM", label: "Sodium", unit: "MILLIGRAMS" },
  { type: "POTASSIUM", label: "Potassium", unit: "MILLIGRAMS" },
  { type: "CALCIUM", label: "Calcium", unit: "MILLIGRAMS" },
  { type: "IRON", label: "Iron", unit: "MILLIGRAMS" },
  { type: "VITAMIN_A", label: "Vitamin A", unit: "MICROGRAMS" },
  { type: "VITAMIN_C", label: "Vitamin C", unit: "MILLIGRAMS" },
];

export const UNITS: ReadonlyArray<{ unit: NutrientUnit; label: string }> = [
  { unit: "KCAL", label: "kcal" },
  { unit: "GRAMS", label: "g" },
  { unit: "MILLIGRAMS", label: "mg" },
  { unit: "MICROGRAMS", label: "µg" },
];

export const RESTRICTION_TYPES: ReadonlyArray<{
  type: FoodRestriction["restrictionType"];
  label: string;
}> = [
  { type: "ALLERGY", label: "Allergy" },
  { type: "INTOLERANCE", label: "Intolerance" },
  { type: "DIET", label: "Diet" },
  { type: "UNDEFINED", label: "Other" },
];

export const SEVERITIES: ReadonlyArray<{ severity: FoodRestriction["severity"]; label: string }> = [
  { severity: "UNKNOWN", label: "Not specified" },
  { severity: "MILD", label: "Mild" },
  { severity: "MODERATE", label: "Moderate" },
  { severity: "SEVERE", label: "Severe" },
];

export function nutrientLabel(type: NutrientType): string {
  return NUTRIENTS.find((nutrient) => nutrient.type === type)?.label ?? type;
}

export function unitLabel(unit: NutrientUnit): string {
  return UNITS.find((entry) => entry.unit === unit)?.label ?? unit;
}

/** "at least 120 g", "at most 2,200 kcal", "1,800–2,200 kcal". */
export function describeGoal(goal: NutrientGoal): string {
  const unit = unitLabel(goal.unit);
  const amount = (value: number) => value.toLocaleString();
  if (goal.min !== undefined && goal.max !== undefined) {
    return `${amount(goal.min)}–${amount(goal.max)} ${unit}`;
  }
  if (goal.min !== undefined) return `at least ${amount(goal.min)} ${unit}`;
  if (goal.max !== undefined) return `at most ${amount(goal.max)} ${unit}`;
  return "";
}

/** "1,050 of 1,800–2,200 kcal", "65 of at least 120 g", "8 g". Cosmos did the sums. */
export function describeIntake(total: NutrientIntake): string {
  const unit = unitLabel(total.unit);
  const consumed = total.consumed.toLocaleString(undefined, { maximumFractionDigits: 1 });
  // A goal reads as describeGoal shows it: rounding 0.24 to "0.2" would put an
  // "under" beside a total that looks equal to its goal.
  const amount = (value: number) => value.toLocaleString();
  if (total.min !== undefined && total.max !== undefined) {
    return `${consumed} of ${amount(total.min)}–${amount(total.max)} ${unit}`;
  }
  if (total.min !== undefined) return `${consumed} of at least ${amount(total.min)} ${unit}`;
  if (total.max !== undefined) return `${consumed} of at most ${amount(total.max)} ${unit}`;
  return `${consumed} ${unit}`;
}

const INTAKE_STATUS: Record<NonNullable<NutrientIntake["status"]>, string> = {
  under: "Under your goal",
  met: "Goal met",
  over: "Over your goal",
};

/** Whether a total meets its goal, and what it could not count; `null` when nothing to say. */
export function intakeNote(total: NutrientIntake): string | null {
  const notes: string[] = [];
  if (total.status) notes.push(INTAKE_STATUS[total.status]);
  if (total.goalUnitMismatch) notes.push("Your goal's unit can't be compared with this total");
  if (total.unreported === 1) notes.push("1 food had no figure for this, so it isn't counted");
  if (total.unreported > 1) {
    notes.push(`${total.unreported} foods had no figure for this, so they aren't counted`);
  }
  return notes.length > 0 ? `${notes.join(". ")}.` : null;
}

/** A goal row as the editor holds it: numbers as typed. */
export interface GoalDraft {
  uuid: string;
  type: NutrientType;
  unit: NutrientUnit;
  min: string;
  max: string;
}

export function goalDraft(goal: NutrientGoal): GoalDraft {
  return {
    uuid: goal.uuid,
    type: goal.type,
    unit: goal.unit,
    min: goal.min === undefined ? "" : String(goal.min),
    max: goal.max === undefined ? "" : String(goal.max),
  };
}

/** The goals to save, or the first sentence explaining why they cannot be. */
export function goalsFromDrafts(drafts: readonly GoalDraft[]): NutrientGoal[] | string {
  const goals: NutrientGoal[] = [];
  for (const draft of drafts) {
    const label = nutrientLabel(draft.type);
    const parse = (text: string) => (text.trim() === "" ? undefined : Number(text));
    const min = parse(draft.min);
    const max = parse(draft.max);
    if (min === undefined && max === undefined) return `${label} needs a minimum, a maximum, or both.`;
    for (const value of [min, max]) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1_000_000)) {
        return `${label} needs a number from 0 to 1,000,000.`;
      }
    }
    if (min !== undefined && max !== undefined && min > max) {
      return `${label}'s minimum is above its maximum.`;
    }
    goals.push({
      uuid: draft.uuid,
      type: draft.type,
      unit: draft.unit,
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
    });
  }
  return goals;
}
