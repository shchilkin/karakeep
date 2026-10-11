import { Readable } from "node:stream";
import { Response } from "node-fetch";
import sharp from "sharp";
import { beforeEach, expect, test, vi } from "vitest";
import { fetchWithProxy } from "network";
import { db } from "@karakeep/db";
import {
  assets,
  bookmarkAssets,
  bookmarkLinks,
  bookmarks,
  users,
} from "@karakeep/db/schema";
import {
  AssetPreprocessingQueue,
  triggerSearchReindex,
} from "@karakeep/shared-server";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import serverConfig from "@karakeep/shared/config";
import { requestMediaCatalog } from "@karakeep/trpc/models/mediaCatalog";
import { WebhooksService } from "@karakeep/trpc/models/webhooks.service";
import { downloadDirectVideo } from "./utils/directVideo";
import { runParseSubprocess } from "./utils/parseSubprocess";
import { runCrawler } from "./crawlerWorker";

vi.mock("@karakeep/db", async () => {
  const { getInMemoryDB } = await import("@karakeep/db/drizzle");
  return { db: getInMemoryDB(true) };
});
vi.mock("network", async (original) => ({
  ...(await original<typeof import("network")>()),
  fetchWithProxy: vi.fn(),
}));
vi.mock("./utils/directVideo", () => ({ downloadDirectVideo: vi.fn() }));
vi.mock("./utils/parseSubprocess", () => ({ runParseSubprocess: vi.fn() }));
vi.mock("@karakeep/trpc/models/mediaCatalog", () => ({
  requestMediaCatalog: vi.fn().mockResolvedValue(null),
}));
vi.mock("@karakeep/shared-server", async (original) => ({
  ...(await original<typeof import("@karakeep/shared-server")>()),
  triggerSearchReindex: vi.fn(),
  saveAssetFromFile: vi.fn(),
  saveAsset: vi.fn(),
  silentDeleteAsset: vi.fn(),
  AssetPreprocessingQueue: { enqueue: vi.fn() },
}));

