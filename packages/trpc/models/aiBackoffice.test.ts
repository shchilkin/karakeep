import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import { randomUUID } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getInMemoryDB } from "@karakeep/db/drizzle";
import {
  assets,
  AssetTypes,
  bookmarkLinks,
  bookmarks,
  mediaAiBatches,
  mediaAiControl,
  mediaAiRequests,
  mediaAiRuns,
  users,
} from "@karakeep/db/schema";
import { MediaCatalogQueue } from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import {
  LOCAL_CHECK_MODEL,
  LOCAL_CHECK_POLICY,
  LOCAL_CHECK_REVISION,
} from "@karakeep/shared/mediaLocalCheck";
import type { LocalCheckResult } from "@karakeep/shared/mediaLocalCheck";
import type { AiBatchRequest } from "@karakeep/shared/aiControl";
import {
  aiBatchView,
  aiHistory,
  changeAiBatch,
  drainAiBatches,
  listAiCards,
  prepareAiBatch,
} from "./aiBackoffice";
import {
  authorizeMediaCatalogDispatch,
  catalogSnapshot,
  continueMediaCatalog,
  finishMediaCatalog,
  recoverHeldMediaCatalog,
  reconcileLocalMediaCatalog,
  requestMediaCatalog,
  startMediaCatalog,
} from "./mediaCatalog";
import { getApiCaller } from "../testUtils";

