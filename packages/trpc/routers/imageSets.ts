import { z } from "zod";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { bookmarks, bookmarkAssets } from "@karakeep/db/schema";
import { SearchIndexingQueue } from "@karakeep/shared-server";
import { zBookmarkSchema } from "@karakeep/shared/types/bookmarks";
import { createScopedAuthedProcedure, router } from "../index";
import { Bookmark } from "../models/bookmarks";
import {
  dissolveImageSet,
  saveImageSet,
  ungroupedBookmarkCondition,
} from "../models/imageSets";

const procedure = createScopedAuthedProcedure("bookmarks");
const composition = z
  .object({
    title: z.string().trim().min(1).max(180),
    memberIds: z.array(z.string().min(1)).min(2).max(50),
    coverBookmarkId: z.string().min(1),
  })
  .refine(
    (v) =>
      new Set(v.memberIds).size === v.memberIds.length &&
      v.memberIds.includes(v.coverBookmarkId),
    "Use distinct images and choose a cover from the set.",
  );
export const imageSetsRouter = router({
  save: procedure
    .input(
      z.object({
        id: z.string().uuid(),
        revision: z.number().int().positive().optional(),
        composition,
      }),
    )
    .output(zBookmarkSchema)
    .mutation(async ({ ctx, input }) => {
      const id = saveImageSet(
        ctx.db,
        ctx.user.id,
        input.id,
        input.composition,
        input.revision,
      );
      await SearchIndexingQueue.enqueue({ bookmarkId: id, type: "index" });
      return (await Bookmark.fromId(ctx, id, false)).asZBookmark();
    }),
  dissolve: procedure
    .input(z.object({ id: z.string(), revision: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const result = dissolveImageSet(
        ctx.db,
        ctx.user.id,
        input.id,
        input.revision,
      );
      await SearchIndexingQueue.enqueue({
        bookmarkId: input.id,
        type: "delete",
      });
      return result;
    }),
  candidates: procedure
    .input(
      z.object({
        query: z.string().max(180).default(""),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = ctx.db
        .select({ id: bookmarks.id })
        .from(bookmarks)
        .innerJoin(bookmarkAssets, eq(bookmarkAssets.id, bookmarks.id))
        .where(
          and(
            eq(bookmarks.userId, ctx.user.id),
            eq(bookmarkAssets.assetType, "image"),
            ungroupedBookmarkCondition(),
            sql`NOT EXISTS (SELECT 1 FROM imageSets s WHERE s.bookmarkId = ${bookmarks.id})`,
            input.query
              ? like(
                  sql`coalesce(${bookmarks.title}, '') || ' ' || ${bookmarkAssets.fileName}`,
                  `%${input.query.replace(/[%_]/g, "")}%`,
                )
              : undefined,
          ),
        )
        .orderBy(desc(bookmarks.createdAt), bookmarks.id)
        .limit(25)
        .offset(input.offset)
        .all();
      const cards = await Promise.all(
        rows
          .slice(0, 24)
          .map(async ({ id }) =>
            (await Bookmark.fromId(ctx, id, false)).asZBookmark(),
          ),
      );
      return { cards, nextOffset: rows.length > 24 ? input.offset + 24 : null };
    }),
});
