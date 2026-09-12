import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getInMemoryDB } from "@karakeep/db/drizzle";
import * as schema from "@karakeep/db/schema";
import serverConfig from "@karakeep/shared/config";
import {
  automaticQueueAllowed,
  isImportAssetRetained,
  MediaCatalogQueue,
  loadAllPlugins,
} from "@karakeep/shared-server";
import { PluginManager, PluginType } from "@karakeep/shared/plugins";
import { zLocalCheckResult } from "@karakeep/shared/mediaLocalCheck";
import { concealSensitiveBookmark } from "@karakeep/shared/sensitiveVisibility";
import type { ImportReservationInput } from "@karakeep/shared/types/deferredImport";
import type { ImportProcessingStage } from "@karakeep/shared/types/importProcessing";
import type { AuthedContext } from "@karakeep/trpc";
import {
  commitImport,
  reserveImport,
  uploadImportFile,
  uploadImportMetadata,
  readImportMetadata,
} from "@karakeep/trpc/models/deferredImport";
import {
  getImportProcessing,
  releaseImportProcessing,
} from "@karakeep/trpc/models/importProcessing";
import {
  requestMediaCatalog,
  startMediaCatalog,
  continueMediaCatalog,
  finishMediaCatalog,
  recoverLocalMediaCatalog,
} from "@karakeep/trpc/models/mediaCatalog";
import { Bookmark } from "@karakeep/trpc/models/bookmarks";
import { makeImportPreview, processNextImport } from "./importProcessingWorker";

vi.mock("@karakeep/shared-server", async (original) => ({
  ...(await original<typeof import("@karakeep/shared-server")>()),
  MediaCatalogQueue: { enqueue: vi.fn().mockResolvedValue("queued") },
}));
let db: ReturnType<typeof getInMemoryDB>;
let ctx: AuthedContext;
const directory = `/tmp/karakeep-processing-${randomUUID()}`;
let original: Buffer;
let id: string;
let bookmarkId: string;
let assetId: string;
const metadata = Buffer.from(
  '{"title":"Source title","tags":["Source tag"],"unknown":null}\n',
);
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const search = vi.fn(async () => undefined);
const preview = vi.fn(makeImportPreview);
const actions = { preview, search, catalog: requestMediaCatalog };
const native = (categories: string[] = [], status = "complete") =>
  zLocalCheckResult.parse({
    scope: "outgoing_images_only",
    frames: [
      {
        model: "google/shieldgemma-2-4b-it",
        revision: "eaf60452b5fc41a911338a022e628b0c15283897",
        policy: "shieldgemma-native-v1",
        precision: "bf16",
        status,
        categories,
        sha256: "a".repeat(64),
        scores:
          status === "complete"
            ? {
                dangerous: 0.01,
                violence: 0.01,
                sexual: categories.includes("sexual") ? 0.9 : 0.01,
              }
            : null,
      },
    ],
  });
