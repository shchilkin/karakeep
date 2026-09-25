import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { Hono } from "hono";
import { beforeAll, afterAll, expect, test, vi } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq, sql } from "drizzle-orm";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { HTTPException } from "hono/http-exception";

const fixture = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const dir = fs.mkdtempSync("/tmp/karakeep-import-http-");
  process.env.DATA_DIR = dir;
  process.env.ASSETS_DIR = dir + "/assets";
  process.env.IMPORT_MAX_FILE_SIZE_MB = "128";
  process.env.IMPORT_IO_TIMEOUT_SEC = "120";
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
import bookmarkRoutes from "./bookmarks";
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
async function nativeImport(
  api: ReturnType<typeof app>,
  type: "link" | "text",
  objectId: string,
) {
  const content =
    type === "link"
      ? { type, url: "https://example.invalid/retained?version=1" }
      : { type, text: "Original text 🌿\n\nSecond paragraph." };
  const input = {
    ...payload,
    source: { ...payload.source, objectId },
    attachments: [],
    content,
    mapping: {
      ...payload.mapping,
      title: "Native source",
      note: "Personal note",
      tags: [" #original "],
    },
  };
  const reserve = await api.request("/api/v1/import/reservations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": objectId,
    },
    body: JSON.stringify(input),
  });
  expect(reserve.status, await reserve.clone().text()).toBe(200);
  const status = await reserve.json();
  const base = `/api/v1/import/reservations/${status.operationId}`;
  expect(status.files).toEqual([]);
  expect(
    (
      await api.request(base + "/metadata", {
        method: "PUT",
        headers: { "X-Import-Fence": String(status.fencingToken) },
        body: metadata,
      })
    ).status,
  ).toBe(200);
  const body = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fencingToken: status.fencingToken }),
  };
  expect((await api.request(base + "/verify", body)).status).toBe(200);
  const committed = await api.request(base + "/commit", body);
  expect(committed.status, await committed.clone().text()).toBe(200);
  const receipt = await committed.json();
  expect(receipt).toMatchObject({
    assets: [],
    processingPolicy: "deferred",
    metadataSize: metadata.length,
  });
  expect(await (await api.request(base + "/commit", body)).json()).toEqual(
    receipt,
  );
  expect(await (await api.request(receipt.metadataUrl)).text()).toBe(
    metadata.toString(),
  );
  const cardResponse = await api.request(
    `/api/v1/bookmarks/${receipt.bookmarkId}`,
  );
  expect(cardResponse.status).toBe(200);
  const card = await cardResponse.json();
  expect(card).toMatchObject({
    title: "Native source",
    note: "Personal note",
    processingPolicy: "deferred",
    importProcessing: { state: "held", generation: 0 },
    content,
  });
  expect(card.tags.map((t: { name: string }) => t.name)).toEqual(["original"]);
  expect(await (await api.request(base + "/processing")).json()).toMatchObject({
    state: "held",
    generation: 0,
  });
  expect(
    (
      await api.request(base + "/release", {
        ...body,
        body: JSON.stringify({
          requestId: randomUUID(),
          stage: "preview",
          expectedGeneration: 0,
        }),
      })
    ).status,
  ).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
  return { receipt, input, base, status };
}
const context: Context = {
  user: { id: "http-owner", role: "user" },
  db,
  auth: {
    type: "apiKey",
    keyId: "importer",
    scopes: ["imports:readwrite", "assets:read", "bookmarks:read"],
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
    .route("/api/v1/bookmarks", bookmarkRoutes)
    .onError((e) => {
      if (e instanceof TRPCError)
        return new Response(e.message, {
          status: getHTTPStatusCodeFromError(e),
        });
      if (e instanceof HTTPException) return e.getResponse();
      throw e;
    });
}
test("native link import retains metadata and its own receipt without crawling or processing release", async () => {
  const api = app();
  const caps = await (await api.request("/api/v1/import/capabilities")).json();
  expect(caps.supportedBookmarkTypes).toEqual(["asset", "link", "text"]);
  await nativeImport(api, "link", "native-link");
});
test("native text is independently retained and changed retries cannot overwrite it", async () => {
  const api = app();
  const { receipt, input, base } = await nativeImport(
    api,
    "text",
    "native-text",
  );
  const reserve = (value: unknown, key: string) =>
    api.request("/api/v1/import/reservations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(value),
    });
  expect(
    (await (await reserve(input, "native-text-another-transport-key")).json())
      .receipt,
  ).toEqual(receipt);
  expect(
    (
      await reserve(
        { ...input, content: { type: "text", text: "Overwritten" } },
        "native-text-conflict",
      )
    ).status,
  ).toBe(409);
  const other = app({
    ...context,
    user: { id: "different-owner", role: "user" },
  });
  expect((await other.request(base)).status).toBe(404);
  expect((await other.request(receipt.metadataUrl)).status).toBe(404);
  const link = await nativeImport(api, "link", "another-native-link");
  const sameUrl = await nativeImport(api, "link", "yet-another-native-link");
  expect(link.receipt.bookmarkId).not.toBe(sameUrl.receipt.bookmarkId);
});
test("Matroska is identified from EBML DocType, never a filename or arbitrary word", async () => {
  const api = app();
  for (const [suffix, bytes, supported] of [
    ["mkv", Buffer.from("1a45dfa38b4282886d6174726f736b61", "hex"), true],
    [
      "fake",
      Buffer.concat([
        Buffer.from("1a45dfa380", "hex"),
        Buffer.from("matroska webm"),
      ]),
      false,
    ],
  ] as const) {
    const input = {
      ...payload,
      source: { ...payload.source, objectId: `ebml-${suffix}` },
      attachments: [
        {
          ...payload.attachments[0],
          originalName: "renamed.bin",
          observed: { sha256: sha(bytes), size: bytes.length },
        },
      ],
    };
    const reserve = await api.request("/api/v1/import/reservations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `ebml-${suffix}`,
      },
      body: JSON.stringify(input),
    });
    expect(reserve.status).toBe(200);
    const status = await reserve.json();
    const base = `/api/v1/import/reservations/${status.operationId}`;
    const headers = { "X-Import-Fence": String(status.fencingToken) };
    await api.request(base + "/metadata", {
      method: "PUT",
      headers,
      body: metadata,
    });
    const upload = await api.request(base + "/files/original", {
      method: "PUT",
      headers,
      body: bytes,
    });
    expect(upload.status).toBe(200);
    const staged = await upload.json();
    expect(staged.files[0].detectedMime).toBe(
      supported ? "video/x-matroska" : null,
    );
    const commit = await api.request(base + "/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fencingToken: status.fencingToken }),
    });
    expect(commit.status).toBe(supported ? 200 : 409);
    if (supported) {
      const receipt = await commit.json();
      expect(
        Buffer.from(
          await (
            await api.request(`/api/v1/assets/${receipt.assets[0].assetId}`)
          ).arrayBuffer(),
        ),
      ).toEqual(bytes);
      expect(
        (
          await (
            await api.request(`/api/v1/bookmarks/${receipt.bookmarkId}`)
          ).json()
        ).content.assetType,
      ).toBe("video");
    }
  }
});
test("native cards reject ordinary edits and stale subtype writers; missing guards disable native admission", async () => {
  const api = app({ ...context, auth: { type: "session" } });
  for (const kind of ["link", "text"] as const) {
    const { receipt } = await nativeImport(api, kind, `retention-${kind}`);
    const cardPath = `/api/v1/bookmarks/${receipt.bookmarkId}`;
    const before = await (await api.request(cardPath)).json();
    expect(
      (
        await api.request(cardPath, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: "Unapproved overwrite" }),
        })
      ).status,
    ).toBe(409);
    expect((await api.request(cardPath, { method: "DELETE" })).status).toBe(
      409,
    );
    // Simulate a stale external writer, then observe the retained card via REST.
    const table =
      kind === "link" ? sql.raw("bookmarkLinks") : sql.raw("bookmarkTexts");
    const column = kind === "link" ? sql.raw("url") : sql.raw("text");
    for (const [query, reason] of [
      [
        sql`UPDATE ${table} SET ${column}='changed' WHERE id=${receipt.bookmarkId}`,
        /immutable/,
      ],
      [sql`DELETE FROM ${table} WHERE id=${receipt.bookmarkId}`, /retained/],
      [
        sql`INSERT OR REPLACE INTO ${table}(id,${column}) VALUES (${receipt.bookmarkId},'replacement')`,
        /cannot be replaced/,
      ],
    ] as const) {
      try {
        db.run(query);
        throw new Error("Unexpected mutation");
      } catch (error) {
        expect(error).toMatchObject({
          cause: { message: expect.stringMatching(reason) },
        });
      }
    }
    expect(await (await api.request(cardPath)).json()).toEqual(before);
  }
  const guard = db.get<{ sql: string }>(
    sql`SELECT sql FROM sqlite_master WHERE name='deferred_text_update'`,
  )!.sql;
  db.run(sql`DROP TRIGGER deferred_text_update`);
  try {
    const caps = await (
      await api.request("/api/v1/import/capabilities")
    ).json();
    expect(caps).toMatchObject({
      materialize: true,
      supportedBookmarkTypes: ["asset"],
    });
    expect(
      (
        await api.request("/api/v1/import/reservations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "missing-native-guard",
          },
          body: JSON.stringify({
            ...payload,
            attachments: [],
            content: { type: "text", text: "Held" },
          }),
        })
      ).status,
    ).toBe(412);
  } finally {
    db.run(sql.raw(guard));
  }
});
test("native input and metadata must be complete, bounded and byte-verified before publication", async () => {
  const api = app();
  const input = {
    ...payload,
    source: { ...payload.source, objectId: "native-validation" },
    attachments: [],
    content: { type: "text", text: "Actual source" },
  };
  const reserve = (value: unknown) =>
    api.request("/api/v1/import/reservations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "native-validation",
      },
      body: JSON.stringify(value),
    });
  for (const invalid of [
    { ...payload, attachments: [] },
    { ...input, attachments: payload.attachments },
    { ...input, content: { type: "link", url: "file:///etc/passwd" } },
    { ...input, content: { type: "text", text: " \n" } },
  ])
    expect((await reserve(invalid)).status).toBe(400);
  expect(
    (
      await reserve({
        ...input,
        source: { ...input.source, revisionKind: "historical" },
      })
    ).status,
  ).toBe(409);
  const status = await (await reserve(input)).json();
  const base = `/api/v1/import/reservations/${status.operationId}`;
  const commit = () =>
    api.request(base + "/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fencingToken: status.fencingToken }),
    });
  expect((await commit()).status).toBe(409);
  const corrupted = Buffer.from(metadata);
  corrupted[0] = 0;
  expect(
    (
      await api.request(base + "/metadata", {
        method: "PUT",
        headers: { "X-Import-Fence": String(status.fencingToken) },
        body: corrupted,
      })
    ).status,
  ).toBe(409);
  expect((await commit()).status).toBe(409);
  expect((await (await api.request(base)).json()).receipt).toBeNull();
});
test("original above 50 MiB is copied and read back but cannot enter the bounded preview worker", async () => {
  const api = app();
  const bytes = Buffer.alloc(51 * 1024 * 1024);
  original.copy(bytes);
  const input = {
    ...payload,
    source: { ...payload.source, objectId: "large-original" },
    attachments: [
      {
        ...payload.attachments[0],
        observed: { sha256: sha(bytes), size: bytes.length },
      },
    ],
  };
  const request = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "large-original",
    },
    body: JSON.stringify(input),
  };
  const reserved = await api.request("/api/v1/import/reservations", request);
  expect(reserved.status).toBe(200);
  const state = await reserved.json();
  const base = `/api/v1/import/reservations/${state.operationId}`;
  const headers = { "X-Import-Fence": String(state.fencingToken) };
  expect(
    (
      await api.request(base + "/metadata", {
        method: "PUT",
        headers,
        body: metadata,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await api.request(base + "/files/original", {
        method: "PUT",
        headers,
        body: bytes,
      })
    ).status,
  ).toBe(200);
  const committed = await api.request(base + "/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fencingToken: state.fencingToken }),
  });
  expect(committed.status).toBe(200);
  const receipt = await committed.json();
  const downloaded = await api.request(
    `/api/v1/assets/${receipt.assets[0].assetId}`,
  );
  const recovered = Buffer.from(await downloaded.arrayBuffer());
  expect(recovered.length).toBe(53477376);
  expect(sha(recovered)).toBe(sha(bytes));
  const oldLimits = serverConfig.importLimits;
  Object.assign(serverConfig, {
    importLimits: { ...oldLimits, maxFileBytes: 1048576 },
  });
  try {
    expect(
      (await (await api.request("/api/v1/import/reservations", request)).json())
        .receipt,
    ).toEqual(receipt);
  } finally {
    Object.assign(serverConfig, { importLimits: oldLimits });
  }
  const release = await api.request(base + "/release", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: randomUUID(),
      stage: "preview",
      expectedGeneration: 0,
    }),
  });
  expect(release.status).toBe(400);
  expect(await (await api.request(base + "/processing")).json()).toMatchObject({
    state: "held",
    generation: 0,
  });
});
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
test("configured import limits admit larger reservations but reject bytes above the advertised cap", async () => {
  const api = app();
  const caps = await (await api.request("/api/v1/import/capabilities")).json();
  expect(caps).toMatchObject({
    maxFileBytes: 134217728,
    ioTimeoutSeconds: 120,
  });
  for (const [size, status] of [
    [83886080, 200],
    [134217729, 413],
  ]) {
    const result = await api.request("/api/v1/import/reservations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `sized-${size}`,
      },
      body: JSON.stringify({
        ...payload,
        source: { ...payload.source, objectId: `sized-${size}` },
        attachments: [
          {
            ...payload.attachments[0],
            observed: { sha256: sha(original), size },
          },
        ],
      }),
    });
    expect(result.status, await result.clone().text()).toBe(status);
  }
});
test("busy original I/O returns retryable HTTP 429 and preserves the reserved operation", async () => {
  const api = app();
  const before = db.select().from(bookmarks).all().length;
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
  expect(db.select().from(bookmarks).all()).toHaveLength(before);
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
  expect(
    db
      .select()
      .from(bookmarks)
      .where(eq(bookmarks.id, receipt.bookmarkId))
      .all(),
  ).toHaveLength(1);
  expect(
    db
      .select()
      .from(processingOutbox)
      .where(eq(processingOutbox.bookmarkId, receipt.bookmarkId))
      .all(),
  ).toMatchObject([{ state: "held" }]);
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
