"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { positionMasonry, visibleMasonry } from "@/lib/virtualMasonry";

function scrollParent(element: HTMLElement): HTMLElement | Window {
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return window;
}

/** Only visible cards, an overscan viewport and pinned interactions stay mounted. */
export default function VirtualMasonry({
  ids,
  columns,
  renderItem,
  focusedIndex = -1,
  persistentIndex = -1,
  estimateHeight = 360,
  layoutKey = "masonry",
}: {
  ids: readonly string[];
  columns: number;
  renderItem: (id: string, index: number) => ReactNode;
  focusedIndex?: number;
  persistentIndex?: number;
  estimateHeight?: number;
  layoutKey?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLElement | Window>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const observer = useRef<ResizeObserver>(null);
  const measured = useRef(
    new Map<string, { width: number; height: number; layout: string }>(),
  );
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState({ top: 0, height: 900, width: 0 });
  const [interacting, setInteracting] = useState<string | null>(null);
  const layoutRef = useRef(layoutKey);
  const readViewport = useCallback(() => {
    const element = host.current;
    if (!element) return;
    const parent = scrollParent(element);
    scroller.current = parent;
    const rect = element.getBoundingClientRect();
    const parentTop =
      parent instanceof HTMLElement
        ? parent.getBoundingClientRect().top + parent.clientTop
        : 0;
    const height =
      parent instanceof HTMLElement ? parent.clientHeight : window.innerHeight;
    const next = { top: parentTop - rect.top, height, width: rect.width };
    setView((old) =>
      Math.abs(old.top - next.top) < 1 &&
      old.width === next.width &&
      old.height === next.height
        ? old
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    layoutRef.current = layoutKey;
    const element = host.current!;
    let frame: number | null = null;
    const update = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        readViewport();
      });
    };
    const resize = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.virtualId;
        if (id === undefined) continue;
        const { width, height } = entry.contentRect;
        if (!width || !height) continue;
        const old = measured.current.get(id);
        if (
          !old ||
          Math.abs(old.height - height) > 1 ||
          old.width !== width ||
          old.layout !== layoutRef.current
        ) {
          measured.current.set(id, {
            width,
            height,
            layout: layoutRef.current,
          });
          changed = true;
        }
      }
      if (changed) setRevision((value) => value + 1);
      update();
    });
    observer.current = resize;
    resize.observe(element);
    for (const node of nodes.current.values()) resize.observe(node);
    // One handler follows both desktop nested scrolling and mobile window scrolling.
    window.addEventListener("scroll", update, { passive: true, capture: true });
    window.addEventListener("resize", update);
    readViewport();
    return () => {
      resize.disconnect();
      observer.current = null;
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [readViewport, layoutKey]);

  const register = useCallback((id: string, node: HTMLDivElement | null) => {
    const old = nodes.current.get(id);
    if (old) observer.current?.unobserve(old);
    if (node) {
      nodes.current.set(id, node);
      observer.current?.observe(node);
    } else nodes.current.delete(id);
  }, []);

  const itemWidth = view.width
    ? Math.max(1, (view.width - (columns - 1) * 16) / columns)
    : 320;
  const layout = useMemo(
    () =>
      positionMasonry(ids, columns, (id) => {
        const size = measured.current.get(id);
        return size &&
          Math.abs(size.width - itemWidth) < 1 &&
          size.layout === layoutKey
          ? size.height
          : estimateHeight;
      }),
    [ids, columns, itemWidth, estimateHeight, layoutKey, revision],
  );
  const previous = useRef<{ layout: typeof layout; top: number }>(null);
  useLayoutEffect(() => {
    const before = previous.current;
    if (before && before.layout !== layout && before.top > 0) {
      const visible = visibleMasonry(
        before.layout.lanes,
        before.top,
        before.top + view.height,
      );
      const positions = layout.byId;
      const anchor = visible.find((p) => positions.has(p.id));
      if (anchor) {
        const delta = positions.get(anchor.id)!.top - anchor.top;
        if (Math.abs(delta) > 1)
          scroller.current?.scrollBy({ top: delta, behavior: "instant" });
      } else {
        scroller.current?.scrollBy({ top: -before.top, behavior: "instant" });
      }
      readViewport();
    }
    previous.current = { layout, top: view.top };
  }, [layout, view.top, view.height, readViewport]);
  useLayoutEffect(() => {
    const remaining = new Set(ids);
    for (const id of measured.current.keys())
      if (!remaining.has(id)) measured.current.delete(id);
  }, [ids]);

  const visible = visibleMasonry(
    layout.lanes,
    view.top - view.height,
    view.top + view.height * 2,
  );
  const mounted = new Set(visible.map((p) => p.index));
  for (const index of [
    focusedIndex,
    persistentIndex,
    interacting === null ? -1 : (layout.byId.get(interacting)?.index ?? -1),
  ]) {
    if (index >= 0 && index < ids.length) mounted.add(index);
  }
  return (
    <div
      ref={host}
      role="list"
      data-virtual-grid
      style={{
        position: "relative",
        height: layout.height,
        overflowAnchor: "none",
      }}
    >
      {[...mounted]
        .sort((a, b) => a - b)
        .map((index) => {
          const item = layout.positions[index];
          return (
            <MeasuredCard
              key={item.id}
              id={item.id}
              index={index}
              size={ids.length}
              register={register}
              onInteract={setInteracting}
              style={{
                position: "absolute",
                display: "flow-root",
                width: `calc((100% - ${(columns - 1) * 16}px) / ${columns})`,
                left: `calc(${item.column} * ((100% + 16px) / ${columns}))`,
                top: item.top,
              }}
            >
              {renderItem(item.id, index)}
            </MeasuredCard>
          );
        })}
    </div>
  );
}

function MeasuredCard({
  id,
  index,
  size,
  register,
  onInteract,
  children,
  style,
}: {
  id: string;
  index: number;
  size: number;
  register: (id: string, node: HTMLDivElement | null) => void;
  onInteract: (id: string) => void;
  children: ReactNode;
  style: React.CSSProperties;
}) {
  const ref = useCallback(
    (node: HTMLDivElement | null) => register(id, node),
    [id, register],
  );
  return (
    <div
      ref={ref}
      role="listitem"
      aria-posinset={index + 1}
      aria-setsize={size}
      data-virtual-id={id}
      style={style}
      onPointerDownCapture={() => onInteract(id)}
      onFocusCapture={() => onInteract(id)}
    >
      {children}
    </div>
  );
}