vi.mock("@karakeep/shared-server", async (original) => ({
  ...(await original<typeof import("@karakeep/shared-server")>()),
  MediaCatalogQueue: { enqueue: vi.fn().mockResolvedValue("queued") },
}));
let db: ReturnType<typeof getInMemoryDB>;
const result = {
  title: "New AI title",
  summary: "A neutral description",
  tags: ["portrait", "studio"],
};
function addCard(id: string, userId = "owner") {
  db.insert(bookmarks)
    .values({
      id,
      userId,
      type: BookmarkTypes.LINK,
      title: `Title ${id}`,
      titleSource: "manual",
      note: "Keep my note",
    })
    .run();
  db.insert(bookmarkLinks)
    .values({ id, url: `https://example.test/${id}` })
    .run();
  db.insert(assets)
    .values({
      id: `${id}-asset`,
      bookmarkId: id,
      userId,
      assetType: AssetTypes.USER_UPLOADED,
      fileName: "001.jpg",
    })
    .run();
}
function request(ids = ["card"]): AiBatchRequest {
  return {
    requestId: randomUUID(),
    selection: { type: "ids", ids },
    mode: "hybrid",
    model: "test-vision-2",
    action: "analyze",
  };
}
function state(id = "card") {
  return catalogSnapshot(db, "owner", id).bookmark.mediaAi!;
}
function job(id = "card") {
  return { bookmarkId: id, userId: "owner", runId: state(id).runId };
}
function control(mode: "off" | "manual" | "auto") {
  db.insert(mediaAiControl)
    .values({
      id: 1,
      cloudMode: mode,
      dailyRequests: 20,
      revision: 1,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({ target: mediaAiControl.id, set: { cloudMode: mode } })
    .run();
}
function localCheck(sensitive = false): LocalCheckResult {
  return {
    scope: "outgoing_images_only",
    frames: [
      {
        model: LOCAL_CHECK_MODEL,
        revision: LOCAL_CHECK_REVISION,
        policy: LOCAL_CHECK_POLICY,
        precision: "bf16",
        status: "complete",
        categories: sensitive ? ["sexual"] : [],
        scores: { dangerous: 0, sexual: sensitive ? 1 : 0, violence: 0 },
        sha256: "a".repeat(64),
      },
    ],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  db = getInMemoryDB(true);
  db.insert(users)
    .values([
      { id: "owner", name: "Owner", email: "owner@test" },
      { id: "other", name: "Other", email: "other@test" },
    ])
    .run();
  addCard("card");
  Object.assign(serverConfig.mediaAi, {
    enabled: true,
    autoNew: true,
    localAutoNew: false,
    hybridEnabled: true,
    localMode: "enforce",
    provider: "xai",
    apiKey: "synthetic",
    model: "test-vision-1",
    dailyRequests: 20,
  });
});

test("draft only fixes selection; later matching cards never join the batch", async () => {
  const input = {
    ...request(),
    selection: {
      type: "filter" as const,
      filter: { status: "missing" as const },
    },
  };
  const draft = prepareAiBatch(db, "owner", input);
  expect(MediaCatalogQueue.enqueue).not.toHaveBeenCalled();
  expect(db.select().from(mediaAiRequests).all()).toHaveLength(0);
  addCard("later");
  await changeAiBatch(db, "owner", draft.id, "start");
  expect(
    aiBatchView(db, "owner", draft.id).entries.map((e) => e.bookmarkId),
  ).toEqual(["card"]);
  expect(state("later")).toBeNull();
});

test("repeated confirmation and concurrent delivery reuse one run without another reservation", async () => {
  const input = request();
  const draft = prepareAiBatch(db, "owner", input);
  expect(prepareAiBatch(db, "owner", input).id).toBe(draft.id);
  await Promise.all([
    changeAiBatch(db, "owner", draft.id, "start"),
    changeAiBatch(db, "owner", draft.id, "start"),
  ]);
  const first = job();
  startMediaCatalog(db, first);
  expect(continueMediaCatalog(db, first, localCheck())).toBe(true);
  finishMediaCatalog(db, first, "success", result);
  await drainAiBatches(db);
  await changeAiBatch(db, "owner", draft.id, "start");
  expect(state().runId).toBe(first.runId);
  expect(db.select().from(mediaAiRequests).all()).toHaveLength(1);
  expect(aiBatchView(db, "owner", draft.id).status).toBe("complete");
});

test("cloud off parks admitted clean media without a reservation but keeps local sensitive analysis", async () => {
  control("off");
  await requestMediaCatalog(db, "owner", "card");
  const first = job();
  expect(startMediaCatalog(db, first)).not.toBeNull();
  expect(continueMediaCatalog(db, first, localCheck())).toBe(false);
  expect(state()).toMatchObject({ status: "waiting_control", route: "cloud" });
  expect(db.select().from(mediaAiRequests).all()).toHaveLength(0);
  expect(() => startMediaCatalog(db, first)).toThrow("waiting_control");
  addCard("sensitive");
  await requestMediaCatalog(db, "owner", "sensitive");
  startMediaCatalog(db, job("sensitive"));
  expect(continueMediaCatalog(db, job("sensitive"), localCheck(true))).toBe(
    "local",
  );
  expect(authorizeMediaCatalogDispatch(db, job("sensitive"), false)).toBe(true);
  expect(db.select().from(mediaAiRequests).all()).toHaveLength(0);
  control("auto");
  await recoverHeldMediaCatalog(db);
  startMediaCatalog(db, first);
  expect(continueMediaCatalog(db, first, localCheck())).toBe(true);
  expect(authorizeMediaCatalogDispatch(db, first, true)).toBe(true);
  expect(db.select().from(mediaAiRequests).all()).toHaveLength(1);
});

test("manual-only cloud holds automatic requests, but permits an explicit batch", async () => {
  control("manual");
  // ASSET path makes automatic catalog eligibility independent of a social tag.
  await requestMediaCatalog(db, "owner", "card");
  db.update(bookmarks)
    .set({ mediaAi: { ...state(), automatic: true } })
    .where(eq(bookmarks.id, "card"))
    .run();
  startMediaCatalog(db, job());
  expect(continueMediaCatalog(db, job(), localCheck())).toBe(false);
  addCard("manual");
  const draft = prepareAiBatch(db, "owner", request(["manual"]));
  await changeAiBatch(db, "owner", draft.id, "start");
  startMediaCatalog(db, job("manual"));
  expect(continueMediaCatalog(db, job("manual"), localCheck())).toBe(true);
  expect(db.select().from(mediaAiRequests).all()).toHaveLength(1);
});

test("the final dispatch gate catches a cloud pause after reservation and never replays it", async () => {
  await requestMediaCatalog(db, "owner", "card");
  const first = job();
  startMediaCatalog(db, first);
  continueMediaCatalog(db, first, localCheck());
  control("off");
  expect(authorizeMediaCatalogDispatch(db, first, true)).toBe(false);
  expect(state().status).toBe("cancelled");
  control("auto");
  await recoverHeldMediaCatalog(db);
  expect(startMediaCatalog(db, first)).toBeNull();
  expect(db.select().from(mediaAiRequests).all()).toHaveLength(1);
});

test("direct cloud mode also honors the stop before preparing media", async () => {
  Object.assign(serverConfig.mediaAi, {
    hybridEnabled: false,
    localMode: "off",
  });
  control("off");
  await requestMediaCatalog(db, "owner", "card");
  expect(() => startMediaCatalog(db, job())).toThrow("waiting_control");
  expect(db.select().from(mediaAiRequests).all()).toHaveLength(0);
});

test("pause/resume preserves a batch's run and cancel blocks unstarted work", async () => {
  const draft = prepareAiBatch(db, "owner", request());
  await changeAiBatch(db, "owner", draft.id, "start");
  const first = job();
  await changeAiBatch(db, "owner", draft.id, "pause");
  expect(() => startMediaCatalog(db, first)).toThrow("waiting_control");
  expect(db.select().from(mediaAiRequests).all()).toHaveLength(0);
  await changeAiBatch(db, "owner", draft.id, "resume");
  expect(startMediaCatalog(db, first)).not.toBeNull();
  await changeAiBatch(db, "owner", draft.id, "cancel");
  expect(continueMediaCatalog(db, first, localCheck())).toBe(false);
  expect(state().status).toBe("cancelled");
  expect(db.select().from(mediaAiRequests).all()).toHaveLength(0);
});

test("new model refresh retains the old result on failure and records successful provenance later", async () => {
  await requestMediaCatalog(db, "owner", "card");
  const first = job();
  startMediaCatalog(db, first);
  continueMediaCatalog(db, first, localCheck());
  finishMediaCatalog(db, first, "success", result, [], {
    resolvedModel: "snapshot-1",
    sampledImages: 1,
    assetCount: 1,
  });
  const previousSource = state().resultSource;
  const draft = prepareAiBatch(db, "owner", {
    ...request(),
    action: "refresh",
  });
  expect(draft.previousPaidAttempts).toBe(1);
  await changeAiBatch(db, "owner", draft.id, "start");
  const second = job();
  startMediaCatalog(db, second);
  continueMediaCatalog(db, second, localCheck());
  finishMediaCatalog(db, second, "failed");
  expect(state().resultSource).toEqual(previousSource);
  expect(state().result).toEqual(result);
  expect(aiHistory(db, "owner", "card")).toHaveLength(2);
  expect(
    listAiCards(db, "owner", {
      status: "all",
      provider: "xai",
      model: "test-vision-1",
    }).total,
  ).toBe(1);
  expect(
    db
      .select()
      .from(mediaAiRuns)
      .all()
      .find((r) => r.id === first.runId)?.snapshot.resultSource?.resolvedModel,
  ).toBe("snapshot-1");
  const next = prepareAiBatch(db, "owner", { ...request(), action: "refresh" });
  await changeAiBatch(db, "owner", next.id, "start");
  startMediaCatalog(db, job());
  continueMediaCatalog(db, job(), localCheck());
  finishMediaCatalog(db, job(), "success", result, [], {
    resolvedModel: "snapshot-2",
    sampledImages: 1,
    assetCount: 1,
  });
  expect(state().resultSource).toMatchObject({
    provider: "xai",
    model: "test-vision-2",
    resolvedModel: "snapshot-2",
    catalogVersion: 1,
  });
  expect(
    listAiCards(db, "owner", {
      status: "all",
      provider: "xai",
      model: "test-vision-2",
    }).total,
  ).toBe(1);
  expect(catalogSnapshot(db, "owner", "card").bookmark).toMatchObject({
    title: "Title card",
    note: "Keep my note",
  });
});

test("manual edits changing the policy/content revision invalidate a prepared batch", async () => {
  const draft = prepareAiBatch(db, "owner", request());
  db.update(bookmarks).set({ contentRevision: 2 }).run();
  await changeAiBatch(db, "owner", draft.id, "start");
  expect(state()).toBeNull();
  expect(aiBatchView(db, "owner", draft.id).entries[0].status).toBe("skipped");
  expect(MediaCatalogQueue.enqueue).not.toHaveBeenCalled();
});

test("deferred imports cannot obtain a catalog permit through bulk", async () => {
  db.update(bookmarks)
    .set({ processingPolicy: "deferred", policyRevision: 1 })
    .run();
  const draft = prepareAiBatch(db, "owner", request());
  expect(draft.entries[0].reason).toBe("import_held");
  await changeAiBatch(db, "owner", draft.id, "start");
  expect(MediaCatalogQueue.enqueue).not.toHaveBeenCalled();
});

test("provider changes after preparation cancel dispatch instead of using another provider's key", async () => {
  const draft = prepareAiBatch(db, "owner", request());
  await changeAiBatch(db, "owner", draft.id, "start");
  serverConfig.mediaAi.provider = "openai";
  startMediaCatalog(db, job());
  expect(continueMediaCatalog(db, job(), localCheck())).toBe(false);
  expect(state().status).toBe("cancelled");
  expect(db.select().from(mediaAiRequests).all()).toHaveLength(0);
});

test("ownership, administrator controls and optimistic settings revisions are enforced", async () => {
  addCard("foreign", "other");
  expect(() => prepareAiBatch(db, "owner", request(["foreign"]))).toThrow();
  const draft = prepareAiBatch(db, "owner", request());
  expect(() => aiBatchView(db, "other", draft.id)).toThrow();
  expect(() => aiHistory(db, "other", "card")).toThrow();
  await expect(
    getApiCaller(db, "owner").ai.updateControls({
      cloudMode: "off",
      dailyRequests: 1,
      expectedRevision: 0,
    }),
  ).rejects.toThrow();
  const admin = getApiCaller(db, "owner", "owner@test", "admin");
  await admin.ai.updateControls({
    cloudMode: "off",
    dailyRequests: 1,
    expectedRevision: 0,
  });
  await expect(
    admin.ai.updateControls({
      cloudMode: "auto",
      dailyRequests: 2,
      expectedRevision: 0,
    }),
  ).rejects.toThrow();
  await expect(
    admin.ai.updateControls({
      cloudMode: "auto",
      dailyRequests: 21,
      expectedRevision: 1,
    }),
  ).rejects.toThrow();
  expect(db.select().from(mediaAiControl).get()?.cloudMode).toBe("off");
});

test("a daily cap applies across manual batches; draft identity cannot be repurposed", async () => {
  control("auto");
  db.update(mediaAiControl).set({ dailyRequests: 1 }).run();
  addCard("two");
  const input = request(["card", "two"]);
  const draft = prepareAiBatch(db, "owner", input);
  expect(() =>
    prepareAiBatch(db, "owner", { ...input, model: "different" }),
  ).toThrow();
  await changeAiBatch(db, "owner", draft.id, "start");
  for (const id of ["card", "two"]) {
    startMediaCatalog(db, job(id));
    continueMediaCatalog(db, job(id), localCheck());
  }
  expect(state("two").status).toBe("quota_exceeded");
  expect(db.select().from(mediaAiRequests).all()).toHaveLength(1);
  expect(db.select().from(mediaAiBatches).all()).toHaveLength(1);
});

test("review filter includes unknown provenance and changed content, while current results stay out", async () => {
  await requestMediaCatalog(db, "owner", "card");
  startMediaCatalog(db, job());
  continueMediaCatalog(db, job(), localCheck());
  finishMediaCatalog(db, job(), "success", result);
  expect(listAiCards(db, "owner", { status: "needs_review" }).total).toBe(0);
  db.update(bookmarks).set({ contentRevision: 2 }).run();
  expect(listAiCards(db, "owner", { status: "needs_review" }).total).toBe(1);
  db.update(bookmarks)
    .set({
      contentRevision: 0,
      mediaAi: {
        ...state(),
        resultSource: { provider: "xai", model: "old-model" },
      },
    })
    .run();
  expect(listAiCards(db, "owner", { status: "needs_review" }).total).toBe(1);
});

test("manual Sensitive change during media I/O blocks the final cloud dispatch", async () => {
  await requestMediaCatalog(db, "owner", "card");
  startMediaCatalog(db, job());
  continueMediaCatalog(db, job(), localCheck());
  db.update(bookmarks)
    .set({ sensitiveCategories: ["nudity"] })
    .run();
  expect(authorizeMediaCatalogDispatch(db, job(), true)).toBe(false);
  expect(state().status).toBe("cancelled");
});

test("terminal admission failures stay terminal in history after a new refresh", async () => {
  control("auto");
  db.update(mediaAiControl).set({ dailyRequests: 0 }).run();
  await requestMediaCatalog(db, "owner", "card");
  const old = job();
  startMediaCatalog(db, old);
  expect(continueMediaCatalog(db, old, localCheck())).toBeFalsy();
  expect(state().status).toBe("quota_exceeded");
  expect(
    db.select().from(mediaAiRuns).where(eq(mediaAiRuns.id, old.runId)).get()
      ?.snapshot.status,
  ).toBe("quota_exceeded");
  db.update(mediaAiControl).set({ dailyRequests: 20 }).run();
  const draft = prepareAiBatch(db, "owner", request());
  await changeAiBatch(db, "owner", draft.id, "start");
  expect(
    aiHistory(db, "owner", "card").find((r) => r.id === old.runId),
  ).toMatchObject({ status: "quota_exceeded", current: false });
});

test("attachment follow-up intent survives reconciliation while cloud is held", async () => {
  control("off");
  await requestMediaCatalog(db, "owner", "card");
  const held = job();
  startMediaCatalog(db, held);
  continueMediaCatalog(db, held, localCheck());
  db.update(bookmarks)
    .set({ mediaAi: { ...state(), localRecheckRequested: true } })
    .run();
  await reconcileLocalMediaCatalog(db, held);
  expect(state()).toMatchObject({
    status: "waiting_control",
    localRecheckRequested: true,
  });
});
