import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { AuthedContext } from "@karakeep/trpc";

const fixture = vi.hoisted(() => ({
  directory: `/tmp/karakeep-hover-route-${crypto.randomUUID()}`,
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
    contentType: fixture.types.get(assetId) ?? "video/mp4",
  }),
  getAssetSize: async ({ assetId }: { assetId: string }) =>
    assetId === "huge"
      ? 513 * 1024 * 1024
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
  await mkdir(fixture.directory, { recursive: true });
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=30:duration=8",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=8",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    fixture.directory + "/source.mp4",
  ]);
  fixture.contents.set(
    "video",
    await readFile(fixture.directory + "/source.mp4"),
  );
  fixture.contents.set("broken", Buffer.from("invalid video"));
  fixture.contents.set("image", Buffer.from("image"));
  fixture.types.set("image", "image/jpeg");
}, 20000);
afterAll(async () => {
  await rm(fixture.directory, { recursive: true, force: true });
});

it("encodes a small silent H264 preview, preserves originals, and reuses it", async () => {
  const original = Buffer.from(fixture.contents.get("video")!);
  const client = app();
  const response = await client.request("/assets/video/hover-clip");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("video/mp4");
  expect(response.headers.get("cache-control")).toContain("private");
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes.length).toBeLessThan(original.length / 3);
  expect(bytes.length).toBeLessThan(2 * 1024 * 1024);
  await writeFile(fixture.directory + "/output.mp4", bytes);
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        fixture.directory + "/output.mp4",
      ],
      { encoding: "utf8" },
    ),
  );
  expect(probe.streams).toHaveLength(1);
  expect(probe.streams[0].codec_name).toBe("h264");
  expect(probe.streams[0].pix_fmt).toBe("yuv420p");
  expect(probe.streams[0].width).toBeLessThanOrEqual(480);
  expect(probe.streams[0].height).toBeLessThanOrEqual(480);
  expect(probe.streams[0].r_frame_rate).toBe("15/1");
  expect(Number(probe.format.duration)).toBeGreaterThan(5);
  expect(Number(probe.format.duration)).toBeLessThanOrEqual(6.1);
  expect(bytes.indexOf(Buffer.from("moov"))).toBeLessThan(
    bytes.indexOf(Buffer.from("mdat")),
  );
  const reads = fixture.read.mock.calls.length;
  expect(
    Buffer.from(
      await (await client.request("/assets/video/hover-clip")).arrayBuffer(),
    ),
  ).toEqual(bytes);
  expect(fixture.read.mock.calls.length).toBe(reads);
  expect(fixture.contents.get("video")).toEqual(original);
}, 20000);

it("requires authentication, ownership and asset read scope on warm cache", async () => {
  for (const [client, status] of [
    [app(""), 401],
    [app("stranger"), 403],
    [app("owner", ["bookmarks:read"]), 403],
  ] as const) {
    const reads = fixture.read.mock.calls.length;
    expect((await client.request("/assets/video/hover-clip")).status).toBe(
      status,
    );
    expect(fixture.read.mock.calls.length).toBe(reads);
  }
});
it("supports browser byte ranges and rejects malformed or unsatisfiable ranges", async () => {
  const client = app();
  const whole = Buffer.from(
    await (await client.request("/assets/video/hover-clip")).arrayBuffer(),
  );
  for (const [header, start, end] of [
    ["bytes=0-9", 0, 9],
    ["bytes=10-", 10, whole.length - 1],
    ["bytes=-10", whole.length - 10, whole.length - 1],
  ] as const) {
    const response = await client.request("/assets/video/hover-clip", {
      headers: { Range: header },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(
      `bytes ${start}-${end}/${whole.length}`,
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      whole.subarray(start, end + 1),
    );
  }
  for (const header of [
    "bytes=-0",
    "bytes=8-2",
    "bytes=999999999-",
    "bytes=0-1,3-4",
    "items=0-1",
  ]) {
    const response = await client.request("/assets/video/hover-clip", {
      headers: { Range: header },
    });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(
      `bytes */${whole.length}`,
    );
  }
});
it("rejects non-video/oversized/corrupt inputs and recovers for valid requests", async () => {
  const client = app();
  for (const [asset, status] of [
    ["image", 415],
    ["huge", 413],
    ["broken", 422],
  ] as const)
    expect((await client.request(`/assets/${asset}/hover-clip`)).status).toBe(
      status,
    );
  const reads = fixture.read.mock.calls.length;
  expect((await client.request("/assets/broken/hover-clip")).status).toBe(422);
  expect(fixture.read.mock.calls.length).toBe(reads);
  expect((await client.request("/assets/video/hover-clip")).status).toBe(200);
});
it("also handles saved WebM and Matroska video without changing originals", async () => {
  for (const [ext, codec, mime] of [
    ["webm", "libvpx-vp9", "video/webm"],
    ["mkv", "libx264", "video/x-matroska"],
  ]) {
    const file = fixture.directory + "/source." + ext;
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=blue:size=120x240:rate=10:duration=1",
      "-c:v",
      codec,
      "-threads",
      "1",
      file,
    ]);
    fixture.contents.set(ext, await readFile(file));
    fixture.types.set(ext, mime);
    const response = await app().request(`/assets/${ext}/hover-clip`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
  }
}, 20000);
