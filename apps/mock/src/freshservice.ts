import { MOCK } from "@crisiscrew/contracts";
import { Hono } from "hono";
import { apiKeyAuth, invalid, json, logCalls, notFound } from "./freshworks";
import { htmlToText, iso, type Alert, type ServiceRecord, type ServiceTicket, type Store } from "./store";
import type { World } from "./world";

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

export type NewAlert = { service: string; metric: string; severity: "critical" | "warning"; label: string; value?: string; threshold?: string };

/**
 * An alert arrives in Alert Management, and the workflow on it tells
 * CrisisCrew by webhook, as FRESHSERVICE_ALERTS_INGEST=webhook expects.
 */
export function fireAlert(store: Store, input: NewAlert): Alert {
  const now = iso();
  const alert: Alert = {
    id: store.next("alert"),
    subject: input.label,
    metric_name: input.metric,
    metric_value: input.value ?? null,
    resource: input.service,
    node: `${input.service}-prod`,
    severity: input.severity === "critical" ? 201 : 101,
    state: 1,
    tags: [`service:${input.service}`],
    occurrence_time: now,
    updated_at: now,
    additional_info: input.threshold ? { Threshold: input.threshold } : {},
  };
  store.alerts.push(alert);
  store.touch();
  void store.webhook("freshservice", "/api/webhooks/freshservice/alerts", { alert_id: alert.id });
  return alert;
}

export function resolveAlert(store: Store, id: number): Alert | null {
  const alert = store.alerts.find((a) => a.id === id);
  if (!alert) return null;
  alert.state = 2;
  alert.updated_at = iso();
  store.touch();
  void store.webhook("freshservice", "/api/webhooks/freshservice/alerts", { alert_id: alert.id });
  return alert;
}

/** The on-call engineer acknowledges in Freshservice; the workflow on the incident tells CrisisCrew. */
export async function acknowledge(store: Store, ticketId: number, by: string): Promise<boolean> {
  const ticket = store.serviceTickets.find((t) => t.id === ticketId);
  if (!ticket) return false;
  const ok = await store.webhook("freshservice", "/api/webhooks/freshservice/acknowledge", { ticket_id: ticketId, agent_name: by });
  if (ok) {
    ticket.acknowledged = { by, at: iso() };
    store.touch();
  }
  return ok;
}

const ticketView = ({ notes: _n, change_id, problem_id, acknowledged: _a, ...t }: ServiceTicket) => ({
  ...t,
  ...(change_id ? { change_initiated_by_ticket: { display_id: change_id } } : {}),
  ...(problem_id ? { problem: { display_id: problem_id } } : {}),
});

