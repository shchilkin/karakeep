import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  zDuplicateDecisionRequest,
  zDuplicateList,
  zDuplicateScan,
} from "@karakeep/shared/types/duplicates";
import { authMiddleware } from "../middlewares/auth";
import { apiKeyScopeMiddleware } from "../middlewares/apiKeyScopes";
import { rejectMutationInReadOnlyMode } from "../middlewares/readOnlyMode";

export default new Hono()
  .use(authMiddleware)
  .get("/status", apiKeyScopeMiddleware("bookmarks", "read"), async (c) =>
    c.json(await c.var.api.duplicates.status()),
  )
  .get(
    "/",
    apiKeyScopeMiddleware("bookmarks", "read"),
    zValidator(
      "query",
      zDuplicateList.extend({
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }),
    ),
    async (c) => c.json(await c.var.api.duplicates.list(c.req.valid("query"))),
  )
  .get("/:groupId", apiKeyScopeMiddleware("bookmarks", "read"), async (c) =>
    c.json(await c.var.api.duplicates.get({ groupId: c.req.param("groupId") })),
  )
  .post(
    "/scan-next",
    rejectMutationInReadOnlyMode,
    zValidator("json", zDuplicateScan),
    async (c) =>
      c.json(await c.var.api.duplicates.scanNext(c.req.valid("json"))),
  )
  .post(
    "/decisions",
    rejectMutationInReadOnlyMode,
    apiKeyScopeMiddleware("bookmarks", "readwrite"),
    zValidator("json", zDuplicateDecisionRequest),
    async (c) => c.json(await c.var.api.duplicates.decide(c.req.valid("json"))),
  );
