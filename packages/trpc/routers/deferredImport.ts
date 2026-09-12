import { z } from "zod";
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
