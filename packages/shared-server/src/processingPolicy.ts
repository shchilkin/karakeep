import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { DB, KarakeepDBTransaction } from "@karakeep/db";
import { bookmarks, importSourceAttachments } from "@karakeep/db/schema";

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
  return !!db
    .select({ id: importSourceAttachments.assetId })
    .from(importSourceAttachments)
    .where(eq(importSourceAttachments.assetId, assetId))
    .get();
}
export function automaticQueueAllowed(db: PolicyDB, payload: unknown) {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("bookmarkId" in payload) ||
    typeof payload.bookmarkId !== "string"
  )
    return true;
  return !isBookmarkDeferred(db, payload.bookmarkId);
}
