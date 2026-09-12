import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { Hono } from "hono";
import { beforeAll, afterAll, expect, test, vi } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { HTTPException } from "hono/http-exception";

const fixture = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const dir = fs.mkdtempSync("/tmp/karakeep-import-http-");
  process.env.DATA_DIR = dir;
  process.env.ASSETS_DIR = dir + "/assets";
  return { dir };
});
import { db } from "@karakeep/db";
import serverConfig from "@karakeep/shared/config";
import {
  users,
  bookmarks,
  processingOutbox,
  assetHashScanLease,
} from "@karakeep/db/schema";
import type { Context } from "@karakeep/trpc";
import imports from "./deferredImport";
import assets from "./assets";
import {
  deleteAsset,
  LinkCrawlerQueue,
  OpenAIQueue,
  EmbeddingsQueue,
  AssetPreprocessingQueue,
  WebhookQueue,
  MediaCatalogQueue,
  SearchIndexingQueue,
  RuleEngineQueue,
  VideoWorkerQueue,
} from "@karakeep/shared-server";
const sha = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const original = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/rN8AAAAASUVORK5CYII=",
  "base64",
);
const metadata = Buffer.from(
  '{\n "objectId":"http-object", "sourceFields":{"notes":"not_exported"}, "custom":"🌿"\n}\n',
);
const payload = {
  contractVersion: "deferred-copy-v1",
  source: {
    provider: "synthetic",
    accountScope: "http",
    objectId: "http-object",
    revision: "v1",
    revisionKind: "current",
  },
  metadata: { sha256: sha(metadata), size: metadata.length },
  mapping: {
    title: "HTTP imported original",
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
      originalName: "renamed.json",
      observed: { sha256: sha(original), size: original.length },
      exported: null,
      transport: { fileid: "http-test" },
    },
  ],
  processingPolicy: "deferred",
  storageMode: "copy",
};
const context: Context = {
  user: { id: "http-owner", role: "user" },
  db,
  auth: {
    type: "apiKey",
    keyId: "importer",
    scopes: ["imports:readwrite", "assets:read"],
  },
  req: { ip: null },
};
function app(ctx = context) {
  return new Hono<{ Variables: { ctx: Context } }>()
    .use(async (c, next) => {
      c.set("ctx", ctx);
      await next();
    })
    .route("/api/v1/import", imports)
    .route("/api/v1/assets", assets)
    .onError((e) => {
      if (e instanceof TRPCError)
        return new Response(e.message, {
          status: getHTTPStatusCodeFromError(e),
        });
      if (e instanceof HTTPException) return e.getResponse();
      throw e;
    });
}
beforeAll(() => {
  migrate(db, { migrationsFolder: path.resolve("../db/drizzle") });
  db.insert(users)
    .values({ id: "http-owner", name: "HTTP QA", email: "http@example.test" })
    .run();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected egress");
    }),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await rm(fixture.dir, { recursive: true, force: true });
});
test("busy original I/O returns retryable HTTP 429 and preserves the reserved operation", async () => {
  const api = app();
  const reserved = await api.request("/api/v1/import/reservations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "busy-http-key",
    },
    body: JSON.stringify({
      ...payload,
      source: { ...payload.source, objectId: "busy-http-object" },
    }),
  });
  expect(reserved.status).toBe(200);
  const item = await reserved.json();
  const endpoint = `/api/v1/import/reservations/${item.operationId}/metadata`;
  const upload = () =>
    api.request(endpoint, {
      method: "PUT",
      headers: { "X-Import-Fence": String(item.fencingToken) },
      body: metadata,
    });
  db.insert(assetHashScanLease)
    .values({ id: 1, token: "synthetic-busy", expiresAt: Date.now() + 60_000 })
    .run();
  try {
    expect((await upload()).status).toBe(429);
    const status = await api.request(
      `/api/v1/import/reservations/${item.operationId}`,
    );
    expect(await status.json()).toMatchObject({
      operationId: item.operationId,
      state: "reserved",
      fencingToken: item.fencingToken,
    });
  } finally {
    db.delete(assetHashScanLease)
      .where(eq(assetHashScanLease.token, "synthetic-busy"))
      .run();
  }
  expect((await upload()).status).toBe(200);
  expect(db.select().from(bookmarks).all()).toHaveLength(0);
});
test("real REST streaming upload, commit and authenticated full target+metadata readback", async () => {
  const api = app();
  const caps = await api.request("/api/v1/import/capabilities");
  expect(caps.status).toBe(200);
  expect(await caps.json()).toMatchObject({
    contractVersion: "deferred-copy-v1",
    materialize: true,
    stagePermits: true,
  });
  const reserve = await api.request("/api/v1/import/reservations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "stable-http-key",
    },
    body: JSON.stringify(payload),
  });
  expect(reserve.status).toBe(200);
  const item = await reserve.json();
  const headers = {
    "X-Import-Fence": String(item.fencingToken),
    "Content-Type": "application/octet-stream",
  };
  const raw = await api.request(
    `/api/v1/import/reservations/${item.operationId}/metadata`,
    { method: "PUT", headers, body: metadata },
  );
  expect(raw.status).toBe(200);
  const file = await api.request(
    `/api/v1/import/reservations/${item.operationId}/files/original`,
    { method: "PUT", headers, body: original },
  );
  expect(file.status).toBe(200);
  const committed = await api.request(
    `/api/v1/import/reservations/${item.operationId}/commit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fencingToken: item.fencingToken }),
    },
  );
  expect(committed.status, await committed.clone().text()).toBe(200);
  const receipt = await committed.json();
  const downloaded = await api.request(
    `/api/v1/assets/${receipt.assets[0].assetId}`,
  );
  expect(downloaded.status).toBe(200);
  expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(original);
  const downloadedMetadata = await api.request(receipt.metadataUrl);
  expect(downloadedMetadata.status).toBe(200);
  expect(Buffer.from(await downloadedMetadata.arrayBuffer())).toEqual(metadata);
  expect(
    (
      await api.request(
        `/api/v1/assets/${receipt.assets[0].assetId}/thumbnail?width=640`,
      )
    ).status,
  ).toBe(409);
  await expect(
    deleteAsset({ userId: "http-owner", assetId: receipt.assets[0].assetId }),
  ).rejects.toThrow(/retained/);
  expect(
    (await api.request(`/api/v1/assets/${receipt.assets[0].assetId}`)).status,
  ).toBe(200);
  const retry = await api.request("/api/v1/import/reservations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "stable-http-key",
    },
    body: JSON.stringify(payload),
  });
  expect((await retry.json()).receipt).toEqual(receipt);
  expect(db.select().from(bookmarks).all()).toHaveLength(1);
  expect(db.select().from(processingOutbox).all()).toMatchObject([
    { state: "held" },
  ]);
  const bookmarkId = receipt.bookmarkId;
  const skipped = await Promise.all([
    LinkCrawlerQueue.enqueue({ bookmarkId }),
    OpenAIQueue.enqueue({ bookmarkId, type: "tag" }),
    EmbeddingsQueue.enqueue({
      bookmarkId,
      type: "embed",
      runTaggingOnComplete: true,
    }),
    AssetPreprocessingQueue.enqueue({ bookmarkId, fixMode: false }),
    WebhookQueue.enqueue({ bookmarkId, operation: "created" }),
    MediaCatalogQueue.enqueue({
      bookmarkId,
      userId: "http-owner",
      runId: "stale",
    }),
    SearchIndexingQueue.enqueue({ bookmarkId, type: "index" }),
    RuleEngineQueue.enqueue({ bookmarkId, events: [] }),
    VideoWorkerQueue.enqueue({
      bookmarkId,
      url: "https://unexpected.example.test/video",
    }),
  ]);
  expect(skipped).toEqual(Array(9).fill(undefined));
  expect(fetch).not.toHaveBeenCalled();
  const other = app({
    ...context,
    user: { id: "different-owner", role: "user" },
  });
  expect((await other.request(receipt.metadataUrl)).status).toBe(404);
  expect(
    (
      await app({ ...context, user: null }).request(
        "/api/v1/import/capabilities",
      )
    ).status,
  ).toBe(401);
  const processingUrl = `/api/v1/import/reservations/${item.operationId}/processing`;
  const releaseUrl = `/api/v1/import/reservations/${item.operationId}/release`;
  expect(await (await api.request(processingUrl)).json()).toMatchObject({
    state: "held",
    generation: 0,
  });
  expect((await other.request(processingUrl)).status).toBe(404);
  const release = {
    requestId: randomUUID(),
    stage: "preview",
    expectedGeneration: 0,
  };
  const request = (client: ReturnType<typeof app>, body = release) =>
    client.request(releaseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await request(other)).status).toBe(404);
  expect((await request(app({ ...context, user: null }))).status).toBe(401);
  expect(
    (
      await request(
        app({
          ...context,
          auth: {
            type: "apiKey",
            keyId: "read-only",
            scopes: ["imports:read"],
          },
        }),
      )
    ).status,
  ).toBe(403);
  const degraded = serverConfig.degradedMode;
  Object.assign(serverConfig, { degradedMode: true });
  try {
    expect((await request(api)).status).toBe(403);
  } finally {
    Object.assign(serverConfig, { degradedMode: degraded });
  }
  const accepted = await request(api);
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  const view = await accepted.json();
  expect(view).toMatchObject({
    state: "queued",
    generation: 1,
    stage: "preview",
  });
  expect(await (await request(api)).json()).toEqual(view);
  expect(
    (await request(api, { ...release, requestId: randomUUID() })).status,
  ).toBe(409);
  expect(fetch).not.toHaveBeenCalled();
});
