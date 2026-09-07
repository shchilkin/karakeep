import { expect, test } from "vitest";
import {
  catalogInput,
  catalogSourceText,
  evenlySample,
  normalizeCatalogTags,
} from "./mediaCatalog";
import { BookmarkTypes } from "./types/bookmarks";

test("carousel selection excludes poster thumbnails and explicitly marks a sample", () => {
  const input = catalogInput({
    content: {
      type: BookmarkTypes.LINK,
      url: "https://instagram.com/p/example",
    },
    assets: [
      { id: "poster", fileName: "001.poster.jpg", assetType: "userUploaded" },
      ...Array.from({ length: 6 }, (_, i) => ({
        id: String(i),
        fileName: `00${i}.jpg`,
        assetType: "userUploaded" as const,
      })),
    ],
  });
  expect(input?.media).toMatchObject({ kind: "carousel", asset_count: 6 });
  expect(evenlySample(input!.assets).map((a) => a.id)).toEqual(["0", "3", "5"]);
});

test("source boilerplate and URLs do not become visual context", () => {
  expect(catalogSourceText("Post isn’t available • Instagram", 500)).toBe("");
  expect(catalogSourceText("(5) Instagram", 500)).toBe("");
  expect(
    catalogSourceText("Useful caption https://example.test/private", 500),
  ).toBe("Useful caption");
});

test("tag normalization reuses existing names, removes duplicates and operational tags", () => {
  expect(
    normalizeCatalogTags(
      ["Studio Portrait", "studio-portrait", "social-media-archived", "NSFW"],
      ["studio_portrait"],
    ),
  ).toEqual(["studio_portrait"]);
});

test("a long existing display name cannot invalidate bounded catalog results", () => {
  expect(
    normalizeCatalogTags(["portrait"], [`Portrait${"_".repeat(90)}`]),
  ).toEqual(["portrait"]);
});

test("archived text-only X posts are eligible, ordinary links and mismatched copies are not", () => {
  const bookmark = {
    content: {
      type: BookmarkTypes.LINK as const,
      url: "https://x.com/author/status/12345",
      description: "An archived post about typography.",
    },
    assets: [
      {
        id: "source-copy",
        assetType: "userUploaded" as const,
        fileName: "x_12345_999_abcdef123456.txt",
      },
    ],
  };
  expect(catalogInput(bookmark)).toMatchObject({
    assets: [],
    media: { kind: "text", coverage: "archived_text", asset_count: 0 },
  });
  expect(
    catalogInput(
      {
        ...bookmark,
        content: { ...bookmark.content, imageAssetId: "generic-x-logo" },
      },
      true,
    )?.media.kind,
  ).toBe("text");
  expect(catalogInput({ ...bookmark, assets: [] })).toBeNull();
  expect(
    catalogInput({
      ...bookmark,
      content: {
        ...bookmark.content,
        url: "https://example.com/author/status/12345",
      },
    }),
  ).toBeNull();
  expect(
    catalogInput({
      ...bookmark,
      content: {
        ...bookmark.content,
        url: "https://x.com/author/status/98765",
      },
    }),
  ).toBeNull();
  expect(
    catalogInput({
      ...bookmark,
      content: { ...bookmark.content, description: " " },
    }),
  ).toBeNull();
  expect(
    catalogInput({
      ...bookmark,
      assets: [
        ...bookmark.assets,
        {
          id: "photo",
          assetType: "userUploaded",
          fileName: "x_12345_001_abcdef123456.jpg",
        },
      ],
    })?.media.kind,
  ).toBe("image");
});
