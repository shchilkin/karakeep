import { z } from "zod";

export const zCloudMode = z.enum(["off", "manual", "auto"]);
export const zCatalogModelName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/);
export const zAiFilter = z.object({
  query: z.string().trim().max(200).optional(),
  provider: z.enum(["local", "xai", "openai", "unknown"]).optional(),
  model: z.string().max(120).optional(),
  status: z
    .enum(["all", "missing", "failed", "active", "success", "needs_review"])
    .default("all"),
  analyzedBefore: z.string().datetime().optional(),
});
export type AiFilter = z.infer<typeof zAiFilter>;
export const zAiBatchRequest = z.object({
  requestId: z.string().uuid(),
  selection: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("ids"),
      ids: z.array(z.string()).min(1).max(200),
    }),
    z.object({ type: z.literal("filter"), filter: zAiFilter }),
  ]),
  mode: z.enum(["hybrid", "local"]).default("hybrid"),
  model: zCatalogModelName,
  action: z.enum(["analyze", "refresh"]).default("analyze"),
});
export type AiBatchRequest = z.infer<typeof zAiBatchRequest>;
export interface AiBatchEntry {
  bookmarkId: string;
  runId: string;
  fingerprint: string;
  priorRunId: string | null;
  policyRevision: number;
  contentRevision: number;
  status: "ready" | "queued" | "skipped";
  reason?: string;
}
export const activeAiStatuses = [
  "pending",
  "checking_local",
  "processing_local",
  "processing",
  "waiting_resource",
  "waiting_control",
];
export const failedAiStatuses = [
  "failed",
  "local_failed",
  "timeout",
  "refused",
  "rate_limited",
  "quota_exceeded",
  "stale",
  "cancelled",
];
