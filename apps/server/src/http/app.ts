import { serveStatic } from "@hono/node-server/serve-static";
import { DecisionBody, LEVEL_NAMES, ReplayBody } from "@crisiscrew/contracts";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { wiringReport, type Config } from "../config";
import { mountMcp } from "../mcp/endpoint";
import { REPO_ROOT, WEB_DIST_DIR } from "../paths";
import type { Runtime } from "../runtime";
import { eventStream } from "./sse";

export type AppDeps = { runtime: Runtime; config: Config };

const VERSION = "0.1.0";

const ManualTicket = z.object({
  customerName: z.string().trim().min(1).max(80).default("Walk-in customer"),
  channel: z.enum(["chat", "email", "phone", "portal"]).default("chat"),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1).max(2000),
});

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(c: Context): string {
  return c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
}

/** Requires the token when one is configured; open otherwise (local demo). */
function requireToken(expected: string | null, role: string): MiddlewareHandler {
  return async (c, next) => {
    if (expected && !sameSecret(bearer(c), expected)) return c.json({ error: `${role} token required` }, 401);
    await next();
  };
}

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: c.json({ error: "body must be JSON" }, 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: c.json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, 400) };
  }
  return { ok: true, data: parsed.data };
}

/** The HTTP API (design section 10.1), the event stream, and the built web app. */
export function createApp({ runtime, config }: AppDeps): Hono {
  const app = new Hono();
  const admin = requireToken(config.adminToken, "admin");
  const approver = requireToken(config.approverToken, "approver");
  const startedAt = Date.now();

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      version: VERSION,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      session: runtime.state().session,
      auth: { admin: config.adminToken !== null, approver: config.approverToken !== null },
    }),
  );

  app.get("/api/wiring", (c) => c.json(wiringReport(config)));
  app.get("/api/state", (c) => c.json(runtime.state()));
  app.get("/api/stream", (c) => eventStream(c, runtime.bus));
  app.get("/api/scenarios", (c) => c.json(runtime.scenarioList()));

  app.post("/api/replay", admin, async (c) => {
    const parsed = await body(c, ReplayBody);
    if (!parsed.ok) return parsed.response;
    if (!runtime.scenarioList().some((s) => s.id === parsed.data.scenario)) return c.json({ error: `unknown scenario "${parsed.data.scenario}"` }, 404);
    const sessionId = await runtime.startReplay(parsed.data.scenario, parsed.data.speed);
    return c.json({ sessionId });
  });

  app.post("/api/live", admin, async (c) => c.json({ sessionId: await runtime.startLive() }));
  app.post("/api/admin/reset", admin, async (c) => c.json({ sessionId: await runtime.startLive() }));

  app.post("/api/tickets", admin, async (c) => {
    const parsed = await body(c, ManualTicket);
    if (!parsed.ok) return parsed.response;
    const { customerName, channel, subject, body: text } = parsed.data;
    const ticket = await runtime.ingest({
      customerRef: `walk-in:${customerName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      customerName,
      channel,
      body: text,
      ...(subject ? { subject } : {}),
    });
    return c.json(ticket, 201);
  });

  app.post("/api/approvals/:id", approver, async (c) => {
    const parsed = await body(c, DecisionBody);
    if (!parsed.ok) return parsed.response;
    const id = c.req.param("id");
    if (!runtime.state().approvals[id]) return c.json({ error: `no approval ${id}` }, 404);
    try {
      const approval = await runtime.decide(id, parsed.data, c.req.header("x-approver-name")?.slice(0, 60) || "approver");
      return c.json(approval);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  app.get("/api/audit", (c) => {
    const engine = runtime.engineNow();
    const agent = c.req.query("agent");
    const decision = c.req.query("decision");
    const entries = engine.audit.entries().filter((e) => (!agent || e.identity === agent) && (!decision || e.decision === decision));
    return c.json({ entries, verify: engine.audit.verify() });
  });
  app.get("/api/audit/verify", (c) => c.json(runtime.engineNow().audit.verify()));

  app.get("/api/policy", (c) => {
    const gate = runtime.engineNow().gate;
    return c.json({ identities: gate.matrix(), tools: gate.catalog(), levelNames: LEVEL_NAMES, limits: runtime.policy().limits });
  });

  app.get("/api/voice/:id", (c) => c.json({ error: "voice is off: no audio is generated in sandbox mode" }, 404));

  mountMcp(app, { runtime, config });

  app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "not found" }, 404) : c.text("Not found", 404)));

  if (existsSync(WEB_DIST_DIR)) {
    const root = relative(process.cwd(), WEB_DIST_DIR) || ".";
    app.use("/*", serveStatic({ root }));
    const index = readFileSync(join(WEB_DIST_DIR, "index.html"), "utf8");
    app.get("*", (c) => (c.req.path.startsWith("/api/") || c.req.path === "/mcp" ? c.notFound() : c.html(index)));
  } else {
    app.get("/", (c) => c.text(`CrisisCrew API is running. Build the web app with \`pnpm build\` (repo: ${REPO_ROOT}).`));
  }

  return app;
}
