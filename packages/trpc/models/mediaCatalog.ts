import { activeAiStatuses } from "@karakeep/shared/aiControl";
import {
  aiControlDecision,
  getAiControl,
  recordAiRun,
  persistAiState,
} from "./aiControl";
import {
  isBookmarkDeferred,
  isImportCatalogBlocked,
  importProcessingPermit,
} from "@karakeep/shared-server";
import { QueueRetryAfterError } from "@karakeep/shared/queueing";
import { createHash, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, count, eq, sql } from "drizzle-orm";

import type { DB, KarakeepDBTransaction } from "@karakeep/db";
import {
  assets,
  AssetTypes,
  bookmarkAssets,
  bookmarkLinks,
  bookmarks,
  bookmarkTags,
  mediaAiRequests,
  mediaAiBatches,
  importProcessing,
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

import {
  holdLocalMedia,
  zCurrentLocalCheckResult,
  LOCAL_CHECK_POLICY,
  LOCAL_CHECK_REVISION,
} from "@karakeep/shared/mediaLocalCheck";
import type { LocalCheckResult } from "@karakeep/shared/mediaLocalCheck";
import {
  LOCAL_CATALOG_MODEL,
  LOCAL_CATALOG_REVISION,
  LOCAL_CATALOG_RECIPE,
} from "@karakeep/shared/mediaLocalCatalog";
import { shouldConcealSensitive } from "@karakeep/shared/sensitiveContent";

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
  const importedImage =
    bookmark.processingPolicy === "deferred" && asset?.assetType === "image"
      ? attached.find(
          (item) =>
            item.id === asset.assetId && item.contentType?.startsWith("image/"),
        )
      : null;
  const importedFileName = importedImage
    ? `original.${importedImage.contentType!.split("/")[1]}`
    : null;
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
              screenshotAssetId: attached.find(
                (a) => a.assetType === AssetTypes.LINK_SCREENSHOT,
              )?.id,
            }
          : bookmark.type === BookmarkTypes.ASSET && asset
            ? {
                ...asset,
                ...(importedFileName ? { fileName: importedFileName } : {}),
                type: BookmarkTypes.ASSET,
              }
            : { type: BookmarkTypes.UNKNOWN },
      assets: importedImage
        ? []
        : attached.map((a) => ({
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

export function catalogFingerprint(
  input: CatalogInput,
  model: string,
  localOnly = false,
  provider = serverConfig.mediaAi.provider,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: MEDIA_CATALOG_VERSION,
        provider,
        model,
        input,
        ...(serverConfig.mediaAi.hybridEnabled
          ? {
              hybrid: {
                model: LOCAL_CATALOG_MODEL,
                revision: LOCAL_CATALOG_REVISION,
                recipe: LOCAL_CATALOG_RECIPE,
              },
            }
          : {}),
        ...(localOnly ? { localOnly: true } : {}),
        ...(serverConfig.mediaAi.localMode !== "off"
          ? {
              local: {
                mode: serverConfig.mediaAi.localMode,
                policy: LOCAL_CHECK_POLICY,
                revision: LOCAL_CHECK_REVISION,
              },
            }
          : {}),
      }),
    )
    .digest("hex");
}

/** Hybrid auto-new authorizes free local continuations as well as admission. */
function automaticCatalogEnabled(localOnly: boolean | undefined) {
  const config = serverConfig.mediaAi;
  return localOnly
    ? config.localAutoNew || (config.hybridEnabled && config.autoNew)
    : config.autoNew;
}

