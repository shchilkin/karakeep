import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getInMemoryDB } from "@karakeep/db/drizzle";
import * as schema from "@karakeep/db/schema";
import serverConfig from "@karakeep/shared/config";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import type {
  ImportReservationInput,
  ImportReceipt,
} from "@karakeep/shared/types/deferredImport";
import { createCallerFactory } from "..";
import { appRouter } from "./_app";
import { advanceLocalCheckBatches } from "../models/importLocalCheckBatches";

let db: ReturnType<typeof getInMemoryDB>;
function caller(id = "owner") {
  return createCallerFactory(appRouter)({
    db,
    user: { id, role: "user" },
    auth: { type: "session" },
    req: { ip: null },
  });
}
// Synthetic persisted imports are fixtures, not assertions against private state.
function seed(id: string, mime = "image/jpeg", owner = "owner") {
  const payload: ImportReservationInput = {
    contractVersion: "deferred-copy-v1",
    source: {
      provider: "mymind",
      accountScope: "test",
      objectId: id,
      revision: "1",
      revisionKind: "current",
    },
    metadata: { sha256: "a".repeat(64), size: 2 },
    mapping: {
      title: id,
      note: null,
      sourceUrl: null,
      savedAt: null,
      tags: [],
    },
    completeness: "unknown",
    attachments: [
      {
        slot: "original",
        ordinal: 0,
        role: "original",
        originalName: "test.jpg",
        observed: { sha256: "a".repeat(64), size: 10 },
        exported: { sha256: "a".repeat(64), size: 10 },
        transport: { fileid: id, etag: "1" },
      },
    ],
    processingPolicy: "deferred",
    storageMode: "copy",
  };
  db.insert(schema.bookmarks)
    .values({
      id,
      userId: owner,
      type: BookmarkTypes.ASSET,
      title: id,
      processingPolicy: "deferred",
      policyRevision: 1,
    })
    .run();
  db.insert(schema.importSourceObjects)
    .values({
      id,
      userId: owner,
      provider: "mymind",
      accountScope: "test",
      objectId: id,
    })
    .run();
  const receipt: ImportReceipt = {
    operationId: id,
    sourceRevisionId: id,
    bookmarkId: id,
    assets: [],
    metadataSha256: "a".repeat(64),
    metadataSize: 2,
    metadataUrl: `/imports/${id}/metadata`,
    processingPolicy: "deferred",
    policyRevision: 1,
    contentRevision: 1,
    physicalReuse: false,
  };
  db.insert(schema.importSourceRevisions)
    .values({
      id,
      sourceObjectId: id,
      userId: owner,
      revision: "1",
      payloadDigest: "a".repeat(64),
      payload,
      state: "committed",
      fencingToken: 1,
      leaseUntil: 0,
      bookmarkId: id,
      receipt,
    })
    .run();
  db.insert(schema.importSourceAttachments)
    .values({
      sourceRevisionId: id,
      slot: "original",
      assetId: `asset-${id}`,
      state: "verified",
      detectedMime: mime,
      storedSize: 10,
      storedSha256: "a".repeat(64),
    })
    .run();
  db.insert(schema.importProcessing)
    .values({
      bookmarkId: id,
      sourceRevisionId: id,
      userId: owner,
      requestId: randomUUID(),
      stage: "preview",
      state: "complete",
      generation: 1,
      policyRevision: 1,
      contentRevision: 1,
      previewAssetId: `preview-${id}`,
      previewReady: true,
      updatedAt: Date.now(),
    })
    .run();
}
beforeEach(() => {
  db = getInMemoryDB(true);
  db.insert(schema.users)
    .values([
      { id: "owner", name: "One", email: "one@example.test" },
      { id: "other", name: "Two", email: "two@example.test" },
    ])
    .run();
  vi.spyOn(serverConfig, "mediaAi", "get").mockReturnValue({
    ...serverConfig.mediaAi,
    enabled: true,
    hybridEnabled: true,
    localMode: "enforce",
  });
});
afterEach(() => {
  db.$client.close();
  vi.restoreAllMocks();
});

