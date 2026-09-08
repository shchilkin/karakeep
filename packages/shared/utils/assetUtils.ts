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
