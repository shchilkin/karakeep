import { describe, expect, it } from "vitest";

import type { ZBookmark } from "@karakeep/shared/types/bookmarks";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import { getBookmarkImages } from "./bookmarkImages";
import { getBookmarkMedia, getMediaCoverId } from "./bookmarkImages";
import { getAssetThumbnailUrl } from "@karakeep/shared/utils/assetUtils";
import {
  bookmarkCardImageRatio,
  bookmarkCardCoverDimensions,
} from "./bookmarkCardHeight";

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
  it("estimates the displayed saved cover instead of a generic banner", () => {
    const post = bookmark([
      {
        id: "photo",
        assetType: "userUploaded",
        fileName: "post_1.jpg",
        width: 600,
        height: 900,
      },
      {
        id: "banner",
        assetType: "bannerImage",
        fileName: "banner.jpg",
        width: 400,
        height: 400,
      },
    ]);
    expect(bookmarkCardImageRatio(post)).toBe(1.5);
    post.content = {
      type: BookmarkTypes.ASSET,
      assetType: "image",
      assetId: "banner",
    };
    expect(bookmarkCardImageRatio(post)).toBe(1);
  });
  it("uses the video poster's dimensions and the card fallback for legacy metadata", () => {
    const post = bookmark([
      { id: "video", assetType: "video", fileName: "direct-video-test.mp4" },
      {
        id: "poster",
        assetType: "bannerImage",
        fileName: "direct-video-test.poster.jpg",
        width: 1920,
        height: 1080,
      },
    ]);
    expect(bookmarkCardImageRatio(post)).toBe(1080 / 1920);
    post.assets[1].width = null;
    expect(bookmarkCardImageRatio(post)).toBe(3 / 4);
    expect(bookmarkCardImageRatio(bookmark([]))).toBeUndefined();
  });
  it.each(["mp4", "webm", "mkv"])(
    "uses a saved direct %s video and its first frame in the gallery",
    (extension) => {
      const post = bookmark([
        {
          id: "video",
          assetType: "video",
          fileName: `direct-video-test.${extension}`,
        },
        {
          id: "poster",
          assetType: "bannerImage",
          fileName: "direct-video-test.poster.jpg",
        },
        { id: "screen", assetType: "screenshot", fileName: "screenshot.jpg" },
      ]);
      const media = getBookmarkMedia(post);
      expect(media).toHaveLength(1);
      expect(media[0]?.id).toBe("video");
      expect(getMediaCoverId(media[0]!)).toBe("poster");
      expect(getBookmarkImages(post)).toEqual([]);
    },
  );
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

it("pairs video posters without counting them as carousel slides", async () => {
  const { getBookmarkMedia, getMediaCoverId } =
    await import("./bookmarkImages");
  const post = bookmark([
    {
      id: "poster",
      assetType: "userUploaded",
      fileName: "instagram_post_001_aaaaaaaaaaaa.poster.jpg",
    },
    {
      id: "photo",
      assetType: "userUploaded",
      fileName: "instagram_post_002_bbbbbbbbbbbb.jpg",
    },
    {
      id: "video",
      assetType: "userUploaded",
      fileName: "instagram_post_001_aaaaaaaaaaaa.mp4",
    },
    {
      id: "orphan",
      assetType: "userUploaded",
      fileName: "instagram_post_003_cccccccccccc.poster.jpg",
    },
  ]);
  const media = getBookmarkMedia(post);
  expect(media.map((item) => item.id)).toEqual(["video", "photo"]);
  expect(getMediaCoverId(media[0])).toBe("poster");
  expect(getBookmarkImages(post).map((item) => item.id)).toEqual(["photo"]);
});

it("keeps conceal/reveal geometry tied to the current cover and prefers stored dimensions", () => {
  const b = bookmark([
    { id: "photo", assetType: "userUploaded", fileName: "001.jpg" },
  ]);
  const cached = {
    src: getAssetThumbnailUrl("photo"),
    width: 600,
    height: 900,
  };
  expect(bookmarkCardCoverDimensions(b, cached)).toEqual({
    width: 600,
    height: 900,
  });
  expect(
    bookmarkCardCoverDimensions(b, { ...cached, src: "old-cover" }),
  ).toBeUndefined();
  b.assets[0].width = 1200;
  b.assets[0].height = 800;
  expect(bookmarkCardCoverDimensions(b, cached)).toEqual({
    width: 1200,
    height: 800,
  });
});
