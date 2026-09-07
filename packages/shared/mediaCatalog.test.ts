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