beforeEach(async () => {
  await mkdir(directory, { recursive: true });
  vi.spyOn(serverConfig, "dataDir", "get").mockReturnValue(directory);
  vi.spyOn(serverConfig, "assetsDir", "get").mockReturnValue(
    path.join(directory, "assets"),
  );
  Object.assign(serverConfig.mediaAi, {
    enabled: true,
    hybridEnabled: true,
    localMode: "enforce",
    apiKey: "synthetic",
    model: "grok-4.6",
    dailyRequests: 200,
  });
  db = getInMemoryDB(true);
  db.insert(schema.users)
    .values([
      { id: "owner", name: "Owner", email: "o@example.test" },
      { id: "other", name: "Other", email: "x@example.test" },
    ])
    .run();
  ctx = {
    db,
    user: { id: "owner", role: "user" },
    auth: { type: "session" },
    req: { ip: null },
  };
  original = await sharp({
    create: { width: 120, height: 80, channels: 3, background: "#789abc" },
  })
    .png()
    .toBuffer();
  const payload: ImportReservationInput = {
    contractVersion: "deferred-copy-v1",
    source: {
      provider: "mymind",
      accountScope: "synthetic",
      objectId: "one",
      revision: "v1",
      revisionKind: "current",
    },
    metadata: { sha256: hash(metadata), size: metadata.length },
    mapping: {
      title: "Source title",
      note: "Source note",
      tags: ["Source tag"],
      savedAt: "2024-01-02T03:04:05Z",
      sourceUrl: null,
    },
    completeness: "unknown",
    processingPolicy: "deferred",
    storageMode: "copy",
    attachments: [
      {
        slot: "original",
        ordinal: 0,
        role: "original",
        originalName: "misleading.mp4",
        observed: { sha256: hash(original), size: original.length },
        exported: null,
        transport: {},
      },
    ],
  };
  const reserved = await reserveImport(ctx, payload, "import-one");
  id = reserved.operationId;
  await uploadImportMetadata(ctx, id, reserved.fencingToken, metadata);
  await uploadImportFile(
    ctx,
    id,
    "original",
    reserved.fencingToken,
    Readable.from([original]),
  );
  const receipt = await commitImport(ctx, id, reserved.fencingToken);
  bookmarkId = receipt.bookmarkId;
  assetId = receipt.assets[0].assetId;
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
const release = (stage: ImportProcessingStage, retry = false) =>
  releaseImportProcessing(ctx, id, {
    stage,
    retry,
    requestId: randomUUID(),
    expectedGeneration: getImportProcessing(ctx, id)!.generation,
  });
const processing = () => db.select().from(schema.importProcessing).get()!;
const ai = () =>
  db
    .select()
    .from(schema.bookmarks)
    .where(eq(schema.bookmarks.id, bookmarkId))
    .get()!.mediaAi!;
const job = () => ({
  bookmarkId,
  userId: "owner",
  runId: processing().aiRunId!,
});

test("commit remains held; release is owner-scoped, cumulative and idempotent", async () => {
  expect(getImportProcessing(ctx, id)).toMatchObject({
    state: "held",
    generation: 0,
    previewAssetId: null,
  });
  expect(await processNextImport(db, actions)).toBe(false);
  expect(() =>
    getImportProcessing({ ...ctx, user: { id: "other", role: "user" } }, id),
  ).toThrow();
  expect(() =>
    releaseImportProcessing(
      { ...ctx, user: { id: "other", role: "user" } },
      id,
      {
        stage: "catalog",
        retry: false,
        requestId: randomUUID(),
        expectedGeneration: 0,
      },
    ),
  ).toThrow();
  const request = {
    stage: "preview" as const,
    retry: false,
    requestId: randomUUID(),
    expectedGeneration: 0,
  };
  expect(releaseImportProcessing(ctx, id, request)).toEqual(
    releaseImportProcessing(ctx, id, request),
  );
  expect(() => release("search")).toThrow();
  await processNextImport(db, actions);
  expect(() =>
    releaseImportProcessing(ctx, id, { ...request, stage: "catalog" }),
  ).toThrow();
  expect(await processNextImport(db, actions)).toBe(false);
});

test("real preview decodes, reserves dimensions and leaves original/title/tags/metadata unchanged", async () => {
  const before = db.select().from(schema.bookmarks).get();
  const assetsBefore = db.select().from(schema.assets).get();
  release("preview");
  await processNextImport(db, actions);
  expect(processing()).toMatchObject({
    state: "complete",
    previewReady: true,
    searchReady: false,
    originalWidth: 120,
    originalHeight: 80,
  });
  const previewBytes = await readFile(
    path.join(
      directory,
      "assets",
      "owner",
      processing().previewAssetId,
      "asset.bin",
    ),
  );
  expect(await sharp(previewBytes).metadata()).toMatchObject({
    format: "webp",
    width: 120,
    height: 80,
  });
  expect(
    await readFile(
      path.join(directory, "assets", "owner", assetId, "asset.bin"),
    ),
  ).toEqual(original);
  expect(readImportMetadata(ctx, id)).toEqual(metadata);
  expect(db.select().from(schema.bookmarks).get()).toEqual(before);
  expect(
    db.select().from(schema.assets).where(eq(schema.assets.id, assetId)).get(),
  ).toEqual(assetsBefore);
  expect(search).not.toHaveBeenCalled();
  expect(MediaCatalogQueue.enqueue).not.toHaveBeenCalled();
  const card = (await Bookmark.fromId(ctx, bookmarkId, true)).asZBookmark();
  expect(card.importProcessing).toMatchObject({
    previewReady: true,
    state: "complete",
  });
  expect(card.assets.find((a) => a.id === assetId)).toMatchObject({
    width: 120,
    height: 80,
  });
  expect(concealSensitiveBookmark(card, "work")).toBe(true);
  expect(isImportAssetRetained(db, processing().previewAssetId)).toBe(true);
});

test("search-only release publishes once and cannot unlock automatic queues or captioning", async () => {
  release("search");
  await processNextImport(db, actions);
  expect(processing()).toMatchObject({
    state: "complete",
    previewReady: true,
    searchReady: true,
  });
  expect(search).toHaveBeenCalledTimes(1);
  for (const queue of [
    "link_crawler_queue",
    "openai_queue",
    "asset_preprocessing_queue",
    "embeddings_queue",
    "rule_engine_queue",
    "webhook_queue",
    "media_catalog_queue",
  ])
    expect(
      automaticQueueAllowed(db, { bookmarkId, type: "index" }, queue),
    ).toBe(false);
  expect(
    automaticQueueAllowed(
      db,
      { bookmarkId, type: "index" },
      "searching_indexing",
    ),
  ).toBe(true);
  await expect(requestMediaCatalog(db, "owner", bookmarkId)).rejects.toThrow();
  expect(MediaCatalogQueue.enqueue).not.toHaveBeenCalled();
});

test("local-check-only permission never reserves cloud or starts the caption model", async () => {
  release("local_check");
  await processNextImport(db, actions);
  expect(startMediaCatalog(db, job())).not.toBeNull();
  expect(continueMediaCatalog(db, job(), native())).toBe(false);
  expect(ai()).toMatchObject({
    status: "local_review",
    classificationOnly: true,
  });
  expect(db.select().from(schema.mediaAiRequests).all()).toHaveLength(0);
  await processNextImport(db, actions);
  expect(processing().state).toBe("complete");
  expect(
    automaticQueueAllowed(
      db,
      { ...job(), runId: "old" },
      "media_catalog_queue",
    ),
  ).toBe(false);
});

test.each([false, true])(
  "catalog routes sensitive=%s locally; AI tags are additive and source writes remain blocked",
  async (sensitive) => {
    release("catalog");
    await processNextImport(db, actions);
    expect(startMediaCatalog(db, job())).not.toBeNull();
    expect(
      continueMediaCatalog(db, job(), native(sensitive ? ["sexual"] : [])),
    ).toBe(sensitive ? "local" : true);
    expect(db.select().from(schema.mediaAiRequests).all()).toHaveLength(
      sensitive ? 0 : 1,
    );
    const result = {
      title: "AI title",
      summary: "AI summary",
      tags: ["Source tag", "new ai tag"],
    };
    expect(
      finishMediaCatalog(db, job(), "success", result, ["Source tag"]),
    ).toBeTruthy();
    await processNextImport(db, actions);
    expect(processing().state).toBe("complete");
    const card = (await Bookmark.fromId(ctx, bookmarkId, true)).asZBookmark();
    expect(card.title).toBe("Source title");
    expect(card.mediaAi?.result).toEqual(result);
    expect(card.tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Source tag", attachedBy: "human" }),
        expect.objectContaining({ name: "new ai tag", attachedBy: "ai" }),
      ]),
    );
    expect(() =>
      db
        .update(schema.bookmarks)
        .set({ title: "Overwrite" })
        .where(eq(schema.bookmarks.id, bookmarkId))
        .run(),
    ).toThrow();
    expect(() =>
      db
        .update(schema.bookmarks)
        .set({ processingPolicy: "automatic" })
        .where(eq(schema.bookmarks.id, bookmarkId))
        .run(),
    ).toThrow();
    expect(() =>
      db
        .delete(schema.tagsOnBookmarks)
        .where(eq(schema.tagsOnBookmarks.bookmarkId, bookmarkId))
        .run(),
    ).toThrow();
    expect(() =>
      db.delete(schema.assets).where(eq(schema.assets.id, assetId)).run(),
    ).toThrow();
    expect(readImportMetadata(ctx, id)).toEqual(metadata);
  },
);

