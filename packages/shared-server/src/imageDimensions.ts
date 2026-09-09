import { stat } from "node:fs/promises";
import sharp from "sharp";

export const MAX_DIMENSION_INPUT_BYTES = 64 * 1024 * 1024;
export const DIMENSION_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
] as const;

/** Display dimensions of the first frame, matching auto-oriented thumbnails. */
export async function extractImageDimensions(
  input: Buffer | string,
  contentType: string | null,
): Promise<{ width: number; height: number } | null> {
  if (!DIMENSION_IMAGE_TYPES.some((type) => type === contentType)) return null;
  try {
    const size =
      typeof input === "string" ? (await stat(input)).size : input.length;
    if (size > MAX_DIMENSION_INPUT_BYTES) return null;
    const meta = await sharp(input, {
      animated: false,
      limitInputPixels: 40_000_000,
      sequentialRead: true,
    }).metadata();
    const width = meta.width;
    const height = meta.pageHeight ?? meta.height;
    if (!width || !height || width * height > 40_000_000) return null;
    return meta.orientation && meta.orientation >= 5
      ? { width: height, height: width }
      : { width, height };
  } catch {
    // A missing/unsupported header must not turn a successful archive into a failure.
    return null;
  }
}
