import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  assets,
  assetHashScanLease,
  AssetTypes,
  bookmarks,
  bookmarkLinks,
  users,
} from "@karakeep/db/schema";
import { getInMemoryDB } from "@karakeep/db/drizzle";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import { getApiCaller } from "../testUtils";

const fixture = vi.hoisted(() => {
  const directory = `/tmp/karakeep-duplicates-${crypto.randomUUID()}`;
  process.env.ASSETS_DIR = directory;
  return { directory };
});
let db: ReturnType<typeof getInMemoryDB>;
beforeEach(async () => {
  db = getInMemoryDB(true);
  db.insert(users)
    .values([
      { id: "owner", name: "Owner", email: "owner@example.test" },
      { id: "other", name: "Other", email: "other@example.test" },
    ])
    .run();
  await mkdir(path.join(fixture.directory, "owner"), { recursive: true });
  await mkdir(path.join(fixture.directory, "other"), { recursive: true });
});
afterEach(async () => {
  await rm(fixture.directory, { recursive: true, force: true });
});

async function add(
  id: string,
  contents: string,
  options: {
    owner?: string;
    card?: string;
    name?: string;
    role?: AssetTypes;
    note?: string;
  } = {},
) {
  const owner = options.owner ?? "owner";
  const card = options.card ?? `card-${id}`;
  db.insert(bookmarks)
    .values({
      id: card,
      userId: owner,
      type: BookmarkTypes.LINK,
      title: `Card ${card}`,
      note: options.note,
      sensitiveCategories: [],
    })
    .onConflictDoNothing()
    .run();
  db.insert(bookmarkLinks)
    .values({ id: card, url: `https://example.test/${card}` })
    .onConflictDoNothing()
    .run();
  db.insert(assets)
    .values({
      id,
      userId: owner,
      bookmarkId: card,
      size: Buffer.byteLength(contents),
      contentType: "image/png",
      fileName: options.name ?? `${id}.png`,
      assetType: options.role ?? AssetTypes.USER_UPLOADED,
    })
    .run();
  const directory = path.join(fixture.directory, owner, id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "asset.bin"), contents);
  await writeFile(
    path.join(directory, "metadata.json"),
    JSON.stringify({
      contentType: "image/png",
      fileName: options.name ?? `${id}.png`,
    }),
  );
  return card;
}
async function scan(owner = "owner", recheck = false) {
  const api = getApiCaller(db, owner).duplicates;
  let afterId: string | null = null;
  for (let i = 0; i < 30; i++) {
    const result = await api.scanNext({ afterId, recheck });
    if (result.done) return;
    afterId = result.nextCursor;
  }
  throw new Error("Scan did not finish");
}

test("groups actual equal bytes across names; excludes derived images and other owners", async () => {
  await add("a", "identical-original", { name: "one.png" });
  await add("b", "identical-original", { name: "renamed.png" });
  await add("c", "different-content!", { name: "one.png" });
  await add("poster", "identical-original", { name: "video.poster.jpg" });
  await add("banner", "identical-original", {
    role: AssetTypes.LINK_BANNER_IMAGE,
  });
  await add("other-file", "identical-original", { owner: "other" });
  await scan();
  await scan("other");
  const api = getApiCaller(db, "owner").duplicates;
  expect(await api.status()).toMatchObject({
    originals: 3,
    verified: 3,
    needsIndex: 0,
    errors: 0,
    physicalReuse: false,
  });
  const list = await api.list({});
  expect(list.groups).toHaveLength(1);
  expect(list.groups[0]).toMatchObject({
    files: 2,
    cards: 2,
    size: 18,
    copyBytes: 18,
  });
  const group = await api.get({ groupId: list.groups[0].id });
  expect(group.members.map((m) => m.asset.id)).toEqual(["a", "b"]);
  expect(
    (await getApiCaller(db, "other").duplicates.list({})).groups,
  ).toHaveLength(0);
  await expect(
    getApiCaller(db, "other").duplicates.get({ groupId: group.id }),
  ).rejects.toThrow();
  await expect(getApiCaller(db).duplicates.scanNext({})).rejects.toThrow();
});