test("restart resumes a search checkpoint without regenerating the preview or repeating uncertain paid work", async () => {
  release("catalog");
  const failure = {
    ...actions,
    search: vi.fn().mockRejectedValueOnce(new Error("unavailable")),
  };
  await processNextImport(db, failure);
  expect(processing()).toMatchObject({
    state: "failed",
    previewReady: true,
    searchReady: false,
  });
  release("catalog", true);
  await processNextImport(db, actions);
  expect(preview).toHaveBeenCalledTimes(1);
  expect(startMediaCatalog(db, job())).not.toBeNull();
  expect(continueMediaCatalog(db, job(), native())).toBe(true);
  await processNextImport(db, actions);
  await processNextImport(db, actions);
  expect(MediaCatalogQueue.enqueue).toHaveBeenCalledTimes(1);
  expect(db.select().from(schema.mediaAiRequests).all()).toHaveLength(1);
  finishMediaCatalog(db, job(), "timeout");
  await processNextImport(db, actions);
  expect(processing()).toMatchObject({
    state: "failed",
    error: "analysis_paid_result_unconfirmed",
  });
  expect(await processNextImport(db, actions)).toBe(false);
});

test("wrong original bytes and stale controller leases cannot publish previews", async () => {
  release("preview");
  const p = path.join(directory, "assets", "owner", assetId, "asset.bin");
  await writeFile(p, Buffer.alloc(original.length));
  await processNextImport(db, actions);
  expect(processing()).toMatchObject({
    state: "failed",
    error: "original_hash_changed",
    previewReady: false,
  });
  expect(db.select().from(schema.assets).all()).toHaveLength(1);
  await writeFile(p, original);
  release("preview", true);
  await processNextImport(db, {
    ...actions,
    preview: async () => {
      db.update(schema.importProcessing)
        .set({ leaseToken: "replacement", leaseUntil: Date.now() + 60_000 })
        .run();
    },
  });
  expect(processing()).toMatchObject({
    previewReady: false,
    leaseToken: "replacement",
  });
});

