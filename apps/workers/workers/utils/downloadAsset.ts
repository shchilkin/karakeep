import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "node:path";
import * as os from "os";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { fetchWithProxy, getBookmarkDomain } from "network";
import type { RunProxyConfig } from "network";
import { db } from "@karakeep/db";
import {
  extractImageDimensions,
  getTracer,
  newAssetId,
  QuotaService,
  saveAssetFromFile,
  withSpan,
} from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";
import { tryCatch } from "@karakeep/shared/tryCatch";
import { normalizeContentType, truncateUrl } from "./crawlerUtils";
const tracer = getTracer("@karakeep/workers");

export async function downloadAndStoreFile(
  url: string,
  userId: string,
  jobId: string,
  fileType: string,
  abortSignal: AbortSignal,
  runProxy: RunProxyConfig,
  expectedContentTypes?: ReadonlySet<string>,
) {
  return await withSpan(
    tracer,
    "crawlerWorker.downloadAndStoreFile",
    {
      attributes: {
        "bookmark.url": url,
        "bookmark.domain": getBookmarkDomain(url),
        "job.id": jobId,
        "user.id": userId,
        "asset.type": fileType,
      },
    },
    async () => {
      let assetPath: string | undefined;
      try {
        logger.info(
          `[Crawler][${jobId}] Downloading ${fileType} from "${truncateUrl(url)}"`,
        );
        const response = await fetchWithProxy(
          url,
          {
            signal: abortSignal,
          },
          runProxy,
        );
        if (!response.ok || response.body == null) {
          throw new Error(`Failed to download ${fileType}: ${response.status}`);
        }

        const contentType = normalizeContentType(
          response.headers.get("content-type"),
        );
        if (!contentType) {
          throw new Error("No content type in the response");
        }
        if (expectedContentTypes && !expectedContentTypes.has(contentType)) {
          if (response.body instanceof Readable) response.body.destroy();
          throw new Error(
            `Unexpected ${fileType} content type: ${contentType}`,
          );
        }

        const assetId = newAssetId();
        assetPath = path.join(os.tmpdir(), assetId);

        let bytesRead = 0;
        const contentLengthEnforcer = new Transform({
          transform(chunk, _, callback) {
            bytesRead += chunk.length;

            if (abortSignal.aborted) {
              callback(new Error("AbortError"));
            } else if (bytesRead > serverConfig.maxAssetSizeMb * 1024 * 1024) {
              callback(
                new Error(
                  `Content length exceeds maximum allowed size: ${serverConfig.maxAssetSizeMb}MB`,
                ),
              );
            } else {
              callback(null, chunk); // pass data along unchanged
            }
          },
          flush(callback) {
            callback();
          },
        });

        await pipeline(
          response.body,
          contentLengthEnforcer,
          fsSync.createWriteStream(assetPath),
        );

        // Check storage quota before saving the asset
        const { data: quotaApproved, error: quotaError } = await tryCatch(
          QuotaService.checkStorageQuota(db, userId, bytesRead),
        );

        if (quotaError) {
          logger.warn(
            `[Crawler][${jobId}] Skipping ${fileType} storage due to quota exceeded: ${quotaError.message}`,
          );
          return null;
        }

        const dimensions = await extractImageDimensions(assetPath, contentType);
        await saveAssetFromFile({
          userId,
          assetId,
          metadata: { contentType },
          assetPath,
          quotaApproved,
        });

        logger.info(
          `[Crawler][${jobId}] Downloaded ${fileType} as assetId: ${assetId} (${bytesRead} bytes)`,
        );

        return { assetId, userId, contentType, size: bytesRead, dimensions };
      } catch (e) {
        logger.error(
          `[Crawler][${jobId}] Failed to download and store ${fileType}: ${e}`,
        );
        // A crawler timeout aborts the job-wide signal. Do not turn that abort
        // into a best-effort download miss: the queue runner must observe it so
        // the crawl is retried and is not reported as successfully completed.
        abortSignal.throwIfAborted();
        return null;
      } finally {
        if (assetPath) {
          await tryCatch(fs.unlink(assetPath));
        }
      }
    },
  );
}