export async function requestMediaCatalog(
  db: DB,
  userId: string,
  bookmarkId: string,
  options: {
    retry?: boolean;
    allowPreview?: boolean;
    automatic?: boolean;
    localOnly?: boolean;
    importRelease?: boolean;
    classificationOnly?: boolean;
    control?: {
      runId: string;
      batchId: string;
      fingerprint: string;
      priorRunId: string | null;
      policyRevision: number;
      contentRevision: number;
      model: string;
      provider: "xai" | "openai";
      refresh: boolean;
    };
  } = {},
) {
  if (
    isBookmarkDeferred(db, bookmarkId) &&
    (!options.importRelease || isImportCatalogBlocked(db, bookmarkId))
  ) {
    if (options.automatic) return null;
    throw new TRPCError({
      code: "CONFLICT",
      message: "Imported snapshot processing is deferred.",
    });
  }
  const config = serverConfig.mediaAi;
  if (
    isBookmarkDeferred(db, bookmarkId) &&
    (!config.enabled || config.localMode !== "enforce" || !config.hybridEnabled)
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Imported analysis requires enforced local admission and hybrid routing.",
    });
  }
  const localOnly =
    options.localOnly ?? (!!options.automatic && config.localAutoNew);
  if (config.hybridEnabled && config.localMode === "off") {
    if (options.automatic) return null;
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Hybrid analysis requires local admission",
    });
  }
  const automaticEnabled = automaticCatalogEnabled(localOnly);
  if (!config.enabled || (options.automatic && !automaticEnabled)) return null;
  if (localOnly && config.localMode === "off") {
    if (options.automatic) return null;
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Local analysis is disabled",
    });
  }
  const allowPreview = options.allowPreview ?? localOnly;
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
        allowPreview,
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
        !localOnly &&
        bookmark.type === BookmarkTypes.LINK &&
        !tags.includes("social-media-archived") &&
        !hasDownloadedVideo
      )
        return null;
      const previous = bookmark.mediaAi;
      const model = options.control?.model ?? config.model;
      const provider = options.control?.provider ?? config.provider;
      const fingerprint = catalogFingerprint(input, model, localOnly, provider);
      if (options.control) {
        const batch = tx
          .select()
          .from(mediaAiBatches)
          .where(eq(mediaAiBatches.id, options.control.batchId))
          .get();
        if (!batch || batch.userId !== userId || batch.status !== "running")
          return null;
        if (previous?.runId === options.control.runId) return previous;
        if (
          fingerprint !== options.control.fingerprint ||
          (previous?.runId ?? null) !== options.control.priorRunId ||
          bookmark.policyRevision !== options.control.policyRevision ||
          bookmark.contentRevision !== options.control.contentRevision
        )
          throw new TRPCError({
            code: "CONFLICT",
            message: "Card changed since the batch was prepared.",
          });
      }
      const busy = catalogBusy(previous);
      if (previous?.status === "pending" || busy) {
        // Repair a lost enqueue only on an explicit, expired retry. Reusing the
        // same key deduplicates an existing backlog and cannot reserve twice.
        if (previous?.status === "pending" && !busy && options.retry) {
          if (previous.fingerprint === fingerprint) return previous;
        } else {
          // An attachment event may overlap a manual/backfill or cloud run.
          // Persist its free follow-up intent until that run reaches a terminal
          // state, including across worker restarts.
          if (
            previous &&
            options.automatic &&
            (localOnly || config.hybridEnabled) &&
            previous.fingerprint !== fingerprint
          ) {
            tx.update(bookmarks)
              .set({ mediaAi: { ...previous, localRecheckRequested: true } })
              .where(eq(bookmarks.id, bookmarkId))
              .run();
          }
          return null;
        }
      }
      // A successful input is never charged again. Failed inputs require a manual retry.
      if (
        previous?.fingerprint === fingerprint &&
        !options.control?.refresh &&
        (previous.status === "success" || !options.retry)
      )
        return null;
      const next: MediaCatalogState = {
        classificationOnly: options.classificationOnly,
        runId: options.control?.runId ?? randomUUID(),
        fingerprint,
        model,
        provider,
        batchId: options.control?.batchId,
        status: "pending",
        updatedAt: new Date().toISOString(),
        allowPreview,
        automatic: options.automatic ?? false,
        localOnly,
        localMode: config.localMode,
        hybrid: config.hybridEnabled,
        // A retry of the same local input is never an implicit cloud upgrade.
        route:
          previous?.fingerprint === fingerprint && previous.route === "local"
            ? "local"
            : undefined,
        // Retain positive observations while replacement media is checked. The
        // worker may reuse bytes only for the matching original fingerprint.
        localCheck: previous?.localCheck,
        localCheckFingerprint:
          previous?.localCheck &&
          previous.fingerprint === fingerprint &&
          [
            "failed",
            "refused",
            "timeout",
            "rate_limited",
            "quota_exceeded",
          ].includes(previous.status)
            ? previous.localCheckFingerprint
            : undefined,
        result: previous?.result,
        resultSource: previous?.resultSource,
        suppressedTags: previous?.suppressedTags,
      };
      if (isBookmarkDeferred(tx, bookmarkId)) {
        const permit = importProcessingPermit(
          tx,
          bookmarkId,
          options.classificationOnly ? "local_check" : "catalog",
        );
        if (!permit || !options.importRelease)
          throw new TRPCError({
            code: "CONFLICT",
            message: "Import processing permission changed.",
          });
        tx.update(importProcessing)
          .set({ aiRunId: next.runId })
          .where(eq(importProcessing.bookmarkId, bookmarkId))
          .run();
      }
      if (previous) recordAiRun(tx, bookmarkId, userId, previous, true);
      recordAiRun(tx, bookmarkId, userId, next);
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
      priority:
        options.importRelease || state.batchId ? 50 : state.automatic ? 10 : 0,
    });
  } catch {
    finishMediaCatalog(
      db,
      job,
      config.localMode === "off" ? "failed" : "local_failed",
    );
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Could not queue media analysis",
    });
  }
  return state;
}

