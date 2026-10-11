import type { ZAssetType } from "../types/bookmarks";

export function getAssetUrl(assetId: string) {
  return `/api/assets/${assetId}`;
}

export const THUMBNAIL_WIDTHS = [96, 320, 640, 1280] as const;
export type ThumbnailWidth = (typeof THUMBNAIL_WIDTHS)[number];

export function getAssetThumbnailUrl(
  assetId: string,
  width: ThumbnailWidth = 640,
) {
  return `${getAssetUrl(assetId)}/thumbnail?width=${width}`;
}

export function getAssetThumbnailSrcSet(assetId: string) {
  return ([320, 640, 1280] as const)
    .map((width) => `${getAssetThumbnailUrl(assetId, width)} ${width}w`)
    .join(", ");
}

/** A small silent preview; full playback and downloads keep getAssetUrl. */
export function getAssetHoverClipUrl(assetId: string) {
  return `${getAssetUrl(assetId)}/hover-clip`;
}

export function humanFriendlyNameForAssertType(type: ZAssetType) {
  const map: Record<ZAssetType, string> = {
    screenshot: "Screenshot",
    pdf: "PDF",
    assetScreenshot: "Asset Screenshot",
    fullPageArchive: "Full Page Archive",
    precrawledArchive: "Precrawled Archive",
    bannerImage: "Banner Image",
    video: "Video",
    bookmarkAsset: "Bookmark Asset",
    linkHtmlContent: "HTML Content",
    userUploaded: "User Uploaded File",
    avatar: "Avatar",
    unknown: "Unknown",
  };
  return map[type];
}
