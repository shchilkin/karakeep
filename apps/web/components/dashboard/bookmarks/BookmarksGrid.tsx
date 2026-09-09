import { memo, useCallback, useEffect, useMemo, useState } from "react";
import KeyboardShortcutsDialog from "@/components/dashboard/KeyboardShortcutsDialog";
import NoBookmarksBanner from "@/components/dashboard/bookmarks/NoBookmarksBanner";
import { ActionButton } from "@/components/ui/action-button";
import ActionConfirmingDialog from "@/components/ui/action-confirming-dialog";
import useBulkActionsStore from "@/lib/bulkActions";
import { bookmarkCardImageRatio } from "@/lib/bookmarkCardHeight";
import { useBookmarkKeyboardNavigation } from "@/lib/hooks/useBookmarkKeyboardNavigation";
import { useTranslation } from "@/lib/i18n/client";
import { useInBookmarkGridStore } from "@/lib/store/useInBookmarkGridStore";
import { useKeyboardNavigationStore } from "@/lib/store/useKeyboardNavigationStore";
import {
  useBookmarkLayout,
  useBookmarkDisplaySettings,
  useGridColumns,
} from "@/lib/userLocalSettings/bookmarksLayout";
import { cn } from "@/lib/utils";
import tailwindConfig from "@/tailwind.config";
import { Slot } from "@radix-ui/react-slot";
import { ErrorBoundary } from "react-error-boundary";
import { useInView } from "react-intersection-observer";
import resolveConfig from "tailwindcss/resolveConfig";

import type { ZBookmark } from "@karakeep/shared/types/bookmarks";
import { useBookmarkListContext } from "@karakeep/shared-react/hooks/bookmark-list-context";

import BookmarkCard from "./BookmarkCard";
import EditorCard from "./EditorCard";
import UnknownCard from "./UnknownCard";
import VirtualMasonry from "./VirtualMasonry";

function StyledBookmarkCard({
  children,
  className,
  ...props
}: {
  children: React.ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Slot
      className={cn(
        "mb-4 border border-border bg-card hover:shadow-lg hover:transition-shadow",
        className,
      )}
      {...props}
    >
      {children}
    </Slot>
  );
}

const BookmarkGridItem = memo(function BookmarkGridItem({
  bookmark,
  index,
}: {
  bookmark: ZBookmark;
  index: number;
}) {
  const isFocused = useKeyboardNavigationStore(
    (state) => state.isNavigating && state.focusedIndex === index,
  );

  return (
    <ErrorBoundary fallback={<UnknownCard bookmark={bookmark} />}>
      <StyledBookmarkCard
        className={cn(
          isFocused &&
            "ring-2 ring-primary ring-offset-2 ring-offset-background",
        )}
      >
        <BookmarkCard bookmark={bookmark} bookmarkIndex={index} />
      </StyledBookmarkCard>
    </ErrorBoundary>
  );
});

function getColumnsForViewport(userColumns: number, viewportWidth: number) {
  const fullConfig = resolveConfig(tailwindConfig);
  const screens = fullConfig.theme.screens;
  const lg = parseInt(screens.lg);
  const md = parseInt(screens.md);
  const sm = parseInt(screens.sm);

  if (viewportWidth <= sm) {
    return 1;
  }
  if (viewportWidth <= md) {
    return Math.max(1, Math.min(userColumns, 2));
  }
  if (viewportWidth <= lg) {
    return Math.max(1, userColumns - 1);
  }
  return userColumns;
}

function useActiveGridColumns(userColumns: number) {
  const [activeColumns, setActiveColumns] = useState(userColumns);

  useEffect(() => {
    let animationFrame: number | null = null;
    const updateActiveColumns = () => {
      if (animationFrame !== null) {
        return;
      }
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        setActiveColumns(getColumnsForViewport(userColumns, window.innerWidth));
      });
    };

    const updateActiveColumnsImmediately = () => {
      setActiveColumns(getColumnsForViewport(userColumns, window.innerWidth));
    };

    updateActiveColumnsImmediately();
    window.addEventListener("resize", updateActiveColumns);
    return () => {
      window.removeEventListener("resize", updateActiveColumns);
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [userColumns]);

  return activeColumns;
}

