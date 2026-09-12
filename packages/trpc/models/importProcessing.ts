import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import {
  bookmarks,
  mediaAiRequests,
  importProcessing,
  importSourceAttachments,
  importSourceRevisions,
} from "@karakeep/db/schema";
import serverConfig from "@karakeep/shared/config";
import {
  importStageOrder,
  zImportProcessingView,
} from "@karakeep/shared/types/importProcessing";
import type { zReleaseImport } from "@karakeep/shared/types/importProcessing";
import type { AuthedContext } from "..";

function ownedRevision(
  ctx: { db: Pick<AuthedContext["db"], "select">; user: AuthedContext["user"] },
  id: string,
) {
  const row = ctx.db
    .select()
    .from(importSourceRevisions)
    .where(
      and(
        eq(importSourceRevisions.id, id),
        eq(importSourceRevisions.userId, ctx.user.id),
      ),
    )
    .get();
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
  if (row.state !== "committed" || !row.receipt)
    throw new TRPCError({
      code: "CONFLICT",
      message: "Verify and commit the original before processing.",
    });
  return row;
}

export function importProcessingView(
  row: typeof importProcessing.$inferSelect | null | undefined,
) {
  if (!row) return null;
  return zImportProcessingView.parse({
    ...row,
    previewAssetId: row.previewReady ? row.previewAssetId : null,
  });
}
export function getImportProcessing(ctx: AuthedContext, id: string) {
  const source = ownedRevision(ctx, id);
  return importProcessingView(
    ctx.db
      .select()
      .from(importProcessing)
      .where(eq(importProcessing.bookmarkId, source.bookmarkId))
      .get(),
  );
}

/** Persist intent only. Workers perform I/O; this API cannot enable ordinary automation. */
export function releaseImportProcessing(
  ctx: AuthedContext,
  id: string,
  input: z.infer<typeof zReleaseImport>,
) {
  return ctx.db.transaction(
    (tx) => {
      const source = ownedRevision({ ...ctx, db: tx }, id);
      const bookmark = tx
        .select()
        .from(bookmarks)
        .where(
          and(
            eq(bookmarks.id, source.bookmarkId),
            eq(bookmarks.userId, ctx.user.id),
          ),
        )
        .get();
      if (!bookmark || bookmark.processingPolicy !== "deferred")
        throw new TRPCError({
          code: "CONFLICT",
          message: "Import retention policy changed.",
        });
      const file = tx
        .select()
        .from(importSourceAttachments)
        .where(eq(importSourceAttachments.sourceRevisionId, id))
        .get();
      if (
        !file ||
        file.state !== "verified" ||
        !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
          file.detectedMime ?? "",
        )
      )
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Processing release currently supports verified images only.",
        });
      const prior = tx
        .select()
        .from(importProcessing)
        .where(eq(importProcessing.bookmarkId, bookmark.id))
        .get();
      if (prior?.requestId === input.requestId) {
        if (prior.stage !== input.stage)
          throw new TRPCError({
            code: "CONFLICT",
            message: "Request identity already used for another stage.",
          });
        return importProcessingView(prior);
      }
      if ((prior?.generation ?? 0) !== input.expectedGeneration)
        throw new TRPCError({
          code: "CONFLICT",
          message: "Processing changed; refresh its status.",
        });
      if (
        prior &&
        (importStageOrder[input.stage] < importStageOrder[prior.stage] ||
          !["held", "complete", "failed"].includes(prior.state))
      )
        throw new TRPCError({
          code: "CONFLICT",
          message: "Wait for the current release; stages cannot be downgraded.",
        });
      if (
        prior?.stage === input.stage &&
        prior.state !== "held" &&
        !(input.retry && prior.state === "failed")
      )
        return importProcessingView(prior);
      if (
        importStageOrder[input.stage] >= importStageOrder.local_check &&
        (!serverConfig.mediaAi.enabled ||
          serverConfig.mediaAi.localMode !== "enforce" ||
          !serverConfig.mediaAi.hybridEnabled)
      )
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Local admission and hybrid analysis must be enabled before release.",
        });
      if (
        prior?.aiRunId &&
        bookmark.mediaAi?.runId === prior.aiRunId &&
        bookmark.mediaAi.status !== "success" &&
        tx
          .select({ id: mediaAiRequests.id })
          .from(mediaAiRequests)
          .where(eq(mediaAiRequests.id, prior.aiRunId))
          .get()
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "A paid attempt has an unconfirmed result. Ordinary retry cannot repeat it.",
        });
      }
      const values = {
        bookmarkId: bookmark.id,
        sourceRevisionId: id,
        userId: ctx.user.id,
        requestId: input.requestId,
        stage: input.stage,
        state: "queued" as const,
        generation: (prior?.generation ?? 0) + 1,
        policyRevision: bookmark.policyRevision,
        contentRevision: bookmark.contentRevision,
        previewAssetId: prior?.previewAssetId ?? randomUUID(),
        originalWidth: prior?.originalWidth ?? null,
        originalHeight: prior?.originalHeight ?? null,
        previewReady: prior?.previewReady ?? false,
        searchReady: prior?.searchReady ?? false,
        aiRunId:
          prior?.stage === input.stage &&
          prior.aiRunId === bookmark.mediaAi?.runId &&
          (bookmark.mediaAi?.status === "success" ||
            (input.stage === "local_check" &&
              bookmark.mediaAi?.status === "local_review"))
            ? prior.aiRunId
            : null,
        leaseToken: null,
        leaseUntil: 0,
        error: null,
        updatedAt: Date.now(),
      };
      tx.insert(importProcessing)
        .values(values)
        .onConflictDoUpdate({
          target: importProcessing.bookmarkId,
          set: values,
        })
        .run();
      return importProcessingView(values);
    },
    { behavior: "immediate" },
  );
}
