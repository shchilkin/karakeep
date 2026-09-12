import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  statfs,
} from "node:fs/promises";
import path from "node:path";
import { normalizeTagName } from "@karakeep/shared/utils/tag";
import { Readable } from "node:stream";
import { TRPCError } from "@trpc/server";
import { and, eq, ne, sql } from "drizzle-orm";
import type { KarakeepDBTransaction } from "@karakeep/db";
import {
  assets,
  assetContentHashes,
  assetHashScanLease,
  AssetTypes,
  bookmarks,
  bookmarkAssets,
  bookmarkTags,
  tagsOnBookmarks,
  duplicateGroups,
  importSourceObjects,
  importSourceRevisions,
  importReservations,
  importSourceAttachments,
  processingOutbox,
  importProcessing,
  users,
} from "@karakeep/db/schema";
import serverConfig from "@karakeep/shared/config";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import {
  IMPORT_CONTRACT_VERSION,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_METADATA_BYTES,
  zImportReservation,
} from "@karakeep/shared/types/deferredImport";
import type {
  ImportReceipt,
  ImportReservationInput,
} from "@karakeep/shared/types/deferredImport";
import type { AuthedContext } from "..";

const LEASE_MS = 120_000;
const IO_LEASE_MS = 60_000;
const IO_TIMEOUT_MS = 20_000;
const MIMES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
];
function conflict(message: string): never {
  throw new TRPCError({ code: "CONFLICT", message });
}
export function canonicalImportJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalImportJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalImportJson((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
const digest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export function importCapabilities(ctx: AuthedContext) {
  const guards =
    ctx.db.get<{ total: number }>(
      sql`SELECT count(*) AS total FROM sqlite_master WHERE type = 'trigger' AND name IN ('deferred_bookmark_update','deferred_bookmark_delete','deferred_asset_update','retained_import_asset_delete','deferred_asset_subtype_update','deferred_list_attachment','deferred_tag_attachment','deferred_tag_delete','deferred_tag_update','deferred_tag_name_update','retained_import_user_delete')`,
    )?.total === 11;
  return {
    contractVersion: IMPORT_CONTRACT_VERSION,
    storageMode: "copy" as const,
    physicalReuse: false,
    persistentDeferred: guards,
    materialize: guards && serverConfig.assetStore.type === "filesystem",
    maxAttachments: 1,
    maxFileBytes: MAX_IMPORT_FILE_BYTES,
    maxMetadataBytes: MAX_IMPORT_METADATA_BYTES,
    supportedMimeTypes: MIMES,
    stagePermits: guards,
    processingStages: ["preview", "search", "local_check", "catalog"],
    processingMimeTypes: MIMES.filter((mime) => mime.startsWith("image/")),
    historicalResolution: false,
  };
}
function requireStorage(ctx: AuthedContext) {
  if (!importCapabilities(ctx).materialize)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "The deferred copy pilot requires the filesystem asset store and all policy migrations.",
    });
}
function stageRoot(id: string) {
  return path.join(serverConfig.dataDir, "import-staging", id);
}
function targetRoot(userId: string, assetId: string) {
  if (![userId, assetId].every((x) => /^[a-zA-Z0-9_-]{1,128}$/.test(x)))
    conflict("Unsupported storage identity.");
  return path.join(serverConfig.assetsDir, userId, assetId);
}
function revision(ctx: AuthedContext, id: string) {
  const row = ctx.db
    .select()
    .from(importSourceRevisions)
    .where(
      and(
        eq(importSourceRevisions.id, id),
        eq(importSourceRevisions.userId, ctx.user.id),
      ),
    )
    .get();
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
  return row;
}
function attachment(ctx: AuthedContext, id: string) {
  const row = ctx.db
    .select()
    .from(importSourceAttachments)
    .where(eq(importSourceAttachments.sourceRevisionId, id))
    .get();
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
  return row;
}
function assertFence(
  row: typeof importSourceRevisions.$inferSelect,
  fence: number,
) {
  if (row.fencingToken !== fence || row.leaseUntil <= Date.now())
    conflict("Import lease expired. Re-reserve the same source payload.");
}
export function importStatus(ctx: AuthedContext, id: string) {
  const row = revision(ctx, id);
  const file = attachment(ctx, id);
  return {
    operationId: id,
    sourceRevisionId: id,
    state: row.state,
    payloadDigest: row.payloadDigest,
    fencingToken: row.fencingToken,
    leaseUntil: row.leaseUntil,
    metadataVerified: row.metadataRaw !== null,
    files: [
      {
        slot: file.slot,
        state: file.state,
        detectedMime: file.detectedMime,
        storedSha256: file.storedSha256,
        storedSize: file.storedSize,
      },
    ],
    receipt: row.receipt,
  };
}
export function lookupImport(
  ctx: AuthedContext,
  input: ImportReservationInput,
) {
  const object = ctx.db
    .select()
    .from(importSourceObjects)
    .where(
      and(
        eq(importSourceObjects.userId, ctx.user.id),
        eq(importSourceObjects.provider, input.source.provider),
        eq(importSourceObjects.accountScope, input.source.accountScope),
        eq(importSourceObjects.objectId, input.source.objectId),
      ),
    )
    .get();
  const old =
    object &&
    ctx.db
      .select()
      .from(importSourceRevisions)
      .where(
        and(
          eq(importSourceRevisions.sourceObjectId, object.id),
          eq(importSourceRevisions.revision, input.source.revision),
        ),
      )
      .get();
  const contentMatches = ctx.db
    .select({ assetId: assets.id, bookmarkId: assets.bookmarkId })
    .from(assetContentHashes)
    .innerJoin(assets, eq(assets.id, assetContentHashes.assetId))
    .innerJoin(bookmarks, eq(bookmarks.id, assets.bookmarkId))
    .where(
      and(
        eq(assets.userId, ctx.user.id),
        eq(bookmarks.userId, ctx.user.id),
        eq(assetContentHashes.userId, ctx.user.id),
        eq(assetContentHashes.sha256, input.attachments[0].observed.sha256),
        eq(assetContentHashes.size, input.attachments[0].observed.size),
        eq(assetContentHashes.status, "verified"),
        eq(assetContentHashes.size, assets.size),
      ),
    )
    .limit(20)
    .all();
  return {
    sourceMatch: old
      ? old.payloadDigest === digest(canonicalImportJson(input))
        ? "same_revision"
        : "source_conflict"
      : "new_source",
    operationId: old?.id ?? null,
    contentMatches,
    physicalReuse: false,
  };
}
function checkQuota(
  tx: KarakeepDBTransaction,
  userId: string,
  extra: number,
  extraCards: number,
) {
  const user = tx.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new TRPCError({ code: "UNAUTHORIZED" });
  const used = tx
    .select({ total: sql<number>`coalesce(sum(${assets.size}),0)` })
    .from(assets)
    .where(eq(assets.userId, userId))
    .get()!.total;
  const existingCards = tx
    .select({ total: sql<number>`count(*)` })
    .from(bookmarks)
    .where(eq(bookmarks.userId, userId))
    .get()!.total;
  const reservations = tx
    .select()
    .from(importSourceRevisions)
    .where(eq(importSourceRevisions.userId, userId))
    .all();
  const retained = reservations.reduce(
    (n, r) =>
      n + r.payload.metadata.size + r.payload.attachments[0].observed.size,
    0,
  );
  const pending = reservations.filter((r) => r.state !== "committed").length;
  if (user.storageQuota !== null && used + retained + extra > user.storageQuota)
    conflict(
      "Import exceeds storage quota, including retained staging and metadata.",
    );
  if (
    user.bookmarkQuota !== null &&
    existingCards + pending + extraCards > user.bookmarkQuota
  )
    conflict("Import exceeds bookmark quota, including reservations.");
}
export async function reserveImport(
  ctx: AuthedContext,
  input: ImportReservationInput,
  idempotencyKey: string,
) {
  requireStorage(ctx);
  if (!idempotencyKey || idempotencyKey.length > 200)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A stable Idempotency-Key (1–200 characters) is required.",
    });
  input = zImportReservation.parse(input);
  if (Buffer.byteLength(canonicalImportJson(input)) > 256 * 1024)
    throw new TRPCError({
      code: "PAYLOAD_TOO_LARGE",
      message: "Reservation manifest exceeds 256 KiB.",
    });
  if (
    canonicalImportJson(input) !==
    canonicalImportJson(JSON.parse(JSON.stringify(input)))
  )
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Import provenance must be plain JSON.",
    });
  const payloadDigest = digest(canonicalImportJson(input));
  await mkdir(path.join(serverConfig.dataDir, "import-staging"), {
    recursive: true,
    mode: 0o700,
  });
  await syncDirectory(serverConfig.dataDir);
  const disk = await statfs(serverConfig.dataDir);
  // FULL applies to this SQLite connection before the short receipt transaction.
  ctx.db.run(sql`PRAGMA synchronous = FULL`);
  const id = ctx.db.transaction(
    (tx) => {
      const keyed = tx
        .select()
        .from(importReservations)
        .where(
          and(
            eq(importReservations.userId, ctx.user.id),
            eq(importReservations.idempotencyKey, idempotencyKey),
          ),
        )
        .get();
      if (keyed && keyed.payloadDigest !== payloadDigest)
        conflict("Idempotency key has a different payload.");
      const source = input.source;
      tx.insert(importSourceObjects)
        .values({
          id: randomUUID(),
          userId: ctx.user.id,
          provider: source.provider,
          accountScope: source.accountScope,
          objectId: source.objectId,
        })
        .onConflictDoNothing()
        .run();
      const object = tx
        .select()
        .from(importSourceObjects)
        .where(
          and(
            eq(importSourceObjects.userId, ctx.user.id),
            eq(importSourceObjects.provider, source.provider),
            eq(importSourceObjects.accountScope, source.accountScope),
            eq(importSourceObjects.objectId, source.objectId),
          ),
        )
        .get()!;
      let row = tx
        .select()
        .from(importSourceRevisions)
        .where(
          and(
            eq(importSourceRevisions.sourceObjectId, object.id),
            eq(importSourceRevisions.revision, source.revision),
          ),
        )
        .get();
      if (row && row.payloadDigest !== payloadDigest)
        conflict("Source revision has a different payload.");
      if (!row) {
        if (
          disk.bavail * disk.bsize <
          input.attachments[0].observed.size * 2 + 64 * 1024 * 1024
        )
          conflict("Insufficient staging disk headroom.");
        const count = tx
          .select({ total: sql<number>`count(*)` })
          .from(importSourceRevisions)
          .where(ne(importSourceRevisions.state, "committed"))
          .get()!.total;
        const own = tx
          .select({ total: sql<number>`count(*)` })
          .from(importSourceRevisions)
          .where(
            and(
              eq(importSourceRevisions.userId, ctx.user.id),
              ne(importSourceRevisions.state, "committed"),
            ),
          )
          .get()!.total;
        if (count >= 64 || own >= 16)
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "Import staging capacity is full.",
          });
        checkQuota(
          tx,
          ctx.user.id,
          input.attachments[0].observed.size + input.metadata.size,
          1,
        );
        row = tx
          .insert(importSourceRevisions)
          .values({
            id: randomUUID(),
            sourceObjectId: object.id,
            userId: ctx.user.id,
            revision: source.revision,
            payloadDigest,
            payload: input,
            state: "reserved",
            fencingToken: 1,
            leaseUntil: Date.now() + LEASE_MS,
            bookmarkId: randomUUID(),
          })
          .returning()
          .get();
        tx.insert(importSourceAttachments)
          .values({
            sourceRevisionId: row.id,
            slot: input.attachments[0].slot,
            assetId: randomUUID(),
            state: "pending",
          })
          .run();
      } else if (row.state !== "committed" && row.leaseUntil <= Date.now()) {
        tx.update(importSourceRevisions)
          .set({
            fencingToken: row.fencingToken + 1,
            leaseUntil: Date.now() + LEASE_MS,
          })
          .where(eq(importSourceRevisions.id, row.id))
          .run();
      }
      tx.insert(importReservations)
        .values({
          userId: ctx.user.id,
          idempotencyKey,
          payloadDigest,
          sourceRevisionId: row.id,
        })
        .onConflictDoNothing()
        .run();
      return row.id;
    },
    { behavior: "immediate" },
  );
  return importStatus(ctx, id);
}

