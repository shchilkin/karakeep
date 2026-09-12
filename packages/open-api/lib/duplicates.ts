import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  zDuplicateDecisionRequest,
  zDuplicateList,
  zDuplicateScan,
} from "@karakeep/shared/types/duplicates";
import { BearerAuth } from "./common";
import { UnauthorizedResponse } from "./errors";

export const registry = new OpenAPIRegistry();
const security = [{ [BearerAuth.name]: [] }];
const tags = ["Duplicates"];
const json = (schema: z.ZodType) => ({ "application/json": { schema } });
const errors = {
  401: UnauthorizedResponse,
  403: {
    description:
      "The authenticated caller lacks the required bookmark scope, or a mutation is disabled in read-only mode.",
  },
};
registry.registerPath({
  operationId: "getDuplicateIndexStatus",
  method: "get",
  path: "/duplicates/status",
  tags,
  security,
  summary: "Get original-file index coverage",
  description:
    "Returns only the owner's attached original occurrences. This read does not start indexing. Requires bookmarks:read.",
  responses: {
    200: {
      description: "Current owner index coverage.",
      content: json(
        z.object({
          originals: z.number(),
          verified: z.number(),
          needsIndex: z.number(),
          errors: z.number(),
          maxFileBytes: z.number(),
          physicalReuse: z.literal(false),
        }),
      ),
    },
    ...errors,
  },
});
registry.registerPath({
  operationId: "listDuplicateGroups",
  method: "get",
  path: "/duplicates",
  tags,
  security,
  summary: "List exact-byte duplicate groups",
  description:
    "Requires bookmarks:read. Cursors page through candidate groups before applying the decision filter. An empty page may still have a nextCursor; continue until it is null. All hashes and groups are owner-scoped.",
  request: { query: zDuplicateList },
  responses: {
    200: {
      description:
        "A page of groups with at least two currently indexed original occurrences.",
      content: json(
        z.object({
          groups: z.array(
            z.object({
              id: z.string(),
              files: z.number(),
              cards: z.number(),
              size: z.number(),
              copyBytes: z.number(),
              decision: z
                .enum(["keep_both", "defer", "prefer_primary"])
                .nullable(),
            }),
          ),
          nextCursor: z.string().nullable(),
        }),
      ),
    },
    ...errors,
  },
});
registry.registerPath({
  operationId: "getDuplicateGroup",
  method: "get",
  path: "/duplicates/{groupId}",
  tags,
  security,
  summary: "Compare originals and their owning cards",
  description:
    "Requires bookmarks:read. Returns id, evidenceVersion, decisionVersion, current decision or null, all matching members with asset metadata and verifiedAt, the first 50 cards, cardContext (originalCount and visible lists), truncated, and size. Decisions apply to the exact membership version; a changed membership reopens review. A shared file is not evidence that entire cards are equivalent.",
  request: { params: z.object({ groupId: z.string() }) },
  responses: {
    200: {
      description: "Owner-only comparison and optimistic concurrency tokens.",
    },
    404: {
      description:
        "Group unavailable to this owner or fewer than two valid originals remain.",
    },
    ...errors,
  },
});
registry.registerComponent("securitySchemes", "OwnerSession", {
  type: "apiKey",
  in: "cookie",
  name: "next-auth.session-token",
  description:
    "An authenticated owner web session. Secure deployments use the __Secure-next-auth.session-token cookie.",
});
registry.registerPath({
  operationId: "scanNextDuplicateOriginal",
  method: "post",
  path: "/duplicates/scan-next",
  tags,
  security: [{ OwnerSession: [] }],
  summary: "Hash one original file",
  description:
    "Owner web session only; API keys are rejected. Reads one original, capped at 512 MiB and 20 seconds. A durable global lease permits one reader at a time. Pass nextCursor as afterId until done is true. recheck=false skips indexed occurrences; recheck=true revisits prior successes and errors. No media decode, AI call, media mutation or automatic scan occurs.",
  request: { body: { required: true, content: json(zDuplicateScan) } },
  responses: {
    200: {
      description: "One bounded scan step or end of scan.",
      content: json(
        z.object({
          done: z.boolean(),
          nextCursor: z.string().nullable(),
          status: z
            .enum(["verified", "unreadable", "too_large", "changed"])
            .nullable(),
        }),
      ),
    },
    409: { description: "Another file reader holds the lease; retry later." },
    ...errors,
  },
});
registry.registerPath({
  operationId: "saveDuplicateDecision",
  method: "post",
  path: "/duplicates/decisions",
  tags,
  security,
  summary: "Save or undo a review decision",
  description:
    "Requires bookmarks:readwrite. Submit the evidenceVersion and decisionVersion from the comparison as expectedDecisionVersion. prefer_primary requires a member card's ID. decision=null undoes the decision while advancing its revision. This organizes review only: all cards, notes and files remain saved and no storage is reclaimed.",
  request: {
    body: { required: true, content: json(zDuplicateDecisionRequest) },
  },
  responses: {
    200: {
      description: "Saved decision revision.",
      content: json(z.object({ version: z.number() })),
    },
    400: { description: "Invalid primary card or request." },
    404: { description: "Group unavailable." },
    409: {
      description:
        "Membership or decision changed. Refresh the group before saving again.",
    },
    ...errors,
  },
});
