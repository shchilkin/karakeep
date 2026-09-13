import { TRPCError } from "@trpc/server";
import { count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { mediaAiBatches, mediaAiControl, bookmarks } from "@karakeep/db/schema";
import serverConfig from "@karakeep/shared/config";
import {
  zAiBatchRequest,
  zAiFilter,
  zCloudMode,
} from "@karakeep/shared/aiControl";
import { LOCAL_CATALOG_MODEL } from "@karakeep/shared/mediaLocalCatalog";
import {
  createAdminScopedProcedure,
  createScopedAuthedProcedure,
  router,
} from "..";
import { aiQuotaUsed, getAiControl } from "../models/aiControl";
import {
  aiBatchView,
  aiHistory,
  changeAiBatch,
  listAiCards,
  prepareAiBatch,
} from "../models/aiBackoffice";

const own = createScopedAuthedProcedure("bookmarks");
const admin = createAdminScopedProcedure("system");
export const aiRouter = router({
  configuration: own.query(({ ctx }) => ({
    ...getAiControl(ctx.db),
    enabled: serverConfig.mediaAi.enabled,
    provider: serverConfig.mediaAi.provider,
    model: serverConfig.mediaAi.model,
    localModel: LOCAL_CATALOG_MODEL,
    localEnabled:
      serverConfig.mediaAi.hybridEnabled &&
      serverConfig.mediaAi.localMode === "enforce",
    automaticEnabled: serverConfig.mediaAi.autoNew,
    cloudConfigured: !!serverConfig.mediaAi.apiKey,
  })),
  controls: admin.query(({ ctx }) => ({
    ...getAiControl(ctx.db),
    used: aiQuotaUsed(ctx.db),
    ceiling: serverConfig.mediaAi.dailyRequests,
  })),
  updateControls: admin
    .input(
      z.object({
        cloudMode: zCloudMode,
        dailyRequests: z.number().int().min(1).max(1000),
        expectedRevision: z.number().int().nonnegative(),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.db.transaction(
        (tx) => {
          const current = getAiControl(tx);
          if (current.revision !== input.expectedRevision)
            throw new TRPCError({
              code: "CONFLICT",
              message: "Settings changed. Reload before saving.",
            });
          if (input.dailyRequests > serverConfig.mediaAi.dailyRequests)
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Daily limit exceeds the server ceiling.",
            });
          const next = {
            id: 1,
            cloudMode: input.cloudMode,
            dailyRequests: input.dailyRequests,
            revision: current.revision + 1,
            updatedAt: new Date().toISOString(),
          };
          tx.insert(mediaAiControl)
            .values(next)
            .onConflictDoUpdate({ target: mediaAiControl.id, set: next })
            .run();
          return getAiControl(tx);
        },
        { behavior: "immediate" },
      ),
    ),
  cards: own
    .input(
      z.object({
        filter: zAiFilter,
        offset: z.number().int().min(0).max(1_000_000).default(0),
      }),
    )
    .query(({ ctx, input }) =>
      listAiCards(ctx.db, ctx.user.id, input.filter, input.offset),
    ),
  models: own.query(({ ctx }) =>
    ctx.db
      .select({
        provider: sql<string>`json_extract(${bookmarks.mediaAi}, '$.resultSource.provider')`,
        model: sql<string>`json_extract(${bookmarks.mediaAi}, '$.resultSource.model')`,
        count: count(),
      })
      .from(bookmarks)
      .where(eq(bookmarks.userId, ctx.user.id))
      .groupBy(
        sql`json_extract(${bookmarks.mediaAi}, '$.resultSource.provider')`,
        sql`json_extract(${bookmarks.mediaAi}, '$.resultSource.model')`,
      )
      .all(),
  ),
  prepare: own
    .input(zAiBatchRequest)
    .mutation(({ ctx, input }) => prepareAiBatch(ctx.db, ctx.user.id, input)),
  batch: own
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => aiBatchView(ctx.db, ctx.user.id, input.id)),
  batches: own.query(({ ctx }) =>
    ctx.db
      .select({ id: mediaAiBatches.id })
      .from(mediaAiBatches)
      .where(eq(mediaAiBatches.userId, ctx.user.id))
      .orderBy(desc(mediaAiBatches.createdAt))
      .limit(20)
      .all()
      .map(({ id }) => aiBatchView(ctx.db, ctx.user.id, id)),
  ),
  changeBatch: own
    .input(
      z.object({
        id: z.string().uuid(),
        action: z.enum(["start", "pause", "resume", "cancel"]),
      }),
    )
    .mutation(({ ctx, input }) =>
      changeAiBatch(ctx.db, ctx.user.id, input.id, input.action),
    ),
  history: own
    .input(z.object({ bookmarkId: z.string() }))
    .query(({ ctx, input }) =>
      aiHistory(ctx.db, ctx.user.id, input.bookmarkId),
    ),
});
