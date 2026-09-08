import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Context } from "hono";
import sharp from "sharp";

import {
  createAssetReadStream,
  getAssetSize,
  readAssetMetadata,
} from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import type { ThumbnailWidth } from "@karakeep/shared/utils/assetUtils";

import { ThumbnailBusyError, ThumbnailCache } from "./thumbnailCache";

const cache = new ThumbnailCache(
  path.join(serverConfig.dataDir, "cache", "thumbnails-v1"),
);
const maxInputBytes = 64 * 1024 * 1024;
const types = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

/** Called only after the same asset authorization as an original download. */
export async function serveThumbnail(
  c: Context,
  assetId: string,
  userId: string,
  width: ThumbnailWidth,
) {
  const metadata = await readAssetMetadata({ assetId, userId });
  if (!types.has(metadata.contentType))
    return c.json({ error: "No thumbnail for this file type" }, 415);
  if ((await getAssetSize({ assetId, userId })) > maxInputBytes) {
    return c.json({ error: "Image exceeds thumbnail input limit" }, 413);
  }
  try {
    const buffer = await cache.get(
      JSON.stringify([userId, assetId, width]),
      async () => {
        let bytes = 0;
        const limit = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            callback(
              bytes > maxInputBytes
                ? new Error("Thumbnail input limit exceeded")
                : null,
              chunk,
            );
          },
        });
        const resize = sharp({
          animated: false,
          limitInputPixels: 40_000_000,
          sequentialRead: true,
        })
          .rotate()
          .resize({
            width,
            withoutEnlargement: true,
          })
          .webp({ quality: 78, effort: 2 })
          .timeout({ seconds: 15 });
        const source = await createAssetReadStream({ assetId, userId });
        const [, output] = await Promise.all([
          pipeline(source, limit, resize, {
            signal: AbortSignal.timeout(20_000),
          }),
          resize.toBuffer(),
        ]);
        return output;
      },
    );
    c.header("Cache-Control", "private, max-age=31536000, immutable");
    c.header("Content-Type", "image/webp");
    c.header("Content-Length", String(buffer.length));
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(new Uint8Array(buffer));
  } catch (error) {
    if (error instanceof ThumbnailBusyError) {
      c.header("Retry-After", "1");
      return c.json({ error: "Thumbnail generation is busy" }, 503);
    }
    return c.json({ error: "Thumbnail could not be generated" }, 422);
  }
}
