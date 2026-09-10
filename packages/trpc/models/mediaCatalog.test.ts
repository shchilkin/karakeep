import { beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { openSqliteDatabase } from "@karakeep/db/sqlite";
import * as dbSchema from "@karakeep/db/schema";
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
import { MediaCatalogQueue } from "@karakeep/shared-server";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import { getBookmarkTitle } from "@karakeep/shared/utils/bookmarkUtils";
import { catalogInput } from "@karakeep/shared/mediaCatalog";
import {
  catalogSnapshot,
  finishMediaCatalog,
  requestMediaCatalog,
  startMediaCatalog,
  continueMediaCatalog,
  recoverLocalMediaCatalog,
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
    localMode: "off",
    apiKey: "synthetic",
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
  test("a saved direct video queues automatic analysis without waiting for a social archive tag", async () => {
    db.delete(assets).run();
    db.insert(assets)
      .values({
        id: "video",
        userId: "u1",
        bookmarkId: "b1",
        assetType: AssetTypes.LINK_VIDEO,
        fileName: "direct-video-test.webm",
      })
      .run();
    const state = await requestMediaCatalog(db, "u1", "b1", {
      automatic: true,
    });
    expect(state?.status).toBe("pending");
    expect(catalogSnapshot(db, "u1", "b1").input?.media.kind).toBe("video");
    Object.assign(serverConfig.mediaAi, { autoNew: false });
    expect(
      startMediaCatalog(db, {
        bookmarkId: "b1",
        userId: "u1",
        runId: state!.runId,
      }),
    ).toBeNull();
    expect(db.select().from(mediaAiRequests).all()).toHaveLength(0);
  });
  test("all lifecycle transactions reserve the WAL writer before taking a snapshot", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "media-catalog-wal-"));
    const file = path.join(directory, "db.sqlite");
    await db.$client.backup(file);
    const connection = openSqliteDatabase(file, {
      readOnly: false,
      walMode: true,
    });
    const competing = openSqliteDatabase(file, {
      readOnly: false,
      walMode: true,
    });
    competing.pragma("busy_timeout = 0");
    try {
      db = drizzle(connection, { schema: dbSchema });
      const transaction = db.transaction.bind(db);
      let reservations = 0;
      const spy = vi
        .spyOn(db, "transaction")
        .mockImplementation((run, options) =>
          transaction((tx) => {
            expect(() =>
              competing
                .prepare(
                  "UPDATE user SET name = 'Concurrent writer' WHERE id = 'u1'",
                )
                .run(),
            ).toThrow(/locked/);
            reservations++;
            return run(tx);
          }, options),
        );
      try {
        const job = await queue();
        startMediaCatalog(db, job);
        finishMediaCatalog(db, job, "success", result);
        expect(reservations).toBe(3);
        expect(catalogSnapshot(db, "u1", "b1").bookmark.mediaAi?.status).toBe(
          "success",
        );
      } finally {
        spy.mockRestore();
      }
    } finally {
      competing.close();
      connection.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

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

  test("a completed X text archive queues and finishes analysis without image assets", async () => {
    db.update(bookmarkLinks)
      .set({
        url: "https://x.com/author/status/12345",
        description: "A source post about typography.",
      })
      .run();
    db.update(assets)
      .set({
        fileName: "x_12345_999_abcdef123456.txt",
        contentType: "text/plain",
      })
      .run();
    expect(
      await requestMediaCatalog(db, "u1", "b1", { automatic: true }),
    ).toBeNull();
    await getApiCaller(db, "u1").bookmarks.updateTags({
      bookmarkId: "b1",
      attach: [{ tagName: "social-media-archived" }],
      detach: [],
    });
    const pending = catalogSnapshot(db, "u1", "b1");
    expect(pending.bookmark.mediaAi?.status).toBe("pending");
    expect(pending.input).toMatchObject({
      assets: [],
      media: { kind: "text", coverage: "archived_text" },
    });
    const job = {
      bookmarkId: "b1",
      userId: "u1",
      runId: pending.bookmark.mediaAi!.runId,
    };
    expect(startMediaCatalog(db, job)).not.toBeNull();
    finishMediaCatalog(db, job, "success", {
      title: "A note about typography",
      summary: "The post discusses typography.",
      tags: ["typography", "design"],
    });
    expect(catalogSnapshot(db, "u1", "b1").bookmark.mediaAi?.status).toBe(
      "success",
    );
    expect(db.select().from(mediaAiRequests).all()).toHaveLength(1);
  });

  test.each(["user", "server"])(
    "queued automatic analysis honors a later %s opt-out without reserving an attempt",
    async (gate) => {
      await getApiCaller(db, "u1").bookmarks.updateTags({
        bookmarkId: "b1",
        attach: [{ tagName: "social-media-archived" }],
        detach: [],
      });
      const state = catalogSnapshot(db, "u1", "b1").bookmark.mediaAi!;
      if (gate === "user")
        db.update(users)
          .set({ autoTaggingEnabled: false })
          .where(eq(users.id, "u1"))
          .run();
      else serverConfig.mediaAi.autoNew = false;
      expect(
        startMediaCatalog(db, {
          bookmarkId: "b1",
          userId: "u1",
          runId: state.runId,
        }),
      ).toBeNull();
      expect(catalogSnapshot(db, "u1", "b1").bookmark.mediaAi?.status).toBe(
        "cancelled",
      );
      expect(db.select().from(mediaAiRequests).all()).toHaveLength(0);
      const manual = await requestMediaCatalog(db, "u1", "b1", { retry: true });
      expect(
        startMediaCatalog(db, {
          bookmarkId: "b1",
          userId: "u1",
          runId: manual!.runId,
        }),
      ).not.toBeNull();
    },
  );

  test("reuses existing Cyrillic tags and reports only newly attached ids", async () => {
    const portrait = db
      .insert(bookmarkTags)
      .values({ userId: "u1", name: "Портрет" })
      .returning()
      .get();
    const studio = db
      .insert(bookmarkTags)
      .values({ userId: "u1", name: "Студия" })
      .returning()
      .get();
    db.insert(tagsOnBookmarks)
      .values({ bookmarkId: "b1", tagId: studio.id, attachedBy: "human" })
      .run();
    const job = await queue();
    startMediaCatalog(db, job);
    expect(
      finishMediaCatalog(db, job, "success", {
        ...result,
        tags: ["портрет", "студия"],
      }),
    ).toEqual({ attachedTagIds: [portrait.id] });
    const saved = await getApiCaller(db, "u1").bookmarks.getBookmark({
      bookmarkId: "b1",
    });
    expect(saved.tags).toEqual(
      expect.arrayContaining([
        { id: portrait.id, name: "Портрет", attachedBy: "ai" },
        { id: studio.id, name: "Студия", attachedBy: "human" },
      ]),
    );
    expect(db.select().from(bookmarkTags).all()).toHaveLength(2);
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

import { zLocalCheckResult } from "@karakeep/shared/mediaLocalCheck";

const localCheck = (categories: string[] = [], status = "complete") =>
  zLocalCheckResult.parse({
    scope: "outgoing_images_only" as const,
    frames: [
      {
        model: "google/shieldgemma-2-4b-it" as const,
        revision: "eaf60452b5fc41a911338a022e628b0c15283897" as const,
        policy: "shieldgemma-native-v1" as const,
        precision: "bf16" as const,
        status,
        categories,
        scores:
          status === "complete"
            ? {
                dangerous: categories.includes("dangerous") ? 0.9 : 0.01,
                sexual: categories.includes("sexual") ? 0.9 : 0.01,
                violence: categories.includes("violence") ? 0.9 : 0.01,
              }
            : null,
        sha256: "a".repeat(64),
      },
    ],
  });

describe("local admission before cloud reservation", () => {
  test.each([false, true])(
    "runner-level failure preserves whether cloud was admitted: %s",
    async (admitted) => {
      serverConfig.mediaAi.localMode = "enforce";
      const job = await queue();
      startMediaCatalog(db, job);
      if (admitted) continueMediaCatalog(db, job, localCheck());
      finishMediaCatalog(db, job, "failed");
      expect(catalogSnapshot(db, "u1", "b1").bookmark.mediaAi?.status).toBe(
        admitted ? "failed" : "local_failed",
      );
      expect(db.select().from(mediaAiRequests).all()).toHaveLength(
        admitted ? 1 : 0,
      );
    },
  );

  test("an initial enqueue failure leaves a recoverable local checkpoint", async () => {
    serverConfig.mediaAi.localMode = "review";
    vi.mocked(MediaCatalogQueue.enqueue).mockRejectedValueOnce(
      new Error("queue offline"),
    );
    await expect(requestMediaCatalog(db, "u1", "b1")).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    const state = catalogSnapshot(db, "u1", "b1").bookmark.mediaAi!;
    expect(state.status).toBe("local_failed");
    await recoverLocalMediaCatalog(db, Date.now() + 700_000);
    const recovered = catalogSnapshot(db, "u1", "b1").bookmark.mediaAi!;
    expect(recovered.status).toBe("pending");
    expect(recovered.runId).not.toBe(state.runId);
    expect(db.select().from(mediaAiRequests).all()).toHaveLength(0);
  });

  test("review runs without a cloud key and never consumes quota or applies manual categories", async () => {
    Object.assign(serverConfig.mediaAi, {
      localMode: "review",
      apiKey: undefined,
    });
    const job = await queue();
    expect(startMediaCatalog(db, job)).not.toBeNull();
    expect(catalogSnapshot(db, "u1", "b1").bookmark.mediaAi?.status).toBe(
      "checking_local",
    );
    expect(continueMediaCatalog(db, job, localCheck())).toBe(false);
    const saved = catalogSnapshot(db, "u1", "b1").bookmark;
    expect(saved.mediaAi?.status).toBe("local_review");
    expect(saved.mediaAi?.localCheck?.frames).toHaveLength(1);
    expect(saved.sensitiveCategories).toBeNull();
    expect(db.select().from(mediaAiRequests).all()).toHaveLength(0);
  });

  test.each([["sexual"], ["dangerous"], ["violence"]])(
    "marked %s never consumes cloud quota",
    async (category) => {
      serverConfig.mediaAi.localMode = "enforce";
      const job = await queue();
      startMediaCatalog(db, job);
      expect(continueMediaCatalog(db, job, localCheck([category]))).toBe(false);
      expect(catalogSnapshot(db, "u1", "b1").bookmark.mediaAi?.status).toBe(
        "local_only",
      );
      expect(db.select().from(mediaAiRequests).all()).toHaveLength(0);
    },
  );

  test("unknown and manual marks cannot be bypassed by a local clean result", async () => {
    serverConfig.mediaAi.localMode = "enforce";
    let job = await queue();
    startMediaCatalog(db, job);
    expect(continueMediaCatalog(db, job, localCheck([], "unknown"))).toBe(
      false,
    );
    const retry = await requestMediaCatalog(db, "u1", "b1", { retry: true });
    job = { ...job, runId: retry!.runId };
    startMediaCatalog(db, job);
    db.update(bookmarks)
      .set({ sensitiveCategories: ["explicit_sexual"] })
      .run();
    expect(continueMediaCatalog(db, job, localCheck())).toBe(false);
    expect(db.select().from(mediaAiRequests).all()).toHaveLength(0);
  });

  test("admitted frames reserve exactly once; saved checkpoint survives a cloud failure and manual retry", async () => {
    serverConfig.mediaAi.localMode = "enforce";
    const job = await queue();
    startMediaCatalog(db, job);
    expect(db.select().from(mediaAiRequests).all()).toHaveLength(0);
    expect(continueMediaCatalog(db, job, localCheck())).toBe(true);
    expect(continueMediaCatalog(db, job, localCheck())).toBe(false);
    expect(db.select().from(mediaAiRequests).all()).toHaveLength(1);
    finishMediaCatalog(db, job, "refused");
    expect(finishMediaCatalog(db, job, "success", result)).toBe(false);
    const retry = await requestMediaCatalog(db, "u1", "b1", { retry: true });
    expect(retry?.localCheck?.frames[0].categories).toEqual([]);
    expect(retry?.localCheck?.frames[0]).toHaveProperty("scores");
  });

  test("changing input or disabling auto analysis during the local stage prevents dispatch", async () => {
    serverConfig.mediaAi.localMode = "enforce";
    let job = await queue();
    startMediaCatalog(db, job);
    db.update(bookmarkLinks).set({ description: "New pixels context" }).run();
    expect(continueMediaCatalog(db, job, localCheck())).toBe(false);
    expect(catalogSnapshot(db, "u1", "b1").bookmark.mediaAi?.status).toBe(
      "stale",
    );
    const retry = await requestMediaCatalog(db, "u1", "b1", { retry: true });
    job = { ...job, runId: retry!.runId };
    startMediaCatalog(db, job);
    serverConfig.mediaAi.enabled = false;
    expect(continueMediaCatalog(db, job, localCheck())).toBe(false);
    expect(db.select().from(mediaAiRequests).all()).toHaveLength(0);
  });

  test("recovery rotates interrupted local runs and rejects their late completion, with a retry bound", async () => {
    serverConfig.mediaAi.localMode = "enforce";
    const old = await queue();
    startMediaCatalog(db, old);
    const expire = () => {
      const current = catalogSnapshot(db, "u1", "b1").bookmark.mediaAi!;
      db.update(bookmarks)
        .set({ mediaAi: { ...current, updatedAt: new Date(0).toISOString() } })
        .run();
    };
    expire();
    await recoverLocalMediaCatalog(db);
    expect(continueMediaCatalog(db, old, localCheck())).toBe(false);
    expect(
      catalogSnapshot(db, "u1", "b1").bookmark.mediaAi?.localRecoveries,
    ).toBe(1);
    const next = catalogSnapshot(db, "u1", "b1").bookmark.mediaAi!;
    startMediaCatalog(db, { ...old, runId: next.runId });
    expire();
    await recoverLocalMediaCatalog(db);
    const last = catalogSnapshot(db, "u1", "b1").bookmark.mediaAi!;
    startMediaCatalog(db, { ...old, runId: last.runId });
    expire();
    await recoverLocalMediaCatalog(db);
    expect(catalogSnapshot(db, "u1", "b1").bookmark.mediaAi?.status).toBe(
      "local_failed",
    );
    expect(db.select().from(mediaAiRequests).all()).toHaveLength(0);
  });

  test("a long pending backlog retains its identity and does not consume local retries", async () => {
    serverConfig.mediaAi.localMode = "review";
    const job = await queue();
    for (let scan = 0; scan < 4; scan++) {
      const state = catalogSnapshot(db, "u1", "b1").bookmark.mediaAi!;
      db.update(bookmarks)
        .set({ mediaAi: { ...state, updatedAt: new Date(0).toISOString() } })
        .run();
      await recoverLocalMediaCatalog(db);
      const waiting = catalogSnapshot(db, "u1", "b1").bookmark.mediaAi!;
      expect(waiting).toMatchObject({ runId: job.runId, status: "pending" });
      expect(waiting.localRecoveries ?? 0).toBe(0);
    }
    expect(startMediaCatalog(db, job)).not.toBeNull();
    expect(continueMediaCatalog(db, job, localCheck())).toBe(false);
    expect(catalogSnapshot(db, "u1", "b1").bookmark.mediaAi?.status).toBe(
      "local_review",
    );
  });

  test("recovery never repeats a paid cloud attempt after process loss", async () => {
    serverConfig.mediaAi.localMode = "enforce";
    const job = await queue();
    startMediaCatalog(db, job);
    continueMediaCatalog(db, job, localCheck());
    const state = catalogSnapshot(db, "u1", "b1").bookmark.mediaAi!;
    db.update(bookmarks)
      .set({ mediaAi: { ...state, updatedAt: new Date(0).toISOString() } })
      .run();
    await recoverLocalMediaCatalog(db);
    expect(catalogSnapshot(db, "u1", "b1").bookmark.mediaAi).toMatchObject({
      status: "timeout",
      runId: job.runId,
    });
    expect(db.select().from(mediaAiRequests).all()).toHaveLength(1);
    expect(finishMediaCatalog(db, job, "success", result)).toBe(false);
  });
});
