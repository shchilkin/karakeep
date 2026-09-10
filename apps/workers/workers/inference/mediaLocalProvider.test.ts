import { beforeEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import serverConfig from "@karakeep/shared/config";
import {
  LOCAL_CHECK_MODEL,
  LOCAL_CHECK_POLICY,
  LOCAL_CHECK_REVISION,
} from "@karakeep/shared/mediaLocalCheck";
import { checkLocalMedia, reusableLocalCheck } from "./mediaLocalProvider";

const frame = {
  model: LOCAL_CHECK_MODEL,
  revision: LOCAL_CHECK_REVISION,
  policy: LOCAL_CHECK_POLICY,
  precision: "bf16",
  status: "complete",
  categories: [],
  scores: { dangerous: 0.01, sexual: 0.01, violence: 0.01 },
};
beforeEach(() =>
  Object.assign(serverConfig.mediaAi, {
    localUrl: "http://classifier:8091/classify",
    localToken: "synthetic-test-token",
  }),
);

test("one sequential private request per image binds the decision to exact outgoing pixels", async () => {
  const pixels = [Buffer.from("one"), Buffer.from("two")];
  let active = 0;
  const request = vi.fn(async (_url: unknown, options: RequestInit = {}) => {
    expect(++active).toBe(1);
    expect(options.redirect).toBe("error");
    const body = JSON.parse(options.body as string);
    expect(Object.keys(body)).toEqual(["image"]);
    await Promise.resolve();
    active--;
    return Response.json(frame);
  });
  const result = await checkLocalMedia(
    pixels,
    new AbortController().signal,
    request,
  );
  expect(result.frames).toHaveLength(2);
  expect(result.frames[0].sha256).toBe(
    createHash("sha256").update(pixels[0]).digest("hex"),
  );
  expect(reusableLocalCheck(result, pixels)).toEqual(result);
  expect(reusableLocalCheck(result, pixels.toReversed())).toBeNull();
});

test.each([
  { ...frame, revision: "wrong-model" },
  { ...frame, categories: ["invented-label"] },
  { ...frame, scores: { dangerous: 0.9, sexual: 0.01, violence: 0.01 } },
  { ...frame, scores: { sexual: 0.01 } },
  { ...frame, scores: { dangerous: -1, sexual: 0, violence: 0 } },
  {
    ...frame,
    model: "nvidia/Nemotron-3.5-Content-Safety",
    revision: "35645ed3543b7e7ffaed2e788699e57a5051497c",
    policy: "nemotron-visibility-v3",
  },
  { ...frame, rawOutput: "must not be stored" },
])("rejects incompatible or unbounded contracts: %j", async (body) => {
  await expect(
    checkLocalMedia(
      [Buffer.from("x")],
      new AbortController().signal,
      vi.fn().mockResolvedValue(Response.json(body)),
    ),
  ).rejects.toMatchObject({ kind: "local_failed" });
});

test("unknown remains unknown and cannot be reused as a completed check", async () => {
  const images = [Buffer.from("x")];
  const result = await checkLocalMedia(
    images,
    new AbortController().signal,
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ ...frame, status: "unknown", scores: null }),
      ),
  );
  expect(result.frames[0].status).toBe("unknown");
  expect(reusableLocalCheck(result, images)).toBeNull();
});

test.each([
  new Response("private raw error", { status: 503 }),
  new Response("x".repeat(9000)),
])("transport failures stay local and do not echo bodies", async (response) => {
  const request = vi.fn().mockResolvedValue(response);
  await expect(
    checkLocalMedia([Buffer.from("x")], new AbortController().signal, request),
  ).rejects.toMatchObject({ message: "local_failed" });
  expect(request).toHaveBeenCalledOnce();
});

test("aborted and oversized inputs never reach the service", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = vi.fn();
  await expect(
    checkLocalMedia([Buffer.from("x")], controller.signal, request),
  ).rejects.toThrow("local_failed");
  await expect(
    checkLocalMedia(
      [Buffer.alloc(2 * 1024 * 1024 + 1)],
      new AbortController().signal,
      request,
    ),
  ).rejects.toThrow("local_failed");
  expect(request).not.toHaveBeenCalled();
});

test("old Nemotron observations remain readable but cannot skip a ShieldGemma check", () => {
  const image = Buffer.from("old-image");
  const previous = {
    scope: "outgoing_images_only",
    frames: [
      {
        model: "nvidia/Nemotron-3.5-Content-Safety",
        revision: "35645ed3543b7e7ffaed2e788699e57a5051497c",
        policy: "nemotron-visibility-v3",
        precision: "bf16",
        status: "complete",
        categories: [],
        sha256: createHash("sha256").update(image).digest("hex"),
      },
    ],
  };
  expect(reusableLocalCheck(previous, [image])).toBeNull();
});
