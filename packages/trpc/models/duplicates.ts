import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import type { DB, KarakeepDBTransaction } from "@karakeep/db";
import type { z } from "zod";
import {
  assets,
  assetContentHashes,
  assetHashScanLease,
  bookmarks,
  duplicateGroups,
  duplicateDecisions,
} from "@karakeep/db/schema";
import { createAssetReadStream, getAssetSize } from "@karakeep/shared-server";
import type {
  zDuplicateDecisionRequest,
  zDuplicateList,
  zDuplicateScan,
} from "@karakeep/shared/types/duplicates";
import type { AuthedContext } from "..";
import { Bookmark } from "./bookmarks";
import { List } from "./lists";

export const MAX_HASH_FILE_BYTES = 512 * 1024 * 1024;
const READ_TIMEOUT_MS = 20_000;
const LEASE_MS = 60_000;

// Original occurrences only; generated banners/screenshots/posters are not evidence.
const originals = sql`${assets.bookmarkId} is not null
  and ${assets.assetType} in ('bookmarkAsset', 'linkVideo', 'userUploaded')
  and (${assets.fileName} is null or lower(${assets.fileName}) not like '%.poster.jpg')`;
const validHash = sql`${assetContentHashes.status} = 'verified'
  and ${assetContentHashes.size} = ${assets.size}
  and ${assetContentHashes.userId} = ${assets.userId}`;

function originalRows(ctx: AuthedContext) {
  return ctx.db
    .select({ asset: assets, hash: assetContentHashes })
    .from(assets)
    .innerJoin(bookmarks, eq(bookmarks.id, assets.bookmarkId))
    .leftJoin(assetContentHashes, eq(assetContentHashes.assetId, assets.id))
    .where(
      and(
        eq(assets.userId, ctx.user.id),
        eq(bookmarks.userId, ctx.user.id),
        originals,
      ),
    );
}

export async function duplicateStatus(ctx: AuthedContext) {
  const rows = await originalRows(ctx);
  return {
    originals: rows.length,
    verified: rows.filter(
      ({ asset, hash }) =>
        hash?.status === "verified" &&
        hash.userId === ctx.user.id &&
        hash.size === asset.size,
    ).length,
    needsIndex: rows.filter(
      ({ asset, hash }) => !hash || hash.size !== asset.size,
    ).length,
    errors: rows.filter(({ hash }) => hash && hash.status !== "verified")
      .length,
    maxFileBytes: MAX_HASH_FILE_BYTES,
    physicalReuse: false as const,
  };
}

async function readOriginalHash(
  userId: string,
  assetId: string,
  expectedSize: number,
): Promise<{
  status: "verified" | "unreadable" | "too_large" | "changed";
  sha256: string | null;
}> {
  let stream: Readable | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + READ_TIMEOUT_MS;
  const checkDeadline = () => {
    if (expired || Date.now() >= deadline)
      throw new Error("Hash read deadline exceeded");
  };
  const work = async () => {
    const before = await getAssetSize({ userId, assetId });
    checkDeadline();
    if (before > MAX_HASH_FILE_BYTES)
      return { status: "too_large" as const, sha256: null };
    if (before !== expectedSize)
      return { status: "changed" as const, sha256: null };
    const source = await createAssetReadStream({ userId, assetId });
    if (!(source instanceof Readable))
      throw new Error("Storage must provide a cancellable stream");
    stream = source;
    if (expired) {
      stream.destroy();
      throw new Error("Hash read deadline exceeded");
    }
    checkDeadline();
    const hash = createHash("sha256");
    let bytesRead = 0;
    for await (const chunk of stream) {
      checkDeadline();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += bytes.length;
      if (bytesRead > MAX_HASH_FILE_BYTES || bytesRead > before)
        return { status: "changed" as const, sha256: null };
      hash.update(bytes);
    }
    const after = await getAssetSize({ userId, assetId });
    checkDeadline();
    if (bytesRead !== before || after !== before)
      return { status: "changed" as const, sha256: null };
    return { status: "verified" as const, sha256: hash.digest("hex") };
  };
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          stream?.destroy();
          reject(new Error("Hash read deadline exceeded"));
        }, READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return { status: "unreadable", sha256: null };
  } finally {
    if (timer) clearTimeout(timer);
    stream?.destroy();
  }
}

