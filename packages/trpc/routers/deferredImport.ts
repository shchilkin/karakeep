import { zReleaseImport } from "@karakeep/shared/types/importProcessing";
import {
  getImportProcessing,
  releaseImportProcessing,
} from "../models/importProcessing";
import { z } from "zod";
import {
  zPrepareLocalCheckBatch,
  zChangeLocalCheckBatch,
  zLocalCheckBatchItems,
} from "@karakeep/shared/types/importLocalCheckBatch";
import {
  getLocalCheckBatch,
  prepareLocalCheckBatch,
  changeLocalCheckBatch,
  listLocalCheckBatches,
  getLocalCheckBatchItems,
} from "../models/importLocalCheckBatches";
import { createScopedAuthedProcedure, router } from "..";
import {
  zImportFence,
  zImportReservation,
} from "@karakeep/shared/types/deferredImport";
import {
  commitImport,
  importCapabilities,
  importStatus,
  lookupImport,
  reserveImport,
  verifyImport,
} from "../models/deferredImport";
const read = createScopedAuthedProcedure("imports");
const write = createScopedAuthedProcedure("imports");
export const deferredImportRouter = router({
  localCheckBatchItems: read
    .input(zLocalCheckBatchItems)
    .query(({ ctx, input }) => getLocalCheckBatchItems(ctx, input)),
  localCheckBatches: read.query(({ ctx }) => listLocalCheckBatches(ctx)),
  changeLocalCheckBatch: write
    .input(zChangeLocalCheckBatch)
    .mutation(({ ctx, input }) => changeLocalCheckBatch(ctx, input)),
  prepareLocalCheckBatch: write
    .input(zPrepareLocalCheckBatch)
    .mutation(({ ctx, input }) => prepareLocalCheckBatch(ctx, input)),
  localCheckBatch: read
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => getLocalCheckBatch(ctx, input.id)),
  processing: read
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => getImportProcessing(ctx, input.id)),
  release: write
    .input(zReleaseImport.extend({ id: z.string() }))
    .mutation(({ ctx, input }) =>
      releaseImportProcessing(ctx, input.id, input),
    ),
  capabilities: read.query(({ ctx }) => importCapabilities(ctx)),
  lookup: read
    .input(zImportReservation)
    .query(({ ctx, input }) => lookupImport(ctx, input)),
  reserve: write
    .input(
      z.object({
        idempotencyKey: z.string().min(1).max(200),
        payload: zImportReservation,
      }),
    )
    .mutation(({ ctx, input }) =>
      reserveImport(ctx, input.payload, input.idempotencyKey),
    ),
  status: read
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => importStatus(ctx, input.id)),
  verify: write
    .input(zImportFence.extend({ id: z.string() }))
    .mutation(({ ctx, input }) =>
      verifyImport(ctx, input.id, input.fencingToken),
    ),
  commit: write
    .input(zImportFence.extend({ id: z.string() }))
    .mutation(({ ctx, input }) =>
      commitImport(ctx, input.id, input.fencingToken),
    ),
});
