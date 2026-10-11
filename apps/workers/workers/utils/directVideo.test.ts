import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Response } from "node-fetch";
import { execa } from "execa";
import { beforeAll, afterAll, beforeEach, expect, test, vi } from "vitest";
import { db } from "@karakeep/db";
import {
  assets,
  AssetTypes,
  bookmarkLinks,
  bookmarks,
  users,
} from "@karakeep/db/schema";
import {
  createAssetReadStream,
  saveAsset,
  saveAssetFromFile,
  silentDeleteAsset,
} from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import { requestMediaCatalog } from "@karakeep/trpc/models/mediaCatalog";
import { fetchWithProxy } from "network";
import { downloadDirectVideo } from "./directVideo";

vi.mock("@karakeep/db", async () => {
  const { getInMemoryDB } = await import("@karakeep/db/drizzle");
  return { db: getInMemoryDB(true) };
});
vi.mock("network", async (original) => ({
  ...(await original<typeof import("network")>()),
  fetchWithProxy: vi.fn(),
}));
vi.mock("@karakeep/shared-server", async (original) => ({
  ...(await original<typeof import("@karakeep/shared-server")>()),
  createAssetReadStream: vi.fn(),
  saveAsset: vi.fn(),
  saveAssetFromFile: vi.fn(),
  silentDeleteAsset: vi.fn(),
}));
vi.mock("@karakeep/trpc/models/mediaCatalog", () => ({
  requestMediaCatalog: vi.fn().mockResolvedValue(null),
}));

const url = "https://example.com/video.mp4";
const args = {
  url,
  userId: "owner",
  bookmarkId: "post",
  jobId: "test",
  abortSignal: new AbortController().signal,
  runProxy: { httpProxy: undefined, httpsProxy: undefined, noProxy: undefined },
};
const stored = new Map<string, Buffer>();
let directory: string;
let video: Buffer;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "direct-video-test-"));
  const file = path.join(directory, "fixture.mp4");
  await execa("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=96x64:d=1:r=2",
    "-threads",
    "1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  video = await readFile(file);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  stored.clear();
  db.delete(assets).run();
  db.delete(bookmarkLinks).run();
  db.delete(bookmarks).run();
  db.delete(users).run();
  db.insert(users)
    .values({ id: "owner", name: "Owner", email: "owner@example.test" })
    .run();
  db.insert(bookmarks)
    .values({ id: "post", userId: "owner", type: BookmarkTypes.LINK })
    .run();
  db.insert(bookmarkLinks).values({ id: "post", url }).run();
  Object.assign(serverConfig, { maxAssetSizeMb: 50 });
  vi.mocked(fetchWithProxy).mockImplementation(
    async () =>
      new Response(video, { headers: { "content-type": "video/mp4" } }),
  );
  vi.mocked(saveAssetFromFile).mockImplementation(
    async ({ assetId, assetPath }) => {
      stored.set(assetId, await readFile(assetPath));
    },
  );
  vi.mocked(saveAsset).mockImplementation(async ({ assetId, asset }) => {
    stored.set(assetId, asset);
  });
  vi.mocked(createAssetReadStream).mockImplementation(async ({ assetId }) =>
    Readable.from(stored.get(assetId)!),
  );
  vi.mocked(silentDeleteAsset).mockImplementation(async (_, id) => {
    if (id) stored.delete(id);
  });
});

test("downloads the original bytes, generates a real first-frame JPEG, and reuses them on retry", async () => {
  await downloadDirectVideo(args);
  const attached = db.select().from(assets).all();
  expect(attached).toHaveLength(2);
  const original = attached.find((a) => a.assetType === AssetTypes.LINK_VIDEO)!;
  const poster = attached.find(
    (a) => a.assetType === AssetTypes.LINK_BANNER_IMAGE,
  )!;
  expect(poster).toMatchObject({ width: 1280, height: 853 });
  expect(stored.get(original.id)).toEqual(video);
  expect(poster.fileName).toBe(
    original.fileName!.replace(/\.mp4$/, ".poster.jpg"),
  );
  expect(stored.get(poster.id)!.subarray(0, 2).toString("hex")).toBe("ffd8");
  expect(attached.some((a) => a.assetType === AssetTypes.LINK_SCREENSHOT)).toBe(
    false,
  );
  expect(requestMediaCatalog).toHaveBeenCalledWith(db, "owner", "post", {
    automatic: true,
  });
  await downloadDirectVideo(args);
  expect(fetchWithProxy).toHaveBeenCalledOnce();
  expect(db.select().from(assets).all()).toEqual(attached);
});

