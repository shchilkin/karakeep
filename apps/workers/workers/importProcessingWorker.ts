import { activeAiStatuses } from "@karakeep/shared/aiControl";
import { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, lt, lte, notExists, or, sql } from "drizzle-orm";
import sharp from "sharp";
import { importVideoFrame } from "./importVideoPreview";
import { isImportVideoMime } from "@karakeep/shared/types/deferredImport";
import type { DB } from "@karakeep/db";
import { db } from "@karakeep/db";
import {
  assets,
  AssetTypes,
  bookmarks,
  mediaAiRequests,
  importProcessing,
  importSourceAttachments,
} from "@karakeep/db/schema";
import {
  createAssetReadStream,
  extractImageDimensions,
  getAssetSize,
  importProcessingPermit,
  QuotaService,
  saveImportPreview,
} from "@karakeep/shared-server";
import { importStageOrder } from "@karakeep/shared/types/importProcessing";
import { getSearchClient } from "@karakeep/shared/search";
import logger from "@karakeep/shared/logger";
import { requestMediaCatalog } from "@karakeep/trpc/models/mediaCatalog";
import { runIndex } from "./searchWorker";

type Processing = typeof importProcessing.$inferSelect;
const LEASE_MS = 300_000;
const POLL_MS = 1000;
const MAX_ERROR_BACKOFF_MS = 30_000;
const activeAi = new Set(activeAiStatuses);
export class ImportProcessingError extends Error {}

/** Read only a bounded, verified original. The preview has its own retained asset ID. */
export async function makeImportPreview(database: DB, item: Processing) {
  const original = database
    .select()
    .from(importSourceAttachments)
    .where(eq(importSourceAttachments.sourceRevisionId, item.sourceRevisionId))
    .get();
  if (
    !original ||
    original.state !== "verified" ||
    !original.storedSha256 ||
    !original.storedSize ||
    original.storedSize > 50 * 1024 * 1024 ||
    original.assetId === item.previewAssetId
  )
    throw new ImportProcessingError("original_not_verified");
  const identity = { userId: item.userId, assetId: original.assetId };
  if ((await getAssetSize(identity)) !== original.storedSize)
    throw new ImportProcessingError("original_size_changed");
  const stream = Readable.from(await createAssetReadStream(identity));
  const timer = setTimeout(
    () => stream.destroy(new Error("Read deadline")),
    20_000,
  );
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of stream) {
      length += chunk.length;
      if (length > original.storedSize)
        throw new ImportProcessingError("original_size_changed");
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    clearTimeout(timer);
    stream.destroy();
  }
  const bytes = Buffer.concat(chunks);
  if (
    length !== original.storedSize ||
    createHash("sha256").update(bytes).digest("hex") !== original.storedSha256
  )
    throw new ImportProcessingError("original_hash_changed");
  const video = isImportVideoMime(original.detectedMime);
  const frame = video ? await importVideoFrame(bytes) : bytes;
  const { data, info } = await sharp(frame, {
    animated: false,
    limitInputPixels: 40_000_000,
  })
    .rotate()
    .resize({
      width: 1280,
      height: 1280,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 80, effort: 2 })
    .timeout({ seconds: 15 })
    .toBuffer({ resolveWithObject: true });
  if (!data.length || !info.width || !info.height)
    throw new ImportProcessingError("preview_decode_failed");
  const dimensions = await extractImageDimensions(
    frame,
    video ? "image/png" : original.detectedMime,
  );
  if (!dimensions)
    throw new ImportProcessingError("preview_dimensions_missing");
  assertClaim(database, item);
  const quotaApproved = await QuotaService.checkStorageQuota(
    database,
    item.userId,
    data.length,
  );
  await saveImportPreview(
    database,
    {
      bookmarkId: item.bookmarkId,
      generation: item.generation,
      leaseToken: item.leaseToken!,
    },
    data,
    quotaApproved,
  );
  database.transaction((tx) => {
    assertClaim(tx, item);
    tx.insert(assets)
      .values({
        id: item.previewAssetId,
        bookmarkId: item.bookmarkId,
        userId: item.userId,
        assetType: AssetTypes.ASSET_SCREENSHOT,
        contentType: "image/webp",
        fileName: "import-preview.webp",
        size: data.length,
        width: info.width,
        height: info.height,
      })
      .onConflictDoNothing()
      .run();
    tx.update(importProcessing)
      .set({
        previewReady: true,
        originalWidth: dimensions.width,
        originalHeight: dimensions.height,
      })
      .where(eq(importProcessing.bookmarkId, item.bookmarkId))
      .run();
  });
}

function assertClaim(database: Pick<DB, "select">, item: Processing) {
  const current = database
    .select()
    .from(importProcessing)
    .where(
      and(
        eq(importProcessing.bookmarkId, item.bookmarkId),
        eq(importProcessing.generation, item.generation),
        eq(importProcessing.leaseToken, item.leaseToken!),
        gt(importProcessing.leaseUntil, Date.now()),
      ),
    )
    .get();
  const bookmark = database
    .select()
    .from(bookmarks)
    .where(eq(bookmarks.id, item.bookmarkId))
    .get();
  if (
    !current ||
    !bookmark ||
    bookmark.userId !== item.userId ||
    bookmark.processingPolicy !== "deferred" ||
    bookmark.policyRevision !== item.policyRevision ||
    bookmark.contentRevision !== item.contentRevision
  )
    throw new ImportProcessingError("processing_revision_changed");
}

