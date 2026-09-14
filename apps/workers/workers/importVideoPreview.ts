import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";

/** CPU-only, bounded first-frame extraction. No asset writes or AI admission. */
export async function importVideoFrame(bytes: Buffer) {
  const folder = await mkdtemp(path.join(tmpdir(), "karakeep-import-video-"));
  try {
    const source = path.join(folder, "source");
    const output = path.join(folder, "frame.png");
    await writeFile(source, bytes, { mode: 0o600 });
    const probe = await execa(
      "ffprobe",
      [
        "-v",
        "error",
        "-max_alloc",
        "67108864",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "mov,matroska,webm",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height:stream_side_data=rotation",
        "-of",
        "json",
        source,
      ],
      { timeout: 10_000, maxBuffer: 65536 },
    );
    const stream = JSON.parse(probe.stdout).streams?.[0];
    let width: number = stream?.width;
    let height: number = stream?.height;
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width * height > 40_000_000
    )
      throw new Error("Video dimensions exceed preview limits");
    const rotation = Number(
      stream.side_data_list?.find(
        (data: { rotation?: number }) => data.rotation !== undefined,
      )?.rotation ?? 0,
    );
    if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
    await execa(
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
        "-frames:v",
        "1",
        "-an",
        "-sn",
        "-dn",
        "-filter_threads",
        "1",
        "-vf",
        "scale=w='min(1280,iw*sar*min(1,1280/ih))':h='min(1280,ih*min(1,1280/(iw*sar)))',setsar=1",
        "-threads",
        "1",
        "-fs",
        "8388608",
        output,
      ],
      { timeout: 20_000, maxBuffer: 65536 },
    );
    return { bytes: await readFile(output), dimensions: { width, height } };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
