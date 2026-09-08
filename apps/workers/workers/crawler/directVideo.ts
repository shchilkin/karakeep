import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { and, eq } from "drizzle-orm";
import { execa } from "execa";
import type { RunProxyConfig } from "network";
import { updateAsset } from "workerUtils";

import { db } from "@karakeep/db";
import { assets, AssetTypes, bookmarkLinks } from "@karakeep/db/schema";
import {
  createAssetReadStream,
  newAssetId,
  QuotaService,
  saveAsset,
  silentDeleteAsset,
  VIDEO_ASSET_TYPES,
} from "@karakeep/shared-server";
import { requestMediaCatalog } from "@karakeep/trpc/models/mediaCatalog";
import { downloadAndStoreFile } from "./assetStorage";

const extensions: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
};

export async function downloadDirectVideo({
  url,
  userId,
  bookmarkId,
  jobId,
  abortSignal,
  runProxy,
}: {
  url: string;
  userId: string;
  bookmarkId: string;
  jobId: string;
  abortSignal: AbortSignal;
  runProxy: RunProxyConfig;
}) {
  const baseName = `direct-video-${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
  // A retry after indexing/queue failure reuses the already attached original.
  const existing = await db.query.assets.findFirst({
    where: and(
      eq(assets.bookmarkId, bookmarkId),
      eq(assets.assetType, AssetTypes.LINK_VIDEO),
    ),
  });
  const existingPoster = await db.query.assets.findFirst({
    where: and(
      eq(assets.bookmarkId, bookmarkId),
      eq(assets.assetType, AssetTypes.LINK_BANNER_IMAGE),
    ),
  });
  if (
    existing?.fileName?.startsWith(`${baseName}.`) &&
    existingPoster?.fileName === `${baseName}.poster.jpg`
  ) {
    await requestMediaCatalog(db, userId, bookmarkId, { automatic: true });
    return;
  }
  const downloaded = await downloadAndStoreFile(
    url,
    userId,
    jobId,
    "video",
    abortSignal,
    runProxy,
    VIDEO_ASSET_TYPES,
  );
  if (!downloaded) throw new Error("Failed to download required video asset");
  let directory: string | undefined;
  let committed = false;
  const posterId = newAssetId();
  try {
    directory = await mkdtemp(path.join(tmpdir(), "karakeep-direct-video-"));
    const fileName = `${baseName}.${extensions[downloaded.contentType]}`;
    const file = path.join(directory, fileName);
    await pipeline(
      await createAssetReadStream({ userId, assetId: downloaded.assetId }),
      createWriteStream(file, { mode: 0o600 }),
      { signal: abortSignal },
    );
    const posterPath = path.join(directory, "poster.jpg");
    await execa(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-threads",
        "1",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "mov,matroska,webm",
        "-i",
        file,
        "-frames:v",
        "1",
        "-vf",
        "scale=1280:1280:force_original_aspect_ratio=decrease",
        "-threads",
        "1",
        posterPath,
      ],
      {
        cancelSignal: abortSignal,
        timeout: 20_000,
        maxBuffer: 65536,
      },
    );
    const poster = await readFile(posterPath);
    if (!poster.length) throw new Error("Video has no decodable first frame");
    const quotaApproved = await QuotaService.checkStorageQuota(
      db,
      userId,
      downloaded.size + poster.length,
    );
    await saveAsset({
      userId,
      assetId: posterId,
      asset: poster,
      metadata: { contentType: "image/jpeg" },
      quotaApproved,
    });
    abortSignal.throwIfAborted();
    const replaced = db.transaction(
      (tx) => {
        const link = tx
          .select()
          .from(bookmarkLinks)
          .where(eq(bookmarkLinks.id, bookmarkId))
          .get();
        if (!link || link.url !== url)
          throw new Error("Bookmark changed during media download");
        // Read replacements under the write lock: overlapping recrawls must not
        // leave duplicate video rows after one finishes ahead of the other.
        const previous = tx
          .select()
          .from(assets)
          .where(eq(assets.bookmarkId, bookmarkId))
          .all();
        const oldVideo = previous.find(
          (a) => a.assetType === AssetTypes.LINK_VIDEO,
        )?.id;
        const oldPoster = previous.find(
          (a) => a.assetType === AssetTypes.LINK_BANNER_IMAGE,
        )?.id;
        updateAsset(
          oldVideo,
          {
            id: downloaded.assetId,
            bookmarkId,
            userId,
            assetType: AssetTypes.LINK_VIDEO,
            contentType: downloaded.contentType,
            size: downloaded.size,
            fileName,
          },
          tx,
        );
        updateAsset(
          oldPoster,
          {
            id: posterId,
            bookmarkId,
            userId,
            assetType: AssetTypes.LINK_BANNER_IMAGE,
            contentType: "image/jpeg",
            size: poster.length,
            fileName: `${baseName}.poster.jpg`,
          },
          tx,
        );
        tx.update(bookmarkLinks)
          .set({ crawledAt: new Date() })
          .where(eq(bookmarkLinks.id, bookmarkId))
          .run();
        return [oldVideo, oldPoster];
      },
      { behavior: "immediate" },
    );
    committed = true;
    for (const id of replaced) await silentDeleteAsset(userId, id);
    await requestMediaCatalog(db, userId, bookmarkId, { automatic: true });
  } finally {
    if (!committed) {
      await silentDeleteAsset(userId, downloaded.assetId);
      await silentDeleteAsset(userId, posterId);
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
