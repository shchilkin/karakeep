import { createHash, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, count, eq } from "drizzle-orm";

import type { DB, KarakeepDBTransaction } from "@karakeep/db";
import {
  assets,
  AssetTypes,
  bookmarkAssets,
  bookmarkLinks,
  bookmarks,
  bookmarkTags,
  mediaAiRequests,
  tagsOnBookmarks,
  users,
} from "@karakeep/db/schema";
import {
  MediaCatalogQueue,
  triggerSearchReindex,
} from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import {
  catalogBusy,
  catalogInput,
  catalogTagKey,
  MEDIA_CATALOG_VERSION,
  normalizeCatalogTags,
} from "@karakeep/shared/mediaCatalog";
import type {
  CatalogInput,
  MediaCatalogResult,
  MediaCatalogState,
} from "@karakeep/shared/mediaCatalog";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import { mapDBAssetTypeToUserType } from "../lib/attachments";

type Connection = DB | KarakeepDBTransaction;
export interface CatalogJob {
  bookmarkId: string;
  userId: string;
  runId: string;
}

// Synchronous reads also work inside the apply transaction: media changes cannot
// race the fingerprint check. Notes and manual titles never enter the prompt.
export function catalogSnapshot(
  db: Connection,
  userId: string,
  bookmarkId: string,
  allowPreview = false,
) {
  const bookmark = db
    .select()
    .from(bookmarks)
    .where(and(eq(bookmarks.id, bookmarkId), eq(bookmarks.userId, userId)))
    .get();
  if (!bookmark) throw new TRPCError({ code: "NOT_FOUND" });
  const attached = db
    .select()
    .from(assets)
    .where(and(eq(assets.bookmarkId, bookmarkId), eq(assets.userId, userId)))
    .all();
  const link = db
    .select()
    .from(bookmarkLinks)
    .where(eq(bookmarkLinks.id, bookmarkId))
    .get();
  const asset = db
    .select()
    .from(bookmarkAssets)
    .where(eq(bookmarkAssets.id, bookmarkId))
    .get();
  const input = catalogInput(
    {
      content:
        bookmark.type === BookmarkTypes.LINK && link
          ? {
              ...link,
              type: BookmarkTypes.LINK,
              imageAssetId: attached.find(
                (a) => a.assetType === AssetTypes.LINK_BANNER_IMAGE,
              )?.id,
            }
          : bookmark.type === BookmarkTypes.ASSET && asset
            ? { ...asset, type: BookmarkTypes.ASSET }
            : { type: BookmarkTypes.UNKNOWN },
      assets: attached.map((a) => ({
        id: a.id,
        fileName: a.fileName,
        assetType: mapDBAssetTypeToUserType(a.assetType),
      })),
    },
    allowPreview,
  );
  const tags = db
    .select({ name: bookmarkTags.name })
    .from(tagsOnBookmarks)
    .innerJoin(bookmarkTags, eq(bookmarkTags.id, tagsOnBookmarks.tagId))
    .where(eq(tagsOnBookmarks.bookmarkId, bookmarkId))
    .all()
    .map((t) => t.name);
  return {
    bookmark,
    input,
    tags,
    hasDownloadedVideo: attached.some(
      (a) => a.assetType === AssetTypes.LINK_VIDEO,
    ),
  };
}

export function catalogFingerprint(input: CatalogInput, model: string) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: MEDIA_CATALOG_VERSION,
        provider: serverConfig.mediaAi.provider,
        model,
        input,
      }),
    )
    .digest("hex");
}

export async function requestMediaCatalog(
  db: DB,
  userId: string,
  bookmarkId: string,
  options: {
    retry?: boolean;
    allowPreview?: boolean;
    automatic?: boolean;
  } = {},
) {
  const config = serverConfig.mediaAi;
  if (!config.enabled || (options.automatic && !config.autoNew)) return null;
  const state = db.transaction(
    (tx) => {
      if (
        options.automatic &&
        tx
          .select({ enabled: users.autoTaggingEnabled })
          .from(users)
          .where(eq(users.id, userId))
          .get()?.enabled === false
      )
        return null;
      const { bookmark, input, tags, hasDownloadedVideo } = catalogSnapshot(
        tx,
        userId,
        bookmarkId,
        options.allowPreview,
      );
      if (!input) {
        if (options.automatic) return null;
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No saved media available",
        });
      }
      if (
        options.automatic &&
        bookmark.type === BookmarkTypes.LINK &&
        !tags.includes("social-media-archived") &&
        !hasDownloadedVideo
      )
        return null;
      const previous = bookmark.mediaAi;
      const fingerprint = catalogFingerprint(input, config.model);
      if (catalogBusy(previous)) return null;
      // A successful input is never charged again. Failed inputs require a manual retry.
      if (
        previous?.fingerprint === fingerprint &&
        (previous.status === "success" || !options.retry)
      )
        return null;
      const next: MediaCatalogState = {
        runId: randomUUID(),
        fingerprint,
        model: config.model,
        status: "pending",
        updatedAt: new Date().toISOString(),
        allowPreview: options.allowPreview ?? false,
        automatic: options.automatic ?? false,
        result: previous?.result,
        suppressedTags: previous?.suppressedTags,
      };
      tx.update(bookmarks)
        .set({ mediaAi: next })
        .where(eq(bookmarks.id, bookmarkId))
        .run();
      return next;
    },
    { behavior: "immediate" },
  );
  if (!state) return null;
  const job = { bookmarkId, userId, runId: state.runId };
  try {
    await MediaCatalogQueue.enqueue(job, {
      groupId: userId,
      idempotencyKey: state.runId,
    });
  } catch {
    finishMediaCatalog(db, job, "failed");
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Could not queue media analysis",
    });
  }
  return state;
}

