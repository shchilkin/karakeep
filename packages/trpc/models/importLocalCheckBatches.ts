import { createHash, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { DB } from "@karakeep/db";
import {
  bookmarks,
  importLocalCheckBatches as batches,
  importLocalCheckItems as items,
  importProcessing,
  importSourceAttachments,
  importSourceRevisions,
} from "@karakeep/db/schema";
import { MAX_IMPORT_PREVIEW_BYTES } from "@karakeep/shared/types/deferredImport";
import { MAX_LOCAL_CHECK_BATCH } from "@karakeep/shared/types/importLocalCheckBatch";
import type {
  LocalCheckBatchView,
  zPrepareLocalCheckBatch,
  zChangeLocalCheckBatch,
  zLocalCheckBatchItems,
} from "@karakeep/shared/types/importLocalCheckBatch";
import serverConfig from "@karakeep/shared/config";
import type { z } from "zod";
import { releaseImportProcessing } from "./importProcessing";

interface Context {
  db: Pick<DB, "select" | "insert" | "update" | "transaction">;
  user: { id: string };
}
function localCheckingEnabled() {
  const config = serverConfig.mediaAi;
  return (
    config.enabled && config.hybridEnabled && config.localMode === "enforce"
  );
}
interface Candidate {
  source: { receipt: unknown };
  bookmark: { processingPolicy: string; mediaAi: unknown };
  file: Pick<
    typeof importSourceAttachments.$inferSelect,
    "state" | "storedSize" | "detectedMime"
  > | null;
  processing: Pick<
    typeof importProcessing.$inferSelect,
    "state" | "stage" | "previewReady"
  > | null;
}
function skipReason(row: Candidate): string | null {
  if (
    !row.source.receipt ||
    row.bookmark.processingPolicy !== "deferred" ||
    row.file?.state !== "verified" ||
    !row.file.storedSize ||
    row.file.storedSize > MAX_IMPORT_PREVIEW_BYTES ||
    !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
      row.file.detectedMime ?? "",
    )
  )
    return "unsupported";
  const prior = row.processing;
  if (prior?.state === "failed") return "prior_failure";
  if (prior && ["queued", "running", "waiting_ai"].includes(prior.state))
    return "active";
  if (prior?.stage === "local_check" || prior?.stage === "catalog")
    return "already_checked";
  // Never overwrite or automatically repeat an existing/uncertain AI checkpoint.
  if (row.bookmark.mediaAi) return "existing_analysis";
  if (!prior?.previewReady) return "preview_missing";
  return null;
}
function owned(ctx: Context, id: string) {
  const batch = ctx.db
    .select()
    .from(batches)
    .where(and(eq(batches.id, id), eq(batches.userId, ctx.user.id)))
    .get();
  if (!batch) throw new TRPCError({ code: "NOT_FOUND" });
  return batch;
}
export function getLocalCheckBatch(
  ctx: Context,
  id: string,
): LocalCheckBatchView {
  const batch = owned(ctx, id);
  const counts: LocalCheckBatchView["counts"] = {
    ready: 0,
    released: 0,
    complete: 0,
    failed: 0,
    skipped: 0,
  };
  const outcomeReasons: Record<string, number> = {};
  for (const row of ctx.db
    .select({
      state: items.state,
      reason: items.reason,
      count: sql<number>`count(*)`,
    })
    .from(items)
    .where(eq(items.batchId, id))
    .groupBy(items.state, items.reason)
    .all()) {
    counts[row.state] += row.count;
    if (row.reason)
      outcomeReasons[row.reason] =
        (outcomeReasons[row.reason] ?? 0) + row.count;
  }
  return {
    id,
    status: batch.status,
    createdAt: batch.createdAt,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    counts,
    outcomeReasons,
  };
}