/** One file per request: bounded storage reads, no decode, models or media mutation. */
export async function scanNextOriginal(
  ctx: AuthedContext,
  input: z.infer<typeof zDuplicateScan>,
) {
  const token = randomUUID();
  const now = Date.now();
  const claimed = ctx.db.transaction(
    (tx) => {
      tx.insert(assetHashScanLease)
        .values({ id: 1, token, expiresAt: now + LEASE_MS })
        .onConflictDoNothing()
        .run();
      tx.update(assetHashScanLease)
        .set({ token, expiresAt: now + LEASE_MS })
        .where(
          and(
            eq(assetHashScanLease.id, 1),
            lt(assetHashScanLease.expiresAt, now),
          ),
        )
        .run();
      return tx
        .select()
        .from(assetHashScanLease)
        .where(eq(assetHashScanLease.token, token))
        .get();
    },
    { behavior: "immediate" },
  );
  if (!claimed)
    throw new TRPCError({
      code: "CONFLICT",
      message: "Another file scan is running. Try again shortly.",
    });
  try {
    const [row] = await ctx.db
      .select({ asset: assets })
      .from(assets)
      .innerJoin(bookmarks, eq(bookmarks.id, assets.bookmarkId))
      .leftJoin(assetContentHashes, eq(assetContentHashes.assetId, assets.id))
      .where(
        and(
          eq(assets.userId, ctx.user.id),
          eq(bookmarks.userId, ctx.user.id),
          originals,
          input.afterId ? gt(assets.id, input.afterId) : undefined,
          input.recheck
            ? undefined
            : sql`(${assetContentHashes.assetId} is null or ${assetContentHashes.size} != ${assets.size})`,
        ),
      )
      .orderBy(asc(assets.id))
      .limit(1);
    if (!row) return { done: true, nextCursor: null, status: null };
    const asset = row.asset;
    const { status, sha256 } = await readOriginalHash(
      ctx.user.id,
      asset.id,
      asset.size,
    );
    ctx.db.transaction(
      (tx) => {
        const lease = tx
          .select()
          .from(assetHashScanLease)
          .where(
            and(
              eq(assetHashScanLease.token, token),
              gt(assetHashScanLease.expiresAt, Date.now()),
            ),
          )
          .get();
        const current = tx
          .select()
          .from(assets)
          .where(and(eq(assets.id, asset.id), eq(assets.userId, ctx.user.id)))
          .get();
        if (!lease || !current) return;
        // An attach/replace during the read must not certify another occurrence.
        if (
          current.size !== asset.size ||
          current.bookmarkId !== asset.bookmarkId ||
          current.assetType !== asset.assetType
        )
          return;
        const value = {
          assetId: asset.id,
          userId: ctx.user.id,
          sha256,
          size: asset.size,
          status,
          verifiedAt: new Date(),
        };
        tx.insert(assetContentHashes)
          .values(value)
          .onConflictDoUpdate({
            target: assetContentHashes.assetId,
            set: value,
          })
          .run();
        if (sha256 && status === "verified")
          tx.insert(duplicateGroups)
            .values({ userId: ctx.user.id, sha256, size: asset.size })
            .onConflictDoNothing()
            .run();
      },
      { behavior: "immediate" },
    );
    return { done: false, nextCursor: asset.id, status };
  } finally {
    ctx.db
      .delete(assetHashScanLease)
      .where(eq(assetHashScanLease.token, token))
      .run();
  }
}

function groupMembers(
  ctx: { db: DB | KarakeepDBTransaction; user: AuthedContext["user"] },
  groupId: string,
) {
  const group = ctx.db
    .select()
    .from(duplicateGroups)
    .where(
      and(
        eq(duplicateGroups.id, groupId),
        eq(duplicateGroups.userId, ctx.user.id),
      ),
    )
    .get();
  if (!group) throw new TRPCError({ code: "NOT_FOUND" });
  const members = ctx.db
    .select({ asset: assets, verifiedAt: assetContentHashes.verifiedAt })
    .from(assetContentHashes)
    .innerJoin(assets, eq(assets.id, assetContentHashes.assetId))
    .innerJoin(bookmarks, eq(bookmarks.id, assets.bookmarkId))
    .where(
      and(
        eq(assetContentHashes.sha256, group.sha256),
        eq(assetContentHashes.size, group.size),
        eq(assets.userId, ctx.user.id),
        eq(bookmarks.userId, ctx.user.id),
        originals,
        validHash,
      ),
    )
    .orderBy(asc(assets.id))
    .all();
  if (members.length < 2)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "This group no longer has duplicate originals.",
    });
  const evidenceVersion = createHash("sha256")
    .update(
      JSON.stringify([
        group.sha256,
        group.size,
        members.map((m) => [
          m.asset.id,
          m.asset.bookmarkId,
          m.asset.fileName,
          m.asset.assetType,
        ]),
      ]),
    )
    .digest("hex");
  const decision = ctx.db
    .select()
    .from(duplicateDecisions)
    .where(eq(duplicateDecisions.groupId, groupId))
    .get();
  return {
    group,
    members,
    evidenceVersion,
    decision: decision?.evidenceVersion === evidenceVersion ? decision : null,
    decisionVersion: decision?.version ?? 0,
  };
}

