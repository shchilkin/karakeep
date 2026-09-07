"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { BookmarkMedia } from "@/lib/bookmarkImages";
import { getMediaCoverId } from "@/lib/bookmarkImages";
import { useTranslation } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ImageOff,
  Maximize2,
  Play,
} from "lucide-react";

import { getAssetUrl } from "@karakeep/shared/utils/assetUtils";

function GalleryImage({
  image,
  alt,
  suspended = false,
}: {
  image: BookmarkMedia;
  alt: string;
  suspended?: boolean;
}) {
  const { t } = useTranslation();
  const labels = image.video ? "preview.media" : "preview.gallery";
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );

  if (status === "error") {
    return (
      <span className="flex max-w-xs flex-col items-center gap-3 px-6 text-center text-sm text-muted-foreground">
        <ImageOff className="size-8" aria-hidden="true" />
        {t(`${labels}.load_error`)}
      </span>
    );
  }

  if (image.video && !suspended) {
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption -- Archived source videos do not supply caption tracks; retain native playback controls.
      <video
        key={image.id}
        src={getAssetUrl(image.id)}
        poster={
          image.video.posterId ? getAssetUrl(image.video.posterId) : undefined
        }
        controls
        playsInline
        preload="none"
        aria-label={alt}
        onError={() => setStatus("error")}
        className="relative z-10 max-h-full max-w-full rounded-xl bg-black object-contain"
      />
    );
  }
  const coverId = getMediaCoverId(image);
  if (!coverId) return <Play className="size-10" aria-label={alt} />;
  return (
    <>
      {status === "loading" && (
        <span role="status" className="absolute text-sm text-muted-foreground">
          {t(`${labels}.loading`)}
        </span>
      )}
      <Image
        src={getAssetUrl(coverId)}
        alt={alt}
        width={0}
        height={0}
        sizes="(min-width: 1024px) 65vw, 100vw"
        unoptimized
        draggable={false}
        onLoad={() => setStatus("ready")}
        onError={() => setStatus("error")}
        className={cn(
          "relative h-auto max-h-full w-auto max-w-full rounded-xl object-contain shadow-xl transition-opacity duration-200 motion-reduce:transition-none",
          status === "loading" ? "opacity-0" : "opacity-100",
        )}
      />
    </>
  );
}

