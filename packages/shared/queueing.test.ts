import { expect, test, vi } from "vitest";
import type { DequeuedJob, GuardedQueueResult, Queue } from "./queueing";
import { guardQueueRunner } from "./queueing";

test("durable policy is checked again at claim, completion and error replay", async () => {
  let allowed = false;
  const queue: Queue<{ bookmarkId: string }> = {
    opts: { defaultJobArgs: { numRetries: 1 }, keepFailedJobs: false },
    shouldRun: async () => allowed,
    name: () => "guarded",
    ensureInit: async () => undefined,
    enqueue: async () => undefined,
    stats: async () => ({
      pending: 0,
      pending_retry: 0,
      running: 0,
      failed: 0,
    }),
  };
  const job: DequeuedJob<{ bookmarkId: string }> = {
    id: "old-job",
    data: { bookmarkId: "deferred" },
    priority: 0,
    runNumber: 1,
    abortSignal: new AbortController().signal,
  };
  const funcs = {
    run: vi.fn(async () => "result"),
    onComplete: vi.fn(),
    onError: vi.fn(),
  };
  const guarded = guardQueueRunner(queue, funcs);
  const skipped = await guarded.run(job);
  expect(skipped).toMatchObject({ skipped: true });
  expect(funcs.run).not.toHaveBeenCalled();
  await guarded.onComplete!(job, {
    __karakeepPolicyGuard: 1,
    skipped: false,
    value: "stale",
  });
  await guarded.onError!({
    ...job,
    error: new Error("stale"),
    numRetriesLeft: 0,
  });
  expect(funcs.onComplete).not.toHaveBeenCalled();
  expect(funcs.onError).not.toHaveBeenCalled();
  allowed = true;
  await guarded.onComplete!(job, skipped);
  expect(funcs.onComplete).not.toHaveBeenCalled();
  const result = await guarded.run(job);
  await guarded.onComplete!(job, result);
  expect(funcs.onComplete).toHaveBeenLastCalledWith(job, "result");
  // Restate journals from the pre-envelope deployment contain the raw result.
  await guarded.onComplete!(
    job,
    "legacy" as unknown as GuardedQueueResult<string>,
  );
  expect(funcs.onComplete).toHaveBeenLastCalledWith(job, "legacy");
  allowed = false;
  await guarded.onComplete!(job, result);
  expect(funcs.onComplete).toHaveBeenCalledTimes(2);
});
