"use client";

import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n/client";
import { FileText } from "lucide-react";

import type { ZBookmarkTypeAsset } from "@karakeep/shared/types/bookmarks";
import {
  getAssetUrl,
  getAssetThumbnailUrl,
  getAssetThumbnailSrcSet,
} from "@karakeep/shared/utils/assetUtils";
import { getSourceUrl } from "@karakeep/shared/utils/bookmarkUtils";

import { BookmarkLayoutAdaptingCard } from "./BookmarkLayoutAdaptingCard";
import BookmarkCardImage from "./BookmarkCardImage";
import FooterLinkURL from "./FooterLinkURL";

function AssetImage({
  bookmark,
  className,
}: {
  bookmark: ZBookmarkTypeAsset;
  className?: string;
}) {
  const bookmarkedAsset = bookmark.content;
  switch (bookmarkedAsset.assetType) {
    case "image": {
      return (
        <Link href={`/dashboard/preview/${bookmark.id}`}>
          <Image
            alt="asset"
            src={getAssetUrl(bookmarkedAsset.assetId)}
            fill={true}
            unoptimized
            className={className}
          />
        </Link>
      );
    }
    case "pdf": {
      const screenshotAssetId = bookmark.assets.find(
        (r) => r.assetType === "assetScreenshot",
      )?.id;
      if (!screenshotAssetId) {
        return (
          <div
            className={cn(className, "flex items-center justify-center")}
            title="PDF screenshot not available. Run asset preprocessing job to generate one screenshot"
          >
            <FileText size={80} />
          </div>
        );
      }
      return (
        <Link href={`/dashboard/preview/${bookmark.id}`}>
          <Image
            alt="asset"
            src={getAssetUrl(screenshotAssetId)}
            fill={true}
            unoptimized
            className={className}
          />
        </Link>
      );
    }
    default: {
      const _exhaustiveCheck: never = bookmarkedAsset.assetType;
      return <span />;
    }
  }
}

export default function AssetCard({
  bookmark: bookmarkedAsset,
  className,
  bookmarkIndex,
}: {
  bookmark: ZBookmarkTypeAsset;
  className?: string;
  bookmarkIndex?: number;
}) {
  const { t } = useTranslation();
  const importedPreview = bookmarkedAsset.importProcessing?.previewReady
    ? bookmarkedAsset.importProcessing.previewAssetId
    : null;
  return (
    <BookmarkLayoutAdaptingCard
      title={
        <Link href={`/dashboard/preview/${bookmarkedAsset.id}`}>
          {bookmarkedAsset.title ?? bookmarkedAsset.content.fileName}
        </Link>
      }
      footer={
        getSourceUrl(bookmarkedAsset) && (
          <FooterLinkURL url={getSourceUrl(bookmarkedAsset)} />
        )
      }
      bookmark={bookmarkedAsset}
      imageFirst={bookmarkedAsset.content.assetType === "image"}
      className={className}
      bookmarkIndex={bookmarkIndex}
      wrapTags={true}
      image={(layout, className) =>
        bookmarkedAsset.processingPolicy === "deferred" && !importedPreview ? (
          <Link
            href={`/dashboard/preview/${bookmarkedAsset.id}`}
            className={cn(
              className,
              "flex min-h-40 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground",
            )}
          >
            <FileText className="size-8" />
            <span>{t("duplicates.deferred_snapshot")}</span>
            <span className="underline">
              {t("duplicates.show_saved_original")}
            </span>
          </Link>
        ) : bookmarkedAsset.content.assetType === "image" &&
          (!!importedPreview || layout === "masonry" || layout === "grid") ? (
          <Link
            href={`/dashboard/preview/${bookmarkedAsset.id}`}
            className="block"
          >
            <BookmarkCardImage
              key={bookmarkedAsset.content.assetId}
              src={
                importedPreview
                  ? getAssetUrl(importedPreview)
                  : getAssetThumbnailUrl(bookmarkedAsset.content.assetId)
              }
              srcSet={
                importedPreview
                  ? undefined
                  : getAssetThumbnailSrcSet(bookmarkedAsset.content.assetId)
              }
              alt={
                bookmarkedAsset.title ?? bookmarkedAsset.content.fileName ?? ""
              }
              dimensions={bookmarkedAsset.assets.find(
                (asset) => asset.id === bookmarkedAsset.content.assetId,
              )}
              naturalSize={layout === "masonry"}
              className={className}
            />
          </Link>
        ) : (
          <div className="relative size-full flex-1">
            <AssetImage bookmark={bookmarkedAsset} className={className} />
          </div>
        )
      }
    />
  );
}