export function listLocalCheckBatches(ctx: Context) {
  return ctx.db
    .select({ id: batches.id })
    .from(batches)
    .where(eq(batches.userId, ctx.user.id))
    .orderBy(
      sql`case when ${batches.status} in ('running', 'paused') then 0 else 1 end`,
      desc(batches.createdAt),
    )
    .limit(20)
    .all()
    .map(({ id }) => getLocalCheckBatch(ctx, id));
}

export function getLocalCheckBatchItems(
  ctx: Context,
  input: z.infer<typeof zLocalCheckBatchItems>,
) {
  const view = getLocalCheckBatch(ctx, input.id);
  return {
    total: view.total,
    items: ctx.db
      .select({
        bookmarkId: items.bookmarkId,
        state: items.state,
        reason: items.reason,
      })
      .from(items)
      .where(eq(items.batchId, input.id))
      .orderBy(items.bookmarkId)
      .limit(input.limit)
      .offset(input.offset)
      .all(),
  };
}

export function changeLocalCheckBatch(
  ctx: Context,
  input: z.infer<typeof zChangeLocalCheckBatch>,
) {
  return ctx.db.transaction(
    (tx) => {
      const scope = { ...ctx, db: tx };
      const batch = owned(scope, input.id);
      if (batch.status === "complete")
        return getLocalCheckBatch(scope, input.id);
      if (input.action === "pause") {
        if (batch.status !== "draft")
          tx.update(batches)
            .set({ status: "paused" })
            .where(eq(batches.id, input.id))
            .run();
      } else {
        if (
          (input.action === "start" && batch.status === "paused") ||
          (input.action === "resume" && batch.status === "draft")
        )
          throw new TRPCError({
            code: "CONFLICT",
            message: "Refresh the batch before changing its state.",
          });
        if (!localCheckingEnabled())
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Local classification must be enabled in enforce mode.",
          });
        if (
          tx
            .select({ id: batches.id })
            .from(batches)
            .where(
              and(
                eq(batches.userId, ctx.user.id),
                ne(batches.id, input.id),
                inArray(batches.status, ["running", "paused"]),
              ),
            )
            .get()
        )
          throw new TRPCError({
            code: "CONFLICT",
            message: "Finish or resume the existing local-check batch first.",
          });
        const view = getLocalCheckBatch(scope, input.id);
        tx.update(batches)
          .set({
            status:
              view.counts.ready + view.counts.released ? "running" : "complete",
          })
          .where(eq(batches.id, input.id))
          .run();
      }
      return getLocalCheckBatch(scope, input.id);
    },
    { behavior: "immediate" },
  );
}

