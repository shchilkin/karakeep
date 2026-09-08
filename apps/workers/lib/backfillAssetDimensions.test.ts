import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { getInMemoryDB } from "@karakeep/db/drizzle";
import { assets, AssetTypes, users } from "@karakeep/db/schema";
import { backfillAssetDimensions } from "./backfillAssetDimensions";

const fixture = vi.hoisted(() => ({
  contents: new Map<string, Buffer>(),
  read: vi.fn(),
}));
vi.mock("@karakeep/shared-server", async (original) => ({
  ...(await original<typeof import("@karakeep/shared-server")>()),
  getAssetSize: async ({ assetId }: { assetId: string }) =>
    assetId === "huge"
      ? 65 * 1024 * 1024
      : fixture.contents.get(assetId)!.length,
  readAsset: async ({
    userId,
    assetId,
    start,
    end,
  }: {
    userId: string;
    assetId: string;
    start: number;
    end: number;
  }) => {
    fixture.read(userId, assetId, start, end);
    return { asset: fixture.contents.get(assetId)! };
  },
}));

it("backfills legacy images in bounded resumable batches without reprocessing known files", async () => {
  const db = getInMemoryDB(true);
  const user = db
    .insert(users)
    .values({ name: "Legacy", email: "legacy@example.com" })
    .returning()
    .get();
  const bytes = await sharp({
    create: { width: 80, height: 120, channels: 3, background: "red" },
  })
    .jpeg()
    .toBuffer();
  for (const id of ["a", "b", "broken", "huge", "known", "video"]) {
    fixture.contents.set(id, id === "broken" ? Buffer.from("bad") : bytes);
    db.insert(assets)
      .values({
        id,
        userId: user.id,
        assetType: AssetTypes.USER_UPLOADED,
        contentType: id === "video" ? "video/mp4" : "image/jpeg",
        width: id === "known" ? 5 : null,
        height: id === "known" ? 7 : null,
      })
      .run();
  }
  const dryRun = await backfillAssetDimensions(db, { limit: 1 });
  expect(dryRun).toMatchObject({
    mode: "dry-run",
    measured: 1,
    updated: 0,
    nextCursor: "a",
  });
  expect(
    db
      .select()
      .from(assets)
      .all()
      .find((a) => a.id === "a")!.width,
  ).toBeNull();
  expect(
    await backfillAssetDimensions(db, { limit: 1, apply: true }),
  ).toMatchObject({ updated: 1, nextCursor: "a" });
  expect(
    await backfillAssetDimensions(db, { after: "a", apply: true }),
  ).toMatchObject({ updated: 1, skipped: 2, nextCursor: null });
  expect(await backfillAssetDimensions(db, { apply: true })).toMatchObject({
    updated: 0,
    measured: 0,
    skipped: 2,
  });
  expect(
    db
      .select()
      .from(assets)
      .all()
      .find((a) => a.id === "known"),
  ).toMatchObject({ width: 5, height: 7 });
  expect(
    fixture.read.mock.calls.every(
      ([owner, id]) =>
        owner === user.id && !["known", "huge", "video"].includes(id),
    ),
  ).toBe(true);
  expect(fixture.contents.get("a")).toEqual(bytes);
  await expect(backfillAssetDimensions(db, { limit: 0 })).rejects.toThrow(
    "Limit",
  );
});
