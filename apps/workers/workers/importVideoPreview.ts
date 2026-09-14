import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";

/** CPU-only, bounded first-frame extraction. No asset writes or AI admission. */
export async function importVideoFrame(bytes: Buffer): Promise<Buffer> {
  const folder = await mkdtemp(path.join(tmpdir(), "karakeep-import-video-"));
  try {
    const source = path.join(folder, "source");
    const output = path.join(folder, "frame.png");
    await writeFile(source, bytes, { mode: 0o600 });
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
        "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease,setsar=1",
        "-threads",
        "1",
        "-fs",
        "8388608",
        output,
      ],
      { timeout: 20_000, maxBuffer: 65536 },
    );
    return await readFile(output);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
