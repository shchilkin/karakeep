"use client";
import { useContext } from "react";
import Link from "next/link";
import { EyeOff } from "lucide-react";
import type { ZBookmark } from "@karakeep/shared/types/bookmarks";
import { getBookmarkTitle } from "@karakeep/shared/utils/bookmarkUtils";
import { bookmarkCardCoverDimensions } from "@/lib/bookmarkCardHeight";
import { CardImageDimensionsContext } from "@/lib/cardImageDimensions";
import { useTranslation } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { BookmarkLayoutAdaptingCard } from "../bookmarks/BookmarkLayoutAdaptingCard";
import ActionBar from "../preview/ActionBar";
import { useSensitiveContent } from "./SensitiveProvider";

export function ConcealedCard({
  bookmark,
  className,
  bookmarkIndex,
}: {
  bookmark: ZBookmark;
  className?: string;
  bookmarkIndex?: number;
}) {
  const { t } = useTranslation();
  const { reveal } = useSensitiveContent();
  const learned = useContext(CardImageDimensionsContext)?.current;
  const dimensions = bookmarkCardCoverDimensions(bookmark, learned);
  const ratio = dimensions ? dimensions.height / dimensions.width : 3 / 4;
  return (
    <BookmarkLayoutAdaptingCard
      bookmark={bookmark}
      className={className}
      bookmarkIndex={bookmarkIndex}
      imageFirst
      concealed
      wrapTags={false}
      title={
        <Link href={`/dashboard/preview/${bookmark.id}`}>
          {getBookmarkTitle(bookmark) ?? t("sensitive.mark")}
        </Link>
      }
      image={(layout) => (
        <button
          type="button"
          onClick={() => reveal(bookmark)}
          aria-label={t("sensitive.reveal")}
          data-sensitive-placeholder
          className="flex w-full flex-col items-center justify-center gap-2 rounded-xl bg-muted-foreground/15 p-3 text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          style={
            layout === "masonry"
              ? { aspectRatio: 1 / ratio }
              : layout === "list"
                ? { height: 128 }
                : { aspectRatio: "1 / 1" }
          }
        >
          <EyeOff className="size-6" />
          <span className="text-sm">{t("sensitive.hidden")}</span>
          <span className="text-xs underline">{t("sensitive.reveal")}</span>
        </button>
      )}
    />
  );
}
export function ConcealedPreview({
  bookmark,
  isOwner,
  onClose,
}: {
  bookmark: ZBookmark;
  isOwner: boolean;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const { reveal } = useSensitiveContent();
  return (
    <div
      className="flex min-h-[60dvh] flex-col items-center justify-center gap-5 p-6 text-center"
      data-sensitive-placeholder
    >
      <EyeOff className="size-10 text-muted-foreground" />
      <h2 className="max-w-xl text-xl">{getBookmarkTitle(bookmark)}</h2>
      <p className="text-muted-foreground">{t("sensitive.hidden")}</p>
      <p className="max-w-xl text-sm text-muted-foreground">
        {bookmark.sensitiveCategories
          ?.map((c) => t(`sensitive.categories.${c}`))
          .join(" · ")}
      </p>
      <Button onClick={() => reveal(bookmark)}>{t("sensitive.reveal")}</Button>
      {isOwner && <ActionBar bookmark={bookmark} />}
      {onClose && (
        <Button variant="ghost" onClick={onClose}>
          {t("actions.close")}
        </Button>
      )}
    </div>
  );
}
