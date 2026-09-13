import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DB, KarakeepDBTransaction } from "@karakeep/db";
import {
  assets,
  bookmarkAssets,
  bookmarks,
  tagsOnBookmarks,
  imageSets,
  imageSetMembers,
  importProcessing,
  bookmarksInLists,
  bookmarkLists,
  listCollaborators,
} from "@karakeep/db/schema";
import { imageSetForMember, isImageSet } from "@karakeep/shared-server";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import type { ZBookmark } from "@karakeep/shared/types/bookmarks";
import {
  concealSensitiveBookmark,
  sensitiveAssessment,
} from "@karakeep/shared/sensitiveVisibility";
import { activeAiStatuses } from "@karakeep/shared/aiControl";
import { recordAiRun } from "./aiControl";
import { mapDBAssetTypeToUserType } from "../lib/attachments";

type Connection = DB | KarakeepDBTransaction;
function fail(message: string): never {
  throw new TRPCError({ code: "CONFLICT", message });
}
export function ungroupedBookmarkCondition() {
  return sql`NOT EXISTS (SELECT 1 FROM imageSetMembers ism WHERE ism.bookmarkId = ${bookmarks.id})`;
}
export function privateSetCondition(userId: string, excludeSets = false) {
  return sql`NOT EXISTS (SELECT 1 FROM imageSets s WHERE s.bookmarkId = ${bookmarks.id} ${excludeSets ? sql`` : sql`AND ${bookmarks.userId} != ${userId}`})`;
}
function ownedSet(
  db: Connection,
  userId: string,
  id: string,
  revision?: number,
) {
  const row = db
    .select({ set: imageSets, bookmark: bookmarks })
    .from(imageSets)
    .innerJoin(bookmarks, eq(bookmarks.id, imageSets.bookmarkId))
    .where(and(eq(bookmarks.id, id), eq(bookmarks.userId, userId)))
    .get();
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
  if (revision !== undefined && revision !== row.set.revision)
    fail("This set changed. Reload it before saving.");
  return row;
}
function memberRows(db: Connection, ids: string[]) {
  return db
    .select({
      bookmark: bookmarks,
      asset: bookmarkAssets,
      file: assets,
      processing: importProcessing,
    })
    .from(bookmarks)
    .innerJoin(bookmarkAssets, eq(bookmarkAssets.id, bookmarks.id))
    .innerJoin(
      assets,
      and(
        eq(assets.id, bookmarkAssets.assetId),
        eq(assets.bookmarkId, bookmarks.id),
        eq(assets.userId, bookmarks.userId),
      ),
    )
    .leftJoin(importProcessing, eq(importProcessing.bookmarkId, bookmarks.id))
    .where(inArray(bookmarks.id, ids))
    .all();
}
export function hydrateImageSets(db: Connection, cards: ZBookmark[]) {
  if (!cards.length) return;
  const ids = cards.map((b) => b.id);
  const memberships = db
    .select()
    .from(imageSetMembers)
    .where(inArray(imageSetMembers.bookmarkId, ids))
    .all();
  for (const card of cards)
    card.memberOfSet = memberships.find((m) => m.bookmarkId === card.id)?.setId;
  const sets = db
    .select()
    .from(imageSets)
    .where(inArray(imageSets.bookmarkId, ids))
    .all();
  if (!sets.length) return;
  const members = db
    .select()
    .from(imageSetMembers)
    .where(
      inArray(
        imageSetMembers.setId,
        sets.map((s) => s.bookmarkId),
      ),
    )
    .orderBy(asc(imageSetMembers.position))
    .all();
  const rows = memberRows(
    db,
    members.map((m) => m.bookmarkId),
  );
  for (const set of sets) {
    const card = cards.find((b) => b.id === set.bookmarkId)!;
    const ordered = members
      .filter((m) => m.setId === set.bookmarkId)
      .map((m) => {
        const row = rows.find(
          (r) => r.bookmark.id === m.bookmarkId && r.file.id === m.assetId,
        );
        if (!row || row.bookmark.userId !== card.userId)
          fail("An original in this set is unavailable.");
        return row;
      });
    const assessedCards = ordered.map((r) => r.bookmark);
    // A manual set label can tighten visibility, but clearing it never clears a member.
    if (card.sensitiveCategories?.length) {
      const original = db
        .select()
        .from(bookmarks)
        .where(eq(bookmarks.id, card.id))
        .get()!;
      assessedCards.push(original);
    }
    const assessments = assessedCards.map(sensitiveAssessment);
    card.imageSet = {
      revision: set.revision,
      coverBookmarkId: set.coverBookmarkId,
      members: ordered.map((r) => ({
        bookmarkId: r.bookmark.id,
        title: r.bookmark.title || r.asset.fileName || "Untitled",
        sourceUrl: r.asset.sourceUrl,
        image: {
          id: r.file.id,
          fileName: r.file.fileName,
          assetType: mapDBAssetTypeToUserType(r.file.assetType),
          width: r.file.width ?? r.processing?.originalWidth,
          height: r.file.height ?? r.processing?.originalHeight,
        },
      })),
      sensitivity: {
        work: assessedCards.some((b) => concealSensitiveBookmark(b, "work")),
        balanced: assessedCards.some((b) =>
          concealSensitiveBookmark(b, "balanced"),
        ),
        sensitive: assessments.some((a) => a.sensitive),
        labels: [...new Set(assessments.flatMap((a) => a.labels))],
      },
    };
    // Compatibility: ASSET remains a cover image; ordered originals accompany it.
    card.assets = card.imageSet.members.map((m) => m.image);
  }
}
export interface SetComposition {
  title: string;
  memberIds: string[];
  coverBookmarkId: string;
}
export function saveImageSet(
  db: DB,
  userId: string,
  id: string,
  composition: SetComposition,
  revision?: number,
) {
  return db.transaction(
    (tx) => {
      const existing = isImageSet(tx, id);
      if (revision !== undefined) ownedSet(tx, userId, id, revision);
      else if (existing) {
        const prior = ownedSet(tx, userId, id);
        const ids = tx
          .select()
          .from(imageSetMembers)
          .where(eq(imageSetMembers.setId, id))
          .orderBy(asc(imageSetMembers.position))
          .all()
          .map((m) => m.bookmarkId);
        if (
          prior.bookmark.title === composition.title &&
          prior.set.coverBookmarkId === composition.coverBookmarkId &&
          JSON.stringify(ids) === JSON.stringify(composition.memberIds)
        )
          return id;
        fail("This creation request has already been used.");
      }
      const rows = memberRows(tx, composition.memberIds);
      if (
        rows.length !== composition.memberIds.length ||
        rows.some((r) => r.bookmark.userId !== userId)
      )
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "One or more selected images are unavailable.",
        });
      for (const row of rows) {
        if (
          row.asset.assetType !== "image" ||
          !row.file.contentType?.startsWith("image/")
        )
          fail("Sets currently support saved image cards only.");
        if (isImageSet(tx, row.bookmark.id))
          fail("A set cannot contain another set.");
        const parent = imageSetForMember(tx, row.bookmark.id);
        if (parent && parent !== id)
          fail("An image already belongs to another set.");
        if (
          row.bookmark.processingPolicy === "deferred" &&
          !row.processing?.previewReady
        )
          fail("Wait for the imported image preview to finish first.");
      }
      const shared = tx
        .select({ id: bookmarksInLists.bookmarkId })
        .from(bookmarksInLists)
        .innerJoin(bookmarkLists, eq(bookmarkLists.id, bookmarksInLists.listId))
        .leftJoin(
          listCollaborators,
          eq(listCollaborators.listId, bookmarkLists.id),
        )
        .where(
          and(
            inArray(bookmarksInLists.bookmarkId, composition.memberIds),
            sql`(${bookmarkLists.public} = 1 OR ${listCollaborators.userId} IS NOT NULL)`,
          ),
        )
        .get();
      if (shared)
        fail(
          "Remove the selected images from shared lists before making a private set.",
        );
      const cover = rows.find(
        (r) => r.bookmark.id === composition.coverBookmarkId,
      )!;
      if (!existing) {
        tx.insert(bookmarks)
          .values({
            id,
            userId,
            title: composition.title,
            titleSource: "manual",
            type: BookmarkTypes.ASSET,
            taggingStatus: "success",
            summarizationStatus: "success",
            embeddingStatus: "success",
          })
          .run();
        tx.insert(imageSets)
          .values({
            bookmarkId: id,
            coverBookmarkId: composition.coverBookmarkId,
          })
          .run();
        tx.insert(bookmarkAssets)
          .values({
            id,
            assetId: cover.file.id,
            assetType: "image",
            fileName: cover.asset.fileName,
          })
          .run();
      } else {
        tx.update(imageSets)
          .set({
            coverBookmarkId: composition.coverBookmarkId,
            revision: sql`${imageSets.revision} + 1`,
          })
          .where(eq(imageSets.bookmarkId, id))
          .run();
        tx.update(bookmarks)
          .set({
            title: composition.title,
            titleSource: "manual",
            contentRevision: sql`${bookmarks.contentRevision} + 1`,
          })
          .where(eq(bookmarks.id, id))
          .run();
        tx.update(bookmarkAssets)
          .set({ assetId: cover.file.id, fileName: cover.asset.fileName })
          .where(eq(bookmarkAssets.id, id))
          .run();
        tx.delete(imageSetMembers).where(eq(imageSetMembers.setId, id)).run();
      }
      tx.insert(imageSetMembers)
        .values(
          composition.memberIds.map((memberId, position) => ({
            setId: id,
            bookmarkId: memberId,
            assetId: rows.find((r) => r.bookmark.id === memberId)!.file.id,
            position,
          })),
        )
        .run();
      // Keep source metadata and previous results; revoke queued/in-flight work.
      for (const { bookmark } of rows) {
        if (
          bookmark.mediaAi &&
          activeAiStatuses.includes(bookmark.mediaAi.status)
        ) {
          const cancelled = {
            ...bookmark.mediaAi,
            status: "cancelled" as const,
            updatedAt: new Date().toISOString(),
          };
          recordAiRun(tx, bookmark.id, userId, cancelled);
          tx.update(bookmarks)
            .set({ mediaAi: cancelled })
            .where(eq(bookmarks.id, bookmark.id))
            .run();
        }
      }
      // Preserve private list placement while originals stay in their lists.
      if (!existing) {
        const lists = tx
          .select({ listId: bookmarksInLists.listId })
          .from(bookmarksInLists)
          .where(inArray(bookmarksInLists.bookmarkId, composition.memberIds))
          .all();
        const listIds = [...new Set(lists.map((l) => l.listId))];
        if (listIds.length)
          tx.insert(bookmarksInLists)
            .values(listIds.map((listId) => ({ listId, bookmarkId: id })))
            .run();
      }
      // Copy tags to the new set, preserving every original tag and its provenance.
      if (!existing) {
        const tags = tx
          .select()
          .from(tagsOnBookmarks)
          .where(inArray(tagsOnBookmarks.bookmarkId, composition.memberIds))
          .all();
        const uniqueTags = [...new Map(tags.map((t) => [t.tagId, t])).values()];
        if (uniqueTags.length)
          tx.insert(tagsOnBookmarks)
            .values(
              uniqueTags.map((t) => ({
                bookmarkId: id,
                tagId: t.tagId,
                attachedBy: "human" as const,
              })),
            )
            .run();
      }
      const searchText = rows
        .map((r) =>
          [
            r.bookmark.title,
            r.asset.fileName,
            r.asset.sourceUrl,
            r.bookmark.note,
            r.bookmark.mediaAi?.result?.summary,
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n\n");
      tx.update(bookmarkAssets)
        .set({ content: searchText })
        .where(eq(bookmarkAssets.id, id))
        .run();
      return id;
    },
    { behavior: "immediate" },
  );
}
export function dissolveImageSet(
  db: DB,
  userId: string,
  id: string,
  revision: number,
) {
  return db.transaction(
    (tx) => {
      ownedSet(tx, userId, id, revision);
      const members = tx
        .select()
        .from(imageSetMembers)
        .where(eq(imageSetMembers.setId, id))
        .orderBy(asc(imageSetMembers.position))
        .all();
      // Remove only the gallery identity. Never call Bookmark.delete/asset cleanup.
      tx.delete(imageSetMembers).where(eq(imageSetMembers.setId, id)).run();
      tx.delete(bookmarks)
        .where(and(eq(bookmarks.id, id), eq(bookmarks.userId, userId)))
        .run();
      return { memberIds: members.map((m) => m.bookmarkId) };
    },
    { behavior: "immediate" },
  );
}
