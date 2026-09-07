import { beforeEach, expect, test, vi } from "vitest";
import { getAssetSize, readAsset } from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import { RuleEngine } from "@karakeep/trpc/lib/ruleEngine";
import {
  finishMediaCatalog,
  reindexMediaCatalog,
  startMediaCatalog,
} from "@karakeep/trpc/models/mediaCatalog";
import { inferMediaCatalog } from "./mediaCatalogProvider";
import { runMediaCatalog } from "./mediaCatalogWorker";

vi.mock("@karakeep/shared-server", async (original) => ({
  ...(await original<typeof import("@karakeep/shared-server")>()),
  readAsset: vi.fn(),
  getAssetSize: vi.fn(),
}));
vi.mock("@karakeep/trpc/models/mediaCatalog", () => ({
  startMediaCatalog: vi.fn(),
  finishMediaCatalog: vi.fn(),
  reindexMediaCatalog: vi.fn(),
}));
vi.mock("@karakeep/trpc/lib/ruleEngine", () => ({
  RuleEngine: { triggerOnEvent: vi.fn() },
}));
vi.mock("./mediaCatalogProvider", async (original) => ({
  ...(await original<typeof import("./mediaCatalogProvider")>()),
  inferMediaCatalog: vi.fn(),
}));
vi.mock("execa", () => ({
  execa: vi
    .fn()
    .mockResolvedValue({ stdout: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }),
}));

const job = {
  id: "job",
  data: { bookmarkId: "bookmark", userId: "owner", runId: "run" },
  priority: 0,
  runNumber: 1,
  abortSignal: new AbortController().signal,
};
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(serverConfig.mediaAi, {
    enabled: true,
    apiKey: "synthetic",
    provider: "xai",
  });
  vi.mocked(getAssetSize).mockResolvedValue(4);
  vi.mocked(readAsset).mockResolvedValue({
    asset: Buffer.from("jpeg"),
    metadata: { contentType: "image/jpeg" },
  });
  vi.mocked(startMediaCatalog).mockReturnValue({
    input: {
      assets: [{ id: "image", fileName: "001.jpg" }],
      media: { kind: "image", coverage: "archived_media", asset_count: 1 },
      source: { title: "", caption: "", author: "" },
    },
    tags: [],
    state: {
      runId: "run",
      fingerprint: "input",
      model: "grok-4.6",
      status: "pending",
      updatedAt: new Date().toISOString(),
      allowPreview: false,
    },
  });
  vi.mocked(finishMediaCatalog).mockReturnValue({
    attachedTagIds: ["new-tag"],
  });
  vi.mocked(inferMediaCatalog).mockResolvedValue({
    title: "Title",
    summary: "Summary",
    tags: ["portrait"],
  });
  vi.mocked(RuleEngine.triggerOnEvent).mockResolvedValue();
  vi.mocked(reindexMediaCatalog).mockResolvedValue();
});

test("new tag rules are published after success; downstream failures never repeat inference or mark it failed", async () => {
  vi.mocked(RuleEngine.triggerOnEvent).mockRejectedValue(
    new Error("Rule queue offline"),
  );
  vi.mocked(reindexMediaCatalog).mockRejectedValue(
    new Error("Search queue offline"),
  );
  await runMediaCatalog(job);
  expect(RuleEngine.triggerOnEvent).toHaveBeenCalledWith("owner", "bookmark", [
    { type: "tagAdded", tagId: "new-tag" },
  ]);
  expect(finishMediaCatalog).toHaveBeenCalledOnce();
  expect(vi.mocked(finishMediaCatalog).mock.calls[0][2]).toBe("success");
  expect(inferMediaCatalog).toHaveBeenCalledOnce();
});

test.each([{ attachedTagIds: [] }, false] as const)(
  "existing or stale tag attachments do not emit new events: %j",
  async (applied) => {
    vi.mocked(finishMediaCatalog).mockReturnValue(
      applied ? { attachedTagIds: [] } : false,
    );
    await runMediaCatalog(job);
    expect(RuleEngine.triggerOnEvent).not.toHaveBeenCalled();
  },
);

test("an unclaimed or cancelled job never prepares media or calls a provider", async () => {
  vi.mocked(startMediaCatalog).mockReturnValue(null);
  await runMediaCatalog(job);
  expect(readAsset).not.toHaveBeenCalled();
  expect(inferMediaCatalog).not.toHaveBeenCalled();
});
