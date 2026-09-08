import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { assets, AssetTypes, bookmarks } from "@karakeep/db/schema";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach } from "../testUtils";
import { Bookmark } from "../models/bookmarks";
import { WebhookQueue } from "@karakeep/shared-server";

beforeEach<CustomTestContext>(defaultBeforeEach(true));
afterEach(() => vi.restoreAllMocks());

const analysis = {
  runId: "one",
  fingerprint: "media",
  model: "test",
  status: "success" as const,
  updatedAt: "2026-09-08T00:00:00.000Z",
  allowPreview: false,
  result: {
    title: "Studio portrait",
    summary: "A portrait.",
    tags: ["portrait"],
  },
};

test<CustomTestContext>("ordinary clients receive AI title and stored photo cover on get, list and resave", async ({
  apiCallers,
  db,
}) => {
  const api = apiCallers[0].bookmarks;
  const b = await api.createBookmark({
    type: BookmarkTypes.LINK,
    url: "https://instagram.com/p/one",
    source: "mobile",
  });
  await db
    .update(bookmarks)
    .set({ mediaAi: analysis })
    .where(eq(bookmarks.id, b.id));
  await db.insert(assets).values([
    {
      id: "banner",
      bookmarkId: b.id,
      userId: b.userId,
      assetType: AssetTypes.LINK_BANNER_IMAGE,
    },
    {
      id: "second",
      bookmarkId: b.id,
      userId: b.userId,
      assetType: AssetTypes.USER_UPLOADED,
      fileName: "002.jpg",
    },
    {
      id: "first",
      bookmarkId: b.id,
      userId: b.userId,
      assetType: AssetTypes.USER_UPLOADED,
      fileName: "001.jpg",
    },
  ]);
  const fetched = await api.getBookmark({ bookmarkId: b.id });
  const listed = (await api.getBookmarks({})).bookmarks[0];
  const saved = await api.createBookmark({
    type: BookmarkTypes.LINK,
    url: "https://instagram.com/p/one",
    source: "extension",
  });
  for (const response of [fetched, listed, saved]) {
    expect(response).toMatchObject({
      title: analysis.result.title,
      originalTitle: null,
      content: { imageAssetId: "first" },
    });
  }
  expect(
    db.select().from(bookmarks).where(eq(bookmarks.id, b.id)).get()?.title,
  ).toBeNull();
  expect(
    db.select().from(assets).where(eq(assets.id, "banner")).get()?.assetType,
  ).toBe(AssetTypes.LINK_BANNER_IMAGE);
  await expect(
    apiCallers[1].bookmarks.getBookmark({ bookmarkId: b.id }),
  ).rejects.toThrow();
});

test<CustomTestContext>("video cover is its paired poster, never the MP4 or another slide", async ({
  apiCallers,
  db,
}) => {
  const api = apiCallers[0].bookmarks;
  const b = await api.createBookmark({
    type: BookmarkTypes.LINK,
    url: "https://x.com/a/status/12345",
  });
  await db.insert(assets).values([
    {
      id: "banner",
      bookmarkId: b.id,
      userId: b.userId,
      assetType: AssetTypes.LINK_BANNER_IMAGE,
    },
    {
      id: "video",
      bookmarkId: b.id,
      userId: b.userId,
      assetType: AssetTypes.USER_UPLOADED,
      fileName: "001.mp4",
    },
    {
      id: "photo",
      bookmarkId: b.id,
      userId: b.userId,
      assetType: AssetTypes.USER_UPLOADED,
      fileName: "002.jpg",
    },
    {
      id: "unpaired",
      bookmarkId: b.id,
      userId: b.userId,
      assetType: AssetTypes.USER_UPLOADED,
      fileName: "003.poster.jpg",
    },
  ]);
  expect((await api.getBookmark({ bookmarkId: b.id })).content).toMatchObject({
    imageAssetId: "banner",
  });
  await db.insert(assets).values({
    id: "poster",
    bookmarkId: b.id,
    userId: b.userId,
    assetType: AssetTypes.USER_UPLOADED,
    fileName: "001.poster.jpg",
  });
  expect((await api.getBookmarks({})).bookmarks[0].content).toMatchObject({
    imageAssetId: "poster",
  });
});

