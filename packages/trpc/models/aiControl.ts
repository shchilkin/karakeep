import type { DB, KarakeepDBTransaction } from "@karakeep/db";
import {
  mediaAiBatches,
  mediaAiControl,
  mediaAiRequests,
  mediaAiRuns,
} from "@karakeep/db/schema";
import { count, eq } from "drizzle-orm";
import serverConfig from "@karakeep/shared/config";
import type { MediaCatalogState } from "@karakeep/shared/mediaCatalog";
import { activeAiStatuses } from "@karakeep/shared/aiControl";

type Connection = DB | KarakeepDBTransaction;

export function getAiControl(db: Connection) {
  const stored = db
    .select()
    .from(mediaAiControl)
    .where(eq(mediaAiControl.id, 1))
    .get();
  return {
    cloudMode: stored?.cloudMode ?? ("auto" as const),
    dailyRequests: Math.min(
      stored?.dailyRequests ?? serverConfig.mediaAi.dailyRequests,
      serverConfig.mediaAi.dailyRequests,
    ),
    revision: stored?.revision ?? 0,
  };
}

export function aiQuotaUsed(db: Connection) {
  return db
    .select({ n: count() })
    .from(mediaAiRequests)
    .where(eq(mediaAiRequests.day, new Date().toISOString().slice(0, 10)))
    .get()!.n;
}

/** The stored mode is read for every claim and immediately before cloud dispatch. */
export function aiControlDecision(
  db: Connection,
  state: MediaCatalogState,
  cloud: boolean,
): "allow" | "wait" | "cancel" {
  if (state.batchId) {
    const batch = db
      .select()
      .from(mediaAiBatches)
      .where(eq(mediaAiBatches.id, state.batchId))
      .get();
    if (!batch || batch.status === "cancelled") return "cancel";
    if (batch.status === "paused" || batch.status === "draft") return "wait";
  }
  if (!cloud) return "allow";
  if (state.provider && state.provider !== serverConfig.mediaAi.provider)
    return "cancel";
  const { cloudMode } = getAiControl(db);
  if (cloudMode === "off" || (cloudMode === "manual" && state.automatic))
    return "wait";
  return "allow";
}

/** Keep the previous result and the current attempt as separate, durable records. */
export function recordAiRun(
  db: Connection,
  bookmarkId: string,
  userId: string,
  state: MediaCatalogState,
  legacy = false,
) {
  const insertion = db.insert(mediaAiRuns).values({
    id: state.runId,
    bookmarkId,
    userId,
    createdAt: state.updatedAt,
    completedAt:
      !legacy && !activeAiStatuses.includes(state.status)
        ? state.updatedAt
        : null,
    snapshot: state,
  });
  if (legacy) {
    insertion.onConflictDoNothing().run();
    return;
  }
  insertion
    .onConflictDoUpdate({
      target: mediaAiRuns.id,
      set: {
        snapshot: state,
        completedAt:
          !legacy && !activeAiStatuses.includes(state.status)
            ? state.updatedAt
            : null,
      },
    })
    .run();
}
