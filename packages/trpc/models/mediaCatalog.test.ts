import { beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getInMemoryDB } from "@karakeep/db/drizzle";
import {
  assets,
  AssetTypes,
  bookmarkLinks,
  bookmarks,
  bookmarkTags,
  mediaAiRequests,
  tagsOnBookmarks,
  users,
} from "@karakeep/db/schema";
import serverConfig from "@karakeep/shared/config";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import { getBookmarkTitle } from "@karakeep/shared/utils/bookmarkUtils";
import { catalogInput } from "@karakeep/shared/mediaCatalog";
import {
  catalogSnapshot,
  finishMediaCatalog,
  requestMediaCatalog,
  startMediaCatalog,
} from "./mediaCatalog";
import { getApiCaller } from "../testUtils";

vi.mock("@karakeep/shared-server", async (original) => ({
  ...(await original<typeof import("@karakeep/shared-server")>()),
  MediaCatalogQueue: { enqueue: vi.fn() },
}));
let db: ReturnType<typeof getInMemoryDB>;
const result = {
  title: "A studio portrait",
  summary: "A neutral visual description.",
  tags: ["portrait", "studio"],
};

beforeEach(() => {
  db = getInMemoryDB(true);
  db.insert(users)
    .values([
      { id: "u1", name: "One", email: "a@example.test" },
      { id: "u2", name: "Two", email: "b@example.test" },
    ])
    .run();
  db.insert(bookmarks)
    .values({ id: "b1", userId: "u1", type: BookmarkTypes.LINK })
    .run();
  db.insert(bookmarkLinks)
    .values({
      id: "b1",
      url: "https://instagram.com/p/test",
      title: "Stories • Instagram",
    })
    .run();
  db.insert(assets)
    .values({
      id: "a1",
      userId: "u1",
      bookmarkId: "b1",
      assetType: AssetTypes.USER_UPLOADED,
      fileName: "001.jpg",
    })
    .run();
  Object.assign(serverConfig.mediaAi, {
    enabled: true,
    autoNew: true,
    model: "grok-4.6",
    dailyRequests: 20,
  });
});

async function queue() {
  const state = await requestMediaCatalog(db, "u1", "b1");
  expect(state).not.toBeNull();
  return { bookmarkId: "b1", userId: "u1", runId: state!.runId };
}

