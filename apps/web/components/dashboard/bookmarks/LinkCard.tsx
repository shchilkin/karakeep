"use client";

import Image from "next/image";
import Link from "next/link";
import type { BookmarksLayoutTypes } from "@/lib/userLocalSettings/types";
import { getBookmarkImages } from "@/lib/bookmarkImages";
import { useTranslation } from "@/lib/i18n/client";
import { useUserSettings } from "@/lib/userSettings";
import { Images } from "lucide-react";
import { getAssetUrl } from "@karakeep/shared/utils/assetUtils";

import type { ZBookmarkTypeLink } from "@karakeep/shared/types/bookmarks";
import {
  getBookmarkLinkImageUrl,
  getBookmarkTitle,
  getSourceUrl,
  isBookmarkStillCrawling,
} from "@karakeep/shared/utils/bookmarkUtils";

import { BookmarkLayoutAdaptingCard } from "./BookmarkLayoutAdaptingCard";
import BookmarkCardImage from "./BookmarkCardImage";
import FooterLinkURL from "./FooterLinkURL";

const useOnClickUrl = (bookmark: ZBookmarkTypeLink) => {
  const userSettings = useUserSettings();
  return {
    urlTarget:
      userSettings.bookmarkClickAction === "open_original_link"
        ? ("_blank" as const)
        : ("_self" as const),
    onClickUrl:
      userSettings.bookmarkClickAction === "expand_bookmark_preview"
        ? `/dashboard/preview/${bookmark.id}`
        : bookmark.content.url,
  };
};

function LinkTitle({ bookmark }: { bookmark: ZBookmarkTypeLink }) {
  const { onClickUrl, urlTarget } = useOnClickUrl(bookmark);
  const parsedUrl = new URL(bookmark.content.url);
  return (
    <Link href={onClickUrl} target={urlTarget} rel="noreferrer">
      {getBookmarkTitle(bookmark) ?? parsedUrl.host}
    </Link>
  );
}

function LinkImage({
  bookmark,
  className,
  layout,
}: {
  bookmark: ZBookmarkTypeLink;
  className?: string;
  layout: BookmarksLayoutTypes;
}) {
  const { onClickUrl, urlTarget } = useOnClickUrl(bookmark);
  const link = bookmark.content;
  const { t } = useTranslation();
  const images = getBookmarkImages(bookmark);

  const imgComponent = (url: string, unoptimized: boolean) => (
    <Image
      unoptimized={unoptimized}
      className={className}
      alt="card banner"
      fill={true}
      src={url}
    />
  );

  const imageDetails = getBookmarkLinkImageUrl(link);
  const cover = images[0] ? getAssetUrl(images[0].id) : imageDetails?.url;

  if (cover && (layout === "masonry" || layout === "grid")) {
    return (
      <Link
        href={onClickUrl}
        target={urlTarget}
        rel="noreferrer"
        className="relative block"
      >
        <BookmarkCardImage
          key={cover}
          src={cover}
          alt={getBookmarkTitle(bookmark) ?? new URL(link.url).host}
          naturalSize={layout === "masonry"}
          className={className}
        />
        {images.length > 1 && (
          <span
            className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-md bg-black/80 px-2 py-1 text-xs tabular-nums text-white"
            aria-label={t("preview.gallery.photo_count", {
              count: images.length,
            })}
          >
            <Images className="size-3.5" aria-hidden="true" />
            {images.length}
          </span>
        )}
      </Link>
    );
  }

  let img: React.ReactNode;
  if (images[0]) {
    img = imgComponent(getAssetUrl(images[0].id), true);
  } else if (isBookmarkStillCrawling(bookmark)) {
    img = imgComponent("/blur.avif", false);
  } else if (imageDetails) {
    img = imgComponent(imageDetails.url, true);
  } else {
    // No image found
    // A dummy white pixel for when there's no image.
    img = imgComponent(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAA1JREFUGFdj+P///38ACfsD/QVDRcoAAAAASUVORK5CYII=",
      true,
    );
  }

  return (
    <Link
      href={onClickUrl}
      target={urlTarget}
      rel="noreferrer"
      className={className}
    >
      <div className="relative size-full flex-1">
        {img}
        {images.length > 1 && (
          <span
            className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs tabular-nums text-white"
            aria-label={t("preview.gallery.photo_count", {
              count: images.length,
            })}
          >
            <Images className="size-3.5" aria-hidden="true" />
            {images.length}
          </span>
        )}
      </div>
    </Link>
  );
}

export default function LinkCard({
  bookmark: bookmarkLink,
  className,
  bookmarkIndex,
}: {
  bookmark: ZBookmarkTypeLink;
  className?: string;
  bookmarkIndex?: number;
}) {
  const hasCover = !!(
    getBookmarkImages(bookmarkLink).length ||
    getBookmarkLinkImageUrl(bookmarkLink.content)
  );
  return (
    <BookmarkLayoutAdaptingCard
      title={<LinkTitle bookmark={bookmarkLink} />}
      footer={<FooterLinkURL url={getSourceUrl(bookmarkLink)} />}
      bookmark={bookmarkLink}
      imageFirst={hasCover}
      fitHeight={!hasCover}
      wrapTags={false}
      image={(layout, className) =>
        !hasCover &&
        !isBookmarkStillCrawling(bookmarkLink) &&
        (layout === "masonry" || layout === "grid") ? null : (
          <LinkImage
            layout={layout}
            className={className}
            bookmark={bookmarkLink}
          />
        )
      }
      className={className}
      bookmarkIndex={bookmarkIndex}
    />
  );
}
