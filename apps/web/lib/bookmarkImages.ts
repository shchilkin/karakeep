import type { ZBookmark } from "@karakeep/shared/types/bookmarks";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

export type BookmarkImage = ZBookmark["assets"][number];

export type BookmarkMedia = BookmarkImage & { video?: { posterId?: string } };

/** Ordered originals; generated video posters never become extra slides. */
export function getBookmarkMedia(bookmark: ZBookmark): BookmarkMedia[] {
  if (bookmark.content.type !== BookmarkTypes.LINK) return [];
  const originals = bookmark.assets.filter(
    (asset) => asset.assetType === "userUploaded",
  );
  const seen = new Set<string>();
  return originals
    .filter((asset) => {
      if (
        !asset.fileName ||
        /\.poster\.jpg$/i.test(asset.fileName) ||
        !/\.(avif|gif|jpe?g|png|webp|mp4)$/i.test(asset.fileName) ||
        seen.has(asset.id)
      )
        return false;
      seen.add(asset.id);
      return true;
    })
    .map(
      (asset): BookmarkMedia =>
        /\.mp4$/i.test(asset.fileName ?? "")
          ? {
              ...asset,
              video: {
                posterId: originals.find(
                  (poster) =>
                    poster.fileName ===
                    asset.fileName?.replace(/\.mp4$/i, ".poster.jpg"),
                )?.id,
              },
            }
          : asset,
    )
    .sort((a, b) =>
      (a.fileName ?? "").localeCompare(b.fileName ?? "", "en", {
        numeric: true,
      }),
    );
}

export function getMediaCoverId(media: BookmarkMedia): string | undefined {
  return media.video ? media.video.posterId : media.id;
}

/** Original image attachments, excluding crawler screenshots, banners and video posters. */
export function getBookmarkImages(bookmark: ZBookmark): BookmarkImage[] {
  return getBookmarkMedia(bookmark).filter((media) => !media.video);
}
