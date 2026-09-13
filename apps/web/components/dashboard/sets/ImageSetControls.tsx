"use client";
import { useState } from "react";
import Link from "next/link";
import { Images } from "lucide-react";
import type { ZBookmark } from "@karakeep/shared/types/bookmarks";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n/client";
import ImageSetEditor from "./ImageSetEditor";
export default function ImageSetControls({
  bookmark,
}: {
  bookmark: ZBookmark;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!bookmark.imageSet) return null;
  return (
    <section className="space-y-4" aria-label={t("image_sets.sources")}>
      <Button
        variant="secondary"
        className="w-full"
        onClick={() => setOpen(true)}
      >
        <Images className="mr-2 size-4" />
        {t("image_sets.edit")}
      </Button>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {t("image_sets.ai_hold")}
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer rounded focus-visible:ring-2 focus-visible:ring-ring">
          {t("image_sets.sources")} ({bookmark.imageSet.members.length})
        </summary>
        <ol className="mt-3 space-y-2">
          {bookmark.imageSet.members.map((m) => (
            <li key={m.bookmarkId}>
              <Link
                className="break-words underline underline-offset-4"
                href={`/dashboard/preview/${m.bookmarkId}`}
                target="_blank"
              >
                {m.title}
              </Link>
            </li>
          ))}
        </ol>
      </details>
      {open && (
        <ImageSetEditor bookmark={bookmark} onClose={() => setOpen(false)} />
      )}
    </section>
  );
}