test("batch controls require an authenticated imports scope", async () => {
  const anonymous = createCallerFactory(appRouter)({
    db,
    user: null,
    auth: null,
    req: { ip: null },
  });
  await expect(
    anonymous.deferredImport.localCheckBatches(),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const limited = createCallerFactory(appRouter)({
    db,
    user: { id: "owner", role: "user" },
    auth: { type: "apiKey", keyId: "test", scopes: [] },
    req: { ip: null },
  });
  await expect(
    limited.deferredImport.prepareLocalCheckBatch({
      requestId: randomUUID(),
      selection: { type: "all" },
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("owner reviews a fixed import selection without starting processing", async () => {
  seed("one");
  seed("two");
  seed("video", "video/mp4");
  seed("private", "image/jpeg", "other");
  const request = {
    requestId: randomUUID(),
    selection: { type: "all" as const },
  };
  const batch = await caller().deferredImport.prepareLocalCheckBatch(request);
  expect(batch).toMatchObject({
    id: request.requestId,
    status: "draft",
    total: 3,
    counts: { ready: 2, skipped: 1, complete: 0, failed: 0 },
    outcomeReasons: { unsupported: 1 },
  });
  expect(await caller().deferredImport.processing({ id: "one" })).toMatchObject(
    { stage: "preview", generation: 1, state: "complete" },
  );
  seed("later");
  expect(
    await caller().deferredImport.localCheckBatch({ id: batch.id }),
  ).toEqual(batch);
  expect(await caller().deferredImport.prepareLocalCheckBatch(request)).toEqual(
    batch,
  );
});

test("large selections skip checked, failed and active imports, and stay owner scoped", async () => {
  const ids = Array.from({ length: 250 }, (_, i) => `image-${i}`);
  for (const id of ids) seed(id);
  seed("checked");
  seed("failed");
  seed("active");
  seed("private", "image/jpeg", "other");
  db.update(schema.importProcessing)
    .set({ stage: "local_check", state: "complete" })
    .where(eq(schema.importProcessing.bookmarkId, "checked"))
    .run();
  db.update(schema.importProcessing)
    .set({ state: "failed" })
    .where(eq(schema.importProcessing.bookmarkId, "failed"))
    .run();
  db.update(schema.importProcessing)
    .set({ state: "running" })
    .where(eq(schema.importProcessing.bookmarkId, "active"))
    .run();
  const requestId = randomUUID();
  const batch = await caller().deferredImport.prepareLocalCheckBatch({
    requestId,
    selection: {
      type: "ids",
      ids: [...ids, "checked", "failed", "active", "private", "missing"],
    },
  });
  expect(batch).toMatchObject({
    total: 253,
    counts: { ready: 250, skipped: 3 },
    outcomeReasons: { already_checked: 1, prior_failure: 1, active: 1 },
  });
  await expect(
    caller("other").deferredImport.localCheckBatch({ id: batch.id }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    caller().deferredImport.prepareLocalCheckBatch({
      requestId,
      selection: { type: "all" },
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});

test("owner explicitly starts, pauses and resumes one durable batch without releasing catalog", async () => {
  seed("one");
  const api = caller().deferredImport;
  const batch = await api.prepareLocalCheckBatch({
    requestId: randomUUID(),
    selection: { type: "all" },
  });
  expect(
    await api.changeLocalCheckBatch({ id: batch.id, action: "start" }),
  ).toMatchObject({ status: "running" });
  expect(
    await api.changeLocalCheckBatch({ id: batch.id, action: "start" }),
  ).toMatchObject({ status: "running" });
  expect(await api.processing({ id: "one" })).toMatchObject({
    stage: "preview",
  });
  await expect(
    caller("other").deferredImport.changeLocalCheckBatch({
      id: batch.id,
      action: "pause",
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await api.changeLocalCheckBatch({ id: batch.id, action: "pause" });
  expect(await caller().deferredImport.localCheckBatches()).toMatchObject([
    { id: batch.id, status: "paused" },
  ]);
  const duplicate = await api.prepareLocalCheckBatch({
    requestId: randomUUID(),
    selection: { type: "all" },
  });
  await expect(
    api.changeLocalCheckBatch({ id: duplicate.id, action: "start" }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(
    await api.changeLocalCheckBatch({ id: batch.id, action: "resume" }),
  ).toMatchObject({ status: "running" });
});

test("dispatcher admits one local-check intent across repeated polls and reconciles an in-flight item while paused", async () => {
  seed("one");
  seed("two");
  const api = caller().deferredImport;
  const batch = await api.prepareLocalCheckBatch({
    requestId: randomUUID(),
    selection: { type: "all" },
  });
  await advanceLocalCheckBatches(db);
  expect(await api.processing({ id: "one" })).toMatchObject({
    stage: "preview",
  });
  await api.changeLocalCheckBatch({ id: batch.id, action: "start" });
  await advanceLocalCheckBatches(db);
  const admitted = await api.processing({ id: "one" });
  expect(admitted).toMatchObject({
    stage: "local_check",
    state: "queued",
    generation: 2,
  });
  await advanceLocalCheckBatches(db);
  expect(await api.processing({ id: "one" })).toEqual(admitted);
  expect(await api.processing({ id: "two" })).toMatchObject({
    stage: "preview",
  });
  await api.changeLocalCheckBatch({ id: batch.id, action: "pause" });
  // Simulate the existing processor committing a terminal checkpoint.
  const runId = randomUUID();
  db.update(schema.importProcessing)
    .set({ state: "waiting_ai", aiRunId: runId, searchReady: true })
    .where(eq(schema.importProcessing.bookmarkId, "one"))
    .run();
  db.update(schema.bookmarks)
    .set({
      mediaAi: {
        fingerprint: "test",
        model: "test",
        runId,
        status: "local_review",
        updatedAt: new Date().toISOString(),
        allowPreview: true,
        localOnly: true,
        classificationOnly: true,
      },
    })
    .where(eq(schema.bookmarks.id, "one"))
    .run();
  db.update(schema.importProcessing)
    .set({ state: "complete" })
    .where(eq(schema.importProcessing.bookmarkId, "one"))
    .run();
  await advanceLocalCheckBatches(db);
  expect(await api.localCheckBatch({ id: batch.id })).toMatchObject({
    status: "paused",
    counts: { complete: 1, ready: 1, released: 0 },
  });
  expect(await api.processing({ id: "two" })).toMatchObject({
    stage: "preview",
  });
  await api.changeLocalCheckBatch({ id: batch.id, action: "resume" });
  await advanceLocalCheckBatches(db);
  expect(await api.processing({ id: "two" })).toMatchObject({
    stage: "local_check",
    generation: 2,
  });
});

test("failed processing pauses admission and resume never retries the uncertain item", async () => {
  seed("one");
  seed("two");
  const api = caller().deferredImport;
  const batch = await api.prepareLocalCheckBatch({
    requestId: randomUUID(),
    selection: { type: "all" },
  });
  await api.changeLocalCheckBatch({ id: batch.id, action: "start" });
  advanceLocalCheckBatches(db);
  db.update(schema.importProcessing)
    .set({ state: "failed", error: "analysis_checkpoint_missing" })
    .where(eq(schema.importProcessing.bookmarkId, "one"))
    .run();
  advanceLocalCheckBatches(db);
  expect(await api.localCheckBatch({ id: batch.id })).toMatchObject({
    status: "paused",
    counts: { failed: 1, ready: 1 },
    outcomeReasons: { analysis_checkpoint_missing: 1 },
  });
  const failed = await api.processing({ id: "one" });
  advanceLocalCheckBatches(db);
  await api.changeLocalCheckBatch({ id: batch.id, action: "resume" });
  advanceLocalCheckBatches(db);
  expect(await api.processing({ id: "one" })).toEqual(failed);
  expect(await api.processing({ id: "two" })).toMatchObject({
    state: "queued",
    stage: "local_check",
  });
  const entries = await api.localCheckBatchItems({
    id: batch.id,
    offset: 0,
    limit: 1,
  });
  expect(entries).toMatchObject({
    total: 2,
    items: [
      {
        bookmarkId: "one",
        state: "failed",
        reason: "analysis_checkpoint_missing",
      },
    ],
  });
  await expect(
    caller("other").deferredImport.localCheckBatchItems({ id: batch.id }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("changed permissions or disabled local checking cannot expand a prepared release", async () => {
  seed("one");
  seed("large");
  seed("pdf", "application/pdf");
  db.update(schema.importSourceAttachments)
    .set({ storedSize: 51 * 1024 * 1024 })
    .where(eq(schema.importSourceAttachments.sourceRevisionId, "large"))
    .run();
  const api = caller().deferredImport;
  const batch = await api.prepareLocalCheckBatch({
    requestId: randomUUID(),
    selection: { type: "all" },
  });
  expect(batch).toMatchObject({ counts: { ready: 1, skipped: 2 } });
  vi.spyOn(serverConfig, "mediaAi", "get").mockReturnValue({
    ...serverConfig.mediaAi,
    localMode: "off",
  });
  await expect(
    api.changeLocalCheckBatch({ id: batch.id, action: "start" }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  vi.spyOn(serverConfig, "mediaAi", "get").mockReturnValue({
    ...serverConfig.mediaAi,
    localMode: "enforce",
  });
  await api.release({
    id: "one",
    requestId: randomUUID(),
    expectedGeneration: 1,
    stage: "search",
  });
  await api.changeLocalCheckBatch({ id: batch.id, action: "start" });
  advanceLocalCheckBatches(db);
  advanceLocalCheckBatches(db);
  expect(await api.localCheckBatch({ id: batch.id })).toMatchObject({
    status: "complete",
    counts: { skipped: 3, complete: 0 },
    outcomeReasons: { changed: 1, unsupported: 2 },
  });
  expect(await api.processing({ id: "one" })).toMatchObject({
    stage: "search",
    generation: 2,
  });
});
