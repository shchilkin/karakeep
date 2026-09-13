import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, inArray, like, sql } from "drizzle-orm";
import type { DB } from "@karakeep/db";
import {
  bookmarkAssets,
  bookmarkLinks,
  bookmarks,
  mediaAiBatches,
  mediaAiRequests,
  mediaAiRuns,
} from "@karakeep/db/schema";
import {
  importProcessingPermit,
  isBookmarkDeferred,
} from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import { activeAiStatuses, failedAiStatuses } from "@karakeep/shared/aiControl";
import type {
  AiBatchEntry,
  AiBatchRequest,
  AiFilter,
} from "@karakeep/shared/aiControl";
import {
  MEDIA_CATALOG_VERSION,
  catalogBusy,
} from "@karakeep/shared/mediaCatalog";
import {
  catalogFingerprint,
  catalogSnapshot,
  holdMediaCatalogControl,
  requestMediaCatalog,
} from "./mediaCatalog";

const title = sql<string>`coalesce(nullif(${bookmarks.title}, ''), json_extract(${bookmarks.mediaAi}, '$.result.title'), ${bookmarkLinks.title}, ${bookmarkAssets.fileName}, 'Untitled')`;
const sourceProvider = sql<string>`json_extract(${bookmarks.mediaAi}, '$.resultSource.provider')`;
const sourceModel = sql<string>`json_extract(${bookmarks.mediaAi}, '$.resultSource.model')`;
const status = sql<string>`json_extract(${bookmarks.mediaAi}, '$.status')`;

function whereFilter(userId: string, filter: AiFilter) {
  return and(
    eq(bookmarks.userId, userId),
    filter.query
      ? like(title, `%${filter.query.replace(/[\\%_]/g, "")}%`)
      : undefined,
    filter.provider === "unknown"
      ? sql`${sourceProvider} IS NULL`
      : filter.provider
        ? eq(sourceProvider, filter.provider)
        : undefined,
    filter.model ? eq(sourceModel, filter.model) : undefined,
    filter.analyzedBefore
      ? sql`json_extract(${bookmarks.mediaAi}, '$.resultSource.analyzedAt') < ${filter.analyzedBefore}`
      : undefined,
    filter.status === "missing"
      ? sql`coalesce(trim(json_extract(${bookmarks.mediaAi}, '$.result.summary')), '') = ''`
      : filter.status === "failed"
        ? inArray(status, failedAiStatuses)
        : filter.status === "active"
          ? inArray(status, activeAiStatuses)
          : filter.status === "success"
            ? eq(status, "success")
            : filter.status === "needs_review"
              ? sql`json_extract(${bookmarks.mediaAi}, '$.result') IS NOT NULL AND (
              coalesce(json_extract(${bookmarks.mediaAi}, '$.resultSource.catalogVersion'), -1) != ${MEDIA_CATALOG_VERSION}
              OR coalesce(json_extract(${bookmarks.mediaAi}, '$.resultSource.contentRevision'), -1) != ${bookmarks.contentRevision}
              OR ${status} = 'stale')`
              : undefined,
  );
}

function cardQuery(db: DB) {
  return db
    .select({
      id: bookmarks.id,
      title,
      mediaAi: bookmarks.mediaAi,
      processingPolicy: bookmarks.processingPolicy,
    })
    .from(bookmarks)
    .leftJoin(bookmarkLinks, eq(bookmarkLinks.id, bookmarks.id))
    .leftJoin(bookmarkAssets, eq(bookmarkAssets.id, bookmarks.id));
}