export function startMediaCatalog(db: DB, job: CatalogJob) {
  return db.transaction(
    (tx) => {
      const state = tx
        .select()
        .from(bookmarks)
        .where(
          and(
            eq(bookmarks.id, job.bookmarkId),
            eq(bookmarks.userId, job.userId),
          ),
        )
        .get()?.mediaAi;
      if (!state || state.runId !== job.runId || state.status !== "pending")
        return null;
      const snapshot = catalogSnapshot(
        tx,
        job.userId,
        job.bookmarkId,
        state.allowPreview,
      );
      const update = (status: MediaCatalogState["status"]) =>
        tx
          .update(bookmarks)
          .set({
            mediaAi: { ...state, status, updatedAt: new Date().toISOString() },
          })
          .where(eq(bookmarks.id, job.bookmarkId))
          .run();
      if (
        state.automatic &&
        (!serverConfig.mediaAi.autoNew ||
          tx
            .select({ enabled: users.autoTaggingEnabled })
            .from(users)
            .where(eq(users.id, job.userId))
            .get()?.enabled === false)
      ) {
        update("cancelled");
        return null;
      }
      if (
        !snapshot.input ||
        catalogFingerprint(snapshot.input, state.model) !== state.fingerprint
      ) {
        update("stale");
        return null;
      }
      const day = new Date().toISOString().slice(0, 10);
      const used = tx
        .select({ n: count() })
        .from(mediaAiRequests)
        .where(eq(mediaAiRequests.day, day))
        .get()!.n;
      if (used >= serverConfig.mediaAi.dailyRequests) {
        update("quota_exceeded");
        return null;
      }
      // Reservation is not refunded after a timeout or crash. No automatic replay.
      const reserved = tx
        .insert(mediaAiRequests)
        .values({
          id: job.runId,
          bookmarkId: job.bookmarkId,
          userId: job.userId,
          day,
        })
        .onConflictDoNothing()
        .run();
      if (!reserved.changes) {
        update("failed");
        return null;
      }
      update("processing");
      return { input: snapshot.input, tags: snapshot.tags, state };
    },
    { behavior: "immediate" },
  );
}

export function finishMediaCatalog(
  db: DB,
  job: CatalogJob,
  status: MediaCatalogState["status"],
  result?: MediaCatalogResult,
  initialTags: string[] = [],
) {
  return db.transaction(
    (tx) => {
      const current = tx
        .select()
        .from(bookmarks)
        .where(
          and(
            eq(bookmarks.id, job.bookmarkId),
            eq(bookmarks.userId, job.userId),
          ),
        )
        .get();
      if (!current?.mediaAi || current.mediaAi.runId !== job.runId)
        return false;
      const state = current.mediaAi;
      const attachedTagIds: string[] = [];
      let applied = result;
      let suppressed = state.suppressedTags ?? [];
      if (applied) {
        const fresh = catalogSnapshot(
          tx,
          job.userId,
          job.bookmarkId,
          state.allowPreview,
        );
        if (
          !fresh.input ||
          catalogFingerprint(fresh.input, state.model) !== state.fingerprint
        ) {
          status = "stale";
          applied = undefined;
        } else {
          const existingKeys = new Set(fresh.tags.map(catalogTagKey));
          suppressed = [
            ...new Set(
              [
                ...suppressed,
                ...initialTags,
                ...(state.result?.tags ?? []),
              ].filter((t) => !existingKeys.has(catalogTagKey(t))),
            ),
          ];
          const blocked = new Set(suppressed.map(catalogTagKey));
          const libraryTags = tx
            .select({ id: bookmarkTags.id, name: bookmarkTags.name })
            .from(bookmarkTags)
            .where(eq(bookmarkTags.userId, job.userId))
            .all();
          const libraryByKey = new Map(
            libraryTags.map((t) => [catalogTagKey(t.name), t]),
          );
          applied = {
            ...applied,
            tags: normalizeCatalogTags(
              applied.tags,
              libraryTags.map((t) => t.name),
            ),
          };
          if (!applied.tags.length) {
            status = "failed";
            applied = undefined;
          }
          for (const name of (applied?.tags ?? []).filter(
            (t) => !blocked.has(catalogTagKey(t)),
          )) {
            // Match by id: SQLite lower() does not normalize Cyrillic case.
            const tag =
              libraryByKey.get(catalogTagKey(name)) ??
              tx
                .insert(bookmarkTags)
                .values({ name, userId: job.userId })
                .onConflictDoNothing()
                .returning({ id: bookmarkTags.id })
                .get();
            if (tag) {
              const attached = tx
                .insert(tagsOnBookmarks)
                .values({
                  tagId: tag.id,
                  bookmarkId: job.bookmarkId,
                  attachedBy: "ai",
                })
                .onConflictDoNothing()
                .returning({ tagId: tagsOnBookmarks.tagId })
                .get();
              if (attached) attachedTagIds.push(attached.tagId);
            }
          }
        }
      }
      tx.update(bookmarks)
        .set({
          mediaAi: {
            ...state,
            status,
            result: applied ?? state.result,
            suppressedTags: suppressed,
            updatedAt: new Date().toISOString(),
          },
        })
        .where(eq(bookmarks.id, job.bookmarkId))
        .run();
      return { attachedTagIds };
    },
    { behavior: "immediate" },
  );
}

export async function reindexMediaCatalog(bookmarkId: string, userId: string) {
  await triggerSearchReindex(bookmarkId, { groupId: userId });
}
