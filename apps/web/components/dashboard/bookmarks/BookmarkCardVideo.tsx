"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

import BookmarkCardImage from "./BookmarkCardImage";

/** The image owns layout; video bytes are requested only after hover/focus. */
export default function BookmarkCardVideo({
  src,
  poster,
  alt,
  naturalSize,
  className,
}: {
  src: string;
  poster: string;
  alt: string;
  naturalSize: boolean;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [requested, setRequested] = useState(false);
  const [playing, setPlaying] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = host.current;
    const trigger = element?.closest("a");
    if (!element || !trigger) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let hovered = false;
    let focused = false;
    let visible = true;
    const update = () =>
      setRequested(
        (hovered || focused) && visible && !document.hidden && !reduced.matches,
      );
    const enter = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      hovered = true;
      update();
    };
    const leave = () => {
      hovered = false;
      update();
    };
    const focus = () => {
      focused = trigger.matches(":focus-visible");
      update();
    };
    const blur = () => {
      focused = false;
      update();
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      update();
    });
    observer.observe(element);
    trigger.addEventListener("pointerenter", enter);
    trigger.addEventListener("pointerleave", leave);
    trigger.addEventListener("focus", focus);
    trigger.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", update);
    reduced.addEventListener("change", update);
    return () => {
      observer.disconnect();
      trigger.removeEventListener("pointerenter", enter);
      trigger.removeEventListener("pointerleave", leave);
      trigger.removeEventListener("focus", focus);
      trigger.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", update);
      reduced.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    const element = video.current;
    if (!requested || !element) {
      setPlaying(false);
      return;
    }
    let cancelled = false;
    element.muted = true;
    element.play().catch(() => {
      if (!cancelled) setPlaying(false);
    });
    return () => {
      cancelled = true;
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [requested]);

  return (
    <div ref={host} className="relative h-full w-full">
      <BookmarkCardImage
        key={poster}
        src={poster}
        alt={alt}
        naturalSize={naturalSize}
        className={className}
      />
      {requested && (
        <video
          ref={video}
          src={src}
          poster={poster}
          muted
          loop
          playsInline
          preload="none"
          aria-hidden="true"
          tabIndex={-1}
          onPlaying={() => setPlaying(true)}
          onError={() => setPlaying(false)}
          className={cn(
            "pointer-events-none absolute inset-0 size-full object-cover",
            !playing && "opacity-0",
          )}
        />
      )}
    </div>
  );
}