test("a failed final search retries publication while retaining the successful paid result", async () => {
  release("catalog");
  await processNextImport(db, actions);
  startMediaCatalog(db, job());
  continueMediaCatalog(db, job(), native());
  finishMediaCatalog(
    db,
    job(),
    "success",
    {
      title: "Generated title",
      summary: "Generated summary",
      tags: ["new tag"],
    },
    ["Source tag"],
  );
  const completedRun = ai().runId;
  await processNextImport(db, {
    ...actions,
    search: async () => {
      throw new Error("search offline");
    },
  });
  expect(processing().state).toBe("failed");
  release("catalog", true);
  await processNextImport(db, actions);
  expect(processing().state).toBe("complete");
  expect(ai().runId).toBe(completedRun);
  expect(MediaCatalogQueue.enqueue).toHaveBeenCalledTimes(1);
  expect(db.select().from(schema.mediaAiRequests).all()).toHaveLength(1);
});

test("unknown local observation fails classification without authorizing any model caption", async () => {
  release("local_check");
  await processNextImport(db, actions);
  startMediaCatalog(db, job());
  expect(continueMediaCatalog(db, job(), native([], "unknown"))).toBe(false);
  await processNextImport(db, actions);
  expect(processing()).toMatchObject({
    state: "failed",
    error: "analysis_local_failed",
  });
  expect(db.select().from(schema.mediaAiRequests).all()).toHaveLength(0);
});

test("ordinary retry never repeats an unconfirmed paid request", async () => {
  release("catalog");
  await processNextImport(db, actions);
  const paidJob = job();
  startMediaCatalog(db, paidJob);
  expect(continueMediaCatalog(db, paidJob, native())).toBeTruthy();
  finishMediaCatalog(db, paidJob, "timeout");
  await processNextImport(db, actions);
  expect(processing()).toMatchObject({
    state: "failed",
    error: "analysis_paid_result_unconfirmed",
    aiRunId: paidJob.runId,
  });
  expect(() => release("catalog", true)).toThrow(/paid attempt/);
  expect(db.select().from(schema.mediaAiRequests).all()).toHaveLength(1);
  expect(MediaCatalogQueue.enqueue).toHaveBeenCalledTimes(1);
});

