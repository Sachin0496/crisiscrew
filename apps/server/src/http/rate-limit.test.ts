import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { rateLimit } from "./rate-limit";

describe("rate limit", () => {
  it("keys requests by the socket peer and ignores spoofed forwarded addresses", async () => {
    const app = new Hono();
    app.get("/", rateLimit("test", 2), (c) => c.text("ok"));
    const from = (remoteAddress: string, forwarded: string) => app.request("/", {
      headers: { "x-forwarded-for": forwarded },
    }, { incoming: { socket: { remoteAddress } } });

    expect((await from("192.0.2.1", "198.51.100.1")).status).toBe(200);
    expect((await from("192.0.2.1", "198.51.100.2")).status).toBe(200);
    expect((await from("192.0.2.1", "198.51.100.3")).status).toBe(429);
    expect((await from("192.0.2.2", "198.51.100.3")).status).toBe(200);
  });
});
