import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import sharp from "sharp";
import { expect, test, vi } from "vitest";
import type { ImportReservationInput } from "@karakeep/shared/types/deferredImport";
import type {
  BookmarkSearchDocument,
  SearchIndexClient,
} from "@karakeep/shared/search";

test("batch worker classifies saved pixels only, preserves originals and does not retry an unknown result", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "karakeep-local-batch-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("ASSETS_DIR", path.join(directory, "assets"));
  vi.stubEnv("NO_COLOR", "true");
  const { db } = await import("@karakeep/db");
  const schema = await import("@karakeep/db/schema");
  const { BookmarkTypes } = await import("@karakeep/shared/types/bookmarks");
  const { default: config } = await import("@karakeep/shared/config");
  const { loadAllPlugins, readAsset } = await import("@karakeep/shared-server");
  const { PluginManager, PluginType } =
    await import("@karakeep/shared/plugins");
  const { getQueueClient } = await import("@karakeep/shared/queueing");
  const { createCallerFactory } = await import("@karakeep/trpc");
  const { appRouter } = await import("@karakeep/trpc/routers/_app");
  const { advanceLocalCheckBatches } =
    await import("@karakeep/trpc/models/importLocalCheckBatches");
  const { recoverLocalMediaCatalog } =
    await import("@karakeep/trpc/models/mediaCatalog");
  const { processNextImport } = await import("./importProcessingWorker");
  const { runMediaCatalog } = await import("./inference/mediaCatalogWorker");
  migrate(db, {
    migrationsFolder: path.resolve(
      import.meta.dirname,
      "../../../packages/db/drizzle",
    ),
  });
  vi.spyOn(config, "mediaAi", "get").mockReturnValue({
    ...config.mediaAi,
    enabled: true,
    hybridEnabled: true,
    localMode: "enforce",
    localUrl: "http://classifier.test/check",
    localToken: "synthetic",
    apiKey: "synthetic",
    model: "synthetic-model",
  });
  await loadAllPlugins();
  await (await getQueueClient()).prepare();
  const indexed = new Map<string, BookmarkSearchDocument>();
  const search: SearchIndexClient = {
    async addDocuments(docs) {
      for (const doc of docs) indexed.set(doc.id, doc);
    },
    async deleteDocuments(ids) {
      for (const id of ids) indexed.delete(id);
    },
    async clearIndex() {
      indexed.clear();
    },
    async search() {
      return {
        hits: [...indexed.keys()].map((id) => ({ id })),
        totalHits: indexed.size,
        processingTimeMs: 0,
      };
    },
  };
  PluginManager.register({
    type: PluginType.Search,
    name: "Batch test search service",
    provider: { getClient: async () => search },
  });
  const calls: string[] = [];
  let unknown = false;
  // Only the external classifier and search service are substituted. The real
  // SQLite queue, API, import controller, ffmpeg and catalog worker run locally.
  vi.stubGlobal("fetch", async (url: URL, options: RequestInit) => {
    calls.push(String(url));
    if (String(url) !== "http://classifier.test/check")
      throw new Error("Unexpected external request");
    expect(
      Buffer.from(JSON.parse(String(options.body)).image, "base64").length,
    ).toBeGreaterThan(0);
    return Response.json({
      model: "google/shieldgemma-2-4b-it",
      revision: "eaf60452b5fc41a911338a022e628b0c15283897",
      policy: "shieldgemma-native-v1",
      precision: "bf16",
      status: unknown ? "unknown" : "complete",
      categories: unknown ? [] : ["sexual"],
      scores: unknown ? null : { dangerous: 0.01, violence: 0.01, sexual: 0.9 },
    });
  });
  try {
    db.insert(schema.users)
      .values({
        id: "owner",
        name: "Owner",
        email: "owner@example.test",
        role: "admin",
      })
      .run();
    const api = createCallerFactory(appRouter)({
      db,
      user: { id: "owner", role: "admin" },
      auth: { type: "session" },
      req: { ip: null },
    });
    const original = await sharp({
      create: { width: 64, height: 48, channels: 3, background: "#abcdef" },
    })
      .png()
      .toBuffer();
    const sha256 = createHash("sha256").update(original).digest("hex");
    const store = (await PluginManager.getClient(PluginType.AssetStore))!;
    for (const id of ["one", "two"]) {
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
          title: "Original title",
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
            originalName: "original.png",
            observed: { sha256, size: original.length },
            exported: null,
            transport: {},
          },
        ],
        processingPolicy: "deferred",
        storageMode: "copy",
      };
      await store.saveAsset({
        userId: "owner",
        assetId: `original-${id}`,
        asset: original,
        metadata: { contentType: "image/png", fileName: "original.png" },
      });
      db.insert(schema.bookmarks)
        .values({
          id,
          userId: "owner",
          type: BookmarkTypes.ASSET,
          title: "Original title",
          processingPolicy: "deferred",
          policyRevision: 1,
        })
        .run();
      db.insert(schema.bookmarkAssets)
        .values({
          id,
          assetId: `original-${id}`,
          assetType: "image",
          fileName: "original.png",
        })
        .run();
      db.insert(schema.assets)
        .values({
          id: `original-${id}`,
          userId: "owner",
          bookmarkId: id,
          assetType: schema.AssetTypes.BOOKMARK_ASSET,
          contentType: "image/png",
          fileName: "original.png",
          size: original.length,
        })
        .run();
      db.insert(schema.importSourceObjects)
        .values({
          id,
          userId: "owner",
          provider: "mymind",
          accountScope: "test",
          objectId: id,
        })
        .run();
      db.insert(schema.importSourceRevisions)
        .values({
          id,
          sourceObjectId: id,
          userId: "owner",
          revision: "1",
          payloadDigest: "a".repeat(64),
          payload,
          state: "committed",
          fencingToken: 1,
          leaseUntil: 0,
          bookmarkId: id,
          receipt: {
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
          },
        })
        .run();
      db.insert(schema.importSourceAttachments)
        .values({
          sourceRevisionId: id,
          slot: "original",
          assetId: `original-${id}`,
          state: "verified",
          detectedMime: "image/png",
          storedSize: original.length,
          storedSha256: sha256,
        })
        .run();
      db.insert(schema.importProcessing)
        .values({
          bookmarkId: id,
          sourceRevisionId: id,
          userId: "owner",
          requestId: randomUUID(),
          stage: "search",
          state: "complete",
          generation: 1,
          policyRevision: 1,
          contentRevision: 1,
          previewAssetId: `preview-${id}`,
          previewReady: true,
          searchReady: true,
          updatedAt: Date.now(),
        })
        .run();
    }
    const batch = await api.deferredImport.prepareLocalCheckBatch({
      requestId: randomUUID(),
      selection: { type: "all" },
    });
    await api.deferredImport.changeLocalCheckBatch({
      id: batch.id,
      action: "start",
    });
    for (const id of ["one", "two"]) {
      unknown = id === "two";
      advanceLocalCheckBatches(db);
      await processNextImport(db);
      const processing = await api.deferredImport.processing({ id });
      expect(processing, JSON.stringify(processing)).toMatchObject({
        stage: "local_check",
        state: "waiting_ai",
      });
      const pending = await api.bookmarks.getBookmark({ bookmarkId: id });
      await runMediaCatalog({
        id,
        data: {
          bookmarkId: id,
          userId: "owner",
          runId: pending.mediaAi!.runId,
        },
        priority: 50,
        runNumber: 1,
        abortSignal: new AbortController().signal,
      });
      // Recovery must not silently repeat an unknown/error outcome after a crash.
      await recoverLocalMediaCatalog(db, Date.now() + 1_200_000);
      await processNextImport(db);
      advanceLocalCheckBatches(db);
    }
    expect(
      await api.deferredImport.localCheckBatch({ id: batch.id }),
    ).toMatchObject({
      status: "complete",
      counts: { complete: 1, failed: 1, ready: 0, released: 0 },
    });
    expect(calls).toEqual([
      "http://classifier.test/check",
      "http://classifier.test/check",
    ]);
    expect(await api.ai.controls()).toMatchObject({ used: 0 });
    const card = await api.bookmarks.getBookmark({ bookmarkId: "one" });
    expect(card).toMatchObject({
      title: "Original title",
      mediaAi: {
        status: "local_review",
        classificationOnly: true,
        localOnly: true,
        localCheck: {
          frames: [{ categories: ["sexual"], status: "complete" }],
        },
      },
    });
    expect(card.mediaAi?.result).toBeUndefined();
    expect(indexed.get("one")?.title).toBe("Original title");
    expect(
      (await readAsset({ userId: "owner", assetId: "original-one" })).asset,
    ).toEqual(original);
  } finally {
    await (await getQueueClient()).shutdown?.();
    db.$client.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