export interface ImportProcessingSteps {
  preview: (database: DB, item: Processing) => Promise<void>;
  search: (item: Processing) => Promise<void>;
  catalog: typeof requestMediaCatalog;
}
const steps: ImportProcessingSteps = {
  preview: makeImportPreview,
  search: async (item) => {
    const client = await getSearchClient();
    if (!client) throw new ImportProcessingError("search_unavailable");
    await runIndex(client, item.bookmarkId, false);
    const indexed = await client.search({
      query: "",
      filter: [
        { type: "eq", field: "id", value: item.bookmarkId },
        { type: "eq", field: "userId", value: item.userId },
      ],
      limit: 1,
    });
    if (!indexed.hits.some((hit) => hit.id === item.bookmarkId))
      throw new ImportProcessingError("search_not_visible");
  },
  catalog: requestMediaCatalog,
};

/** Durable, single-admission CPU controller. It never holds a lease during GPU work. */
export async function processNextImport(
  database: DB,
  actions: ImportProcessingSteps = steps,
) {
  const item = database.transaction(
    (tx) => {
      const now = Date.now();
      if (
        tx
          .select()
          .from(importProcessing)
          .where(gt(importProcessing.leaseUntil, now))
          .get()
      )
        return null;
      const candidate = tx
        .select()
        .from(importProcessing)
        .where(
          and(
            or(
              inArray(importProcessing.state, ["queued", "running"]),
              and(
                eq(importProcessing.state, "waiting_ai"),
                or(
                  lte(importProcessing.updatedAt, now - POLL_MS),
                  // An active checkpoint has a durable polling cooldown, so
                  // draining ready work cannot repeatedly reclaim it. Terminal
                  // or missing checkpoints remain immediately actionable.
                  notExists(
                    tx
                      .select({ id: bookmarks.id })
                      .from(bookmarks)
                      .where(
                        and(
                          eq(bookmarks.id, importProcessing.bookmarkId),
                          eq(
                            sql<string>`json_extract(${bookmarks.mediaAi}, '$.runId')`,
                            importProcessing.aiRunId,
                          ),
                          inArray(
                            sql<string>`json_extract(${bookmarks.mediaAi}, '$.status')`,
                            activeAiStatuses,
                          ),
                        ),
                      ),
                  ),
                ),
              ),
              and(
                eq(importProcessing.state, "complete"),
                lt(
                  importProcessing.searchIndexedRevision,
                  importProcessing.searchRevision,
                ),
                inArray(importProcessing.stage, [
                  "search",
                  "local_check",
                  "catalog",
                ]),
              ),
            ),
            lte(importProcessing.leaseUntil, now),
          ),
        )
        .orderBy(importProcessing.updatedAt)
        .get();
      if (!candidate) return null;
      const claimed = {
        ...candidate,
        // An expired writer can only finish its private, unpublished derivative.
        // It cannot overwrite the asset subsequently published by a new claim.
        previewAssetId: candidate.previewReady
          ? candidate.previewAssetId
          : randomUUID(),
        leaseToken: randomUUID(),
        leaseUntil: now + LEASE_MS,
        updatedAt: now,
      };
      tx.update(importProcessing)
        .set(claimed)
        .where(eq(importProcessing.bookmarkId, claimed.bookmarkId))
        .run();
      return claimed;
    },
    { behavior: "immediate" },
  );
  if (!item) return false;
  const update = (values: Partial<Processing>) => {
    database.transaction((tx) => {
      assertClaim(tx, item);
      tx.update(importProcessing)
        .set({ ...values, updatedAt: Date.now() })
        .where(
          and(
            eq(importProcessing.bookmarkId, item.bookmarkId),
            eq(importProcessing.generation, item.generation),
            eq(importProcessing.leaseToken, item.leaseToken!),
          ),
        )
        .run();
    });
    Object.assign(item, values);
  };
  const publishSearch = async () => {
    let searchFailed = false;
    let searchError: unknown;
    try {
      await actions.search(item);
    } catch (error) {
      searchFailed = true;
      searchError = error;
    }
    try {
      assertClaim(database, item);
    } catch (error) {
      // Search is an external, unversioned projection. If an obsolete request
      // completes late (including an uncertain HTTP outcome), durably request
      // a fresh projection of the current retained record, without replaying AI.
      database
        .update(importProcessing)
        .set({
          searchRevision: sql`${importProcessing.searchRevision} + 1`,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(importProcessing.bookmarkId, item.bookmarkId),
            eq(importProcessing.policyRevision, item.policyRevision),
            eq(importProcessing.contentRevision, item.contentRevision),
          ),
        )
        .run();
      throw error;
    }
    if (searchFailed) throw searchError;
    // Repair dirtiness is independent of admission: an already running paid
    // analysis must keep its permit while the search projection catches up.
    update({ searchIndexedRevision: item.searchRevision });
  };
  try {
    assertClaim(database, item);
    update({ state: "running" });
    if (!item.previewReady) {
      await actions.preview(database, item);
      update({ previewReady: true });
    }
    if (
      importStageOrder[item.stage] >= importStageOrder.search &&
      // Once AI is admitted, defer projection repair until its checkpoint is
      // terminal. Search outages must not revoke an in-flight paid result.
      !item.aiRunId &&
      (!item.searchReady || item.searchIndexedRevision < item.searchRevision)
    ) {
      await publishSearch();
      update({ searchReady: true });
    }
    if (importStageOrder[item.stage] >= importStageOrder.local_check) {
      // Read current checkpoint after every restart; never create a second intent
      // merely because the queue or cloud response is slow or uncertain.
      const current = database
        .select()
        .from(importProcessing)
        .where(eq(importProcessing.bookmarkId, item.bookmarkId))
        .get()!;
      if (!current.aiRunId) {
        const state = await actions.catalog(
          database,
          item.userId,
          item.bookmarkId,
          {
            importRelease: true,
            retry: true,
            classificationOnly: item.stage === "local_check",
            localOnly: item.stage === "local_check",
          },
        );
        if (!state) throw new ImportProcessingError("analysis_not_admitted");
        update({
          aiRunId: state.runId,
          state: "waiting_ai",
          leaseToken: null,
          leaseUntil: 0,
        });
        return true;
      }
      const state = database
        .select({ ai: bookmarks.mediaAi })
        .from(bookmarks)
        .where(eq(bookmarks.id, item.bookmarkId))
        .get()?.ai;
      if (!state || state.runId !== current.aiRunId)
        throw new ImportProcessingError("analysis_checkpoint_missing");
      if (activeAi.has(state.status)) {
        update({ state: "waiting_ai", leaseToken: null, leaseUntil: 0 });
        return true;
      }
      const success =
        item.stage === "local_check"
          ? state.status === "local_review"
          : state.status === "success" && !!state.result;
      if (!success) {
        const paid = database
          .select({ id: mediaAiRequests.id })
          .from(mediaAiRequests)
          .where(eq(mediaAiRequests.id, state.runId))
          .get();
        throw new ImportProcessingError(
          paid
            ? "analysis_paid_result_unconfirmed"
            : `analysis_${state.status}`,
        );
      }
      // Publish the AI projection only after the model succeeds; the original
      // title and source tags are still present in the search document.
      await publishSearch();
    }
    update({ state: "complete", error: null, leaseToken: null, leaseUntil: 0 });
  } catch (error) {
    // Log/store only a controlled code. Decoder/provider exceptions may contain
    // paths or private metadata. A failed stage needs an explicit owner retry.
    const code =
      error instanceof ImportProcessingError
        ? error.message
        : "processing_failed";
    database.transaction(
      (tx) => {
        const ownedClaim = and(
          eq(importProcessing.bookmarkId, item.bookmarkId),
          eq(importProcessing.generation, item.generation),
          eq(importProcessing.leaseToken, item.leaseToken!),
        );
        if (!tx.select().from(importProcessing).where(ownedClaim).get()) return;
        const permit = importProcessingPermit(
          tx,
          item.bookmarkId,
          "local_check",
        );
        const state = tx
          .select({ ai: bookmarks.mediaAi })
          .from(bookmarks)
          .where(eq(bookmarks.id, item.bookmarkId))
          .get()?.ai;
        // Admission persists its run before enqueue. An expired CPU lease or a
        // later controller error must not revoke a still-active AI run's permit:
        // it may already be paid, and its result/recovery still needs to commit.
        // Never reopen a failed run or overwrite a newer lease/generation.
        const waiting =
          !!permit?.aiRunId &&
          state?.runId === permit.aiRunId &&
          activeAi.has(state.status);
        tx.update(importProcessing)
          .set({
            state: waiting ? "waiting_ai" : "failed",
            error: waiting ? null : code,
            leaseUntil: 0,
            leaseToken: null,
            updatedAt: Date.now(),
          })
          .where(ownedClaim)
          .run();
      },
      { behavior: "immediate" },
    );
  }
  return true;
}

export class ImportProcessingWorker {
  static async build(processNext = () => processNextImport(db)) {
    let stopped = false;
    let errorBackoff = POLL_MS;
    let wake: (() => void) | undefined;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        }
        wake = done;
      });
    return {
      async run() {
        while (!stopped) {
          let waitMs = 0;
          try {
            const worked = await processNext();
            errorBackoff = POLL_MS;
            if (!worked) waitMs = POLL_MS;
          } catch {
            waitMs = errorBackoff;
            errorBackoff = Math.min(errorBackoff * 2, MAX_ERROR_BACKOFF_MS);
            logger.warn(
              "[importProcessing] Controller unavailable; durable intents remain pending.",
            );
          }
          if (!stopped && waitMs) await sleep(waitMs);
        }
      },
      stop() {
        stopped = true;
        wake?.();
      },
    };
  }
}
