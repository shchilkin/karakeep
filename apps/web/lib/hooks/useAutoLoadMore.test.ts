// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoLoadMore } from "./useAutoLoadMore";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function scrollBoundary() {
  const scroller = document.createElement("main");
  scroller.style.overflowY = "auto";
  const boundary = document.createElement("button");
  scroller.append(boundary);
  document.body.append(scroller);
  return { scroller, boundary };
}

it("loads once while the observer still reports the previous visible boundary", async () => {
  const { scroller, boundary } = scrollBoundary();
  const fetchNextPage = vi.fn();
  const props = {
    inView: true,
    boundary,
    hasNextPage: true,
    isFetchingNextPage: false,
    fetchNextPage,
  };
  const { rerender } = renderHook(useAutoLoadMore, { initialProps: props });
  expect(fetchNextPage).toHaveBeenCalledTimes(1);
  rerender({ ...props, isFetchingNextPage: true });
  await act(async () => {
    await Promise.resolve();
  });
  // The query completes before IntersectionObserver reports the new geometry.
  rerender(props);
  expect(fetchNextPage).toHaveBeenCalledTimes(1);
  rerender({ ...props, inView: false });
  // Late image geometry and virtualizer anchor adjustments are not user input.
  scroller.dispatchEvent(new Event("scroll"));
  rerender(props);
  expect(fetchNextPage).toHaveBeenCalledTimes(1);
  rerender({ ...props, inView: false });
  scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
  rerender(props);
  expect(fetchNextPage).toHaveBeenCalledTimes(2);
});

it("allows a boundary first reached during an existing request once it finishes", async () => {
  const fetchNextPage = vi.fn();
  const props = {
    inView: false,
    hasNextPage: true,
    isFetchingNextPage: true,
    fetchNextPage,
  };
  const { rerender } = renderHook(useAutoLoadMore, { initialProps: props });
  rerender({ ...props, inView: true });
  expect(fetchNextPage).not.toHaveBeenCalled();
  rerender({ ...props, inView: true, isFetchingNextPage: false });
  await act(async () => {
    await Promise.resolve();
  });
  expect(fetchNextPage).toHaveBeenCalledTimes(1);
});

it("shares the request guard with manual and keyboard pagination", async () => {
  let complete!: () => void;
  const fetchNextPage = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const props = {
    inView: false,
    hasNextPage: true,
    isFetchingNextPage: false,
    fetchNextPage,
  };
  const { result, rerender } = renderHook(useAutoLoadMore, {
    initialProps: props,
  });
  act(() => {
    result.current();
    result.current();
  });
  rerender({ ...props, inView: true });
  expect(fetchNextPage).toHaveBeenCalledTimes(1);
  await act(async () => {
    complete();
  });
  rerender({ ...props, inView: true });
  expect(fetchNextPage).toHaveBeenCalledTimes(1);
  act(() => {
    result.current();
  });
  expect(fetchNextPage).toHaveBeenCalledTimes(2);
  await act(async () => {
    complete();
  });
});

it("does not loop on failure, but allows an explicit retry and stops at the last page", async () => {
  const fetchNextPage = vi.fn().mockRejectedValue(new Error("offline"));
  const props = {
    inView: true,
    hasNextPage: true,
    isFetchingNextPage: false,
    fetchNextPage,
  };
  const { result, rerender } = renderHook(useAutoLoadMore, {
    initialProps: props,
  });
  await act(async () => {
    await Promise.resolve();
  });
  rerender({ ...props });
  expect(fetchNextPage).toHaveBeenCalledTimes(1);
  await act(async () => {
    await result.current();
  });
  expect(fetchNextPage).toHaveBeenCalledTimes(2);
  rerender({ ...props, hasNextPage: false });
  await act(async () => {
    await result.current();
  });
  expect(fetchNextPage).toHaveBeenCalledTimes(2);
});

it.each(["touchmove", "keydown", "pointerdown"])(
  "rearms on %s outside the boundary and removes listeners on unmount",
  async (name) => {
    const { scroller, boundary } = scrollBoundary();
    const fetchNextPage = vi.fn();
    const props = {
      inView: true,
      boundary,
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage,
    };
    const { rerender, unmount } = renderHook(useAutoLoadMore, {
      initialProps: props,
    });
    await act(async () => {
      await Promise.resolve();
    });
    rerender({ ...props, inView: false });
    const event =
      name === "keydown"
        ? new KeyboardEvent(name, { key: "PageDown", bubbles: true })
        : name === "pointerdown"
          ? new PointerEvent(name)
          : new Event(name);
    scroller.dispatchEvent(event);
    rerender(props);
    expect(fetchNextPage).toHaveBeenCalledTimes(2);
    await act(async () => {
      await Promise.resolve();
    });
    rerender({ ...props, inView: false });
    const remove = vi.spyOn(
      name === "keydown" ? window : scroller,
      "removeEventListener",
    );
    unmount();
    expect(remove).toHaveBeenCalledWith(name, expect.any(Function));
  },
);

it("supports window scrolling and ignores typing or upward wheel input", async () => {
  const boundary = document.createElement("button");
  document.body.append(boundary);
  const fetchNextPage = vi.fn();
  const props = {
    inView: true,
    boundary,
    hasNextPage: true,
    isFetchingNextPage: false,
    fetchNextPage,
  };
  const { rerender } = renderHook(useAutoLoadMore, { initialProps: props });
  await act(async () => {
    await Promise.resolve();
  });
  rerender({ ...props, inView: false });
  const input = document.createElement("input");
  document.body.append(input);
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: " ", bubbles: true }),
  );
  window.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
  rerender(props);
  expect(fetchNextPage).toHaveBeenCalledTimes(1);
  rerender({ ...props, inView: false });
  window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
  rerender(props);
  expect(fetchNextPage).toHaveBeenCalledTimes(2);
});

it("rearms from the window scrollbar but not card clicks", async () => {
  const boundary = document.createElement("button");
  document.body.append(boundary);
  const fetchNextPage = vi.fn();
  const props = {
    inView: true,
    boundary,
    hasNextPage: true,
    isFetchingNextPage: false,
    fetchNextPage,
  };
  const { rerender } = renderHook(useAutoLoadMore, { initialProps: props });
  await act(async () => {
    await Promise.resolve();
  });
  rerender({ ...props, inView: false });
  boundary.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  rerender(props);
  expect(fetchNextPage).toHaveBeenCalledTimes(1);
  rerender({ ...props, inView: false });
  document.documentElement.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true }),
  );
  rerender(props);
  expect(fetchNextPage).toHaveBeenCalledTimes(2);
});
