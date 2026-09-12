import { beforeEach, expect, test, vi } from "vitest";
import serverConfig from "@karakeep/shared/config";
import {
  LOCAL_CATALOG_MODEL,
  LOCAL_CATALOG_REVISION,
  LOCAL_CATALOG_RECIPE,
} from "@karakeep/shared/mediaLocalCatalog";
import { inferLocalCatalog } from "./mediaLocalCatalogProvider";

const input = {
  assets: [{ id: "private-id", fileName: "private-file.jpg" }],
  media: {
    kind: "image" as const,
    coverage: "archived_media" as const,
    asset_count: 1,
  },
  source: { title: "Synthetic", caption: "", author: "" },
};
const response = {
  model: LOCAL_CATALOG_MODEL,
  revision: LOCAL_CATALOG_REVISION,
  recipe: LOCAL_CATALOG_RECIPE,
  result: { title: "Title", summary: "Summary", tags: ["topic"] },
};
beforeEach(() =>
  Object.assign(serverConfig.mediaAi, {
    hybridEnabled: true,
    localCatalogUrl: "http://local-catalog:8092/catalog",
    localCatalogToken: "synthetic-token",
  }),
);

test("bounded request and pinned response; no IDs or archive paths", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(response));
  expect(
    await inferLocalCatalog(
      input,
      [Buffer.from("jpeg")],
      new AbortController().signal,
      request,
    ),
  ).toEqual(response.result);
  const options = request.mock.calls[0][1]!;
  expect(options.redirect).toBe("error");
  expect(options.body).not.toContain("private-");
  expect(request).toHaveBeenCalledOnce();
});

test.each([
  {},
  { ...response, model: "other" },
  { ...response, revision: "unverified" },
  { ...response, result: { ...response.result, raw: "private" } },
  { ...response, result: { ...response.result, tags: [] } },
])("invalid service response never becomes success: %j", async (body) => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
  await expect(
    inferLocalCatalog(
      input,
      [Buffer.from("jpeg")],
      new AbortController().signal,
      request,
    ),
  ).rejects.toMatchObject({ kind: "local_failed", message: "local_failed" });
  expect(request).toHaveBeenCalledOnce();
});

test("unavailable service and oversized responses are not retried or logged", async () => {
  for (const value of [
    new Response("private error", { status: 503 }),
    new Response("x".repeat(40000)),
  ]) {
    const request = vi.fn<typeof fetch>().mockResolvedValue(value);
    await expect(
      inferLocalCatalog(
        input,
        [Buffer.from("jpeg")],
        new AbortController().signal,
        request,
      ),
    ).rejects.toMatchObject({ message: "local_failed" });
    expect(request).toHaveBeenCalledOnce();
  }
});

test("disabled service and invalid endpoint fail before sending data", async () => {
  const request = vi.fn<typeof fetch>();
  serverConfig.mediaAi.localCatalogUrl =
    "https://example.test/catalog?token=private";
  await expect(
    inferLocalCatalog(input, [], new AbortController().signal, request),
  ).rejects.toThrow("local_failed");
  expect(request).not.toHaveBeenCalled();
});
