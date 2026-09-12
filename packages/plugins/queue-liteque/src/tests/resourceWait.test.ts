import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import serverConfig from "@karakeep/shared/config";
import { QueueRetryAfterError } from "@karakeep/shared/queueing";
import { LitequeQueueProvider } from "../index";

test("resource waiting yields to another job and preserves runNumber with zero retries configured", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "karakeep-gpu-queue-"));
  const configured = vi
    .spyOn(serverConfig, "dataDir", "get")
    .mockReturnValue(dir);
  try {
    const client = (await new LitequeQueueProvider().getClient())!;
    await client.prepare();
    const queue = client.createQueue<{ name: string }>("resource_wait", {
      defaultJobArgs: { numRetries: 0 },
      keepFailedJobs: false,
    });
    await queue.enqueue({ name: "background" }, { priority: 10 });
    await queue.enqueue({ name: "manual" }, { priority: 0 });
    const calls: string[] = [];
    const errors = vi.fn();
    let waited = false;
    const runner = client.createRunner(
      queue,
      {
        run: async (job) => {
          calls.push(`${job.data.name}:${job.runNumber}`);
          if (job.data.name === "manual" && !waited) {
            waited = true;
            throw new QueueRetryAfterError("waiting_resource", 30);
          }
        },
        onError: errors,
      },
      { timeoutSecs: 5, concurrency: 1, pollIntervalMs: 10 },
    );
    await runner.runUntilEmpty!();
    expect(calls).toEqual(["manual:0", "background:0", "manual:0"]);
    expect(errors).not.toHaveBeenCalled();
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
