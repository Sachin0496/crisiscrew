import { serveStatic } from "@hono/node-server/serve-static";
import { postMonitoringAlert, VOBIZ_CALLBACKS, type VobizCallback } from "@crisiscrew/adapters";
import { DecisionBody, impactGraph, LEVEL_NAMES, ReplayBody } from "@crisiscrew/contracts";
import { describeWorkflows } from "@crisiscrew/core";
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
import { rateLimit } from "./rate-limit";
import { eventStream } from "./sse";

export type AppDeps = { runtime: Runtime; config: Config; onError?: (error: unknown) => void };

const VERSION = "0.2.0";

const ManualTicket = z.object({
  customerName: z.string().trim().min(1).max(80).default("Walk-in customer"),
  customerEmail: z.string().trim().max(120).optional(),
  channel: z.enum(["chat", "email", "phone", "portal"]).default("chat"),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1).max(2000),
}).strict();

/** Freshdesk's automation rule posts {"ticket_id": 123}; its simple mode nests the fields under "freshdesk_webhook". */
const FreshdeskWebhook = z.union([
  z.object({ ticket_id: z.coerce.number().int().positive() }),
  z.object({ freshdesk_webhook: z.object({ ticket_id: z.coerce.number().int().positive() }) }),
]);

/** An alert posted by hand (a demo, or a monitoring tool CrisisCrew doesn't read directly). */
const ManualAlert = z
  .object({
    service: z.string().trim().min(1).max(80),
    metric: z.string().trim().min(1).max(80),
    severity: z.enum(["critical", "warning"]),
    label: z.string().trim().min(1).max(200),
    value: z.string().trim().max(40).optional(),
    threshold: z.string().trim().max(40).optional(),
  })
  .strict();

/** A Freshservice workflow names the alert; CrisisCrew reads it back from the API. */
const FreshserviceAlertHook = z.object({ alert_id: z.coerce.number().int().positive() });

const AcknowledgeBody = z.object({ by: z.string().trim().min(1).max(60).optional() }).strict();

/** A Freshservice workflow's webhook: the incident ticket's id, and who acknowledged. */
const FreshserviceAck = z.object({ ticket_id: z.coerce.number().int().positive(), agent_name: z.string().trim().max(60).optional() });

const ImportanceBody = z.object({ level: z.enum(["P1", "P2", "P3"]), note: z.string().trim().max(500).optional() }).strict();

// talk: the call is a conversation (streamed and voiced by Sarvam when VOBIZ_VOICE=sarvam) that repeats back what it heard.
const TestCall = z.object({ to: z.string().trim().min(8).max(20), talk: z.boolean().optional() }).strict();

