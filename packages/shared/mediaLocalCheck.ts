import { z } from "zod";
import { zSensitiveCategories } from "./sensitiveContent";

export const LOCAL_CHECK_MODEL = "nvidia/Nemotron-3.5-Content-Safety";
export const LOCAL_CHECK_REVISION = "35645ed3543b7e7ffaed2e788699e57a5051497c";
export const LOCAL_CHECK_POLICY = "nemotron-visibility-v3";
export const zLocalCheckMode = z.enum(["off", "review", "enforce"]);

/** The verdict describes only the outgoing JPEGs, never the complete archive. */
export const zLocalFrameResult = z
  .object({
    model: z.literal(LOCAL_CHECK_MODEL),
    revision: z.literal(LOCAL_CHECK_REVISION),
    policy: z.literal(LOCAL_CHECK_POLICY),
    precision: z.literal("bf16"),
    status: z.enum(["complete", "unknown"]),
    categories: zSensitiveCategories,
  })
  .strict();
export const zLocalCheckResult = z
  .object({
    scope: z.literal("outgoing_images_only"),
    frames: z
      .array(
        zLocalFrameResult.extend({
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .min(1)
      .max(3),
  })
  .strict();
export type LocalCheckResult = z.infer<typeof zLocalCheckResult>;

/** Upload policy is independent of Work/Balanced/Show all and manual clears. */
export function holdLocalMedia(result: LocalCheckResult) {
  return result.frames.some(
    (frame) =>
      frame.status !== "complete" ||
      frame.categories.some(
        (category) =>
          category !== "revealing_clothing" && category !== "suggestive",
      ),
  );
}
