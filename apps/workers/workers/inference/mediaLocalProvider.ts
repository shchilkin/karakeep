import { createHash } from "node:crypto";
import serverConfig from "@karakeep/shared/config";
import {
  zLocalFrameResult,
  zCurrentLocalCheckResult,
} from "@karakeep/shared/mediaLocalCheck";
import type { LocalCheckResult } from "@karakeep/shared/mediaLocalCheck";
import { CatalogFailure } from "./mediaCatalogProvider";

/** Only this private service receives the prepared pixels before cloud dispatch. */
export async function checkLocalMedia(
  images: Buffer[],
  signal: AbortSignal,
  request = fetch,
): Promise<LocalCheckResult> {
  const { localUrl, localToken } = serverConfig.mediaAi;
  try {
    if (!localUrl || !localToken || images.length < 1 || images.length > 3)
      throw new Error("configuration");
    const url = new URL(localUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("endpoint");
    const frames: LocalCheckResult["frames"] = [];
    for (const image of images) {
      signal.throwIfAborted();
      if (!image.length || image.length > 2 * 1024 * 1024)
        throw new Error("image_limit");
      const response = await request(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localToken}`,
        },
        body: JSON.stringify({ image: image.toString("base64") }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("local_service");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("empty_body");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 8192) throw new Error("response_limit");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const result = zLocalFrameResult.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      frames.push({
        ...result,
        sha256: createHash("sha256").update(image).digest("hex"),
      });
    }
    return { scope: "outgoing_images_only", frames };
  } catch {
    // Never log pixels, raw model output, headers, tokens or transport bodies.
    throw new CatalogFailure("local_failed");
  }
}

export function reusableLocalCheck(value: unknown, images: Buffer[]) {
  const parsed = zCurrentLocalCheckResult.safeParse(value);
  if (!parsed.success || parsed.data.frames.length !== images.length)
    return null;
  return parsed.data.frames.every(
    (frame, index) =>
      frame.status === "complete" &&
      frame.sha256 === createHash("sha256").update(images[index]).digest("hex"),
  )
    ? parsed.data
    : null;
}