/** The test call's conversation: it says back what it heard, so the whole voice path is checked, then hangs up. */
const echoDialog = {
  respond: (utterance: string) => ({ say: `I heard: ${utterance}. Your line and the voice agent both work. Goodbye.`, end: true }),
};

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
  const limit = config.rateLimitPerMinute;
  const adminLimit = rateLimit("admin", limit);
  const approvalLimit = rateLimit("approval", limit);
  const webhookLimit = rateLimit("webhook", limit * 5);
  const workflows = describeWorkflows();
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
      demo: { freshdeskTickets: config.demo.tickets?.count ?? null, freshserviceAlert: config.demo.alert?.service ?? null, filing: runtime.demoFiling },
    }),
  );

  // Real-mode demo: file the live world's tickets in Freshdesk, as its customers would.
  app.post("/api/demo/freshdesk-tickets", adminLimit, admin, (c) => {
    if (!config.demo.tickets) return c.json({ error: "Filing demo tickets needs TICKETS=freshdesk against a real Freshdesk" }, 404);
    try {
      return c.json(runtime.fileDemoTickets(config.demo.tickets), 202);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  // Real-mode demo: play the monitoring tool, and post a critical alert to Freshservice Alert Management.
  app.post("/api/demo/freshservice-alert", adminLimit, admin, async (c) => {
    const alert = config.demo.alert;
    if (!alert) return c.json({ error: "Firing a demo alert needs FRESHSERVICE_ALERT_WEBHOOK_URL and FRESHSERVICE_ALERT_WEBHOOK_KEY" }, 404);
    try {
      await postMonitoringAlert(alert, {
        resource: alert.service,
        node: `${alert.service}-prod`,
        metric_name: "http_5xx_rate",
        metric_value: "3.4%",
        severity: "critical",
        message: `${alert.service} 5xx error rate at 3.4%, above the 1% threshold`,
        description: `Payment API errors on ${alert.service} jumped after the last release. Fired from the CrisisCrew demo.`,
        tags: [`service:${alert.service}`],
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
    // Alert Management files it a few seconds after accepting it; read it back then rather than waiting for the next poll.
    if (config.alerts) {
      for (const delay of [5_000, 12_000]) {
        setTimeout(() => runtime.pollFreshserviceAlerts().catch((error) => onError?.(error)), delay);
      }
    }
    return c.json({ fired: true, service: alert.service }, 202);
  });

  app.get("/api/wiring", (c) => c.json(wiringReport(config)));
  app.get("/api/state", (c) => c.json(runtime.state()));
  app.get("/api/stream", (c) => eventStream(c, runtime.bus));
  app.get("/api/scenarios", (c) => c.json(runtime.scenarioList()));

  app.post("/api/replay", adminLimit, admin, async (c) => {
    const parsed = await body(c, ReplayBody);
    if (!parsed.ok) return parsed.response;
    if (!runtime.scenarioList().some((s) => s.id === parsed.data.scenario)) return c.json({ error: `unknown scenario "${parsed.data.scenario}"` }, 404);
    const sessionId = await runtime.startReplay(parsed.data.scenario, parsed.data.speed);
    return c.json({ sessionId });
  });

  app.post("/api/live", adminLimit, admin, async (c) => c.json({ sessionId: await runtime.startLive() }));
  app.post("/api/admin/reset", adminLimit, admin, async (c) => c.json({ sessionId: await runtime.startLive() }));

  app.get("/api/customers", (c) => c.json(runtime.customerDirectory()));

  app.post("/api/tickets", adminLimit, admin, async (c) => {
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

  app.post("/api/webhooks/freshdesk", webhookLimit, async (c) => {
    if (!runtime.freshdeskEnabled || !config.freshdesk?.webhookSecret) return c.json({ error: "Freshdesk webhook ingest is off: set TICKETS=freshdesk and FRESHDESK_INGEST=webhook" }, 404);
    if (!sameSecret(c.req.header("x-crisiscrew-secret") ?? "", config.freshdesk.webhookSecret)) return c.json({ error: "X-CrisisCrew-Secret is missing or wrong" }, 401);
    const parsed = await body(c, FreshdeskWebhook);
    if (!parsed.ok) return parsed.response;
    const ticketId = "ticket_id" in parsed.data ? parsed.data.ticket_id : parsed.data.freshdesk_webhook.ticket_id;
    // Answer at once; Freshdesk's webhook times out quickly, and ingest reads the ticket back from the API.
    void runtime.ingestFreshdesk(ticketId).catch((error) => onError?.(error));
    return c.json({ accepted: true, ticketId }, 202);
  });

  app.post("/api/alerts", adminLimit, admin, async (c) => {
    const parsed = await body(c, ManualAlert);
    if (!parsed.ok) return parsed.response;
    const alert = await runtime.ingestAlert({ ...parsed.data, source: "manual", firedAt: Date.now() });
    return c.json(alert, 202);
  });

  app.post("/api/webhooks/freshservice/alerts", webhookLimit, async (c) => {
    if (!runtime.freshserviceAlertsEnabled || !config.freshserviceWebhookSecret) {
      return c.json({ error: "Freshservice alert webhooks are off: set ALERTS=freshservice and FRESHSERVICE_WEBHOOK_SECRET" }, 404);
    }
    if (!sameSecret(c.req.header("x-crisiscrew-secret") ?? "", config.freshserviceWebhookSecret)) return c.json({ error: "X-CrisisCrew-Secret is missing or wrong" }, 401);
    const parsed = await body(c, FreshserviceAlertHook);
    if (!parsed.ok) return parsed.response;
    // Answer at once; the alert is read back from the API.
    void runtime.ingestFreshserviceAlert(parsed.data.alert_id).catch((error) => onError?.(error));
    return c.json({ accepted: true, alertId: parsed.data.alert_id }, 202);
  });

  // An operator takes the page, so no one else is called.
  app.post("/api/incidents/:id/page/acknowledge", adminLimit, admin, async (c) => {
    const parsed = await body(c, AcknowledgeBody);
    if (!parsed.ok) return parsed.response;
    const id = c.req.param("id");
    if (!runtime.state().incidents[id]) return c.json({ error: `no incident ${id}` }, 404);
    try {
      await runtime.acknowledgePage(id, parsed.data.by ?? (c.req.header("x-operator-name")?.slice(0, 60) || "an operator"));
      return c.json(runtime.state().incidents[id]!.paging);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  // Acknowledging in Freshservice: a workflow on the incident ticket posts its id here with the shared secret.
  app.post("/api/webhooks/freshservice/acknowledge", webhookLimit, async (c) => {
    if (!config.freshserviceWebhookSecret) return c.json({ error: "Freshservice acknowledgements are off: set FRESHSERVICE_WEBHOOK_SECRET" }, 404);
    if (!sameSecret(c.req.header("x-crisiscrew-secret") ?? "", config.freshserviceWebhookSecret)) return c.json({ error: "X-CrisisCrew-Secret is missing or wrong" }, 401);
    const parsed = await body(c, FreshserviceAck);
    if (!parsed.ok) return parsed.response;
    const incidentId = runtime.incidentForEngineering(parsed.data.ticket_id);
    if (!incidentId) return c.json({ error: `no incident is filed as Freshservice ticket #${parsed.data.ticket_id}` }, 404);
    try {
      await runtime.acknowledgePage(incidentId, parsed.data.agent_name || "Freshservice");
      return c.json({ incidentId, paging: runtime.state().incidents[incidentId]!.paging });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  // A human sets an incident's importance, up or down; the Commander's rules leave it alone from then on.
  app.post("/api/incidents/:id/importance", adminLimit, admin, async (c) => {
    const parsed = await body(c, ImportanceBody);
    if (!parsed.ok) return parsed.response;
    const id = c.req.param("id");
    if (!runtime.state().incidents[id]) return c.json({ error: `no incident ${id}` }, 404);
    const by = c.req.header("x-operator-name")?.slice(0, 60) || "an operator";
    return c.json(await runtime.setImportance(id, parsed.data.level, by, parsed.data.note || undefined));
  });

  // A Vobiz application's answer URL (calls into the number or a SIP endpoint). CrisisCrew only places calls, so it says so and hangs up.
  app.post("/api/webhooks/vobiz/app/answer", webhookLimit, (c) =>
    c.body(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Speak>This number places CrisisCrew incident calls and does not take calls. Goodbye.</Speak><Hangup/></Response>`,
      200,
      { "content-type": "application/xml; charset=utf-8" },
    ),
  );

  // Vobiz fetches what a call says and reports its progress here. Each callback is signed with the account's auth token.
  app.post("/api/webhooks/vobiz/:callId/:kind", webhookLimit, async (c) => {
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
  app.post("/api/telephony/test-call", adminLimit, admin, async (c) => {
    const parsed = await body(c, TestCall);
    if (!parsed.ok) return parsed.response;
    try {
      const { callId } = await runtime.placeCall({
        to: parsed.data.to,
        script: TEST_CALL_SCRIPT,
        purpose: "oncall",
        gather: { prompt: parsed.data.talk ? "Say something, and I'll repeat what I heard." : "Press 1 to confirm you can hear this." },
        metadata: { test: "true" },
        ...(parsed.data.talk ? { dialog: echoDialog } : {}),
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

  app.post("/api/approvals/:id", approvalLimit, approver, async (c) => {
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

  app.get("/api/workflows", (c) => c.json(workflows));
  app.get("/api/traces", (c) => {
    const session = c.req.query("session") === "all" ? undefined : runtime.state().session.id;
    const incident = c.req.query("incident");
    const status = c.req.query("status");
    const traces = runtime.traces.list(session).filter((t) => (!incident || t.incidentId === incident) && (!status || t.status === status));
    return c.json({ traces, langsmith: config.langsmith ? { project: config.langsmith.project } : null });
  });
  app.get("/api/traces/:id", (c) => {
    const detail = runtime.traces.get(c.req.param("id"));
    return detail ? c.json(detail) : c.json({ error: `no trace ${c.req.param("id")}` }, 404);
  });

  app.use("/mcp", rateLimit("MCP", limit * 5));
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