export default function BookmarksGrid({
  bookmarks,
  hasNextPage = false,
  fetchNextPage = () => ({}),
  isFetchingNextPage = false,
  showEditorCard = false,
}: {
  bookmarks: ZBookmark[];
  showEditorCard?: boolean;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  fetchNextPage?: () => void;
}) {
  const { t } = useTranslation();
  const layout = useBookmarkLayout();
  const { showTitle, showNotes } = useBookmarkDisplaySettings();
  const gridColumns = useGridColumns();
  const activeGridColumns = useActiveGridColumns(gridColumns);
  const setVisibleBookmarks = useBulkActionsStore(
    (state) => state.setVisibleBookmarks,
  );
  const setListContext = useBulkActionsStore((state) => state.setListContext);
  const setInBookmarkGrid = useInBookmarkGridStore(
    (state) => state.setInBookmarkGrid,
  );
  const withinListContext = useBookmarkListContext();
  const { ref: loadMoreRef, inView: loadMoreButtonInView } = useInView();

  // For list/compact layouts, navigation is single-column
  const isListLayout = layout === "list" || layout === "compact";
  const navColumns = isListLayout ? 1 : activeGridColumns;

  const {
    focusedIndex,
    isNavigating,
    helpDialogOpen,
    setHelpDialogOpen,
    deleteDialogOpen,
    setDeleteDialogOpen,
    isBulkDelete,
    deleteCount,
    confirmDelete,
    isDeletePending,
  } = useBookmarkKeyboardNavigation({
    bookmarks,
    columns: navColumns,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  });

  useEffect(() => {
    setVisibleBookmarks(bookmarks);
    setListContext(withinListContext);

    return () => {
      setVisibleBookmarks([]);
      setListContext(undefined);
    };
  }, [bookmarks, setListContext, setVisibleBookmarks, withinListContext]);

  useEffect(() => {
    setInBookmarkGrid(true);
    return () => {
      setInBookmarkGrid(false);
    };
  }, [setInBookmarkGrid]);

  useEffect(() => {
    if (loadMoreButtonInView && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, loadMoreButtonInView]);

  const ids = useMemo(
    () => [
      ...(showEditorCard ? ["editor"] : []),
      ...bookmarks.map((bookmark) => bookmark.id),
    ],
    [bookmarks, showEditorCard],
  );
  const estimates = useMemo(
    () =>
      new Map(
        bookmarks.map((bookmark) => [
          bookmark.id,
          {
            ratio: bookmarkCardImageRatio(bookmark),
            hasNote: !!bookmark.note?.trim(),
          },
        ]),
      ),
    [bookmarks],
  );
  const estimateHeight = useCallback(
    (id: string, width: number) => {
      if (layout === "compact") return 72;
      if (layout === "list") return 160;
      const estimate = estimates.get(id);
      if (layout !== "masonry" || estimate?.ratio === undefined) return 400;
      // Media geometry plus the two-line caption, optional note and card spacing.
      // ResizeObserver replaces these text estimates after the card first mounts.
      return (
        width * estimate.ratio +
        16 +
        (showTitle ? 54 : 0) +
        (showNotes && estimate.hasNote ? 24 : 0)
      );
    },
    [layout, estimates, showTitle, showNotes],
  );

  if (bookmarks.length == 0 && !showEditorCard) {
    return (
      <>
        <NoBookmarksBanner />
        <KeyboardShortcutsDialog
          open={helpDialogOpen}
          setOpen={setHelpDialogOpen}
        />
      </>
    );
  }

  return (
    <>
      <VirtualMasonry
        ids={ids}
        columns={navColumns}
        layoutKey={layout}
        estimateHeight={estimateHeight}
        focusedIndex={
          isNavigating && focusedIndex >= 0
            ? focusedIndex + Number(showEditorCard)
            : -1
        }
        persistentIndex={showEditorCard ? 0 : -1}
        renderItem={(id, index) =>
          id === "editor" ? (
            <StyledBookmarkCard>
              <EditorCard />
            </StyledBookmarkCard>
          ) : (
            <BookmarkGridItem
              bookmark={bookmarks[index - Number(showEditorCard)]}
              index={index - Number(showEditorCard)}
            />
          )
        }
      />
      {hasNextPage && (
        <div className="flex justify-center">
          <ActionButton
            ref={loadMoreRef}
            ignoreDemoMode={true}
            loading={isFetchingNextPage}
            onClick={() => fetchNextPage()}
            variant="ghost"
          >
            Load More
          </ActionButton>
        </div>
      )}

      <KeyboardShortcutsDialog
        open={helpDialogOpen}
        setOpen={setHelpDialogOpen}
      />

      <ActionConfirmingDialog
        open={deleteDialogOpen}
        setOpen={setDeleteDialogOpen}
        title={t("dialogs.bookmarks.delete_confirmation_title")}
        description={
          isBulkDelete
            ? t("dialogs.bookmarks.bulk_delete_confirmation_description", {
                count: deleteCount,
              })
            : t("dialogs.bookmarks.delete_confirmation_description")
        }
        actionButton={() => (
          <ActionButton
            type="button"
            variant="destructive"
            loading={isDeletePending}
            onClick={confirmDelete}
          >
            {t("actions.delete")}
          </ActionButton>
        )}
      />
    </>
  );
}
