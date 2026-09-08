import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { AuthedContext } from "@karakeep/trpc";

const fixture = vi.hoisted(() => ({
  directory: `/tmp/karakeep-thumbnail-route-${crypto.randomUUID()}`,
  contents: new Map<string, Buffer>(),
  types: new Map<string, string>(),
  read: vi.fn(),
  ensure: vi.fn(),
}));
vi.mock("@karakeep/shared/config", () => ({
  default: { dataDir: fixture.directory, rateLimiting: { enabled: false } },
}));
vi.mock("@karakeep/shared-server", () => ({
  readAssetMetadata: async ({ assetId }: { assetId: string }) => ({
    contentType: fixture.types.get(assetId) ?? "image/jpeg",
  }),
  getAssetSize: async ({ assetId }: { assetId: string }) =>
    assetId === "huge"
      ? 65 * 1024 * 1024
      : fixture.contents.get(assetId)!.length,
  createAssetReadStream: ({ assetId }: { assetId: string }) => {
    fixture.read(assetId);
    return Readable.from([fixture.contents.get(assetId)!]);
  },
}));
vi.mock("@karakeep/trpc", () => ({ createCallerFactory: () => () => ({}) }));
vi.mock("@karakeep/trpc/routers/_app", () => ({ appRouter: {} }));
vi.mock("@karakeep/trpc/models/assets", () => ({
  Asset: {
    fromId: async (ctx: AuthedContext) => ({
      asset: { userId: "owner" },
      ensureCanView: async () => {
        fixture.ensure();
        if (ctx.user.id !== "owner") throw new HTTPException(403);
      },
    }),
  },
}));
vi.mock("../utils/upload", () => ({ uploadAsset: vi.fn() }));
vi.mock("../utils/assets", () => ({ serveAsset: vi.fn() }));
import assets from "./assets";

function app(user = "owner", scopes?: string[]) {
  return new Hono<{ Variables: { ctx: AuthedContext } }>()
    .use(async (c, next) => {
      c.set("ctx", {
        user: user ? { id: user } : null,
        auth: scopes ? { type: "apiKey", scopes } : { type: "session" },
      } as AuthedContext);
      await next();
    })
    .route("/assets", assets);
}
beforeAll(async () => {
  fixture.contents.set(
    "photo",
    await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: "#782c99" },
    })
      .jpeg()
      .toBuffer(),
  );
  fixture.contents.set("broken", Buffer.from("not an image"));
  fixture.contents.set("video", Buffer.from("video bytes"));
  fixture.types.set("video", "video/mp4");
});
afterAll(async () => {
  await rm(fixture.directory, { recursive: true, force: true });
});
it("resizes with real sharp, preserves aspect ratio, strips metadata, and reuses the cache", async () => {
  const client = app();
  const first = await client.request("/assets/photo/thumbnail?width=640");
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toBe("image/webp");
  expect(first.headers.get("cache-control")).toContain("private");
  const bytes = Buffer.from(await first.arrayBuffer());
  const meta = await sharp(bytes).metadata();
  expect([meta.width, meta.height, meta.format]).toEqual([640, 320, "webp"]);
  expect(meta.exif).toBeUndefined();
  expect(bytes.length).toBeLessThan(fixture.contents.get("photo")!.length);
  const reads = fixture.read.mock.calls.length;
  const second = await client.request("/assets/photo/thumbnail?width=640");
  expect(Buffer.from(await second.arrayBuffer())).toEqual(bytes);
  expect(fixture.read.mock.calls.length).toBe(reads);
});
it("checks authentication, asset authorization and API key scopes even on cache hits", async () => {
  for (const [client, code] of [
    [app(""), 401],
    [app("stranger"), 403],
    [app("owner", ["bookmarks:read"]), 403],
  ] as const) {
    const reads = fixture.read.mock.calls.length;
    expect(
      (await client.request("/assets/photo/thumbnail?width=640")).status,
    ).toBe(code);
    expect(fixture.read.mock.calls.length).toBe(reads);
  }
  expect(fixture.ensure).toHaveBeenCalled();
});
it("allows only fixed thumbnail sizes and rejects non-image and oversized originals", async () => {
  const client = app();
  expect(
    (await client.request("/assets/photo/thumbnail?width=99999")).status,
  ).toBe(400);
  expect(
    (await client.request("/assets/photo/thumbnail?width=-1")).status,
  ).toBe(400);
  expect(
    (await client.request("/assets/video/thumbnail?width=96")).status,
  ).toBe(415);
  expect((await client.request("/assets/huge/thumbnail?width=96")).status).toBe(
    413,
  );
  expect(
    (await client.request("/assets/broken/thumbnail?width=96")).status,
  ).toBe(422);
  expect(
    (await client.request("/assets/photo/thumbnail?width=96")).status,
  ).toBe(200);
});

it("keeps responsive width descriptors accurate for EXIF-rotated portraits", async () => {
  fixture.contents.set(
    "rotated",
    await sharp(fixture.contents.get("photo")!)
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer(),
  );
  const response = await app().request("/assets/rotated/thumbnail?width=640");
  expect(response.status).toBe(200);
  const metadata = await sharp(
    Buffer.from(await response.arrayBuffer()),
  ).metadata();
  expect([metadata.width, metadata.height]).toEqual([640, 1280]);
  expect(metadata.exif).toBeUndefined();
});
