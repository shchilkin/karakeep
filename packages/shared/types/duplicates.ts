import { z } from "zod";

export const zDuplicateDecision = z.enum([
  "keep_both",
  "defer",
  "prefer_primary",
]);
export const zDuplicateScan = z.object({
  afterId: z.string().nullish(),
  recheck: z.boolean().default(false),
});
export const zDuplicateList = z.object({
  cursor: z.string().nullish(),
  limit: z.number().int().min(1).max(50).default(20),
  view: z.enum(["pending", "reviewed", "all"]).default("pending"),
});
export const zDuplicateDecisionRequest = z.object({
  groupId: z.string(),
  evidenceVersion: z.string(),
  expectedDecisionVersion: z.number().int().nonnegative(),
  decision: zDuplicateDecision.nullable(),
  primaryBookmarkId: z.string().nullable().default(null),
});
