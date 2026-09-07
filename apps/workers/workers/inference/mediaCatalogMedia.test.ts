import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execa } from "execa";
import { expect, test, vi } from "vitest";
import { getAssetSize, readAsset } from "@karakeep/shared-server";
import { prepareCatalogImages } from "./mediaCatalogWorker";

vi.mock("@karakeep/shared-server", async (original) => ({
  ...(await original<typeof import("@karakeep/shared-server")>()),
  getAssetSize: vi.fn(),
  readAsset: vi.fn(),
}));

const input = {
  assets: [{ id: "video", fileName: "001.mp4" }],
  media: { kind: "video", coverage: "archived_media", asset_count: 1 },
  source: { title: "", caption: "", author: "" },
};

test("video samples start, middle and end as three distinct bounded JPEGs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "catalog-test-"));
  try {
    const file = path.join(directory, "video.mp4");
    await execa("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=64x64:d=2:r=2",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=64x64:d=2:r=2",
      "-f",
      "lavfi",
      "-i",
      "color=c=green:s=64x64:d=2:r=2",
      "-filter_complex",
      "[0:v][1:v][2:v]concat=n=3:v=1:a=0",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      file,
    ]);
    const bytes = await readFile(file);
    vi.mocked(getAssetSize).mockResolvedValue(bytes.length);
    vi.mocked(readAsset).mockResolvedValue({
      asset: bytes,
      metadata: { contentType: "video/mp4" },
    });
    const frames = await prepareCatalogImages(
      "owner",
      input,
      new AbortController().signal,
    );
    expect(frames).toHaveLength(3);
    expect(
      new Set(frames.map((f) => createHash("sha256").update(f).digest("hex")))
        .size,
    ).toBe(3);
    for (const f of frames) {
      expect(f.subarray(0, 2).toString("hex")).toBe("ffd8");
      expect(f.length).toBeLessThan(2 * 1024 * 1024);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("oversized originals are rejected before reading the media body", async () => {
  vi.mocked(getAssetSize).mockResolvedValue(51 * 1024 * 1024);
  vi.mocked(readAsset).mockClear();
  await expect(
    prepareCatalogImages("owner", input, new AbortController().signal),
  ).rejects.toThrow("failed");
  expect(readAsset).not.toHaveBeenCalled();
});
