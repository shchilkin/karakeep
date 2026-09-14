import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { expect, test } from "vitest";
import { importVideoFrame } from "./importVideoPreview";

test.each([
  [1920, 1080, "1/1", 1280, 720],
  [160, 96, "2/1", 320, 96],
])(
  "poster preserves display aspect and original dimensions (%i x %i SAR %s)",
  async (width, height, sar, posterWidth, posterHeight) => {
    const folder = await mkdtemp(path.join(tmpdir(), "import-video-fixture-"));
    try {
      const file = path.join(folder, "source.mp4");
      execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          `testsrc2=size=${width}x${height}:rate=1:duration=1`,
          "-vf",
          `setsar=${sar}`,
          "-c:v",
          "libx264",
          "-threads",
          "1",
          "-preset",
          "ultrafast",
          file,
        ],
        { timeout: 15000 },
      );
      const original = await readFile(file);
      const result = await importVideoFrame(original);
      expect(result.dimensions).toEqual({ width, height });
      expect(await sharp(result.bytes).metadata()).toMatchObject({
        width: posterWidth,
        height: posterHeight,
      });
      expect(await readFile(file)).toEqual(original);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
  30000,
);
