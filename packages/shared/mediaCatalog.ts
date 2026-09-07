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
  ]),
  updatedAt: z.string(),
  allowPreview: z.boolean(),
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
        a.assetType === "userUploaded" &&
        !a.fileName?.toLowerCase().endsWith(".poster.jpg") &&
        /\.(?:jpe?g|png|webp|avif|mp4)$/i.test(a.fileName ?? ""),
    )
    .sort((a, b) => (a.fileName ?? a.id).localeCompare(b.fileName ?? b.id));
  const c = bookmark.content;
  const assets = originals.length
    ? originals
    : c.type === "asset" && c.assetType === "image"
      ? [{ id: c.assetId, fileName: c.fileName ?? "image.jpg" }]
      : c.type === "link" && allowPreview && c.imageAssetId
        ? [{ id: c.imageAssetId, fileName: "preview.jpg" }]
        : [];
  if (!assets.length) return null;
  const videos = assets.filter((a) =>
    a.fileName?.toLowerCase().endsWith(".mp4"),
  ).length;
  return {
    assets: assets.map((a) => ({
      id: a.id,
      fileName: a.fileName ?? "image.jpg",
    })),
    media: {
      kind:
        videos === assets.length
          ? "video"
          : videos
            ? "mixed"
            : assets.length > 1
              ? "carousel"
              : "image",
      coverage: originals.length
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
    .replaceAll("ё", "е")
    .replace(/[\s_-]+/g, "");
}

export function normalizeCatalogTags(tags: string[], existing: string[] = []) {
  const names = new Map(existing.map((t) => [catalogTagKey(t), t]));
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