export function prepareLocalCheckBatch(
  ctx: Context,
  input: z.infer<typeof zPrepareLocalCheckBatch>,
) {
  return ctx.db.transaction(
    (tx) => {
      const selection =
        input.selection.type === "all"
          ? "all"
          : [...new Set(input.selection.ids)].sort();
      const selectionKey = createHash("sha256")
        .update(JSON.stringify(selection))
        .digest("hex");
      const prior = tx
        .select()
        .from(batches)
        .where(eq(batches.id, input.requestId))
        .get();
      if (prior) {
        owned({ ...ctx, db: tx }, input.requestId);
        if (prior.selectionKey !== selectionKey)
          throw new TRPCError({
            code: "CONFLICT",
            message: "Request identity already used for another selection.",
          });
        return getLocalCheckBatch({ ...ctx, db: tx }, input.requestId);
      }
      // Do not materialize archived payloads, metadata or descriptions for a
      // library-sized selection. JSON membership avoids SQLite's bind limit.
      const rows = tx
        .select({
          source: {
            id: importSourceRevisions.id,
            receipt: sql<boolean>`${importSourceRevisions.receipt} is not null`,
          },
          bookmark: {
            id: bookmarks.id,
            policyRevision: bookmarks.policyRevision,
            contentRevision: bookmarks.contentRevision,
            processingPolicy: bookmarks.processingPolicy,
            mediaAi: sql<boolean>`${bookmarks.mediaAi} is not null`,
          },
          file: {
            state: importSourceAttachments.state,
            storedSize: importSourceAttachments.storedSize,
            detectedMime: importSourceAttachments.detectedMime,
          },
          processing: {
            generation: importProcessing.generation,
            state: importProcessing.state,
            stage: importProcessing.stage,
            previewReady: importProcessing.previewReady,
          },
        })
        .from(importSourceRevisions)
        .innerJoin(
          bookmarks,
          eq(bookmarks.id, importSourceRevisions.bookmarkId),
        )
        .leftJoin(
          importSourceAttachments,
          eq(
            importSourceAttachments.sourceRevisionId,
            importSourceRevisions.id,
          ),
        )
        .leftJoin(
          importProcessing,
          eq(importProcessing.bookmarkId, bookmarks.id),
        )
        .where(
          and(
            eq(importSourceRevisions.userId, ctx.user.id),
            eq(bookmarks.userId, ctx.user.id),
            eq(importSourceRevisions.state, "committed"),
            selection === "all"
              ? undefined
              : sql`${bookmarks.id} in (select value from json_each(${JSON.stringify(selection)}))`,
          ),
        )
        .limit(MAX_LOCAL_CHECK_BATCH + 1)
        .all();
      if (rows.length > MAX_LOCAL_CHECK_BATCH)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Selection exceeds 50000 imports. Select a smaller group.",
        });
      tx.insert(batches)
        .values({
          id: input.requestId,
          userId: ctx.user.id,
          selectionKey,
          status: "draft",
          createdAt: Date.now(),
        })
        .run();
      for (const row of rows) {
        const reason = skipReason(row);
        tx.insert(items)
          .values({
            batchId: input.requestId,
            bookmarkId: row.bookmark.id,
            sourceRevisionId: row.source.id,
            requestId: randomUUID(),
            generation: row.processing?.generation ?? 0,
            policyRevision: row.bookmark.policyRevision,
            contentRevision: row.bookmark.contentRevision,
            state: reason ? "skipped" : "ready",
            reason,
          })
          .run();
      }
      return getLocalCheckBatch({ ...ctx, db: tx }, input.requestId);
    },
    { behavior: "immediate" },
  );
}

/** Worker entry point. Reconcile durable receipts before admitting at most one
 * original globally. The intent and batch cursor commit in the same transaction;
 * no network I/O or model invocation occurs here. */
