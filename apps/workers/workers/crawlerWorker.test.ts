import { beforeEach, expect, test, vi } from "vitest";
import { getBookmarkDetails } from "workerUtils";
import { triggerSearchReindex } from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import { WebhooksService } from "@karakeep/trpc/models/webhooks.service";
import { getContentTypeAndMetadata } from "./crawler/probe";
import {
  crawlAndParseUrl,
  handleAsAssetBookmark,
} from "./crawler/crawlAndParse";
import { downloadDirectVideo } from "./crawler/directVideo";
import { runCrawler } from "./crawlerWorker";

vi.mock("workerUtils", () => ({ getBookmarkDetails: vi.fn() }));
vi.mock("./crawler/probe", () => ({ getContentTypeAndMetadata: vi.fn() }));
vi.mock("./crawler/crawlAndParse", () => ({
  crawlAndParseUrl: vi.fn(),
  handleAsAssetBookmark: vi.fn(),
}));
vi.mock("./crawler/directVideo", () => ({ downloadDirectVideo: vi.fn() }));
vi.mock("@karakeep/shared-server", async (original) => ({
  ...(await original<typeof import("@karakeep/shared-server")>()),
  triggerSearchReindex: vi.fn(),
}));

const job = {
  id: "test",
  priority: 0,
  runNumber: 1,
  abortSignal: new AbortController().signal,
  data: { bookmarkId: "post", archiveFullPage: false, runInference: false },
};
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(serverConfig.crawler, {
    downloadVideo: false,
    domainRatelimiting: undefined,
  });
  vi.spyOn(WebhooksService.prototype, "triggerWebhook").mockResolvedValue();
  vi.mocked(getBookmarkDetails).mockResolvedValue({
    url: "https://example.com/media",
    userId: "owner",
    createdAt: new Date(),
    crawledAt: null,
    probeMetadataAt: null,
    screenshotAssetId: undefined,
    imageAssetId: undefined,
    videoAssetId: undefined,
    pdfAssetId: undefined,
    fullPageArchiveAssetId: undefined,
    precrawledArchiveAssetId: undefined,
    contentAssetId: undefined,
  });
  vi.mocked(crawlAndParseUrl).mockResolvedValue(async () => undefined);
});

test.each(["video/mp4", "video/webm", "video/x-matroska"])(
  "downloads %s without running the browser, even with optional page-video extraction off",
  async (contentType) => {
    vi.mocked(getContentTypeAndMetadata).mockResolvedValue({
      contentType,
      metadata: Promise.resolve(null),
    });
    await runCrawler(job, 3);
    expect(downloadDirectVideo).toHaveBeenCalledOnce();
    expect(crawlAndParseUrl).not.toHaveBeenCalled();
    expect(triggerSearchReindex).toHaveBeenCalledOnce();
  },
);

test("a direct video download error fails the crawl without screenshot fallback", async () => {
  vi.mocked(getContentTypeAndMetadata).mockResolvedValue({
    contentType: "video/mp4",
    metadata: Promise.resolve(null),
  });
  vi.mocked(downloadDirectVideo).mockRejectedValueOnce(
    new Error("download failed"),
  );
  await expect(runCrawler(job, 3)).rejects.toThrow("download failed");
  expect(crawlAndParseUrl).not.toHaveBeenCalled();
  expect(triggerSearchReindex).not.toHaveBeenCalled();
});

test.each(["image/jpeg", "application/pdf"])(
  "retains direct %s downloads",
  async (contentType) => {
    vi.mocked(getContentTypeAndMetadata).mockResolvedValue({
      contentType,
      metadata: Promise.resolve(null),
    });
    await runCrawler(job, 3);
    expect(handleAsAssetBookmark).toHaveBeenCalledOnce();
    expect(crawlAndParseUrl).not.toHaveBeenCalled();
  },
);

test("HTML remains a webpage", async () => {
  vi.mocked(getContentTypeAndMetadata).mockResolvedValue({
    contentType: "text/html",
    metadata: Promise.resolve(null),
  });
  await runCrawler(job, 3);
  expect(crawlAndParseUrl).toHaveBeenCalledOnce();
  expect(downloadDirectVideo).not.toHaveBeenCalled();
});
