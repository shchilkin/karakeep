import { eq } from "drizzle-orm";
import { bookmarks } from "@karakeep/db/schema";
import { zMediaCatalogState } from "@karakeep/shared/mediaCatalog";
import { concealSensitiveBookmark } from "@karakeep/shared/sensitiveVisibility";
import { beforeEach, expect, test } from "vitest";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import type { CustomTestContext } from "../testUtils";
import { defaultBeforeEach } from "../testUtils";
beforeEach<CustomTestContext>(defaultBeforeEach(true));

test<CustomTestContext>("manual categories persist, enforce ownership, and survive old-client updates", async ({
  apiCallers,
}) => {
  const api = apiCallers[0].bookmarks;
  const b = await api.createBookmark({
    type: BookmarkTypes.LINK,
    url: "https://example.com/one",
  });
  await api.updateBookmark({
    bookmarkId: b.id,
    sensitiveCategories: ["explicit_sexual", "nudity"],
  });
  await api.updateBookmark({
    bookmarkId: b.id,
    title: "Old client title",
    note: "Note",
  });
  expect(
    (await api.getBookmark({ bookmarkId: b.id })).sensitiveCategories,
  ).toEqual(["explicit_sexual", "nudity"]);
  expect((await api.getBookmarks({})).bookmarks[0].sensitiveCategories).toEqual(
    ["explicit_sexual", "nudity"],
  );
  await expect(
    apiCallers[1].bookmarks.updateBookmark({
      bookmarkId: b.id,
      sensitiveCategories: [],
    }),
  ).rejects.toThrow();
  await api.updateBookmark({ bookmarkId: b.id, sensitiveCategories: [] });
  expect((await api.getBookmarks({ sensitive: true })).bookmarks).toHaveLength(
    0,
  );
});

test<CustomTestContext>("sensitive filter applies before pagination and stays scoped to the owner", async ({
  apiCallers,
}) => {
  const api = apiCallers[0].bookmarks;
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const b = await api.createBookmark({
      type: BookmarkTypes.LINK,
      url: `https://example.com/${i}`,
    });
    if (i % 2 === 0) {
      await api.updateBookmark({
        bookmarkId: b.id,
        sensitiveCategories: ["revealing_clothing"],
      });
      ids.push(b.id);
    }
  }
  const other = await apiCallers[1].bookmarks.createBookmark({
    type: BookmarkTypes.LINK,
    url: "https://example.com/other",
  });
  await apiCallers[1].bookmarks.updateBookmark({
    bookmarkId: other.id,
    sensitiveCategories: ["nudity"],
  });
  const first = await api.getBookmarks({
    sensitive: true,
    limit: 2,
    useCursorV2: true,
  });
  expect(first.bookmarks).toHaveLength(2);
  const second = await api.getBookmarks({
    sensitive: true,
    limit: 2,
    useCursorV2: true,
    cursor: first.nextCursor,
  });
  expect(
    [...first.bookmarks, ...second.bookmarks].map((b) => b.id).sort(),
  ).toEqual(ids.sort());
  expect(second.nextCursor).toBeNull();
  expect((await api.getBookmarks({ sensitive: false })).bookmarks).toHaveLength(
    3,
  );
  expect((await api.getBookmarks({})).bookmarks).toHaveLength(6);
});

test<CustomTestContext>("native observations enter the paginated section, manual clear wins, and null restores detection", async ({
  apiCallers,
  unauthedAPICaller,
  db,
}) => {
  const api = apiCallers[0].bookmarks;
  const ids = [];
  const state = zMediaCatalogState.parse({
    runId: "r1",
    fingerprint: "f1",
    model: "catalog",
    status: "local_review",
    allowPreview: true,
    updatedAt: new Date().toISOString(),
    localCheck: {
      scope: "outgoing_images_only",
      frames: [
        {
          model: "google/shieldgemma-2-4b-it",
          revision: "eaf60452b5fc41a911338a022e628b0c15283897",
          policy: "shieldgemma-native-v1",
          precision: "bf16",
          status: "complete",
          categories: ["sexual"],
          scores: { sexual: 0.9, dangerous: 0.01, violence: 0.01 },
          sha256: "a".repeat(64),
        },
      ],
    },
  });
  for (let n = 0; n < 5; n++) {
    const b = await api.createBookmark({
      type: BookmarkTypes.LINK,
      url: `https://example.test/auto-${n}`,
    });
    if (n < 3) {
      db.update(bookmarks)
        .set({ mediaAi: state })
        .where(eq(bookmarks.id, b.id))
        .run();
      ids.push(b.id);
    }
  }
  const other = await apiCallers[1].bookmarks.createBookmark({
    type: BookmarkTypes.LINK,
    url: "https://example.test/other-auto",
  });
  db.update(bookmarks)
    .set({ mediaAi: state })
    .where(eq(bookmarks.id, other.id))
    .run();
  const first = await api.getBookmarks({
    sensitive: true,
    limit: 2,
    useCursorV2: true,
  });
  const second = await api.getBookmarks({
    sensitive: true,
    limit: 2,
    useCursorV2: true,
    cursor: first.nextCursor,
  });
  expect(
    [...first.bookmarks, ...second.bookmarks].map((b) => b.id).sort(),
  ).toEqual(ids.sort());
  expect(second.nextCursor).toBeNull();
  expect((await api.getBookmarks({ sensitive: false })).bookmarks).toHaveLength(
    2,
  );
  expect(
    first.bookmarks.every((b) => concealSensitiveBookmark(b, "balanced")),
  ).toBe(true);
  await api.updateBookmark({ bookmarkId: ids[0], sensitiveCategories: [] });
  expect((await api.getBookmarks({ sensitive: true })).bookmarks).toHaveLength(
    2,
  );
  expect(
    concealSensitiveBookmark(
      await api.getBookmark({ bookmarkId: ids[0] }),
      "work",
    ),
  ).toBe(false);
  await api.updateBookmark({ bookmarkId: ids[0], sensitiveCategories: null });
  await api.updateBookmark({ bookmarkId: ids[0], note: "Old client update" });
  expect((await api.getBookmarks({ sensitive: true })).bookmarks).toHaveLength(
    3,
  );
  await expect(
    unauthedAPICaller.bookmarks.getBookmarks({ sensitive: true }),
  ).rejects.toThrow();
});
