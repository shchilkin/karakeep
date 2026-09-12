import serverConfig from "@karakeep/shared/config";
import type { CatalogInput } from "@karakeep/shared/mediaCatalog";
import { zLocalCatalogResponse } from "@karakeep/shared/mediaLocalCatalog";
import { CatalogFailure } from "./mediaCatalogProvider";

/** Private service only. No retries and no fallback provider. */
export async function inferLocalCatalog(
  input: CatalogInput,
  images: Buffer[],
  signal: AbortSignal,
  request = fetch,
) {
  try {
    const config = serverConfig.mediaAi;
    if (
      !config.hybridEnabled ||
      !config.localCatalogUrl ||
      !config.localCatalogToken
    )
      throw new Error();
    const url = new URL(config.localCatalogUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    if (
      images.length > 3 ||
      images.some((i) => !i.length || i.length > 2 * 1024 * 1024) ||
      (!images.length && input.media.kind !== "text")
    )
      throw new Error();
    const response = await request(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(480_000)]),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.localCatalogToken}`,
      },
      // No bookmark IDs, URLs, notes, keys or filesystem paths are transmitted.
      body: JSON.stringify({
        media: { ...input.media, sampled_images: images.length },
        source: input.source,
        images: images.map((i) => i.toString("base64")),
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 32 * 1024) throw new Error();
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return zLocalCatalogResponse.parse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    ).result;
  } catch {
    // Never propagate local responses or source content to worker logs.
    throw new CatalogFailure("local_failed");
  }
}
