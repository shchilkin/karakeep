import { Readable } from "node:stream";
import { Response } from "node-fetch";
import { expect, test, vi } from "vitest";
import { fetchWithProxy } from "network";
import { getContentTypeAndMetadata } from "./probe";

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
    const result = await getContentTypeAndMetadata(
      "https://example.com/media",
      "test",
      new AbortController().signal,
      { httpProxy: undefined, httpsProxy: undefined, noProxy: undefined },
    );
    expect(result.contentType).toBe(contentType);
    expect(await result.metadata).toBeNull();
    expect(body.destroyed).toBe(true);
  },
);