async function withIo<T>(
  ctx: AuthedContext,
  id: string,
  fence: number,
  fn: (token: string) => Promise<T>,
) {
  requireStorage(ctx);
  assertFence(revision(ctx, id), fence);
  ctx.db.run(sql`PRAGMA synchronous = FULL`);
  const token = randomUUID();
  ctx.db.transaction(
    (tx) => {
      const old = tx
        .select()
        .from(assetHashScanLease)
        .where(eq(assetHashScanLease.id, 1))
        .get();
      if (old && old.expiresAt > Date.now())
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message:
            "Another original read or import write is running. Retry the same operation later.",
        });
      tx.insert(assetHashScanLease)
        .values({ id: 1, token, expiresAt: Date.now() + IO_LEASE_MS })
        .onConflictDoUpdate({
          target: assetHashScanLease.id,
          set: { token, expiresAt: Date.now() + IO_LEASE_MS },
        })
        .run();
    },
    { behavior: "immediate" },
  );
  try {
    return await fn(token);
  } finally {
    ctx.db
      .delete(assetHashScanLease)
      .where(eq(assetHashScanLease.token, token))
      .run();
  }
}
function assertWriter(
  ctx: AuthedContext,
  id: string,
  fence: number,
  token: string,
) {
  assertFence(revision(ctx, id), fence);
  const lease = ctx.db
    .select()
    .from(assetHashScanLease)
    .where(eq(assetHashScanLease.token, token))
    .get();
  if (!lease || lease.expiresAt <= Date.now())
    conflict("Import writer lease expired.");
}
async function writePrivateFile(location: string, bytes: Buffer) {
  const file = await open(location, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function syncDirectory(location: string) {
  const d = await open(location, "r");
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
async function hashFile(location: string, limit: number) {
  const hash = createHash("sha256");
  let size = 0;
  const stream = createReadStream(location);
  const timer = setTimeout(
    () => stream.destroy(new Error("Import read deadline exceeded")),
    IO_TIMEOUT_MS,
  );
  try {
    for await (const bytes of stream) {
      size += bytes.length;
      if (size > limit) conflict("Stored original exceeds its declared size.");
      hash.update(bytes);
    }
    return { sha256: hash.digest("hex"), size };
  } finally {
    clearTimeout(timer);
    stream.destroy();
  }
}
function sniffMime(bytes: Buffer) {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString()))
    return "image/gif";
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  if (bytes.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  return null;
}
export async function uploadImportFile(
  ctx: AuthedContext,
  id: string,
  slot: string,
  fence: number,
  source: Readable,
) {
  try {
    return await withIo(ctx, id, fence, async (token) => {
      const row = revision(ctx, id);
      const file = attachment(ctx, id);
      const expected = row.payload.attachments[0];
      if (file.slot !== slot) throw new TRPCError({ code: "NOT_FOUND" });
      if (row.state === "committed")
        conflict("Committed originals are immutable.");
      if (row.state === "hold")
        conflict(
          "Held evidence is immutable until owner resolution is supported.",
        );
      const directory = stageRoot(id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await syncDirectory(path.dirname(directory));
      const stageName = `${token}.bin`;
      const temporary = path.join(directory, `${token}.part`);
      const target = await open(temporary, "wx", 0o600);
      const hash = createHash("sha256");
      let size = 0;
      let prefix = Buffer.alloc(0);
      let completedUpload = false;
      const timer = setTimeout(
        () => source.destroy(new Error("Import upload deadline exceeded")),
        IO_TIMEOUT_MS,
      );
      try {
        for await (const data of source) {
          const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
          size += bytes.length;
          if (size > expected.observed.size || size > MAX_IMPORT_FILE_BYTES)
            throw new TRPCError({
              code: "PAYLOAD_TOO_LARGE",
              message: "Original exceeds its declared byte limit.",
            });
          if (prefix.length < 32)
            prefix = Buffer.concat([
              prefix,
              bytes.subarray(0, 32 - prefix.length),
            ]);
          hash.update(bytes);
          await target.writeFile(bytes);
        }
        await target.sync();
        completedUpload = true;
      } finally {
        clearTimeout(timer);
        source.destroy();
        await target.close();
        if (!completedUpload) await rm(temporary, { force: true });
      }
      const sha256 = hash.digest("hex");
      await rename(temporary, path.join(directory, stageName));
      await syncDirectory(directory);
      const readback = await hashFile(
        path.join(directory, stageName),
        expected.observed.size,
      );
      const detectedMime = sniffMime(prefix);
      const matches =
        sha256 === expected.observed.sha256 &&
        size === expected.observed.size &&
        readback.sha256 === sha256 &&
        readback.size === size;
      const historicalConflict =
        row.payload.source.revisionKind === "historical" ||
        (!!expected.exported &&
          (expected.exported.sha256 !== sha256 ||
            expected.exported.size !== size));
      assertWriter(ctx, id, fence, token);
      // Once a slot is verified it cannot silently acquire another copy or generation.
      if (file.state === "verified") {
        await rm(path.join(directory, stageName));
        if (!matches)
          conflict("Verified slot cannot be replaced by different bytes.");
        return importStatus(ctx, id);
      }
      ctx.db.transaction(
        (tx) => {
          tx.update(importSourceAttachments)
            .set({
              stageName,
              state:
                matches && detectedMime && !historicalConflict
                  ? "verified"
                  : "hold",
              detectedMime,
              storedSha256: sha256,
              storedSize: size,
              storageGeneration: token,
              verifiedAt: new Date(),
            })
            .where(eq(importSourceAttachments.sourceRevisionId, id))
            .run();
          tx.update(importSourceRevisions)
            .set({
              state:
                matches && detectedMime && !historicalConflict
                  ? "reserved"
                  : "hold",
              leaseUntil: Date.now() + LEASE_MS,
            })
            .where(eq(importSourceRevisions.id, id))
            .run();
        },
        { behavior: "immediate" },
      );
      return importStatus(ctx, id);
    });
  } finally {
    source.destroy();
  }
}
export async function uploadImportMetadata(
  ctx: AuthedContext,
  id: string,
  fence: number,
  bytes: Buffer,
) {
  return withIo(ctx, id, fence, async (token) => {
    const row = revision(ctx, id);
    if (
      bytes.length !== row.payload.metadata.size ||
      digest(bytes) !== row.payload.metadata.sha256
    )
      conflict("Metadata bytes do not match the reserved envelope.");
    const raw = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (row.metadataRaw !== null && row.metadataRaw !== raw)
      conflict("Metadata envelope is immutable.");
    assertWriter(ctx, id, fence, token);
    if (row.state !== "committed")
      ctx.db
        .update(importSourceRevisions)
        .set({ metadataRaw: raw, leaseUntil: Date.now() + LEASE_MS })
        .where(eq(importSourceRevisions.id, id))
        .run();
    return importStatus(ctx, id);
  });
}
export function readImportMetadata(ctx: AuthedContext, id: string) {
  const row = revision(ctx, id);
  if (row.metadataRaw === null) throw new TRPCError({ code: "NOT_FOUND" });
  return Buffer.from(row.metadataRaw, "utf8");
}
async function verifyStage(ctx: AuthedContext, id: string) {
  const row = revision(ctx, id);
  const file = attachment(ctx, id);
  if (
    row.state === "hold" ||
    file.state !== "verified" ||
    !file.stageName ||
    !file.detectedMime ||
    row.metadataRaw === null
  )
    conflict("Import has incomplete or held evidence.");
  const stored = await hashFile(
    path.join(stageRoot(id), file.stageName),
    row.payload.attachments[0].observed.size,
  );
  if (
    stored.sha256 !== file.storedSha256 ||
    stored.size !== file.storedSize ||
    digest(Buffer.from(row.metadataRaw)) !== row.payload.metadata.sha256
  )
    conflict("Staged evidence changed. Import remains uncommitted.");
  return { row, file, stored };
}
export async function verifyImport(
  ctx: AuthedContext,
  id: string,
  fence: number,
) {
  if (revision(ctx, id).state === "committed") return importStatus(ctx, id);
  return withIo(ctx, id, fence, async (token) => {
    await verifyStage(ctx, id);
    assertWriter(ctx, id, fence, token);
    ctx.db
      .update(importSourceRevisions)
      .set({ state: "verified", leaseUntil: Date.now() + LEASE_MS })
      .where(eq(importSourceRevisions.id, id))
      .run();
    return importStatus(ctx, id);
  });
}
export async function commitImport(
  ctx: AuthedContext,
  id: string,
  fence: number,
): Promise<ImportReceipt> {
  const existing = revision(ctx, id);
  if (existing.receipt) return existing.receipt;
  return withIo(ctx, id, fence, async (token) => {
    const { row, file, stored } = await verifyStage(ctx, id);
    const target = targetRoot(ctx.user.id, file.assetId);
    const parent = path.dirname(target);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await syncDirectory(serverConfig.assetsDir);
    await syncDirectory(path.dirname(serverConfig.assetsDir));
    const disk = await statfs(parent);
    if (disk.bavail * disk.bsize < stored.size + 64 * 1024 * 1024)
      conflict("Insufficient target disk headroom.");
    ctx.db.transaction((tx) => checkQuota(tx, ctx.user.id, stored.size, 0), {
      behavior: "immediate",
    });
    const pending = path.join(parent, `.import-${file.assetId}`);
    const targetExists = await stat(target).then(
      () => true,
      () => false,
    );
    if (!targetExists) {
      await rm(pending, { recursive: true, force: true });
      await mkdir(pending, { mode: 0o700 });
      const source = createReadStream(
        path.join(stageRoot(id), file.stageName!),
      );
      const destination = await open(
        path.join(pending, "asset.bin"),
        "wx",
        0o600,
      );
      const timer = setTimeout(
        () => source.destroy(new Error("Import promotion deadline exceeded")),
        IO_TIMEOUT_MS,
      );
      try {
        for await (const bytes of source) await destination.writeFile(bytes);
        await destination.sync();
      } finally {
        clearTimeout(timer);
        source.destroy();
        await destination.close();
      }
      await writePrivateFile(
        path.join(pending, "metadata.json"),
        Buffer.from(
          JSON.stringify({
            contentType: file.detectedMime,
            fileName: row.payload.attachments[0].originalName,
          }),
        ),
      );
      await syncDirectory(pending);
      assertWriter(ctx, id, fence, token);
      await rename(pending, target);
      await syncDirectory(parent);
    }
    const targetHash = await hashFile(
      path.join(target, "asset.bin"),
      stored.size,
    );
    const targetMetadata = JSON.parse(
      await readFile(path.join(target, "metadata.json"), "utf8"),
    );
    if (
      targetHash.sha256 !== stored.sha256 ||
      targetHash.size !== stored.size ||
      targetMetadata.contentType !== file.detectedMime ||
      targetMetadata.fileName !== row.payload.attachments[0].originalName
    )
      conflict(
        "Target readback failed. Existing target bytes were not overwritten.",
      );
    assertWriter(ctx, id, fence, token);
    const receipt: ImportReceipt = {
      operationId: id,
      sourceRevisionId: id,
      bookmarkId: row.bookmarkId,
      assets: [
        {
          slot: file.slot,
          assetId: file.assetId,
          storedSha256: stored.sha256,
          storedSize: stored.size,
          storageGeneration: file.storageGeneration!,
        },
      ],
      metadataSha256: row.payload.metadata.sha256,
      metadataSize: row.payload.metadata.size,
      metadataUrl: `/api/v1/import/reservations/${id}/metadata`,
      processingPolicy: "deferred",
      policyRevision: 1,
      contentRevision: 1,
      physicalReuse: false,
    };
    ctx.db.transaction(
      (tx) => {
        // This transaction publishes every relation and the held intent together.
        const current = tx
          .select()
          .from(importSourceRevisions)
          .where(eq(importSourceRevisions.id, id))
          .get()!;
        if (current.receipt) return;
        assertFence(current, fence);
        const lease = tx
          .select()
          .from(assetHashScanLease)
          .where(eq(assetHashScanLease.token, token))
          .get();
        if (!lease || lease.expiresAt <= Date.now())
          conflict("Import writer lease expired before commit.");
        checkQuota(tx, ctx.user.id, stored.size, 0);
        const mapping = row.payload.mapping;
        tx.insert(bookmarks)
          .values({
            id: row.bookmarkId,
            userId: ctx.user.id,
            type: BookmarkTypes.ASSET,
            source: "import",
            title: mapping.title,
            note: mapping.note,
            processingPolicy: "deferred",
            policyRevision: 1,
            contentRevision: 1,
            taggingStatus: null,
            summarizationStatus: null,
            embeddingStatus: null,
            sensitiveCategories: null,
            dbCreatedAt: mapping.savedAt
              ? new Date(mapping.savedAt)
              : new Date(),
            createdAt: mapping.savedAt ? new Date(mapping.savedAt) : new Date(),
          })
          .run();
        tx.insert(assets)
          .values({
            id: file.assetId,
            userId: ctx.user.id,
            bookmarkId: row.bookmarkId,
            assetType: AssetTypes.BOOKMARK_ASSET,
            contentType: file.detectedMime,
            size: stored.size,
            fileName: row.payload.attachments[0].originalName,
          })
          .run();
        tx.insert(bookmarkAssets)
          .values({
            id: row.bookmarkId,
            assetId: file.assetId,
            assetType:
              file.detectedMime === "application/pdf" ? "pdf" : "image",
            fileName: row.payload.attachments[0].originalName,
            sourceUrl: mapping.sourceUrl,
          })
          .run();
        for (const name of new Set(
          mapping.tags.map((tag) => normalizeTagName(tag).trim()),
        )) {
          tx.insert(bookmarkTags)
            .values({ id: randomUUID(), userId: ctx.user.id, name })
            .onConflictDoNothing()
            .run();
          const tag = tx
            .select()
            .from(bookmarkTags)
            .where(
              and(
                eq(bookmarkTags.userId, ctx.user.id),
                eq(bookmarkTags.name, name),
              ),
            )
            .get()!;
          tx.insert(tagsOnBookmarks)
            .values({
              bookmarkId: row.bookmarkId,
              tagId: tag.id,
              attachedBy: "human",
            })
            .run();
        }
        tx.insert(assetContentHashes)
          .values({
            assetId: file.assetId,
            userId: ctx.user.id,
            sha256: stored.sha256,
            size: stored.size,
            status: "verified",
            verifiedAt: new Date(),
          })
          .run();
        tx.insert(duplicateGroups)
          .values({
            userId: ctx.user.id,
            sha256: stored.sha256,
            size: stored.size,
          })
          .onConflictDoNothing()
          .run();
        tx.insert(importProcessing)
          .values({
            bookmarkId: row.bookmarkId,
            sourceRevisionId: id,
            userId: ctx.user.id,
            requestId: randomUUID(),
            stage: "preview",
            state: "held",
            generation: 0,
            policyRevision: 1,
            contentRevision: 1,
            previewAssetId: randomUUID(),
            updatedAt: Date.now(),
          })
          .run();
        tx.insert(processingOutbox)
          .values({
            id: randomUUID(),
            userId: ctx.user.id,
            sourceRevisionId: id,
            bookmarkId: row.bookmarkId,
            kind: "import.committed",
            state: "held",
            policyRevision: 1,
            contentRevision: 1,
          })
          .run();
        tx.update(importSourceRevisions)
          .set({ state: "committed", receipt })
          .where(eq(importSourceRevisions.id, id))
          .run();
      },
      { behavior: "immediate" },
    );
    return receipt;
  });
}
