"use client";

import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";
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
        bookmarkedAsset.content.assetType === "image" &&
        (layout === "masonry" || layout === "grid") ? (
          <Link
            href={`/dashboard/preview/${bookmarkedAsset.id}`}
            className="block"
          >
            <BookmarkCardImage
              key={bookmarkedAsset.content.assetId}
              src={getAssetThumbnailUrl(bookmarkedAsset.content.assetId)}
              srcSet={getAssetThumbnailSrcSet(bookmarkedAsset.content.assetId)}
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
