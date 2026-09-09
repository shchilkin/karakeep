import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";
import { extractImageDimensions } from "./imageDimensions";

it("measures stored images and matches thumbnail orientation for all EXIF transforms", async () => {
  for (let orientation = 1; orientation <= 8; orientation++) {
    const bytes = await sharp({
      create: { width: 80, height: 120, channels: 3, background: "red" },
    })
      .jpeg()
      .withMetadata({ orientation })
      .toBuffer();
    const { info } = await sharp(bytes)
      .rotate()
      .toBuffer({ resolveWithObject: true });
    expect(await extractImageDimensions(bytes, "image/jpeg")).toEqual({
      width: info.width,
      height: info.height,
    });
  }
});

it("reads file uploads and the first frame of animations without changing their bytes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "image-dimensions-"));
  try {
    const bytes = await sharp({
      create: { width: 40, height: 120, channels: 3, background: "blue" },
    })
      .gif()
      .toBuffer();
    const file = path.join(directory, "image.gif");
    await writeFile(file, bytes);
    expect(await extractImageDimensions(file, "image/gif")).toEqual({
      width: 40,
      height: 120,
    });
    // Two 40x60 test-pattern frames.
    const frames = Buffer.from(
      "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",
      "base64",
    );
    expect((await sharp(frames).metadata()).pages).toBe(2);
    expect(await extractImageDimensions(frames, "image/gif")).toEqual({
      width: 40,
      height: 60,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("leaves unsupported, malformed and oversized media without guessed dimensions", async () => {
  expect(
    await extractImageDimensions(Buffer.from("bad"), "image/jpeg"),
  ).toBeNull();
  expect(
    await extractImageDimensions("/missing/video.mp4", "video/mp4"),
  ).toBeNull();
  expect(
    await extractImageDimensions(
      Buffer.alloc(64 * 1024 * 1024 + 1),
      "image/png",
    ),
  ).toBeNull();
});
