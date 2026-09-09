import type { ZBookmark } from "@karakeep/shared/types/bookmarks";
import { getBookmarkLinkImageUrl } from "@karakeep/shared/utils/bookmarkUtils";
import { getBookmarkMedia, getMediaCoverId } from "./bookmarkImages";
import { validImageDimensions } from "./cardImageDimensions";

/** Match the displayed cover; an original video is not the poster's geometry. */
export function bookmarkCardImageRatio(bookmark: ZBookmark) {
  const content = bookmark.content;
  let coverId: string | null | undefined;
  if (content.type === "link") {
    const first = getBookmarkMedia(bookmark)[0];
    coverId = first && getMediaCoverId(first);
    if (!coverId && !getBookmarkLinkImageUrl(content)) return undefined;
    coverId ??= content.imageAssetId ?? content.screenshotAssetId;
  } else if (content.type === "asset" && content.assetType === "image") {
    coverId = content.assetId;
  } else {
    return undefined;
  }
  const dimensions = validImageDimensions(
    bookmark.assets.find((asset) => asset.id === coverId),
  );
  // Same first-load fallback as BookmarkCardImage when dimensions are unavailable.
  return dimensions ? dimensions.height / dimensions.width : 3 / 4;
}
