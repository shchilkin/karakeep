import { z } from "zod";

// Server-side snapshots, not the 200-card general captioning batch.
export const MAX_LOCAL_CHECK_BATCH = 50_000;
export const zPrepareLocalCheckBatch = z.object({
  requestId: z.string().uuid(),
  selection: z.discriminatedUnion("type", [
    z.object({ type: z.literal("all") }),
    z.object({
      type: z.literal("ids"),
      ids: z.array(z.string().min(1)).min(1).max(MAX_LOCAL_CHECK_BATCH),
    }),
  ]),
});
export type LocalCheckSelection = z.infer<
  typeof zPrepareLocalCheckBatch
>["selection"];
export const zChangeLocalCheckBatch = z.object({
  id: z.string().uuid(),
  action: z.enum(["start", "pause", "resume"]),
});
export const zLocalCheckBatchItems = z.object({
  id: z.string().uuid(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(50),
});
export type LocalCheckBatchStatus = "draft" | "running" | "paused" | "complete";
export type LocalCheckItemState =
  | "ready"
  | "released"
  | "complete"
  | "failed"
  | "skipped";
export interface LocalCheckBatchView {
  id: string;
  status: LocalCheckBatchStatus;
  createdAt: number;
  total: number;
  counts: Record<LocalCheckItemState, number>;
  outcomeReasons: Record<string, number>;
}
