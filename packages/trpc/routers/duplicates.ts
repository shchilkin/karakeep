import { z } from "zod";
import {
  zDuplicateDecisionRequest,
  zDuplicateList,
  zDuplicateScan,
} from "@karakeep/shared/types/duplicates";
import { createScopedAuthedProcedure, router, sessionProcedure } from "..";
import {
  decideDuplicateGroup,
  duplicateStatus,
  getDuplicateGroup,
  listDuplicateGroups,
  scanNextOriginal,
} from "../models/duplicates";

const read = createScopedAuthedProcedure("bookmarks");
export const duplicatesAppRouter = router({
  status: read.query(({ ctx }) => duplicateStatus(ctx)),
  list: read
    .input(zDuplicateList)
    .query(({ ctx, input }) => listDuplicateGroups(ctx, input)),
  get: read
    .input(z.object({ groupId: z.string() }))
    .query(({ ctx, input }) => getDuplicateGroup(ctx, input.groupId)),
  // Explicit owner-session action. Reading the page never starts disk work.
  scanNext: sessionProcedure
    .input(zDuplicateScan)
    .mutation(({ ctx, input }) => scanNextOriginal(ctx, input)),
  decide: createScopedAuthedProcedure("bookmarks")
    .input(zDuplicateDecisionRequest)
    .mutation(({ ctx, input }) => decideDuplicateGroup(ctx, input)),
});
