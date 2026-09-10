import { useSensitiveContent } from "../sensitive/SensitiveProvider";
import { ConcealedCard } from "../sensitive/ConcealedBookmark";
import { useQuery } from "@tanstack/react-query";

import { useTRPC } from "@karakeep/shared-react/trpc";
import { BookmarkTypes, ZBookmark } from "@karakeep/shared/types/bookmarks";
import { getBookmarkRefreshInterval } from "@karakeep/shared/utils/bookmarkUtils";

import AssetCard from "./AssetCard";
import LinkCard from "./LinkCard";
import TextCard from "./TextCard";
import UnknownCard from "./UnknownCard";

export default function BookmarkCard({
  bookmark: initialData,
  className,
  bookmarkIndex,
}: {
  bookmark: ZBookmark;
  className?: string;
  bookmarkIndex?: number;
}) {
  const { conceal } = useSensitiveContent();
  const api = useTRPC();
  const { data: bookmark } = useQuery(
    api.bookmarks.getBookmark.queryOptions(
      {
        bookmarkId: initialData.id,
      },
      {
        initialData,
        refetchInterval: (query) => {
          const data = query.state.data;
          if (!data) {
            return false;
          }
          return getBookmarkRefreshInterval(data);
        },
      },
    ),
  );

  if (conceal(bookmark))
    return (
      <ConcealedCard
        bookmark={bookmark}
        className={className}
        bookmarkIndex={bookmarkIndex}
      />
    );

  switch (bookmark.content.type) {
    case BookmarkTypes.LINK:
      return (
        <LinkCard
          className={className}
          bookmarkIndex={bookmarkIndex}
          bookmark={{ ...bookmark, content: bookmark.content }}
        />
      );
    case BookmarkTypes.TEXT:
      return (
        <TextCard
          className={className}
          bookmarkIndex={bookmarkIndex}
          bookmark={{ ...bookmark, content: bookmark.content }}
        />
      );
    case BookmarkTypes.ASSET:
      return (
        <AssetCard
          className={className}
          bookmarkIndex={bookmarkIndex}
          bookmark={{ ...bookmark, content: bookmark.content }}
        />
      );
    case BookmarkTypes.UNKNOWN:
      return (
        <UnknownCard
          className={className}
          bookmarkIndex={bookmarkIndex}
          bookmark={bookmark}
        />
      );
  }
}