export function listAiCards(
  db: DB,
  userId: string,
  filter: AiFilter,
  offset = 0,
) {
  const where = whereFilter(userId, filter);
  const total = db
    .select({ n: count() })
    .from(bookmarks)
    .leftJoin(bookmarkLinks, eq(bookmarkLinks.id, bookmarks.id))
    .leftJoin(bookmarkAssets, eq(bookmarkAssets.id, bookmarks.id))
    .where(where)
    .get()!.n;
  const items = cardQuery(db)
    .where(where)
    .orderBy(desc(bookmarks.createdAt), bookmarks.id)
    .limit(50)
    .offset(offset)
    .all()
    .map(({ mediaAi, ...card }) => ({
      ...card,
      status: mediaAi?.status ?? "not_started",
      source: mediaAi?.resultSource,
      hasDescription: !!mediaAi?.result?.summary,
      requestedModel: mediaAi?.model,
    }));
  return { items, total };
}

function ownedBatch(db: DB, userId: string, id: string) {
  const batch = db
    .select()
    .from(mediaAiBatches)
    .where(and(eq(mediaAiBatches.id, id), eq(mediaAiBatches.userId, userId)))
    .get();
  if (!batch) throw new TRPCError({ code: "NOT_FOUND" });
  return batch;
}

export function prepareAiBatch(
  db: DB,
  userId: string,
  request: AiBatchRequest,
) {
  return db.transaction(
    () => {
      const prior = db
        .select()
        .from(mediaAiBatches)
        .where(eq(mediaAiBatches.id, request.requestId))
        .get();
      if (prior) {
        if (
          prior.userId !== userId ||
          JSON.stringify(prior.request) !== JSON.stringify(request)
        )
          throw new TRPCError({
            code: "CONFLICT",
            message: "Request identity already used.",
          });
        return aiBatchView(db, userId, prior.id);
      }
      if (!serverConfig.mediaAi.enabled)
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Media AI is disabled on the server.",
        });
      const where =
        request.selection.type === "ids"
          ? and(
              eq(bookmarks.userId, userId),
              inArray(bookmarks.id, [...new Set(request.selection.ids)]),
            )
          : whereFilter(userId, request.selection.filter);
      const cards = cardQuery(db)
        .where(where)
        .orderBy(desc(bookmarks.createdAt), bookmarks.id)
        .limit(201)
        .all();
      if (
        request.selection.type === "ids" &&
        cards.length !== new Set(request.selection.ids).size
      )
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "One or more cards are unavailable.",
        });
      if (cards.length > 200)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Select at most 200 cards or narrow the filter.",
        });
      if (!cards.length)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No matching cards.",
        });
      const entries: AiBatchEntry[] = cards.map((card) => {
        const snapshot = catalogSnapshot(db, userId, card.id);
        let reason: string | undefined;
        if (
          card.processingPolicy === "deferred" &&
          !importProcessingPermit(db, card.id, "catalog")
        )
          reason = "import_held";
        else if (!snapshot.input) reason = "no_saved_media";
        else if (catalogBusy(card.mediaAi)) reason = "already_queued";
        else if (
          request.action === "analyze" &&
          card.mediaAi?.status === "success"
        )
          reason = "already_analyzed";
        else if (
          request.mode === "local" &&
          (!serverConfig.mediaAi.hybridEnabled ||
            serverConfig.mediaAi.localMode !== "enforce")
        )
          reason = "local_unavailable";
        return {
          bookmarkId: card.id,
          runId: randomUUID(),
          priorRunId: card.mediaAi?.runId ?? null,
          policyRevision: snapshot.bookmark.policyRevision,
          contentRevision: snapshot.bookmark.contentRevision,
          fingerprint: snapshot.input
            ? catalogFingerprint(
                snapshot.input,
                request.model,
                request.mode === "local",
                serverConfig.mediaAi.provider,
              )
            : "",
          status: reason ? "skipped" : "ready",
          reason,
        };
      });
      db.insert(mediaAiBatches)
        .values({
          id: request.requestId,
          userId,
          status: "draft",
          provider: serverConfig.mediaAi.provider,
          request,
          entries,
          createdAt: new Date().toISOString(),
        })
        .run();
      return aiBatchView(db, userId, request.requestId);
    },
    { behavior: "immediate" },
  );
}

