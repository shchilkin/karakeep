import { z } from "zod";
import { zSensitiveCategories } from "./sensitiveContent";

export const LOCAL_CHECK_MODEL = "google/shieldgemma-2-4b-it";
export const LOCAL_CHECK_REVISION = "eaf60452b5fc41a911338a022e628b0c15283897";
export const LOCAL_CHECK_POLICY = "shieldgemma-native-v1";
export const LOCAL_CHECK_THRESHOLD = 0.5;
export const localNativePolicies = ["dangerous", "sexual", "violence"] as const;
export const zLocalCheckMode = z.enum(["off", "review", "enforce"]);
const score = z.number().finite().min(0).max(1);
const zNativeScores = z
  .object({ dangerous: score, sexual: score, violence: score })
  .strict();

/** Native policy scores never imply finer manual labels such as nudity or self_harm. */
export const zLocalFrameResult = z
  .object({
    model: z.literal(LOCAL_CHECK_MODEL),
    revision: z.literal(LOCAL_CHECK_REVISION),
    policy: z.literal(LOCAL_CHECK_POLICY),
    precision: z.literal("bf16"),
    status: z.enum(["complete", "unknown"]),
    categories: z.array(z.enum(localNativePolicies)).max(3),
    scores: zNativeScores.nullable(),
  })
  .strict()
  .refine((frame) => {
    if (frame.status === "unknown")
      return frame.scores === null && frame.categories.length === 0;
    if (!frame.scores) return false;
    const expected = localNativePolicies.filter(
      (policy) => frame.scores![policy] >= LOCAL_CHECK_THRESHOLD,
    );
    return (
      new Set(frame.categories).size === frame.categories.length &&
      expected.length === frame.categories.length &&
      expected.every((policy) => frame.categories.includes(policy))
    );
  }, "Categories must match complete native scores and the pinned threshold");

// Preserve saved observations when reading old bookmarks, but never admit or reuse
// an old model's result for a new cloud request.
const zLegacyLocalFrame = z
  .object({
    model: z.literal("nvidia/Nemotron-3.5-Content-Safety"),
    revision: z.literal("35645ed3543b7e7ffaed2e788699e57a5051497c"),
    policy: z.literal("nemotron-visibility-v3"),
    precision: z.literal("bf16"),
    status: z.enum(["complete", "unknown"]),
    categories: zSensitiveCategories,
  })
  .strict();
const fingerprint = { sha256: z.string().regex(/^[a-f0-9]{64}$/) };
const zCurrentStoredFrame = zLocalFrameResult.safeExtend(fingerprint);
export const zLocalCheckResult = z
  .object({
    scope: z.literal("outgoing_images_only"),
    frames: z
      .array(
        z.union([zCurrentStoredFrame, zLegacyLocalFrame.extend(fingerprint)]),
      )
      .min(1)
      .max(3),
  })
  .strict();
export const zCurrentLocalCheckResult = zLocalCheckResult.extend({
  frames: z.array(zCurrentStoredFrame).min(1).max(3),
});
export type LocalCheckResult = z.infer<typeof zLocalCheckResult>;

/** Upload policy is independent of Work/Balanced/Show all and manual clears. */
export function holdLocalMedia(result: LocalCheckResult) {
  return result.frames.some(
    (frame) =>
      frame.status !== "complete" ||
      (frame.model === LOCAL_CHECK_MODEL
        ? frame.categories.length > 0
        : frame.categories.some(
            (category) =>
              category !== "revealing_clothing" && category !== "suggestive",
          )),
  );
}

export function localCheckCategoryKeys(result: LocalCheckResult) {
  type Key =
    | `media_ai.native_categories.${(typeof localNativePolicies)[number]}`
    | `sensitive.categories.${z.infer<typeof zSensitiveCategories>[number]}`;
  const keys = new Set<Key>();
  for (const frame of result.frames) {
    if (frame.model === LOCAL_CHECK_MODEL) {
      for (const category of frame.categories)
        keys.add(`media_ai.native_categories.${category}`);
    } else {
      for (const category of frame.categories)
        keys.add(`sensitive.categories.${category}`);
    }
  }
  return [...keys];
}
