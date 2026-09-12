import { z } from "zod";

export const zImportProcessingStage = z.enum([
  "preview",
  "search",
  "local_check",
  "catalog",
]);
export type ImportProcessingStage = z.infer<typeof zImportProcessingStage>;
export const importStageOrder: Record<ImportProcessingStage, number> = {
  preview: 1,
  search: 2,
  local_check: 3,
  catalog: 4,
};
export const zReleaseImport = z
  .object({
    requestId: z.string().uuid(),
    stage: zImportProcessingStage,
    expectedGeneration: z.number().int().nonnegative(),
    retry: z.boolean().default(false),
  })
  .strict();
export const zImportProcessingView = z.object({
  sourceRevisionId: z.string(),
  stage: zImportProcessingStage,
  state: z.enum([
    "held",
    "queued",
    "running",
    "waiting_ai",
    "complete",
    "failed",
  ]),
  generation: z.number().int(),
  previewAssetId: z.string().nullable(),
  previewReady: z.boolean(),
  searchReady: z.boolean(),
  error: z.string().nullable(),
});
