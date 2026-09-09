import { eq } from "drizzle-orm";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { getInMemoryDB } from "@karakeep/db/drizzle";
import { assets, users } from "@karakeep/db/schema";
import { saveAssetFromFile } from "@karakeep/shared-server";
import { uploadAsset } from "./upload";

vi.mock("@karakeep/shared-server", async (original) => ({
  ...(await original<typeof import("@karakeep/shared-server")>()),
  saveAssetFromFile: vi.fn(),
}));

it("persists display dimensions when a normal client uploads a photo or video poster", async () => {
  const db = getInMemoryDB(true);
  const user = db
    .insert(users)
    .values({ name: "Uploader", email: "upload@example.com" })
    .returning()
    .get();
  const bytes = await sharp({
    create: { width: 80, height: 120, channels: 3, background: "red" },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  for (const name of ["photo.jpg", "movie.poster.jpg"]) {
    const result = await uploadAsset(user, db, {
      file: new File([new Uint8Array(bytes)], name, { type: "image/jpeg" }),
    });
    expect(result).not.toHaveProperty("error");
    if ("error" in result) throw new Error(result.error);
    expect(
      db.select().from(assets).where(eq(assets.id, result.assetId)).get(),
    ).toMatchObject({ width: 120, height: 80, fileName: name });
  }
  expect(saveAssetFromFile).toHaveBeenCalledTimes(2);
});
