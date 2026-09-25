import {
  actionsFor,
  alertMentionsService,
  customerState,
  incidentAlert,
  recoveryCoverage,
  recoveryMetrics,
  Surface,
  type AffectedCustomer,
  type Approval,
  type CrisisState,
  type Customer,
  type CustomerImpact,
  type CustomerUpdate,
  type EventInput,
  type IncidentView,
  type Level,
  type Policy,
  recoveryAlert,
  type Ticket,
  type ToolName,
} from "@crisiscrew/contracts";
import { z } from "zod";
import type { ToolDef } from "../policy/gate";
import type { Ports } from "../ports";
import { assessImpact } from "../recovery/impact";
import { planRecovery } from "../recovery/plan";
import { customerCase, draftUpdate, engineeringSummary, inr, type Draft } from "../recovery/templates";

export type ToolCtx = {
  now(): number;
  state(): CrisisState;
  ports: Ports;
  policy: Policy;
  emit(event: EventInput): void;
  drafts: Map<string, { draft: Draft; since: number }>;
  nextId(kind: "update" | "approval" | "action"): string;
  /** Approvals already used for a credit, so one approval can't pay twice. */
  spentApprovals: Set<string>;
};

type Tool = ToolDef<ToolCtx> & { name: ToolName };

function incidentOf(ctx: ToolCtx, id: string): IncidentView {
  const incident = ctx.state().incidents[id];
  if (!incident) throw new Error(`no incident ${id}`);
  return incident;
}

/** The incident a read tool is asked about: the given one, or the latest. */
function incidentOrLatest(ctx: ToolCtx, id: string | undefined): IncidentView | null {
  const s = ctx.state();
  const chosen = id ?? s.incidentOrder.at(-1);
  return chosen ? incidentOf(ctx, chosen) : null;
}

function ticketsOf(ctx: ToolCtx, incident: IncidentView): Ticket[] {
  const ids = new Set([...incident.ticketIds, ...incident.linkedTicketIds]);
  return [...ids].map((id) => ctx.state().tickets[id]?.ticket).filter((t): t is Ticket => Boolean(t));
}

function firstComplaintAt(ctx: ToolCtx, incident: IncidentView): number {
  return Math.min(...ticketsOf(ctx, incident).map((t) => t.receivedAt));
}

function rootOf(incident: IncidentView) {
  return incident.hypotheses.find((h) => h.id === incident.rootCause?.hypothesisId);
}

/** Start of the incident window: when the cause began, or a lookback before the first complaint. */
function windowStart(ctx: ToolCtx, incident: IncidentView): number {
  return rootOf(incident)?.startedAt ?? firstComplaintAt(ctx, incident) - ctx.policy.recovery.affectedLookbackMin * 60_000;
}

function affectedCustomer(incident: IncidentView | undefined, ref: string): AffectedCustomer | undefined {
  return incident?.impact?.customers.find((c) => c.ref === ref);
}

/** The adapter that handles a ticket's notes and replies: Freshdesk for Freshdesk tickets, the sandbox otherwise. */
function ticketAdapter(ctx: ToolCtx, ticketId: string | undefined): string {
  const ticket = ticketId ? ctx.state().tickets[ticketId]?.ticket : undefined;
  return ticket && ctx.ports.ticketActions.adapterFor ? ctx.ports.ticketActions.adapterFor(ticket) : ctx.ports.ticketActions.adapter;
}

/** Credits the agents issued on their own (without an approval) for this incident. */
function issuedWithinAuthority(ctx: ToolCtx, incidentId: string): number {
  return ctx.state().credits.filter((c) => c.incidentId === incidentId && !c.approvalId).reduce((sum, c) => sum + c.amountInr, 0);
}

function customerView(incident: IncidentView, c: AffectedCustomer) {
  const actions = actionsFor(incident, c.ref);
  return {
    ref: c.ref,
    name: c.name,
    confidence: c.confidence,
    complained: c.complained,
    severity: c.severity ?? null,
    tier: c.tier,
    recovery: customerState(c, actions),
    evidence: c.evidence.map((e) => e.label),
    actions: actions.map((a) => ({
      id: a.id,
      kind: a.kind,
      status: a.status,
      reason: a.reason,
      ...(a.amountInr !== undefined ? { amountInr: a.amountInr } : {}),
      ...(a.detail ? { detail: a.detail } : {}),
      ...(a.approvalId ? { approvalId: a.approvalId } : {}),
    })),
  };
}

