import { useState } from "react";
import Image from "next/image";
import { useTranslation } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { ImageOff } from "lucide-react";

/** Key by src so replacing a cover also resets its loading/error state. */
export default function BookmarkCardImage({
  src,
  alt,
  naturalSize,
  className,
}: {
  src: string;
  alt: string;
  naturalSize: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );

  if (status === "error") {
    return (
      <span className="flex aspect-square w-full flex-col items-center justify-center gap-3 bg-muted px-6 text-center text-sm text-muted-foreground">
        <ImageOff className="size-6" aria-hidden="true" />
        {t("preview.gallery.load_error")}
      </span>
    );
  }

  return (
    <Image
      src={src}
      alt={alt}
      width={0}
      height={0}
      unoptimized
      loading="lazy"
      onLoad={() => setStatus("ready")}
      onError={() => setStatus("error")}
      className={cn(
        "block w-full",
        naturalSize ? "h-auto" : "aspect-square h-full",
        naturalSize && status === "loading" && "aspect-[4/3] object-contain",
        className,
      )}
    />
  );
}
