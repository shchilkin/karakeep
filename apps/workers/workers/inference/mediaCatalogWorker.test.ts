import { inferLocalCatalog } from "./mediaLocalCatalogProvider";
vi.mock("./mediaLocalCatalogProvider", () => ({ inferLocalCatalog: vi.fn() }));
import { beforeEach, expect, test, vi } from "vitest";
import { db } from "@karakeep/db";
import { getAssetSize, readAsset } from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import { RuleEngine } from "@karakeep/trpc/lib/ruleEngine";
import {
  finishMediaCatalog,
  reindexMediaCatalog,
  startMediaCatalog,
  continueMediaCatalog,
  waitForMediaCatalogResource,
} from "@karakeep/trpc/models/mediaCatalog";
import { inferMediaCatalog } from "./mediaCatalogProvider";
import { runMediaCatalog } from "./mediaCatalogWorker";
import { checkLocalMedia } from "./mediaLocalProvider";
import { LocalResourceWait, LocalExecutorUnavailable } from "./localResource";

vi.mock("./mediaLocalProvider", () => ({
  checkLocalMedia: vi.fn(),
  reusableLocalCheck: () => null,
}));

vi.mock("@karakeep/shared-server", async (original) => ({
  ...(await original<typeof import("@karakeep/shared-server")>()),
  readAsset: vi.fn(),
  getAssetSize: vi.fn(),
}));
vi.mock("@karakeep/trpc/models/mediaCatalog", () => ({
  startMediaCatalog: vi.fn(),
  authorizeMediaCatalogDispatch: vi.fn(() => true),
  mediaCatalogIsHeld: vi.fn(() => false),
  continueMediaCatalog: vi.fn(),
  finishMediaCatalog: vi.fn(),
  waitForMediaCatalogResource: vi.fn(),
  reindexMediaCatalog: vi.fn(),
  reconcileLocalMediaCatalog: vi.fn().mockResolvedValue(undefined),
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
    hybridEnabled: false,
    localMode: "off",
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

test.each(["classifier", "catalog"])(
  "busy %s parks the same operation without another model or paid call",
  async (stage) => {
    Object.assign(serverConfig.mediaAi, {
      hybridEnabled: true,
      localMode: "enforce",
    });
    const started = startMediaCatalog(db, job.data)!;
    Object.assign(started.state, { hybrid: true, localMode: "enforce" });
    vi.mocked(waitForMediaCatalogResource).mockReturnValue(true);
    if (stage === "classifier") {
      vi.mocked(checkLocalMedia).mockRejectedValue(new LocalResourceWait());
    } else {
      vi.mocked(checkLocalMedia).mockResolvedValue({
        scope: "outgoing_images_only",
        frames: [],
      });
      vi.mocked(continueMediaCatalog).mockReturnValue("local");
      vi.mocked(inferLocalCatalog).mockRejectedValue(new LocalResourceWait());
    }
    await expect(runMediaCatalog(job)).rejects.toMatchObject({
      name: "QueueRetryAfterError",
      delayMs: 30_000,
    });
    expect(waitForMediaCatalogResource).toHaveBeenCalledWith(
      db,
      job.data,
      30_000,
    );
    expect(inferMediaCatalog).not.toHaveBeenCalled();
    expect(finishMediaCatalog).not.toHaveBeenCalled();
    if (stage === "classifier") {
      expect(inferLocalCatalog).not.toHaveBeenCalled();
      expect(continueMediaCatalog).not.toHaveBeenCalled();
    }
  },
);

test("unavailable classifier stops the hybrid run instead of dispatching Qwen", async () => {
  Object.assign(serverConfig.mediaAi, {
    hybridEnabled: true,
    localMode: "enforce",
  });
  Object.assign(startMediaCatalog(db, job.data)!.state, {
    hybrid: true,
    localMode: "enforce",
  });
  vi.mocked(checkLocalMedia).mockRejectedValue(new LocalExecutorUnavailable());
  await runMediaCatalog(job);
  expect(inferLocalCatalog).not.toHaveBeenCalled();
  expect(inferMediaCatalog).not.toHaveBeenCalled();
  expect(finishMediaCatalog).toHaveBeenCalledWith(db, job.data, "local_failed");
});

test("a local service failure cannot reach cloud admission or inference", async () => {
  serverConfig.mediaAi.localMode = "enforce";
  const started = startMediaCatalog(db, job.data)!;
  started.state.localMode = "enforce";
  vi.mocked(startMediaCatalog).mockReturnValue(started);
  vi.mocked(checkLocalMedia).mockRejectedValue(new Error("Unavailable"));
  await runMediaCatalog(job);
  expect(checkLocalMedia).toHaveBeenCalledOnce();
  expect(continueMediaCatalog).not.toHaveBeenCalled();
  expect(inferMediaCatalog).not.toHaveBeenCalled();
  expect(vi.mocked(finishMediaCatalog).mock.calls[0][2]).toBe("local_failed");
});

test.each(["held", "unavailable", "text"])(
  "hybrid %s input invokes Qwen only",
  async (kind) => {
    serverConfig.mediaAi.hybridEnabled = true;
    const started = startMediaCatalog(db, job.data)!;
    started.state.hybrid = true;
    started.state.localMode = "enforce";
    if (kind === "text")
      started.input = {
        assets: [],
        media: { kind: "text", coverage: "archived_text", asset_count: 0 },
        source: { title: "", caption: "Synthetic", author: "" },
      };
    vi.mocked(startMediaCatalog).mockReturnValue(started);
    vi.mocked(checkLocalMedia).mockRejectedValue(
      new Error("synthetic failure"),
    );
    vi.mocked(continueMediaCatalog).mockReturnValue("local");
    vi.mocked(inferLocalCatalog).mockResolvedValue({
      title: "Title",
      summary: "Summary",
      tags: ["topic"],
    });
    await runMediaCatalog(job);
    expect(inferLocalCatalog).toHaveBeenCalledOnce();
    expect(inferMediaCatalog).not.toHaveBeenCalled();
  },
);

test("Qwen timeout or malformed output never falls back to Grok", async () => {
  const started = startMediaCatalog(db, job.data)!;
  started.state.hybrid = true;
  started.state.localMode = "enforce";
  vi.mocked(startMediaCatalog).mockReturnValue(started);
  vi.mocked(continueMediaCatalog).mockReturnValue("local");
  vi.mocked(inferLocalCatalog).mockRejectedValue(
    new Error("synthetic failure"),
  );
  await runMediaCatalog(job);
  expect(inferMediaCatalog).not.toHaveBeenCalled();
  expect(vi.mocked(finishMediaCatalog).mock.calls[0][2]).toBe("local_failed");
});

test("hybrid cloud payload contains checked bytes but no source text, IDs or old tags", async () => {
  const started = startMediaCatalog(db, job.data)!;
  started.state.hybrid = true;
  started.state.localMode = "enforce";
  started.input.source = {
    title: "PRIVATE TITLE",
    caption: "PRIVATE CAPTION",
    author: "PRIVATE AUTHOR",
  };
  started.tags = ["PRIVATE TAG"];
  vi.mocked(startMediaCatalog).mockReturnValue(started);
  vi.mocked(continueMediaCatalog).mockReturnValue(true);
  await runMediaCatalog(job);
  const body = JSON.stringify(
    vi.mocked(inferMediaCatalog).mock.calls[0][0].body,
  );
  expect(body).not.toContain("PRIVATE");
  expect(body).toContain("data:image/jpeg;base64,");
  expect(inferLocalCatalog).not.toHaveBeenCalled();
});
