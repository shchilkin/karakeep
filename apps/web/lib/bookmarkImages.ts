import type { ZBookmark } from "@karakeep/shared/types/bookmarks";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

export type BookmarkImage = ZBookmark["assets"][number];

/** Original image attachments, excluding crawler screenshots and banners. */
export function getBookmarkImages(bookmark: ZBookmark): BookmarkImage[] {
  if (bookmark.content.type !== BookmarkTypes.LINK) return [];

  const seen = new Set<string>();
  return bookmark.assets
    .filter((asset) => {
      if (
        asset.assetType !== "userUploaded" ||
        !asset.fileName ||
        !/\.(avif|gif|jpe?g|png|webp)$/i.test(asset.fileName) ||
        seen.has(asset.id)
      ) {
        return false;
      }
      seen.add(asset.id);
      return true;
    })
    .sort((a, b) =>
      (a.fileName ?? "").localeCompare(b.fileName ?? "", "en", {
        numeric: true,
      }),
    );
}