test("keep, prefer, defer and undo persist without moving unique attachments or changing notes", async () => {
  const a = await add("a", "shared", { note: "Keep this note" });
  const b = await add("b", "shared", { note: "A distinct source note" });
  await add("c", "unique", { card: a });
  await scan();
  const api = getApiCaller(db, "owner").duplicates;
  const id = (await api.list({})).groups[0].id;
  let group = await api.get({ groupId: id });
  const request = {
    groupId: id,
    evidenceVersion: group.evidenceVersion,
    expectedDecisionVersion: group.decisionVersion,
    decision: "keep_both" as const,
  };
  await api.decide(request);
  expect((await api.list({})).groups).toHaveLength(0);
  expect((await api.list({ view: "reviewed" })).groups).toHaveLength(1);
  await expect(api.decide({ ...request, decision: "defer" })).rejects.toThrow(
    /changed/,
  );
  group = await getApiCaller(db, "owner").duplicates.get({ groupId: id });
  await api.decide({
    ...request,
    decision: "prefer_primary",
    primaryBookmarkId: b,
    expectedDecisionVersion: group.decisionVersion,
  });
  group = await api.get({ groupId: id });
  expect(group.decision?.primaryBookmarkId).toBe(b);
  await api.decide({
    ...request,
    decision: "defer",
    expectedDecisionVersion: group.decisionVersion,
  });
  group = await api.get({ groupId: id });
  expect(group.decision?.decision).toBe("defer");
  await api.decide({
    ...request,
    decision: null,
    expectedDecisionVersion: group.decisionVersion,
  });
  group = await api.get({ groupId: id });
  expect(group.decision).toBeNull();
  expect(group.decisionVersion).toBe(4);
  const original = await getApiCaller(db, "owner").bookmarks.getBookmark({
    bookmarkId: a,
  });
  expect(original.note).toBe("Keep this note");
  expect(original.assets.map((x) => x.id).sort()).toEqual(["a", "c"]);
  expect(group.cards.find((x) => x.id === b)?.note).toBe(
    "A distinct source note",
  );
});

test("a new occurrence invalidates old decisions and stale review requests", async () => {
  await add("a", "same");
  await add("b", "same");
  await scan();
  const api = getApiCaller(db, "owner").duplicates;
  const id = (await api.list({})).groups[0].id;
  const old = await api.get({ groupId: id });
  await api.decide({
    groupId: id,
    evidenceVersion: old.evidenceVersion,
    expectedDecisionVersion: 0,
    decision: "keep_both",
  });
  await add("c", "same");
  await scan();
  expect((await api.list({})).groups).toHaveLength(1);
  const current = await api.get({ groupId: id });
  expect(current.decision).toBeNull();
  await expect(
    api.decide({
      groupId: id,
      evidenceVersion: old.evidenceVersion,
      expectedDecisionVersion: current.decisionVersion,
      decision: "defer",
    }),
  ).rejects.toThrow(/changed/);
  await expect(
    api.decide({
      groupId: id,
      evidenceVersion: current.evidenceVersion,
      expectedDecisionVersion: current.decisionVersion,
      decision: "prefer_primary",
      primaryBookmarkId: "not-a-member",
    }),
  ).rejects.toThrow(/Choose/);
});

test("unreadable or changed files cannot remain certified after recheck", async () => {
  await add("a", "same");
  await add("b", "same");
  await scan();
  await rm(path.join(fixture.directory, "owner", "b", "asset.bin"));
  await scan("owner", true);
  const api = getApiCaller(db, "owner").duplicates;
  expect((await api.list({})).groups).toHaveLength(0);
  expect(await api.status()).toMatchObject({ verified: 1, errors: 1 });
  await writeFile(
    path.join(fixture.directory, "owner", "b", "asset.bin"),
    "longer changed file",
  );
  await scan("owner", true);
  expect((await api.list({})).groups).toHaveLength(0);
  db.delete(assets).where(eq(assets.id, "b")).run();
  expect(await api.status()).toMatchObject({ originals: 1, verified: 1 });
});

test("read-only scoped API keys cannot scan storage or save review decisions", async () => {
  const api = getApiCaller(db, "owner", undefined, "user", {
    type: "apiKey",
    keyId: "key",
    scopes: ["bookmarks:read"],
  }).duplicates;
  expect(await api.status()).toMatchObject({ originals: 0 });
  await expect(api.scanNext({})).rejects.toThrow(/API keys/);
  await expect(
    api.decide({
      groupId: "no-group",
      evidenceVersion: "x",
      expectedDecisionVersion: 0,
      decision: "defer",
    }),
  ).rejects.toThrow(/scope/);
});

test("a durable active scan lease blocks another reader and an expired lease is recoverable", async () => {
  await add("a", "same", { card: "one-card" });
  await add("b", "same", { card: "one-card" });
  db.insert(assetHashScanLease)
    .values({ id: 1, token: "another-reader", expiresAt: Date.now() + 60_000 })
    .run();
  const api = getApiCaller(db, "owner").duplicates;
  await expect(api.scanNext({})).rejects.toThrow(/Another file scan/);
  expect((await api.status()).verified).toBe(0);
  db.update(assetHashScanLease)
    .set({ expiresAt: Date.now() - 1 })
    .run();
  await scan();
  const groups = (await api.list({})).groups;
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({ files: 2, cards: 1 });
  expect(db.select().from(assetHashScanLease).all()).toHaveLength(0);
});
