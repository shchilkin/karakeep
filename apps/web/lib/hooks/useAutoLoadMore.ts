import { useCallback, useEffect, useRef } from "react";

export function useAutoLoadMore({
  inView,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  inView: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
}) {
  const consumed = useRef(false);
  const pending = useRef(false);

  const requestNextPage = useCallback(async () => {
    if (!hasNextPage || isFetchingNextPage || pending.current) return;
    // Manual/keyboard requests also consume the current automatic trigger.
    consumed.current = true;
    pending.current = true;
    try {
      await fetchNextPage();
    } catch {
      // The query owns its error state. Retry only on explicit input or re-entry.
    } finally {
      pending.current = false;
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  useEffect(() => {
    if (!inView) consumed.current = false;
  }, [inView]);

  useEffect(() => {
    // Query completion can precede IntersectionObserver's new layout report.
    // A still-true inView must not turn that completion into another page load.
    if (inView && !consumed.current) void requestNextPage();
  }, [inView, requestNextPage]);

  return requestNextPage;
}
