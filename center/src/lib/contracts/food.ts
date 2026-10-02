import * as z from "zod/mini";
import { countSchema, epochSecondsSchema } from "./pagination";

/** humane.common.food enums. Cosmos account_api/capture_api use these exact names. */
export const nutrientTypeSchema = z.enum([
  "CALCIUM",
  "CALORIES",
  "CHOLESTEROL",
  "DIETARY_FIBER",
  "IRON",
  "MONOUNSATURATED_FAT",
  "POLYUNSATURATED_FAT",
  "POTASSIUM",
  "PROTEIN",
  "SATURATED_FAT",
  "SODIUM",
  "SUGARS",
  "TOTAL_CARBS",
  "TOTAL_FAT",
  "TRANS_FAT",
  "VITAMIN_A",
  "VITAMIN_C",
]);
export type NutrientType = z.infer<typeof nutrientTypeSchema>;
export const nutrientUnitSchema = z.enum([
  "KCAL",
  "GRAMS",
  "MILLIGRAMS",
  "MICROGRAMS",
]);
export type NutrientUnit = z.infer<typeof nutrientUnitSchema>;
export const nutritionInfoSchema = z.object({
  nutrientType: nutrientTypeSchema,
  value: z.number(),
});
export type NutritionInfo = z.infer<typeof nutritionInfoSchema>;
const foodFields = {
  itemName: z.string(),
  brand: z.optional(z.string()),
  typicalServingSize: z.optional(z.string()),
  servingsConsumed: z.number(),
  nutritionInfo: z.array(nutritionInfoSchema),
};
export const foodLogEntrySchema = z.object({
  ...foodFields,
  loggedAt: z.string(),
});
export type FoodLogEntry = z.infer<typeof foodLogEntrySchema>;
export const foodLogEntryDtoSchema = z.object({
  ...foodFields,
  memoryUuid: z.string(),
  loggedAt: epochSecondsSchema,
});
export const foodRestrictionSchema = z.object({
  uuid: z.string(),
  name: z.string(),
  restrictionType: z.enum(["UNDEFINED", "ALLERGY", "INTOLERANCE", "DIET"]),
  severity: z.enum(["UNKNOWN", "MILD", "MODERATE", "SEVERE"]),
});
export type FoodRestriction = z.infer<typeof foodRestrictionSchema>;
export const nutrientGoalSchema = z.object({
  uuid: z.string(),
  type: nutrientTypeSchema,
  unit: nutrientUnitSchema,
  min: z.optional(z.number()),
  max: z.optional(z.number()),
});
export type NutrientGoal = z.infer<typeof nutrientGoalSchema>;
export const foodPreferencesSchema = z.object({
  restrictions: z.array(foodRestrictionSchema),
  dailyIntakeGoals: z.array(nutrientGoalSchema),
});
export type FoodPreferences = z.infer<typeof foodPreferencesSchema>;
export const foodPreferencesViewSchema = z.extend(foodPreferencesSchema, {
  sealedRestrictions: countSchema,
});
export type FoodPreferencesView = z.infer<typeof foodPreferencesViewSchema>;
export const nutrientIntakeSchema = z.object({
  type: nutrientTypeSchema,
  unit: nutrientUnitSchema,
  consumed: z.number(),
  min: z.optional(z.number()),
  max: z.optional(z.number()),
  status: z.optional(z.enum(["under", "met", "over"])),
  unreported: countSchema,
  goalUnitMismatch: z.optional(z.literal(true)),
});
export type NutrientIntake = z.infer<typeof nutrientIntakeSchema>;
export const foodIntakeSchema = z.object({
  logged: countSchema,
  nutrients: z.array(nutrientIntakeSchema),
});
export type FoodIntake = z.infer<typeof foodIntakeSchema>;
