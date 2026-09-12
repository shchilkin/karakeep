import { catalogBusy } from "../mediaCatalog";
import { BookmarkTypes, ZBookmark, ZBookmarkedLink } from "../types/bookmarks";
import { getAssetUrl } from "./assetUtils";

export function getBookmarkLinkAssetIdOrUrl(bookmark: ZBookmarkedLink) {
  if (bookmark.imageAssetId) {
    return { assetId: bookmark.imageAssetId, localAsset: true as const };
  }
  if (bookmark.screenshotAssetId) {
    return { assetId: bookmark.screenshotAssetId, localAsset: true as const };
  }
  return bookmark.imageUrl
    ? { url: bookmark.imageUrl, localAsset: false as const }
    : null;
}

export function getBookmarkLinkImageUrl(bookmark: ZBookmarkedLink) {
  const assetOrUrl = getBookmarkLinkAssetIdOrUrl(bookmark);
  if (!assetOrUrl) {
    return null;
  }
  if (!assetOrUrl.localAsset) {
    return assetOrUrl;
  }
  return {
    url: getAssetUrl(assetOrUrl.assetId),
    localAsset: true,
  };
}

export function isBookmarkStillCrawling(bookmark: ZBookmark) {
  if (bookmark.content.type != BookmarkTypes.LINK) {
    return false;
  }
  if (bookmark.content.crawlStatus) {
    return bookmark.content.crawlStatus === "pending";
  }
  return !bookmark.content.crawledAt;
}

export function isBookmarkStillTagging(bookmark: ZBookmark) {
  return bookmark.taggingStatus == "pending";
}

export function isBookmarkStillSummarizing(bookmark: ZBookmark) {
  return bookmark.summarizationStatus == "pending";
}

export function isBookmarkStillLoading(bookmark: ZBookmark) {
  return (
    isBookmarkStillTagging(bookmark) ||
    isBookmarkStillCrawling(bookmark) ||
    isBookmarkStillSummarizing(bookmark)
  );
}

export function getBookmarkRefreshInterval(
  bookmark: ZBookmark,
): number | false {
  if (catalogBusy(bookmark.mediaAi)) return 2000;
  const state = bookmark.mediaAi;
  if (
    state?.localMode &&
    state.localMode !== "off" &&
    (["pending", "checking_local", "processing", "processing_local"].includes(
      state.status,
    ) ||
      (state.status === "local_failed" && (state.localRecoveries ?? 0) < 2))
  )
    return 10_000;
  if (!isBookmarkStillLoading(bookmark)) {
    return false;
  }

  // For the first 30 seconds, we'll refresh the bookmark every second
  if (Date.now().valueOf() - bookmark.createdAt.valueOf() < 30 * 1000) {
    return 1000;
  }

  // Then, we'll refresh it every 10 seconds after than for 10mins
  if (Date.now().valueOf() - bookmark.createdAt.valueOf() < 10 * 60 * 1000) {
    return 10_000;
  }

  // Then, we'll refresh it every minute after than for 6hrs
  if (
    Date.now().valueOf() - bookmark.createdAt.valueOf() <
    6 * 60 * 60 * 1000
  ) {
    return 60_000;
  }

  // Then we'll stop refreshing it
  return false;
}

export function getSourceUrl(bookmark: ZBookmark) {
  if (bookmark.content.type === BookmarkTypes.LINK) {
    return bookmark.content.url;
  }
  if (bookmark.content.type === BookmarkTypes.ASSET) {
    return bookmark.content.sourceUrl ?? null;
  }
  if (bookmark.content.type === BookmarkTypes.TEXT) {
    return bookmark.content.sourceUrl ?? null;
  }
  return null;
}

export function getStoredBookmarkTitle(
  bookmark: Pick<ZBookmark, "title" | "originalTitle">,
) {
  return bookmark.originalTitle !== undefined
    ? bookmark.originalTitle
    : bookmark.title;
}

export function getBookmarkTitleOverride(
  bookmark: Pick<
    ZBookmark,
    "title" | "originalTitle" | "titleSource" | "mediaAi"
  >,
) {
  const storedTitle = getStoredBookmarkTitle(bookmark);
  const title = storedTitle?.trim() ? storedTitle : null;
  return bookmark.titleSource === "captured"
    ? bookmark.mediaAi?.result?.title || title
    : title || bookmark.mediaAi?.result?.title;
}

export function getBookmarkTitle(bookmark: ZBookmark) {
  let title: string | null = null;
  switch (bookmark.content.type) {
    case BookmarkTypes.LINK:
      title = bookmark.content.title ?? bookmark.content.url;
      break;
    case BookmarkTypes.TEXT:
      title = null;
      break;
    case BookmarkTypes.ASSET:
      title = bookmark.content.fileName ?? null;
      break;
  }

  return getBookmarkTitleOverride(bookmark) || title;
}
