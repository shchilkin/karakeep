import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { DB, KarakeepDBTransaction } from "@karakeep/db";
import { imageSetMembers, imageSets } from "@karakeep/db/schema";

type Connection = DB | KarakeepDBTransaction;
export function imageSetForMember(db: Connection, bookmarkId: string) {
  return db
    .select()
    .from(imageSetMembers)
    .where(eq(imageSetMembers.bookmarkId, bookmarkId))
    .get()?.setId;
}
export function isImageSet(db: Connection, bookmarkId: string) {
  return !!db
    .select()
    .from(imageSets)
    .where(eq(imageSets.bookmarkId, bookmarkId))
    .get();
}
/** Manual sets and members wait for composition-aware AI admission. */
export function isImageSetAnalysisHeld(db: Connection, bookmarkId: string) {
  return isImageSet(db, bookmarkId) || !!imageSetForMember(db, bookmarkId);
}
export function assertImageSetFilesMutable(db: Connection, bookmarkId: string) {
  if (isImageSetAnalysisHeld(db, bookmarkId))
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "Edit the image set or remove this image from its set first. Originals are retained.",
    });
}

export function isImageSetAssetRetained(db: Connection, assetId: string) {
  return !!db
    .select()
    .from(imageSetMembers)
    .where(eq(imageSetMembers.assetId, assetId))
    .get();
}