export function aiBatchView(db: DB, userId: string, id: string) {
  const batch = ownedBatch(db, userId, id);
  const cards = batch.entries.length
    ? cardQuery(db)
        .where(
          and(
            eq(bookmarks.userId, userId),
            inArray(
              bookmarks.id,
              batch.entries.map((e) => e.bookmarkId),
            ),
          ),
        )
        .all()
    : [];
  const byId = new Map(cards.map((c) => [c.id, c]));
  const previousRunIds = batch.entries
    .filter((e) => e.status === "ready" && e.priorRunId)
    .map((e) => e.priorRunId!);
  const previousPaidAttempts = previousRunIds.length
    ? db
        .select({ n: count() })
        .from(mediaAiRequests)
        .where(inArray(mediaAiRequests.id, previousRunIds))
        .get()!.n
    : 0;
  const entries = batch.entries.map((entry) => {
    const card = byId.get(entry.bookmarkId);
    const current = card?.mediaAi;
    const effectiveStatus = !card
      ? "deleted"
      : entry.status === "queued"
        ? current?.batchId === id
          ? current.status
          : "superseded"
        : entry.status;
    return {
      bookmarkId: entry.bookmarkId,
      title: card?.title ?? "Deleted card",
      status: effectiveStatus,
      reason: entry.reason,
    };
  });
  return {
    id,
    status: batch.status,
    provider: batch.provider,
    model: batch.request.model,
    mode: batch.request.mode,
    action: batch.request.action,
    createdAt: batch.createdAt,
    entries,
    previousPaidAttempts,
  };
}

export async function changeAiBatch(
  db: DB,
  userId: string,
  id: string,
  action: "start" | "pause" | "resume" | "cancel",
) {
  db.transaction(
    (tx) => {
      const batch = ownedBatch(db, userId, id);
      if (batch.status === "cancelled" || batch.status === "complete") return;
      const next =
        action === "pause"
          ? "paused"
          : action === "cancel"
            ? "cancelled"
            : "running";
      if (action === "resume" && batch.status !== "paused") return;
      if (action === "start" && batch.status !== "draft") return;
      tx.update(mediaAiBatches)
        .set({ status: next })
        .where(eq(mediaAiBatches.id, id))
        .run();
    },
    { behavior: "immediate" },
  );
  if (action === "start" || action === "resume") await drainAiBatches(db, id);
  if (action === "cancel") {
    const batch = ownedBatch(db, userId, id);
    for (const entry of batch.entries) {
      const card = db
        .select()
        .from(bookmarks)
        .where(
          and(eq(bookmarks.id, entry.bookmarkId), eq(bookmarks.userId, userId)),
        )
        .get();
      if (
        card?.mediaAi?.batchId === id &&
        ["pending", "waiting_resource", "waiting_control"].includes(
          card.mediaAi.status,
        )
      )
        holdMediaCatalogControl(
          db,
          { userId, bookmarkId: card.id, runId: card.mediaAi.runId },
          "cancel",
        );
    }
  }
  return aiBatchView(db, userId, id);
}

/** Durable draft entries are the outbox. Repeating delivery reuses the same run ID. */
const batchRecoveryCursor = new WeakMap<DB, string>();