export default function SavedImageGallery({
  images,
  title,
}: {
  images: BookmarkMedia[];
  title: string;
}) {
  const { t } = useTranslation();
  const labels = images.some((image) => image.video)
    ? "preview.media"
    : "preview.gallery";
  const [selectedId, setSelectedId] = useState(images[0]?.id);
  const [expanded, setExpanded] = useState(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const lastSwipe = useRef(0);
  const enlargeTrigger = useRef<HTMLButtonElement>(null);
  const thumbnailStrip = useRef<HTMLDivElement>(null);
  const selectedThumbnail = useRef<HTMLButtonElement>(null);
  const activeIndex = Math.max(
    0,
    images.findIndex((image) => image.id === selectedId),
  );
  const active = images[activeIndex];

  useEffect(() => {
    const strip = thumbnailStrip.current;
    const thumbnail = selectedThumbnail.current;
    if (strip && thumbnail) {
      strip.scrollLeft =
        thumbnail.offsetLeft -
        strip.offsetLeft -
        (strip.clientWidth - thumbnail.clientWidth) / 2;
    }
  }, [active?.id, expanded]);

  if (!active) return null;

  const select = (index: number) => {
    const image = images[index];
    if (image) setSelectedId(image.id);
  };
  const previous = images[activeIndex - 1];
  const next = images[activeIndex + 1];
  const imageLabel = t(`${labels}.image_label`, {
    title,
    current: activeIndex + 1,
    total: images.length,
  });

  const carousel = (fullscreen: boolean) => (
    <section
      aria-label={t(`${labels}.saved_photos`)}
      aria-roledescription="carousel"
      className="flex h-full min-h-0 w-full flex-col rounded-xl"
      onKeyDown={(event) => {
        if (
          event.target instanceof HTMLVideoElement ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey
        )
          return;
        const index = {
          ArrowLeft: activeIndex - 1,
          ArrowRight: activeIndex + 1,
          Home: 0,
          End: images.length - 1,
        }[event.key];
        if (index === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        select(index);
      }}
    >
      <div
        className="relative flex min-h-0 flex-1 touch-pan-y items-center justify-center overflow-hidden px-5 py-4 sm:px-12 sm:py-8"
        onTouchStart={(event) => {
          if (event.target instanceof HTMLVideoElement) return;
          const touch = event.touches[0];
          touchStart.current =
            event.touches.length === 1 && touch
              ? { x: touch.clientX, y: touch.clientY }
              : null;
        }}
        onTouchCancel={() => {
          touchStart.current = null;
        }}
        onTouchEnd={(event) => {
          const start = touchStart.current;
          touchStart.current = null;
          const end = event.changedTouches[0];
          if (!start || !end) return;
          const dx = end.clientX - start.x;
          const dy = end.clientY - start.y;
          if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            lastSwipe.current = Date.now();
            select(activeIndex + (dx < 0 ? 1 : -1));
          }
        }}
      >
        {!fullscreen &&
          [previous, next].map(
            (image, index) =>
              image &&
              getMediaCoverId(image) && (
                <Image
                  key={image.id}
                  src={getAssetUrl(getMediaCoverId(image)!)}
                  alt=""
                  aria-hidden="true"
                  width={0}
                  height={0}
                  unoptimized
                  draggable={false}
                  className={cn(
                    "pointer-events-none absolute hidden h-auto max-h-[65%] w-auto max-w-[48%] rounded-xl object-contain opacity-40 sm:block",
                    index === 0 ? "left-[6%] -rotate-3" : "right-[6%] rotate-3",
                  )}
                />
              ),
          )}
        {fullscreen || active.video ? (
          <div className="relative flex h-full min-h-0 w-full items-center justify-center">
            <GalleryImage
              key={active.id}
              image={active}
              alt={imageLabel}
              suspended={expanded && !fullscreen}
            />
          </div>
        ) : (
          <button
            type="button"
            aria-label={t(`${labels}.enlarge`)}
            className="relative z-10 flex h-full min-h-0 w-full cursor-zoom-in items-center justify-center rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-[78%]"
            onClick={(event) => {
              if (Date.now() - lastSwipe.current > 400) {
                enlargeTrigger.current = event.currentTarget;
                setExpanded(true);
              }
            }}
          >
            <GalleryImage
              key={active.id}
              image={active}
              alt={imageLabel}
              suspended={expanded && !fullscreen}
            />
          </button>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-center gap-3 px-4 pb-4 sm:pb-6">
        <div className="flex items-center gap-2">
          {images.length > 1 && (
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              aria-label={t(`${labels}.previous`)}
              disabled={!previous}
              onClick={() => select(activeIndex - 1)}
            >
              <ChevronLeft className="size-5" />
            </Button>
          )}
          <span
            aria-live="polite"
            aria-atomic="true"
            className="min-w-14 text-center text-sm tabular-nums text-muted-foreground"
          >
            {activeIndex + 1} / {images.length}
          </span>
          {images.length > 1 && (
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              aria-label={t(`${labels}.next`)}
              disabled={!next}
              onClick={() => select(activeIndex + 1)}
            >
              <ChevronRight className="size-5" />
            </Button>
          )}
          {!fullscreen && (
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              aria-label={t(`${labels}.enlarge`)}
              onClick={(event) => {
                enlargeTrigger.current = event.currentTarget;
                setExpanded(true);
              }}
            >
              <Maximize2 className="size-4" />
            </Button>
          )}
          <a
            href={getAssetUrl(active.id)}
            download={active.fileName ?? true}
            aria-label={t(`${labels}.download`)}
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon" }),
              "rounded-full",
            )}
          >
            <Download className="size-4" />
          </a>
        </div>
        {images.length > 1 && (
          <div
            ref={fullscreen === expanded ? thumbnailStrip : undefined}
            aria-label={t(`${labels}.choose_photo`)}
            className="flex max-w-full gap-2 overflow-x-auto px-1 py-1"
          >
            {images.map((image, index) => (
              <button
                key={image.id}
                ref={
                  fullscreen === expanded && image.id === active.id
                    ? selectedThumbnail
                    : undefined
                }
                type="button"
                aria-label={t(`${labels}.go_to`, { current: index + 1 })}
                aria-pressed={image.id === active.id}
                onClick={() => select(index)}
                className={cn(
                  "relative size-11 shrink-0 overflow-hidden rounded-lg outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none sm:size-12",
                  image.id === active.id
                    ? "ring-2 ring-foreground ring-offset-2 ring-offset-background"
                    : "opacity-50 hover:opacity-100",
                )}
              >
                {getMediaCoverId(image) && (
                  <Image
                    src={getAssetUrl(getMediaCoverId(image)!)}
                    alt=""
                    fill
                    unoptimized
                    sizes="48px"
                    loading="lazy"
                    className="object-cover"
                  />
                )}
                {image.video && (
                  <Play
                    className="absolute bottom-1 right-1 size-3.5 fill-white text-white"
                    aria-hidden="true"
                  />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );

  return (
    <>
      {carousel(false)}
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          className="h-[96dvh] max-w-[96vw] gap-0 border-0 bg-background p-2 pt-10 shadow-none sm:p-4 sm:pt-10"
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            enlargeTrigger.current?.focus();
          }}
        >
          <DialogTitle className="sr-only">{title}</DialogTitle>
          {carousel(true)}
        </DialogContent>
      </Dialog>
    </>
  );
}
