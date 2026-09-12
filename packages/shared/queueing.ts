import { ZodType } from "zod";

import { PluginManager, PluginType } from "./plugins";

/**
 * Special error that indicates a job should be retried after a delay
 * without counting against the retry attempts limit.
 * Useful for handling rate limiting scenarios.
 */
export class QueueRetryAfterError extends Error {
  constructor(
    message: string,
    public readonly delayMs: number,
  ) {
    super(message);
    this.name = "QueueRetryAfterError";
  }
}

export interface EnqueueOptions {
  idempotencyKey?: string;
  priority?: number;
  delayMs?: number;
  groupId?: string;
}

export interface QueueOptions {
  defaultJobArgs: {
    numRetries: number;
  };
  keepFailedJobs: boolean;
}

export function queueOptionsEqual(
  left: QueueOptions,
  right: QueueOptions,
): boolean {
  return (
    left.defaultJobArgs.numRetries === right.defaultJobArgs.numRetries &&
    left.keepFailedJobs === right.keepFailedJobs
  );
}

export interface DequeuedJob<T> {
  id: string;
  data: T;
  priority: number;
  runNumber: number;
  abortSignal: AbortSignal;
}

export interface DequeuedJobError<T> {
  id: string;
  data?: T;
  priority: number;
  error: Error;
  runNumber: number;
  numRetriesLeft: number;
}

export interface RunnerFuncs<T, R = void> {
  run: (job: DequeuedJob<T>) => Promise<R>;
  onComplete?: (job: DequeuedJob<T>, result: R) => Promise<void>;
  onError?: (job: DequeuedJobError<T>) => Promise<void>;
}

export interface RunnerOptions<T> {
  pollIntervalMs?: number;
  timeoutSecs: number;
  concurrency: number;
  validator?: ZodType<T>;
}

export interface Queue<T> {
  opts: QueueOptions;
  shouldRun?(payload: T): Promise<boolean>;
  ensureInit(): Promise<void>;
  name(): string;
  enqueue(payload: T, options?: EnqueueOptions): Promise<string | undefined>;
  stats(): Promise<{
    pending: number;
    pending_retry: number;
    running: number;
    failed: number;
  }>;
  cancelAllNonRunning?(): Promise<number>;
}

export interface Runner<_T> {
  run(): Promise<void>;
  stop(): void;
  runUntilEmpty?(): Promise<void>;
}

export interface QueueClient {
  prepare(): Promise<void>;
  start(): Promise<void>;
  createQueue<T>(name: string, options: QueueOptions): Queue<T>;
  createRunner<T, R = void>(
    queue: Queue<T>,
    funcs: RunnerFuncs<T, R>,
    opts: RunnerOptions<T>,
  ): Runner<T>;
  shutdown?(): Promise<void>;
}

export async function getQueueClient(): Promise<QueueClient> {
  const client = await PluginManager.getClient(PluginType.Queue);
  if (!client) {
    throw new Error("Failed to get queue client");
  }
  return client;
}

// The same durable gate runs at claim and callbacks, including old/replayed jobs.
export type GuardedQueueResult<R> =
  | { __karakeepPolicyGuard: 1; skipped: true }
  | { __karakeepPolicyGuard: 1; skipped: false; value: R };
export function guardQueueRunner<T, R>(
  queue: Queue<T>,
  funcs: RunnerFuncs<T, R>,
): RunnerFuncs<T, GuardedQueueResult<R>> {
  const allowed = async (payload: T) =>
    !queue.shouldRun || (await queue.shouldRun(payload));
  return {
    run: async (job) =>
      (await allowed(job.data))
        ? {
            __karakeepPolicyGuard: 1,
            skipped: false,
            value: await funcs.run(job),
          }
        : { __karakeepPolicyGuard: 1, skipped: true },
    onComplete: async (job, result) => {
      if (!(await allowed(job.data))) return;
      if (
        result &&
        typeof result === "object" &&
        result.__karakeepPolicyGuard === 1
      ) {
        if (!result.skipped) await funcs.onComplete?.(job, result.value);
      } else {
        // Restate may replay an onComplete journal from before the guard envelope.
        await funcs.onComplete?.(job, result as R);
      }
    },
    onError: async (job) => {
      if (!job.data || (await allowed(job.data))) await funcs.onError?.(job);
    },
  };
}
