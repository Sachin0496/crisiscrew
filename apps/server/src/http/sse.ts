import type { CrisisEvent } from "@crisiscrew/contracts";
import type { EventBus } from "@crisiscrew/core";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

const HEARTBEAT_MS = 15_000;

/**
 * Streams every event after `since` (query parameter or Last-Event-ID), then
 * live events as they happen. The backlog is read and the subscription made
 * in the same synchronous step, so nothing can fall between them.
 */
export function eventStream(c: Context, bus: EventBus): Response {
  const header = c.req.header("last-event-id");
  const since = Number(c.req.query("since") ?? header ?? 0) || 0;

  return streamSSE(c, async (stream) => {
    const queue: CrisisEvent[] = bus.since(since);
    let wake: (() => void) | null = null;
    let closed = false;
    const off = bus.subscribe((event) => {
      queue.push(event);
      wake?.();
    });
    stream.onAbort(() => {
      closed = true;
      off();
      wake?.();
    });

    let last = since;
    while (!closed) {
      while (queue.length > 0 && !closed) {
        const event = queue.shift()!;
        if (event.seq <= last) continue;
        await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
        last = event.seq;
      }
      if (closed) break;
      const woke = await Promise.race([
        new Promise<boolean>((resolve) => (wake = () => resolve(true))),
        stream.sleep(HEARTBEAT_MS).then(() => false),
      ]);
      wake = null;
      if (!woke && !closed) await stream.writeSSE({ event: "ping", data: String(last) });
    }
    off();
  });
}
