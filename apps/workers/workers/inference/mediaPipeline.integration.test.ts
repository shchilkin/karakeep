import { expect, test, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import sharp from "sharp";

test("real SQLite queue, asset storage, FFmpeg and local HTTP gate precede the stubbed cloud request", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "local-media-pipeline-"));
  const oldEnvironment = { ...process.env };
  Object.assign(process.env, {
    DATA_DIR: directory,
    MEDIA_AI_ENABLED: "true",
    MEDIA_AI_LOCAL_MODE: "review",
    MEDIA_AI_LOCAL_TOKEN: "synthetic-token",
    MEDIA_AI_API_KEY: "",
  });
  let localCalls = 0;
  let cloudCalls = 0;
  let categories: string[] = [];
  const service = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    expect(request.headers.authorization).toBe("Bearer synthetic-token");
    expect(Object.keys(body)).toEqual(["image"]);
    expect(
      Buffer.from(body.image, "base64").subarray(0, 2).toString("hex"),
    ).toBe("ffd8");
    localCalls++;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        model: "google/shieldgemma-2-4b-it",
        revision: "eaf60452b5fc41a911338a022e628b0c15283897",
        policy: "shieldgemma-native-v1",
        precision: "bf16",
        status: "complete",
        categories,
        scores: {
          dangerous: categories.includes("dangerous") ? 0.9 : 0.01,
          sexual: categories.includes("sexual") ? 0.9 : 0.01,
          violence: categories.includes("violence") ? 0.9 : 0.01,
        },
      }),
    );
  });
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  const address = service.address();
  if (!address || typeof address === "string") throw new Error("missing_port");
  process.env.MEDIA_AI_LOCAL_URL = `http://127.0.0.1:${address.port}/classify`;
  const nativeFetch = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(`http://127.0.0.1:${address.port}/`))
        return nativeFetch(input, init);
      if (url !== "https://api.x.ai/v1/responses")
        throw new Error("Unexpected outbound request blocked by test");
      cloudCalls++;
      return Response.json({
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  title: "Серый квадрат",
                  summary: "Синтетическое изображение.",
                  tags: ["геометрия"],
                }),
              },
            ],
          },
        ],
      });
    }),
  );
  let closeDatabase: (() => void) | undefined;
  try {
    const { db } = await import("@karakeep/db");
    closeDatabase = () => db.$client.close();
    const {
      users,
      bookmarks,
      bookmarkLinks,
      assets,
      AssetTypes,
      mediaAiRequests,
    } = await import("@karakeep/db/schema");
    migrate(db, {
      migrationsFolder: path.resolve("../../packages/db/drizzle"),
    });
    db.insert(users)
      .values({
        id: "qa-owner",
        name: "Synthetic",
        email: "synthetic@example.test",
      })
      .run();
    const { BookmarkTypes } = await import("@karakeep/shared/types/bookmarks");
    db.insert(bookmarks)
      .values({ id: "qa-card", userId: "qa-owner", type: BookmarkTypes.LINK })
      .run();
    db.insert(bookmarkLinks)
      .values({ id: "qa-card", url: "https://example.test/synthetic" })
      .run();
    const { prepareQueue, MediaCatalogQueue, saveAsset, QuotaService } =
      await import("@karakeep/shared-server");
    await prepareQueue();
    const pixels = await sharp({
      create: { width: 64, height: 64, channels: 3, background: "#999999" },
    })
      .jpeg()
      .toBuffer();
    const quotaApproved = await QuotaService.checkStorageQuota(
      db,
      "qa-owner",
      pixels.length,
    );
    await saveAsset({
      userId: "qa-owner",
      assetId: "qa-image",
      asset: pixels,
      metadata: { contentType: "image/jpeg", fileName: "001.jpg" },
      quotaApproved,
    });
    db.insert(assets)
      .values({
        id: "qa-image",
        userId: "qa-owner",
        bookmarkId: "qa-card",
        assetType: AssetTypes.USER_UPLOADED,
        fileName: "001.jpg",
        size: pixels.length,
        contentType: "image/jpeg",
      })
      .run();
    const { default: config } = await import("@karakeep/shared/config");
    const { getQueueClient } = await import("@karakeep/shared/queueing");
    const { runMediaCatalog } = await import("./mediaCatalogWorker");
    const { requestMediaCatalog, catalogSnapshot, recoverLocalMediaCatalog } =
      await import("@karakeep/trpc/models/mediaCatalog");
    await MediaCatalogQueue.ensureInit();
    const runner = (await getQueueClient()).createRunner(
      MediaCatalogQueue,
      { run: runMediaCatalog },
      { concurrency: 1, timeoutSecs: 10 },
    );
    const run = async (retry = false, localOnly = false) => {
      const state = await requestMediaCatalog(db, "qa-owner", "qa-card", {
        retry,
        ...(localOnly ? { localOnly: true, automatic: true } : {}),
      });
      if (state) {
        // A job waiting behind a large batch is repaired with the same key.
        await recoverLocalMediaCatalog(db, Date.now() + 700_000);
        expect((await MediaCatalogQueue.stats()).pending).toBe(1);
        expect(
          catalogSnapshot(db, "qa-owner", "qa-card").bookmark.mediaAi?.runId,
        ).toBe(state.runId);
      }
      await runner.runUntilEmpty!();
      return catalogSnapshot(db, "qa-owner", "qa-card").bookmark.mediaAi;
    };
    expect((await run())?.status).toBe("local_review");
    expect([localCalls, cloudCalls]).toEqual([1, 0]);
    expect(db.select().from(mediaAiRequests).all()).toHaveLength(0);
    Object.assign(config.mediaAi, {
      localMode: "enforce",
      apiKey: "synthetic-cloud-key",
    });
    categories = ["dangerous", "sexual"];
    expect((await run())?.status).toBe("local_only");
    expect(cloudCalls).toBe(0);
    categories = [];
    expect((await run(true))?.status).toBe("success");
    expect([localCalls, cloudCalls]).toEqual([3, 1]);
    expect(db.select().from(mediaAiRequests).all()).toHaveLength(1);
    expect((await run(true))?.status).toBe("success");
    expect([localCalls, cloudCalls]).toEqual([3, 1]);
    expect(
      catalogSnapshot(db, "qa-owner", "qa-card").bookmark.sensitiveCategories,
    ).toBeNull();
    // The same real queue must never promote explicitly local automatic jobs,
    // even with enforce, a cloud key, and a clean native result.
    Object.assign(config.mediaAi, { localAutoNew: true, autoNew: false });
    expect((await run(false, true))?.status).toBe("local_review");
    expect([localCalls, cloudCalls]).toEqual([4, 1]);
    categories = ["sexual"];
    const flagged = await run(true, true);
    const { concealSensitiveBookmark } =
      await import("@karakeep/shared/sensitiveVisibility");
    expect(
      concealSensitiveBookmark({ id: "qa-card", mediaAi: flagged }, "balanced"),
    ).toBe(true);
    expect([localCalls, cloudCalls]).toEqual([5, 1]);
    expect(db.select().from(mediaAiRequests).all()).toHaveLength(1);
    expect(flagged?.result?.title).toBe("Серый квадрат");
    // Additional attachments arriving before the job is claimed invalidate the
    // queued snapshot; the worker must repair it with a new local-only run.
    db.update(assets).set({ fileName: "changed.jpg" }).run();
    const outdated = await requestMediaCatalog(db, "qa-owner", "qa-card", {
      automatic: true,
    });
    expect(outdated?.localOnly).toBe(true);
    db.update(assets).set({ fileName: "changed-again.jpg" }).run();
    await runner.runUntilEmpty!();
    const repaired = catalogSnapshot(db, "qa-owner", "qa-card").bookmark
      .mediaAi;
    expect(repaired?.status).toBe("local_review");
    expect(repaired?.runId).not.toBe(outdated!.runId);
    expect([localCalls, cloudCalls]).toEqual([6, 1]);
    expect(db.select().from(mediaAiRequests).all()).toHaveLength(1);
  } finally {
    vi.unstubAllGlobals();
    service.close();
    service.closeAllConnections();
    closeDatabase?.();
    for (const key of Object.keys(process.env))
      if (!(key in oldEnvironment)) delete process.env[key];
    Object.assign(process.env, oldEnvironment);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