export function startMediaCatalog(db: DB, job: CatalogJob) {
  if (isImportCatalogBlocked(db, job.bookmarkId)) return null;
  const started = db.transaction(
    (tx) => {
      if (isImportCatalogBlocked(tx, job.bookmarkId)) return null;
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
      if (
        !state ||
        state.runId !== job.runId ||
        !["pending", "waiting_resource", "waiting_control"].includes(
          state.status,
        )
      )
        return null;
      const control = aiControlDecision(
        tx,
        state,
        state.route === "cloud" ||
          !state.localMode ||
          state.localMode === "off",
      );
      if (control !== "allow") return { held: control, state };
      if (state.status === "waiting_resource") {
        const delay =
          Date.parse(state.resourceWaitUntil ?? state.updatedAt) - Date.now();
        if (delay > 0)
          throw new QueueRetryAfterError(
            "waiting_resource",
            Math.min(delay, 300_000),
          );
      }
      const snapshot = catalogSnapshot(
        tx,
        job.userId,
        job.bookmarkId,
        state.allowPreview,
      );
      const update = (status: MediaCatalogState["status"]) =>
        persistAiState(tx, job.bookmarkId, job.userId, {
          ...state,
          status,
          resourceWaitUntil: undefined,
          updatedAt: new Date().toISOString(),
        });
      if (
        state.automatic &&
        (!automaticCatalogEnabled(state.localOnly) ||
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
        catalogFingerprint(
          snapshot.input,
          state.model,
          state.localOnly,
          state.provider,
        ) !== state.fingerprint
      ) {
        update("stale");
        return null;
      }
      if (
        (isBookmarkDeferred(tx, job.bookmarkId) &&
          (!serverConfig.mediaAi.enabled ||
            serverConfig.mediaAi.localMode !== "enforce" ||
            !serverConfig.mediaAi.hybridEnabled ||
            state.localMode !== "enforce" ||
            !state.hybrid)) ||
        (state.localMode ?? "off") !== serverConfig.mediaAi.localMode ||
        !!state.hybrid !== serverConfig.mediaAi.hybridEnabled ||
        (state.hybrid && state.localMode === "off")
      ) {
        update("cancelled");
        return null;
      }
      if (state.localOnly && state.localMode === "off") {
        update("cancelled");
        return null;
      }
      if (state.localMode && state.localMode !== "off") {
        update("checking_local");
        return { input: snapshot.input, tags: snapshot.tags, state };
      }
      const day = new Date().toISOString().slice(0, 10);
      const used = tx
        .select({ n: count() })
        .from(mediaAiRequests)
        .where(eq(mediaAiRequests.day, day))
        .get()!.n;
      if (used >= getAiControl(tx).dailyRequests) {
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
  if (started?.held) {
    holdMediaCatalogControl(db, job, started.held);
    if (started.held === "wait")
      throw new QueueRetryAfterError("waiting_control", 30_000);
    return null;
  }
  return started;
}

/** Persist the local checkpoint and reserve a paid attempt only after admission. */
export function continueMediaCatalog(
  db: DB,
  job: CatalogJob,
  unchecked: LocalCheckResult | null,
) {
  if (isImportCatalogBlocked(db, job.bookmarkId)) return false;
  // Null represents unavailable/invalid admission or a text-only input. It can
  // select local cataloging, but can never authorize cloud or erase observations.
  const parsed = zCurrentLocalCheckResult.safeParse(unchecked);
  const localCheck = parsed.success ? parsed.data : null;
  return db.transaction(
    (tx) => {
      if (isImportCatalogBlocked(tx, job.bookmarkId)) return false;
      const snapshot = catalogSnapshot(tx, job.userId, job.bookmarkId, true);
      const state = snapshot.bookmark.mediaAi;
      if (
        !state ||
        state.runId !== job.runId ||
        state.status !== "checking_local"
      )
        return false;
      const unknown =
        !localCheck ||
        localCheck.frames.some((frame) => frame.status === "unknown");
      const retainPriorHold =
        unknown && !!state.localCheck && holdLocalMedia(state.localCheck);
      const update = (
        status: MediaCatalogState["status"],
        acceptObservation = true,
      ) =>
        persistAiState(tx, job.bookmarkId, job.userId, {
          ...state,
          ...(acceptObservation && localCheck && !retainPriorHold
            ? { localCheck, localCheckFingerprint: state.fingerprint }
            : {}),
          localCheckUnavailable:
            unknown || (status === "processing_local" && !acceptObservation),
          route:
            status === "processing_local"
              ? "local"
              : status === "processing"
                ? "cloud"
                : state.route,
          status,
          updatedAt: new Date().toISOString(),
        });
      if (
        !snapshot.input ||
        catalogFingerprint(
          snapshot.input,
          state.model,
          state.localOnly,
          state.provider,
        ) !== state.fingerprint
      ) {
        update("stale", false);
        return false;
      }
      const expected =
        snapshot.input.assets.length === 1 &&
        snapshot.input.media.kind === "video"
          ? 3
          : Math.min(3, snapshot.input.assets.length);
      const validCoverage =
        !!expected && localCheck?.frames.length === expected;
      if (!validCoverage && !state.hybrid) {
        update("local_failed", false);
        return false;
      }
      if (
        !serverConfig.mediaAi.enabled ||
        state.localMode !== serverConfig.mediaAi.localMode ||
        !!state.hybrid !== serverConfig.mediaAi.hybridEnabled ||
        (state.hybrid && state.localMode === "off") ||
        (state.automatic &&
          (!automaticCatalogEnabled(state.localOnly) ||
            tx
              .select({ enabled: users.autoTaggingEnabled })
              .from(users)
              .where(eq(users.id, job.userId))
              .get()?.enabled === false))
      ) {
        update("cancelled", false);
        return false;
      }
      const batchControl = aiControlDecision(tx, state, false);
      if (batchControl !== "allow") {
        update(batchControl === "wait" ? "waiting_control" : "cancelled");
        return false;
      }
      if (state.classificationOnly) {
        update(
          validCoverage && !unknown ? "local_review" : "local_failed",
          validCoverage,
        );
        return false;
      }
      if ((!state.hybrid && state.localOnly) || state.localMode === "review") {
        update("local_review");
        return false;
      }
      if (
        !validCoverage ||
        !localCheck ||
        (state.hybrid && (state.localOnly || state.route === "local")) ||
        holdLocalMedia(localCheck) ||
        shouldConcealSensitive(
          snapshot.bookmark.sensitiveCategories,
          state.hybrid ? "work" : "balanced",
        )
      ) {
        if (state.hybrid) {
          update("processing_local", validCoverage);
          return "local" as const;
        }
        update("local_only");
        return false;
      }
      const control = aiControlDecision(tx, state, true);
      if (control !== "allow") {
        update(control === "wait" ? "waiting_control" : "cancelled");
        const held = tx
          .select()
          .from(bookmarks)
          .where(eq(bookmarks.id, job.bookmarkId))
          .get()!.mediaAi!;
        const next = { ...held, route: "cloud" as const };
        tx.update(bookmarks)
          .set({ mediaAi: next })
          .where(eq(bookmarks.id, job.bookmarkId))
          .run();
        recordAiRun(tx, job.bookmarkId, job.userId, next);
        return false;
      }
      if (!serverConfig.mediaAi.apiKey) {
        update("failed");
        return false;
      }
      const day = new Date().toISOString().slice(0, 10);
      const used = tx
        .select({ n: count() })
        .from(mediaAiRequests)
        .where(eq(mediaAiRequests.day, day))
        .get()!.n;
      if (used >= getAiControl(tx).dailyRequests) {
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
      return true;
    },
    { behavior: "immediate" },
  );
}

/** Park the same local operation; this is not a failed/paid attempt or a new intent. */
export function waitForMediaCatalogResource(
  db: DB,
  job: CatalogJob,
  delayMs = 30_000,
) {
  return db.transaction(
    (tx) => {
      if (isImportCatalogBlocked(tx, job.bookmarkId)) return false;
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
      const state = current?.mediaAi;
      if (
        !state ||
        state.runId !== job.runId ||
        !["checking_local", "processing_local"].includes(state.status) ||
        tx
          .select({ id: mediaAiRequests.id })
          .from(mediaAiRequests)
          .where(eq(mediaAiRequests.id, job.runId))
          .get()
      )
        return false;
      const now = Date.now();
      persistAiState(tx, job.bookmarkId, job.userId, {
        ...state,
        status: "waiting_resource",
        updatedAt: new Date(now).toISOString(),
        resourceWaitUntil: new Date(
          now + Math.max(1000, Math.min(300_000, delayMs)),
        ).toISOString(),
      });
      return true;
    },
    { behavior: "immediate" },
  );
}

/** Reconcile attachment events after any job, without replaying cloud work. */
export async function reconcileLocalMediaCatalog(db: DB, job: CatalogJob) {
  if (isBookmarkDeferred(db, job.bookmarkId)) return;
  if (isImportCatalogBlocked(db, job.bookmarkId)) return;
  const active = (state: MediaCatalogState) =>
    activeAiStatuses.includes(state.status);
  const state = db
    .select({ mediaAi: bookmarks.mediaAi })
    .from(bookmarks)
    .where(
      and(eq(bookmarks.id, job.bookmarkId), eq(bookmarks.userId, job.userId)),
    )
    .get()?.mediaAi;
  if (
    !state ||
    state.runId !== job.runId ||
    active(state) ||
    (!state.localOnly && !state.localRecheckRequested)
  )
    return;
  await requestMediaCatalog(db, job.userId, job.bookmarkId, {
    automatic: true,
    localOnly: true,
  });
  // A deduplicated input or later opt-out consumes the intent as well. A failed
  // enqueue keeps its durable recovery checkpoint instead of clearing it here.
  db.transaction(
    (tx) => {
      const current = tx
        .select()
        .from(bookmarks)
        .where(eq(bookmarks.id, job.bookmarkId))
        .get()?.mediaAi;
      if (
        current?.runId === job.runId &&
        current.localRecheckRequested &&
        !active(current)
      ) {
        tx.update(bookmarks)
          .set({ mediaAi: { ...current, localRecheckRequested: undefined } })
          .where(eq(bookmarks.id, job.bookmarkId))
          .run();
      }
    },
    { behavior: "immediate" },
  );
}

/** Recover only free local work. An uncertain cloud attempt is never replayed. */
export async function recoverLocalMediaCatalog(db: DB, now = Date.now()) {
  if (!serverConfig.mediaAi.enabled || serverConfig.mediaAi.localMode === "off")
    return;
  // Repair a lost delivery while preserving the semantic run and local checkpoint.
  const waiting = db
    .select({
      id: bookmarks.id,
      userId: bookmarks.userId,
      mediaAi: bookmarks.mediaAi,
    })
    .from(bookmarks)
    .where(
      sql`json_extract(${bookmarks.mediaAi}, '$.status') = 'waiting_resource' AND coalesce(json_extract(${bookmarks.mediaAi}, '$.resourceWaitUntil'), json_extract(${bookmarks.mediaAi}, '$.updatedAt')) <= ${new Date(now).toISOString()}`,
    )
    .limit(100)
    .all();
  for (const item of waiting) {
    if (
      isImportCatalogBlocked(db, item.id) ||
      !item.mediaAi ||
      db
        .select({ id: mediaAiRequests.id })
        .from(mediaAiRequests)
        .where(eq(mediaAiRequests.id, item.mediaAi.runId))
        .get()
    )
      continue;
    await MediaCatalogQueue.enqueue(
      { bookmarkId: item.id, userId: item.userId, runId: item.mediaAi.runId },
      {
        groupId: item.userId,
        idempotencyKey: item.mediaAi.runId,
        priority: isBookmarkDeferred(db, item.id)
          ? 50
          : item.mediaAi.automatic
            ? 10
            : 0,
      },
    );
  }
  const followups = db
    .select({
      id: bookmarks.id,
      userId: bookmarks.userId,
      mediaAi: bookmarks.mediaAi,
    })
    .from(bookmarks)
    .where(
      sql`json_extract(${bookmarks.mediaAi}, '$.localRecheckRequested') = 1 AND json_extract(${bookmarks.mediaAi}, '$.status') NOT IN ('pending', 'checking_local', 'processing', 'processing_local', 'waiting_resource', 'waiting_control')`,
    )
    .limit(100)
    .all();
  for (const followup of followups) {
    if (isImportCatalogBlocked(db, followup.id)) continue;
    await reconcileLocalMediaCatalog(db, {
      bookmarkId: followup.id,
      userId: followup.userId,
      runId: followup.mediaAi!.runId,
    });
  }
  const candidates = db
    .select({ id: bookmarks.id, userId: bookmarks.userId })
    .from(bookmarks)
    .where(
      sql`json_extract(${bookmarks.mediaAi}, '$.localMode') IN ('review', 'enforce') AND json_extract(${bookmarks.mediaAi}, '$.status') IN ('pending', 'checking_local', 'processing', 'processing_local', 'local_failed') AND (json_extract(${bookmarks.mediaAi}, '$.status') <> 'local_failed' OR coalesce(json_extract(${bookmarks.mediaAi}, '$.localRecoveries'), 0) < 2) AND json_extract(${bookmarks.mediaAi}, '$.updatedAt') <= ${new Date(now - 660_000).toISOString()}`,
    )
    .limit(100)
    .all();
  for (const candidate of candidates) {
    if (isImportCatalogBlocked(db, candidate.id)) continue;
    const job = db.transaction(
      (tx) => {
        const bookmark = tx
          .select()
          .from(bookmarks)
          .where(eq(bookmarks.id, candidate.id))
          .get();
        const state = bookmark?.mediaAi;
        if (
          !state ||
          ![
            "pending",
            "checking_local",
            "processing",
            "processing_local",
            "local_failed",
          ].includes(state.status) ||
          now - Date.parse(state.updatedAt) < (state.hybrid ? 960_000 : 660_000)
        )
          return null;
        if (
          state.status === "local_failed" &&
          (state.localRecoveries ?? 0) >= 2
        )
          return null;
        const paid = tx
          .select({ id: mediaAiRequests.id })
          .from(mediaAiRequests)
          .where(eq(mediaAiRequests.id, state.runId))
          .get();
        const stop =
          paid ||
          state.status === "processing" ||
          (state.status !== "pending" && (state.localRecoveries ?? 0) >= 2);
        // A long backlog is not a failed attempt. Re-enqueue its existing key:
        // the queue deduplicates a live job and repairs a lost enqueue.
        const waiting = state.status === "pending" && !paid;
        const next: MediaCatalogState = {
          ...state,
          runId: stop || waiting ? state.runId : randomUUID(),
          status: stop
            ? paid || state.status === "processing"
              ? "timeout"
              : "local_failed"
            : "pending",
          updatedAt: new Date(now).toISOString(),
          localRecoveries:
            stop || waiting
              ? state.localRecoveries
              : (state.localRecoveries ?? 0) + 1,
        };
        if (isBookmarkDeferred(tx, candidate.id)) {
          tx.update(importProcessing)
            .set({ aiRunId: next.runId })
            .where(eq(importProcessing.bookmarkId, candidate.id))
            .run();
        }
        recordAiRun(tx, candidate.id, candidate.userId, {
          ...state,
          status: stop ? next.status : "local_failed",
          updatedAt: next.updatedAt,
        });
        recordAiRun(tx, candidate.id, candidate.userId, next);
        tx.update(bookmarks)
          .set({ mediaAi: next })
          .where(eq(bookmarks.id, candidate.id))
          .run();
        return stop
          ? null
          : {
              bookmarkId: candidate.id,
              userId: candidate.userId,
              runId: next.runId,
            };
      },
      { behavior: "immediate" },
    );
    // If enqueue fails, the persisted pending state is recovered on the next pass.
    if (job)
      await MediaCatalogQueue.enqueue(job, {
        groupId: job.userId,
        idempotencyKey: job.runId,
        priority: isBookmarkDeferred(db, job.bookmarkId) ? 50 : 0,
      });
  }
}

export function finishMediaCatalog(
  db: DB,
  job: CatalogJob,
  status: MediaCatalogState["status"],
  result?: MediaCatalogResult,
  initialTags: string[] = [],
  metadata?: {
    resolvedModel?: string;
    sampledImages?: number;
    assetCount?: number;
  },
) {
  if (isImportCatalogBlocked(db, job.bookmarkId)) return;
  return db.transaction(
    (tx) => {
      if (isImportCatalogBlocked(tx, job.bookmarkId)) return false;
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
      if (
        !current?.mediaAi ||
        current.mediaAi.runId !== job.runId ||
        ![
          "pending",
          "processing",
          "checking_local",
          "processing_local",
        ].includes(current.mediaAi.status)
      )
        return false;
      const state = current.mediaAi;
      // Runner-level aborts can beat the worker's catch handler. Preserve the
      // free local recovery path, but never relabel an admitted cloud attempt.
      if (
        status === "failed" &&
        !result &&
        state.localMode &&
        state.localMode !== "off" &&
        state.status !== "processing"
      )
        status = "local_failed";
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
          catalogFingerprint(
            fresh.input,
            state.model,
            state.localOnly,
            state.provider,
          ) !== state.fingerprint
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
      const completedAt = new Date().toISOString();
      tx.update(bookmarks)
        .set({
          mediaAi: {
            ...state,
            status,
            result: applied ?? state.result,
            resultSource: applied
              ? state.route === "local"
                ? {
                    provider: "local",
                    model: LOCAL_CATALOG_MODEL,
                    revision: LOCAL_CATALOG_REVISION,
                    recipe: LOCAL_CATALOG_RECIPE,
                  }
                : {
                    provider: state.provider ?? serverConfig.mediaAi.provider,
                    model: state.model,
                    resolvedModel: metadata?.resolvedModel,
                  }
              : state.resultSource,
            suppressedTags: suppressed,
            updatedAt: completedAt,
          },
        })
        .where(eq(bookmarks.id, job.bookmarkId))
        .run();
      const finished = tx
        .select()
        .from(bookmarks)
        .where(eq(bookmarks.id, job.bookmarkId))
        .get()!.mediaAi!;
      if (applied && finished.resultSource) {
        finished.resultSource = {
          ...finished.resultSource,
          analyzedAt: completedAt,
          catalogVersion: MEDIA_CATALOG_VERSION,
          contentRevision: current.contentRevision,
          sampledImages: metadata?.sampledImages,
          assetCount: metadata?.assetCount,
        };
        tx.update(bookmarks)
          .set({ mediaAi: finished })
          .where(eq(bookmarks.id, job.bookmarkId))
          .run();
      }
      recordAiRun(tx, job.bookmarkId, job.userId, finished);
      return { attachedTagIds };
    },
    { behavior: "immediate" },
  );
}

export async function reindexMediaCatalog(bookmarkId: string, userId: string) {
  await triggerSearchReindex(bookmarkId, { groupId: userId });
}

export function holdMediaCatalogControl(
  db: DB,
  job: CatalogJob,
  decision: "wait" | "cancel",
) {
  return db.transaction(
    (tx) => {
      const row = tx
        .select()
        .from(bookmarks)
        .where(
          and(
            eq(bookmarks.id, job.bookmarkId),
            eq(bookmarks.userId, job.userId),
          ),
        )
        .get();
      const state = row?.mediaAi;
      if (!state || state.runId !== job.runId) return;
      // A reserved/in-flight cloud request is never replayed by resuming a pause.
      const paid = tx
        .select()
        .from(mediaAiRequests)
        .where(eq(mediaAiRequests.id, job.runId))
        .get();
      const next: MediaCatalogState = {
        ...state,
        status: decision === "cancel" || paid ? "cancelled" : "waiting_control",
        updatedAt: new Date().toISOString(),
      };
      tx.update(bookmarks)
        .set({ mediaAi: next })
        .where(eq(bookmarks.id, job.bookmarkId))
        .run();
      recordAiRun(tx, job.bookmarkId, job.userId, next);
    },
    { behavior: "immediate" },
  );
}

/** Final synchronous gate directly before invoking the provider, including after CPU I/O. */
export function authorizeMediaCatalogDispatch(
  db: DB,
  job: CatalogJob,
  cloud: boolean,
) {
  const row = db
    .select()
    .from(bookmarks)
    .where(
      and(eq(bookmarks.id, job.bookmarkId), eq(bookmarks.userId, job.userId)),
    )
    .get();
  const state = row?.mediaAi;
  if (
    !state ||
    state.runId !== job.runId ||
    !["processing", "processing_local"].includes(state.status)
  )
    return false;
  const decision = aiControlDecision(db, state, cloud);
  if (
    !serverConfig.mediaAi.enabled ||
    isImportCatalogBlocked(db, job.bookmarkId) ||
    decision !== "allow"
  ) {
    holdMediaCatalogControl(
      db,
      job,
      decision === "allow" ? "cancel" : decision,
    );
    return false;
  }
  if (
    cloud &&
    state.localMode === "enforce" &&
    shouldConcealSensitive(
      row!.sensitiveCategories,
      state.hybrid ? "work" : "balanced",
    )
  ) {
    holdMediaCatalogControl(db, job, "cancel");
    return false;
  }
  const snapshot = catalogSnapshot(
    db,
    job.userId,
    job.bookmarkId,
    state.allowPreview,
  );
  if (
    !snapshot.input ||
    catalogFingerprint(
      snapshot.input,
      state.model,
      state.localOnly,
      state.provider,
    ) !== state.fingerprint
  ) {
    finishMediaCatalog(db, job, "stale");
    return false;
  }
  return true;
}

export function mediaCatalogIsHeld(db: DB, job: CatalogJob) {
  const row = db
    .select()
    .from(bookmarks)
    .where(
      and(eq(bookmarks.id, job.bookmarkId), eq(bookmarks.userId, job.userId)),
    )
    .get();
  return (
    row?.mediaAi?.runId === job.runId &&
    row.mediaAi.status === "waiting_control"
  );
}

const heldRecoveryCursor = new WeakMap<DB, string>();

export async function recoverHeldMediaCatalog(db: DB) {
  if (!serverConfig.mediaAi.enabled) return;
  const rows = db
    .select()
    .from(bookmarks)
    .where(
      and(
        sql`json_extract(${bookmarks.mediaAi}, '$.status') = 'waiting_control'`,
        sql`${bookmarks.id} > ${heldRecoveryCursor.get(db) ?? ""}`,
      ),
    )
    .orderBy(bookmarks.id)
    .limit(200)
    .all();
  heldRecoveryCursor.set(
    db,
    rows.length === 200 ? rows[rows.length - 1].id : "",
  );
  for (const row of rows) {
    const state = row.mediaAi!;
    if (isImportCatalogBlocked(db, row.id)) continue;
    const decision = aiControlDecision(
      db,
      state,
      state.route === "cloud" || state.localMode === "off",
    );
    const job = { bookmarkId: row.id, userId: row.userId, runId: state.runId };
    if (decision === "cancel") holdMediaCatalogControl(db, job, decision);
    if (decision === "allow")
      await MediaCatalogQueue.enqueue(job, {
        groupId: row.userId,
        idempotencyKey: state.runId,
        priority: state.batchId ? 50 : state.automatic ? 10 : 0,
      });
  }
}
