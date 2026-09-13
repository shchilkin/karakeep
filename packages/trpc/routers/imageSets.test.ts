import { randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import {
  AssetTypes,
  assets,
  bookmarkAssets,
  bookmarks,
  bookmarkTags,
  tagsOnBookmarks,
  imageSetMembers,
  bookmarkLists,
  bookmarksInLists,
  users,
} from "@karakeep/db/schema";
import {
  isImageSetAssetRetained,
  assertBookmarkDerivativesAllowed,
  assertBookmarkMutable,
  automaticQueueAllowed,
  isImportCatalogBlocked,
} from "@karakeep/shared-server";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import { getBookmarkMedia } from "@karakeep/shared/utils/bookmarkMedia";
import { concealSensitiveBookmark } from "@karakeep/shared/sensitiveVisibility";
import { requestMediaCatalog, startMediaCatalog } from "../models/mediaCatalog";
import { defaultBeforeEach, getTestQueueMocks } from "../testUtils";
import type { CustomTestContext } from "../testUtils";

beforeEach<CustomTestContext>(defaultBeforeEach(true));
function seed(ctx: CustomTestContext, n = 4) {
  const owner = ctx.db.select().from(users).all()[0];
  const ids = Array.from({ length: n }, () => randomUUID());
  for (const [i, id] of ids.entries()) {
    ctx.db
      .insert(bookmarks)
      .values({
        id,
        userId: owner.id,
        type: BookmarkTypes.ASSET,
        title: `Image ${i + 1}`,
        titleSource: "manual",
        note: `Original note ${i}`,
        sensitiveCategories: [],
      })
      .run();
    ctx.db
      .insert(assets)
      .values({
        id: `file-${id}`,
        bookmarkId: id,
        userId: owner.id,
        assetType: AssetTypes.BOOKMARK_ASSET,
        contentType: "image/png",
        fileName: `${i}.png`,
        width: 600,
        height: 900,
        size: 100,
      })
      .run();
    ctx.db
      .insert(bookmarkAssets)
      .values({
        id,
        assetId: `file-${id}`,
        assetType: "image",
        fileName: `${i}.png`,
        sourceUrl: `https://example.test/${i}`,
      })
      .run();
  }
  return { owner, ids, api: ctx.apiCallers[0], id: randomUUID() };
}
test<CustomTestContext>("reversible gallery retains original assets, titles, notes and tags; feed paginates sets", async (ctx) => {
  const { ids, api, id, owner } = seed(ctx);
  const before = ctx.db.select().from(bookmarks).all();
  const files = ctx.db.select().from(assets).all();
  const [tag] = ctx.db
    .insert(bookmarkTags)
    .values({ name: "source tag", userId: owner.id })
    .returning()
    .all();
  ctx.db
    .insert(tagsOnBookmarks)
    .values({ bookmarkId: ids[0], tagId: tag.id, attachedBy: "human" })
    .run();
  const input = {
    id,
    composition: {
      title: "A series",
      memberIds: ids.slice(0, 3),
      coverBookmarkId: ids[1],
    },
  };
  const card = await api.imageSets.save(input);
  expect((await api.imageSets.save(input)).id).toBe(id);
  expect(card.content).toMatchObject({
    type: "asset",
    assetId: `file-${ids[1]}`,
  });
  expect(getBookmarkMedia(card).map((m) => m.id)).toEqual(
    ids.slice(0, 3).map((id) => `file-${id}`),
  );
  expect(card.tags.map((t) => t.name)).toEqual(["source tag"]);
  expect(isImageSetAssetRetained(ctx.db, files[0].id)).toBe(true);
  expect(ctx.db.select().from(assets).all()).toEqual(files);
  for (const original of before)
    expect(
      ctx.db
        .select()
        .from(bookmarks)
        .where(eq(bookmarks.id, original.id))
        .get(),
    ).toEqual(original);
  const page = await api.bookmarks.getBookmarks({ limit: 1 });
  const next = await api.bookmarks.getBookmarks({
    limit: 1,
    cursor: page.nextCursor,
  });
  expect(
    new Set([...page.bookmarks, ...next.bookmarks].map((b) => b.id)),
  ).toEqual(new Set([id, ids[3]]));
  expect(
    (await api.bookmarks.getBookmark({ bookmarkId: ids[0] })).memberOfSet,
  ).toBe(id);
  await expect(
    api.bookmarks.deleteBookmark({ bookmarkId: ids[0] }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(
    api.bookmarks.deleteBookmark({ bookmarkId: id }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  const restored = await api.imageSets.dissolve({
    id,
    revision: card.imageSet!.revision,
  });
  expect(restored.memberIds).toEqual(ids.slice(0, 3));
  expect((await api.bookmarks.getBookmarks({})).bookmarks).toHaveLength(4);
  expect(ctx.db.select().from(assets).all()).toEqual(files);
  expect(ctx.db.select().from(tagsOnBookmarks).all()).toHaveLength(1);
});
test<CustomTestContext>("reorders, changes cover, adds and removes with optimistic concurrency", async (ctx) => {
  const { ids, api, id } = seed(ctx);
  await api.imageSets.save({
    id,
    composition: {
      title: "Set",
      memberIds: ids.slice(0, 2),
      coverBookmarkId: ids[0],
    },
  });
  const updated = await api.imageSets.save({
    id,
    revision: 1,
    composition: {
      title: "Updated",
      memberIds: [ids[3], ids[1], ids[2]],
      coverBookmarkId: ids[2],
    },
  });
  expect(updated.imageSet).toMatchObject({
    revision: 2,
    coverBookmarkId: ids[2],
  });
  expect(updated.imageSet!.members.map((m) => m.bookmarkId)).toEqual([
    ids[3],
    ids[1],
    ids[2],
  ]);
  expect(
    (await api.bookmarks.getBookmark({ bookmarkId: ids[0] })).memberOfSet,
  ).toBeUndefined();
  await expect(
    api.imageSets.dissolve({ id, revision: 1 }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(
    api.imageSets.save({
      id,
      revision: 1,
      composition: {
        title: "Stale",
        memberIds: ids.slice(0, 2),
        coverBookmarkId: ids[0],
      },
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await api.bookmarks.getBookmark({ bookmarkId: id })).title).toBe(
    "Updated",
  );
});
test<CustomTestContext>("rejects cross-owner, nested, duplicate and invalid-cover composition atomically", async (ctx) => {
  const { ids, api, id } = seed(ctx);
  const composition = {
    title: "Set",
    memberIds: ids.slice(0, 2),
    coverBookmarkId: ids[0],
  };
  await expect(
    ctx.apiCallers[1].imageSets.save({ id, composition }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    api.imageSets.save({
      id,
      composition: { ...composition, memberIds: [ids[0], ids[0]] },
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    api.imageSets.save({
      id,
      composition: { ...composition, coverBookmarkId: ids[3] },
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(ctx.db.select().from(imageSetMembers).all()).toHaveLength(0);
  await api.imageSets.save({ id, composition });
  await expect(
    ctx.apiCallers[1].bookmarks.getBookmark({ bookmarkId: id }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    api.imageSets.save({
      id: randomUUID(),
      composition: {
        title: "Nested",
        memberIds: [id, ids[2]],
        coverBookmarkId: id,
      },
    }),
  ).rejects.toBeDefined();
  await expect(
    api.imageSets.save({
      id: randomUUID(),
      composition: {
        title: "Overlap",
        memberIds: [ids[1], ids[2]],
        coverBookmarkId: ids[1],
      },
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});
test<CustomTestContext>("a safe cover cannot reveal a sensitive or unknown member; sensitive section returns the set", async (ctx) => {
  const { ids, api, id } = seed(ctx);
  ctx.db
    .update(bookmarks)
    .set({ sensitiveCategories: ["nudity"] })
    .where(eq(bookmarks.id, ids[1]))
    .run();
  const card = await api.imageSets.save({
    id,
    composition: {
      title: "Mixed",
      memberIds: ids.slice(0, 3),
      coverBookmarkId: ids[0],
    },
  });
  expect(concealSensitiveBookmark(card, "work")).toBe(true);
  expect(concealSensitiveBookmark(card, "balanced")).toBe(true);
  expect(concealSensitiveBookmark(card, "all")).toBe(false);
  expect(
    (await api.bookmarks.getBookmarks({ sensitive: true })).bookmarks.map(
      (b) => b.id,
    ),
  ).toEqual([id]);
  expect(
    (await api.bookmarks.getBookmarks({ sensitive: false })).bookmarks.map(
      (b) => b.id,
    ),
  ).toEqual([ids[3]]);
  ctx.db
    .update(bookmarks)
    .set({ sensitiveCategories: [] })
    .where(eq(bookmarks.id, ids[1]))
    .run();
  ctx.db
    .update(bookmarks)
    .set({ sensitiveCategories: null })
    .where(eq(bookmarks.id, ids[2]))
    .run();
  const changed = await api.bookmarks.getBookmark({ bookmarkId: id });
  expect(concealSensitiveBookmark(changed, "work")).toBe(true);
  expect(concealSensitiveBookmark(changed, "balanced")).toBe(false);
});
test<CustomTestContext>("grouping revokes pending AI and blocks new/old dispatch while preserving results", async (ctx) => {
  const { ids, api, id, owner } = seed(ctx);
  const previous = {
    runId: "old-job",
    fingerprint: "input",
    model: "fixture-model",
    status: "pending" as const,
    updatedAt: new Date().toISOString(),
    allowPreview: false,
    result: {
      title: "Existing",
      summary: "Existing summary",
      tags: ["existing"],
    },
  };
  ctx.db
    .update(bookmarks)
    .set({ mediaAi: previous })
    .where(eq(bookmarks.id, ids[0]))
    .run();
  await api.imageSets.save({
    id,
    composition: {
      title: "Set",
      memberIds: ids.slice(0, 2),
      coverBookmarkId: ids[0],
    },
  });
  expect(
    ctx.db.select().from(bookmarks).where(eq(bookmarks.id, ids[0])).get()!
      .mediaAi,
  ).toMatchObject({ status: "cancelled", result: previous.result });
  const job = { bookmarkId: ids[0], userId: owner.id, runId: previous.runId };
  expect(startMediaCatalog(ctx.db, job)).toBeNull();
  for (const bookmarkId of [id, ...ids.slice(0, 2)]) {
    expect(isImportCatalogBlocked(ctx.db, bookmarkId)).toBe(true);
    for (const queue of [
      "media_catalog_queue",
      "openai_queue",
      "embeddings_queue",
      "asset_preprocessing_queue",
    ])
      expect(automaticQueueAllowed(ctx.db, { bookmarkId }, queue)).toBe(false);
    expect(
      automaticQueueAllowed(
        ctx.db,
        { bookmarkId, type: "index" },
        "searching_indexing",
      ),
    ).toBe(true);
    await expect(
      requestMediaCatalog(ctx.db, owner.id, bookmarkId),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await requestMediaCatalog(ctx.db, owner.id, bookmarkId, {
        automatic: true,
      }),
    ).toBeNull();
  }
  expect(getTestQueueMocks().openAIEnqueue).not.toHaveBeenCalled();
  expect(getTestQueueMocks().assetPreprocessingEnqueue).not.toHaveBeenCalled();
});

test<CustomTestContext>("sets preserve private list placement and invalidate drafts edited through legacy clients", async (ctx) => {
  const { ids, api, id, owner } = seed(ctx);
  const listId = randomUUID();
  ctx.db
    .insert(bookmarkLists)
    .values({
      id: listId,
      name: "Reference",
      userId: owner.id,
      icon: "folder",
      type: "manual",
    })
    .run();
  ctx.db.insert(bookmarksInLists).values({ listId, bookmarkId: ids[0] }).run();
  const composition = {
    title: "Set",
    memberIds: ids.slice(0, 2),
    coverBookmarkId: ids[0],
  };
  const card = await api.imageSets.save({ id, composition });
  expect(
    (await api.bookmarks.getBookmarks({ listId })).bookmarks.map((b) => b.id),
  ).toEqual([id]);
  expect(
    ctx.db
      .select()
      .from(bookmarksInLists)
      .all()
      .map((r) => r.bookmarkId)
      .sort(),
  ).toEqual([id, ids[0]].sort());
  await api.bookmarks.updateBookmark({
    bookmarkId: id,
    title: "Title from old client",
  });
  await expect(
    api.imageSets.save({ id, composition, revision: card.imageSet!.revision }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await api.bookmarks.getBookmark({ bookmarkId: id })).title).toBe(
    "Title from old client",
  );
});

test<CustomTestContext>("read-only image derivatives remain available while original mutations are held", async (ctx) => {
  const { ids, api, id } = seed(ctx);
  await api.imageSets.save({
    id,
    composition: {
      title: "Set",
      memberIds: ids.slice(0, 2),
      coverBookmarkId: ids[0],
    },
  });
  expect(() => assertBookmarkDerivativesAllowed(ctx.db, ids[0])).not.toThrow();
  expect(() => assertBookmarkMutable(ctx.db, ids[0])).toThrow();
  ctx.db
    .update(bookmarks)
    .set({ processingPolicy: "deferred" })
    .where(eq(bookmarks.id, ids[2]))
    .run();
  expect(() => assertBookmarkDerivativesAllowed(ctx.db, ids[2])).toThrow();
});
