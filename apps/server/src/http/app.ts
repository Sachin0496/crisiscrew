import { serveStatic } from "@hono/node-server/serve-static";
import { VOBIZ_CALLBACKS, type VobizCallback } from "@crisiscrew/adapters";
import { DecisionBody, impactGraph, LEVEL_NAMES, ReplayBody } from "@crisiscrew/contracts";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { wiringReport, type Config } from "../config";
import { mountMcp } from "../mcp/endpoint";
import { REPO_ROOT, WEB_DIST_DIR } from "../paths";
import type { Runtime } from "../runtime";
import { ticketImpact } from "./impact";
import { eventStream } from "./sse";

export type AppDeps = { runtime: Runtime; config: Config; onError?: (error: unknown) => void };

const VERSION = "0.2.0";

const ManualTicket = z.object({
  customerName: z.string().trim().min(1).max(80).default("Walk-in customer"),
  customerEmail: z.string().trim().max(120).optional(),
  channel: z.enum(["chat", "email", "phone", "portal"]).default("chat"),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1).max(2000),
});

/** Freshdesk's automation rule posts {"ticket_id": 123}; its simple mode nests the fields under "freshdesk_webhook". */
const FreshdeskWebhook = z.union([
  z.object({ ticket_id: z.coerce.number().int().positive() }),
  z.object({ freshdesk_webhook: z.object({ ticket_id: z.coerce.number().int().positive() }) }),
]);

const TestCall = z.object({ to: z.string().trim().min(8).max(20) }).strict();

const TEST_CALL_SCRIPT = "This is a test call from CrisisCrew. Your phone line is set up to receive incident calls.";

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

/** The HTTP API (design section 10.1), the event stream, the Freshdesk webhook and sidebar data, and the built web app. */
export function createApp({ runtime, config, onError }: AppDeps): Hono {
  const app = new Hono();
  const admin = requireToken(config.adminToken, "admin");
  const approver = requireToken(config.approverToken, "approver");
  const startedAt = Date.now();
  const baseUrl = (c: Context) => config.publicBaseUrl ?? new URL(c.req.url).origin;

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

  app.get("/api/customers", (c) => c.json(runtime.customerDirectory()));

  app.post("/api/tickets", admin, async (c) => {
    const parsed = await body(c, ManualTicket);
    if (!parsed.ok) return parsed.response;
    const { customerName, customerEmail, channel, subject, body: text } = parsed.data;
    // A known customer brings their payment history, so the complaint can be verified; anyone else is a walk-in.
    const known = await runtime.findCustomer({ ...(customerEmail ? { email: customerEmail } : {}), name: customerName });
    const ticket = await runtime.ingest({
      customerRef: known?.ref ?? `walk-in:${customerName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      customerName: known?.name ?? customerName,
      channel,
      body: text,
      ...(subject ? { subject } : {}),
    });
    return c.json(ticket, 201);
  });

  app.get("/api/incidents/:id/graph", (c) => {
    const incident = runtime.state().incidents[c.req.param("id")];
    return incident ? c.json(impactGraph(incident)) : c.json({ error: `no incident ${c.req.param("id")}` }, 404);
  });

  app.get("/api/tickets/:id/impact", (c) => c.json(ticketImpact(runtime.state(), runtime.state().tickets[c.req.param("id")], baseUrl(c))));

  app.get("/api/freshdesk/tickets/:id", (c) => {
    const externalId = `freshdesk:${c.req.param("id")}`;
    const view = Object.values(runtime.state().tickets).find((v) => v.ticket.externalId === externalId);
    return c.json(ticketImpact(runtime.state(), view, baseUrl(c)));
  });

  app.post("/api/webhooks/freshdesk", async (c) => {
    if (!runtime.freshdeskEnabled || !config.freshdesk?.webhookSecret) return c.json({ error: "Freshdesk webhook ingest is off: set TICKETS=freshdesk and FRESHDESK_INGEST=webhook" }, 404);
    if (!sameSecret(c.req.header("x-crisiscrew-secret") ?? "", config.freshdesk.webhookSecret)) return c.json({ error: "X-CrisisCrew-Secret is missing or wrong" }, 401);
    const parsed = await body(c, FreshdeskWebhook);
    if (!parsed.ok) return parsed.response;
    const ticketId = "ticket_id" in parsed.data ? parsed.data.ticket_id : parsed.data.freshdesk_webhook.ticket_id;
    // Answer at once; Freshdesk's webhook times out quickly, and ingest reads the ticket back from the API.
    void runtime.ingestFreshdesk(ticketId).catch((error) => onError?.(error));
    return c.json({ accepted: true, ticketId }, 202);
  });

  // Vobiz fetches what a call says and reports its progress here. Each callback is signed with the account's auth token.
  app.post("/api/webhooks/vobiz/:callId/:kind", async (c) => {
    const vobiz = runtime.vobiz;
    if (!vobiz) return c.json({ error: "Vobiz calls are off: set TELEPHONY=vobiz" }, 404);
    const kind = c.req.param("kind") as VobizCallback;
    if (!VOBIZ_CALLBACKS.includes(kind)) return c.json({ error: `unknown Vobiz callback "${kind}"` }, 404);
    const callId = c.req.param("callId");
    // Vobiz signs the public URL it called, which a tunnel or proxy rewrites before it reaches us.
    if (!vobiz.verifySignature(vobiz.callbackUrl(callId, kind), (name) => c.req.header(name))) return c.json({ error: "Vobiz signature is missing or wrong" }, 401);
    const form = await c.req.parseBody().catch(() => ({}));
    const params = Object.fromEntries(Object.entries(form).filter((e): e is [string, string] => typeof e[1] === "string"));
    const reply = vobiz.handleCallback(callId, kind, params);
    if (reply === null) return kind === "answer" || kind === "digits" ? c.json({ error: `no call ${callId}` }, 404) : c.body(null, 204);
    return c.body(reply, 200, { "content-type": "application/xml; charset=utf-8" });
  });

  // Checks the phone line end to end: places one short call, and its progress arrives as call.updated events.
  app.post("/api/telephony/test-call", admin, async (c) => {
    const parsed = await body(c, TestCall);
    if (!parsed.ok) return parsed.response;
    try {
      const { callId } = await runtime.placeCall({
        to: parsed.data.to,
        script: TEST_CALL_SCRIPT,
        purpose: "oncall",
        gather: { prompt: "Press 1 to confirm you can hear this." },
        metadata: { test: "true" },
      });
      return c.json({ callId, status: runtime.state().calls[callId] ?? null }, 202);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.get("/api/calls/:id", (c) => {
    const call = runtime.state().calls[c.req.param("id")];
    return call ? c.json(call) : c.json({ error: `no call ${c.req.param("id")}` }, 404);
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
