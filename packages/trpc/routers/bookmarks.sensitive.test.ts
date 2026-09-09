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
