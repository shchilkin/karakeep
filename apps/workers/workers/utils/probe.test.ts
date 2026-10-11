import { Readable } from "node:stream";
import { Response } from "node-fetch";
import { expect, test, vi } from "vitest";
import { fetchWithProxy } from "network";
import { getContentTypeAndMetadata, crawlLogger } from "../crawlerWorker";

vi.mock("network", async (original) => ({
  ...(await original<typeof import("network")>()),
  fetchWithProxy: vi.fn(),
}));

test.each(["video/mp4", "video/webm", "image/jpeg", "application/pdf"])(
  "closes the %s probe stream after reading its headers",
  async (contentType) => {
    const body = Readable.from(Buffer.from("media bytes"));
    vi.mocked(fetchWithProxy).mockResolvedValue(
      new Response(body, { headers: { "content-type": contentType } }),
    );
    const result = await getContentTypeAndMetadata({
      url: "https://example.com/media",
      jobId: "test",
      bookmarkId: "post",
      userId: "owner",
      abortSignal: new AbortController().signal,
      runProxy: {
        httpProxy: undefined,
        httpsProxy: undefined,
        noProxy: undefined,
      },
      browserCrawlingEnabled: false,
      log: crawlLogger("test"),
    });
    expect(result.contentType).toBe(contentType);
    expect(await result.metadata).toBeNull();
    expect(body.destroyed).toBe(true);
  },
);