/** The Freshservice REST API v2 that CrisisCrew uses: incidents and their notes, changes, problems, on-call and alerts. */
export function freshserviceApi(store: Store, world: World): Hono {
  const app = new Hono();
  app.use("/api/*", logCalls(store, "freshservice"), apiKeyAuth(MOCK.freshserviceApiKey));

  app.post("/api/v2/tickets", async (c) => {
    const body = await json(c);
    if (!body) return c.json({ description: "body must be JSON" }, 400);
    const errors = [];
    if (typeof body.subject !== "string" || !body.subject.trim()) errors.push({ field: "subject", message: "It should be a non-empty string" });
    if (typeof body.description !== "string") errors.push({ field: "description", message: "It should be a string" });
    if (typeof body.email !== "string" || !body.email.includes("@")) errors.push({ field: "email", message: "It should be a valid email address" });
    if (errors.length) return invalid(c, errors);
    const now = iso();
    const ticket: ServiceTicket = {
      id: store.next("service"),
      subject: body.subject as string,
      description: body.description as string,
      description_text: htmlToText(body.description as string),
      priority: num(body.priority, 1),
      urgency: num(body.urgency, 1),
      impact: num(body.impact, 1),
      status: num(body.status, 2),
      group_id: typeof body.group_id === "number" ? body.group_id : null,
      tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : [],
      requester_email: body.email as string,
      created_at: now,
      updated_at: now,
      change_id: null,
      problem_id: null,
      notes: [],
      acknowledged: null,
    };
    store.serviceTickets.push(ticket);
    store.touch();
    return c.json({ ticket: ticketView(ticket) }, 201);
  });

  app.get("/api/v2/tickets/:id", (c) => {
    const ticket = store.serviceTickets.find((t) => t.id === Number(c.req.param("id")));
    return ticket ? c.json({ ticket: ticketView(ticket) }) : notFound(c);
  });

  app.put("/api/v2/tickets/:id", async (c) => {
    const ticket = store.serviceTickets.find((t) => t.id === Number(c.req.param("id")));
    if (!ticket) return notFound(c);
    const body = (await json(c)) ?? {};
    for (const key of ["priority", "urgency", "impact", "status"] as const) if (typeof body[key] === "number") ticket[key] = body[key] as number;
    const change = (body.change_initiated_by_ticket as { display_id?: number } | undefined)?.display_id;
    const problem = (body.problem as { display_id?: number } | undefined)?.display_id;
    for (const [id, field] of [[change, "change_id"], [problem, "problem_id"]] as const) {
      if (typeof id !== "number") continue;
      const record = store.records.find((r) => r.id === id);
      if (!record) return c.json({ description: "Validation failed", errors: [{ field, message: `There is no record with id ${id}`, code: "invalid_value" }] }, 400);
      ticket[field] = id;
      record.ticket_id = ticket.id;
    }
    ticket.updated_at = iso();
    store.touch();
    return c.json({ ticket: ticketView(ticket) });
  });

  app.post("/api/v2/tickets/:id/notes", async (c) => {
    const ticket = store.serviceTickets.find((t) => t.id === Number(c.req.param("id")));
    if (!ticket) return notFound(c);
    const body = await json(c);
    if (typeof body?.body !== "string" || !body.body.trim()) return invalid(c, [{ field: "body", message: "It should be a non-empty string" }]);
    const note = store.conversation(body.body, body.private === false ? "reply" : "note");
    ticket.notes.push(note);
    ticket.updated_at = iso();
    store.touch();
    return c.json({ conversation: { ...note, ticket_id: ticket.id } }, 201);
  });

  for (const kind of ["change", "problem"] as const) {
    app.post(`/api/v2/${kind}s`, async (c) => {
      const body = await json(c);
      if (typeof body?.subject !== "string" || !body.subject.trim()) return invalid(c, [{ field: "subject", message: "It should be a non-empty string" }]);
      const record: ServiceRecord = {
        id: store.next("record"),
        kind,
        subject: body.subject,
        description: typeof body.description === "string" ? body.description : "",
        description_text: htmlToText(typeof body.description === "string" ? body.description : ""),
        priority: num(body.priority, 1),
        impact: num(body.impact, 1),
        status: num(body.status, 1),
        created_at: iso(),
        ticket_id: null,
      };
      store.records.push(record);
      store.touch();
      const { kind: _k, ...view } = record;
      return c.json({ [kind]: view }, 201);
    });
  }

  app.get("/api/v2/oncall/shift-events/current", (c) => {
    if (Number(c.req.query("schedule_id")) !== MOCK.oncallScheduleId) return c.json({ shift_events: [] });
    return c.json({ shift_events: world.shiftEvents() });
  });

  app.get("/api/v2/ams/alerts/:id", (c) => {
    const alert = store.alerts.find((a) => a.id === Number(c.req.param("id")));
    return alert ? c.json({ alert }) : notFound(c);
  });

  // Only the one query CrisisCrew sends is understood: updated_at:>'<time>'.
  app.get("/api/v2/ams/alerts", (c) => {
    const match = /updated_at:>'([^']+)'/.exec(c.req.query("query") ?? "");
    const since = match ? Date.parse(match[1]!) : Number.NaN;
    const alerts = store.alerts.filter((a) => Number.isNaN(since) || Date.parse(a.updated_at) > since).sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
    return c.json({ alerts });
  });

  return app;
}
