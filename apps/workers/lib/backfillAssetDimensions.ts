import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { DB } from "@karakeep/db";
import { assets } from "@karakeep/db/schema";
import {
  DIMENSION_IMAGE_TYPES,
  MAX_DIMENSION_INPUT_BYTES,
  extractImageDimensions,
  getAssetSize,
  readAsset,
} from "@karakeep/shared-server";

/** One bounded batch; existing dimensions and original files are never replaced. */
export async function backfillAssetDimensions(
  db: DB,
  {
    apply = false,
    limit = 200,
    after = "",
  }: {
    apply?: boolean;
    limit?: number;
    after?: string;
  } = {},
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("Limit must be between 1 and 1000");
  const missing = or(isNull(assets.width), isNull(assets.height));
  const batch = await db
    .select()
    .from(assets)
    .where(
      and(
        gt(assets.id, after),
        inArray(assets.contentType, [...DIMENSION_IMAGE_TYPES]),
        missing,
      ),
    )
    .orderBy(asc(assets.id))
    .limit(limit + 1);
  const rows = batch.slice(0, limit);
  const result = {
    mode: apply ? "apply" : "dry-run",
    scanned: rows.length,
    measured: 0,
    updated: 0,
    skipped: 0,
    nextCursor: batch.length > limit ? rows.at(-1)!.id : null,
  };
  // Process sequentially: at most one bounded image buffer is held in memory.
  for (const row of rows) {
    try {
      const address = { userId: row.userId, assetId: row.id };
      if ((await getAssetSize(address)) > MAX_DIMENSION_INPUT_BYTES) {
        result.skipped++;
        continue;
      }
      const { asset } = await readAsset({
        ...address,
        start: 0,
        end: MAX_DIMENSION_INPUT_BYTES - 1,
      });
      const dimensions = await extractImageDimensions(asset, row.contentType);
      if (!dimensions) {
        result.skipped++;
        continue;
      }
      result.measured++;
      if (apply) {
        const updated = await db
          .update(assets)
          .set(dimensions)
          .where(
            and(eq(assets.id, row.id), eq(assets.userId, row.userId), missing),
          );
        result.updated += updated.changes;
      }
    } catch {
      // One missing/corrupt legacy asset must not prevent the rest of the batch.
      result.skipped++;
    }
  }
  return result;
}
