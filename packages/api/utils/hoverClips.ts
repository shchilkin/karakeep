import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { Context } from "hono";
import {
  createAssetReadStream,
  getAssetSize,
  readAssetMetadata,
} from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import { MediaPreviewCache, PreviewBusyError } from "./mediaPreviewCache";

const execute = promisify(execFile);
const maxInputBytes = 512 * 1024 * 1024;
const maxOutputBytes = 2 * 1024 * 1024;
const failedUntil = new Map<string, number>();
const cache = new MediaPreviewCache(
  path.join(serverConfig.dataDir, "cache", "hover-clips-v1"),
  512 * 1024 * 1024,
  2, // One active conversion and at most one waiting; cache hits stay immediate.
  7 * 24 * 60 * 60 * 1000,
  "mp4",
);

async function encodeClip(assetId: string, userId: string) {
  const folder = await mkdtemp(path.join(tmpdir(), "karakeep-hover-"));
  const signal = AbortSignal.timeout(30_000);
  try {
    const source = path.join(folder, "source");
    const output = path.join(folder, "preview.mp4");
    let bytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(
          bytes > maxInputBytes
            ? new Error("Preview input exceeds limit")
            : null,
          chunk,
        );
      },
    });
    // A seekable private copy also supports MP4 files whose index is at the end.
    await pipeline(
      await createAssetReadStream({ assetId, userId }),
      limit,
      createWriteStream(source, { mode: 0o600 }),
      { signal },
    );
    await execute(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-threads",
        "1",
        "-max_alloc",
        "67108864",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "mov,matroska,webm",
        "-i",
        source,
        "-map",
        "0:v:0",
        "-t",
        "6",
        "-an",
        "-sn",
        "-dn",
        "-vf",
        "fps=15,scale=w='min(480,iw)':h='min(480,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
        "-filter_threads",
        "1",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-preset",
        "veryfast",
        "-crf",
        "28",
        "-maxrate",
        "600k",
        "-bufsize",
        "1200k",
        "-pix_fmt",
        "yuv420p",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-movflags",
        "+faststart",
        "-fs",
        String(maxOutputBytes),
        output,
      ],
      { signal, killSignal: "SIGKILL", timeout: 30_000, maxBuffer: 65536 },
    );
    const info = await stat(output);
    if (!info.size || info.size > maxOutputBytes)
      throw new Error("Invalid preview output size");
    return await readFile(output);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

export function clipRange(
  range: string,
  size: number,
): [number, number] | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  const end =
    match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start <= end &&
    start < size
    ? [start, end]
    : null;
}

/** Asset authorization and API key read scope must precede cache access. */
export async function serveHoverClip(
  c: Context,
  assetId: string,
  userId: string,
) {
  const [metadata, size] = await Promise.all([
    readAssetMetadata({ assetId, userId }),
    getAssetSize({ assetId, userId }),
  ]);
  if (
    !["video/mp4", "video/webm", "video/x-matroska"].includes(
      metadata.contentType,
    )
  )
    return c.json({ error: "No hover clip for this file type" }, 415);
  if (size > maxInputBytes)
    return c.json({ error: "Video exceeds preview input limit" }, 413);
  const identity = JSON.stringify([userId, assetId]);
  if ((failedUntil.get(identity) ?? 0) > Date.now())
    return c.json({ error: "Hover preview could not be generated" }, 422);
  try {
    const bytes = await cache.get(identity, () => encodeClip(assetId, userId));
    c.header("Content-Type", "video/mp4");
    c.header("Cache-Control", "private, max-age=31536000, immutable");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Accept-Ranges", "bytes");
    const requested = c.req.header("Range");
    if (requested) {
      const range = clipRange(requested, bytes.length);
      if (!range) {
        c.header("Content-Range", `bytes */${bytes.length}`);
        return c.body(null, 416);
      }
      const [start, end] = range;
      c.header("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
      c.header("Content-Length", String(end - start + 1));
      return c.body(new Uint8Array(bytes.subarray(start, end + 1)), 206);
    }
    c.header("Content-Length", String(bytes.length));
    return c.body(new Uint8Array(bytes));
  } catch (error) {
    if (error instanceof PreviewBusyError) {
      c.header("Retry-After", "2");
      return c.json({ error: "Preview generation is busy" }, 503);
    }
    if (failedUntil.size >= 128)
      failedUntil.delete(failedUntil.keys().next().value!);
    failedUntil.set(identity, Date.now() + 60_000);
    return c.json({ error: "Hover preview could not be generated" }, 422);
  }
}
