import { expect, test } from "vitest";
import type { ZBookmark } from "../types/bookmarks";
import { BookmarkTypes } from "../types/bookmarks";
import { getBookmarkTitle } from "./bookmarkUtils";

function bookmark(overrides: Partial<ZBookmark> = {}): ZBookmark {
  return {
    id: "post",
    userId: "owner",
    createdAt: new Date(),
    modifiedAt: null,
    archived: false,
    favourited: false,
    taggingStatus: null,
    summarizationStatus: null,
    embeddingStatus: null,
    tags: [],
    assets: [],
    title: "Stories • Instagram",
    titleSource: "captured",
    content: {
      type: BookmarkTypes.LINK,
      url: "https://instagram.com/p/example",
      title: "Instagram",
    },
    mediaAi: {
      runId: "one",
      fingerprint: "originals",
      model: "test",
      status: "success",
      updatedAt: new Date().toISOString(),
      allowPreview: false,
      result: {
        title: "Studio portrait",
        summary: "A studio portrait.",
        tags: ["portrait"],
      },
    },
    ...overrides,
  };
}

test("a generated title replaces only a captured title", () => {
  expect(getBookmarkTitle(bookmark())).toBe("Studio portrait");
  for (const titleSource of ["manual", "unknown", undefined] as const) {
    expect(getBookmarkTitle(bookmark({ titleSource }))).toBe(
      "Stories • Instagram",
    );
  }
});

test("captured titles survive failed or unavailable analysis", () => {
  expect(getBookmarkTitle(bookmark({ mediaAi: null }))).toBe(
    "Stories • Instagram",
  );
  expect(getBookmarkTitle(bookmark({ title: null, mediaAi: null }))).toBe(
    "Instagram",
  );
});

test("clearing a manual title restores automatic naming", () => {
  expect(
    getBookmarkTitle(bookmark({ titleSource: "manual", title: "  " })),
  ).toBe("Studio portrait");
  expect(
    getBookmarkTitle(
      bookmark({ titleSource: "manual", title: "My reference" }),
    ),
  ).toBe("My reference");
});
