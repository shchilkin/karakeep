import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PreviewBusyError, MediaPreviewCache } from "./mediaPreviewCache";

const folders: string[] = [];
async function cache(bytes = 1024, pending = 64, age?: number) {
  const folder = await mkdtemp(
    path.join(tmpdir(), "karakeep-thumbnails-test-"),
  );
  folders.push(folder);
  return { folder, store: new MediaPreviewCache(folder, bytes, pending, age) };
}
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

it("coalesces duplicate requests and reuses disk cache after restart", async () => {
  const { folder, store } = await cache();
  const render = vi.fn(async () => Buffer.from("preview"));
  const results = await Promise.all(
    Array.from({ length: 20 }, () => store.get("owner/asset/640", render)),
  );
  expect(results.every((r) => r.toString() === "preview")).toBe(true);
  expect(render).toHaveBeenCalledOnce();
  await new MediaPreviewCache(folder).get("owner/asset/640", render);
  expect(render).toHaveBeenCalledOnce();
  await store.get("another-owner/asset/640", render);
  expect(render).toHaveBeenCalledTimes(2);
});
it("serializes conversion but serves a cached image while conversion is blocked", async () => {
  const { store } = await cache();
  await store.get("cached", async () => Buffer.from("ready"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const render = vi.fn(async () => {
    await gate;
    return Buffer.from("new");
  });
  const first = store.get("first", render);
  const second = store.get("second", render);
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
  expect((await store.get("cached", render)).toString()).toBe("ready");
  release();
  await Promise.all([first, second]);
  expect(render).toHaveBeenCalledTimes(2);
});
it("bounds the waiting queue and recovers after a failed conversion", async () => {
  const { store } = await cache(1024, 1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const render = vi.fn(async () => {
    await gate;
    throw new Error("decode failed");
  });
  const failed = store.get("broken", render);
  const assertion = expect(failed).rejects.toThrow("decode failed");
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
  await expect(store.get("overflow", render)).rejects.toBeInstanceOf(
    PreviewBusyError,
  );
  release();
  await assertion;
  expect(
    (await store.get("working", async () => Buffer.from("ok"))).toString(),
  ).toBe("ok");
});
it("evicts old entries to keep disk usage bounded", async () => {
  const { folder, store } = await cache(10);
  const render = vi.fn(async () => Buffer.from("123456"));
  await store.get("one", render);
  await store.get("two", render);
  expect(await readdir(folder)).toHaveLength(1);
  await store.get("one", render);
  expect(render).toHaveBeenCalledTimes(3);
  expect(await readdir(folder)).toHaveLength(1);
});
it("recreates expired or manually removed cache files", async () => {
  const { folder, store } = await cache(1024, 64, 0);
  const render = vi.fn(async () => Buffer.from("preview"));
  await store.get("old", render);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.get("old", render);
  expect(render).toHaveBeenCalledTimes(2);
  for (const name of await readdir(folder)) await rm(path.join(folder, name));
  await store.get("old", render);
  expect(render).toHaveBeenCalledTimes(3);
});

it("persists MP4 previews and reuses them across cache instances", async () => {
  const { folder } = await cache();
  const render = vi.fn(async () => Buffer.from("small video"));
  const first = new MediaPreviewCache(folder, 1024, 2, 60_000, "mp4");
  await first.get("owner/video", render);
  expect((await readdir(folder)).every((file) => file.endsWith(".mp4"))).toBe(
    true,
  );
  const restarted = new MediaPreviewCache(folder, 1024, 2, 60_000, "mp4");
  expect((await restarted.get("owner/video", render)).toString()).toBe(
    "small video",
  );
  expect(render).toHaveBeenCalledOnce();
});
