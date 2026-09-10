import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt } from "drizzle-orm";
import type { DB } from "@karakeep/db";
import { bookmarks } from "@karakeep/db/schema";
import serverConfig from "@karakeep/shared/config";
import { catalogBusy } from "@karakeep/shared/mediaCatalog";
import {
  catalogFingerprint,
  catalogSnapshot,
  requestMediaCatalog,
} from "./mediaCatalog";

/** Bounded, owner-scoped, local-only backfill. Dry-run does not enqueue work,
 * touch media, or call either inference service. Retry of terminal failures is
 * separate from backfill; rerunning a page cannot silently repeat an analysis. */
export async function backfillLocalMedia(
  db: DB,
  userId: string,
  options: { apply: boolean; limit: number; cursor?: string },
) {
  const config = serverConfig.mediaAi;
  if (!config.enabled || config.localMode === "off")
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Enable local analysis before backfill",
    });
  const page = db
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .where(
      and(
        eq(bookmarks.userId, userId),
        options.cursor ? gt(bookmarks.id, options.cursor) : undefined,
      ),
    )
    .orderBy(asc(bookmarks.id))
    .limit(options.limit + 1)
    .all();
  const rows = page.slice(0, options.limit);
  const summary = {
    scanned: rows.length,
    eligible: 0,
    queued: 0,
    busy: 0,
    unchanged: 0,
    unsupported: 0,
    failed: 0,
    nextCursor: page.length > options.limit ? rows[rows.length - 1].id : null,
  };
  for (const { id } of rows) {
    const { bookmark, input } = catalogSnapshot(db, userId, id, true);
    if (!input || input.media.kind === "text") {
      summary.unsupported++;
      continue;
    }
    if (
      bookmark.mediaAi?.status === "pending" ||
      catalogBusy(bookmark.mediaAi)
    ) {
      summary.busy++;
      continue;
    }
    if (
      bookmark.mediaAi?.fingerprint ===
      catalogFingerprint(input, config.model, true)
    ) {
      summary.unchanged++;
      continue;
    }
    summary.eligible++;
    if (options.apply) {
      try {
        if (
          await requestMediaCatalog(db, userId, id, {
            localOnly: true,
            allowPreview: true,
          })
        )
          summary.queued++;
      } catch {
        summary.failed++;
      }
    }
  }
  return summary;
}
