import { afterEach, expect, test, vi } from "vitest";
import logger from "@karakeep/shared/logger";
import { ImportProcessingWorker } from "./importProcessingWorker";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("drains ready work immediately and polls only when empty", async () => {
  vi.useFakeTimers();
  const next = vi
    .fn()
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockResolvedValue(false);
  const worker = await ImportProcessingWorker.build(next);
  const running = worker.run();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(next).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(999);
    expect(next).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(next).toHaveBeenCalledTimes(4);
  } finally {
    worker.stop();
    await vi.runOnlyPendingTimersAsync();
    await running;
  }
});

test("backs off infrastructure failures, caps the delay, and resets after recovery", async () => {
  vi.useFakeTimers();
  vi.spyOn(logger, "warn").mockReturnValue(logger);
  const next = vi
    .fn<() => Promise<boolean>>()
    .mockRejectedValue(new Error("database unavailable"));
  const worker = await ImportProcessingWorker.build(next);
  const running = worker.run();
  try {
    await vi.advanceTimersByTimeAsync(0);
    let count = 1;
    for (const ms of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      await vi.advanceTimersByTimeAsync(ms - 1);
      expect(next).toHaveBeenCalledTimes(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(next).toHaveBeenCalledTimes(++count);
    }
    next.mockResolvedValueOnce(true);
    await vi.advanceTimersByTimeAsync(30000);
    // A recovered task drains into the next attempt without an extra delay.
    expect(next).toHaveBeenCalledTimes(count + 2);
    await vi.advanceTimersByTimeAsync(999);
    expect(next).toHaveBeenCalledTimes(count + 2);
    await vi.advanceTimersByTimeAsync(1);
    expect(next).toHaveBeenCalledTimes(count + 3);
  } finally {
    worker.stop();
    await vi.runOnlyPendingTimersAsync();
    await running;
  }
});

test("stop wakes an idle controller without advancing the clock", async () => {
  vi.useFakeTimers();
  const next = vi.fn().mockResolvedValue(false);
  const worker = await ImportProcessingWorker.build(next);
  let finished = false;
  const running = worker.run().then(() => {
    finished = true;
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    worker.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  } finally {
    worker.stop();
    await vi.runOnlyPendingTimersAsync();
    await running;
  }
});

test("stop finishes the active operation without admitting another", async () => {
  vi.useFakeTimers();
  let finish!: (worked: boolean) => void;
  const next = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const worker = await ImportProcessingWorker.build(next);
  const running = worker.run();
  await vi.advanceTimersByTimeAsync(5000);
  expect(next).toHaveBeenCalledTimes(1);
  worker.stop();
  finish(true);
  await running;
  expect(next).toHaveBeenCalledTimes(1);
});