test("rejects an HTML/login response in place of the probed video", async () => {
  vi.mocked(fetchWithProxy).mockResolvedValue(
    new Response("<html>Login</html>", {
      headers: { "content-type": "text/html" },
    }),
  );
  await expect(downloadDirectVideo(args)).rejects.toThrow(
    "Failed to download required video",
  );
  expect(stored.size).toBe(0);
  expect(db.select().from(assets).all()).toEqual([]);
  expect(requestMediaCatalog).not.toHaveBeenCalled();
});

test("a corrupt video fails and leaves no orphan original or poster", async () => {
  vi.mocked(fetchWithProxy).mockResolvedValue(
    new Response("broken video", { headers: { "content-type": "video/mp4" } }),
  );
  await expect(downloadDirectVideo(args)).rejects.toThrow();
  expect(stored.size).toBe(0);
  expect(db.select().from(assets).all()).toEqual([]);
  expect(requestMediaCatalog).not.toHaveBeenCalled();
});

test("enforces the streaming download limit", async () => {
  Object.assign(serverConfig, { maxAssetSizeMb: 0.0001 });
  await expect(downloadDirectVideo(args)).rejects.toThrow(
    "Failed to download required video",
  );
  expect(stored.size).toBe(0);
  expect(db.select().from(assets).all()).toEqual([]);
});

test("storage quota failure keeps the bookmark without partial attachments", async () => {
  db.update(users).set({ storageQuota: 100 }).run();
  await expect(downloadDirectVideo(args)).rejects.toThrow(
    "Failed to download required video",
  );
  expect(stored.size).toBe(0);
  expect(db.select().from(assets).all()).toEqual([]);
  expect(requestMediaCatalog).not.toHaveBeenCalled();
});

test.each([
  ["webm", "video/webm", "libvpx-vp9"],
  ["mkv", "video/x-matroska", "libx264"],
])(
  "saves a real %s original and generates its poster",
  async (extension, contentType, codec) => {
    const file = path.join(directory, `fixture.${extension}`);
    await execa("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=96x64:d=1:r=2",
      "-threads",
      "1",
      "-c:v",
      codec,
      "-pix_fmt",
      "yuv420p",
      file,
    ]);
    const bytes = await readFile(file);
    vi.mocked(fetchWithProxy).mockResolvedValue(
      new Response(bytes, { headers: { "content-type": contentType } }),
    );
    await downloadDirectVideo(args);
    const attached = db.select().from(assets).all();
    const original = attached.find(
      (a) => a.assetType === AssetTypes.LINK_VIDEO,
    )!;
    expect(original.contentType).toBe(contentType);
    expect(original.fileName).toMatch(new RegExp(`\\.${extension}$`));
    expect(stored.get(original.id)).toEqual(bytes);
    expect(
      attached.find((a) => a.assetType === AssetTypes.LINK_BANNER_IMAGE)?.size,
    ).toBeGreaterThan(0);
  },
);

test("does not attach media after the bookmark URL changes during download", async () => {
  vi.mocked(fetchWithProxy).mockImplementation(async () => {
    db.update(bookmarkLinks)
      .set({ url: "https://example.com/another.mp4" })
      .run();
    return new Response(video, { headers: { "content-type": "video/mp4" } });
  });
  await expect(downloadDirectVideo(args)).rejects.toThrow("Bookmark changed");
  expect(stored.size).toBe(0);
  expect(db.select().from(assets).all()).toEqual([]);
});
