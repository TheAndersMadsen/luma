import { afterEach, expect, it, vi } from "vitest";
import { watchPinEvents } from "./events";

afterEach(() => {
  vi.useRealTimers();
});

it("accepts fragmented events, ignores malformed lines, and distinguishes heartbeats", async () => {
  vi.useFakeTimers();
  const cancelled = vi.fn();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('null\n{"type":4}\n{"type":"heart'));
      controller.enqueue(
        encoder.encode(
          'beat"}\n{"type":"memory_completed","uuid":"fixture"}\n',
        ),
      );
    },
    cancel: cancelled,
  });
  const activity = vi.fn();
  const stop = watchPinEvents(
    { openStream: vi.fn().mockResolvedValue(stream) },
    activity,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(activity.mock.calls).toEqual([[false], [true]]);
  stop();
  await vi.advanceTimersByTimeAsync(0);
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels a stream that opens after navigation without delivering old events", async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<ReadableStream<Uint8Array>>();
  const cancelled = vi.fn();
  const activity = vi.fn();
  const stop = watchPinEvents(
    { openStream: vi.fn().mockReturnValue(pending.promise) },
    activity,
  );
  stop();
  pending.resolve(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"type":"heartbeat"}\n'));
      },
      cancel: cancelled,
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(activity).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds unfinished event lines and cancels scheduled retries on navigation", async () => {
  vi.useFakeTimers();
  const cancelled = vi.fn();
  const openStream = vi.fn().mockResolvedValue(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(70_000)));
      },
      cancel: cancelled,
    }),
  );
  const stop = watchPinEvents({ openStream }, vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(cancelled).toHaveBeenCalledTimes(1);
  stop();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(openStream).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("releases a stalled reader even if its transport ignores abort", async () => {
  vi.useFakeTimers();
  const cancelled = vi.fn();
  const openStream = vi
    .fn()
    .mockImplementation(async () => new ReadableStream({ cancel: cancelled }));
  const stop = watchPinEvents({ openStream }, vi.fn());
  await vi.advanceTimersByTimeAsync(60_000);
  expect(cancelled).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(openStream).toHaveBeenCalledTimes(2);
  stop();
  await vi.advanceTimersByTimeAsync(0);
  expect(cancelled).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
