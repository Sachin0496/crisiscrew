import type { Context, MiddlewareHandler } from "hono";

/**
 * A fixed-window rate limit per client and route group, in memory. Enough to
 * stop a script hammering the webhook, MCP or admin routes of one server; a
 * multi-instance deployment would put this in its gateway instead.
 */
export function rateLimit(group: string, perMinute: number): MiddlewareHandler {
  const windows = new Map<string, { start: number; count: number }>();
  return async (c, next) => {
    if (perMinute <= 0) return next();
    const now = Date.now();
    const key = clientKey(c);
    let w = windows.get(key);
    if (!w || now - w.start >= 60_000) {
      w = { start: now, count: 0 };
      windows.set(key, w);
      // Forget idle clients so the map can't grow without bound.
      if (windows.size > 10_000) for (const [k, v] of windows) if (now - v.start >= 60_000) windows.delete(k);
    }
    w.count += 1;
    if (w.count > perMinute) {
      const retry = Math.max(1, Math.ceil((w.start + 60_000 - now) / 1000));
      c.header("retry-after", String(retry));
      return c.json({ error: `too many ${group} requests: at most ${perMinute} a minute, try again in ${retry} s` }, 429);
    }
    await next();
  };
}

function clientKey(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
  return forwarded || socket || "local";
}
