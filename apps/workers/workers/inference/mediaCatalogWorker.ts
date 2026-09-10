import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { db } from "@karakeep/db";
import {
  getAssetSize,
  MediaCatalogQueue,
  readAsset,
} from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import { evenlySample } from "@karakeep/shared/mediaCatalog";
import type { CatalogInput } from "@karakeep/shared/mediaCatalog";
import { getQueueClient } from "@karakeep/shared/queueing";
import type { DequeuedJob } from "@karakeep/shared/queueing";
import {
  finishMediaCatalog,
  reindexMediaCatalog,
  startMediaCatalog,
  continueMediaCatalog,
  recoverLocalMediaCatalog,
  reconcileLocalMediaCatalog,
} from "@karakeep/trpc/models/mediaCatalog";
import type { CatalogJob } from "@karakeep/trpc/models/mediaCatalog";
import { RuleEngine } from "@karakeep/trpc/lib/ruleEngine";
import {
  catalogRequest,
  CatalogFailure,
  inferMediaCatalog,
} from "./mediaCatalogProvider";
import { checkLocalMedia, reusableLocalCheck } from "./mediaLocalProvider";

export async function prepareCatalogImages(
  userId: string,
  input: CatalogInput,
  signal: AbortSignal,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "karakeep-media-ai-"));
  const frames: Buffer[] = [];
  try {
    const chosen = evenlySample(input.assets);
    for (const [index, item] of chosen.entries()) {
      signal.throwIfAborted();
      const maxBytes = 50 * 1024 * 1024;
      if ((await getAssetSize({ userId, assetId: item.id })) > maxBytes)
        throw new CatalogFailure("failed");
      const { asset } = await readAsset({
        userId,
        assetId: item.id,
        start: 0,
        end: maxBytes,
      });
      if (!asset?.length || asset.length > maxBytes)
        throw new CatalogFailure("failed");
      const file = path.join(
        directory,
        `${index}${path.extname(item.fileName)}`,
      );
      await writeFile(file, asset, { mode: 0o600 });
      const isVideo = /\.(mp4|webm|mkv)$/i.test(file);
      let timestamps = [0];
      if (isVideo && chosen.length === 1) {
        const probe = await execa(
          "ffprobe",
          [
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            file,
          ],
          { timeout: 20_000, cancelSignal: signal, maxBuffer: 65536 },
        );
        const duration = Number(JSON.parse(probe.stdout).format.duration);
        if (!Number.isFinite(duration) || duration <= 0)
          throw new CatalogFailure("failed");
        timestamps = [0, duration * 0.5, duration * 0.9];
      }
      for (const timestamp of timestamps) {
        const output = await execa(
          "ffmpeg",
          [
            "-v",
            "error",
            "-threads",
            "1",
            "-protocol_whitelist",
            "file,pipe",
            // Seeking can discard the only frame of a large still image.
            ...(isVideo ? ["-ss", String(timestamp)] : []),
            "-i",
            file,
            "-frames:v",
            "1",
            "-vf",
            "scale=768:768:force_original_aspect_ratio=decrease",
            "-threads",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "pipe:1",
          ],
          {
            timeout: 20_000,
            cancelSignal: signal,
            encoding: "buffer",
            maxBuffer: 2 * 1024 * 1024,
          },
        );
        if (!output.stdout.length) throw new CatalogFailure("failed");
        frames.push(Buffer.from(output.stdout));
      }
      await rm(file);
    }
    return frames;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runMediaCatalog(job: DequeuedJob<CatalogJob>) {
  const config = serverConfig.mediaAi;
  if (!config.enabled || (!config.apiKey && config.localMode === "off")) {
    finishMediaCatalog(db, job.data, "failed");
    return;
  }
  const started = startMediaCatalog(db, job.data);
  if (!started) {
    await reconcileLocalMediaCatalog(db, job.data).catch(() => undefined);
    return;
  }
  let attachedTagIds: string[] = [];
  let cloudStarted =
    !started.state.localMode || started.state.localMode === "off";
  try {
    const images = await prepareCatalogImages(
      job.data.userId,
      started.input,
      job.abortSignal,
    );
    if (started.state.localMode && started.state.localMode !== "off") {
      if (!images.length) {
        finishMediaCatalog(db, job.data, "local_only");
        return;
      }
      const local =
        (started.state.localCheckFingerprint === started.state.fingerprint
          ? reusableLocalCheck(started.state.localCheck, images)
          : null) ?? (await checkLocalMedia(images, job.abortSignal));
      job.abortSignal.throwIfAborted();
      if (!continueMediaCatalog(db, job.data, local)) return;
      cloudStarted = true;
    }
    job.abortSignal.throwIfAborted();
    if (!config.apiKey) throw new CatalogFailure("failed");
    const result = await inferMediaCatalog({
      provider: config.provider,
      apiKey: config.apiKey,
      signal: job.abortSignal,
      body: catalogRequest(
        started.state.model,
        started.input,
        images,
        started.tags,
      ),
    });
    const applied = finishMediaCatalog(
      db,
      job.data,
      "success",
      result,
      started.tags,
    );
    if (applied) attachedTagIds = applied.attachedTagIds;
  } catch (error) {
    finishMediaCatalog(
      db,
      job.data,
      !cloudStarted
        ? "local_failed"
        : job.abortSignal.aborted
          ? "timeout"
          : error instanceof CatalogFailure
            ? error.kind
            : "failed",
    );
  } finally {
    // Includes manual/backfill jobs that overlapped an automatic attachment event.
    await reconcileLocalMediaCatalog(db, job.data).catch(() => undefined);
  }
  // Downstream failures must never trigger another paid inference request.
  await Promise.allSettled([
    reindexMediaCatalog(job.data.bookmarkId, job.data.userId),
    ...(attachedTagIds.length
      ? [
          RuleEngine.triggerOnEvent(
            job.data.userId,
            job.data.bookmarkId,
            attachedTagIds.map((tagId) => ({
              type: "tagAdded" as const,
              tagId,
            })),
          ),
        ]
      : []),
  ]);
}

export class MediaCatalogWorker {
  static async build() {
    const runner = (await getQueueClient()).createRunner(
      MediaCatalogQueue,
      {
        run: runMediaCatalog,
        onError: async (job) => {
          if (job.data) finishMediaCatalog(db, job.data, "failed");
        },
      },
      {
        concurrency: 1,
        pollIntervalMs: 1000,
        timeoutSecs: serverConfig.mediaAi.localMode === "off" ? 300 : 600,
      },
    );
    let timer: ReturnType<typeof setInterval> | undefined;
    let recovering = false;
    const recover = async () => {
      if (recovering) return;
      recovering = true;
      try {
        await recoverLocalMediaCatalog(db);
      } catch {
        /* Pending checkpoints remain durable; the next scan retries. */
      } finally {
        recovering = false;
      }
    };
    return {
      async run() {
        await recover();
        timer = setInterval(() => void recover(), 60_000);
        try {
          await runner.run();
        } finally {
          clearInterval(timer);
        }
      },
      stop() {
        clearInterval(timer);
        runner.stop();
      },
    };
  }
}