const fixed = (level: Level) => () => level;
const idOnly = z.object({ incidentId: z.string().min(1) });

export function createTools(): Tool[] {
  return [
    {
      name: "search_recent_tickets",
      description: "List tickets received in the last N minutes, with their product area and whether they report a failure.",
      input: z.object({ minutes: z.number().int().min(1).max(1440).default(15) }),
      level: fixed(0),
      async run(args, ctx) {
        const { minutes } = args as { minutes: number };
        const since = ctx.now() - minutes * 60_000;
        const s = ctx.state();
        return s.ticketOrder
          .map((id) => s.tickets[id]!)
          .filter((v) => v.ticket.receivedAt >= since)
          .map((v) => ({
            id: v.ticket.id,
            customer: v.ticket.customerName,
            channel: v.ticket.channel,
            text: v.ticket.body,
            receivedAt: new Date(v.ticket.receivedAt).toISOString(),
            surface: v.signal?.surface,
            reportsFailure: v.signal?.isFailure,
            incidentId: v.incidentId,
            ...(v.ticket.externalId ? { externalId: v.ticket.externalId } : {}),
          }));
      },
      summarize: (r) => `${(r as unknown[]).length} tickets`,
    },
    {
      name: "get_incident",
      description:
        "Summary of an incident (the latest one when no id is given): status, root cause, customer impact, recovery coverage and pending decisions.",
      input: z.object({ incidentId: z.string().optional() }),
      level: fixed(0),
      async run(args, ctx) {
        const i = incidentOrLatest(ctx, (args as { incidentId?: string }).incidentId);
        if (!i) return { incident: null };
        const coverage = recoveryCoverage(i);
        const pending = Object.values(ctx.state().approvals).filter((a) => a.incidentId === i.id && a.status === "pending");
        return {
          id: i.id,
          status: i.status,
          severity: i.severity,
          surface: i.surface,
          openedAt: new Date(i.openedAt).toISOString(),
          linkedTickets: i.linkedTicketIds.length,
          rootCause: i.rootCause ?? null,
          impact: i.impact ? { affected: coverage.confirmed, complained: coverage.complained, silent: coverage.silent, unverified: coverage.unverified } : null,
          recoveryCoverage: coverage.confirmed ? { recovered: coverage.recovered, of: coverage.confirmed, needsHuman: coverage.needsHuman } : null,
          pendingDecisions: pending.map((a) => ({ id: a.id, customer: a.customerName, amountInr: a.amountInr })),
          engineeringIncident: i.engineering ?? null,
        };
      },
    },
    {
      name: "get_customer_impact",
      description:
        "The Customer Impact Graph for an incident (the latest when no id is given): every affected customer, whether they complained or stayed silent, the evidence that links them to the incident, and their recovery actions and state.",
      input: z.object({
        incidentId: z.string().optional(),
        filter: z.enum(["all", "complained", "silent", "needs_human", "unverified"]).default("all"),
      }),
      level: fixed(0),
      async run(args, ctx) {
        const { incidentId, filter } = args as { incidentId?: string; filter: string };
        const i = incidentOrLatest(ctx, incidentId);
        if (!i) return { incident: null, customers: [] };
        const customers = (i.impact?.customers ?? []).map((c) => customerView(i, c));
        const shown = customers.filter((c) => {
          if (filter === "complained") return c.confidence === "confirmed" && c.complained;
          if (filter === "silent") return c.confidence === "confirmed" && !c.complained;
          if (filter === "needs_human") return c.recovery === "needs_human";
          if (filter === "unverified") return c.confidence === "unverified";
          return true;
        });
        return { incident: i.id, since: i.impact ? new Date(i.impact.since).toISOString() : null, customers: shown };
      },
      summarize: (r) => `${(r as { customers: unknown[] }).customers.length} customers`,
    },
    {
      name: "get_recovery_coverage",
      description:
        "Recovery Coverage for an incident (the latest when no id is given): confirmed affected customers with a completed or human-decided recovery, over all confirmed affected customers, plus the recovery metrics.",
      input: z.object({ incidentId: z.string().optional() }),
      level: fixed(0),
      async run(args, ctx) {
        const i = incidentOrLatest(ctx, (args as { incidentId?: string }).incidentId);
        if (!i) return { incident: null };
        return { incident: i.id, coverage: recoveryCoverage(i), metrics: recoveryMetrics(ctx.state(), i) };
      },
      summarize: (r) => {
        const c = (r as { coverage?: { recovered: number; confirmed: number } }).coverage;
        return c ? `recovery coverage ${c.recovered}/${c.confirmed}` : "no incident";
      },
    },
    {
      name: "get_payment_health",
      description: "Status of the payment gateway and its components.",
      input: z.object({}),
      level: fixed(0),
      adapter: (ctx) => ctx.ports.payments.adapter,
      run: async (_args, ctx) => ctx.ports.payments.health(),
      summarize: (r) => (r as { provider: string; status: string }[]).map((p) => `${p.provider}: ${p.status}`).join(", "),
    },
    {
      name: "get_recent_deployments",
      description: "Releases of a service in the last N minutes, newest first.",
      input: z.object({ service: z.string().min(1), sinceMinutes: z.number().int().min(1).max(10_080).default(360) }),
      level: fixed(0),
      adapter: (ctx) => ctx.ports.deployments.adapter,
      async run(args, ctx) {
        const { service, sinceMinutes } = args as { service: string; sinceMinutes: number };
        return ctx.ports.deployments.recent(service, ctx.now() - sinceMinutes * 60_000);
      },
      summarize: (r) => {
        const list = r as { version: string; sha: string }[];
        return list.length ? `${list.length} releases: ${list.map((d) => `${d.version} (${d.sha.slice(0, 7)})`).join(", ")}` : "no releases";
      },
    },
    {
      name: "get_service_status",
      description: "A service's error rate, one point a minute, over the last N minutes.",
      input: z.object({ service: z.string().min(1), minutes: z.number().int().min(5).max(1440).default(120) }),
      level: fixed(0),
      adapter: (ctx) => ctx.ports.metrics.adapter,
      async run(args, ctx) {
        const { service, minutes } = args as { service: string; minutes: number };
        const points = await ctx.ports.metrics.errorRates(service, ctx.now() - minutes * 60_000, ctx.now());
        return { service, points, latestRate: points.at(-1)?.rate ?? null };
      },
      summarize: (r) => {
        const { service, points, latestRate } = r as { service: string; points: unknown[]; latestRate: number | null };
        return `${service}: ${points.length} points, latest ${latestRate === null ? "n/a" : `${(latestRate * 100).toFixed(2)}%`}`;
      },
    },
    {
      name: "get_active_alerts",
      description:
        "Open alerts from the monitoring tools (Freshservice Alert Management), most recent first: what fired, on which service, how bad, and since when. This is operational evidence that a service is actually failing, independent of what customers wrote in.",
      input: z.object({
        service: z.string().optional(),
        minutes: z.number().int().min(1).max(1440).default(360),
      }),
      level: fixed(0),
      adapter: (ctx) => ctx.ports.alerts.adapter,
      async run(args, ctx) {
        const { service, minutes } = args as { service?: string; minutes: number };
        const alerts = await ctx.ports.alerts.active(ctx.now() - minutes * 60_000);
        const shown = service ? alerts.filter((a) => alertMentionsService(a, service)) : alerts;
        return {
          alerts: shown.map((a) => ({
            id: a.id,
            source: a.source,
            severity: a.severity,
            resource: a.resource,
            hostname: a.hostname,
            metric: a.metric,
            message: a.message,
            description: a.description,
            at: new Date(a.at).toISOString(),
            attributes: a.attributes,
          })),
          count: shown.length,
          critical: shown.filter((a) => a.severity === "critical").length,
        };
      },
      summarize: (r) => {
        const { count, critical } = r as { count: number; critical: number };
        return count === 0 ? "no open alerts" : `${count} open alert${count === 1 ? "" : "s"}${critical ? ` (${critical} critical)` : ""}`;
      },
    },
    {
      name: "raise_alert",
      description:
        "Raise the incident as an alert in Freshservice Alert Management, so ITOps sees the customer harm next to the service that caused it. Alerts group by resource, so this keeps one alert per service rather than one per incident.",
      input: z.object({
        incidentId: z.string().min(1),
        service: z.string().min(1).optional(),
      }),
      level: fixed(1),
      adapter: (ctx) => ctx.ports.alerts.adapter,
      async run(args, ctx) {
        const { incidentId, service } = args as { incidentId: string; service?: string };
        const incident = incidentOf(ctx, incidentId);
        const coverage = recoveryCoverage(incident);
        const resource = service ?? ctx.ports.catalog.servicesFor(incident.surface)[0]?.name ?? incident.surface;
        const notification = incidentAlert({
          service: resource,
          title: engineeringSummary(incident).title,
          summary: engineeringSummary(incident).description,
          severity: incident.severity,
          incidentId,
          affected: coverage.confirmed,
          silent: coverage.silent,
          recovered: coverage.recovered,
          confirmed: coverage.confirmed,
          status: incident.status,
        });
        const result = await ctx.ports.alerts.push(notification);
        if (!result.ok) throw new Error(result.reason ?? "the alert push failed");
        ctx.emit({ type: "alert.raised", payload: { incidentId, severity: notification.severity, message: notification.message, adapter: ctx.ports.alerts.adapter } });
        return { incidentId, resource, severity: notification.severity };
      },
      summarize: (r) => {
        const { resource, severity } = r as { resource: string; severity: string };
        return `${severity} alert raised for ${resource}`;
      },
    },
    {
      name: "resolve_alert",
      description: "Resolve an incident's Freshservice alert (severity ok) once every affected customer has been recovered, so ITOps does not keep chasing it.",
      input: idOnly,
      level: fixed(1),
      adapter: (ctx) => ctx.ports.alerts.adapter,
      async run(args, ctx) {
        const { incidentId } = args as { incidentId: string };
        const incident = incidentOf(ctx, incidentId);
        const coverage = recoveryCoverage(incident);
        const resource = ctx.ports.catalog.servicesFor(incident.surface)[0]?.name ?? incident.surface;
        const notification = recoveryAlert({
          service: resource,
          incidentId,
          summary: engineeringSummary(incident).description,
          confirmed: coverage.confirmed,
        });
        const result = await ctx.ports.alerts.push(notification);
        if (!result.ok) throw new Error(result.reason ?? "the alert push failed");
        ctx.emit({ type: "alert.resolved", payload: { incidentId, adapter: ctx.ports.alerts.adapter } });
        return { incidentId, resource };
      },
      summarize: (r) => `alert resolved for ${(r as { resource: string }).resource}`,
    },
    {
      name: "identify_affected_customers",
      description:
        "Build the Customer Impact Graph: customers with a failed or pending payment in the incident window (confirmed), and customers who complained without one (unverified), each with their evidence.",
      input: z.object({ incidentId: z.string().min(1) }),
      level: fixed(0),
      adapter: (ctx) => ctx.ports.orders.adapter,
      async run(args, ctx) {
        const { incidentId } = args as { incidentId: string };
        const incident = incidentOf(ctx, incidentId);
        const since = windowStart(ctx, incident);
        const tickets = ticketsOf(ctx, incident);
        const attempts = await ctx.ports.orders.attemptsSince(since);
        const refs = new Set([...tickets.map((t) => t.customerRef), ...attempts.map((a) => a.customerRef)]);
        const records = await Promise.all([...refs].map(async (ref) => [ref, await ctx.ports.orders.customer(ref)] as const));
        const root = rootOf(incident);
        const impact: CustomerImpact = {
          since,
          assessedAt: ctx.now(),
          customers: assessImpact({
            incidentId,
            tickets,
            attempts,
            customers: new Map(records.filter((r): r is readonly [string, Customer] => r[1] !== null)),
            since,
            services: ctx.ports.catalog.servicesFor(incident.surface).map((s) => s.name),
            ...(root && incident.rootCause
              ? { cause: { id: root.id, label: root.label, confidence: incident.rootCause.confidence, ...(root.startedAt !== undefined ? { startedAt: root.startedAt } : {}) } }
              : {}),
            highValueInr: ctx.policy.recovery.highValueInr,
            ordersSource: ctx.ports.orders.adapter,
          }),
        };
        return impact;
      },
      summarize: (r) => {
        const customers = (r as CustomerImpact).customers;
        const confirmed = customers.filter((c) => c.confidence === "confirmed");
        const complained = confirmed.filter((c) => c.complained).length;
        const unverified = customers.length - confirmed.length;
        return `${confirmed.length} affected: ${complained} complained, ${confirmed.length - complained} silent${unverified ? `, plus ${unverified} not verified` : ""}`;
      },
    },
    {
      name: "open_incident",
      description: "Open an incident for a cluster that passed every detection gate.",
      input: z.object({
        incidentId: z.string().min(1),
        clusterId: z.string().min(1),
        ticketIds: z.array(z.string()).min(1),
        surface: Surface,
        severity: z.enum(["high", "medium"]),
      }),
      level: fixed(1),
      condition: (args, ctx) => (ctx.state().incidents[(args as { incidentId: string }).incidentId] ? "incident is already open" : null),
      async run(args, ctx) {
        const a = args as { incidentId: string; clusterId: string; ticketIds: string[]; surface: Surface; severity: "high" | "medium" };
        const now = ctx.now();
        const incident: IncidentView = {
          id: a.incidentId,
          status: "detected",
          severity: a.severity,
          openedAt: now,
          surface: a.surface,
          clusterId: a.clusterId,
          ticketIds: a.ticketIds,
          linkedTicketIds: [],
          hypotheses: [],
          actions: [],
          updates: [],
          timeline: [{ at: now, status: "detected", note: `${a.ticketIds.length} similar failure reports passed every detection gate` }],
        };
        ctx.emit({ type: "incident.opened", payload: { incident } });
        return { incidentId: a.incidentId };
      },
      summarize: (r) => `opened ${(r as { incidentId: string }).incidentId}`,
    },
    {
      name: "file_engineering_incident",
      description: "File the incident where engineering works (Freshservice, or its sandbox), so the operational side sees the customer impact.",
      input: idOnly,
      level: fixed(1),
      adapter: (ctx) => ctx.ports.incidents.adapter,
      condition(args, ctx) {
        const incident = ctx.state().incidents[(args as { incidentId: string }).incidentId];
        if (!incident) return "no such incident";
        return incident.engineering ? `already filed as ${incident.engineering.id}` : null;
      },
      async run(args, ctx) {
        const { incidentId } = args as { incidentId: string };
        const incident = incidentOf(ctx, incidentId);
        const record = await ctx.ports.incidents.open({ incidentId, severity: incident.severity, ...engineeringSummary(incident) });
        ctx.emit({ type: "engineering.recorded", payload: { incidentId, record: { ...record, adapter: ctx.ports.incidents.adapter } } });
        return record;
      },
      summarize: (r) => `filed ${(r as { id: string }).id}`,
    },
    {
      name: "update_engineering_incident",
      description: "Add a private note to the engineering incident: the root cause, or customer impact and recovery coverage.",
      input: z.object({ incidentId: z.string().min(1), note: z.string().min(1).max(4000) }),
      level: fixed(1),
      adapter: (ctx) => ctx.ports.incidents.adapter,
      condition: (args, ctx) => (ctx.state().incidents[(args as { incidentId: string }).incidentId]?.engineering ? null : "no engineering incident has been filed"),
      async run(args, ctx) {
        const { incidentId, note } = args as { incidentId: string; note: string };
        const record = incidentOf(ctx, incidentId).engineering!;
        await ctx.ports.incidents.note(record.id, note);
        return { recordId: record.id };
      },
      summarize: (r) => `note added to ${(r as { recordId: string }).recordId}`,
    },
    {
      name: "link_ticket_to_incident",
      description: "Link a ticket to an incident and leave a private note on it (a Freshdesk private note when the ticket came from Freshdesk).",
      input: z.object({ incidentId: z.string().min(1), ticketId: z.string().min(1) }),
      level: fixed(1),
      adapter: (ctx, args) => ticketAdapter(ctx, (args as { ticketId?: string } | undefined)?.ticketId),
      condition: (args, ctx) => {
        const { incidentId, ticketId } = args as { incidentId: string; ticketId: string };
        if (!ctx.state().incidents[incidentId]) return `no incident ${incidentId}`;
        return ctx.state().tickets[ticketId] ? null : `no ticket ${ticketId}`;
      },
      async run(args, ctx) {
        const { incidentId, ticketId } = args as { incidentId: string; ticketId: string };
        const incident = incidentOf(ctx, incidentId);
        if (incident.linkedTicketIds.includes(ticketId)) return { incidentId, ticketId, alreadyLinked: true };
        const ticket = ctx.state().tickets[ticketId]!.ticket;
        await ctx.ports.ticketActions.addNote(
          ticket,
          `CrisisCrew linked this ticket to ${incidentId}: ${engineeringSummary(incident).title}. The customer's impact and recovery are tracked there.`,
        );
        ctx.emit({ type: "ticket.linked", payload: { incidentId, ticketId } });
        return { incidentId, ticketId, alreadyLinked: false };
      },
      summarize: (r) => {
        const { incidentId, ticketId, alreadyLinked } = r as { incidentId: string; ticketId: string; alreadyLinked: boolean };
        return alreadyLinked ? `${ticketId} was already linked to ${incidentId}` : `linked ${ticketId} to ${incidentId}, with a private note`;
      },
    },
    {
      name: "add_ticket_note",
      description: "Leave a private note on one of the incident's tickets, e.g. the customer's recovery outcome.",
      input: z.object({ incidentId: z.string().min(1), ticketId: z.string().min(1), text: z.string().min(1).max(4000) }),
      level: fixed(1),
      adapter: (ctx, args) => ticketAdapter(ctx, (args as { ticketId?: string } | undefined)?.ticketId),
      condition(args, ctx) {
        const { incidentId, ticketId } = args as { incidentId: string; ticketId: string };
        const incident = ctx.state().incidents[incidentId];
        if (!incident) return `no incident ${incidentId}`;
        return [...incident.ticketIds, ...incident.linkedTicketIds].includes(ticketId) ? null : `${ticketId} is not part of ${incidentId}`;
      },
      async run(args, ctx) {
        const { ticketId, text } = args as { ticketId: string; text: string };
        await ctx.ports.ticketActions.addNote(ctx.state().tickets[ticketId]!.ticket, text);
        return { ticketId };
      },
      summarize: (r) => `private note on ${(r as { ticketId: string }).ticketId}`,
    },
    {
      name: "draft_customer_update",
      description: "Write the update every affected customer will receive for this incident, and the acknowledgement for complaints that can't be verified yet.",
      input: idOnly,
      level: fixed(1),
      async run(args, ctx) {
        const { incidentId } = args as { incidentId: string };
        const incident = incidentOf(ctx, incidentId);
        const since = rootOf(incident)?.startedAt ?? firstComplaintAt(ctx, incident);
        const draft = draftUpdate(incident, since);
        ctx.drafts.set(incidentId, { draft, since });
        return draft;
      },
      summarize: (r) => (r as Draft).subject,
    },
    {
      name: "plan_recovery",
      description:
        "Apply the recovery policy to every affected customer: the channel they allow, a voice update for priority customers, and a credit sized by the harm, each with its reason and the authority it needs.",
      input: idOnly,
      level: fixed(1),
      condition: (args, ctx) => (ctx.state().incidents[(args as { incidentId: string }).incidentId]?.impact ? null : "affected customers not identified yet"),
      async run(args, ctx) {
        const { incidentId } = args as { incidentId: string };
        const incident = incidentOf(ctx, incidentId);
        const actions = planRecovery({
          incidentId,
          customers: incident.impact!.customers,
          existing: incident.actions,
          policy: ctx.policy,
          now: ctx.now(),
          nextId: () => ctx.nextId("action"),
        });
        if (actions.length > 0) ctx.emit({ type: "recovery.planned", payload: { incidentId, actions } });
        return {
          planned: actions.length,
          customers: new Set(actions.map((a) => a.customerRef)).size,
          needsHuman: actions.filter((a) => a.level === 3).length,
        };
      },
      summarize: (r) => {
        const { planned, customers, needsHuman } = r as { planned: number; customers: number; needsHuman: number };
        const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
        return planned === 0
          ? "nothing new to plan"
          : `${n(planned, "action")} for ${n(customers, "customer")}${needsHuman ? `; ${needsHuman} ${needsHuman === 1 ? "credit needs" : "credits need"} a human` : ""}`;
      },
    },
    {
      name: "send_customer_update",
      description:
        "Send the incident update to one customer: a reply on their ticket, a proactive message (needs consent and confirmed impact), or voice (needs voice consent and confirmed impact).",
      input: z.object({
        incidentId: z.string().min(1),
        customerRef: z.string().min(1),
        channel: z.enum(["ticket_reply", "proactive_message", "voice"]),
        text: z.string().min(1).max(2000),
        actionId: z.string().optional(),
      }),
      level: fixed(2),
      adapter: (ctx, args) => {
        const { incidentId, customerRef, channel } = (args ?? {}) as { incidentId?: string; customerRef?: string; channel?: string };
        if (channel === "voice") return ctx.ports.voice.adapter;
        if (channel !== "ticket_reply") return ctx.ports.notifier.adapter;
        const incident = incidentId ? ctx.state().incidents[incidentId] : undefined;
        const ticket = incident ? ticketsOf(ctx, incident).filter((t) => t.customerRef === customerRef).at(-1) : undefined;
        return ticketAdapter(ctx, ticket?.id);
      },
      async condition(args, ctx) {
        const { incidentId, customerRef, channel } = args as { incidentId: string; customerRef: string; channel: string };
        const incident = ctx.state().incidents[incidentId];
        if (!incident) return `no incident ${incidentId}`;
        if (channel === "ticket_reply") {
          return ticketsOf(ctx, incident).some((t) => t.customerRef === customerRef) ? null : "this customer has no ticket in the incident";
        }
        if (affectedCustomer(incident, customerRef)?.confidence !== "confirmed") return "no evidence this customer was affected, so they aren't contacted";
        const customer = await ctx.ports.orders.customer(customerRef);
        if (!customer) return `unknown customer ${customerRef}`;
        if (channel === "proactive_message" && !customer.consent.proactive) return "customer has not agreed to proactive messages";
        if (channel === "voice" && !customer.consent.voice) return "customer has not agreed to voice contact";
        return null;
      },
      async run(args, ctx) {
        const { incidentId, customerRef, channel, text, actionId } = args as {
          incidentId: string;
          customerRef: string;
          channel: CustomerUpdate["channel"];
          text: string;
          actionId?: string;
        };
        const incident = incidentOf(ctx, incidentId);
        const customer = await ctx.ports.orders.customer(customerRef);
        const ticket = ticketsOf(ctx, incident).filter((t) => t.customerRef === customerRef).at(-1);
        const name = customer?.name ?? ticket?.customerName ?? customerRef;
        let adapter: string;
        let status: CustomerUpdate["status"] = "sent";
        let audioId: string | null | undefined;
        if (channel === "ticket_reply") {
          await ctx.ports.ticketActions.reply(ticket!, text);
          adapter = ticketAdapter(ctx, ticket!.id);
        } else if (channel === "proactive_message") {
          await ctx.ports.notifier.proactive(customer!, text);
          adapter = ctx.ports.notifier.adapter;
        } else {
          ({ audioId } = await ctx.ports.voice.synthesize(text));
          adapter = ctx.ports.voice.adapter;
          if (ctx.ports.voice.mode === "off") status = "prepared";
        }
        const update: CustomerUpdate = {
          id: ctx.nextId("update"),
          incidentId,
          customerRef,
          customerName: name,
          channel,
          text,
          source: ctx.drafts.get(incidentId)?.draft.source ?? "template",
          status,
          adapter,
          ...(channel === "voice" ? { audioId: audioId ?? null } : {}),
          ...(actionId ? { actionId } : {}),
        };
        ctx.emit({ type: "update.sent", payload: { update } });
        return { updateId: update.id, customer: name, channel, status, adapter };
      },
      summarize: (r) => {
        const { updateId, customer, channel, status } = r as { updateId: string; customer: string; channel: string; status: string };
        const how = channel === "ticket_reply" ? "ticket reply" : channel === "proactive_message" ? "proactive message" : "voice script";
        return `${how} to ${customer} ${status === "prepared" ? "prepared (voice is off)" : "sent"} (${updateId})`;
      },
    },
    {
      name: "add_account_note",
      description: "Leave a note on an affected customer's account when they can't be contacted, so support knows what happened if they get in touch.",
      input: z.object({ incidentId: z.string().min(1), customerRef: z.string().min(1), text: z.string().min(1).max(2000) }),
      level: fixed(1),
      adapter: (ctx) => ctx.ports.orders.adapter,
      condition(args, ctx) {
        const { incidentId, customerRef } = args as { incidentId: string; customerRef: string };
        return affectedCustomer(ctx.state().incidents[incidentId], customerRef)?.confidence === "confirmed" ? null : "no evidence this customer was affected";
      },
      async run(args, ctx) {
        const { customerRef, text } = args as { customerRef: string; text: string };
        const { id } = await ctx.ports.orders.addAccountNote(customerRef, text);
        return { noteId: id, customerRef };
      },
      summarize: (r) => `account note ${(r as { noteId: string }).noteId} for ${(r as { customerRef: string }).customerRef}`,
    },
    {
      name: "request_human_approval",
      description: "Ask a human to decide one customer's credit that is above the agents' authority, with that customer's evidence attached.",
      input: z.object({ incidentId: z.string().min(1), customerRef: z.string().min(1) }),
      level: fixed(1),
      condition(args, ctx) {
        const { incidentId, customerRef } = args as { incidentId: string; customerRef: string };
        const incident = ctx.state().incidents[incidentId];
        const credit = incident?.actions.find((a) => a.customerRef === customerRef && a.kind === "credit");
        if (!credit || credit.level !== 3) return "no credit above the agents' authority is planned for this customer";
        if (credit.status !== "planned") return `this credit is already ${credit.status.replace("_", " ")}`;
        return null;
      },
      async run(args, ctx) {
        const { incidentId, customerRef } = args as { incidentId: string; customerRef: string };
        const incident = incidentOf(ctx, incidentId);
        const customer = affectedCustomer(incident, customerRef)!;
        const actions = actionsFor(incident, customerRef);
        const credit = actions.find((a) => a.kind === "credit")!;
        const limitInr = ctx.policy.limits.perCustomerLimitInr;
        const approval: Approval = {
          id: ctx.nextId("approval"),
          incidentId,
          action: "issue_recovery_credit",
          actionId: credit.id,
          customerRef,
          customerName: customer.name,
          amountInr: credit.amountInr ?? 0,
          limitInr,
          rationale: credit.reason,
          caseSummary: customerCase(incident, customer, actions, credit, limitInr),
          status: "pending",
          requestedAt: ctx.now(),
        };
        ctx.emit({ type: "approval.requested", payload: { approval } });
        return { approvalId: approval.id, customer: customer.name, amountInr: approval.amountInr };
      },
      summarize: (r) => {
        const { approvalId, customer, amountInr } = r as { approvalId: string; customer: string; amountInr: number };
        return `${approvalId}: ${inr(amountInr)} for ${customer} sent to a human approver`;
      },
    },
    {
      name: "issue_recovery_credit",
      description:
        "Issue one confirmed customer's goodwill credit. L2 when it is within the per-customer limit and the incident's authority budget; otherwise L3, which needs an approved approval for exactly this customer and amount.",
      input: z.object({
        incidentId: z.string().min(1),
        customerRef: z.string().min(1),
        amountInr: z.number().positive(),
        approvalId: z.string().optional(),
      }),
      level: (args, ctx) => {
        const { incidentId, amountInr, approvalId } = args as { incidentId?: string; amountInr?: number; approvalId?: string };
        if (approvalId !== undefined) return 3;
        const { perCustomerLimitInr, authorityLimitInr } = ctx.policy.limits;
        const amount = amountInr ?? 0;
        return amount <= perCustomerLimitInr && issuedWithinAuthority(ctx, incidentId ?? "") + amount <= authorityLimitInr ? 2 : 3;
      },
      levels: [2, 3],
      adapter: (ctx) => ctx.ports.credits.adapter,
      condition(args, ctx) {
        const { incidentId, customerRef, amountInr, approvalId } = args as { incidentId: string; customerRef: string; amountInr: number; approvalId?: string };
        const incident = ctx.state().incidents[incidentId];
        if (!incident) return `no incident ${incidentId}`;
        if (affectedCustomer(incident, customerRef)?.confidence !== "confirmed") return "no evidence this customer was harmed, so no credit";
        if (ctx.state().credits.some((c) => c.incidentId === incidentId && c.customerRef === customerRef)) return "a credit was already issued to this customer";
        if (approvalId !== undefined) {
          const approval = ctx.state().approvals[approvalId];
          if (!approval || approval.incidentId !== incidentId || approval.customerRef !== customerRef) return `no approval ${approvalId} for this customer`;
          if (approval.status !== "approved" && approval.status !== "modified") return `approval ${approvalId} is ${approval.status}`;
          if (ctx.spentApprovals.has(approvalId)) return `approval ${approvalId} was already used`;
          if (amountInr !== approval.approvedAmountInr) return `amount differs from the approved amount (${approval.approvedAmountInr} INR)`;
          return null;
        }
        const planned = incident.actions.find((a) => a.customerRef === customerRef && a.kind === "credit");
        if (!planned) return "no credit is planned for this customer";
        if (planned.level === 3) return "this credit needs a human's approval";
        return amountInr === planned.amountInr ? null : `amount differs from the planned credit (${planned.amountInr} INR)`;
      },
      async run(args, ctx) {
        const { incidentId, customerRef, amountInr, approvalId } = args as { incidentId: string; customerRef: string; amountInr: number; approvalId?: string };
        const { id } = await ctx.ports.credits.issue([customerRef], amountInr, `${incidentId}:${customerRef}`);
        if (approvalId) ctx.spentApprovals.add(approvalId);
        ctx.emit({
          type: "credit.issued",
          payload: { incidentId, customerRef, amountInr, adapter: ctx.ports.credits.adapter, creditId: id, ...(approvalId ? { approvalId } : {}) },
        });
        return { creditId: id, customerRef, amountInr };
      },
      summarize: (r) => {
        const { creditId, customerRef, amountInr } = r as { creditId: string; customerRef: string; amountInr: number };
        return `${inr(amountInr)} credit issued to ${customerRef} (${creditId})`;
      },
    },
  ];
}
