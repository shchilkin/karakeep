import SavedImageGallery from "./SavedImageGallery";
import { getBookmarkMedia } from "@/lib/bookmarkImages";
import ImageSetControls from "../sets/ImageSetControls";
import type { ReactNode } from "react";
import Link from "next/link";
import { BookmarkTagsEditor } from "@/components/dashboard/bookmarks/BookmarkTagsEditor";
import SummarizeBookmarkArea from "@/components/dashboard/bookmarks/SummarizeBookmarkArea";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n/client";
import { ExternalLink, X } from "lucide-react";

import type { ZBookmark } from "@karakeep/shared/types/bookmarks";
import { getBookmarkTitle } from "@karakeep/shared/utils/bookmarkUtils";

import ActionBar from "./ActionBar";
import AttachmentBox from "./AttachmentBox";
import HighlightsBox from "./HighlightsBox";
import LinkContentSection from "./LinkContentSection";
import { NoteEditor } from "./NoteEditor";

export default function MediaBookmarkPreview({
  bookmark,
  readOnly,
  metadata,
  onClose,
}: {
  bookmark: ZBookmark;
  readOnly: boolean;
  metadata: ReactNode;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const link = bookmark.content.type === "link" ? bookmark.content : null;
  const title = getBookmarkTitle(bookmark) ?? "Untitled";
  const summary = (
    <SummarizeBookmarkArea bookmark={bookmark} readOnly={readOnly} />
  );

  return (
    <div className="relative h-full min-w-0 overflow-hidden bg-background">
      {onClose && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-2 top-2 z-20 rounded-full bg-background/90"
          aria-label={t("actions.close")}
          onClick={onClose}
        >
          <X className="size-5" />
        </Button>
      )}
      <div className="flex h-full min-w-0 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <div className="h-[60dvh] min-h-80 min-w-0 shrink-0 bg-muted/30 pb-1 pt-3 lg:h-full lg:min-h-0 lg:flex-1 lg:pt-5">
          {bookmark.imageSet ? (
            <SavedImageGallery
              key={bookmark.id}
              images={getBookmarkMedia(bookmark)}
              initialImageId={
                bookmark.imageSet.members.find(
                  (m) => m.bookmarkId === bookmark.imageSet!.coverBookmarkId,
                )?.image.id
              }
              title={title}
            />
          ) : (
            link && (
              <LinkContentSection
                key={bookmark.id}
                bookmark={{ ...bookmark, content: link }}
              />
            )
          )}
        </div>
        <aside className="flex min-w-0 shrink-0 flex-col bg-background lg:w-[35%] lg:min-w-80 lg:max-w-md">
          <div className="flex flex-col gap-7 px-6 py-8 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-7 lg:pt-12">
            <header className="flex flex-col gap-3">
              <h1 className="break-words text-2xl font-normal leading-tight tracking-tight sm:text-3xl">
                {title}
              </h1>
              {link && (
                <Link
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex w-fit max-w-full items-center gap-1.5 rounded text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="truncate">
                    {new URL(link.url).hostname.replace(/^www\./, "")}
                  </span>
                  <ExternalLink
                    className="size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="sr-only">{t("preview.view_original")}</span>
                </Link>
              )}
              {metadata}
            </header>
            {link?.description && (
              <p className="whitespace-pre-line break-words text-sm leading-relaxed text-foreground/80">
                {link.description}
              </p>
            )}
            {bookmark.summary ? (
              <section
                className="flex flex-col gap-3"
                aria-label={t("common.summary")}
              >
                <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t("common.summary")}
                </h2>
                {summary}
              </section>
            ) : (
              summary
            )}
            <section
              className="flex flex-col gap-3"
              aria-label={t("common.tags")}
            >
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {t("common.tags")}
              </h2>
              <BookmarkTagsEditor
                key={bookmark.id}
                bookmark={bookmark}
                disabled={readOnly}
                variant="pills"
              />
            </section>
            <section
              className="flex flex-col gap-3"
              aria-label={t("common.note")}
            >
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {t("common.note")}
              </h2>
              <NoteEditor
                key={bookmark.id}
                bookmark={bookmark}
                disabled={readOnly}
                className="min-h-24 border-0 bg-muted/50 p-4"
              />
            </section>
            {bookmark.imageSet && <ImageSetControls bookmark={bookmark} />}
            {!bookmark.imageSet && (
              <AttachmentBox
                bookmark={bookmark}
                readOnly={readOnly}
                defaultOpen={false}
              />
            )}
            <HighlightsBox bookmarkId={bookmark.id} readOnly={readOnly} />
          </div>
          {!readOnly && (
            <div className="shrink-0 border-t border-border/50 px-6 py-4">
              <ActionBar bookmark={bookmark} />
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
