import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import serverConfig from "@karakeep/shared/config";
import { LitequeQueueProvider } from "../index";

test("persisted jobs from an earlier process are skipped before callbacks when policy is deferred", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "karakeep-liteque-policy-"));
  const configured = vi
    .spyOn(serverConfig, "dataDir", "get")
    .mockReturnValue(dir);
  try {
    const first = (await new LitequeQueueProvider().getClient())!;
    await first.prepare();
    const opts = { defaultJobArgs: { numRetries: 1 }, keepFailedJobs: false };
    const source = first.createQueue<{ bookmarkId: string }>("policy", opts);
    await source.enqueue({ bookmarkId: "deferred" });
    await source.enqueue({ bookmarkId: "automatic" });
    // New provider reads the actual SQLite queue written by the previous one.
    const restarted = (await new LitequeQueueProvider().getClient())!;
    await restarted.prepare();
    const queue = restarted.createQueue<{ bookmarkId: string }>("policy", opts);
    queue.shouldRun = async ({ bookmarkId }) => bookmarkId !== "deferred";
    const calls: string[] = [];
    const runner = restarted.createRunner(
      queue,
      {
        run: async ({ data }) => {
          calls.push("run:" + data.bookmarkId);
          return "ok";
        },
        onComplete: async ({ data }, result) => {
          calls.push("complete:" + data.bookmarkId + ":" + result);
        },
        onError: async () => {
          calls.push("error");
        },
      },
      { timeoutSecs: 5, concurrency: 1, pollIntervalMs: 10 },
    );
    await runner.runUntilEmpty!();
    expect(calls).toEqual(["run:automatic", "complete:automatic:ok"]);
    expect(await queue.stats()).toEqual({
      pending: 0,
      pending_retry: 0,
      running: 0,
      failed: 0,
    });
  } finally {
    configured.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