export async function drainAiBatches(db: DB, onlyId?: string) {
  if (!serverConfig.mediaAi.enabled) return;
  const batches = db
    .select()
    .from(mediaAiBatches)
    .where(
      and(
        eq(mediaAiBatches.status, "running"),
        onlyId
          ? eq(mediaAiBatches.id, onlyId)
          : sql`${mediaAiBatches.id} > ${batchRecoveryCursor.get(db) ?? ""}`,
      ),
    )
    .orderBy(mediaAiBatches.id)
    .limit(20)
    .all();
  if (!onlyId)
    batchRecoveryCursor.set(
      db,
      batches.length === 20 ? batches[batches.length - 1].id : "",
    );
  for (const candidate of batches) {
    for (const item of candidate.entries
      .filter((e) => e.status === "ready")
      .slice(0, 20)) {
      const batch = ownedBatch(db, candidate.userId, candidate.id);
      if (batch.status !== "running") break;
      if (batch.entries.find((e) => e.runId === item.runId)?.status !== "ready")
        continue;
      let reason: string | undefined;
      let queued = false;
      try {
        const state = await requestMediaCatalog(
          db,
          batch.userId,
          item.bookmarkId,
          {
            retry: true,
            localOnly: batch.request.mode === "local",
            importRelease: isBookmarkDeferred(db, item.bookmarkId),
            control: {
              ...item,
              batchId: batch.id,
              model: batch.request.model,
              provider: batch.provider,
              refresh: batch.request.action === "refresh",
            },
          },
        );
        queued = !!state && state.runId === item.runId;
        reason = queued ? undefined : "changed_or_busy";
      } catch (error) {
        // Never expose provider bodies or source content. A persisted run owns all retries.
        const row = db
          .select()
          .from(bookmarks)
          .where(eq(bookmarks.id, item.bookmarkId))
          .get();
        queued = row?.mediaAi?.runId === item.runId;
        reason = queued
          ? undefined
          : error instanceof TRPCError && error.code === "NOT_FOUND"
            ? "deleted"
            : "changed_or_held";
      }
      db.transaction(
        (tx) => {
          const fresh = tx
            .select()
            .from(mediaAiBatches)
            .where(eq(mediaAiBatches.id, batch.id))
            .get()!;
          tx.update(mediaAiBatches)
            .set({
              entries: fresh.entries.map((e) =>
                e.runId === item.runId && e.status === "ready"
                  ? { ...e, status: queued ? "queued" : "skipped", reason }
                  : e,
              ),
            })
            .where(eq(mediaAiBatches.id, batch.id))
            .run();
        },
        { behavior: "immediate" },
      );
    }
    const view = aiBatchView(db, candidate.userId, candidate.id);
    if (
      view.status === "running" &&
      view.entries.every(
        (e) => e.status !== "ready" && !activeAiStatuses.includes(e.status),
      )
    )
      db.update(mediaAiBatches)
        .set({ status: "complete" })
        .where(
          and(
            eq(mediaAiBatches.id, candidate.id),
            eq(mediaAiBatches.status, "running"),
          ),
        )
        .run();
  }
}

export function aiHistory(db: DB, userId: string, bookmarkId: string) {
  const card = db
    .select()
    .from(bookmarks)
    .where(and(eq(bookmarks.id, bookmarkId), eq(bookmarks.userId, userId)))
    .get();
  if (!card) throw new TRPCError({ code: "NOT_FOUND" });
  const records = db
    .select()
    .from(mediaAiRuns)
    .where(
      and(
        eq(mediaAiRuns.bookmarkId, bookmarkId),
        eq(mediaAiRuns.userId, userId),
      ),
    )
    .orderBy(desc(mediaAiRuns.createdAt))
    .limit(30)
    .all();
  const history = records.map((row) => ({
    id: row.id,
    state: row.snapshot,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  }));
  if (card.mediaAi) {
    const found = history.find((h) => h.id === card.mediaAi!.runId);
    if (found) found.state = card.mediaAi;
    else
      history.unshift({
        id: card.mediaAi.runId,
        state: card.mediaAi,
        createdAt: card.mediaAi.updatedAt,
        completedAt: null,
      });
  }
  // History UI needs provenance, not private descriptions or raw classifier observations.
  return history.map(({ id, state, createdAt, completedAt }) => ({
    id,
    createdAt,
    completedAt,
    status: state.status,
    requestedProvider: state.provider,
    requestedModel: state.model,
    source: state.resultSource,
    localPolicy: state.localCheck?.frames[0]?.policy,
    localModel: state.localCheck?.frames[0]?.model,
    localRevision: state.localCheck?.frames[0]?.revision,
    current: card.mediaAi?.runId === id,
  }));
}
