import * as z from "zod/mini";
import type { PinClient } from "./client";
import { logWarn } from "./logging";

const RETRY_MS = 3_000;
const STALL_MS = 60_000;
const MAX_LINE_CHARACTERS = 64 * 1024;
// Only the event kind is consumed here. New device events should invalidate
// cached queries too. Their payloads belong to the endpoints those queries read.
const eventSchema = z.object({
  type: z.string().check(z.minLength(1), z.maxLength(128)),
});

/** Own one USB event subscription, including its reader, deadline and retries. */
export function watchPinEvents(
  client: Pick<PinClient, "openStream">,
  onActivity: (changed: boolean) => void,
): () => void {
  let stopped = false;
  let controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let resumeRetry: (() => void) | undefined;
  let lastReceivedAt = Date.now();

  // Cancelling the reader closes the device relay even when a transport ignores
  // AbortSignal. Aborting alone does not invoke ReadableStream.cancel().
  function closeStream() {
    controller.abort();
    void reader?.cancel().catch(() => undefined);
  }

  const stallTimer = setInterval(() => {
    if (Date.now() - lastReceivedAt >= STALL_MS) closeStream();
  }, STALL_MS);

  async function run() {
    while (!stopped) {
      controller = new AbortController();
      lastReceivedAt = Date.now();
      try {
        const stream = await client.openStream(
          "/api/events",
          controller.signal,
        );
        reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped && !controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done || stopped || controller.signal.aborted) break;
          lastReceivedAt = Date.now();
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          if (buffer.length > MAX_LINE_CHARACTERS)
            throw new Error("Event line exceeded the limit");
          for (const line of lines) {
            if (line.length > MAX_LINE_CHARACTERS)
              throw new Error("Event line exceeded the limit");
            if (!line.trim()) continue;
            let value: unknown;
            try {
              value = JSON.parse(line);
            } catch {
              continue;
            }
            const parsed = eventSchema.safeParse(value);
            if (parsed.success) onActivity(parsed.data.type !== "heartbeat");
          }
        }
      } catch (error) {
        if (!stopped)
          logWarn("pin-device", "Event stream failed", {
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
      } finally {
        await reader?.cancel().catch(() => undefined);
        reader = null;
      }
      if (!stopped) {
        await new Promise<void>((resolve) => {
          resumeRetry = resolve;
          retryTimer = setTimeout(resolve, RETRY_MS);
        });
        resumeRetry = undefined;
      }
    }
  }

  void run();
  return () => {
    stopped = true;
    clearInterval(stallTimer);
    clearTimeout(retryTimer);
    resumeRetry?.();
    closeStream();
  };
}
