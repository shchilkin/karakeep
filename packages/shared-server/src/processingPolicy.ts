import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { DB, KarakeepDBTransaction } from "@karakeep/db";
import {
  bookmarks,
  importSourceAttachments,
  importProcessing,
} from "@karakeep/db/schema";
import { importStageOrder } from "@karakeep/shared/types/importProcessing";
import type { ImportProcessingStage } from "@karakeep/shared/types/importProcessing";

type PolicyDB = DB | KarakeepDBTransaction;
export function isBookmarkDeferred(db: PolicyDB, bookmarkId: string) {
  return (
    db
      .select({ policy: bookmarks.processingPolicy })
      .from(bookmarks)
      .where(eq(bookmarks.id, bookmarkId))
      .get()?.policy === "deferred"
  );
}
export function assertBookmarkMutable(db: PolicyDB, bookmarkId: string) {
  if (isBookmarkDeferred(db, bookmarkId))
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "This imported snapshot is deferred and immutable. Processing or changes require a revision-aware release.",
    });
}
export function isImportAssetRetained(db: PolicyDB, assetId: string) {
  return (
    !!db
      .select({ id: importProcessing.bookmarkId })
      .from(importProcessing)
      .where(eq(importProcessing.previewAssetId, assetId))
      .get() ||
    !!db
      .select({ id: importSourceAttachments.assetId })
      .from(importSourceAttachments)
      .where(eq(importSourceAttachments.assetId, assetId))
      .get()
  );
}
export function importProcessingPermit(
  db: PolicyDB,
  bookmarkId: string,
  stage: ImportProcessingStage,
) {
  const record = db
    .select({ processing: importProcessing, bookmark: bookmarks })
    .from(importProcessing)
    .innerJoin(
      bookmarks,
      and(
        eq(bookmarks.id, importProcessing.bookmarkId),
        eq(bookmarks.userId, importProcessing.userId),
      ),
    )
    .where(eq(importProcessing.bookmarkId, bookmarkId))
    .get();
  if (
    !record ||
    record.bookmark.processingPolicy !== "deferred" ||
    record.processing.policyRevision !== record.bookmark.policyRevision ||
    record.processing.contentRevision !== record.bookmark.contentRevision ||
    importStageOrder[record.processing.stage] < importStageOrder[stage]
  )
    return null;
  if (stage === "local_check" || stage === "catalog") {
    if (
      !record.processing.previewReady ||
      !record.processing.searchReady ||
      !["running", "waiting_ai", "complete"].includes(record.processing.state)
    )
      return null;
  }
  return record.processing;
}
export function isImportCatalogBlocked(db: PolicyDB, bookmarkId: string) {
  return (
    isBookmarkDeferred(db, bookmarkId) &&
    !importProcessingPermit(db, bookmarkId, "local_check")
  );
}
export function automaticQueueAllowed(
  db: PolicyDB,
  payload: unknown,
  queueName?: string,
) {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("bookmarkId" in payload) ||
    typeof payload.bookmarkId !== "string"
  )
    return true;
  if (!isBookmarkDeferred(db, payload.bookmarkId)) return true;
  if (
    queueName === "searching_indexing" &&
    "type" in payload &&
    payload.type === "index"
  )
    return !!importProcessingPermit(db, payload.bookmarkId, "search")
      ?.searchReady;
  if (queueName === "media_catalog_queue" && "runId" in payload) {
    const permit = importProcessingPermit(
      db,
      payload.bookmarkId,
      "local_check",
    );
    return !!permit?.aiRunId && payload.runId === permit.aiRunId;
  }
  return false;
}