const url = "https://example.com/media";
const job = {
  id: "test",
  priority: 0,
  runNumber: 1,
  abortSignal: new AbortController().signal,
  data: { bookmarkId: "post", archiveFullPage: false, runInference: false },
};
function mediaResponse(body: Buffer | string, contentType: string) {
  const response = new Response(body, {
    headers: { "content-type": contentType },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
function respond(contentType: string, body: Buffer | string = "media bytes") {
  vi.mocked(fetchWithProxy).mockImplementation(async () =>
    mediaResponse(body, contentType),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  db.delete(assets).run();
  db.delete(bookmarkAssets).run();
  db.delete(bookmarkLinks).run();
  db.delete(bookmarks).run();
  db.delete(users).run();
  db.insert(users)
    .values({
      id: "owner",
      name: "Owner",
      email: "owner@example.test",
      browserCrawlingEnabled: false,
    })
    .run();
  db.insert(bookmarks)
    .values({ id: "post", userId: "owner", type: BookmarkTypes.LINK })
    .run();
  db.insert(bookmarkLinks).values({ id: "post", url }).run();
  Object.assign(serverConfig.crawler, {
    downloadVideo: false,
    domainRatelimiting: undefined,
    fullPageArchive: false,
    downloadBannerImage: true,
  });
  Object.assign(serverConfig.mediaAi, {
    localAutoNew: false,
    hybridEnabled: false,
    autoNew: false,
  });
  vi.spyOn(WebhooksService.prototype, "triggerWebhook").mockResolvedValue();
  vi.mocked(runParseSubprocess).mockResolvedValue({
    metadata: { title: "Page title" },
    readableContent: null,
    readerViewAssessment: null,
  });
});

test.each(["video/mp4", "video/webm", "video/x-matroska"])(
  "downloads %s without page rendering even when optional page-video extraction is off",
  async (contentType) => {
    respond(contentType);
    await runCrawler(job, 3);
    expect(downloadDirectVideo).toHaveBeenCalledOnce();
    expect(runParseSubprocess).not.toHaveBeenCalled();
    expect(fetchWithProxy).toHaveBeenCalledOnce();
    expect(triggerSearchReindex).toHaveBeenCalledOnce();
  },
);

test("a direct video download failure has no screenshot or webpage fallback", async () => {
  respond("video/mp4");
  vi.mocked(downloadDirectVideo).mockRejectedValueOnce(
    new Error("download failed"),
  );
  await expect(runCrawler(job, 3)).rejects.toThrow("download failed");
  expect(runParseSubprocess).not.toHaveBeenCalled();
  expect(triggerSearchReindex).not.toHaveBeenCalled();
});

test.each(["image/jpeg", "application/pdf"])(
  "retains direct %s downloads and image dimensions",
  async (contentType) => {
    const image = contentType === "image/jpeg";
    const bytes = image
      ? await sharp({
          create: { width: 96, height: 64, channels: 3, background: "red" },
        })
          .jpeg()
          .toBuffer()
      : Buffer.from("%PDF fixture");
    respond(contentType, bytes);
    await runCrawler(job, 3);
    expect(db.select().from(bookmarks).get()?.type).toBe("asset");
    expect(db.select().from(assets).get()).toMatchObject({
      contentType,
      size: bytes.length,
      ...(image ? { width: 96, height: 64 } : {}),
    });
    expect(AssetPreprocessingQueue.enqueue).toHaveBeenCalledOnce();
    expect(runParseSubprocess).not.toHaveBeenCalled();
    if (image)
      expect(requestMediaCatalog).toHaveBeenCalledWith(db, "owner", "post", {
        automatic: true,
      });
    else expect(requestMediaCatalog).not.toHaveBeenCalled();
  },
);

test.each(["image/jpeg", "application/pdf"])(
  "rejects an HTML login page returned instead of the probed %s",
  async (contentType) => {
    const body = Readable.from("<html>Login</html>");
    vi.mocked(fetchWithProxy)
      .mockResolvedValueOnce(
        new Response("probe", { headers: { "content-type": contentType } }),
      )
      .mockResolvedValueOnce(
        new Response(body, { headers: { "content-type": "text/html" } }),
      );
    await expect(runCrawler(job, 3)).rejects.toThrow(
      "Failed to download required",
    );
    expect(db.select().from(assets).all()).toEqual([]);
    expect(db.select().from(bookmarks).get()?.type).toBe("link");
    expect(body.destroyed).toBe(true);
  },
);

test("HTML stays a webpage and keeps parsed metadata", async () => {
  respond("text/html", "<html>Article</html>");
  await runCrawler(job, 3);
  expect(runParseSubprocess).toHaveBeenCalled();
  expect(downloadDirectVideo).not.toHaveBeenCalled();
  expect(db.select().from(bookmarkLinks).get()?.title).toBe("Page title");
  expect(triggerSearchReindex).toHaveBeenCalledOnce();
});

test.each([true, false])(
  "preserves automatic media catalog routing (localOnly=%s)",
  async (localOnly) => {
    Object.assign(serverConfig.mediaAi, {
      localAutoNew: localOnly,
      hybridEnabled: !localOnly,
      autoNew: !localOnly,
    });
    respond("text/html", "<html>Article</html>");
    await runCrawler(job, 3);
    expect(requestMediaCatalog).toHaveBeenCalledWith(db, "owner", "post", {
      automatic: true,
      localOnly,
    });
  },
);

test("stores dimensions for an upstream-optimized banner", async () => {
  const image = await sharp({
    create: { width: 96, height: 64, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  vi.mocked(runParseSubprocess).mockResolvedValue({
    metadata: { title: "Page", image: "https://example.com/banner.png" },
    readableContent: null,
    readerViewAssessment: null,
  });
  vi.mocked(fetchWithProxy).mockImplementation(async (input) =>
    String(input).endsWith("banner.png")
      ? new Response(image, { headers: { "content-type": "image/png" } })
      : mediaResponse("<html>Article</html>", "text/html"),
  );
  await runCrawler(job, 3);
  expect(db.select().from(assets).get()).toMatchObject({
    assetType: "linkBannerImage",
    width: 96,
    height: 64,
  });
});