describe("media catalog lifecycle", () => {
  test("archive completion queues analysis, respecting the user's automatic tagging opt-out", async () => {
    await getApiCaller(db, "u1").bookmarks.updateTags({
      bookmarkId: "b1",
      attach: [{ tagName: "social-media-archived" }],
      detach: [],
    });
    expect(catalogSnapshot(db, "u1", "b1").bookmark.mediaAi?.status).toBe(
      "pending",
    );
    db.update(bookmarks).set({ mediaAi: null }).run();
    db.update(users)
      .set({ autoTaggingEnabled: false })
      .where(eq(users.id, "u1"))
      .run();
    expect(
      await requestMediaCatalog(db, "u1", "b1", { automatic: true }),
    ).toBeNull();
    expect(await requestMediaCatalog(db, "u1", "b1")).not.toBeNull();
  });

  test("a response with only unusable tags does not become a successful catalog", async () => {
    const job = await queue();
    startMediaCatalog(db, job);
    finishMediaCatalog(db, job, "success", {
      ...result,
      tags: ["instagram", "nsfw"],
    });
    const state = catalogSnapshot(db, "u1", "b1").bookmark.mediaAi;
    expect(state?.status).toBe("failed");
    expect(state?.result).toBeUndefined();
  });

  test("no automatic analysis before a complete archive; no default preview upload", async () => {
    expect(
      await requestMediaCatalog(db, "u1", "b1", { automatic: true }),
    ).toBeNull();
    db.update(assets).set({ assetType: AssetTypes.LINK_BANNER_IMAGE }).run();
    expect(catalogSnapshot(db, "u1", "b1").input).toBeNull();
    expect(catalogSnapshot(db, "u1", "b1", true).input?.media.coverage).toBe(
      "preview_only",
    );
  });

  test("ownership is checked by both request route and storage", async () => {
    await expect(requestMediaCatalog(db, "u2", "b1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      getApiCaller(db, "u2").bookmarks.analyzeMedia({ bookmarkId: "b1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      getApiCaller(db).bookmarks.analyzeMedia({ bookmarkId: "b1" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  test("duplicates and successful reruns cannot create another paid reservation", async () => {
    const job = await queue();
    expect(
      await requestMediaCatalog(db, "u1", "b1", { retry: true }),
    ).toBeNull();
    expect(startMediaCatalog(db, job)).not.toBeNull();
    expect(startMediaCatalog(db, job)).toBeNull();
    finishMediaCatalog(db, job, "success", result);
    expect(
      await requestMediaCatalog(db, "u1", "b1", { retry: true }),
    ).toBeNull();
    expect(db.select().from(mediaAiRequests).all()).toHaveLength(1);
  });

  test("manual title, summary, note and human tag ownership survive inference", async () => {
    const job = await queue();
    startMediaCatalog(db, job);
    db.update(bookmarks)
      .set({ title: "My title", summary: "My summary", note: "Private note" })
      .run();
    const tag = db
      .insert(bookmarkTags)
      .values({ userId: "u1", name: "Portrait" })
      .returning()
      .get();
    db.insert(tagsOnBookmarks)
      .values({ tagId: tag.id, bookmarkId: "b1", attachedBy: "human" })
      .run();
    finishMediaCatalog(db, job, "success", result);
    const saved = await getApiCaller(db, "u1").bookmarks.getBookmark({
      bookmarkId: "b1",
    });
    expect(saved).toMatchObject({
      title: "My title",
      summary: "My summary",
      note: "Private note",
      mediaAi: { status: "success", result: { title: result.title } },
    });
    expect(getBookmarkTitle(saved)).toBe("My title");
    expect(saved.tags.find((t) => t.id === tag.id)?.attachedBy).toBe("human");
    db.update(bookmarks).set({ title: null }).run();
    const aiTitled = await getApiCaller(db, "u1").bookmarks.getBookmark({
      bookmarkId: "b1",
    });
    expect(getBookmarkTitle(aiTitled)).toBe(result.title);
    expect(JSON.stringify(catalogInput(aiTitled))).not.toContain(
      "Private note",
    );
  });

  test("a user removing a tag during inference is not overridden", async () => {
    const tag = db
      .insert(bookmarkTags)
      .values({ userId: "u1", name: "portrait" })
      .returning()
      .get();
    db.insert(tagsOnBookmarks)
      .values({ tagId: tag.id, bookmarkId: "b1", attachedBy: "ai" })
      .run();
    const job = await queue();
    const started = startMediaCatalog(db, job)!;
    db.delete(tagsOnBookmarks).run();
    finishMediaCatalog(db, job, "success", result, started.tags);
    expect(catalogSnapshot(db, "u1", "b1").tags).toEqual(["studio"]);
  });

  test("changing an attachment or source makes an in-flight answer stale", async () => {
    const job = await queue();
    startMediaCatalog(db, job);
    db.update(bookmarkLinks).set({ description: "Changed caption" }).run();
    finishMediaCatalog(db, job, "success", result);
    expect(catalogSnapshot(db, "u1", "b1").bookmark.mediaAi).toMatchObject({
      status: "stale",
    });
    expect(catalogSnapshot(db, "u1", "b1").tags).toHaveLength(0);
  });

  test("quota remains consumed after a timeout, including after deleting its bookmark", async () => {
    serverConfig.mediaAi.dailyRequests = 1;
    const job = await queue();
    startMediaCatalog(db, job);
    finishMediaCatalog(db, job, "timeout");
    expect(await requestMediaCatalog(db, "u1", "b1")).toBeNull();
    const retry = await requestMediaCatalog(db, "u1", "b1", { retry: true });
    expect(startMediaCatalog(db, { ...job, runId: retry!.runId })).toBeNull();
    expect(catalogSnapshot(db, "u1", "b1").bookmark.mediaAi?.status).toBe(
      "quota_exceeded",
    );
    db.delete(bookmarks).where(eq(bookmarks.id, "b1")).run();
    expect(db.select().from(mediaAiRequests).all()).toHaveLength(1);
  });

  test("a lost worker can be retried manually; its late response cannot overwrite the retry", async () => {
    const old = await queue();
    startMediaCatalog(db, old);
    const state = catalogSnapshot(db, "u1", "b1").bookmark.mediaAi!;
    db.update(bookmarks)
      .set({ mediaAi: { ...state, updatedAt: new Date(0).toISOString() } })
      .run();
    const retry = await requestMediaCatalog(db, "u1", "b1", { retry: true });
    finishMediaCatalog(db, old, "success", result);
    expect(catalogSnapshot(db, "u1", "b1").bookmark.mediaAi?.runId).toBe(
      retry?.runId,
    );
    expect(
      catalogSnapshot(db, "u1", "b1").bookmark.mediaAi?.result,
    ).toBeUndefined();
  });
});
