import { useCallback, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
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
}: {
  src: string;
  alt: string;
  naturalSize: boolean;
  className?: string;
  srcSet?: string;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const imageRef = useCallback((image: HTMLImageElement | null) => {
    // A cached image may finish before React attaches its load listener.
    if (image?.complete && image.naturalWidth > 0) setStatus("ready");
  }, []);

  if (status === "error") {
    return (
      <span className="flex aspect-square w-full flex-col items-center justify-center gap-3 bg-muted px-6 text-center text-sm text-muted-foreground">
        <ImageOff className="size-6" aria-hidden="true" />
        {t("preview.gallery.load_error")}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "relative block w-full overflow-hidden rounded-xl",
        !naturalSize && "h-full",
      )}
      aria-busy={status === "loading"}
    >
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
        sizes={
          srcSet
            ? "auto, (max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            : undefined
        }
        decoding="async"
        loading="lazy"
        onLoad={() => setStatus("ready")}
        onError={() => setStatus("error")}
        className={cn(
          "relative block w-full transition-opacity duration-150 motion-reduce:transition-none",
          status === "loading" ? "opacity-0" : "opacity-100",
          naturalSize ? "h-auto" : "aspect-square h-full",
          naturalSize && status === "loading" && "aspect-[4/3] object-contain",
          className,
        )}
      />
    </span>
  );
}
