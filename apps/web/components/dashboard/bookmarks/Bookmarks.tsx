import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Separator } from "@/components/ui/separator";
import { api } from "@/server/api/client";
import { getServerAuthSession } from "@/server/auth";

import type { ZGetBookmarksRequest } from "@karakeep/shared/types/bookmarks";

import UpdatableBookmarksGrid from "./UpdatableBookmarksGrid";
import BookmarksGridSkeleton from "./BookmarksGridSkeleton";

interface BookmarksProps {
  query: Omit<ZGetBookmarksRequest, "sortOrder" | "includeContent">;
  header?: React.ReactNode;
  showDivider?: boolean;
  showEditorCard?: boolean;
}

async function BookmarkResults({ query, showEditorCard }: BookmarksProps) {
  const session = await getServerAuthSession();
  if (!session) redirect("/");
  const bookmarks = await api.bookmarks.getBookmarks({ ...query });
  return (
    <UpdatableBookmarksGrid
      query={query}
      bookmarks={bookmarks}
      showEditorCard={showEditorCard}
    />
  );
}

export default function Bookmarks({
  query,
  header,
  showDivider,
  showEditorCard = false,
}: BookmarksProps) {
  return (
    <div className="flex flex-col gap-3">
      {header}
      {showDivider && <Separator />}
      <Suspense
        fallback={<BookmarksGridSkeleton showEditorCard={showEditorCard} />}
      >
        <BookmarkResults query={query} showEditorCard={showEditorCard} />
      </Suspense>
    </div>
  );
}
