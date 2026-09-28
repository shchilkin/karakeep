import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import sharp from "sharp";
import { expect, test, vi } from "vitest";
import type { ImportReservationInput } from "@karakeep/shared/types/deferredImport";
import type { BookmarkSearchDocument } from "@karakeep/shared/search";

test("real workers reopen their queue and SQLite, retain pause, and never replay an interrupted or unknown local check", async () => {
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
  const { createCallerFactory } = await import("@karakeep/trpc");
  const { appRouter } = await import("@karakeep/trpc/routers/_app");
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
  const indexed = new Map<string, BookmarkSearchDocument>();
  const calls: string[] = [];
  const unexpected: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    if (request.url === "/index") {
      if (request.method === "GET") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify([...indexed.keys()]));
        return;
      }
      for (const doc of JSON.parse(body) as BookmarkSearchDocument[])
        indexed.set(doc.id, doc);
      response.end("{}");
      return;
    }
    if (request.url !== "/check") {
      unexpected.push(request.url ?? "missing-url");
      response.writeHead(404).end();
      return;
    }
    calls.push(body);
    // The second request stays in flight until its worker is killed. No outcome
    // is delivered: reopening must mark this attempt uncertain, never replay it.
    if (calls.length === 2) return;
    const unknown = calls.length === 3;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        model: "google/shieldgemma-2-4b-it",
        revision: "eaf60452b5fc41a911338a022e628b0c15283897",
        policy: "shieldgemma-native-v1",
        precision: "bf16",
        status: unknown ? "unknown" : "complete",
        categories: unknown ? [] : ["sexual"],
        scores: unknown
          ? null
          : { dangerous: 0.01, violence: 0.01, sexual: 0.9 },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const endpoint = `http://127.0.0.1:${address.port}`;
  let child: ChildProcess | undefined;
  let output = "";
  const start = async (importOnly = false, clockOffset = 0) => {
    output = "";
    child = fork(
      path.join(import.meta.dirname, "fixtures/importLocalCheckProcess.ts"),
      {
        execArgv: ["--import", "tsx"],
        // Deliberate allowlist: never inherit production credentials or .env.
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          TZ: "UTC",
          NO_COLOR: "true",
          DOTENV_CONFIG_PATH: path.join(directory, "absent.env"),
          DATA_DIR: directory,
          ASSETS_DIR: path.join(directory, "assets"),
          MEDIA_AI_ENABLED: "true",
          MEDIA_AI_HYBRID_ENABLED: "true",
          MEDIA_AI_LOCAL_MODE: "enforce",
          MEDIA_AI_LOCAL_URL: `${endpoint}/check`,
          MEDIA_AI_LOCAL_TOKEN: "synthetic",
          MEDIA_AI_API_KEY: "synthetic",
          MEDIA_AI_LOCAL_CATALOG_URL: `${endpoint}/caption`,
          MEDIA_AI_LOCAL_CATALOG_TOKEN: "synthetic",
          TEST_SERVICES_URL: endpoint,
          TEST_IMPORT_ONLY: String(importOnly),
          TEST_CLOCK_OFFSET_MS: String(clockOffset),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    child.stdout?.on("data", (data) => {
      output += String(data);
    });
    child.stderr?.on("data", (data) => {
      output += String(data);
    });
    child.on("message", (message: { type: string; url?: string }) => {
      if (message.type === "unexpected-request") unexpected.push(message.url!);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Worker startup timeout: ${output}`)),
        15_000,
      );
      child!.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Worker exited ${code}/${signal}: ${output}`));
      });
      child!.on("message", (message: { type: string }) => {
        if (message.type === "ready") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  };
  const stop = async (crash = false) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    const timeout = setTimeout(() => child?.kill("SIGKILL"), 5000);
    if (crash) child.kill("SIGKILL");
    else child.send("stop");
    const [code, signal] = await exited;
    clearTimeout(timeout);
    expect({ code, signal }, output).toEqual(
      crash ? { code: null, signal: "SIGKILL" } : { code: 0, signal: null },
    );
  };
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
    for (const id of ["one", "two", "z-three"]) {
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
    await start(true);
    await vi.waitFor(
      async () => {
        expect(
          await api.deferredImport.processing({ id: "one" }),
          output,
        ).toMatchObject({
          stage: "local_check",
          state: "waiting_ai",
        });
      },
      { timeout: 15_000 },
    );
    await api.deferredImport.changeLocalCheckBatch({
      id: batch.id,
      action: "pause",
    });
    await stop();
    expect(calls).toHaveLength(0);
    await start();
    await vi.waitFor(
      async () => {
        const view = await api.deferredImport.localCheckBatch({ id: batch.id });
        expect(
          view,
          JSON.stringify({ view, unexpected, calls: calls.length, output }),
        ).toMatchObject({
          status: "paused",
          counts: { complete: 1, ready: 2, released: 0 },
        });
      },
      { timeout: 15_000 },
    );
    await delay(1500); // Allow another admission poll while paused.
    expect(calls).toHaveLength(1);
    expect(await api.deferredImport.processing({ id: "two" })).toMatchObject({
      stage: "search",
    });

    await api.deferredImport.changeLocalCheckBatch({
      id: batch.id,
      action: "resume",
    });
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 15_000 });
    await stop(true);
    // Real process restart reopens both SQLite files. Advance only wall-clock
    // time so startup recovery sees the expired interrupted attempt immediately.
    await start(false, 1_200_000);
    await vi.waitFor(
      async () => {
        expect(
          await api.deferredImport.localCheckBatch({ id: batch.id }),
          output,
        ).toMatchObject({
          status: "paused",
          counts: { complete: 1, failed: 1, ready: 1, released: 0 },
        });
      },
      { timeout: 15_000 },
    );
    expect(calls).toHaveLength(2);
    await api.deferredImport.changeLocalCheckBatch({
      id: batch.id,
      action: "resume",
    });
    await vi.waitFor(
      async () => {
        const view = await api.deferredImport.localCheckBatch({ id: batch.id });
        expect(
          view,
          JSON.stringify({
            view,
            processing: await api.deferredImport.processing({ id: "z-three" }),
            calls: calls.length,
            unexpected,
            output,
          }),
        ).toMatchObject({
          status: "complete",
          counts: { complete: 1, failed: 2, ready: 0, released: 0 },
        });
      },
      { timeout: 15_000 },
    );
    await stop();
    await start(false, 2_400_000);
    await delay(1500);
    expect(
      await api.deferredImport.localCheckBatch({ id: batch.id }),
    ).toMatchObject({
      status: "complete",
      counts: { complete: 1, failed: 2, ready: 0, released: 0 },
    });
    expect(calls).toHaveLength(3);
    for (const body of calls)
      expect(
        Buffer.from(JSON.parse(body).image, "base64").length,
      ).toBeGreaterThan(0);
    expect(unexpected).toEqual([]);
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
    await stop(true);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.$client.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
