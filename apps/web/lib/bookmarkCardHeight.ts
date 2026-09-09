import type { ZBookmark } from "@karakeep/shared/types/bookmarks";
import { getAssetThumbnailUrl } from "@karakeep/shared/utils/assetUtils";
import { getBookmarkLinkImageUrl } from "@karakeep/shared/utils/bookmarkUtils";
import { getBookmarkMedia, getMediaCoverId } from "./bookmarkImages";
import type { CardImageDimensions } from "./cardImageDimensions";
import { validImageDimensions } from "./cardImageDimensions";

/** Match the displayed cover; an original video is not the poster's geometry. */
function bookmarkCardCover(bookmark: ZBookmark) {
  const content = bookmark.content;
  let coverId: string | null | undefined;
  let src: string | undefined;
  if (content.type === "link") {
    const first = getBookmarkMedia(bookmark)[0];
    coverId = first && getMediaCoverId(first);
    const image = getBookmarkLinkImageUrl(content);
    if (!coverId && !image) return undefined;
    src = coverId ? getAssetThumbnailUrl(coverId) : image?.url;
    coverId ??= content.imageAssetId ?? content.screenshotAssetId;
  } else if (content.type === "asset" && content.assetType === "image") {
    coverId = content.assetId;
    src = getAssetThumbnailUrl(coverId);
  } else {
    return undefined;
  }
  return {
    src,
    dimensions: validImageDimensions(
      bookmark.assets.find((asset) => asset.id === coverId),
    ),
  };
}

export function bookmarkCardCoverDimensions(
  bookmark: ZBookmark,
  cached?: CardImageDimensions,
) {
  const cover = bookmarkCardCover(bookmark);
  return (
    cover?.dimensions ??
    (cover?.src && cached?.src === cover.src
      ? validImageDimensions(cached)
      : undefined)
  );
}

export function bookmarkCardImageRatio(bookmark: ZBookmark) {
  const cover = bookmarkCardCover(bookmark);
  if (!cover) return undefined;
  const dimensions = cover.dimensions;
  // Same first-load fallback as BookmarkCardImage when dimensions are unavailable.
  return dimensions ? dimensions.height / dimensions.width : 3 / 4;
}
