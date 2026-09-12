import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openSqliteDatabase } from "@karakeep/db/sqlite";
import * as schema from "@karakeep/db/schema";
import serverConfig from "@karakeep/shared/config";
import { guardQueueRunner } from "@karakeep/shared/queueing";
import type { Queue, DequeuedJob } from "@karakeep/shared/queueing";
import type { ImportReservationInput } from "@karakeep/shared/types/deferredImport";
import {
  automaticQueueAllowed,
  isImportAssetRetained,
} from "@karakeep/shared-server";
import {
  commitImport,
  importStatus,
  readImportMetadata,
  reserveImport,
  uploadImportFile,
  uploadImportMetadata,
  verifyImport,
} from "../models/deferredImport";
import { getApiCaller, getTestQueueMocks } from "../testUtils";
import type { AuthedContext } from "..";

const directory = `/tmp/karakeep-deferred-import-${crypto.randomUUID()}`;
const original = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/rN8AAAAASUVORK5CYII=",
  "base64",
);
const raw = Buffer.from(
  '{\n  "title": "Source 🌿", "not_exported": ["collections"], "custom": {"value":42}\n}\n',
);
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
let sqlite: ReturnType<typeof openSqliteDatabase>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let ctx: AuthedContext;
function openDB() {
  sqlite = openSqliteDatabase(path.join(directory, "import.sqlite"), {
    readOnly: false,
    walMode: true,
  });
  db = drizzle(sqlite, { schema });
  ctx = {
    db,
    user: { id: "owner", role: "user" },
    auth: { type: "session" },
    req: { ip: null },
  };
}
function payload(
  objectId = "object-one",
  data = original,
): ImportReservationInput {
  return {
    contractVersion: "deferred-copy-v1",
    source: {
      provider: "mymind",
      accountScope: "synthetic",
      objectId,
      revision: "current-revision-1",
      revisionKind: "current",
    },
    metadata: { sha256: sha(raw), size: raw.length },
    mapping: {
      title: "Original source title",
      note: "Preserve the source note.",
      sourceUrl: "https://example.test/same-url",
      savedAt: "2024-01-02T03:04:05.743900Z",
      tags: [" ##Source tag ", "Source tag"],
    },
    completeness: "unknown",
    attachments: [
      {
        slot: "original",
        ordinal: 0,
        role: "original",
        originalName: "export.json",
        observed: { sha256: sha(data), size: data.length },
        exported: { sha256: sha(data), size: data.length },
        transport: { fileid: "synthetic-file", etag: "synthetic-etag" },
      },
    ],
    processingPolicy: "deferred",
    storageMode: "copy",
  };
}
beforeEach(async () => {
  await mkdir(directory, { recursive: true });
  vi.spyOn(serverConfig, "dataDir", "get").mockReturnValue(directory);
  vi.spyOn(serverConfig, "assetsDir", "get").mockReturnValue(
    path.join(directory, "assets"),
  );
  openDB();
  migrate(db, { migrationsFolder: path.resolve("../db/drizzle") });
  db.insert(schema.users)
    .values([
      { id: "owner", name: "Owner", email: "owner@example.test" },
      { id: "other", name: "Other", email: "other@example.test" },
    ])
    .run();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected external request");
    }),
  );
  Object.values(getTestQueueMocks()).forEach((mock) => mock.mockClear());
});
afterEach(async () => {
  sqlite.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
async function staged(input = payload(), key = "stable-key") {
  const result = await reserveImport(ctx, input, key);
  await uploadImportMetadata(ctx, result.operationId, result.fencingToken, raw);
  await uploadImportFile(
    ctx,
    result.operationId,
    "original",
    result.fencingToken,
    Readable.from([original]),
  );
  return result;
}
test("actual original and raw metadata survive atomic copy commit; source retries retain one receipt", async () => {
  const input = payload();
  const [a, b] = await Promise.all([
    reserveImport(ctx, input, "key-one"),
    reserveImport(ctx, input, "key-two"),
  ]);
  expect(a.operationId).toBe(b.operationId);
  await uploadImportMetadata(ctx, a.operationId, a.fencingToken, raw);
  await uploadImportFile(
    ctx,
    a.operationId,
    "original",
    a.fencingToken,
    Readable.from([original]),
  );
  expect((await verifyImport(ctx, a.operationId, a.fencingToken)).state).toBe(
    "verified",
  );
  const receipt = await commitImport(ctx, a.operationId, a.fencingToken);
  expect(await commitImport(ctx, a.operationId, a.fencingToken)).toEqual(
    receipt,
  );
  const api = getApiCaller(db, "owner");
  expect(
    await api.deferredImport.commit({
      id: a.operationId,
      fencingToken: a.fencingToken,
    }),
  ).toEqual(receipt);
  const card = await api.bookmarks.getBookmark({
    bookmarkId: receipt.bookmarkId,
  });
  expect(card).toMatchObject({
    processingPolicy: "deferred",
    note: input.mapping.note,
    title: input.mapping.title,
    taggingStatus: null,
    summary: null,
    sensitiveCategories: null,
  });
  expect(card.tags.map((t) => t.name)).toEqual(["Source tag"]);
  expect(card.createdAt.toISOString()).toBe("2024-01-02T03:04:05.000Z");
  expect(card.content).toMatchObject({
    type: "asset",
    assetType: "image",
    sourceUrl: input.mapping.sourceUrl,
    fileName: "export.json",
  });
  expect(readImportMetadata(ctx, a.operationId)).toEqual(raw);
  expect(
    await readFile(
      path.join(
        serverConfig.assetsDir,
        "owner",
        receipt.assets[0].assetId,
        "asset.bin",
      ),
    ),
  ).toEqual(original);
  expect(db.select().from(schema.processingOutbox).all()).toMatchObject([
    { state: "held", kind: "import.committed" },
  ]);
  expect(db.select().from(schema.bookmarks).all()).toHaveLength(1);
  Object.values(getTestQueueMocks()).forEach((mock) =>
    expect(mock).not.toHaveBeenCalled(),
  );
  expect(fetch).not.toHaveBeenCalled();
  const next = await staged(payload("different-source"), "another-key");
  const second = await commitImport(ctx, next.operationId, next.fencingToken);
  expect(second.assets[0].assetId).not.toBe(receipt.assets[0].assetId);
  expect((await api.duplicates.list({})).groups).toMatchObject([
    { files: 2, cards: 2 },
  ]);
  expect(db.select().from(schema.bookmarks).all()).toHaveLength(2);
});
test("conflicting source/key, incomplete uploads, and other owners fail closed", async () => {
  const input = payload();
  const item = await reserveImport(ctx, input, "key");
  const changed = {
    ...input,
    mapping: { ...input.mapping, note: "different" },
  };
  await expect(reserveImport(ctx, changed, "key")).rejects.toThrow(
    /different payload/,
  );
  await expect(reserveImport(ctx, changed, "another-key")).rejects.toThrow(
    /different payload/,
  );
  await expect(
    commitImport(ctx, item.operationId, item.fencingToken),
  ).rejects.toThrow(/incomplete/);
  const other = { ...ctx, user: { id: "other", role: "user" as const } };
  expect(() => importStatus(other, item.operationId)).toThrow();
  await expect(
    uploadImportMetadata(other, item.operationId, item.fencingToken, raw),
  ).rejects.toThrow();
  const read = getApiCaller(db, "owner", undefined, "user", {
    type: "apiKey",
    keyId: "reader",
    scopes: ["imports:read"],
  }).deferredImport;
  expect((await read.status({ id: item.operationId })).operationId).toBe(
    item.operationId,
  );
  await expect(
    read.commit({ id: item.operationId, fencingToken: item.fencingToken }),
  ).rejects.toThrow(/scope/);
  await expect(
    getApiCaller(db).deferredImport.capabilities(),
  ).rejects.toThrow();
});
test("unrecognized bytes and historical mismatches are retained as holds without a fake representation", async () => {
  const unsupported = Buffer.from('{"actual":"text, not a picture"}');
  const input = payload("unsupported", unsupported);
  const item = await reserveImport(ctx, input, "unsupported");
  await uploadImportMetadata(ctx, item.operationId, item.fencingToken, raw);
  const result = await uploadImportFile(
    ctx,
    item.operationId,
    "original",
    item.fencingToken,
    Readable.from([unsupported]),
  );
  expect(result.state).toBe("hold");
  expect(result.files[0].detectedMime).toBeNull();
  await expect(
    commitImport(ctx, item.operationId, item.fencingToken),
  ).rejects.toThrow(/held/);
  const mismatch = payload("mismatch");
  mismatch.attachments[0].exported = {
    sha256: "0".repeat(64),
    size: original.length,
  };
  const second = await staged(mismatch, "mismatch");
  expect(importStatus(ctx, second.operationId).state).toBe("hold");
  await expect(
    commitImport(ctx, second.operationId, second.fencingToken),
  ).rejects.toThrow(/held/);
  expect(db.select().from(schema.bookmarks).all()).toHaveLength(0);
  expect(readImportMetadata(ctx, item.operationId)).toEqual(raw);
});
test("restart and expired lease recover staged bytes; stale fence cannot publish", async () => {
  const input = payload();
  const item = await staged(input);
  db.update(schema.importSourceRevisions)
    .set({ leaseUntil: Date.now() - 1 })
    .where(eq(schema.importSourceRevisions.id, item.operationId))
    .run();
  sqlite.close();
  openDB();
  const renewed = await reserveImport(ctx, input, "stable-key");
  expect(renewed.fencingToken).toBe(item.fencingToken + 1);
  await expect(
    commitImport(ctx, item.operationId, item.fencingToken),
  ).rejects.toThrow(/lease expired/);
  const receipt = await commitImport(
    ctx,
    item.operationId,
    renewed.fencingToken,
  );
  expect(receipt.assets[0].storedSha256).toBe(sha(original));
  sqlite.close();
  openDB();
  expect(
    await commitImport(ctx, item.operationId, renewed.fencingToken),
  ).toEqual(receipt);
  expect(readImportMetadata(ctx, item.operationId)).toEqual(raw);
});
test("failure after target promotion retries the same retained target without another occurrence", async () => {
  const item = await staged();
  sqlite.exec(
    "CREATE TRIGGER synthetic_crash BEFORE INSERT ON bookmarks BEGIN SELECT RAISE(ABORT, 'synthetic crash'); END;",
  );
  await expect(
    commitImport(ctx, item.operationId, item.fencingToken),
  ).rejects.toThrow(/synthetic crash/);
  expect(db.select().from(schema.bookmarks).all()).toHaveLength(0);
  const file = db.select().from(schema.importSourceAttachments).get()!;
  expect(isImportAssetRetained(db, file.assetId)).toBe(true);
  expect(
    await readFile(
      path.join(serverConfig.assetsDir, "owner", file.assetId, "asset.bin"),
    ),
  ).toEqual(original);
  sqlite.exec("DROP TRIGGER synthetic_crash");
  sqlite.close();
  openDB();
  const receipt = await commitImport(ctx, item.operationId, item.fencingToken);
  expect(receipt.assets[0].assetId).toBe(file.assetId);
  expect(db.select().from(schema.assets).all()).toHaveLength(1);
});
test("corrupted target and stale worker apply cannot mutate an imported snapshot", async () => {
  const item = await staged();
  const file = db.select().from(schema.importSourceAttachments).get()!;
  const target = path.join(serverConfig.assetsDir, "owner", file.assetId);
  await mkdir(target, { recursive: true });
  await writeFile(
    path.join(target, "asset.bin"),
    Buffer.alloc(original.length),
  );
  await writeFile(
    path.join(target, "metadata.json"),
    JSON.stringify({ contentType: "image/png", fileName: "export.json" }),
  );
  await expect(
    commitImport(ctx, item.operationId, item.fencingToken),
  ).rejects.toThrow(/readback failed/);
  expect(db.select().from(schema.bookmarks).all()).toHaveLength(0);
  // Repair only the synthetic corruption, then exercise the actual published guards.
  await writeFile(path.join(target, "asset.bin"), original);
  const receipt = await commitImport(ctx, item.operationId, item.fencingToken);
  await expect(
    getApiCaller(db, "owner").bookmarks.updateBookmark({
      bookmarkId: receipt.bookmarkId,
      note: "stale overwrite",
    }),
  ).rejects.toThrow(/immutable/);
  expect(() =>
    db
      .update(schema.bookmarks)
      .set({ summary: "stale AI result" })
      .where(eq(schema.bookmarks.id, receipt.bookmarkId))
      .run(),
  ).toThrow(/immutable/);
  expect(() =>
    db.delete(schema.assets).where(eq(schema.assets.id, file.assetId)).run(),
  ).toThrow(/retained/);
  const queue: Queue<{ bookmarkId: string }> = {
    name: () => "synthetic",
    opts: { defaultJobArgs: { numRetries: 1 }, keepFailedJobs: false },
    ensureInit: async () => undefined,
    enqueue: async () => undefined,
    stats: async () => ({
      pending: 0,
      pending_retry: 0,
      running: 0,
      failed: 0,
    }),
    shouldRun: async (data) => automaticQueueAllowed(db, data),
  };
  const run = vi.fn(async () => {
    await fetch("https://unexpected.example.test");
  });
  const complete = vi.fn();
  const error = vi.fn();
  const guarded = guardQueueRunner(queue, {
    run,
    onComplete: complete,
    onError: error,
  });
  const job: DequeuedJob<{ bookmarkId: string }> = {
    id: "old-job",
    data: { bookmarkId: receipt.bookmarkId },
    priority: 0,
    runNumber: 1,
    abortSignal: new AbortController().signal,
  };
  const result = await guarded.run(job);
  expect(result.skipped).toBe(true);
  await guarded.onComplete!(job, result);
  await guarded.onError!({
    ...job,
    numRetriesLeft: 0,
    error: new Error("old failure"),
  });
  expect(run).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test("two independent database connections converge on one commit after a busy response", async () => {
  const item = await staged();
  const secondSqlite = openSqliteDatabase(
    path.join(directory, "import.sqlite"),
    { readOnly: false, walMode: true },
  );
  const otherConnection = { ...ctx, db: drizzle(secondSqlite, { schema }) };
  try {
    const results = await Promise.allSettled([
      commitImport(ctx, item.operationId, item.fencingToken),
      commitImport(otherConnection, item.operationId, item.fencingToken),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const one = await commitImport(ctx, item.operationId, item.fencingToken);
    const two = await commitImport(
      otherConnection,
      item.operationId,
      item.fencingToken,
    );
    expect(two).toEqual(one);
    expect(db.select().from(schema.bookmarks).all()).toHaveLength(1);
    const lookup = await getApiCaller(db, "other").deferredImport.lookup(
      payload(),
    );
    expect(lookup).toMatchObject({
      sourceMatch: "new_source",
      operationId: null,
      contentMatches: [],
    });
  } finally {
    secondSqlite.close();
  }
});

test("missing policy barriers disable materialization and over-limit streams cannot publish", async () => {
  const api = getApiCaller(db, "owner").deferredImport;
  const item = await reserveImport(ctx, payload(), "bounded");
  await expect(
    uploadImportFile(
      ctx,
      item.operationId,
      "original",
      item.fencingToken,
      Readable.from([original, Buffer.from("excess")]),
    ),
  ).rejects.toThrow(/byte limit/);
  expect(importStatus(ctx, item.operationId).files[0].state).toBe("pending");
  sqlite.exec("DROP TRIGGER deferred_bookmark_update");
  expect(await api.capabilities()).toMatchObject({
    materialize: false,
    persistentDeferred: false,
  });
  await expect(
    reserveImport(ctx, payload("blocked"), "blocked"),
  ).rejects.toThrow(/policy migrations/);
  expect(db.select().from(schema.bookmarks).all()).toHaveLength(0);
});
