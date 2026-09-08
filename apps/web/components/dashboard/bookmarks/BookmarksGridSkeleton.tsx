"use client";

import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslation } from "@/lib/i18n/client";
import type { BookmarksLayoutTypes } from "@/lib/userLocalSettings/types";
import {
  bookmarkLayoutSwitch,
  useBookmarkLayout,
  useGridColumns,
} from "@/lib/userLocalSettings/bookmarksLayout";
import tailwindConfig from "@/tailwind.config";
import Masonry from "react-masonry-css";
import resolveConfig from "tailwindcss/resolveConfig";

function getBreakpointConfig(userColumns: number) {
  const fullConfig = resolveConfig(tailwindConfig);

  const breakpointColumnsObj: { [key: number]: number; default: number } = {
    default: userColumns,
  };

  const lgColumns = Math.max(1, Math.min(userColumns, userColumns - 1));
  const mdColumns = Math.max(1, Math.min(userColumns, 2));
  const smColumns = 1;

  breakpointColumnsObj[parseInt(fullConfig.theme.screens.lg)] = lgColumns;
  breakpointColumnsObj[parseInt(fullConfig.theme.screens.md)] = mdColumns;
  breakpointColumnsObj[parseInt(fullConfig.theme.screens.sm)] = smColumns;
  return breakpointColumnsObj;
}

const imageRatios = [
  "aspect-[3/4]",
  "aspect-square",
  "aspect-[4/3]",
  "aspect-[4/5]",
];

function BookmarkCardSkeleton({
  layout,
  index,
}: {
  layout: BookmarksLayoutTypes;
  index: number;
}) {
  if (layout === "list" || layout === "compact") {
    return (
      <div className="mb-4 flex items-center gap-4 rounded-xl border border-border bg-card p-4">
        <Skeleton
          className={
            layout === "compact" ? "size-8 shrink-0" : "size-24 shrink-0"
          }
        />
        <div className="flex-1 space-y-3">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-2 w-1/3" />
        </div>
      </div>
    );
  }
  return (
    <div className="mb-6 space-y-3">
      <Skeleton
        className={`w-full rounded-xl bg-muted-foreground/10 ${layout === "grid" ? "aspect-square" : imageRatios[index % imageRatios.length]}`}
      />
      <Skeleton className="mx-auto h-3 w-2/3 bg-muted-foreground/10" />
    </div>
  );
}

export default function BookmarksGridSkeleton({
  count = 12,
  showEditorCard = false,
}: {
  count?: number;
  showEditorCard?: boolean;
}) {
  const { t } = useTranslation();
  const layout = useBookmarkLayout();
  const gridColumns = useGridColumns();
  const breakpointConfig = useMemo(
    () => getBreakpointConfig(gridColumns),
    [gridColumns],
  );

  const children = [
    ...(showEditorCard
      ? [
          <div
            key="editor"
            className="mb-4 flex h-72 flex-col gap-4 rounded-xl border border-border bg-card p-4"
          >
            <Skeleton className="h-3 w-24" />
            <div className="flex-1 border-t border-border pt-4">
              <Skeleton className="h-3 w-4/5" />
            </div>
            <Skeleton className="h-9 w-full" />
          </div>,
        ]
      : []),
    ...Array.from({ length: count }, (_, i) => (
      <BookmarkCardSkeleton key={i} layout={layout} index={i} />
    )),
  ];

  return (
    <div
      role="status"
      aria-label={t("common.loading_bookmarks")}
      aria-busy="true"
    >
      <div aria-hidden="true">
        {bookmarkLayoutSwitch(layout, {
          masonry: (
            <Masonry
              className="-ml-4 flex w-auto"
              columnClassName="pl-4"
              breakpointCols={breakpointConfig}
            >
              {children}
            </Masonry>
          ),
          grid: (
            <Masonry
              className="-ml-4 flex w-auto"
              columnClassName="pl-4"
              breakpointCols={breakpointConfig}
            >
              {children}
            </Masonry>
          ),
          list: <div className="grid grid-cols-1">{children}</div>,
          compact: <div className="grid grid-cols-1">{children}</div>,
        })}
      </div>
    </div>
  );
}