test("queued import cannot bypass admission after worker configuration changes", async () => {
  release("catalog");
  Object.assign(serverConfig.mediaAi, {
    hybridEnabled: false,
    localMode: "off",
  });
  await processNextImport(db, actions);
  expect(processing().state).toBe("failed");
  expect(MediaCatalogQueue.enqueue).not.toHaveBeenCalled();
  expect(db.select().from(schema.mediaAiRequests).all()).toHaveLength(0);
  Object.assign(serverConfig.mediaAi, {
    hybridEnabled: true,
    localMode: "enforce",
  });
  release("catalog", true);
  await processNextImport(db, actions);
  Object.assign(serverConfig.mediaAi, {
    hybridEnabled: false,
    localMode: "off",
  });
  expect(startMediaCatalog(db, job())).toBeNull();
  expect(["cancelled", "stale"]).toContain(ai().status);
  expect(db.select().from(schema.mediaAiRequests).all()).toHaveLength(0);
});

test("lost local import jobs recover behind interactive work", async () => {
  release("catalog");
  await processNextImport(db, actions);
  const previous = job();
  await recoverLocalMediaCatalog(db, Date.now() + 1_000_000);
  expect(MediaCatalogQueue.enqueue).toHaveBeenLastCalledWith(
    previous,
    expect.objectContaining({ priority: 50 }),
  );
});

test("an expired storage writer cannot overwrite the replacement published preview", async () => {
  await loadAllPlugins();
  const store = (await PluginManager.getClient(PluginType.AssetStore))!;
  const save = store.saveAsset.bind(store);
  let unblock!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let obsoleteId = "";
  vi.spyOn(store, "saveAsset").mockImplementationOnce(async (args) => {
    obsoleteId = args.assetId;
    entered();
    await blocked;
    return save(args);
  });
  release("preview");
  const old = processNextImport(db, actions);
  await started;
  db.update(schema.importProcessing).set({ leaseUntil: 0 }).run();
  await processNextImport(db, actions);
  const current = processing();
  expect(current).toMatchObject({ state: "complete", previewReady: true });
  expect(current.previewAssetId).not.toBe(obsoleteId);
  const published = path.join(
    directory,
    "assets",
    "owner",
    current.previewAssetId,
    "asset.bin",
  );
  const before = await readFile(published);
  unblock();
  await old;
  expect(processing()).toEqual(current);
  expect(await readFile(published)).toEqual(before);
  expect(
    db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.id, obsoleteId))
      .get(),
  ).toBeUndefined();
});

test("late search publication is durably repaired without replaying completed AI", async () => {
  let unblock!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let document = "",
    first = true;
  const steps = {
    ...actions,
    search: async () => {
      const summary = ai()?.result?.summary ?? "source";
      if (first) {
        first = false;
        entered();
        await blocked;
      }
      document = summary;
    },
  };
  release("search");
  const obsolete = processNextImport(db, steps);
  await started;
  db.update(schema.importProcessing).set({ leaseUntil: 0 }).run();
  await processNextImport(db, steps);
  release("catalog");
  await processNextImport(db, steps);
  startMediaCatalog(db, job());
  continueMediaCatalog(db, job(), native());
  finishMediaCatalog(db, job(), "success", {
    title: "AI",
    summary: "Current AI summary",
    tags: ["new"],
  });
  await processNextImport(db, steps);
  expect(document).toBe("Current AI summary");
  unblock();
  await obsolete;
  expect(document).toBe("source");
  expect(processing()).toMatchObject({ state: "complete", searchReady: false });
  await processNextImport(db, steps);
  expect(document).toBe("Current AI summary");
  expect(processing()).toMatchObject({ state: "complete", searchReady: true });
  expect(db.select().from(schema.mediaAiRequests).all()).toHaveLength(1);
  expect(MediaCatalogQueue.enqueue).toHaveBeenCalledTimes(1);
});
