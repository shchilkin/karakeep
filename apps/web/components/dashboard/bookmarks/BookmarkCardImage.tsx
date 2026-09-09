import { useCallback, useContext, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CardImageDimensionsContext,
  validImageDimensions,
} from "@/lib/cardImageDimensions";
import type { ImageDimensions } from "@/lib/cardImageDimensions";
import { useTranslation } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { ImageOff } from "lucide-react";

/** Key by src so replacing a cover also resets its loading/error state. */
export default function BookmarkCardImage({
  src,
  alt,
  naturalSize,
  className,
  srcSet,
  dimensions: sourceDimensions,
}: {
  src: string;
  alt: string;
  naturalSize: boolean;
  className?: string;
  srcSet?: string;
  dimensions?: ImageDimensions;
}) {
  const { t } = useTranslation();
  const savedDimensions = useContext(CardImageDimensionsContext);
  const [learnedDimensions, setDimensions] = useState(() =>
    savedDimensions?.current?.src === src ? savedDimensions.current : undefined,
  );
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const loaded = useCallback(
    (image: HTMLImageElement) => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        const next = {
          src,
          width: image.naturalWidth,
          height: image.naturalHeight,
        };
        if (savedDimensions) savedDimensions.current = next;
        setDimensions(next);
      }
      setStatus("ready");
    },
    [src, savedDimensions],
  );
  const imageRef = useCallback(
    (image: HTMLImageElement | null) => {
      // A cached image may finish before React attaches its load listener.
      if (image?.complete && image.naturalWidth > 0) loaded(image);
    },
    [loaded],
  );
  // Keep the original ratio even when a responsive thumbnail rounds its pixels.
  const dimensions =
    validImageDimensions(sourceDimensions) ?? learnedDimensions;
  const aspectRatio = dimensions
    ? `${dimensions.width} / ${dimensions.height}`
    : "4 / 3";

  return (
    <span
      className={cn(
        "relative block w-full overflow-hidden rounded-xl",
        !naturalSize && "h-full",
      )}
      style={naturalSize ? { aspectRatio } : undefined}
      aria-busy={status === "loading"}
    >
      {status === "error" ? (
        <span
          className={cn(
            "flex w-full flex-col items-center justify-center gap-3 bg-muted px-6 text-center text-sm text-muted-foreground",
            naturalSize ? "absolute inset-0" : "aspect-square h-full",
            className,
          )}
        >
          <ImageOff className="size-6" aria-hidden="true" />
          {t("preview.gallery.load_error")}
        </span>
      ) : (
        <>
          {status === "loading" && (
            <Skeleton
              aria-hidden="true"
              className="absolute inset-0 rounded-[inherit] bg-muted-foreground/10"
            />
          )}
          {/* eslint-disable-next-line @next/next/no-img-element -- Authenticated server thumbnails supply responsive sources directly. */}
          <img
            ref={imageRef}
            src={src}
            alt={alt}
            srcSet={srcSet}
            width={dimensions?.width}
            height={dimensions?.height}
            style={naturalSize ? { aspectRatio } : undefined}
            sizes={
              srcSet
                ? "auto, (max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                : undefined
            }
            decoding="async"
            loading="lazy"
            onLoad={(event) => loaded(event.currentTarget)}
            onError={() => setStatus("error")}
            className={cn(
              "relative block w-full transition-opacity duration-150 motion-reduce:transition-none",
              status === "loading" ? "opacity-0" : "opacity-100",
              naturalSize
                ? "absolute inset-0 h-full object-contain"
                : "aspect-square h-full",
              className,
            )}
          />
        </>
      )}
    </span>
  );
}
