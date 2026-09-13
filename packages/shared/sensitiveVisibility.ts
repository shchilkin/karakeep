import type { MediaCatalogState } from "./mediaCatalog";
import { localCheckCategoryKeys } from "./mediaLocalCheck";
import { shouldConcealSensitive } from "./sensitiveContent";
import type { SensitiveCategory, SensitivityMode } from "./sensitiveContent";

export interface SensitiveBookmark {
  id: string;
  imageSet?: {
    revision: number;
    sensitivity: {
      work: boolean;
      balanced: boolean;
      sensitive: boolean;
      labels: (
        | `sensitive.categories.${SensitiveCategory}`
        | "media_ai.native_categories.sexual"
        | "media_ai.native_categories.violence"
        | "media_ai.native_categories.dangerous"
      )[];
    };
  };
  sensitiveCategories?: SensitiveCategory[] | null;
  mediaAi?: MediaCatalogState | null;
}

/** Manual [] is an explicit clear; null delegates to observations. Native
 * negatives cover only sampled images and cannot certify Work suitability. */
export function sensitiveAssessment(bookmark: SensitiveBookmark) {
  if (bookmark.imageSet)
    return { source: "automatic" as const, ...bookmark.imageSet.sensitivity };
  const manual = bookmark.sensitiveCategories;
  if (manual != null) {
    return {
      source: "manual" as const,
      sensitive: manual.length > 0,
      labels: manual.map((c) => `sensitive.categories.${c}` as const),
    };
  }
  const check = bookmark.mediaAi?.localCheck;
  const labels = check ? localCheckCategoryKeys(check) : [];
  return {
    source: "automatic" as const,
    sensitive: labels.length > 0,
    labels,
  };
}

export function concealSensitiveBookmark(
  bookmark: SensitiveBookmark,
  mode: SensitivityMode,
) {
  if (mode === "all") return false;
  if (bookmark.imageSet) return bookmark.imageSet.sensitivity[mode];
  if (bookmark.sensitiveCategories != null)
    return shouldConcealSensitive(bookmark.sensitiveCategories, mode);
  return mode === "work" || sensitiveAssessment(bookmark).sensitive;
}

/** A new observation or a manual decision revokes the temporary reveal. */
export function sensitiveRevealKey(bookmark: SensitiveBookmark) {
  return JSON.stringify([
    bookmark.id,
    bookmark.imageSet,
    bookmark.sensitiveCategories == null
      ? null
      : [...bookmark.sensitiveCategories].sort(),
    bookmark.mediaAi?.localCheck ?? null,
  ]);
}