export async function listDuplicateGroups(
  ctx: AuthedContext,
  input: z.infer<typeof zDuplicateList>,
) {
  // SQL bounds the candidate page. A decision can be stale when occurrences change.
  const candidates = await ctx.db
    .select({ id: duplicateGroups.id })
    .from(duplicateGroups)
    .innerJoin(
      assetContentHashes,
      and(
        eq(assetContentHashes.sha256, duplicateGroups.sha256),
        eq(assetContentHashes.size, duplicateGroups.size),
        eq(assetContentHashes.userId, duplicateGroups.userId),
      ),
    )
    .innerJoin(assets, eq(assets.id, assetContentHashes.assetId))
    .innerJoin(bookmarks, eq(bookmarks.id, assets.bookmarkId))
    .where(
      and(
        eq(duplicateGroups.userId, ctx.user.id),
        eq(assets.userId, ctx.user.id),
        eq(bookmarks.userId, ctx.user.id),
        originals,
        validHash,
        input.cursor ? gt(duplicateGroups.id, input.cursor) : undefined,
      ),
    )
    .groupBy(duplicateGroups.id)
    .having(sql`count(*) >= 2`)
    .orderBy(asc(duplicateGroups.id))
    .limit(input.limit + 1);
  const page = candidates.slice(0, input.limit);
  const groups = [];
  for (const candidate of page) {
    let detail;
    try {
      detail = groupMembers(ctx, candidate.id);
    } catch (e) {
      if (e instanceof TRPCError && e.code === "NOT_FOUND") continue;
      throw e;
    }
    if (!detail) continue;
    if (input.view === "pending" && detail.decision) continue;
    if (input.view === "reviewed" && !detail.decision) continue;
    groups.push({
      id: candidate.id,
      files: detail.members.length,
      cards: new Set(detail.members.map((m) => m.asset.bookmarkId)).size,
      size: detail.group.size,
      copyBytes: (detail.members.length - 1) * detail.group.size,
      decision: detail.decision?.decision ?? null,
    });
  }
  return {
    groups,
    nextCursor:
      candidates.length > input.limit ? page[page.length - 1].id : null,
  };
}

export async function getDuplicateGroup(ctx: AuthedContext, groupId: string) {
  const detail = await groupMembers(ctx, groupId);
  const bookmarkIds = [
    ...new Set(detail.members.map((m) => m.asset.bookmarkId!)),
  ];
  const cards = [];
  const cardContext: {
    bookmarkId: string;
    originalCount: number;
    lists: { id: string; name: string }[];
  }[] = [];
  // A group can have many occurrences; only the first 50 are expanded per view.
  for (const id of bookmarkIds.slice(0, 50)) {
    cards.push((await Bookmark.fromId(ctx, id, true)).asZBookmark());
    const [{ total }] = await ctx.db
      .select({ total: sql<number>`count(*)` })
      .from(assets)
      .where(
        and(
          eq(assets.userId, ctx.user.id),
          eq(assets.bookmarkId, id),
          originals,
        ),
      );
    const lists = (await List.forBookmark(ctx, id))
      .filter((l) => l.canUserView())
      .map((l) => {
        const item = l.asZBookmarkList();
        return { id: item.id, name: item.name };
      });
    cardContext.push({ bookmarkId: id, originalCount: total, lists });
  }
  return {
    id: groupId,
    evidenceVersion: detail.evidenceVersion,
    decision: detail.decision,
    decisionVersion: detail.decisionVersion,
    members: detail.members,
    cards,
    cardContext,
    truncated: bookmarkIds.length > 50,
    size: detail.group.size,
  };
}

export async function decideDuplicateGroup(
  ctx: AuthedContext,
  input: z.infer<typeof zDuplicateDecisionRequest>,
) {
  return ctx.db.transaction(
    (tx) => {
      const detail = groupMembers({ ...ctx, db: tx }, input.groupId);
      if (
        input.evidenceVersion !== detail.evidenceVersion ||
        input.expectedDecisionVersion !== detail.decisionVersion
      )
        throw new TRPCError({
          code: "CONFLICT",
          message: "The group changed. Refresh before saving your decision.",
        });
      if (
        input.decision === "prefer_primary" &&
        !detail.members.some(
          (m) => m.asset.bookmarkId === input.primaryBookmarkId,
        )
      )
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Choose a card in this group.",
        });
      if (input.decision === null) {
        // Keep a revision tombstone: a stale tab must not overwrite a later undo.
        const value = {
          groupId: input.groupId,
          evidenceVersion: "undone",
          decision: "defer" as const,
          primaryBookmarkId: null,
          version: detail.decisionVersion + 1,
          updatedAt: new Date(),
        };
        tx.insert(duplicateDecisions)
          .values(value)
          .onConflictDoUpdate({
            target: duplicateDecisions.groupId,
            set: value,
          })
          .run();
      } else {
        const value = {
          groupId: input.groupId,
          evidenceVersion: input.evidenceVersion,
          decision: input.decision,
          primaryBookmarkId:
            input.decision === "prefer_primary"
              ? input.primaryBookmarkId
              : null,
          version: detail.decisionVersion + 1,
          updatedAt: new Date(),
        };
        tx.insert(duplicateDecisions)
          .values(value)
          .onConflictDoUpdate({
            target: duplicateDecisions.groupId,
            set: value,
          })
          .run();
      }
      return { version: detail.decisionVersion + 1 };
    },
    { behavior: "immediate" },
  );
}