test<CustomTestContext>("legacy form echoes keep the stored title; explicit edits still win", async ({
  apiCallers,
  db,
}) => {
  const api = apiCallers[0].bookmarks;
  for (const original of [null, "Stories • Instagram"]) {
    const b = await api.createBookmark({
      type: BookmarkTypes.LINK,
      url: `https://example.com/${original ? "captured" : "empty"}`,
      title: original,
      titleSource: "captured",
    });
    await db
      .update(bookmarks)
      .set({ mediaAi: analysis })
      .where(eq(bookmarks.id, b.id));
    const response = await api.updateBookmark({
      bookmarkId: b.id,
      title: analysis.result.title,
      note: "My note",
    });
    expect(response).toMatchObject({
      title: analysis.result.title,
      originalTitle: original,
      titleSource: "captured",
      note: "My note",
    });
    expect(
      db.select().from(bookmarks).where(eq(bookmarks.id, b.id)).get(),
    ).toMatchObject({ title: original, titleSource: "captured" });
    const manual = await api.updateBookmark({
      bookmarkId: b.id,
      title: "My composition",
    });
    expect(manual).toMatchObject({
      title: "My composition",
      originalTitle: "My composition",
      titleSource: "manual",
    });
    const explicit = await api.updateBookmark({
      bookmarkId: b.id,
      title: analysis.result.title,
      titleSource: "manual",
    });
    expect(explicit).toMatchObject({
      titleSource: "manual",
      originalTitle: analysis.result.title,
    });
  }
});

test<CustomTestContext>("only deliberate resaves carry the reason through the webhook queue schema", async ({
  apiCallers,
}) => {
  const api = apiCallers[0];
  await api.webhooks.create({
    url: "https://example.com/hook",
    events: ["created", "edited"],
  });
  const enqueue = vi
    .spyOn(WebhookQueue, "enqueue")
    .mockResolvedValue(undefined);
  enqueue.mockClear();
  const b = await api.bookmarks.createBookmark({
    type: BookmarkTypes.LINK,
    url: "https://example.com/post",
    source: "mobile",
  });
  expect(enqueue.mock.calls[0][0]).toMatchObject({ operation: "created" });
  expect(enqueue.mock.calls[0][0]).not.toHaveProperty("reason");
  enqueue.mockClear();
  await api.bookmarks.updateBookmark({ bookmarkId: b.id, note: "Edited note" });
  expect(enqueue.mock.calls[0][0]).toMatchObject({ operation: "edited" });
  expect(enqueue.mock.calls[0][0]).not.toHaveProperty("reason");
  enqueue.mockClear();
  await api.bookmarks.createBookmark({
    type: BookmarkTypes.LINK,
    url: "https://example.com/post",
    source: "extension",
  });
  expect(enqueue).toHaveBeenCalledOnce();
  const { zWebhookRequestSchema } = await import("@karakeep/shared-server");
  expect(zWebhookRequestSchema.parse(enqueue.mock.calls[0][0])).toMatchObject({
    bookmarkId: b.id,
    operation: "edited",
    reason: "resaved",
  });
});

test<CustomTestContext>("a private cover projection never changes public sharing output", async ({
  apiCallers,
  db,
}) => {
  const b = await apiCallers[0].bookmarks.createBookmark({
    type: BookmarkTypes.LINK,
    url: "https://example.com/private-photo",
  });
  await db
    .insert(assets)
    .values({
      id: "private-photo",
      userId: b.userId,
      bookmarkId: b.id,
      assetType: AssetTypes.USER_UPLOADED,
      fileName: "001.jpg",
    });
  const model = await Bookmark.fromId(
    { db, user: { id: b.userId, role: "user" }, req: { ip: null } },
    b.id,
    false,
  );
  expect(model.asPublicBookmark().bannerImageUrl).toBeNull();
  expect(model.asZBookmark().content).toMatchObject({
    imageAssetId: "private-photo",
  });
  expect(model.asPublicBookmark().bannerImageUrl).toBeNull();
});
