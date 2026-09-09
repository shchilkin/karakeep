import { z } from "zod";

export const sensitiveCategories = [
  "revealing_clothing",
  "suggestive",
  "nudity",
  "explicit_sexual",
  "violence",
  "gore",
  "self_harm",
  "drugs",
  "hate_extremism",
  "disturbing",
  "other",
] as const;
export const zSensitiveCategory = z.enum(sensitiveCategories);
export const zSensitiveCategories = z
  .array(zSensitiveCategory)
  .max(sensitiveCategories.length)
  .refine(
    (categories) => new Set(categories).size === categories.length,
    "Duplicate categories",
  );
export type SensitiveCategory = z.infer<typeof zSensitiveCategory>;
export const zSensitivityMode = z.enum(["work", "balanced", "all"]);
export type SensitivityMode = z.infer<typeof zSensitivityMode>;

/** Display policy, independent of classification. Unmarked is not certified safe. */
export function shouldConcealSensitive(
  categories: readonly SensitiveCategory[] | null | undefined,
  mode: SensitivityMode,
) {
  if (mode === "all") return false;
  return (
    categories?.some(
      (category) =>
        mode === "work" ||
        (category !== "revealing_clothing" && category !== "suggestive"),
    ) ?? false
  );
}