export function advanceLocalCheckBatches(database: DB) {
  return database.transaction(
    (tx) => {
      let changed = false;
      const mark = (
        item: typeof items.$inferSelect,
        state: typeof items.$inferSelect.state,
        reason: string | null = null,
      ) => {
        tx.update(items)
          .set({ state, reason })
          .where(
            and(
              eq(items.batchId, item.batchId),
              eq(items.bookmarkId, item.bookmarkId),
            ),
          )
          .run();
        changed = true;
      };
      const released = tx
        .select({
          item: items,
          processing: importProcessing,
          bookmark: bookmarks,
        })
        .from(items)
        .leftJoin(
          importProcessing,
          eq(importProcessing.bookmarkId, items.bookmarkId),
        )
        .leftJoin(bookmarks, eq(bookmarks.id, items.bookmarkId))
        .where(eq(items.state, "released"))
        .all();
      for (const { item, processing: p, bookmark: b } of released) {
        let failure: string | null = null;
        if (
          !p ||
          !b ||
          p.requestId !== item.requestId ||
          p.generation !== item.generation ||
          p.stage !== "local_check" ||
          b.policyRevision !== item.policyRevision ||
          b.contentRevision !== item.contentRevision
        )
          failure = "processing_changed";
        else if (p.state === "failed") failure = p.error ?? "processing_failed";
        else if (p.state === "complete") {
          if (
            p.aiRunId &&
            b.mediaAi?.runId === p.aiRunId &&
            b.mediaAi.status === "local_review" &&
            b.mediaAi.classificationOnly &&
            b.mediaAi.localOnly
          )
            mark(item, "complete");
          else failure = "checkpoint_unconfirmed";
        }
        if (failure) {
          mark(item, "failed", failure);
          tx.update(batches)
            .set({ status: "paused" })
            .where(eq(batches.id, item.batchId))
            .run();
        }
      }
      for (const batch of tx
        .select()
        .from(batches)
        .where(inArray(batches.status, ["running", "paused"]))
        .all()) {
        if (
          !tx
            .select({ id: items.bookmarkId })
            .from(items)
            .where(
              and(
                eq(items.batchId, batch.id),
                inArray(items.state, ["ready", "released"]),
              ),
            )
            .get()
        ) {
          tx.update(batches)
            .set({ status: "complete" })
            .where(eq(batches.id, batch.id))
            .run();
          changed = true;
        }
      }
      // Repeated polling/restarts cannot issue another intent while one is pending.
      if (
        tx
          .select({ id: items.bookmarkId })
          .from(items)
          .where(eq(items.state, "released"))
          .get()
      )
        return changed;
      const batch = tx
        .select()
        .from(batches)
        .where(eq(batches.status, "running"))
        .orderBy(batches.createdAt, batches.id)
        .get();
      if (!batch) return changed;
      if (!localCheckingEnabled()) {
        tx.update(batches)
          .set({ status: "paused" })
          .where(eq(batches.id, batch.id))
          .run();
        return true;
      }
      const item = tx
        .select()
        .from(items)
        .where(and(eq(items.batchId, batch.id), eq(items.state, "ready")))
        .orderBy(items.bookmarkId)
        .get();
      if (!item) return changed;
      const source = tx
        .select()
        .from(importSourceRevisions)
        .where(
          and(
            eq(importSourceRevisions.id, item.sourceRevisionId),
            eq(importSourceRevisions.userId, batch.userId),
            eq(importSourceRevisions.state, "committed"),
          ),
        )
        .get();
      const bookmark = tx
        .select()
        .from(bookmarks)
        .where(
          and(
            eq(bookmarks.id, item.bookmarkId),
            eq(bookmarks.userId, batch.userId),
          ),
        )
        .get();
      const file =
        tx
          .select()
          .from(importSourceAttachments)
          .where(
            eq(importSourceAttachments.sourceRevisionId, item.sourceRevisionId),
          )
          .get() ?? null;
      const processing =
        tx
          .select()
          .from(importProcessing)
          .where(eq(importProcessing.bookmarkId, item.bookmarkId))
          .get() ?? null;
      if (
        !source ||
        !bookmark ||
        source.bookmarkId !== bookmark.id ||
        bookmark.policyRevision !== item.policyRevision ||
        bookmark.contentRevision !== item.contentRevision ||
        (processing?.generation ?? 0) !== item.generation
      ) {
        mark(item, "skipped", "changed");
        return true;
      }
      const reason = skipReason({ source, bookmark, file, processing });
      if (reason) {
        mark(item, "skipped", reason);
        return true;
      }
      try {
        const intent = releaseImportProcessing(
          { db: tx, user: { id: batch.userId } },
          item.sourceRevisionId,
          {
            requestId: item.requestId,
            expectedGeneration: item.generation,
            stage: "local_check",
            retry: false,
          },
        );
        if (
          !intent ||
          intent.stage !== "local_check" ||
          intent.state !== "queued"
        )
          throw new Error("release_not_queued");
        tx.update(items)
          .set({ state: "released", generation: intent.generation })
          .where(
            and(
              eq(items.batchId, item.batchId),
              eq(items.bookmarkId, item.bookmarkId),
            ),
          )
          .run();
      } catch {
        // Preserve uncertain intent; do not reset it or automatically repeat it.
        mark(item, "failed", "release_blocked");
        tx.update(batches)
          .set({ status: "paused" })
          .where(eq(batches.id, batch.id))
          .run();
      }
      return true;
    },
    { behavior: "immediate" },
  );
}
