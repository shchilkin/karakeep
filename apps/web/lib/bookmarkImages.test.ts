import { describe, expect, it } from "vitest";

import type { ZBookmark } from "@karakeep/shared/types/bookmarks";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import { getBookmarkImages } from "./bookmarkImages";

function bookmark(assets: ZBookmark["assets"]): ZBookmark {
  return {
    id: "post",
    userId: "owner",
    createdAt: new Date("2026-01-01"),
    modifiedAt: null,
    archived: false,
    favourited: false,
    taggingStatus: null,
    summarizationStatus: null,
    embeddingStatus: null,
    tags: [],
    assets,
    content: {
      type: BookmarkTypes.LINK,
      url: "https://www.instagram.com/p/example/",
    },
  };
}

describe("saved bookmark images", () => {
  it("selects original photos in natural filename order without changing the bookmark", () => {
    const post = bookmark([
      { id: "ten", assetType: "userUploaded", fileName: "post_10.jpg" },
      { id: "banner", assetType: "bannerImage", fileName: "banner.jpg" },
      { id: "two", assetType: "userUploaded", fileName: "post_2.JPG" },
      { id: "screenshot", assetType: "screenshot", fileName: "screenshot.png" },
      { id: "one", assetType: "userUploaded", fileName: "post_1.webp" },
    ]);
    const originalIds = post.assets.map((asset) => asset.id);
    expect(getBookmarkImages(post).map((asset) => asset.id)).toEqual([
      "one",
      "two",
      "ten",
    ]);
    expect(post.assets.map((asset) => asset.id)).toEqual(originalIds);
  });

  it("excludes unsupported files and deduplicates asset IDs", () => {
    const photo = {
      id: "photo",
      assetType: "userUploaded" as const,
      fileName: "photo.png",
    };
    expect(
      getBookmarkImages(
        bookmark([
          photo,
          photo,
          { id: "pdf", assetType: "userUploaded", fileName: "paper.pdf" },
          { id: "video", assetType: "userUploaded", fileName: "clip.mp4" },
          { id: "svg", assetType: "userUploaded", fileName: "image.svg" },
          { id: "unknown", assetType: "userUploaded" },
        ]),
      ),
    ).toEqual([photo]);
  });

  it("works for other link sources without treating standalone files as carousels", () => {
    const post = bookmark([
      { id: "photo", assetType: "userUploaded", fileName: "photo.avif" },
    ]);
    post.content = {
      type: BookmarkTypes.LINK,
      url: "https://x.com/example/status/123",
    };
    expect(getBookmarkImages(post)).toHaveLength(1);
    post.content = {
      type: BookmarkTypes.ASSET,
      assetType: "image",
      assetId: "photo",
    };
    expect(getBookmarkImages(post)).toEqual([]);
  });
});
