import { z } from "zod";

import type { ZBookmark } from "./types/bookmarks";

export const MEDIA_CATALOG_VERSION = 1;
export const zMediaCatalogResult = z
  .object({
    title: z.string().trim().min(1).max(180),
    summary: z.string().trim().min(1).max(1600),
    tags: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
  })
  .strict();
export type MediaCatalogResult = z.infer<typeof zMediaCatalogResult>;
export const zMediaCatalogState = z.object({
  runId: z.string(),
  fingerprint: z.string(),
  model: z.string(),
  status: z.enum([
    "pending",
    "processing",
    "success",
    "refused",
    "failed",
    "timeout",
    "rate_limited",
    "quota_exceeded",
    "stale",
    "cancelled",
  ]),
  updatedAt: z.string(),
  allowPreview: z.boolean(),
  automatic: z.boolean().optional(),
  result: zMediaCatalogResult.optional(),
  suppressedTags: z.array(z.string()).optional(),
});
export type MediaCatalogState = z.infer<typeof zMediaCatalogState>;

export function catalogBusy(state: MediaCatalogState | null | undefined) {
  return (
    !!state &&
    ["pending", "processing"].includes(state.status) &&
    Date.now() - Date.parse(state.updatedAt) < 360_000
  );
}

export function catalogSourceText(
  value: string | null | undefined,
  limit: number,
) {
  const text = (value ?? "")
    .normalize("NFKC")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (
    /^(?:\(\d+\)\s*)?(?:(?:Stories|Post isn[’']t available)\s*[•·]\s*)?Instagram$/i.test(
      text,
    )
  )
    return "";
  return text.slice(0, limit);
}

export function catalogInput(
  bookmark: Pick<ZBookmark, "content" | "assets">,
  allowPreview = false,
) {
  const originals = bookmark.assets
    .filter(
      (a) =>
        (a.assetType === "userUploaded" || a.assetType === "video") &&
        !a.fileName?.toLowerCase().endsWith(".poster.jpg") &&
        /\.(?:jpe?g|png|webp|avif|mp4|webm|mkv)$/i.test(a.fileName ?? ""),
    )
    .sort((a, b) => (a.fileName ?? a.id).localeCompare(b.fileName ?? b.id));
  const c = bookmark.content;
  // An archived text-only X post has an explicit source-text attachment. Ordinary
  // link previews and arbitrary uploaded text files do not opt into cloud analysis.
  let archivedText = false;
  if (
    !originals.length &&
    c.type === "link" &&
    catalogSourceText(c.description, 2500)
  ) {
    try {
      const url = new URL(c.url);
      const match = url.pathname.match(
        /^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/([1-9][0-9]{0,24})(?:\/(?:photo|video)\/[1-4])?\/?$/,
      );
      archivedText =
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        (!url.port || url.port === "443") &&
        [
          "x.com",
          "www.x.com",
          "twitter.com",
          "www.twitter.com",
          "mobile.twitter.com",
        ].includes(url.hostname) &&
        !!match &&
        bookmark.assets.some(
          (a) =>
            a.assetType === "userUploaded" &&
            new RegExp(`^x_${match[1]}_999_[0-9a-f]{12}\\.txt$`).test(
              a.fileName ?? "",
            ),
        );
    } catch {
      /* Invalid source URLs are not eligible. */
    }
  }
  const assets = originals.length
    ? originals
    : archivedText
      ? []
      : c.type === "asset" && c.assetType === "image"
        ? [{ id: c.assetId, fileName: c.fileName ?? "image.jpg" }]
        : c.type === "link" && allowPreview && c.imageAssetId
          ? [{ id: c.imageAssetId, fileName: "preview.jpg" }]
          : [];
  if (!assets.length && !archivedText) return null;
  const videos = assets.filter((a) =>
    /\.(mp4|webm|mkv)$/i.test(a.fileName ?? ""),
  ).length;
  return {
    assets: assets.map((a) => ({
      id: a.id,
      fileName: a.fileName ?? "image.jpg",
    })),
    media: {
      kind: archivedText
        ? "text"
        : videos === assets.length
          ? "video"
          : videos
            ? "mixed"
            : assets.length > 1
              ? "carousel"
              : "image",
      coverage: archivedText
        ? "archived_text"
        : originals.length
          ? "archived_media"
          : c.type === "asset"
            ? "saved_image"
            : "preview_only",
      asset_count: assets.length,
    },
    source: {
      title: c.type === "link" ? catalogSourceText(c.title, 500) : "",
      caption: c.type === "link" ? catalogSourceText(c.description, 2500) : "",
      author: c.type === "link" ? catalogSourceText(c.author, 160) : "",
    },
  };
}
export type CatalogInput = NonNullable<ReturnType<typeof catalogInput>>;

export function evenlySample<T>(items: T[], limit = 3): T[] {
  if (items.length <= limit) return items;
  return Array.from(
    { length: limit },
    (_, i) => items[Math.round((i * (items.length - 1)) / (limit - 1))],
  );
}

export function catalogTagKey(tag: string) {
  return tag
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\s_-]+/g, "");
}

export function normalizeCatalogTags(tags: string[], existing: string[] = []) {
  const names = new Map(
    existing.filter((t) => t.length <= 80).map((t) => [catalogTagKey(t), t]),
  );
  const seen = new Set<string>();
  return tags
    .map((t) => t.normalize("NFKC").trim().toLowerCase())
    .filter(
      (t) =>
        !/^social-media-|^instagram$|^nsfw$|^карусель$|^изображение$/.test(t),
    )
    .filter((t) => {
      const key = catalogTagKey(t);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((t) => names.get(catalogTagKey(t)) ?? t)
    .slice(0, 8);
}
