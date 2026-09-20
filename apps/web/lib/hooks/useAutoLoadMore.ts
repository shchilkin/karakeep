import { useCallback, useEffect, useRef } from "react";

export function useAutoLoadMore({
  inView,
  boundary,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  inView: boolean;
  boundary?: Element;
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
    if (!boundary || inView) return;
    // Image measurements can move the boundary out and back into view. Only a
    // new scroll gesture may rearm it; scroll events also include layout shifts
    // and the virtualizer's own anchor corrections.
    let parent = boundary.parentElement;
    while (
      parent &&
      !/(auto|scroll)/.test(getComputedStyle(parent).overflowY)
    ) {
      parent = parent.parentElement;
    }
    const scroller = parent ?? window;
    const rearm = (event: Event) => {
      if (event.defaultPrevented) return;
      if (event instanceof WheelEvent && event.deltaY <= 0) return;
      if (event instanceof PointerEvent) {
        const scrollbarTarget = parent
          ? event.target === parent
          : event.target === document.documentElement ||
            event.target === document.body;
        if (!scrollbarTarget) return;
      }
      if (event instanceof KeyboardEvent) {
        if (!["ArrowDown", "PageDown", "End", " "].includes(event.key)) return;
        if (
          event.target instanceof Element &&
          event.target.closest("input, textarea, select, [contenteditable]")
        )
          return;
      }
      consumed.current = false;
    };
    const events = ["wheel", "touchmove", "pointerdown"] as const;
    for (const name of events)
      scroller.addEventListener(name, rearm, { passive: true });
    window.addEventListener("keydown", rearm);
    return () => {
      window.removeEventListener("keydown", rearm);
      for (const name of events) scroller.removeEventListener(name, rearm);
    };
  }, [boundary, inView]);

  useEffect(() => {
    // Query completion can precede IntersectionObserver's new layout report.
    // A still-true inView must not turn that completion into another page load.
    if (inView && !consumed.current) void requestNextPage();
  }, [inView, requestNextPage]);

  return requestNextPage;
}
